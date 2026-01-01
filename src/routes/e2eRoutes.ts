import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import z from 'zod';
import prisma from '../infrastructure/prismaClient';

export default async function e2eRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * POST /e2e/reset/location/:locationId
   * 
   * E2E test-only endpoint to reset a location's auto-approve state and delete all invoice data.
   * This makes tests deterministic by ensuring the location is in a "first verified invoice" state.
   * 
   * Guards:
   * - Only available when NODE_ENV !== 'production'
   * - Requires x-e2e-reset-secret header matching E2E_RESET_SECRET env var
   * - Returns 404 if guards fail (to avoid endpoint discovery)
   */
  app.post('/reset/location/:locationId', {
    schema: {
      params: z.object({ locationId: z.string() }),
      response: {
        200: z.object({
          ok: z.boolean(),
        }),
      },
    },
  }, async (request: FastifyRequest<{ Params: { locationId: string } }>, reply: FastifyReply) => {
    const { locationId } = request.params;

    // Guard 1: Only allow in non-production environments
    if (process.env.NODE_ENV === 'production') {
      return reply.status(404).send();
    }

    // Guard 2: Require secret header
    const resetSecret = request.headers['x-e2e-reset-secret'];
    const expectedSecret = process.env.E2E_RESET_SECRET;
    
    if (!resetSecret || !expectedSecret || resetSecret !== expectedSecret) {
      return reply.status(404).send(); // hide existence in prod
    }

    // Verify location exists and derive organisationId
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, organisationId: true },
    });

    if (!location) {
      return reply.status(404).send();
    }

    const organisationId = location.organisationId;

    // Log only in non-test environments
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[E2E Reset] Resetting auto-approve prompt state for location ${locationId} (organisation: ${organisationId})`);
    }

    // Perform all deletions and updates in a single transaction
    await prisma.$transaction(async (tx) => {
      // 1. Get all invoice files for this location (to delete related data)
      const invoiceFiles = await tx.invoiceFile.findMany({
        where: { locationId },
        select: { id: true },
      });
      const invoiceFileIds = invoiceFiles.map(f => f.id);

      // 2. Get all invoices for this location (to delete line items)
      const invoices = await tx.invoice.findMany({
        where: { locationId },
        select: { id: true },
      });
      const invoiceIds = invoices.map(i => i.id);

      // 3. Delete InvoiceLineItems (cascades from Invoice, but being explicit for clarity)
      if (invoiceIds.length > 0) {
        await tx.invoiceLineItem.deleteMany({
          where: { invoiceId: { in: invoiceIds } },
        });
      }

      // 4. Delete Invoices
      if (invoiceIds.length > 0) {
        await tx.invoice.deleteMany({
          where: { id: { in: invoiceIds } },
        });
      }

      // 5. Delete InvoiceOcrResult (linked to InvoiceFile)
      if (invoiceFileIds.length > 0) {
        await tx.invoiceOcrResult.deleteMany({
          where: { invoiceFileId: { in: invoiceFileIds } },
        });
      }

      // 6. Delete InvoiceFiles
      if (invoiceFileIds.length > 0) {
        await tx.invoiceFile.deleteMany({
          where: { id: { in: invoiceFileIds } },
        });
      }

      // 7. Delete OCR-created Suppliers for this organisation
      // Only delete suppliers that were created by OCR (not manually created or from Xero)
      // IMPORTANT: Delete dependent rows first to avoid FK constraint failures.
      const ocrSuppliers = await tx.supplier.findMany({
        where: {
          organisationId,
          sourceType: 'OCR',
        },
        select: { id: true },
      });

      const ocrSupplierIds = ocrSuppliers.map((s) => s.id);

      if (ocrSupplierIds.length > 0) {
        // SupplierSourceLink has a FK to Supplier; clear links first.
        await tx.supplierSourceLink.deleteMany({
          where: {
            supplierId: { in: ocrSupplierIds },
          },
        });

        // If you have other supplier-dependent tables (aliases, configs, etc.), delete them here too.
        // Example (only if these models exist in your schema):
        // await tx.supplierAlias.deleteMany({ where: { supplierId: { in: ocrSupplierIds } } });

        await tx.supplier.deleteMany({
          where: {
            id: { in: ocrSupplierIds },
          },
        });
      }

      // 8. Update Location: reset auto-approve flags
      await tx.location.update({
        where: { id: locationId },
        data: {
          hasSeenAutoApprovePrompt: false,
          autoApproveCleanInvoices: false,
        },
      });
    });

    return reply.send({ ok: true });
  });
}

