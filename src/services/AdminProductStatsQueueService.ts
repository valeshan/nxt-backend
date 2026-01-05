import { Queue, Worker, Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { getBullMqRedisClient } from '../infrastructure/redis';
import { supplierInsightsService } from './supplierInsightsService';
import prisma from '../infrastructure/prismaClient';
import { canonicalizeLine, assertCanonicalInvoiceLegacyLink } from './canonical';
import { ocrService } from './OcrService';

export const ADMIN_QUEUE_NAME = 'admin-jobs';

// Dedicated BullMQ connection (BullMQ requires maxRetriesPerRequest=null).
const connection = getBullMqRedisClient();

export type ProductStatsRefreshJobData = {
  organisationId: string;
  locationId: string;
  accountCodes?: string[];
  triggeredBy: 'internal_api_key';
  requestedAt: string; // ISO
  requestId?: string;
};

export type CanonicalBackfillJobData = {
  organisationId: string;
  locationId: string;
  source: 'OCR' | 'XERO' | 'ALL';
  limit?: number; // max invoices per job run (per source)
  triggeredBy: 'internal_api_key';
  requestedAt: string; // ISO
  requestId?: string;
};

export const adminQueue = new Queue(ADMIN_QUEUE_NAME, {
  connection: connection as never, // Cast needed due to ioredis version mismatch with BullMQ's bundled ioredis
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 2000,
    removeOnFail: 5000,
  },
});

export async function enqueueProductStatsRefresh(data: Omit<ProductStatsRefreshJobData, 'requestedAt'> & { requestedAt?: string }) {
  // Deterministic-ish jobId to dedupe retries/deploy races, but still allow re-enqueue after cooldown:
  // one job per (org,location) per 10-minute bucket.
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  // BullMQ rejects custom IDs that contain ":".
  const jobId = `productStatsRefresh|${data.organisationId}|${data.locationId}|${bucket}`;
  const job = await adminQueue.add(
    'product-stats-refresh',
    {
      ...data,
      requestedAt: data.requestedAt ?? new Date().toISOString(),
    },
    { jobId }
  );
  return { jobId: String(job.id) };
}

export async function enqueueCanonicalBackfill(
  data: Omit<CanonicalBackfillJobData, 'requestedAt'> & { requestedAt?: string }
) {
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  // BullMQ rejects custom IDs that contain ":".
  // Prefer requestId (unique per HTTP request) to allow immediate retries while still being deterministic per request.
  const dedupeKey = data.requestId ? `req-${data.requestId}` : String(bucket);
  const jobId = `canonicalBackfill|${data.organisationId}|${data.locationId}|${data.source}|${dedupeKey}`;
  const job = await adminQueue.add(
    'canonical-backfill',
    {
      ...data,
      requestedAt: data.requestedAt ?? new Date().toISOString(),
    },
    { jobId }
  );
  return { jobId: String(job.id) };
}

export type AdminJobStatus =
  | { jobId: string; exists: false }
  | {
      jobId: string;
      exists: true;
      name: string;
      state: string;
      progress: unknown;
      createdAt?: number;
      processedOn?: number;
      finishedOn?: number;
      failedReason?: string;
      returnvalue?: unknown;
    };

export async function getAdminJobStatus(jobId: string): Promise<AdminJobStatus> {
  const job = await adminQueue.getJob(jobId);
  if (!job) return { jobId, exists: false };

  const state = await job.getState();
  return {
    jobId,
    exists: true,
    name: job.name,
    state,
    progress: job.progress,
    createdAt: job.timestamp,
    processedOn: job.processedOn ?? undefined,
    finishedOn: job.finishedOn ?? undefined,
    failedReason: job.failedReason ?? undefined,
    returnvalue: (job as any).returnvalue,
  };
}

export function setupAdminWorker(logger: { info: (obj: any, msg?: string) => void; error: (obj: any, msg?: string) => void }) {
  const worker = new Worker(
    ADMIN_QUEUE_NAME,
    async (job: Job) => {
      const startedAt = Date.now();
      if (job.name === 'product-stats-refresh') {
        const data = job.data as ProductStatsRefreshJobData;

        logger.info(
          {
            audit: true,
            event: 'admin.productStats.refresh.started',
            jobId: job.id,
            organisationId: data.organisationId,
            locationId: data.locationId,
            triggeredBy: data.triggeredBy,
            requestId: data.requestId,
          },
          'admin.job.started'
        );

        await job.updateProgress({ stage: 'refreshing', pct: 10 });
        const result = await supplierInsightsService.refreshProductStatsForLocation(
          data.organisationId,
          data.locationId,
          data.accountCodes
        );
        await job.updateProgress({ stage: 'done', pct: 100, count: result.count, statsAsOf: result.statsAsOf.toISOString() });

        const durationMs = Date.now() - startedAt;
        logger.info(
          {
            audit: true,
            event: 'admin.productStats.refresh.completed',
            jobId: job.id,
            organisationId: data.organisationId,
            locationId: data.locationId,
            triggeredBy: data.triggeredBy,
            requestId: data.requestId,
            durationMs,
            result: { count: result.count, statsAsOf: result.statsAsOf.toISOString(), accountCodesHash: result.accountCodesHash },
          },
          'admin.job.completed'
        );

        return { ok: true, ...result, durationMs };
      }

      if (job.name === 'canonical-backfill') {
        const data = job.data as CanonicalBackfillJobData;
        const limit = Math.min(Math.max(Number(data.limit || 200), 1), 2000);

        logger.info(
          {
            audit: true,
            event: 'admin.canonical.backfill.started',
            jobId: job.id,
            organisationId: data.organisationId,
            locationId: data.locationId,
            source: data.source,
            limit,
            triggeredBy: data.triggeredBy,
            requestId: data.requestId,
          },
          'admin.job.started'
        );

        await job.updateProgress({ stage: 'scanning', pct: 5 });

        const result = await backfillCanonicalForLocation({
          organisationId: data.organisationId,
          locationId: data.locationId,
          source: data.source,
          limit,
          job,
        });

        const durationMs = Date.now() - startedAt;
        await job.updateProgress({ stage: 'done', pct: 100, ...result });

        logger.info(
          {
            audit: true,
            event: 'admin.canonical.backfill.completed',
            jobId: job.id,
            organisationId: data.organisationId,
            locationId: data.locationId,
            source: data.source,
            durationMs,
            result,
          },
          'admin.job.completed'
        );

        return { ok: true, ...result, durationMs };
      }
    },
    { connection: connection as never, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      {
        audit: true,
        event: 'admin.job.failed',
        jobId: job?.id,
        name: job?.name,
        err: { message: err.message },
      },
      'admin.job.failed'
    );
  });

  return worker;
}

export async function closeAdminQueue(): Promise<void> {
  await adminQueue.close();
}

async function backfillCanonicalForLocation(params: {
  organisationId: string;
  locationId: string;
  source: 'OCR' | 'XERO' | 'ALL';
  limit: number;
  job: Job;
}): Promise<{
  invoicesProcessed: number;
  linesProcessed: number;
  skipped: number;
  okLines: number;
  warnLines: number;
  warnRate: number;
}> {
  const { organisationId, locationId, source, limit, job } = params;

  const DEFAULT_CURRENCY_CODE = 'AUD';
  let invoicesProcessed = 0;
  let linesProcessed = 0;
  let skipped = 0;
  let okLines = 0;
  let warnLines = 0;

  const doOcr = source === 'OCR' || source === 'ALL';
  const doXero = source === 'XERO' || source === 'ALL';

  if (doOcr) {
    // Repair case: canonical header exists but line items are missing (often caused by earlier dual-write failures).
    // We detect these deterministically via SQL (Prisma relation filters can be finicky across schema changes).
    const repairOcrInvoiceIds = await prisma.$queryRaw<Array<{ legacyInvoiceId: string }>>(
      Prisma.sql`
        SELECT ci."legacyInvoiceId" as "legacyInvoiceId"
        FROM "CanonicalInvoice" ci
        LEFT JOIN "CanonicalInvoiceLineItem" li ON li."canonicalInvoiceId" = ci."id"
        WHERE ci."organisationId" = ${organisationId}
          AND ci."locationId" = ${locationId}
          AND ci."deletedAt" IS NULL
          AND ci."legacyInvoiceId" IS NOT NULL
        GROUP BY ci."legacyInvoiceId"
        HAVING COUNT(li."id") = 0
        LIMIT ${limit}
      `
    );

    // Rebuild case: canonical lines exist but are WARN due to UNKNOWN_UNIT_CATEGORY.
    // This allows targeted reprocessing after canonicalization rule improvements without forcing a full rewrite.
    const rebuildUnknownUnitOcrInvoiceIds = await prisma.$queryRaw<Array<{ legacyInvoiceId: string }>>(
      Prisma.sql`
        SELECT DISTINCT ci."legacyInvoiceId" as "legacyInvoiceId"
        FROM "CanonicalInvoice" ci
        JOIN "CanonicalInvoiceLineItem" li ON li."canonicalInvoiceId" = ci."id"
        WHERE ci."organisationId" = ${organisationId}
          AND ci."locationId" = ${locationId}
          AND ci."deletedAt" IS NULL
          AND ci."legacyInvoiceId" IS NOT NULL
          AND li."qualityStatus" = 'WARN'
          AND 'UNKNOWN_UNIT_CATEGORY' = ANY(li."warnReasons")
        LIMIT ${limit}
      `
    );

    const invoices = await prisma.invoice.findMany({
      where: {
        organisationId,
        locationId,
        deletedAt: null,
        OR: [
          // Normal case: no canonical header yet
          { canonicalInvoice: null as any },
          // Repair case: header exists but lines are missing
          { id: { in: repairOcrInvoiceIds.map((r) => r.legacyInvoiceId) } },
          // Rebuild case: canonical lines exist but are WARN due to unknown unit category
          { id: { in: rebuildUnknownUnitOcrInvoiceIds.map((r) => r.legacyInvoiceId) } },
        ],
      } as any,
      include: { lineItems: true, invoiceFile: { include: { ocrResult: true } } },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });

    for (const inv of invoices as any[]) {
      await job.updateProgress({ stage: 'backfilling_ocr', invoicesProcessed, linesProcessed, skipped });

      if (!inv.locationId) {
        skipped++;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const txAny = tx as any;
        assertCanonicalInvoiceLegacyLink({ source: 'OCR' as any, legacyInvoiceId: inv.id, legacyXeroInvoiceId: null });

        const canonical = await txAny.canonicalInvoice.upsert({
          where: { legacyInvoiceId: inv.id },
          create: {
            organisationId: inv.organisationId,
            locationId: inv.locationId,
            supplierId: inv.supplierId ?? null,
            source: inv.isVerified ? 'MANUAL' : 'OCR',
            legacyInvoiceId: inv.id,
            legacyXeroInvoiceId: null,
            sourceInvoiceRef: inv.invoiceFileId ? `invoiceFileId:${inv.invoiceFileId}` : `invoiceId:${inv.id}`,
            date: inv.date ?? null,
            currencyCode: DEFAULT_CURRENCY_CODE,
            deletedAt: inv.deletedAt ?? null,
          } as any,
          update: {
            supplierId: inv.supplierId ?? null,
            source: inv.isVerified ? 'MANUAL' : 'OCR',
            date: inv.date ?? undefined,
            deletedAt: inv.deletedAt ?? null,
          } as any,
          select: { id: true, currencyCode: true },
        });

        // Replace any existing lines to keep backfill deterministic.
        await txAny.canonicalInvoiceLineItem.deleteMany({ where: { canonicalInvoiceId: canonical.id } });

        const parsedFromOcr = !inv.isVerified && inv.invoiceFile?.ocrResult?.rawResultJson
          ? ocrService.parseTextractOutput(inv.invoiceFile.ocrResult.rawResultJson)
          : null;

        const ocrLineItems = parsedFromOcr?.lineItems || null;
        const legacyLineItems = inv.lineItems || [];

        const sourceLineItems = inv.isVerified
          ? legacyLineItems.map((li: any) => ({
              description: li.description,
              rawQuantityText: li.quantity !== null && li.quantity !== undefined ? String(li.quantity) : null,
              rawUnitText: null,
              rawDeliveredText: null,
              rawSizeText: null,
              quantity: li.quantity ? Number(li.quantity) : null,
              unitPrice: li.unitPrice ? Number(li.unitPrice) : null,
              lineTotal: li.lineTotal ? Number(li.lineTotal) : null,
              productCode: li.productCode ?? null,
              unitLabel: null,
              sourceLineRef: `invoiceId:${inv.id}:manual:${li.id}`,
              confidenceScore: inv.invoiceFile?.confidenceScore ?? null,
            }))
          : (ocrLineItems || []).map((li: any, idx: number) => ({
              description: li.description,
              rawQuantityText: li.rawQuantityText ?? null,
              rawUnitText: li.unitLabel ?? null,
              rawDeliveredText: li.rawDeliveredText ?? null,
              rawSizeText: li.rawSizeText ?? null,
              quantity: li.quantity ?? null,
              unitPrice: li.unitPrice ?? null,
              lineTotal: li.lineTotal ?? null,
              productCode: li.productCode ?? null,
              unitLabel: li.unitLabel ?? null,
              sourceLineRef: inv.invoiceFileId ? `invoiceFileId:${inv.invoiceFileId}:line:${idx}` : `invoiceId:${inv.id}:line:${idx}`,
              confidenceScore: inv.invoiceFile?.confidenceScore ?? null,
            }));

        const lines = sourceLineItems.map((li: any) => {
          const canon = canonicalizeLine({
            source: inv.isVerified ? ('MANUAL' as any) : ('OCR' as any),
            rawDescription: li.description,
            productCode: li.productCode ?? null,
            quantity: li.quantity ?? null,
            unitLabel: li.unitLabel ?? null,
            unitPrice: li.unitPrice ?? null,
            lineTotal: li.lineTotal ?? null,
            taxAmount: null,
            currencyCode: null,
            headerCurrencyCode: canonical.currencyCode ?? DEFAULT_CURRENCY_CODE,
            adjustmentStatus: inv.isVerified ? ('MODIFIED' as any) : ('NONE' as any),
            confidenceScore: li.confidenceScore ?? null,
          });

          return {
            canonicalInvoiceId: canonical.id,
            organisationId: inv.organisationId,
            locationId: inv.locationId,
            supplierId: inv.supplierId ?? null,
            source: inv.isVerified ? 'MANUAL' : 'OCR',
            sourceLineRef: li.sourceLineRef,
            normalizationVersion: 'v1',
            rawDescription: canon.rawDescription,
            normalizedDescription: canon.normalizedDescription,
            productCode: li.productCode ?? null,
            rawQuantityText: li.rawQuantityText ?? null,
            rawUnitText: li.rawUnitText ?? null,
            rawDeliveredText: li.rawDeliveredText ?? null,
            rawSizeText: li.rawSizeText ?? null,
            quantity: li.quantity ?? null,
            unitLabel: canon.unitLabel,
            unitCategory: canon.unitCategory,
            unitPrice: li.unitPrice ?? null,
            lineTotal: li.lineTotal ?? null,
            taxAmount: null,
            currencyCode: canon.currencyCode ?? canonical.currencyCode ?? DEFAULT_CURRENCY_CODE,
            adjustmentStatus: canon.adjustmentStatus,
            qualityStatus: canon.qualityStatus,
            warnReasons: canon.qualityWarnReasons ?? [],
            confidenceScore: li.confidenceScore ?? null,
          } as any;
        });

        if (lines.length > 0) {
          await txAny.canonicalInvoiceLineItem.createMany({ data: lines });
        }
        invoicesProcessed += 1;
        linesProcessed += lines.length;
        okLines += lines.filter((l: any) => l.qualityStatus === 'OK').length;
        warnLines += lines.filter((l: any) => l.qualityStatus === 'WARN').length;
      });
    }
  }

  if (doXero) {
    const repairXeroInvoiceIds = await prisma.$queryRaw<Array<{ legacyXeroInvoiceId: string }>>(
      Prisma.sql`
        SELECT ci."legacyXeroInvoiceId" as "legacyXeroInvoiceId"
        FROM "CanonicalInvoice" ci
        LEFT JOIN "CanonicalInvoiceLineItem" li ON li."canonicalInvoiceId" = ci."id"
        WHERE ci."organisationId" = ${organisationId}
          AND ci."locationId" = ${locationId}
          AND ci."deletedAt" IS NULL
          AND ci."legacyXeroInvoiceId" IS NOT NULL
        GROUP BY ci."legacyXeroInvoiceId"
        HAVING COUNT(li."id") = 0
        LIMIT ${limit}
      `
    );

    const rebuildUnknownUnitXeroInvoiceIds = await prisma.$queryRaw<Array<{ legacyXeroInvoiceId: string }>>(
      Prisma.sql`
        SELECT DISTINCT ci."legacyXeroInvoiceId" as "legacyXeroInvoiceId"
        FROM "CanonicalInvoice" ci
        JOIN "CanonicalInvoiceLineItem" li ON li."canonicalInvoiceId" = ci."id"
        WHERE ci."organisationId" = ${organisationId}
          AND ci."locationId" = ${locationId}
          AND ci."deletedAt" IS NULL
          AND ci."legacyXeroInvoiceId" IS NOT NULL
          AND li."qualityStatus" = 'WARN'
          AND 'UNKNOWN_UNIT_CATEGORY' = ANY(li."warnReasons")
        LIMIT ${limit}
      `
    );

    const xeroInvoices = await prisma.xeroInvoice.findMany({
      where: {
        organisationId,
        locationId,
        deletedAt: null,
        OR: [
          { canonicalInvoice: null as any },
          { id: { in: repairXeroInvoiceIds.map((r) => r.legacyXeroInvoiceId) } },
          { id: { in: rebuildUnknownUnitXeroInvoiceIds.map((r) => r.legacyXeroInvoiceId) } },
        ],
      } as any,
      include: { lineItems: true },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });

    for (const inv of xeroInvoices as any[]) {
      await job.updateProgress({ stage: 'backfilling_xero', invoicesProcessed, linesProcessed, skipped });

      if (!inv.locationId) {
        skipped++;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const txAny = tx as any;
        assertCanonicalInvoiceLegacyLink({ source: 'XERO' as any, legacyInvoiceId: null, legacyXeroInvoiceId: inv.id });

        const headerCurrencyCode = (inv.currencyCode || DEFAULT_CURRENCY_CODE).toUpperCase();
        const canonical = await txAny.canonicalInvoice.upsert({
          where: { legacyXeroInvoiceId: inv.id },
          create: {
            organisationId: inv.organisationId,
            locationId: inv.locationId,
            supplierId: inv.supplierId ?? null,
            source: 'XERO',
            legacyInvoiceId: null,
            legacyXeroInvoiceId: inv.id,
            sourceInvoiceRef: `xeroInvoiceId:${inv.xeroInvoiceId}`,
            date: inv.date ?? null,
            currencyCode: headerCurrencyCode,
            deletedAt: inv.deletedAt ?? null,
          } as any,
          update: {
            supplierId: inv.supplierId ?? null,
            date: inv.date ?? undefined,
            currencyCode: headerCurrencyCode,
            deletedAt: inv.deletedAt ?? null,
          } as any,
          select: { id: true, currencyCode: true },
        });

        await txAny.canonicalInvoiceLineItem.deleteMany({ where: { canonicalInvoiceId: canonical.id } });

        const lines = (inv.lineItems || []).map((li: any, idx: number) => {
          const canon = canonicalizeLine({
            source: 'XERO' as any,
            rawDescription: li.description || '',
            productCode: li.itemCode ?? null,
            quantity: li.quantity ? Number(li.quantity) : null,
            unitLabel: null,
            unitPrice: li.unitAmount ? Number(li.unitAmount) : null,
            lineTotal: li.lineAmount ? Number(li.lineAmount) : null,
            taxAmount: li.taxAmount ? Number(li.taxAmount) : null,
            currencyCode: null,
            headerCurrencyCode: canonical.currencyCode ?? headerCurrencyCode,
            adjustmentStatus: 'NONE' as any,
          });

          return {
            canonicalInvoiceId: canonical.id,
            organisationId: inv.organisationId,
            locationId: inv.locationId,
            supplierId: inv.supplierId ?? null,
            source: 'XERO',
            sourceLineRef: `xeroInvoiceId:${inv.xeroInvoiceId}:line:${idx}`,
            normalizationVersion: 'v1',
            rawDescription: canon.rawDescription,
            normalizedDescription: canon.normalizedDescription,
            productCode: li.itemCode ?? null,
            rawQuantityText: li.quantity !== null && li.quantity !== undefined ? String(li.quantity) : null,
            rawUnitText: null,
            rawDeliveredText: null,
            rawSizeText: null,
            quantity: li.quantity,
            unitLabel: canon.unitLabel,
            unitCategory: canon.unitCategory,
            unitPrice: li.unitAmount,
            lineTotal: li.lineAmount,
            taxAmount: li.taxAmount,
            currencyCode: canon.currencyCode ?? canonical.currencyCode ?? headerCurrencyCode,
            adjustmentStatus: canon.adjustmentStatus,
            qualityStatus: canon.qualityStatus,
            warnReasons: canon.qualityWarnReasons ?? [],
            confidenceScore: null,
          } as any;
        });

        if (lines.length > 0) {
          await txAny.canonicalInvoiceLineItem.createMany({ data: lines });
        }

        invoicesProcessed += 1;
        linesProcessed += lines.length;
        okLines += lines.filter((l: any) => l.qualityStatus === 'OK').length;
        warnLines += lines.filter((l: any) => l.qualityStatus === 'WARN').length;
      });
    }
  }

  const warnRate = okLines + warnLines > 0 ? warnLines / (okLines + warnLines) : 0;
  return { invoicesProcessed, linesProcessed, skipped, okLines, warnLines, warnRate };
}


