import prisma from '../src/infrastructure/prismaClient';
import { XeroSyncService } from '../src/services/xeroSyncService';
import { XeroConnectionRepository } from '../src/repositories/xeroConnectionRepository';

const syncService = new XeroSyncService();
const connectionRepo = new XeroConnectionRepository();

async function backfill() {
  console.log('Starting Supplier Backfill via Full Sync...');
  console.log('Note: Existing XeroInvoice records lack Contact info, so we must re-fetch from Xero to resolve Suppliers.');

  try {
    // 1. Get all active Xero Connections
    const connections = await prisma.xeroConnection.findMany({
        select: { id: true, organisationId: true }
    });

    console.log(`Found ${connections.length} connections to sync.`);

    for (const conn of connections) {
        console.log(`Syncing Organisation: ${conn.organisationId}`);
        try {
            // Trigger sync (this handles pagination, token refresh, and supplier resolution)
            await syncService.syncInvoices(conn.organisationId, conn.id);
            console.log(`Completed sync for ${conn.organisationId}`);
        } catch (err) {
            console.error(`Failed to sync ${conn.organisationId}:`, err);
        }
    }

    console.log('Backfill complete.');

  } catch (error) {
    console.error('Backfill script failed:', error);
  } finally {
      await prisma.$disconnect();
  }
}

backfill();
