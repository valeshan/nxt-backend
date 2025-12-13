import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { XeroSyncService } from '../services/xeroSyncService';
import { pusherService } from '../services/pusherService';
import { config } from '../config/env';
import { XeroSyncScope, XeroSyncStatus, XeroSyncTriggerType } from '@prisma/client';

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
    const { organisationId } = request.authContext;

    if (!organisationId) {
      const error: any = new Error('Not found');
      error.statusCode = 404;
      throw error;
    }

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
      }
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

