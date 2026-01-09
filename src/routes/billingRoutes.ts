import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import authContextPlugin from '../plugins/authContext';
import { billingController } from '../controllers/billingController';

// Request schemas
const checkoutSessionRequest = z.object({
  planKey: z.enum(['pro', 'enterprise']),
  interval: z.enum(['monthly', 'annual']),
  // Optional return paths (relative only) to support onboarding flows.
  // The backend remains the source of truth for FRONTEND_URL resolution.
  successPath: z.string().optional(),
  cancelPath: z.string().optional(),
});

const portalSessionRequest = z
  .object({
    flow: z.enum(['manage', 'switch_plan']).optional(),
  })
  .nullable()
  .optional();

/**
 * Billing Routes
 * 
 * All routes are protected and require authentication.
 * Organisation context is derived from JWT, never from request body.
 */
export default async function billingRoutes(fastify: FastifyInstance) {
  // All billing routes require authentication
  fastify.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const app = protectedApp.withTypeProvider<ZodTypeProvider>();

    /**
     * GET /billing/plans
     *
     * Canonical plan caps/labels for UI display.
     */
    app.get('/plans', {
      schema: {
        response: {
          200: z.object({
            plans: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                caps: z.object({
                  seatLimit: z.number().int(),
                  locationLimit: z.number().int().nullable(),
                  inviteExpiryHours: z.number().int(),
                }),
              })
            ),
          }),
        },
      },
    }, billingController.getPlans);

    /**
     * POST /billing/checkout-session
     * 
     * Create a Stripe Checkout session for upgrading to a paid plan.
     * Returns a URL to redirect the user to Stripe Checkout.
     */
    app.post('/checkout-session', {
      schema: {
        body: checkoutSessionRequest,
        response: {
          200: z.object({ url: z.string().url() }),
          400: z.object({ message: z.string() }),
          403: z.object({ message: z.string() }),
          404: z.object({ message: z.string() }),
          503: z.object({ message: z.string() }),
          500: z.object({ message: z.string() }),
        },
      },
    }, billingController.createCheckoutSession);

    /**
     * POST /billing/portal-session
     * 
     * Create a Stripe Customer Portal session for managing billing.
     * Returns a URL to redirect the user to Stripe Portal.
     */
    app.post('/portal-session', {
      schema: {
        body: portalSessionRequest,
        response: {
          200: z.object({ url: z.string().url() }),
          400: z.object({ message: z.string() }),
          403: z.object({ message: z.string() }),
          404: z.object({ message: z.string() }),
          503: z.object({ message: z.string() }),
          500: z.object({ message: z.string() }),
        },
      },
    }, billingController.createPortalSession);
  });
}

