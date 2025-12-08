import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { supplierInsightsService } from '../services/supplierInsightsService';
import authContextPlugin from '../plugins/authContext';

export default async function supplierInsightsRoutes(fastify: FastifyInstance) {
  // Register Auth Plugin for all routes in this file
  fastify.register(authContextPlugin);

  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/summary', {
    schema: {
      tags: ['Supplier Insights'],
      summary: 'Get supplier spend summary and charts data',
      querystring: z.object({
          accountCodes: z.union([z.string(), z.array(z.string())]).optional(),
      }),
      // Removed headers validation
      response: {
        200: z.object({
            summaryCards: z.object({
                totalSupplierSpendPerMonth: z.number(),
                totalSpendTrendLast6mPercent: z.number(),
                totalSpendTrendSeries: z.array(z.object({
                    monthLabel: z.string(),
                    total: z.number()
                })),
                averagePriceMovementLast3mPercent: z.number(),
                averageMonthlyVariancePercent: z.number(),
                canCalculateVariance: z.boolean(),
                priceMovementSeries: z.array(z.object({
                    monthLabel: z.string(),
                    percentChange: z.number().nullable()
                })),
                canCalculatePriceMovement: z.boolean(),
                forecastedSpendNext30Days: z.number(),
                forecastedSpendFixedNext30Days: z.number(),
                forecastedSpendVariableNext30Days: z.number(),
                forecastConfidence: z.enum(['low', 'medium', 'high'])
            }),
            recentPriceChanges: z.array(z.object({
                productId: z.string(),
                productName: z.string(),
                supplierName: z.string(),
                latestUnitPrice: z.number(),
                percentChange: z.number(),
                effectiveDate: z.string()
            })),
            spendBreakdown: z.object({
                bySupplier: z.array(z.object({
                    supplierId: z.string(),
                    supplierName: z.string(),
                    totalSpend12m: z.number()
                })),
                byCategory: z.array(z.object({
                    categoryId: z.string(),
                    categoryName: z.string(),
                    totalSpend12m: z.number()
                }))
            }),
            costCreepAlerts: z.array(z.object({
                supplierId: z.string(),
                supplierName: z.string(),
                percentIncrease: z.number()
            }))
        })
      }
    }
  }, async (request, reply) => {
    const { organisationId, locationId, tokenType } = request.authContext;
    const { accountCodes } = request.query as any;

    // Normalize accountCodes
    let normalizedAccountCodes: string[] | undefined = undefined;
    if (accountCodes) {
        if (Array.isArray(accountCodes)) {
            normalizedAccountCodes = accountCodes;
        } else if (typeof accountCodes === 'string') {
            normalizedAccountCodes = accountCodes.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
    }

    if (!organisationId) {
      // Should not happen if auth passed and we enforce org token, but safer to check
      return reply.status(400).send({ error: { code: 'MISSING_ORG_ID', message: 'Organisation ID is required' } } as any);
    }

    // Guard: Must be location token for this route (as per plan)
    // "In location-only routes (e.g. /supplier-insights/...), explicitly assert: tokenType === 'location' && locationId"
    if (tokenType !== 'location' || !locationId) {
       return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Location context required' } } as any);
    }

    const [summary, recentPriceChanges, spendBreakdown, alerts] = await Promise.all([
        supplierInsightsService.getSupplierSpendSummary(organisationId, locationId, normalizedAccountCodes),
        supplierInsightsService.getRecentPriceChanges(organisationId, locationId, normalizedAccountCodes),
        supplierInsightsService.getSpendBreakdown(organisationId, locationId, normalizedAccountCodes),
        supplierInsightsService.getCostCreepAlerts(organisationId, locationId, normalizedAccountCodes)
    ]);

    return {
        summaryCards: summary,
        recentPriceChanges,
        spendBreakdown,
        costCreepAlerts: alerts
    };
  });

  app.get('/products', {
    schema: {
      tags: ['Supplier Insights'],
      summary: 'Get all products with pagination',
      // Removed headers validation
      querystring: z.object({
        page: z.coerce.number().default(1),
        pageSize: z.coerce.number().default(20),
        sortBy: z.enum(['productName', 'supplierName', 'unitCost', 'lastPriceChangePercent', 'spend12m']).optional(),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        search: z.string().optional(),
        accountCodes: z.union([z.string(), z.array(z.string())]).optional(),
      }),
      response: {
          200: z.object({
              items: z.array(z.object({
                  productId: z.string(),
                  productName: z.string(),
                  supplierName: z.string(),
                  latestUnitCost: z.number(),
                  lastPriceChangePercent: z.number(),
                  spend12m: z.number(),
                  itemCode: z.string().nullable().optional(),
                  description: z.string().nullable().optional()
              })),
              pagination: z.object({
                  page: z.number(),
                  pageSize: z.number(),
                  totalItems: z.number(),
                  totalPages: z.number()
              })
          })
      }
    }
  }, async (request, reply) => {
    const { organisationId, locationId, tokenType } = request.authContext;
    const { accountCodes } = request.query as any;

    // Normalize accountCodes
    let normalizedAccountCodes: string[] | undefined = undefined;
    if (accountCodes) {
        if (Array.isArray(accountCodes)) {
            normalizedAccountCodes = accountCodes;
        } else if (typeof accountCodes === 'string') {
            normalizedAccountCodes = accountCodes.split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
    }

    if (!organisationId) {
        return reply.status(400).send({ error: { code: 'MISSING_ORG_ID', message: 'Organisation ID is required' } } as any);
    }
    
    if (tokenType !== 'location' || !locationId) {
       return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Location context required' } } as any);
    }

    return supplierInsightsService.getProducts(organisationId, locationId, { ...request.query, accountCodes: normalizedAccountCodes });
  });

  app.get('/products/:productId', {
    schema: {
        tags: ['Supplier Insights'],
        summary: 'Get product details',
        // Removed headers validation
        params: z.object({
            productId: z.string() // Allow UUID or manual:supplierId:base64 format
        }),
        response: {
            200: z.object({
                productId: z.string(),
                productName: z.string(),
                supplierName: z.string(),
                categoryName: z.string(),
                stats12m: z.object({
                    totalSpend12m: z.number(),
                    averageMonthlySpend: z.number(),
                    quantityPurchased12m: z.number(),
                    spendTrend12mPercent: z.number()
                }),
                priceHistory: z.array(z.object({
                    monthLabel: z.string(),
                    averageUnitPrice: z.number().nullable()
                }))
            }),
            404: z.object({
                error: z.object({
                    code: z.string(),
                    message: z.string()
                })
            })
        }
    }
  }, async (request, reply) => {
    const { organisationId, locationId, tokenType } = request.authContext;
    const { productId } = request.params;
    
    // Decode the productId to handle cases where it's URI encoded (e.g. manual%3A...)
    const decodedProductId = decodeURIComponent(productId);

    if (!organisationId) {
        return reply.status(400).send({ error: { code: 'MISSING_ORG_ID', message: 'Organisation ID is required' } } as any);
    }

    if (tokenType !== 'location' || !locationId) {
       return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Location context required' } } as any);
    }

    try {
        const detail = await supplierInsightsService.getProductDetail(organisationId, decodedProductId, locationId);
        if (!detail) {
            return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
        }
        return detail;
    } catch (e) {
        console.error('[SupplierInsights] Error fetching product detail:', e);
        return reply.status(400).send({ error: { code: 'INVALID_ID', message: 'Invalid Product ID' } });
    }
  });
}
