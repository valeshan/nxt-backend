import { PrismaClient } from '@prisma/client';
import prisma from '../infrastructure/prismaClient';

type PrismaTransaction = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// Returns record data to avoid double queries. Returns null if not found/not owned.
export async function getInvoiceFileIfOwned(
  invoiceFileId: string, 
  organisationId: string,
  client: PrismaTransaction = prisma
): Promise<{ id: string; organisationId: string; locationId: string } | null> {
  return client.invoiceFile.findFirst({
    where: { id: invoiceFileId, organisationId, deletedAt: null },
    select: { id: true, organisationId: true, locationId: true }
  });
}

export async function getLocationIfOwned(
  locationId: string, 
  organisationId: string,
  client: PrismaTransaction = prisma
): Promise<{ id: string; organisationId: string } | null> {
  return client.location.findUnique({
    where: { id: locationId },
    select: { id: true, organisationId: true }
  }).then(loc => loc?.organisationId === organisationId ? loc : null);
}

export async function getInvoiceIfOwned(
  invoiceId: string, 
  organisationId: string,
  client: PrismaTransaction = prisma
): Promise<{ id: string; organisationId: string; locationId: string | null } | null> {
  return client.invoice.findFirst({
    where: { id: invoiceId, organisationId },
    select: { id: true, organisationId: true, locationId: true }
  });
}

export async function getSupplierIfOwned(
  supplierId: string,
  organisationId: string,
  client: PrismaTransaction = prisma
): Promise<{ id: string; organisationId: string } | null> {
  return client.supplier.findFirst({
    where: { id: supplierId, organisationId },
    select: { id: true, organisationId: true }
  });
}

// For location-scoped tokens: validate locationId matches token scope
export function validateLocationScope(
  requestedLocationId: string,
  auth: { organisationId?: string | null; locationId?: string | null; tokenType: string }
): boolean {
  if (auth.tokenType === 'location') {
    // Location-scoped token: must match exactly
    return auth.locationId === requestedLocationId;
  }
  // Org-scoped token: allow any location (ownership checked separately)
  return true;
}
