import { describe, it, expect, beforeEach } from 'vitest';
import prisma from '../../src/infrastructure/prismaClient';
import { resetDb } from './testApp';

describe('Canonical Invoice backfill/idempotency (DB-level)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('enforces idempotency via unique (canonicalInvoiceId, sourceLineRef)', async () => {
    const org = await prisma.organisation.create({ data: { name: 'Org' } as any });
    const loc = await prisma.location.create({ data: { organisationId: org.id, name: 'Loc' } as any });
    const supplier = await prisma.supplier.create({
      data: { organisationId: org.id, name: 'Supp', normalizedName: 'supp', status: 'ACTIVE', sourceType: 'MANUAL' } as any,
    });

    const invoice = await prisma.invoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        invoiceNumber: 'INV-1',
        sourceType: 'UPLOAD',
        isVerified: true,
      } as any,
    });

    const canonical = await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        source: 'MANUAL',
        legacyInvoiceId: invoice.id,
        sourceInvoiceRef: `invoiceId:${invoice.id}`,
        currencyCode: 'AUD',
      },
      select: { id: true },
    });

    // Insert the same line twice; skipDuplicates should keep only one row.
    await (prisma as any).canonicalInvoiceLineItem.createMany({
      data: [
        {
          canonicalInvoiceId: canonical.id,
          organisationId: org.id,
          locationId: loc.id,
          supplierId: supplier.id,
          source: 'MANUAL',
          sourceLineRef: `invoiceId:${invoice.id}:manual:line-1`,
          normalizationVersion: 'v1',
          rawDescription: 'Test 1kg',
          normalizedDescription: 'test 1kg',
          quantity: 1,
          unitLabel: 'KG',
          unitCategory: 'WEIGHT',
          lineTotal: 10,
          currencyCode: 'AUD',
          adjustmentStatus: 'NONE',
          qualityStatus: 'OK',
        },
        {
          canonicalInvoiceId: canonical.id,
          organisationId: org.id,
          locationId: loc.id,
          supplierId: supplier.id,
          source: 'MANUAL',
          sourceLineRef: `invoiceId:${invoice.id}:manual:line-1`,
          normalizationVersion: 'v1',
          rawDescription: 'Test 1kg',
          normalizedDescription: 'test 1kg',
          quantity: 1,
          unitLabel: 'KG',
          unitCategory: 'WEIGHT',
          lineTotal: 10,
          currencyCode: 'AUD',
          adjustmentStatus: 'NONE',
          qualityStatus: 'OK',
        },
      ],
      skipDuplicates: true,
    });

    const rows = await (prisma as any).canonicalInvoiceLineItem.findMany({
      where: { canonicalInvoiceId: canonical.id },
    });
    expect(rows.length).toBe(1);
  });

  it('stores per-line taxAmount (nullable) without recomputing totals', async () => {
    const org = await prisma.organisation.create({ data: { name: 'Org2' } as any });
    const loc = await prisma.location.create({ data: { organisationId: org.id, name: 'Loc2' } as any });
    const supplier = await prisma.supplier.create({
      data: { organisationId: org.id, name: 'Supp2', normalizedName: 'supp2', status: 'ACTIVE', sourceType: 'MANUAL' } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        invoiceNumber: 'INV-2',
        sourceType: 'UPLOAD',
        isVerified: true,
      } as any,
    });

    const canonical = await (prisma as any).canonicalInvoice.create({
      data: {
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        source: 'MANUAL',
        legacyInvoiceId: invoice.id,
        sourceInvoiceRef: `invoiceId:${invoice.id}`,
        currencyCode: 'AUD',
      },
      select: { id: true },
    });

    const created = await (prisma as any).canonicalInvoiceLineItem.create({
      data: {
        canonicalInvoiceId: canonical.id,
        organisationId: org.id,
        locationId: loc.id,
        supplierId: supplier.id,
        source: 'MANUAL',
        sourceLineRef: `invoiceId:${invoice.id}:manual:tax-1`,
        normalizationVersion: 'v1',
        rawDescription: 'Taxable Item 1kg',
        normalizedDescription: 'taxable item 1kg',
        quantity: 1,
        unitLabel: 'KG',
        unitCategory: 'WEIGHT',
        unitPrice: 11,
        lineTotal: 11,
        taxAmount: 1,
        currencyCode: 'AUD',
        adjustmentStatus: 'NONE',
        qualityStatus: 'OK',
      },
      select: { taxAmount: true, lineTotal: true },
    });

    expect(Number(created.taxAmount)).toBe(1);
    expect(Number(created.lineTotal)).toBe(11);
  });
});


