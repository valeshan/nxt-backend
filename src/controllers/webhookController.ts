import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import prisma from '../infrastructure/prismaClient';
import { config } from '../config/env';
import { addInboundJob } from '../services/InboundQueueService';
import { s3Service } from '../services/S3Service';
import { randomUUID } from 'node:crypto';

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
    req.log.info('[Webhook] Received Mailgun inbound webhook request');
    // 1. Determine Content-Type
    const contentType = req.headers['content-type'] || '';
    const payload: Record<string, any> = {};

    const uploadedFiles: Array<{
      filename: string;
      mimetype: string;
      encoding: string;
      content: Buffer;
    }> = [];

    const getProviderMessageId = (): string => {
      const raw =
        (payload['Message-Id'] as string | undefined) ||
        (payload['message-id'] as string | undefined) ||
        (payload['messageId'] as string | undefined) ||
        (payload['message_id'] as string | undefined);

      if (raw && typeof raw === 'string' && raw.trim().length > 0) return raw.trim();

      // Fallback (deterministic) to preserve idempotency when Mailgun omits Message-Id.
      // NOTE: This is a last resort; primary idempotency should be provider message id.
      const token = (payload.token ?? '').toString();
      const ts = (payload.timestamp ?? '').toString();
      const rcpt = (payload.recipient ?? '').toString().toLowerCase().trim();
      const subj = (payload.subject ?? '').toString();
      const sender = (payload.sender ?? '').toString();
      const basis = `${ts}|${token}|${rcpt}|${sender}|${subj}`;
      const digest = crypto.createHash('sha256').update(basis).digest('hex');
      return `fallback-${digest}`;
    };

    const ok = (body: any = { success: true }) => reply.status(200).send(body);

    try {
      if (contentType.includes('multipart/form-data')) {
        // Fastify multipart gives us a stream of parts. We must consume them all.
        const parts = req.parts();
        for await (const part of parts) {
          if (part.type === 'field') {
            payload[part.fieldname] = part.value;
          } else {
            // Consume file stream to buffer
            const buffer = await part.toBuffer();
            uploadedFiles.push({
              filename: part.filename,
              mimetype: part.mimetype,
              encoding: part.encoding,
              content: buffer,
            });
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
        req.log.warn({ contentType }, 'Unsupported Content-Type for Mailgun inbound webhook');
        return ok({ success: false, ignored: true, reason: 'UNSUPPORTED_CONTENT_TYPE' });
      }
    } catch (err) {
      req.log.error(err, 'Error parsing Mailgun inbound webhook body');
      return ok({ success: false, ignored: true, reason: 'BODY_PARSING_FAILED' });
    }

    // 2. Extract signature fields
    const { timestamp, token, signature } = payload;

    if (!timestamp || !token || !signature) {
      req.log.error({ hasTimestamp: !!timestamp, hasToken: !!token, hasSignature: !!signature }, 'Missing Mailgun signature fields');
      return ok({ success: false, ignored: true, reason: 'MISSING_SIGNATURE_FIELDS' });
    }

    // 3. Normalize recipient + alias
    const recipient = (payload.recipient || '').toString().toLowerCase().trim();
    req.log.info({ recipient }, '[Webhook] Processing email recipient');

    // Normalize Recipient: Strip "Name <email>" format
    const emailMatch = recipient.match(/<([^>]+)>/);
    const normalizedRecipient = emailMatch ? emailMatch[1] : recipient;

    // Recipient Alias Parsing: invoices+<ALIAS>@...
    const aliasMatch = normalizedRecipient.match(/\+([^@]+)@/);
    const recipientAlias = aliasMatch ? aliasMatch[1] : null;

    // 4. Provider message id (primary idempotency key)
    const providerMessageId = getProviderMessageId();

    // 5. Signature verification (never non-200)
    const isValid = verifyMailgunSignature(
      config.MAILGUN_WEBHOOK_SIGNING_KEY,
      token,
      timestamp,
      signature
    );

    // 6. Idempotency check via provider message id
    try {
      const existingByMessageId = await prisma.inboundEmailEvent.findFirst({
        where: { messageId: providerMessageId },
        select: { id: true },
      });

      if (existingByMessageId) {
        req.log.info(
          { eventId: existingByMessageId.id, messageId: providerMessageId },
          'Ignored duplicate Mailgun webhook (messageId)'
        );
        return ok({ success: true, duplicate: true, id: existingByMessageId.id });
      }
    } catch (err) {
      // If lookup fails, continue and rely on DB unique constraint during create (once added).
      req.log.warn(
        { err, messageId: providerMessageId },
        'Idempotency lookup failed; will rely on DB uniqueness'
      );
    }

    // 7. Persist event (even if invalid signature)
    try {
      const event = await prisma.inboundEmailEvent.create({
        data: {
          recipient: normalizedRecipient,
          recipientAlias,
          sender: payload.sender as string,
          subject: payload.subject as string,
          messageId: providerMessageId,
          timestamp: timestamp.toString(),
          token: token.toString(),
          signature: signature.toString(),
          raw: payload,
          status: isValid ? 'PENDING_FETCH' : 'FAILED_SIGNATURE',
          failureReason: isValid ? null : 'Invalid Mailgun webhook signature',
        },
      });

      if (!isValid) {
        const debugInfo = {
          messageId: providerMessageId,
          token,
          timestamp,
          signature,
          signingKeyLength: config.MAILGUN_WEBHOOK_SIGNING_KEY?.length,
          signingKeyPrefix: config.MAILGUN_WEBHOOK_SIGNING_KEY?.substring(0, 4),
          payloadKeys: Object.keys(payload),
        };
        req.log.error(debugInfo, 'Invalid Mailgun webhook signature');
        // Do NOT enqueue processing for invalid signature
        return ok({ success: true, id: event.id, accepted: true, signatureValid: false });
      }

      // 8. Upload files to S3 if present (Forward-route staging)
      if (uploadedFiles.length > 0) {
        const stagingAttachments: any[] = [];

        for (const file of uploadedFiles) {
          const s3Key = `inbound-email/staging/${event.id}/${randomUUID()}-${file.filename}`;
          await s3Service.putObject(s3Key, file.content, { ContentType: file.mimetype });
          stagingAttachments.push({
            originalName: file.filename,
            mimeType: file.mimetype,
            size: file.content.length,
            key: s3Key,
          });
        }

        await prisma.inboundEmailEvent.update({
          where: { id: event.id },
          data: {
            raw: {
              ...(payload as any),
              stagingAttachments,
            },
          },
        });
      }

      // 9. Enqueue job for async processing
      await addInboundJob(event.id);
      req.log.info({ eventId: event.id, alias: recipientAlias, messageId: providerMessageId }, 'Enqueued inbound email');

      return ok({ success: true, id: event.id, accepted: true, signatureValid: true });

    } catch (err: any) {
      // If duplicate due to unique(messageId), treat as idempotent success
      if (err?.code === 'P2002') {
        req.log.info({ messageId: providerMessageId }, 'Ignored duplicate Mailgun webhook (DB unique)');
        const existing = await prisma.inboundEmailEvent
          .findFirst({ where: { messageId: providerMessageId }, select: { id: true } })
          .catch(() => null);
        return ok({ success: true, duplicate: true, id: existing?.id });
      }

      req.log.error(err, 'Failed to store inbound email event');
      // Always return 200 so Mailgun does not keep retrying.
      return ok({ success: false, accepted: true, reason: 'DB_ERROR' });
    }
  },
};
