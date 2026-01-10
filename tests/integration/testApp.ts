import { buildApp } from '../../src/app';
import prisma from '../../src/infrastructure/prismaClient';

export async function buildTestApp() {
  const app = buildApp();
  await app.ready();
  return app;
}

export async function resetDb() {
  // Truncate all tables (order matters due to foreign keys)
  // Deleting userSettings first because it references user
  await prisma.userSettings.deleteMany();
  await prisma.productStats.deleteMany();
  await (prisma as any).canonicalInvoiceLineItem.deleteMany();
  await (prisma as any).canonicalInvoice.deleteMany();

  // Retro auto-approval audit tables (reference invoices/files/users)
  await (prisma as any).invoiceAuditEvent.deleteMany();
  await (prisma as any).retroAutoApproveBatch.deleteMany();
  
  await prisma.xeroInvoiceLineItem.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.xeroInvoice.deleteMany();
  await prisma.invoiceOcrResult.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.invoiceFile.deleteMany();
  
  // Products must be deleted after line items but before locations/suppliers
  await prisma.product.deleteMany();

  await prisma.xeroLocationLink.deleteMany();
  // Delete sync runs before connections
  await prisma.xeroSyncRun.deleteMany();
  await prisma.xeroConnection.deleteMany();
  
  await prisma.locationAccountConfig.deleteMany();
  await prisma.supplierAlias.deleteMany();
  await prisma.location.deleteMany();
  await prisma.supplierSourceLink.deleteMany();
  await prisma.supplier.deleteMany();
  
  // Delete UserOrganisation immediately before Organisation to minimize race windows
  await prisma.userOrganisation.deleteMany();
  
  // Delete lexicon entries before organisations (foreign key constraint)
  await (prisma as any).organisationLexiconEntry.deleteMany();
  
  // Delete billing webhook events (no foreign key constraints)
  await prisma.billingWebhookEvent.deleteMany();
  
  await prisma.organisation.deleteMany();
  
  // User must be last if referenced by others (which it is by UserSettings, UserOrganisation)
  await prisma.user.deleteMany();
}

export async function teardown() {
  // Do not disconnect when using the global singleton in tests.
  // Vitest reuses the process/environment, and disconnecting breaks subsequent tests.
  // The connections will be closed when the process exits.
  // await prisma.$disconnect();
}
