import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import prisma from '../infrastructure/prismaClient';
import { config } from '../config/env';
import { addInboundJob } from '../services/InboundQueueService';

/**
 * Verifies Mailgun webhook signature using timing-safe comparison.
 */
export const verifyMailgunSignature = (
  signingKey: string,
  token: string,
  timestamp: string,
  signature: string
): boolean => {
  if (!signingKey || !token || !timestamp || !signature) return false;

  // 1. Create the HMAC using the signing key
  const encodedToken = crypto
    .createHmac('sha256', signingKey)
    .update(timestamp.concat(token))
    .digest('hex');

  // 2. Use timingSafeEqual to prevent side-channel timing attacks
  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(encodedToken);

  if (signatureBuffer.length !== digestBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
};

export const webhookController = {
  mailgunInbound: async (req: FastifyRequest, reply: FastifyReply) => {
    // 1. Determine Content-Type
    const contentType = req.headers['content-type'] || '';
    const payload: Record<string, any> = {};

    try {
      if (contentType.includes('multipart/form-data')) {
        // Fastify multipart gives us a stream of parts. We must consume them all.
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === 'field') {
            payload[part.fieldname] = part.value;
          } else {
            // Consume file stream to avoid hanging
            await part.toBuffer(); 
          }
        }
      } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('application/json')) {
        // Standard body parsing (handled by Fastify or fastify-formbody if registered)
        // If fastify-raw-body is used, we might need to parse manually or rely on Fastify's body
        // Assuming Fastify has parsed the body into req.body
        const body = req.body as Record<string, any>;
        if (body) {
          Object.assign(payload, body);
        }
      } else {
        // Fallback or Error
        return reply.status(415).send({ error: 'Unsupported Content-Type' });
      }
    } catch (err) {
      req.log.error(err, 'Error parsing webhook body');
      return reply.status(400).send({ error: 'Body parsing failed' });
    }

    // 2. Verify Signature
    const { timestamp, token, signature } = payload;
    
    // Safety check: Ensure fields exist
    if (!timestamp || !token || !signature) {
      return reply.status(400).send({ error: 'Missing signature fields' });
    }

    const isValid = verifyMailgunSignature(
      config.MAILGUN_WEBHOOK_SIGNING_KEY,
      token,
      timestamp,
      signature
    );

    if (!isValid) {
      req.log.warn({ 
        token, 
        timestamp, 
        signature,
        signingKeyLength: config.MAILGUN_WEBHOOK_SIGNING_KEY?.length,
        signingKeyPrefix: config.MAILGUN_WEBHOOK_SIGNING_KEY?.substring(0, 4),
        payloadKeys: Object.keys(payload)
      }, 'Invalid Mailgun webhook signature - Debug Info');
      return reply.status(403).send({ error: 'Invalid signature' });
    }

    // 3. Idempotency Check
    const existingEvent = await prisma.inboundEmailEvent.findUnique({
      where: {
        token_timestamp: {
          token,
          timestamp,
        },
      },
    });

    if (existingEvent) {
      req.log.info({ eventId: existingEvent.id }, 'Ignored duplicate Mailgun webhook');
      return reply.status(200).send({ success: true, duplicate: true });
    }

    // 4. Normalization
    const recipient = (payload.recipient || '').toString().toLowerCase().trim();
    // Normalize Recipient: Strip "Name <email>" format
    // Regex matches text inside < > or just the full string if no brackets
    const emailMatch = recipient.match(/<([^>]+)>/);
    const normalizedRecipient = emailMatch ? emailMatch[1] : recipient;
    
    // Recipient Alias Parsing: invoices+<ALIAS>@...
    // Matches content between + and @
    const aliasMatch = normalizedRecipient.match(/\+([^@]+)@/);
    const recipientAlias = aliasMatch ? aliasMatch[1] : null;

    // 5. Persist Event
    try {
      const event = await prisma.inboundEmailEvent.create({
        data: {
          recipient: normalizedRecipient,
          recipientAlias,
          sender: payload.sender as string,
          subject: payload.subject as string,
          messageId: payload['Message-Id'] as string || payload['message-id'] as string,
          timestamp,
          token,
          signature,
          raw: payload,
          status: 'PENDING_FETCH', // Initial status
        },
      });

      // 6. Enqueue Job
      await addInboundJob(event.id);

      req.log.info({ eventId: event.id, alias: recipientAlias }, 'Enqueued inbound email');
      return reply.status(200).send({ success: true, id: event.id });

    } catch (err) {
      req.log.error(err, 'Failed to store inbound email event');
      // Even if DB fails, return 500 so Mailgun retries
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  },
};
