import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { supplierInsightsService } from '../services/supplierInsightsService';

export default async function supplierInsightsRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Middleware/hook to ensure x-org-id is present?
  // Assuming global auth middleware or per-route check. 
  // For now, we extract from headers.

  server.get('/summary', {
    schema: {
      tags: ['Supplier Insights'],
      summary: 'Get supplier spend summary and charts data',
      headers: z.object({
        'x-org-id': z.string().uuid(),
        'x-location-id': z.string().uuid().optional()
      }).passthrough(), // allow other headers
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
    const organisationId = request.headers['x-org-id'] as string;
    const locationId = request.headers['x-location-id'] as string | undefined;

    if (!organisationId) {
      return reply.status(400).send({ error: { code: 'MISSING_ORG_ID', message: 'Organisation ID is required' } } as any);
    }

    const [summary, recentPriceChanges, spendBreakdown, alerts] = await Promise.all([
        supplierInsightsService.getSupplierSpendSummary(organisationId, locationId),
        supplierInsightsService.getRecentPriceChanges(organisationId, locationId),
        supplierInsightsService.getSpendBreakdown(organisationId, locationId),
        supplierInsightsService.getCostCreepAlerts(organisationId, locationId)
    ]);

    return {
        summaryCards: summary,
        recentPriceChanges,
        spendBreakdown,
        costCreepAlerts: alerts
    };
  });

  server.get('/products', {
    schema: {
      tags: ['Supplier Insights'],
      summary: 'Get all products with pagination',
      headers: z.object({
        'x-org-id': z.string().uuid(),
        'x-location-id': z.string().uuid().optional()
      }).passthrough(),
      querystring: z.object({
        page: z.coerce.number().default(1),
        pageSize: z.coerce.number().default(20),
        sortBy: z.enum(['productName', 'supplierName', 'unitCost', 'lastPriceChangePercent', 'spend12m']).optional(),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        search: z.string().optional()
      }),
      response: {
          200: z.object({
              items: z.array(z.object({
                  productId: z.string(),
                  productName: z.string(),
                  supplierName: z.string(),
                  latestUnitCost: z.number(),
                  lastPriceChangePercent: z.number(),
                  spend12m: z.number()
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
    const organisationId = request.headers['x-org-id'] as string;
    const locationId = request.headers['x-location-id'] as string | undefined;

    if (!organisationId) {
        return reply.status(400).send({ error: { code: 'MISSING_ORG_ID', message: 'Organisation ID is required' } } as any);
    }

    return supplierInsightsService.getProducts(organisationId, locationId, request.query);
  });

  server.get('/products/:productId', {
    schema: {
        tags: ['Supplier Insights'],
        summary: 'Get product details',
        headers: z.object({
            'x-org-id': z.string().uuid(),
            'x-location-id': z.string().uuid().optional()
        }).passthrough(),
        params: z.object({
            productId: z.string().uuid()
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
    const organisationId = request.headers['x-org-id'] as string;
    const { productId } = request.params;

    if (!organisationId) {
        return reply.status(400).send({ error: { code: 'MISSING_ORG_ID', message: 'Organisation ID is required' } } as any);
    }

    try {
        const detail = await supplierInsightsService.getProductDetail(organisationId, productId);
        if (!detail) {
            return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
        }
        return detail;
    } catch (e) {
        return reply.status(400).send({ error: { code: 'INVALID_ID', message: 'Invalid Product ID' } });
    }
  });
}

