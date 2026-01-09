import prisma from '../infrastructure/prismaClient';
import { supplierInsightsService } from './supplierInsightsService';
import * as Sentry from '@sentry/node';

/**
 * Service for backfilling locationId on historical Xero invoices that are missing
 * or have incorrect locationId assignments.
 * 
 * This is idempotent and safe to run multiple times. It only updates invoices
 * where locationId is NULL or clearly wrong (based on connection mapping).
 */

export interface BackfillOptions {
  organisationId: string;
  connectionId?: string; // If provided, only backfill invoices for this connection
  locationId?: string; // If provided, only backfill to this location
  dryRun?: boolean; // If true, only log what would be updated, don't actually update
  batchSize?: number; // Number of invoices to update per batch (default: 1000)
  maxBatches?: number; // Maximum number of batches to process (default: unlimited)
}

export interface BackfillResult {
  dryRun: boolean;
  totalInvoicesScanned: number;
  invoicesToUpdate: number;
  invoicesUpdated: number;
  batchesProcessed: number;
  affectedConnections: string[];
  affectedLocations: string[];
  sampleInvoiceIds: string[]; // First N invoice IDs that would be/were updated
  errors: Array<{ invoiceId: string; error: string }>;
}

export class XeroLocationBackfillService {
  /**
   * Backfill locationId for Xero invoices based on connection ↔ location mapping.
   * 
   * Process:
   * 1. Find all Xero connections with exactly one location link
   * 2. For each connection, find invoices with locationId NULL or mismatched
   * 3. Update invoices in batches
   * 4. Refresh ProductStats for affected (org, location, accountCodesHash) combinations
   */
  async backfillLocationIds(options: BackfillOptions): Promise<BackfillResult> {
    const {
      organisationId,
      connectionId,
      locationId,
      dryRun = false,
      batchSize = 1000,
      maxBatches
    } = options;

    console.log(`[XeroLocationBackfill] Starting backfill for org=${organisationId}`, {
      connectionId,
      locationId,
      dryRun,
      batchSize,
      maxBatches
    });

    const result: BackfillResult = {
      dryRun,
      totalInvoicesScanned: 0,
      invoicesToUpdate: 0,
      invoicesUpdated: 0,
      batchesProcessed: 0,
      affectedConnections: [],
      affectedLocations: [],
      sampleInvoiceIds: [],
      errors: []
    };

    try {
      // Step 1: Find connections with valid location mappings
      const connectionWhere: any = {
        organisationId,
        locationLinks: {
          some: {} // Has at least one location link
        }
      };

      if (connectionId) {
        connectionWhere.id = connectionId;
      }

      const connections = await prisma.xeroConnection.findMany({
        where: connectionWhere,
        include: {
          locationLinks: true
        }
      });

      // Filter to connections with exactly one location link (authoritative mapping)
      const validConnections = connections.filter(conn => {
        if (conn.locationLinks.length !== 1) {
          console.warn(
            `[XeroLocationBackfill] Skipping connection ${conn.id}: has ${conn.locationLinks.length} location links (expected 1)`
          );
          return false;
        }
        if (locationId && conn.locationLinks[0].locationId !== locationId) {
          return false; // Filter to specific location if requested
        }
        return true;
      });

      if (validConnections.length === 0) {
        console.log(`[XeroLocationBackfill] No valid connections found for backfill`);
        return result;
      }

      console.log(`[XeroLocationBackfill] Found ${validConnections.length} valid connections`);

      // Step 2: For each connection, find invoices needing backfill
      const invoicesToUpdate: Array<{
        invoiceId: string;
        connectionId: string;
        targetLocationId: string;
        xeroInvoiceId: string;
        invoiceNumber: string | null;
      }> = [];

      for (const conn of validConnections) {
        const targetLocationId = conn.locationLinks[0].locationId;
        result.affectedConnections.push(conn.id);
        if (!result.affectedLocations.includes(targetLocationId)) {
          result.affectedLocations.push(targetLocationId);
        }

        // Find invoices for this connection that need locationId update
        const invoiceWhere: any = {
          organisationId,
          xeroTenantId: conn.xeroTenantId,
          deletedAt: null,
          OR: [
            { locationId: null },
            { locationId: { not: targetLocationId } } // Mismatched location
          ]
        };

        const invoices = await prisma.xeroInvoice.findMany({
          where: invoiceWhere,
          select: {
            id: true,
            xeroInvoiceId: true,
            invoiceNumber: true,
            locationId: true
          },
          take: batchSize * (maxBatches || 100) // Reasonable limit for scanning
        });

        result.totalInvoicesScanned += invoices.length;

        for (const inv of invoices) {
          invoicesToUpdate.push({
            invoiceId: inv.id,
            connectionId: conn.id,
            targetLocationId,
            xeroInvoiceId: inv.xeroInvoiceId,
            invoiceNumber: inv.invoiceNumber
          });
        }

        console.log(
          `[XeroLocationBackfill] Connection ${conn.id} → Location ${targetLocationId}: found ${invoices.length} invoices needing update`
        );
      }

      result.invoicesToUpdate = invoicesToUpdate.length;

      // Step 3: Dry-run logging
      if (dryRun) {
        console.log(`[XeroLocationBackfill] DRY RUN: Would update ${invoicesToUpdate.length} invoices`);
        result.sampleInvoiceIds = invoicesToUpdate
          .slice(0, 20)
          .map(inv => inv.xeroInvoiceId);

        // Log sample
        for (let i = 0; i < Math.min(10, invoicesToUpdate.length); i++) {
          const inv = invoicesToUpdate[i];
          console.log(
            `[XeroLocationBackfill] DRY RUN: Would update invoice ${inv.invoiceNumber} (${inv.xeroInvoiceId}) → location ${inv.targetLocationId}`
          );
        }

        return result;
      }

      // Step 4: Batch updates
      const batches: typeof invoicesToUpdate[] = [];
      for (let i = 0; i < invoicesToUpdate.length; i += batchSize) {
        batches.push(invoicesToUpdate.slice(i, i + batchSize));
      }

      if (maxBatches) {
        batches.splice(maxBatches);
      }

      console.log(`[XeroLocationBackfill] Processing ${batches.length} batches`);

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        console.log(
          `[XeroLocationBackfill] Processing batch ${batchIdx + 1}/${batches.length} (${batch.length} invoices)`
        );

        try {
          await prisma.$transaction(async (tx) => {
            // Group by target location for efficient updates
            const byLocation = new Map<string, string[]>();
            for (const inv of batch) {
              if (!byLocation.has(inv.targetLocationId)) {
                byLocation.set(inv.targetLocationId, []);
              }
              byLocation.get(inv.targetLocationId)!.push(inv.invoiceId);
            }

            // Update each location group
            for (const [targetLocationId, invoiceIds] of byLocation.entries()) {
              const updated = await tx.xeroInvoice.updateMany({
                where: {
                  id: { in: invoiceIds },
                  organisationId,
                  deletedAt: null
                },
                data: {
                  locationId: targetLocationId
                }
              });

              console.log(
                `[XeroLocationBackfill] Updated ${updated.count} invoices to location ${targetLocationId}`
              );
              result.invoicesUpdated += updated.count;
            }
          });

          result.batchesProcessed++;
          result.sampleInvoiceIds.push(...batch.slice(0, 5).map(inv => inv.xeroInvoiceId));
        } catch (error: any) {
          console.error(`[XeroLocationBackfill] Batch ${batchIdx + 1} failed:`, error);
          for (const inv of batch) {
            result.errors.push({
              invoiceId: inv.xeroInvoiceId,
              error: error.message || String(error)
            });
          }
        }
      }

      // Step 5: Refresh ProductStats for affected locations
      console.log(`[XeroLocationBackfill] Refreshing ProductStats for ${result.affectedLocations.length} locations`);

      for (const locId of result.affectedLocations) {
        try {
          // Refresh for all accountCodesHash combinations (undefined = all accounts)
          await supplierInsightsService.refreshProductStatsForLocation(organisationId, locId, undefined);

          // Also refresh for any configured account codes
          const accountConfigs = await prisma.locationAccountConfig.findMany({
            where: {
              locationId: locId,
              category: 'COGS'
            },
            select: { accountCode: true }
          });

          const accountCodes = accountConfigs.map(c => c.accountCode).filter(Boolean) as string[];
          if (accountCodes.length > 0) {
            await supplierInsightsService.refreshProductStatsForLocation(organisationId, locId, accountCodes);
          }

          console.log(`[XeroLocationBackfill] Refreshed ProductStats for location ${locId}`);
        } catch (error: any) {
          console.error(`[XeroLocationBackfill] Failed to refresh ProductStats for location ${locId}:`, error);
          Sentry.captureException(error, {
            tags: {
              component: 'xero-location-backfill',
              step: 'refresh_product_stats'
            },
            extra: {
              organisationId,
              locationId: locId
            }
          });
        }
      }

      console.log(`[XeroLocationBackfill] Backfill completed`, {
        invoicesUpdated: result.invoicesUpdated,
        batchesProcessed: result.batchesProcessed,
        errors: result.errors.length
      });

      return result;
    } catch (error: any) {
      console.error(`[XeroLocationBackfill] Backfill failed:`, error);
      Sentry.captureException(error, {
        tags: {
          component: 'xero-location-backfill',
          step: 'backfill_execution'
        },
        extra: {
          organisationId,
          connectionId,
          locationId
        }
      });
      throw error;
    }
  }
}

export const xeroLocationBackfillService = new XeroLocationBackfillService();



