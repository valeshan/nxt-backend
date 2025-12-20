import prisma from '../infrastructure/prismaClient';

export const supplierResolutionService = {
  async resolveSupplier(rawName: string, organisationId: string) {
    if (!rawName) return null;
    const normalized = rawName.toLowerCase().trim();

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
        // Structured logging for instrumentation
        console.log(JSON.stringify({
            event: 'supplier_resolve',
            orgId: organisationId,
            rawName,
            matchType: 'ALIAS',
            supplierId: alias.supplier.id,
            supplierName: alias.supplier.name,
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
        // Structured logging for instrumentation
        console.log(JSON.stringify({
            event: 'supplier_resolve',
            orgId: organisationId,
            rawName,
            matchType: 'EXACT',
            supplierId: supplier.id,
            supplierName: supplier.name,
            confidence: 1.0
        }));
        return { supplier, confidence: 1.0, matchType: 'EXACT' as const };
    }
    
    // 3. No match
    // Structured logging for instrumentation
    console.log(JSON.stringify({
        event: 'supplier_resolve',
        orgId: organisationId,
        rawName,
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









