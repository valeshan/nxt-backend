import { FastifyRequest, FastifyReply } from 'fastify';
import { constructWebhookEvent, isStripeEnabled, Stripe } from '../services/stripe/stripeService';
import prisma from '../infrastructure/prismaClient';
import {
  handleCheckoutSessionCompleted,
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
} from '../services/stripe/webhookHandlers';

/**
 * Stripe Webhook Controller
 * 
 * Handles incoming Stripe webhook events with:
 * - Signature verification
 * - Idempotency (via BillingWebhookEvent table)
 * - Event routing to handlers
 */
export const stripeWebhookController = {
  /**
   * POST /webhooks/stripe
   * 
   * Main webhook endpoint for Stripe events.
   * Requires raw body for signature verification.
   */
  async handleWebhook(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    // Kill switch check
    if (!isStripeEnabled()) {
      return reply.code(503).send({ message: 'Billing webhooks disabled' });
    }

    // Get raw body for signature verification
    const rawBody = (request as any).rawBody;
    if (!rawBody) {
      request.log.error('[Stripe Webhook] No raw body available for signature verification');
      return reply.code(400).send({ message: 'No raw body' });
    }

    // Get signature header
    const signature = request.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      request.log.error('[Stripe Webhook] Missing stripe-signature header');
      return reply.code(400).send({ message: 'Missing signature' });
    }

    // Verify signature and construct event
    let event: Stripe.Event;
    try {
      event = constructWebhookEvent(rawBody, signature);
    } catch (err: any) {
      request.log.error({ err }, '[Stripe Webhook] Signature verification failed');
      return reply.code(400).send({ message: `Webhook signature verification failed: ${err.message}` });
    }

    const eventId = event.id;
    const eventType = event.type;

    request.log.info({ eventId, eventType }, '[Stripe Webhook] Received event');

    // Idempotency check: see if event was already processed
    const existingEvent = await prisma.billingWebhookEvent.findUnique({
      where: { id: eventId },
    });

    // If we "processed" an event but couldn't link it to an organisationId at the time,
    // allow reprocessing so webhook fixes (or delayed ordering) can be applied.
    // This is safe because handlers are written to be idempotent updates.
    if (existingEvent?.processedAt && existingEvent.organisationId) {
      request.log.info({ eventId }, '[Stripe Webhook] Event already processed, skipping');
      return reply.code(200).send({ received: true, skipped: true });
    }

    // Claim the event by inserting/upserting with processedAt = null
    try {
      await prisma.billingWebhookEvent.upsert({
        where: { id: eventId },
        create: {
          id: eventId,
          eventType: eventType,
          organisationId: extractOrgIdFromEvent(event),
          processedAt: null,
          payload: event as any,
        },
        update: {}, // No-op if exists but not processed
      });
    } catch (err: any) {
      // If upsert fails due to race condition, another instance is handling it
      request.log.warn({ eventId, err: err.message }, '[Stripe Webhook] Event claim race condition');
      return reply.code(200).send({ received: true, skipped: true });
    }

    // Process the event
    try {
      await processEvent(event, request);

      // Mark as processed
      await prisma.billingWebhookEvent.update({
        where: { id: eventId },
        data: { processedAt: new Date() },
      });

      request.log.info({ eventId, eventType }, '[Stripe Webhook] Event processed successfully');
      return reply.code(200).send({ received: true });
    } catch (err: any) {
      request.log.error({ eventId, eventType, err }, '[Stripe Webhook] Error processing event');
      
      // Don't mark as processed so it can be retried
      // Return 500 so Stripe will retry
      return reply.code(500).send({ message: 'Error processing webhook' });
    }
  },
};

/**
 * Extract organisation ID from event data
 */
function extractOrgIdFromEvent(event: Stripe.Event): string | null {
  const data = event.data.object as any;
  
  // Try metadata first (most objects: checkout session, subscription, etc.)
  if (data?.metadata?.organisationId) return String(data.metadata.organisationId);

  // Invoices often carry metadata on nested objects (Stripe API varies over time):
  // - invoice.parent.subscription_details.metadata.organisationId
  // - invoice.lines.data[0].metadata.organisationId
  const parentMetaOrgId = data?.parent?.subscription_details?.metadata?.organisationId;
  if (parentMetaOrgId) return String(parentMetaOrgId);

  const firstLineMetaOrgId = data?.lines?.data?.[0]?.metadata?.organisationId;
  if (firstLineMetaOrgId) return String(firstLineMetaOrgId);
  
  // For invoice events, we'd need to look up by subscription ID
  // (handled in the individual handlers)
  
  return null;
}

/**
 * Route event to appropriate handler
 */
async function processEvent(
  event: Stripe.Event,
  request: FastifyRequest
): Promise<void> {
  const data = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(data as Stripe.Checkout.Session);
      break;

    case 'customer.subscription.created':
      await handleSubscriptionCreated(data as Stripe.Subscription);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(data as Stripe.Subscription);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(data as Stripe.Subscription);
      break;

    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(data as Stripe.Invoice);
      break;

    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(data as Stripe.Invoice);
      break;

    default:
      request.log.info({ eventType: event.type }, '[Stripe Webhook] Unhandled event type');
  }
}

