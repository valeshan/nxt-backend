import { XeroClient, Invoice } from 'xero-node';
import { config } from '../config/env';
import prisma from '../infrastructure/prismaClient';
import { XeroConnectionRepository } from '../repositories/xeroConnectionRepository';
import { SupplierService } from './supplierService';
import { XeroService } from './xeroService';
import { decryptToken } from '../utils/crypto';
import { Prisma, XeroSyncScope, XeroSyncStatus, XeroSyncTriggerType } from '@prisma/client';
import { getProductKeyFromLineItem } from './helpers/productKey';

const connectionRepo = new XeroConnectionRepository();
const supplierService = new SupplierService();
const xeroService = new XeroService();

interface SyncConnectionParams {
  connectionId: string;
  organisationId: string;
  scope: XeroSyncScope;
  runId?: string;
}

export class XeroSyncService {
  private readonly MAX_RETRIES = 3;

  async syncConnection(params: SyncConnectionParams): Promise<void> {
    const { connectionId, organisationId, scope, runId } = params;
    console.log(`[XeroSync] Starting sync for org ${organisationId}, connection ${connectionId}, scope ${scope}, runId ${runId}`);
    
    // 1. Validation: Get Connection
    let connection = await connectionRepo.findById(connectionId);
    if (!connection) {
      console.error(`[XeroSync] Connection not found for connection ${connectionId}`);
      throw new Error('Connection not found');
    }
    if (connection.organisationId !== organisationId) {
      console.error(`[XeroSync] Mismatch: Connection org ${connection.organisationId} !== params org ${organisationId}`);
      throw new Error('Connection organisation mismatch');
    }

    // 2. Run Management
    let currentRunId = runId;
    let effectiveScope = scope;

    if (runId) {
        // Case A: runId provided (Controller created it)
        // Load existing run and transition to IN_PROGRESS
        const existingRun = await prisma.xeroSyncRun.findUnique({ where: { id: runId } });
        if (!existingRun) {
            throw new Error(`Sync run ${runId} not found`);
        }
        await prisma.xeroSyncRun.update({
            where: { id: runId },
            data: {
                status: XeroSyncStatus.IN_PROGRESS,
                startedAt: new Date()
            }
        });
    } else {
        // Case B: runId NOT provided (Internal call)
        // Concurrency Check
        const activeRun = await prisma.xeroSyncRun.findFirst({
            where: {
                xeroConnectionId: connectionId,
                status: { in: [XeroSyncStatus.PENDING, XeroSyncStatus.IN_PROGRESS] }
            }
        });

        if (activeRun) {
            console.warn(`[XeroSync] Sync already in progress for connection ${connectionId} (Run ${activeRun.id})`);
            throw new Error('Sync already in progress');
        }

        // Create new run
        const newRun = await prisma.xeroSyncRun.create({
            data: {
                organisationId,
                xeroConnectionId: connectionId,
                triggerType: XeroSyncTriggerType.MANUAL, // Default for internal calls
                scope: scope,
                status: XeroSyncStatus.IN_PROGRESS,
                tenantId: connection.xeroTenantId
            }
        });
        currentRunId = newRun.id;
    }

    // 3. Upgrade Logic & Token Refresh
    try {
        // Check Token Expiry and Refresh if needed
        if (connection.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
            console.log('[XeroSync] Token expiring soon, refreshing...');
            await xeroService.refreshAccessToken(connectionId);
            // Re-fetch connection to get new tokens
            const refreshed = await connectionRepo.findById(connectionId);
            if (!refreshed) throw new Error('Connection lost after refresh');
            connection = refreshed;
        }

        // Upgrade Scope if never successfully synced
        if (effectiveScope === XeroSyncScope.INCREMENTAL && !connection.lastSuccessfulSyncAt) {
            console.log('[XeroSync] First successful sync missing. Upgrading scope to FULL.');
            effectiveScope = XeroSyncScope.FULL;
            
            // Update run record to reflect actual scope
            if (currentRunId) {
                await prisma.xeroSyncRun.update({
                    where: { id: currentRunId },
                    data: { scope: XeroSyncScope.FULL }
                });
            }
        }

        // 4. Determine Sync Window
        let lastModified: Date | undefined = undefined;
        if (effectiveScope === XeroSyncScope.INCREMENTAL && connection.lastSuccessfulSyncAt) {
            lastModified = connection.lastSuccessfulSyncAt;
        }
        // If FULL, lastModified stays undefined (syncs everything available or default window)

        console.log(`[XeroSync] Syncing with LastModified: ${lastModified}`);

        // 5. Initialize Xero Client
        const xero = new XeroClient({
            clientId: config.XERO_CLIENT_ID || '',
            clientSecret: config.XERO_CLIENT_SECRET || '',
        });

        const decryptedToken = decryptToken(connection.accessToken);
        await xero.setTokenSet({ access_token: decryptedToken });

        let page = 1;
        let hasMore = true;
        let maxModifiedDate = lastModified;
        let totalRowsProcessed = 0;

        // 6. Sync Loop
        while (hasMore) {
            let invoicesResponse: any;
            let attempts = 0;
            
            while (attempts < this.MAX_RETRIES) {
                try {
                    console.log(`[XeroSync] Fetching invoices. Page: ${page}, Attempt: ${attempts + 1}`);
                    invoicesResponse = await xero.accountingApi.getInvoices(
                        connection.xeroTenantId,
                        lastModified, // IfModifiedSince
                        'Type=="ACCPAY"', // Where clause (only bills)
                        'Date', // Order by
                        undefined, // Ids
                        undefined, // InvoiceNumbers
                        undefined, // ContactIDs
                        ['AUTHORISED', 'PAID', 'VOIDED'], // Statuses
                        page, // Page
                        true, // IncludeArchived
                        false, // CreatedByMyApp
                        true // UnitDP (4dp)
                    );
                    break; // Success
                } catch (error: any) {
                    console.error(`[XeroSync] API Error on page ${page}`, error.response ? error.response.statusCode : error.message);
                    if (error.response && error.response.statusCode === 429) {
                        const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10);
                        console.log(`[XeroSync] Rate limited. Sleeping for ${retryAfter}s`);
                        await new Promise(resolve => setTimeout(resolve, (retryAfter + 2) * 1000));
                        attempts++;
                    } else {
                        throw error;
                    }
                }
            }

            if (!invoicesResponse || !invoicesResponse.body || !invoicesResponse.body.invoices) {
                console.log(`[XeroSync] No invoices returned in response body for page ${page}. Stopping.`);
                hasMore = false;
                break;
            }

            const invoices: Invoice[] = invoicesResponse.body.invoices;
            console.log(`[XeroSync] Page ${page} returned ${invoices.length} invoices.`);
            
            if (invoices.length === 0) {
                hasMore = false;
                break;
            }

            console.log(`[XeroSync] Processing page ${page} with ${invoices.length} invoices`);

            for (const invoice of invoices) {
                try {
                    await this.processInvoice(organisationId, connectionId, invoice);
                    totalRowsProcessed++;
                } catch (err) {
                    console.error(`[XeroSync] Failed to process invoice ${invoice.invoiceID}:`, err);
                    // Continue with next invoice
                }
                
                // Track max updated date
                if (invoice.updatedDateUTC) {
                    const invoiceDate = new Date(invoice.updatedDateUTC);
                    if (!maxModifiedDate || invoiceDate > maxModifiedDate) {
                        maxModifiedDate = invoiceDate;
                    }
                }
            }

            page++;
        }

        // 7. Completion - Success
        console.log('[XeroSync] Sync completed successfully. Max Modified Date:', maxModifiedDate);
        
        const finishedAt = new Date();
        
        // Update Run
        if (currentRunId) {
            await prisma.xeroSyncRun.update({
                where: { id: currentRunId },
                data: {
                    status: XeroSyncStatus.SUCCESS,
                    finishedAt,
                    rowsProcessed: totalRowsProcessed
                }
            });
        }

        // Update Connection Last Sync
        // Use maxModifiedDate if available, otherwise use sync end time as fallback (though maxModified is safer for incremental)
        // If we did a FULL sync and got no data, we can still mark 'now' as sync point?
        // Actually, if maxModifiedDate is null (no invoices found), we should probably set 'now' so next incremental works?
        // Or keep previous? If we found nothing, nothing changed.
        // Let's update to 'now' if full sync succeeded, or maxModifiedDate if incremental found stuff.
        const newSyncTimestamp = maxModifiedDate || finishedAt;
        
        await prisma.xeroConnection.update({
            where: { id: connectionId },
            data: { lastSuccessfulSyncAt: newSyncTimestamp }
        });

    } catch (error: any) {
        console.error('[XeroSync] Sync failed', error);
        
        // 7. Completion - Failure
        if (currentRunId) {
            await prisma.xeroSyncRun.update({
                where: { id: currentRunId },
                data: {
                    status: XeroSyncStatus.FAILED,
                    finishedAt: new Date(),
                    errorMessage: error instanceof Error ? error.message : String(error)
                }
            });
        }
        
        // Re-throw to ensure caller knows it failed (if awaited)
        throw error;
    }
  }

  private async processInvoice(organisationId: string, connectionId: string, invoice: Invoice) {
    if (!invoice.invoiceID || !invoice.contact) {
        console.warn(`[XeroSync] Skipping invalid invoice: ID=${invoice.invoiceID}, Contact=${!!invoice.contact}`);
        return;
    }

    // Resolve Supplier
    const contactId = invoice.contact.contactID!;
    const contactName = invoice.contact.name!;
    
    const supplier = await supplierService.resolveSupplierFromXero(
        organisationId,
        contactId,
        contactName
    );

    // Transactional Upsert
    await prisma.$transaction(async (tx) => {
        // 0. Resolve Location ID for Product Linking and Invoice
        let locationId: string | null = null;
        let xeroTenantId: string | null = null;

        // Resolve active connection to get tenantId and locationLinks
        const connection = await tx.xeroConnection.findUnique({
            where: { id: connectionId },
            include: { locationLinks: true }
        });

        if (connection) {
            xeroTenantId = connection.xeroTenantId;
            const links = connection.locationLinks;
            
            if (links.length === 1) {
                locationId = links[0].locationId;
            } else if (links.length > 1) {
                console.warn(`[XeroSync] Ambiguous location mapping for connection ${connectionId}. Links found: ${links.length}. Skipping location assignment.`);
                locationId = null;
            } else {
                // 0 links
                locationId = null;
            }
        }

        if (!locationId) {
             console.warn(`[XeroSync] No unique location found for connection ${connectionId}. Product linking skipped. Invoice will be org-wide only.`);
        }

        // 1. Upsert Invoice Header
        // Fix for type mismatch: explicitly cast or handle enums properly if needed. 
        // The errors indicate that the Xero types (TypeEnum, StatusEnum, etc.) might not exactly match strings in Prisma update.
        // Prisma schema uses Strings for these fields currently. 
        // We should ensure we are passing strings.
        
        const xeroInvoice = await tx.xeroInvoice.upsert({
            where: { xeroInvoiceId: invoice.invoiceID },
            update: {
                invoiceNumber: invoice.invoiceNumber,
                reference: invoice.reference,
                type: invoice.type ? String(invoice.type) : null,
                status: invoice.status ? String(invoice.status) : null,
                date: invoice.date ? new Date(invoice.date) : null,
                dueDate: invoice.dueDate ? new Date(invoice.dueDate) : null,
                total: invoice.total,
                subTotal: invoice.subTotal,
                taxAmount: invoice.totalTax,
                amountDue: invoice.amountDue,
                amountPaid: invoice.amountPaid,
                currencyCode: invoice.currencyCode ? String(invoice.currencyCode) : null,
                updatedDateUTC: invoice.updatedDateUTC ? new Date(invoice.updatedDateUTC) : null,
                supplierId: supplier.id,
                organisationId,
                locationId,
                xeroTenantId,
            },
            create: {
                organisationId,
                xeroInvoiceId: invoice.invoiceID!,
                invoiceNumber: invoice.invoiceNumber,
                reference: invoice.reference,
                type: invoice.type ? String(invoice.type) : null,
                status: invoice.status ? String(invoice.status) : null,
                date: invoice.date ? new Date(invoice.date) : null,
                dueDate: invoice.dueDate ? new Date(invoice.dueDate) : null,
                total: invoice.total,
                subTotal: invoice.subTotal,
                taxAmount: invoice.totalTax,
                amountDue: invoice.amountDue,
                amountPaid: invoice.amountPaid,
                currencyCode: invoice.currencyCode ? String(invoice.currencyCode) : null,
                updatedDateUTC: invoice.updatedDateUTC ? new Date(invoice.updatedDateUTC) : null,
                supplierId: supplier.id,
                locationId,
                xeroTenantId,
            },
        });

        // 2. Delete existing line items (simplest strategy for updates)
        await tx.xeroInvoiceLineItem.deleteMany({
            where: { invoiceId: xeroInvoice.id },
        });

        // 3. Create Line Items with Product Linking
        if (invoice.lineItems && invoice.lineItems.length > 0) {
            const lineItemsData = [];
            
            for (const li of invoice.lineItems) {
                let productId: string | null = null;
                
                if (locationId) {
                    const productKey = getProductKeyFromLineItem(li.itemCode, li.description);
                    
                    if (productKey !== 'unknown') {
                        // Upsert Product
                        const product = await tx.product.upsert({
                            where: {
                                organisationId_locationId_productKey: {
                                    organisationId,
                                    locationId,
                                    productKey
                                }
                            },
                            update: {},
                            create: {
                                organisationId,
                                locationId,
                                productKey,
                                name: (li.itemCode || li.description || 'Unknown').trim(),
                                supplierId: null // Can be backfilled later
                            }
                        });
                        productId = product.id;
                    }
                }

                lineItemsData.push({
                    invoiceId: xeroInvoice.id,
                    description: li.description,
                    quantity: li.quantity,
                    unitAmount: li.unitAmount,
                    lineAmount: li.lineAmount,
                    taxAmount: li.taxAmount,
                    itemCode: li.itemCode,
                    accountCode: li.accountCode,
                    productId: productId
                });
            }

            await tx.xeroInvoiceLineItem.createMany({
                data: lineItemsData,
            });
        }
    });
  }
}
