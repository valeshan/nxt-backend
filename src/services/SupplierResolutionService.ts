import prisma from '../infrastructure/prismaClient';
import { normalizeSupplierName } from '../utils/normalizeSupplierName';
import { SupplierSourceSystem, SupplierSourceType, SupplierStatus } from '@prisma/client';
import * as levenshtein from 'fast-levenshtein';

/**
 * Similarity threshold for fuzzy matching.
 * 0.9 = 90% similar (allows for minor typos/variations)
 */
const SIMILARITY_THRESHOLD = 0.9;

/**
 * Computes similarity score between 0 and 1.
 * 1 = exact match, 0 = no match.
 */
function computeNameSimilarity(nameA: string, nameB: string): number {
  const normalizedA = normalizeSupplierName(nameA);
  const normalizedB = normalizeSupplierName(nameB);

  if (normalizedA === normalizedB) return 1.0;
  if (!normalizedA || !normalizedB) return 0.0;

  const distance = levenshtein.get(normalizedA, normalizedB);
  const maxLength = Math.max(normalizedA.length, normalizedB.length);
  
  if (maxLength === 0) return 1.0; // Both empty after normalization

  return 1.0 - (distance / maxLength);
}

export const supplierResolutionService = {
  /**
   * Resolve a supplier from a raw OCR-extracted name.
   * 
   * Resolution strategy:
   * 1. Exact match on SupplierAlias (normalized)
   * 2. Exact match on Supplier.normalizedName
   * 3. Fuzzy match on Supplier names (90% similarity threshold)
   * 4. Auto-create new supplier if no match found
   * 
   * @returns Supplier with match metadata, never null (always creates if no match)
   */
  async resolveSupplier(rawName: string, organisationId: string) {
    if (!rawName) return null;
    
    const normalized = normalizeSupplierName(rawName);
    const rawNameSafe = rawName.slice(0, 50);

    // 1. Try exact match on SupplierAlias
    const alias = await prisma.supplierAlias.findUnique({
        where: {
            organisationId_normalisedAliasName: {
                organisationId,
                normalisedAliasName: normalized
            }
        },
        include: { supplier: true }
    });

    if (alias) {
        console.log(JSON.stringify({
            event: 'supplier_resolve',
            orgId: organisationId,
            rawName: rawNameSafe,
            matchType: 'ALIAS',
            supplierId: alias.supplier.id,
            confidence: 1.0
        }));
        return { 
            supplier: alias.supplier, 
            confidence: 1.0, 
            matchType: 'ALIAS' as const,
            matchedAliasKey: alias.normalisedAliasName // Use the actual alias record's normalized name
        };
    }

    // 2. Try exact match on Supplier normalizedName
    const exactSupplier = await prisma.supplier.findFirst({
        where: {
            organisationId,
            normalizedName: normalized
        }
    });

    if (exactSupplier) {
        return { 
            supplier: exactSupplier, 
            confidence: 1.0, 
            matchType: 'EXACT' as const 
        };
    }

    // 3. Fuzzy matching - find best match above threshold
    const candidates = await prisma.supplier.findMany({
        where: { organisationId },
        select: { id: true, normalizedName: true, name: true },
    });

    let bestMatch: { id: string; score: number; name: string } | null = null;

    for (const candidate of candidates) {
        const score = computeNameSimilarity(normalized, candidate.normalizedName);
        if (score >= SIMILARITY_THRESHOLD) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { id: candidate.id, score, name: candidate.name };
            }
        }
    }

    if (bestMatch) {
        const fuzzySupplier = await prisma.supplier.findUniqueOrThrow({
            where: { id: bestMatch.id },
        });

        // Create a source link to track this fuzzy match
        try {
            await prisma.supplierSourceLink.create({
                data: {
                    supplierId: fuzzySupplier.id,
                    organisationId,
                    sourceSystem: SupplierSourceSystem.OCR,
                    rawName: rawName,
                    confidence: bestMatch.score,
                },
            });
        } catch (e: any) {
            // Ignore duplicate link errors (P2002)
            if (e.code !== 'P2002') throw e;
        }

        console.log(JSON.stringify({
            event: 'supplier_resolve',
            orgId: organisationId,
            rawName: rawNameSafe,
            matchType: 'FUZZY',
            supplierId: fuzzySupplier.id,
            matchedName: bestMatch.name,
            confidence: bestMatch.score
        }));

        return { supplier: fuzzySupplier, confidence: bestMatch.score, matchType: 'FUZZY' as const };
    }
    
    // 4. No match found - create new supplier with PENDING_REVIEW status
    console.log(JSON.stringify({
        event: 'supplier_resolve',
        orgId: organisationId,
        rawName: rawNameSafe,
        matchType: 'CREATED',
        confidence: 1.0
    }));

    const newSupplier = await prisma.$transaction(async (tx) => {
      const created = await tx.supplier.create({
        data: {
          organisationId,
          name: rawName,
          normalizedName: normalized,
          sourceType: SupplierSourceType.OCR,
          status: SupplierStatus.PENDING_REVIEW,
        },
      });

      await tx.supplierSourceLink.create({
        data: {
          supplierId: created.id,
          organisationId,
          sourceSystem: SupplierSourceSystem.OCR,
          rawName: rawName,
          confidence: 1.0,
        },
      });

      return created;
    });

    return { supplier: newSupplier, confidence: 1.0, matchType: 'CREATED' as const };
  },

  async createAlias(organisationId: string, supplierId: string, aliasName: string) {
    const normalized = normalizeSupplierName(aliasName);
    
    return await prisma.supplierAlias.upsert({
        where: {
            organisationId_normalisedAliasName: {
                organisationId,
                normalisedAliasName: normalized
            }
        },
        update: {
            supplierId
        },
        create: {
            organisationId,
            supplierId,
            aliasName,
            normalisedAliasName: normalized
        }
    });
  }
};
