import { PrismaClient } from '@prisma/client';
import { getProductKeyFromLineItem } from '../src/services/helpers/productKey';

const prisma = new PrismaClient();

async function backfillProducts() {
  console.log('Starting Product backfill...');
  const startTime = Date.now();

  // Process in batches to avoid memory issues
  const BATCH_SIZE = 500;
  let processedCount = 0;
  let createdCount = 0;

  while (true) {
    // Fetch unlinked line items
    const lineItems = await prisma.xeroInvoiceLineItem.findMany({
        where: { productId: null },
        take: BATCH_SIZE,
        include: {
            invoice: {
                select: {
                    organisationId: true,
                    // We assume locationId is NOT on invoice directly but on organisation or handled higher up.
                    // Wait, schema shows Location is related to Organisation. XeroInvoice has organisationId.
                    // We need a locationId for Product.
                    // The plan says: "org + location from invoice".
                    // BUT XeroInvoice table DOES NOT have locationId column in the schema provided earlier!
                    // It only has organisationId.
                    // Let's check the schema again carefully.
                    // Location is via XeroLocationLink usually? Or implicit?
                    // Schema: XeroInvoice -> organisationId. No locationId on Invoice.
                    // However, Product table requires locationId.
                    // CRITICAL: How do we determine locationId for an invoice?
                    // XeroConnection links Org + Location.
                    // If an Org has multiple Locations, how do we know which one an invoice belongs to?
                    // Usually Xero doesn't support multi-location in one tenant in the same way, 
                    // OR we sync per connection which is tied to a location.
                    // Let's look at XeroConnection. It has locationLinks.
                    // If we can't determine locationId from invoice directly, we might default to the "primary" location 
                    // or the one linked to the connection that synced it?
                    // But Invoice doesn't store connectionId.
                    
                    // Fallback strategy for this script:
                    // 1. Find XeroConnection for the Org (assuming 1:1 for now or take first).
                    // 2. Get linked Location.
                    // 3. If multiple, this is ambiguous.
                    
                    // Let's check XeroConnectionRepository.findByOrganisation.
                }
            }
        }
    });

    if (lineItems.length === 0) {
        console.log('No more unlinked line items found.');
        break;
    }

    console.log(`Processing batch of ${lineItems.length} items...`);

    // Pre-fetch Orgs -> Location map to avoid queries in loop
    const distinctOrgIds = [...new Set(lineItems.map(li => li.invoice.organisationId))];
    const orgLocationMap = new Map<string, string>();

    for (const orgId of distinctOrgIds) {
        // Find a valid location for this org.
        // Ideally we want the one linked to Xero.
        const connection = await prisma.xeroConnection.findFirst({
            where: { organisationId: orgId },
            include: { locationLinks: true }
        });

        if (connection?.locationLinks?.[0]?.locationId) {
            orgLocationMap.set(orgId, connection.locationLinks[0].locationId);
        } else {
            // Fallback: Find ANY location for this org
            const loc = await prisma.location.findFirst({ where: { organisationId: orgId } });
            if (loc) {
                orgLocationMap.set(orgId, loc.id);
            } else {
                console.warn(`Skipping org ${orgId} - no location found.`);
            }
        }
    }

    // Process batch
    for (const item of lineItems) {
        const { organisationId } = item.invoice;
        const locationId = orgLocationMap.get(organisationId);
        
        if (!locationId) continue; // Skip if no location can be determined

        const productKey = getProductKeyFromLineItem(item.itemCode, item.description);
        
        if (productKey === 'unknown') continue;

        // Upsert Product (ensure it exists)
        // We use a transaction to ensure we get the ID safely even with races
        // (though script is single threaded usually, but safer).
        // Actually, cache products in memory for the batch?
        
        // Simple efficient approach: Upsert Product, then Update Item.
        // Note: Prisma upsert returns the object.
        
        try {
            // We can't use upsert easily with "where" unless uniqueness is perfect.
            // uniqueness is [organisationId, locationId, productKey].
            
            const product = await prisma.product.upsert({
                where: {
                    organisationId_locationId_productKey: {
                        organisationId,
                        locationId,
                        productKey
                    }
                },
                update: {}, // No change if exists
                create: {
                    organisationId,
                    locationId,
                    productKey,
                    name: (item.itemCode || item.description || 'Unknown Product').trim(),
                    supplierId: null // We can run the secondary script to fix this later
                }
            });

            await prisma.xeroInvoiceLineItem.update({
                where: { id: item.id },
                data: { productId: product.id }
            });

            if (product.createdAt.getTime() > startTime) {
                createdCount++;
            }
        } catch (e) {
            console.error(`Failed to process item ${item.id}:`, e);
        }
    }
    
    processedCount += lineItems.length;
    console.log(`Processed ${processedCount} items total...`);
  }

  console.log(`Backfill complete. Processed: ${processedCount}, Created Products: ${createdCount}`);
  const duration = (Date.now() - startTime) / 1000;
  console.log(`Duration: ${duration}s`);
}

backfillProducts()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

