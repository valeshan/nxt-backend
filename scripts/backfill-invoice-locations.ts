import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const prisma = new PrismaClient();

// Config
const DRY_RUN = process.env.DRY_RUN === 'true';

async function main() {
  console.log(`Starting Backfill: Invoice Locations and Tenant IDs`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (No writes)' : 'LIVE (Writes enabled)'}`);

  const organisations = await prisma.organisation.findMany({
    include: {
      xeroConnections: {
        include: {
          locationLinks: true
        }
      }
    }
  });

  console.log(`Found ${organisations.length} organisations to process.`);

  let totalOrgsProcessed = 0;
  let totalOrgsSkipped = 0;
  let totalInvoicesUpdated = 0;

  for (const org of organisations) {
    console.log(`Processing Org: ${org.name} (${org.id})`);
    
    const connections = org.xeroConnections;

    if (connections.length === 0) {
      console.log(`  -> Skipped: No Xero connections.`);
      totalOrgsSkipped++;
      continue;
    }

    // Strategy:
    // 1. Single Connection + Single Location Link => Full Backfill (Location + Tenant)
    // 2. Single Connection + No/Multiple Links => Partial Backfill (Tenant Only, Location Null)
    // 3. Multiple Connections => SKIP (Ambiguous for existing invoices without tenantId)

    if (connections.length > 1) {
      console.log(`  -> Skipped: Multiple Xero connections (${connections.length}). Cannot infer tenant/location for existing invoices safely.`);
      // Future improvement: If we had xeroTenantId on invoices already, we could map them. 
      // But this script is to POPULATE it.
      totalOrgsSkipped++;
      continue;
    }

    const connection = connections[0];
    const links = connection.locationLinks;
    const xeroTenantId = connection.xeroTenantId;

    let targetLocationId: string | null = null;
    let locationReason = "";

    if (links.length === 1) {
      targetLocationId = links[0].locationId;
      locationReason = "Single Location Link Found";
    } else if (links.length === 0) {
      targetLocationId = null;
      locationReason = "No Location Links";
    } else {
      targetLocationId = null;
      locationReason = `Ambiguous: ${links.length} Location Links`;
    }

    // Count invoices to be updated
    const invoiceCount = await prisma.xeroInvoice.count({
      where: {
        organisationId: org.id,
        // Optional: Only update if fields are missing? 
        // For safety, we can overwrite to ensure consistency if the heuristic holds.
        // But typically backfills target missing data.
        OR: [
            { locationId: null },
            { xeroTenantId: null }
        ]
      }
    });

    if (invoiceCount === 0) {
        console.log(`  -> No invoices needing update.`);
        continue;
    }

    console.log(`  -> Found ${invoiceCount} invoices.`);
    console.log(`  -> Action: Set xeroTenantId=${xeroTenantId}`);
    console.log(`  -> Action: Set locationId=${targetLocationId} (${locationReason})`);

    if (!DRY_RUN) {
        // Perform Batch Update
        const result = await prisma.xeroInvoice.updateMany({
            where: {
                organisationId: org.id
            },
            data: {
                xeroTenantId: xeroTenantId,
                locationId: targetLocationId // Prisma handles null correctly
            }
        });
        console.log(`  -> Updated ${result.count} invoices.`);
        totalInvoicesUpdated += result.count;
    } else {
        console.log(`  -> [DRY RUN] Would update ${invoiceCount} invoices.`);
    }
    
    totalOrgsProcessed++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Orgs Processed: ${totalOrgsProcessed}`);
  console.log(`Orgs Skipped (Ambiguous/No-Connection): ${totalOrgsSkipped}`);
  console.log(`Invoices Updated: ${DRY_RUN ? 0 : totalInvoicesUpdated} ${DRY_RUN ? '(0 actual)' : ''}`);
  console.log(`Done.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });










