import prisma from '../../infrastructure/prismaClient';
import { randomUUID, createHash } from 'crypto';
import { resolveOrganisationEntitlements } from '../entitlements/resolveOrganisationEntitlements';
import { isInvoiceAutoApprovable, getAutoApprovalRequirements } from './autoApprovalEngine';
import { ReviewStatus, ProcessingStatus, VerificationSource } from '@prisma/client';

const MAX_CANDIDATES_DEFAULT = 2000;
const MAX_APPROVE_PER_RUN = 200;
const ELIGIBLE_ESTIMATE_SAMPLE_SIZE = 200;

type CandidateRow = {
  invoiceFileId: string;
  invoiceId: string;
  fileName: string;
  supplierId: string;
  supplierName: string;
  invoiceDate: Date;
  total: any;
  confidenceScore: number | null;
  warningLineCount: number;
};

function fingerprint(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

async function selectCandidates(params: {
  organisationId: string;
  locationId: string;
  limit: number;
}): Promise<CandidateRow[]> {
  // Banner-safe candidate selection: no CanonicalInvoiceLineItem joins.
  // Includes Supplier.status=ACTIVE to keep candidateCount trustworthy.
  return prisma.$queryRaw<CandidateRow[]>`
    SELECT
      f.id as "invoiceFileId",
      i.id as "invoiceId",
      f."fileName" as "fileName",
      s.id as "supplierId",
      s.name as "supplierName",
      i.date as "invoiceDate",
      i.total as "total",
      f."confidenceScore" as "confidenceScore",
      ci."warningLineCount" as "warningLineCount"
    FROM "InvoiceFile" f
    JOIN "Invoice" i ON i."invoiceFileId" = f.id
    JOIN "Supplier" s ON s.id = i."supplierId"
    JOIN "CanonicalInvoice" ci ON ci."legacyInvoiceId" = i.id
    WHERE
      f."organisationId" = ${params.organisationId}
      AND f."locationId" = ${params.locationId}
      AND f."deletedAt" IS NULL
      AND i."deletedAt" IS NULL
      AND f."processingStatus" = ${ProcessingStatus.OCR_COMPLETE}::"ProcessingStatus"
      AND f."reviewStatus" = ${ReviewStatus.NEEDS_REVIEW}::"ReviewStatus"
      AND f."verificationSource" IS NULL
      AND i."isVerified" = false
      AND s."status" = 'ACTIVE'::"SupplierStatus"
      AND ci."deletedAt" IS NULL
      AND ci."warningLineCount" = 0
      AND f."confidenceScore" >= 90
      AND i."total" IS NOT NULL
      AND i."date" IS NOT NULL
      AND (f."validationErrors" IS NULL OR f."validationErrors"::text = 'null' OR f."validationErrors"::text = '[]')
    ORDER BY i."date" DESC NULLS LAST, i.id DESC
    LIMIT ${params.limit};
  `;
}

export async function getRetroAutoApprovableSummary(params: {
  organisationId: string;
  locationId: string;
  userId: string;
  maxCandidates?: number;
}) {
  const maxCandidates = params.maxCandidates ?? MAX_CANDIDATES_DEFAULT;
  const entitlements = await resolveOrganisationEntitlements(params.organisationId);
  const access = await prisma.userLocationAccess.findUnique({
    where: { userId_locationId: { userId: params.userId, locationId: params.locationId } },
    select: { hasSeenRetroAutoApproveDiscovery: true },
  });
  const location = await prisma.location.findUnique({
    where: { id: params.locationId },
    select: { autoApproveCleanInvoices: true },
  });

  const canRun = Boolean(entitlements.flags.autoApproval) && Boolean(location?.autoApproveCleanInvoices);
  const cta: 'upgrade' | 'run' = entitlements.flags.autoApproval ? 'run' : 'upgrade';
  const upgradeTarget: 'pro' | null = entitlements.flags.autoApproval ? null : 'pro';
  const hasSeenDiscoveryModal = access?.hasSeenRetroAutoApproveDiscovery ?? false;

  const rows = await selectCandidates({
    organisationId: params.organisationId,
    locationId: params.locationId,
    limit: maxCandidates + 1,
  });

  const isTruncated = rows.length > maxCandidates;
  const candidates = isTruncated ? rows.slice(0, maxCandidates) : rows;

  const candidateBySupplier: Record<string, { supplierId: string; supplierName: string; candidateCount: number }> = {};
  for (const r of candidates) {
    const key = r.supplierId;
    candidateBySupplier[key] = candidateBySupplier[key] || { supplierId: r.supplierId, supplierName: r.supplierName, candidateCount: 0 };
    candidateBySupplier[key].candidateCount++;
  }

  // Eligible estimate + preview: evaluate a small sample whenever there are candidates.
  // We intentionally do this even when canRun=false (e.g. upsell or location toggle off),
  // because the UI wants a "likely eligible" preview as soon as invoices become eligible.
  let eligibleEstimate: number | null = null;
  let eligibleEstimateSampleSize = 0;
  let preview: Array<any> = [];

  if (candidates.length > 0) {
    const sample = candidates.slice(0, Math.min(ELIGIBLE_ESTIMATE_SAMPLE_SIZE, candidates.length));
    eligibleEstimateSampleSize = sample.length;

    const evaluated = sample.map((c) => {
      const decision = isInvoiceAutoApprovable({
        locationAutoApproveEnabled: true,
        invoiceFile: {
          reviewStatus: ReviewStatus.NEEDS_REVIEW,
          processingStatus: ProcessingStatus.OCR_COMPLETE,
          confidenceScore: c.confidenceScore ?? null,
          validationErrors: null,
          verificationSource: null,
        },
        invoice: {
          total: c.total,
          date: c.invoiceDate,
          supplier: { status: 'ACTIVE' as any },
        },
        canonical: { warningLineCount: c.warningLineCount },
      });
      return { c, decision };
    });

    const okCount = evaluated.filter((e) => e.decision.ok).length;
    eligibleEstimate = okCount;

    // Preview shows “likely eligible”: first N ok=true from the sample
    preview = evaluated
      .filter((e) => e.decision.ok)
      .slice(0, 20)
      .map(({ c }) => ({
        invoiceId: c.invoiceId,
        invoiceFileId: c.invoiceFileId,
        fileName: c.fileName,
        supplierName: c.supplierName,
        invoiceDate: c.invoiceDate,
        total: c.total,
        confidenceScore: c.confidenceScore,
      }));
  }

  return {
    candidateCount: candidates.length,
    eligibleEstimate,
    eligibleEstimateSampleSize,
    isTruncated,
    maxCandidates,
    candidateBySupplier: Object.values(candidateBySupplier).sort((a, b) => b.candidateCount - a.candidateCount),
    preview,
    requirements: getAutoApprovalRequirements(),
    canRun,
    cta,
    upgradeTarget,
    hasSeenDiscoveryModal,
  };
}

export async function markRetroAutoApproveDiscoverySeen(params: {
  organisationId: string;
  locationId: string;
  userId: string;
}) {
  await prisma.userLocationAccess.upsert({
    where: { userId_locationId: { userId: params.userId, locationId: params.locationId } },
    create: {
      userId: params.userId,
      organisationId: params.organisationId,
      locationId: params.locationId,
      hasSeenRetroAutoApproveDiscovery: true,
      retroAutoApproveDiscoverySeenAt: new Date(),
    },
    update: {
      hasSeenRetroAutoApproveDiscovery: true,
      retroAutoApproveDiscoverySeenAt: new Date(),
    },
  });

  return { ok: true };
}

export async function runRetroAutoApprove(params: {
  organisationId: string;
  locationId: string;
  userId: string;
  dryRun?: boolean;
  idempotencyKey?: string;
}) {
  const entitlements = await resolveOrganisationEntitlements(params.organisationId);
  if (!entitlements.flags.autoApproval) {
    throw { statusCode: 403, code: 'FEATURE_DISABLED', upgradeTarget: 'pro' };
  }

  const location = await prisma.location.findUnique({
    where: { id: params.locationId },
    select: { autoApproveCleanInvoices: true },
  });
  if (!location?.autoApproveCleanInvoices) {
    // Not an upsell; this is a location-level flag.
    throw { statusCode: 403, code: 'FEATURE_DISABLED', message: 'Auto-approval is disabled for this location' };
  }

  const dryRun = params.dryRun === true;
  const idempotencyKey = params.idempotencyKey || randomUUID();
  if (!params.idempotencyKey) {
    console.warn('[RetroAutoApprove] Missing idempotencyKey from client; generated server-side', {
      organisationId: params.organisationId,
      locationId: params.locationId,
    });
  }

  const requestFingerprint = fingerprint({ locationId: params.locationId, dryRun });

  const existing = await prisma.retroAutoApproveBatch.findFirst({
    where: { organisationId: params.organisationId, locationId: params.locationId, idempotencyKey },
  });

  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw { statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' };
    }
    return {
      approvedCount: existing.approvedCount,
      skippedCount: existing.skippedCount,
      remainingCandidateCount: null,
      batchId: existing.id,
      approvedInvoiceIds: existing.approvedInvoiceIds ?? [],
      reasonsBreakdown: existing.reasonsBreakdown ?? {},
      reusedBatch: true,
      dryRun: existing.dryRun,
      state: existing.state,
    };
  }

  const batch = await prisma.retroAutoApproveBatch.create({
    data: {
      organisationId: params.organisationId,
      locationId: params.locationId,
      createdByUserId: params.userId,
      idempotencyKey,
      requestFingerprint,
      dryRun,
      state: 'IN_PROGRESS',
      approvedCount: 0,
      skippedCount: 0,
      approvedInvoiceIds: [],
      reasonsBreakdown: {},
    },
  });

  const candidates = await selectCandidates({
    organisationId: params.organisationId,
    locationId: params.locationId,
    limit: MAX_APPROVE_PER_RUN,
  });

  const reasonsBreakdown: Record<string, number> = {};
  const approvedInvoiceIds: string[] = [];
  const toApprove: CandidateRow[] = [];
  const toSkip: Array<{ invoiceId: string; reasonCode: string }> = [];

  for (const c of candidates) {
    const decision = isInvoiceAutoApprovable({
      locationAutoApproveEnabled: true,
      invoiceFile: {
        reviewStatus: ReviewStatus.NEEDS_REVIEW,
        processingStatus: ProcessingStatus.OCR_COMPLETE,
        confidenceScore: c.confidenceScore ?? null,
        validationErrors: null,
        verificationSource: null,
      },
      invoice: {
        total: c.total,
        date: c.invoiceDate,
        supplier: { status: 'ACTIVE' as any },
      },
      canonical: { warningLineCount: c.warningLineCount },
    });

    if (decision.ok) {
      toApprove.push(c);
    } else {
      const key = decision.reasonCode;
      reasonsBreakdown[key] = (reasonsBreakdown[key] ?? 0) + 1;
      toSkip.push({ invoiceId: c.invoiceId, reasonCode: key });
    }
  }

  const now = new Date();

  // Dry-run: report what would be approved without mutating state.
  if (dryRun) {
    const wouldApproveIds = toApprove.map((c) => c.invoiceId);
    for (const c of toApprove) {
      approvedInvoiceIds.push(c.invoiceId);
    }

    const approvedCount = wouldApproveIds.length;
    const skippedCount = candidates.length - approvedCount;

    const remaining = await selectCandidates({
      organisationId: params.organisationId,
      locationId: params.locationId,
      limit: MAX_CANDIDATES_DEFAULT + 1,
    });
    const remainingCandidateCount = Math.min(remaining.length, MAX_CANDIDATES_DEFAULT);

    await prisma.retroAutoApproveBatch.update({
      where: { id: batch.id },
      data: {
        state: 'COMPLETED',
        approvedCount,
        skippedCount,
        approvedInvoiceIds: wouldApproveIds,
        reasonsBreakdown,
        completedAt: new Date(),
      },
    });

    return {
      approvedCount,
      skippedCount,
      remainingCandidateCount,
      batchId: batch.id,
      approvedInvoiceIds: wouldApproveIds,
      reasonsBreakdown,
      reusedBatch: false,
      dryRun: true,
    };
  }

  if (!dryRun && toApprove.length > 0) {
    await prisma.$transaction(async (tx) => {
      // Apply guarded updates invoice-by-invoice (max 200) so we can produce precise audit rows.
      for (const c of toApprove) {
        const updatedFile = await tx.invoiceFile.updateMany({
          where: {
            id: c.invoiceFileId,
            organisationId: params.organisationId,
            locationId: params.locationId,
            deletedAt: null,
            processingStatus: ProcessingStatus.OCR_COMPLETE,
            reviewStatus: ReviewStatus.NEEDS_REVIEW,
          } as any,
          data: {
            reviewStatus: ReviewStatus.VERIFIED,
            verificationSource: VerificationSource.AUTO,
            verifiedAt: now,
          } as any,
        });

        const updatedInvoice = await tx.invoice.updateMany({
          where: {
            id: c.invoiceId,
            organisationId: params.organisationId,
            locationId: params.locationId,
            deletedAt: null,
            isVerified: false,
          } as any,
          data: { isVerified: true } as any,
        });

        if (updatedFile.count === 1 && updatedInvoice.count === 1) {
          approvedInvoiceIds.push(c.invoiceId);
        } else {
          // Lost the race / state changed; count as skipped for this run.
          reasonsBreakdown['STATE_CHANGED'] = (reasonsBreakdown['STATE_CHANGED'] ?? 0) + 1;
        }
      }

      if (approvedInvoiceIds.length > 0) {
        await tx.invoiceAuditEvent.createMany({
          data: approvedInvoiceIds.map((invoiceId) => {
            const row = toApprove.find((x) => x.invoiceId === invoiceId)!;
            return {
              organisationId: params.organisationId,
              locationId: params.locationId,
              invoiceId,
              invoiceFileId: row.invoiceFileId,
              action: 'AUTO_APPROVED_BATCH',
              reason: 'RETRO_SUPPLIER_VERIFIED',
              triggeredByUserId: params.userId,
              batchId: batch.id,
            };
          }),
        });
      }
    });
  }

  const approvedCount = approvedInvoiceIds.length;
  const skippedCount = candidates.length - approvedCount;

  // Remaining candidates after this run (status-guarded updates mean approved invoices drop out naturally)
  const remaining = await selectCandidates({
    organisationId: params.organisationId,
    locationId: params.locationId,
    limit: MAX_CANDIDATES_DEFAULT + 1,
  });
  const remainingCandidateCount = Math.min(remaining.length, MAX_CANDIDATES_DEFAULT);

  await prisma.retroAutoApproveBatch.update({
    where: { id: batch.id },
    data: {
      state: 'COMPLETED',
      approvedCount,
      skippedCount,
      approvedInvoiceIds,
      reasonsBreakdown,
      completedAt: new Date(),
    },
  });

  return {
    approvedCount,
    skippedCount,
    remainingCandidateCount,
    batchId: batch.id,
    approvedInvoiceIds,
    reasonsBreakdown,
    reusedBatch: false,
    dryRun,
  };
}


