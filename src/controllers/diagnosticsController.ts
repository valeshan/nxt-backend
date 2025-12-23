import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { XeroSyncService } from '../services/xeroSyncService';
import { pusherService } from '../services/pusherService';
import { config } from '../config/env';
import { Prisma, XeroSyncScope, XeroSyncStatus, XeroSyncTriggerType } from '@prisma/client';
import { isCanonicalLinesEnabledForOrg } from '../utils/canonicalFlags';
import { supplierInsightsService } from '../services/supplierInsightsService';

const xeroSyncService = new XeroSyncService();

export class DiagnosticsController {
  private validateAccess(request: FastifyRequest) {
    // 1. Check Feature Flag
    if (config.ENABLE_DIAGNOSTICS !== 'true') {
      const error: any = new Error('Not found');
      error.statusCode = 404;
      throw error;
    }

    // 2. Check Role (Owner/Admin only) OR allow if no roles system exists
    // If roles array is empty, assume no permission system and allow any authenticated user
    const { roles, organisationId } = request.authContext;
    const hasRoles = roles && roles.length > 0;
    const isAuthorized = hasRoles 
      ? roles.some(r => ['owner', 'admin'].includes(r))
      : !!organisationId; // If no roles, allow any user with organisation context
    
    if (!isAuthorized) {
      const error: any = new Error('Not found');
      error.statusCode = 404;
      throw error;
    }
  }

  getSnapshot = async (request: FastifyRequest, reply: FastifyReply) => {
    this.validateAccess(request);
    const { organisationId, tokenType, locationId } = request.authContext;

    if (!organisationId) {
      const error: any = new Error('Not found');
      error.statusCode = 404;
      throw error;
    }

    const includeCanonicalParity = Boolean((request.query as any)?.includeCanonicalParity);

    const [
      supplierCount,
      pendingSupplierCount,
      productCount,
      xeroInvoiceCount,
      invoiceCount,
      invoiceFileCount,
      pendingReviewCount,
      xeroConnection,
      latestSyncRun
    ] = await Promise.all([
      prisma.supplier.count({ where: { organisationId } }),
      prisma.supplier.count({ where: { organisationId, status: 'PENDING_REVIEW' } }),
      prisma.product.count({ where: { organisationId } }),
      prisma.xeroInvoice.count({ where: { organisationId } }),
      prisma.invoice.count({ where: { organisationId } }),
      prisma.invoiceFile.count({ where: { organisationId } }),
      prisma.invoiceFile.count({ where: { organisationId, reviewStatus: 'NEEDS_REVIEW' } }),
      prisma.xeroConnection.findFirst({
        where: { organisationId },
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.xeroSyncRun.findFirst({
        where: { organisationId },
        orderBy: { startedAt: 'desc' }
      })
    ]);

    // Canonical diagnostics (scoped rollout + operational checks)
    const enabledForOrg = isCanonicalLinesEnabledForOrg(organisationId);
    let canonicalOperationalOk = true;
    let canonicalOperationalError: string | null = null;
    let canonicalInvoiceCount = 0;
    let canonicalLineCount = 0;
    let warnRate: number | null = null;
    let warnReasonsBreakdown: { totalWarnLines: number; byReason: Record<string, number> } | null = null;
    let lastWriteAt: string | null = null;
    let lastInvoiceDate: string | null = null;

    try {
      const canonicalInvoiceWhere: any = {
        organisationId,
        deletedAt: null,
        ...(tokenType === 'location' && locationId ? { locationId } : {}),
      };

      const canonicalLineWhere: any = {
        organisationId,
        ...(tokenType === 'location' && locationId ? { locationId } : {}),
        canonicalInvoice: { deletedAt: null },
      };

      const [invAgg, linesCount, okLines, warnLines] = await Promise.all([
        (prisma as any).canonicalInvoice.aggregate({
          where: canonicalInvoiceWhere,
          _max: { updatedAt: true, date: true },
        }),
        (prisma as any).canonicalInvoiceLineItem.count({ where: canonicalLineWhere }),
        (prisma as any).canonicalInvoiceLineItem.count({ where: { ...canonicalLineWhere, qualityStatus: 'OK' } }),
        (prisma as any).canonicalInvoiceLineItem.count({ where: { ...canonicalLineWhere, qualityStatus: 'WARN' } }),
      ]);

      canonicalInvoiceCount = await (prisma as any).canonicalInvoice.count({ where: canonicalInvoiceWhere });
      canonicalLineCount = Number(linesCount || 0);

      const denom = Number(okLines || 0) + Number(warnLines || 0);
      warnRate = denom > 0 ? Number(warnLines || 0) / denom : null;

      lastWriteAt = invAgg?._max?.updatedAt ? new Date(invAgg._max.updatedAt).toISOString() : null;
      lastInvoiceDate = invAgg?._max?.date ? new Date(invAgg._max.date).toISOString() : null;

      // WARN breakdown by reason (from persisted warnReasons array)
      const locFilter =
        tokenType === 'location' && locationId ? Prisma.sql`AND li."locationId" = ${locationId}` : Prisma.empty;
      const warnReasonRows = await prisma.$queryRaw<Array<{ reason: string; count: number }>>(
        Prisma.sql`
          SELECT reason, COUNT(*)::int AS count
          FROM (
            SELECT unnest(li."warnReasons") AS reason
            FROM "CanonicalInvoiceLineItem" li
            JOIN "CanonicalInvoice" ci ON ci.id = li."canonicalInvoiceId"
            WHERE li."organisationId" = ${organisationId}
              ${locFilter}
              AND li."qualityStatus" = 'WARN'
              AND ci."deletedAt" IS NULL
          ) t
          GROUP BY reason
          ORDER BY count DESC
        `
      );
      const byReason: Record<string, number> = {};
      for (const r of warnReasonRows || []) byReason[String(r.reason)] = Number((r as any).count || 0);
      warnReasonsBreakdown = { totalWarnLines: Number(warnLines || 0), byReason };
    } catch (e: any) {
      canonicalOperationalOk = false;
      canonicalOperationalError = e?.message || String(e);
    }

    // Optional parity (on-demand only)
    let parity: any = null;
    if (includeCanonicalParity) {
      const checkedAt = new Date().toISOString();
      if (tokenType === 'location' && locationId) {
        const report = await supplierInsightsService.getCanonicalParityChecklist(organisationId, locationId);
        parity = {
          ok: report.ok,
          checkedAt,
          organisationId,
          locationId,
          report,
        };
      } else {
        parity = {
          ok: false,
          checkedAt,
          organisationId,
          locationId: null,
          report: { ok: false, error: 'Parity requires a location-context token (select a location first).' },
        };
      }
    }

    // DTO Mapping: Convert all Date fields to ISO strings
    const responseDto = {
      meta: {
        serverTimeUtc: new Date().toISOString(),
        env: config.NODE_ENV,
        dbConnected: true
      },
      counts: {
        suppliers: { total: supplierCount, pendingReview: pendingSupplierCount },
        products: { total: productCount },
        xeroInvoices: { total: xeroInvoiceCount },
        invoices: { total: invoiceCount },
        invoiceFiles: { 
            total: invoiceFileCount,
            needsReview: pendingReviewCount
        }
      },
      xero: {
        connection: xeroConnection ? {
          tenantName: xeroConnection.tenantName,
          lastSuccessfulSyncAt: xeroConnection.lastSuccessfulSyncAt 
            ? xeroConnection.lastSuccessfulSyncAt.toISOString() 
            : null
        } : null,
        latestSyncRun: latestSyncRun ? {
          status: latestSyncRun.status,
          startedAt: latestSyncRun.startedAt.toISOString(),
          finishedAt: latestSyncRun.finishedAt 
            ? latestSyncRun.finishedAt.toISOString() 
            : null,
          rowsProcessed: latestSyncRun.rowsProcessed,
          errorMessage: latestSyncRun.errorMessage
        } : null
      },
      canonical: {
        enabledForOrg,
        operational: { ok: canonicalOperationalOk, error: canonicalOperationalError },
        counts: { invoices: canonicalInvoiceCount, lines: canonicalLineCount },
        warnRate,
        warnReasonsBreakdown,
        lastWriteAt,
        lastInvoiceDate,
        parity,
      },
    };

    return reply.status(200).send(responseDto);
  }

  triggerSync = async (request: FastifyRequest, reply: FastifyReply) => {
    this.validateAccess(request);
    const { organisationId } = request.authContext;

    if (!organisationId) {
      const error: any = new Error('Not found');
      error.statusCode = 404;
      throw error;
    }

    // 1. Smart Resolve: Find latest connection
    const connection = await prisma.xeroConnection.findFirst({
      where: { organisationId },
      orderBy: { updatedAt: 'desc' }
    });

    if (!connection) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }

    // 2. Concurrency Check
    const activeRun = await prisma.xeroSyncRun.findFirst({
      where: {
        xeroConnectionId: connection.id,
        status: { in: [XeroSyncStatus.PENDING, XeroSyncStatus.IN_PROGRESS] }
      }
    });

    if (activeRun) {
      return reply.status(409).send({ 
        error: { 
            code: 'SYNC_IN_PROGRESS', 
            message: 'Sync already in progress for this connection' 
        } 
      });
    }

    // 3. Create PENDING Run
    const newRun = await prisma.xeroSyncRun.create({
      data: {
        organisationId: connection.organisationId,
        xeroConnectionId: connection.id,
        tenantId: connection.xeroTenantId,
        triggerType: XeroSyncTriggerType.MANUAL,
        scope: XeroSyncScope.INCREMENTAL,
        status: XeroSyncStatus.PENDING
      }
    });

    // 4. Notify frontend via Pusher (wrapped in try/catch to prevent failure)
    try {
      await pusherService.triggerEvent(
        pusherService.getOrgChannel(connection.organisationId),
        'xero-sync-started',
        {
          organisationId: connection.organisationId,
          runId: newRun.id,
          connectionId: connection.id,
          startedAt: new Date().toISOString()
        }
      );
    } catch (pusherError) {
      console.error('[DiagnosticsController] Pusher event failed (non-fatal)', pusherError);
      // Continue even if Pusher fails
    }

    // 5. Fire-and-Forget Safety: Wrap to prevent unhandled rejections
    Promise.resolve().then(() => {
      return xeroSyncService.syncConnection({
        connectionId: connection.id,
        organisationId: connection.organisationId,
        scope: XeroSyncScope.INCREMENTAL,
        runId: newRun.id,
        triggerType: XeroSyncTriggerType.MANUAL
      });
    }).catch(async (err) => {
      console.error(`[DiagnosticsController] Manual sync failed for run ${newRun.id}`, err);
      const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
      await prisma.xeroSyncRun.update({
        where: { id: newRun.id },
        data: { 
          status: XeroSyncStatus.FAILED, 
          finishedAt: new Date(), 
          errorMessage: message 
        }
      });
    });

    // 6. Return 202 Accepted (with explicit ISO string conversion)
    return reply.status(202).send({
      id: newRun.id,
      status: newRun.status,
      triggerType: newRun.triggerType,
      scope: newRun.scope,
      startedAt: newRun.startedAt.toISOString()
    });
  }
}

