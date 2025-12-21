import prisma from '../infrastructure/prismaClient';

export const supplierResolutionService = {
  async resolveSupplier(rawName: string, organisationId: string) {
    if (!rawName) return null;
    const normalized = rawName.toLowerCase().trim();
    const rawNameSafe = rawName.slice(0, 50); // truncate to reduce log noise/PII exposure

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
        // Structured logging for instrumentation (log interesting cases only)
        console.log(JSON.stringify({
            event: 'supplier_resolve',
            orgId: organisationId,
            rawName: rawNameSafe,
            matchType: 'ALIAS',
            supplierId: alias.supplier.id,
            confidence: 1.0
        }));
        return { supplier: alias.supplier, confidence: 1.0, matchType: 'ALIAS' as const };
    }

    // 2. Try exact match on Supplier name
    // We use normalizedName which should be lowercase and trimmed
    const supplier = await prisma.supplier.findFirst({
        where: {
            organisationId,
            normalizedName: normalized
        }
    });

    if (supplier) {
        // Do not log EXACT matches to reduce noise/cost.
        return { supplier, confidence: 1.0, matchType: 'EXACT' as const };
    }
    
    // 3. No match
    // Structured logging for instrumentation
    console.log(JSON.stringify({
        event: 'supplier_resolve',
        orgId: organisationId,
        rawName: rawNameSafe,
        matchType: 'NO_MATCH',
        confidence: 0.0
    }));
    
    // Future: Fuzzy matching using Fuse.js or database trigrams
    
    return null;
  },

  async createAlias(organisationId: string, supplierId: string, aliasName: string) {
    const normalized = aliasName.toLowerCase().trim();
    
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









