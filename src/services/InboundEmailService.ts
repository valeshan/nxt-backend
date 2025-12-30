import prisma from '../infrastructure/prismaClient';
import { config } from '../config/env';
import { s3Service } from './S3Service';
import { invoicePipelineService } from './InvoicePipelineService';
import { pusherService } from './pusherService';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus, InboundEmailStatus, InboundAttachmentStatus, EmailForwardingVerificationStatus, LocationForwardingStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isForwardingVerificationEmail, extractGmailVerificationLink } from '../utils/emailForwardingVerification';


const redact = (v?: string | null) => {
  if (!v) return 'null';
  if (v.length <= 8) return '********';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
};

const getMailgunApiKey = (): string => {
  const raw = config.MAILGUN_API_KEY as any;

  if (!raw || typeof raw !== 'string') {
    throw new Error('[InboundEmail] Missing MAILGUN_API_KEY (Mailgun private API key secret).');
  }

  // Mailgun UI sometimes shows keys as `key-<privateKey>`. For API auth, we must use the raw private key.
  const key = raw.startsWith('key-') ? raw.slice(4) : raw;

  // Lightweight sanity check (don’t be too strict — formats can vary)
  if (key.length < 20) {
    console.warn(`[InboundEmail] MAILGUN_API_KEY looks unusually short. Got: ${redact(key)}`);
  }

  // Warn if we had to strip the prefix (helps catch accidental use of webhook signing key)
  if (raw.startsWith('key-')) {
    console.warn(`[InboundEmail] MAILGUN_API_KEY included 'key-' prefix; stripped for HTTP Basic auth. Using: ${redact(key)}`);
  }

  return key;
};

const mailgunAuthHeaders = (): Record<string, string> => ({
  Authorization: `Basic ${Buffer.from(`api:${getMailgunApiKey()}`).toString('base64')}`,
  Accept: 'application/json',
});

const resolveMailgunApiUrl = (inputUrl: string): string => {
  const u = new URL(inputUrl);

  // If it’s a storage host, swap to the normal API host while preserving the path
  const isEu = u.hostname.includes('eu') || u.hostname.includes('mailgun.eu');
  u.hostname = isEu ? 'api.eu.mailgun.net' : 'api.mailgun.net';
  u.protocol = 'https:';
  return u.toString();
};

const fetchMailgunJson = async (url: string): Promise<Response> => {
  console.log(`[InboundEmail] Using MAILGUN_API_KEY: ${redact(config.MAILGUN_API_KEY)}`);

  // Storage hosts are often flaky / eventually-consistent. Prefer the standard API host first.
  const primaryUrl = (() => {
    try {
      const u = new URL(url);
      const isStorage = u.hostname.startsWith('storage-') || u.hostname.includes('storage');
      return isStorage ? resolveMailgunApiUrl(url) : url;
    } catch {
      return url;
    }
  })();

  let res = await fetch(primaryUrl, { headers: mailgunAuthHeaders() });

  const isStorageHost = (() => {
    try {
      const u = new URL(primaryUrl);
      return u.hostname.startsWith('storage-') || u.hostname.includes('storage');
    } catch {
      return false;
    }
  })();

  // On auth errors, retry against the standard API host.
  if (res.status === 401 || res.status === 403) {
    const fallbackUrl = resolveMailgunApiUrl(primaryUrl);
    if (fallbackUrl !== primaryUrl) {
      console.warn(`[InboundEmail] Mailgun fetch failed (${res.status}) for ${primaryUrl}. Retrying via ${fallbackUrl}`);
      console.log(`[InboundEmail] Using MAILGUN_API_KEY: ${redact(config.MAILGUN_API_KEY)}`);
      res = await fetch(fallbackUrl, { headers: mailgunAuthHeaders() });
    }
  }

  // IMPORTANT: storage hosts can return 404 even when the message is retrievable via api.mailgun.net.
  // If we got a 404 from a storage host, retry once via the standard API host.
  if (res.status === 404 && isStorageHost) {
    const fallbackUrl = resolveMailgunApiUrl(primaryUrl);
    if (fallbackUrl !== primaryUrl) {
      console.warn(`[InboundEmail] Mailgun storage 404 for ${primaryUrl}. Retrying via ${fallbackUrl}`);
      console.log(`[InboundEmail] Using MAILGUN_API_KEY: ${redact(config.MAILGUN_API_KEY)}`);
      res = await fetch(fallbackUrl, { headers: mailgunAuthHeaders() });
    }
  }

  if (!res.ok) {
    console.warn(`[InboundEmail] Mailgun fetch failed: ${res.status} ${res.statusText} url=${primaryUrl}`);
  }

  return res;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mailgun storage can be eventually-consistent for a short window after Store & Notify.
 * Retry a few times on 404 before treating as terminal.
 */
const fetchMailgunJsonWithRetry = async (
  url: string,
  opts: { maxAttempts?: number; initialDelayMs?: number } = {}
): Promise<Response> => {
  const maxAttempts = opts.maxAttempts ?? 10;
  let delay = opts.initialDelayMs ?? 1000;

  let lastRes: Response | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchMailgunJson(url);
    lastRes = res;

    if (res.status === 404) {
      try {
        const txt = await res.clone().text();
        console.warn(`[InboundEmail] Mailgun 404 body: ${txt.slice(0, 200)}`);
      } catch {
        // ignore
      }
    }

    // 404 can happen briefly right after inbound email arrives (storage not ready yet)
    if (res.status === 404 && attempt < maxAttempts) {
      console.warn(`[InboundEmail] Mailgun message 404 (attempt ${attempt}/${maxAttempts}). Waiting ${delay}ms then retrying...`);
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
      continue;
    }

    return res;
  }

  // Should never hit because we return inside the loop, but keep types happy
  return lastRes as Response;
};
// Mailgun types (partial)
interface MailgunAttachment {
  url: string;
  'content-type': string;
  name: string;
  size: number;
}

interface MailgunMessage {
  'body-plain'?: string;
  'body-html'?: string;
  attachments?: MailgunAttachment[];
}

export const inboundEmailService = {
  async fetchAndProcess(eventId: string) {
    console.log(`[InboundEmail] Starting process for event ${eventId}`);
    
    // 1. Load Event
    const event = await prisma.inboundEmailEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      console.error(`[InboundEmail] Event ${eventId} not found`);
      return;
    }

    if (
      event.status === InboundEmailStatus.PROCESSED || 
      event.status === InboundEmailStatus.FAILED_PROCESSING ||
      event.status === InboundEmailStatus.FAILED_ROUTING
    ) {
      console.log(`[InboundEmail] Event ${eventId} already in terminal state: ${event.status}`);
      return;
    }

    // Update status to PROCESSING
    await prisma.inboundEmailEvent.update({
      where: { id: eventId },
      data: { status: InboundEmailStatus.PROCESSING },
    });

    try {
      // 2. Routing Logic
      let locationId: string | null = null;
      let organisationId: string | null = null;
      let locationForwardingStatus: LocationForwardingStatus | null = null;

      // Prefer Recipient Alias (extracted in controller)
      const alias = event.recipientAlias;

      if (!alias) {
        throw new Error('No routing alias found in recipient');
      }

      // Check if Alias is UUID
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alias);

      if (isUuid) {
        const location = await prisma.location.findUnique({
          where: { id: alias },
          select: { id: true, organisationId: true, forwardingStatus: true },
        });
        if (location) {
          locationId = location.id;
          organisationId = location.organisationId;
          locationForwardingStatus = location.forwardingStatus;
        }
      } else {
        // Check custom mailgunAlias
        const location = await prisma.location.findUnique({
          where: { mailgunAlias: alias },
          select: { id: true, organisationId: true, forwardingStatus: true },
        });
        if (location) {
          locationId = location.id;
          organisationId = location.organisationId;
          locationForwardingStatus = location.forwardingStatus;
        }
      }

      if (!locationId || !organisationId) {
        await prisma.inboundEmailEvent.update({
          where: { id: eventId },
          data: { 
            status: InboundEmailStatus.FAILED_ROUTING,
            failureReason: `Could not resolve location for alias: ${alias}`
          },
        });
        return;
      }

      // Update event with resolved IDs
      await prisma.inboundEmailEvent.update({
        where: { id: eventId },
        data: { locationId, organisationId },
      });

      // 2.5. Check if this is a forwarding verification email
      const rawPayload = event.raw as any;
      const sender = event.sender;
      
      // Strict pre-check: only forwarding-noreply@google.com or forwarding-noreply@googlemail.com
      // OR body contains verification link pattern
      const mightBeVerification = sender?.toLowerCase().includes('forwarding-noreply@google.com') || 
                                   sender?.toLowerCase().includes('forwarding-noreply@googlemail.com');
      
      if (mightBeVerification) {
        console.log(`[InboundEmail] Potential verification email detected from ${sender}`);
        // First, try to get body from raw payload (already in webhook)
        let bodyText: string | null = rawPayload['body-plain'] || rawPayload['stripped-text'] || null;
        let bodyHtml: string | null = rawPayload['body-html'] || rawPayload['stripped-html'] || null;
        
        console.log(`[InboundEmail] Body text length: ${bodyText?.length || 0}, HTML length: ${bodyHtml?.length || 0}`);
        
        // If body not in raw payload, fetch from Mailgun storage URL
        if (!bodyText && !bodyHtml) {
          const storageUrl = rawPayload['message-url'] || rawPayload['storage']?.['url'];
          if (storageUrl) {
            try {
              const response = await fetchMailgunJsonWithRetry(storageUrl, { maxAttempts: 4, initialDelayMs: 500 });
              if (response.ok) {
                const messageData = await response.json() as MailgunMessage;
                bodyText = messageData['body-plain'] || null;
                bodyHtml = messageData['body-html'] || null;
              }
            } catch (err) {
              console.error('[InboundEmail] Failed to fetch message for verification check', err);
            }
          }
        }
        
        // After getting body (from payload or fetch), run extraction and only then commit to verification branch
        const isVerification = isForwardingVerificationEmail(sender, bodyText, bodyHtml);
        console.log(`[InboundEmail] isForwardingVerificationEmail returned: ${isVerification}`);
        
        if (isVerification) {
          const verificationLink = extractGmailVerificationLink(bodyText, bodyHtml);
          console.log(`[InboundEmail] Extracted verification link: ${verificationLink ? 'Found' : 'Not found'}`);
          
          if (verificationLink) {
            // Expire existing PENDING verifications and create new one in a transaction
            await prisma.$transaction(async (tx) => {
              // Expire existing PENDING verifications for this location
              await tx.emailForwardingVerification.updateMany({
                where: {
                  locationId: locationId!,
                  status: EmailForwardingVerificationStatus.PENDING
                },
                data: {
                  status: EmailForwardingVerificationStatus.EXPIRED
                }
              });
              
              // Create new PENDING verification
              await tx.emailForwardingVerification.create({
                data: {
                  organisationId: organisationId!,
                  locationId: locationId!,
                  recipientAlias: event.recipientAlias || event.recipient,
                  provider: 'GMAIL',
                  status: EmailForwardingVerificationStatus.PENDING,
                  verificationLink,
                  sender,
                  subject: event.subject,
                  emailMessageId: event.messageId || null,
                  expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000) // 72 hours
                }
              });
              
              // Update location forwarding status
              // This ensures status transitions correctly even if previous verification expired
              await tx.location.update({
                where: { id: locationId! },
                data: {
                  forwardingStatus: LocationForwardingStatus.PENDING_VERIFICATION
                }
              });
            });
            
            // Mark event as processed (successfully handled, though not as invoice)
            // Note: PROCESSED is used for all successfully handled emails, including verification emails
            await prisma.inboundEmailEvent.update({
              where: { id: eventId },
              data: { status: InboundEmailStatus.PROCESSED }
            });
            
            console.log(`[InboundEmail] Processed Gmail forwarding verification email for location ${locationId}`);
            return;
          }
        }
      }

      // 2.6. Check if forwarding is verified before processing invoices
      // Only process invoices if forwarding status is VERIFIED
      // Verification emails are handled above, so we skip them here
      if (!locationForwardingStatus || locationForwardingStatus !== LocationForwardingStatus.VERIFIED) {
        console.log(`[InboundEmail] Skipping invoice processing - forwarding not verified. Status: ${locationForwardingStatus || 'null/undefined'}`);
        await prisma.inboundEmailEvent.update({
          where: { id: eventId },
          data: { 
            status: InboundEmailStatus.FAILED_PROCESSING,
            failureReason: `Email forwarding not verified for location. Current status: ${locationForwardingStatus || 'NOT_CONFIGURED'}`
          },
        });
        return;
      }

      // 3. Fetch Message from Mailgun OR Use Staging Attachments
      let attachments: MailgunAttachment[] = [];
      let stagingAttachments: any[] = [];

      if (rawPayload.stagingAttachments && Array.isArray(rawPayload.stagingAttachments)) {
        // "Forward" route case: Attachments already in S3 (staging)
        console.log(`[InboundEmail] Found ${rawPayload.stagingAttachments.length} pre-uploaded staging attachments`);
        stagingAttachments = rawPayload.stagingAttachments;
      } else {
        // "Store and Notify" route case: Fetch from Storage URL
        const storageUrl = rawPayload['message-url'] || rawPayload['storage']?.['url'];
        
        if (!storageUrl) {
           // Fallback logic or error. For "Store and Notify", there should be a storage URL.
           // If "message-url" is not present, we might need to construct it or use what's available.
           // However, standard "Store and Notify" sends "message-url" or "storage.url".
           throw new Error('No storage URL found in webhook payload and no direct attachments present');
        }
  
        console.log(`[InboundEmail] Fetching message content from ${storageUrl}`);
        
        // Try original URL first, but retry on 404 (eventual consistency)
        const response = await fetchMailgunJsonWithRetry(storageUrl, { maxAttempts: 5, initialDelayMs: 750 });

        if (response.status === 404) {
          // After retries, treat as transient and allow BullMQ to retry the job later.
          // Mailgun storage can lag, and sometimes message becomes available after a longer window.
          await prisma.inboundEmailEvent.update({
            where: { id: eventId },
            data: {
              status: InboundEmailStatus.PROCESSING,
              failureReason: `Mailgun message returned 404 after retries; will retry job. url=${storageUrl}`,
            },
          });

          const err: any = new Error(`MAILGUN_MESSAGE_NOT_READY: 404 from Mailgun after retries. url=${storageUrl}`);
          err.code = 'MAILGUN_MESSAGE_NOT_READY';
          throw err;
        }
        if (!response.ok) {
          throw new Error(`Mailgun API error: ${response.status} ${response.statusText}`);
        }

        const messageData = await response.json() as MailgunMessage;
        attachments = messageData.attachments || [];
      }

      console.log(`[InboundEmail] Found ${attachments.length + stagingAttachments.length} attachments to process`);

      if (attachments.length === 0 && stagingAttachments.length === 0) {
          await prisma.inboundEmailEvent.update({
              where: { id: eventId },
              data: { 
                  status: InboundEmailStatus.FAILED_PROCESSING,
                  failureReason: 'No attachments found in email'
              }
          });
          return;
      }

      // 4. Process Attachments
      let successCount = 0;
      let processedAttachmentsCount = 0;

      // Limit max attachments
      const maxAttachments = config.MAILGUN_MAX_ATTACHMENTS || 10;
      
      // Combine lists (prioritizing staging if both exist, which is unlikely)
      const allAttachments = [
          ...stagingAttachments.map(sa => ({ type: 'staging', ...sa })),
          ...attachments.map(ma => ({ type: 'mailgun', ...ma }))
      ].slice(0, maxAttachments);

      for (const att of allAttachments) {
        processedAttachmentsCount++;
        
        // Normalize fields
        const fileName = att.type === 'staging' ? att.originalName : att.name;
        const mimeType = att.type === 'staging' ? att.mimeType : att['content-type'];
        const sizeBytes = att.type === 'staging' ? att.size : att.size;

        // Create InboundAttachment record
        const inboundAtt = await prisma.inboundAttachment.create({
          data: {
            inboundEmailEventId: eventId,
            filename: fileName,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            status: InboundAttachmentStatus.PENDING
          }
        });

        // Validation: Mime Type
        const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
        if (!allowedMimes.includes(mimeType)) {
           await prisma.inboundAttachment.update({
             where: { id: inboundAtt.id },
             data: { status: InboundAttachmentStatus.SKIPPED_TYPE, failureReason: 'Unsupported file type' }
           });
           continue;
        }

        // Validation: Size
        // Plan says "Max 20MB per attachment" in logic, but env has 40MB total.
        // Let's enforce 20MB individual limit for safety as per plan.
        if (sizeBytes > 20 * 1024 * 1024) {
             await prisma.inboundAttachment.update({
             where: { id: inboundAtt.id },
             data: { status: InboundAttachmentStatus.SKIPPED_SIZE, failureReason: 'File too large (>20MB)' }
           });
           continue;
        }

        // Download & Upload (or Copy from Staging)
        try {
            let finalS3Key = '';

            if (att.type === 'staging') {
                // It's already in S3 (Staging) -> Move/Copy to Final
                await prisma.inboundAttachment.update({
                    where: { id: inboundAtt.id },
                    data: { status: InboundAttachmentStatus.UPLOADING } // It's technically moving
                });

                // We need to move it to the correct final path structure
                const stagingKey = att.key;
                finalS3Key = `inbound-email/${organisationId}/${locationId}/${eventId}/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
                
                // CopyObject (Move)
                await s3Service.copyObject(stagingKey, finalS3Key);
                // Optionally delete staging object, but S3 lifecycle rules are safer
                // await s3Service.deleteObject(stagingKey); 

            } else {
                // It's in Mailgun -> Download & Upload
                await prisma.inboundAttachment.update({
                    where: { id: inboundAtt.id },
                    data: { status: InboundAttachmentStatus.DOWNLOADING }
                });
    
                const attResponse = await fetchMailgunJson(att.url);
    
                if (!attResponse.ok) throw new Error(`Failed to download attachment: ${attResponse.statusText}`);
    
                const arrayBuffer = await attResponse.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
    
                await prisma.inboundAttachment.update({
                    where: { id: inboundAtt.id },
                    data: { status: InboundAttachmentStatus.UPLOADING }
                });
    
                finalS3Key = `inbound-email/${organisationId}/${locationId}/${eventId}/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
                
                await s3Service.putObject(finalS3Key, buffer, { ContentType: mimeType });
            }

            // Create InvoiceFile
            const invoiceFile = await prisma.invoiceFile.create({
                data: {
                    organisationId: organisationId!,
                    locationId: locationId!,
                    sourceType: InvoiceSourceType.EMAIL,
                    sourceReference: eventId, // Link back to event
                    fileName: fileName,
                    mimeType: mimeType,
                    storageKey: finalS3Key,
                    fileSizeBytes: sizeBytes,
                    processingStatus: ProcessingStatus.PENDING_OCR,
                    reviewStatus: ReviewStatus.NONE
                }
            });

            // Link Attachment to InvoiceFile
            await prisma.inboundAttachment.update({
                where: { id: inboundAtt.id },
                data: { 
                    status: InboundAttachmentStatus.OCR_STARTED,
                    invoiceFileId: invoiceFile.id 
                }
            });

            // Trigger Pusher Event for real-time UI update
            const channel = pusherService.getOrgChannel(organisationId!);
            await pusherService.triggerEvent(channel, 'invoice-file-created', {
                invoiceFileId: invoiceFile.id,
                fileName: invoiceFile.fileName,
                sourceType: 'EMAIL',
                status: invoiceFile.processingStatus,
                createdAt: invoiceFile.createdAt.toISOString(),
                locationId: invoiceFile.locationId
            });

            // Trigger OCR
            // We run this async without awaiting if we want faster processing, but awaiting ensures we know it started.
            // InvoicePipelineService.startOcrProcessing handles its own errors safely.
            await invoicePipelineService.startOcrProcessing(invoiceFile.id);
            
            successCount++;
            
        } catch (attError: any) {
            console.error(`[InboundEmail] Attachment processing failed for ${inboundAtt.id}`, attError);
            await prisma.inboundAttachment.update({
                where: { id: inboundAtt.id },
                data: { 
                    status: InboundAttachmentStatus.FAILED,
                    failureReason: attError.message
                }
            });
        }
      }

      // 5. Final Status Update
      if (successCount > 0) {
          await prisma.inboundEmailEvent.update({
              where: { id: eventId },
              data: { status: InboundEmailStatus.PROCESSED }
          });
      } else {
          // If we had attachments but none succeeded
           await prisma.inboundEmailEvent.update({
              where: { id: eventId },
              data: { 
                  status: InboundEmailStatus.FAILED_PROCESSING,
                  failureReason: 'All attachments failed or were skipped'
              }
          });
      }

    } catch (err: any) {
      console.error(`[InboundEmail] Fatal error processing event ${eventId}`, err);
      await prisma.inboundEmailEvent.update({
        where: { id: eventId },
        data: { 
          status: InboundEmailStatus.FAILED_PROCESSING,
          failureReason: err.message
        },
      });
      throw err; // Re-throw to let BullMQ retry if transient
    }
  }
};
