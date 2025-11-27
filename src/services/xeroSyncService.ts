import { XeroClient, Invoice } from 'xero-node';
import { config } from '../config/env';
import prisma from '../infrastructure/prismaClient';
import { XeroConnectionRepository } from '../repositories/xeroConnectionRepository';
import { SupplierService } from './supplierService';
import { XeroService } from './xeroService';
import { decryptToken } from '../utils/crypto';
import { Prisma } from '@prisma/client';
import { getProductKeyFromLineItem } from './helpers/productKey';

const connectionRepo = new XeroConnectionRepository();
const supplierService = new SupplierService();
const xeroService = new XeroService();

export class XeroSyncService {
  private readonly MAX_RETRIES = 3;

  async syncInvoices(organisationId: string, connectionId: string): Promise<void> {
    console.log(`[XeroSync] Starting sync for org ${organisationId}`);
    
    // 1. Get Connection
    let connection = await connectionRepo.findById(connectionId);
    if (!connection || connection.organisationId !== organisationId) {
      console.error(`[XeroSync] Connection not found or mismatch for org ${organisationId} and connection ${connectionId}`);
      throw new Error('Connection not found or mismatch');
    }

    // 2. Check Token Expiry and Refresh if needed
    if (connection.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
      console.log('[XeroSync] Token expiring soon, refreshing...');
      try {
          await xeroService.refreshAccessToken(connectionId);
          connection = await connectionRepo.findById(connectionId);
          if (!connection) throw new Error('Connection lost after refresh');
      } catch (err) {
          console.error('[XeroSync] Token refresh failed', err);
          throw err;
      }
    }

    // 3. Get Sync State for Incremental Sync
    const syncLog = await prisma.xeroSyncLog.findFirst({
      where: { organisationId, xeroConnectionId: connectionId },
      orderBy: { lastRunAt: 'desc' },
    });

    const lastModified = syncLog?.lastModifiedDateProcessed || undefined;
    console.log(`[XeroSync] Last modified date processed: ${lastModified}`);

    // 4. Initialize Xero Client
    const xero = new XeroClient({
      clientId: config.XERO_CLIENT_ID,
      clientSecret: config.XERO_CLIENT_SECRET,
    });

    const decryptedToken = decryptToken(connection.accessToken);
    await xero.setTokenSet({ access_token: decryptedToken });

    let page = 1;
    let hasMore = true;
    let maxModifiedDate = lastModified;

    console.log(`[XeroSync] Starting sync loop. Page: ${page}, LastModified: ${lastModified}`);

    // Create new sync log entry
    const currentSyncLog = await prisma.xeroSyncLog.create({
        data: {
            organisationId,
            xeroConnectionId: connectionId,
            status: 'IN_PROGRESS',
            lastRunAt: new Date(),
        }
    });

    try {
      while (hasMore) {
        // Rate Limit Handling Loop
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
                await this.processInvoice(organisationId, invoice);
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

      // Update Sync Log Success
      await prisma.xeroSyncLog.update({
          where: { id: currentSyncLog.id },
          data: {
              status: 'SUCCESS',
              lastModifiedDateProcessed: maxModifiedDate,
          }
      });
      console.log('[XeroSync] Sync completed successfully. Max Modified Date:', maxModifiedDate);

    } catch (error: any) {
        console.error('[XeroSync] Sync failed', error);
        await prisma.xeroSyncLog.update({
            where: { id: currentSyncLog.id },
            data: {
                status: 'FAILED',
                message: error.message,
            }
        });
        throw error;
    }
  }

  private async processInvoice(organisationId: string, invoice: Invoice) {
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
        // 0. Resolve Location ID for Product Linking
        let locationId: string | undefined;
        
        // Try to find ANY location for this org (simplest fallback)
        // In a real scenario, we should link invoice to specific location if possible.
        // Here we fallback to the first location found for the org or linked connection.
        const connection = await tx.xeroConnection.findFirst({
             where: { organisationId },
             include: { locationLinks: true }
        });
        
        if (connection?.locationLinks?.[0]?.locationId) {
            locationId = connection.locationLinks[0].locationId;
        } else {
             // Fallback
             const loc = await tx.location.findFirst({ where: { organisationId } });
             locationId = loc?.id;
        }

        if (!locationId) {
             console.warn(`[XeroSync] No location found for org ${organisationId}. Product linking skipped.`);
        }

        // 1. Upsert Invoice Header
        const xeroInvoice = await tx.xeroInvoice.upsert({
            where: { xeroInvoiceId: invoice.invoiceID },
            update: {
                invoiceNumber: invoice.invoiceNumber,
                reference: invoice.reference,
                type: invoice.type,
                status: invoice.status,
                date: invoice.date ? new Date(invoice.date) : null,
                dueDate: invoice.dueDate ? new Date(invoice.dueDate) : null,
                total: invoice.total,
                subTotal: invoice.subTotal,
                taxAmount: invoice.totalTax,
                amountDue: invoice.amountDue,
                amountPaid: invoice.amountPaid,
                currencyCode: invoice.currencyCode,
                updatedDateUTC: invoice.updatedDateUTC ? new Date(invoice.updatedDateUTC) : null,
                supplierId: supplier.id,
                organisationId,
            },
            create: {
                organisationId,
                xeroInvoiceId: invoice.invoiceID!,
                invoiceNumber: invoice.invoiceNumber,
                reference: invoice.reference,
                type: invoice.type,
                status: invoice.status,
                date: invoice.date ? new Date(invoice.date) : null,
                dueDate: invoice.dueDate ? new Date(invoice.dueDate) : null,
                total: invoice.total,
                subTotal: invoice.subTotal,
                taxAmount: invoice.totalTax,
                amountDue: invoice.amountDue,
                amountPaid: invoice.amountPaid,
                currencyCode: invoice.currencyCode,
                updatedDateUTC: invoice.updatedDateUTC ? new Date(invoice.updatedDateUTC) : null,
                supplierId: supplier.id,
                organisationId,
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
