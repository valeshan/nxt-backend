import prisma from '../infrastructure/prismaClient';
import { config } from '../config/env';
import { s3Service } from './S3Service';
import { invoicePipelineService } from './InvoicePipelineService';
import { InvoiceSourceType, ProcessingStatus, ReviewStatus, InboundEmailStatus, InboundAttachmentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

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
          select: { id: true, organisationId: true },
        });
        if (location) {
          locationId = location.id;
          organisationId = location.organisationId;
        }
      } else {
        // Check custom mailgunAlias
        const location = await prisma.location.findUnique({
          where: { mailgunAlias: alias },
          select: { id: true, organisationId: true },
        });
        if (location) {
          locationId = location.id;
          organisationId = location.organisationId;
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

      // 3. Fetch Message from Mailgun OR Use Staging Attachments
      const rawPayload = event.raw as any;
      let attachments: MailgunAttachment[] = [];
      let stagingAttachments: any[] = [];

      if (rawPayload.stagingAttachments && Array.isArray(rawPayload.stagingAttachments)) {
        // "Forward" route case: Attachments already in S3 (staging)
        console.log(`[InboundEmail] Found ${rawPayload.stagingAttachments.length} pre-uploaded staging attachments`);
        stagingAttachments = rawPayload.stagingAttachments;
      } else {
        // "Store and Notify" route case: Fetch from Storage URL
        const storageUrl = rawPayload['storage']?.['url'] || rawPayload['message-url']; 
        
        if (!storageUrl) {
           // Fallback logic or error. For "Store and Notify", there should be a storage URL.
           // If "message-url" is not present, we might need to construct it or use what's available.
           // However, standard "Store and Notify" sends "message-url" or "storage.url".
           throw new Error('No storage URL found in webhook payload and no direct attachments present');
        }
  
        console.log(`[InboundEmail] Fetching message content from ${storageUrl}`);
        
        // Try original URL first
        let response = await fetch(storageUrl, {
          headers: {
            Authorization: `Basic ${Buffer.from(`api:${config.MAILGUN_API_KEY}`).toString('base64')}`,
            Accept: 'application/json'
          }
        });

        // Fallback Logic for Storage URL Auth Issues
        if (response.status === 401 || response.status === 403 || response.status === 404) {
             console.warn(`[InboundEmail] Storage URL failed (${response.status}), attempting fallback to standard API endpoint...`);
             
             // Extract path from storage URL (e.g., /v3/domains/...)
             // Storage URL format: https://storage-us-east4.api.mailgun.net/v3/domains/...
             try {
                 const urlObj = new URL(storageUrl);
                 const standardApiUrl = `https://api.mailgun.net${urlObj.pathname}`;
                 
                 console.log(`[InboundEmail] Fallback URL: ${standardApiUrl}`);
                 
                 response = await fetch(standardApiUrl, {
                    headers: {
                        Authorization: `Basic ${Buffer.from(`api:${config.MAILGUN_API_KEY}`).toString('base64')}`,
                        Accept: 'application/json'
                    }
                 });
             } catch (urlErr) {
                 console.error('[InboundEmail] Failed to construct fallback URL', urlErr);
             }
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
    
                const attResponse = await fetch(att.url, {
                    headers: {
                        Authorization: `Basic ${Buffer.from(`api:${config.MAILGUN_API_KEY}`).toString('base64')}`
                    }
                });
    
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
