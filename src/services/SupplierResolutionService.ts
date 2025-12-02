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
        return { supplier: alias.supplier, confidence: 1.0, matchType: 'ALIAS' };
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
        return { supplier, confidence: 1.0, matchType: 'EXACT' };
    }
    
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

