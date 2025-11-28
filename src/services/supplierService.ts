import prisma from '../infrastructure/prismaClient';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';
import { Supplier, SupplierSourceSystem, SupplierSourceType, SupplierStatus } from '@prisma/client';
import * as levenshtein from 'fast-levenshtein';

export class SupplierService {
  private readonly SIMILARITY_THRESHOLD = 0.9;

  /**
   * Computes similarity score between 0 and 1.
   * 1 = exact match, 0 = no match.
   */
  computeNameSimilarity(nameA: string, nameB: string): number {
    const normalizedA = normalizeSupplierName(nameA);
    const normalizedB = normalizeSupplierName(nameB);

    if (normalizedA === normalizedB) return 1.0;
    if (!normalizedA || !normalizedB) return 0.0;

    const distance = levenshtein.get(normalizedA, normalizedB);
    const maxLength = Math.max(normalizedA.length, normalizedB.length);
    
    if (maxLength === 0) return 1.0; // Both empty after normalization

    return 1.0 - (distance / maxLength);
  }

  async resolveSupplierFromXero(
    organisationId: string,
    contactId: string,
    contactName: string
  ): Promise<Supplier> {
    // 1. Try to find by External ID (Xero Contact ID)
    const existingLink = await prisma.supplierSourceLink.findFirst({
      where: {
        organisationId,
        sourceSystem: SupplierSourceSystem.XERO,
        externalId: contactId,
      },
      include: { supplier: true },
    });

    if (existingLink) {
      // Update name if changed? For now, just return the supplier.
      return existingLink.supplier;
    }

    const normalizedName = normalizeSupplierName(contactName);

    // 2. Try to find by Normalized Name
    const existingSupplier = await prisma.supplier.findFirst({
      where: {
        organisationId,
        normalizedName: normalizedName,
      },
    });

    if (existingSupplier) {
      // Found a match by name, create the link
      await prisma.supplierSourceLink.create({
        data: {
          supplierId: existingSupplier.id,
          organisationId,
          sourceSystem: SupplierSourceSystem.XERO,
          externalId: contactId,
          rawName: contactName,
          confidence: 1.0,
        },
      });
      return existingSupplier;
    }

    // 3. Create new Supplier
    return await prisma.$transaction(async (tx) => {
      const newSupplier = await tx.supplier.create({
        data: {
          organisationId,
          name: contactName,
          normalizedName,
          sourceType: SupplierSourceType.XERO,
          status: SupplierStatus.ACTIVE,
        },
      });

      await tx.supplierSourceLink.create({
        data: {
          supplierId: newSupplier.id,
          organisationId,
          sourceSystem: SupplierSourceSystem.XERO,
          externalId: contactId,
          rawName: contactName,
          confidence: 1.0,
        },
      });

      return newSupplier;
    });
  }

  async resolveSupplierFromOCR(
    organisationId: string,
    rawName: string,
    optionalMetadata?: { abn?: string; email?: string }
  ): Promise<Supplier> {
    const normalizedName = normalizeSupplierName(rawName);

    // 1. Direct match by ABN if available (Future improvement)
    if (optionalMetadata?.abn) {
      const matchByAbn = await prisma.supplier.findFirst({
        where: { organisationId, abn: optionalMetadata.abn },
      });
      if (matchByAbn) return matchByAbn;
    }

    // 2. Fuzzy matching
    // Get all suppliers for org to check similarity
    // Optimization: filter by first letter or length range if list is huge
    const candidates = await prisma.supplier.findMany({
      where: { organisationId },
      select: { id: true, normalizedName: true, name: true },
    });

    let bestMatch: { id: string; score: number } | null = null;

    for (const candidate of candidates) {
      const score = this.computeNameSimilarity(normalizedName, candidate.normalizedName);
      if (score >= this.SIMILARITY_THRESHOLD) {
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { id: candidate.id, score };
        }
      }
    }

    if (bestMatch) {
      // Link to best match
      const existingSupplier = await prisma.supplier.findUniqueOrThrow({
        where: { id: bestMatch.id },
      });

      // Create OCR link if not exists (or just log it)
      // We allow multiple OCR links for same supplier if raw names differ
      await prisma.supplierSourceLink.create({
        data: {
          supplierId: existingSupplier.id,
          organisationId,
          sourceSystem: SupplierSourceSystem.OCR,
          rawName: rawName,
          confidence: bestMatch.score,
        },
      });

      return existingSupplier;
    }

    // 3. No match found, create new Pending Review supplier
    return await prisma.$transaction(async (tx) => {
      const newSupplier = await tx.supplier.create({
        data: {
          organisationId,
          name: rawName,
          normalizedName,
          sourceType: SupplierSourceType.OCR,
          status: SupplierStatus.PENDING_REVIEW,
        },
      });

      await tx.supplierSourceLink.create({
        data: {
          supplierId: newSupplier.id,
          organisationId,
          sourceSystem: SupplierSourceSystem.OCR,
          rawName: rawName,
          confidence: 1.0, // New creation
        },
      });

      return newSupplier;
    });
  }
}


