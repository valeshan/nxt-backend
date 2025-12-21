import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { supplierInsightsService } from '../services/supplierInsightsService';
import authContextPlugin from '../plugins/authContext';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import prisma from '../infrastructure/prismaClient';

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
              }),
              // Nightly cache freshness signal (ISO timestamp)
              statsAsOf: z.string().nullable().optional(),
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

  app.post('/trigger-price-alerts', {
    schema: {
      tags: ['Supplier Insights'],
      summary: 'Manually trigger price alert scan and email sending',
      querystring: z.object({
        locationId: z.string().optional(),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          message: z.string(),
          organisationId: z.string(),
          locationId: z.string().optional(),
        }),
        400: z.object({
          error: z.string(),
        }),
        403: z.object({
          error: z.string(),
        }),
        500: z.object({
          error: z.string(),
          message: z.string().optional(),
        }),
      }
    }
  }, async (request, reply) => {
    const { userId, organisationId, locationId: ctxLocationId, tokenType } = request.authContext;
    const { locationId: queryLocationId } = request.query;

    if (!organisationId) {
      return reply.status(400).send({ error: 'organisationId is required (missing from auth context)' });
    }

    // Any org member can trigger (no owner/admin roles enforced)
    const membership = await userOrganisationRepository.findMembership(userId, organisationId);
    if (!membership) {
      return reply.status(403).send({ error: 'Not a member of this organisation' });
    }

    // Determine target location safely:
    // - If user is on a location token, ONLY allow triggering for that location.
    // - Otherwise, allow specifying a locationId query param.
    const targetLocationId =
      tokenType === 'location'
        ? ctxLocationId
        : queryLocationId;

    if (!targetLocationId) {
      return reply.status(400).send({ error: 'locationId is required' });
    }

    // Validate location belongs to org
    const loc = await prisma.location.findUnique({
      where: { id: targetLocationId },
      select: { id: true, organisationId: true }
    });
    if (!loc || loc.organisationId !== organisationId) {
      return reply.status(400).send({ error: 'Invalid locationId for organisation' });
    }
    
    try {
      console.log(`[TriggerPriceAlerts] Manually triggering price alerts`, { organisationId, locationId: targetLocationId });
      await supplierInsightsService.scanAndSendPriceIncreaseAlertsForOrg(organisationId, targetLocationId);
      
      return reply.send({
        success: true,
        message: `Price alerts triggered for location ${targetLocationId}. Check logs for details.`,
        organisationId,
        locationId: targetLocationId,
      });
    } catch (error: any) {
      console.error('[TriggerPriceAlerts] Error:', error);
      return reply.status(500).send({
        error: 'Failed to trigger price alerts',
        message: error.message,
      });
    }
  });
}
