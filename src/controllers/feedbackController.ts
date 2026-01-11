import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as Sentry from '@sentry/node';
import { FeedbackRequest } from '../dtos/feedbackDtos';
import { GmailSmtpProvider } from '../services/emailProviders/gmailSmtpProvider';
import { buildFeedbackEmail } from '../services/emailTemplates/feedbackTemplates';
import { config } from '../config/env';
import prisma from '../infrastructure/prismaClient';

const emailProvider = new GmailSmtpProvider();

export const feedbackController = {
  async submitFeedback(
    request: FastifyRequest<{ Body: z.infer<typeof FeedbackRequest> }>,
    reply: FastifyReply
  ) {
    try {
      const feedback = request.body;
      const { userId } = request.authContext;

      // Validate required fields
      if (!feedback.referenceType || !feedback.message) {
        return reply.code(400).send({
          success: false,
          message: 'referenceType and message are required',
        });
      }

      // Get recipient email from env var
      const recipientEmail = config.FEEDBACK_TO_EMAIL;
      if (!recipientEmail) {
        request.log.error({ msg: 'FEEDBACK_TO_EMAIL not configured' });
        return reply.code(500).send({
          success: false,
          message: 'Feedback email recipient not configured',
        });
      }

      // 1. Fetch user, organisation, and location names for email
      const [user, organisation, location] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, firstName: true, lastName: true, email: true },
        }),
        feedback.organisationId
          ? prisma.organisation.findUnique({
              where: { id: feedback.organisationId },
              select: { name: true },
            })
          : null,
        feedback.locationId
          ? prisma.location.findUnique({
              where: { id: feedback.locationId },
              select: { name: true },
            })
          : null,
      ]);

      // Use user email from DB or client-provided, fallback to unknown
      const userEmail = user?.email || feedback.userEmail || 'unknown@example.com';

      // 2. Save to database FIRST (before email)
      const feedbackRecord = await prisma.feedback.create({
        data: {
          referenceType: feedback.referenceType,
          message: feedback.message,
          userId: feedback.userId,
          orgId: feedback.organisationId,
          locationId: feedback.locationId,
          pageUrl: feedback.fullUrl,
          userAgent: feedback.userAgent,
          screenWidth: feedback.screenWidth,
          screenHeight: feedback.screenHeight,
          environment: feedback.environment,
          status: 'new',
        },
      });

      // 3. Build email with feedbackId and user-friendly names
      const { subject, html, text } = buildFeedbackEmail(
        feedback,
        userId,
        userEmail,
        feedbackRecord.id, // Include feedbackId
        {
          userName:
            user?.name ||
            `${user?.firstName || ''} ${user?.lastName || ''}`.trim() ||
            'Unknown',
          userEmail: userEmail,
          organisationName: organisation?.name || null,
          locationName: location?.name || null,
        }
      );

      // 4. Send email (fire-and-forget for true non-blocking, but track status)
      emailProvider
        .sendEmail({
          to: recipientEmail,
          subject,
          html,
          text,
          headers: {
            'X-Feedback-ID': feedbackRecord.id, // Machine-parsable header for email piping
          },
        })
        .then(async () => {
          // Update email status on success
          await prisma.feedback.update({
            where: { id: feedbackRecord.id },
            data: { emailStatus: 'sent', emailError: null },
          });
          request.log.info({
            msg: 'Feedback email sent successfully',
            feedbackId: feedbackRecord.id,
          });
        })
        .catch(async (error) => {
          // Update email status on failure
          const errorMessage = error.message || 'Unknown error';
          await prisma.feedback.update({
            where: { id: feedbackRecord.id },
            data: { emailStatus: 'failed', emailError: errorMessage },
          });

          // Log error
          request.log.error({
            msg: 'Failed to send feedback email',
            feedbackId: feedbackRecord.id,
            error: errorMessage,
            stack: error.stack,
          });

          // Capture in Sentry for visibility and alerting
          Sentry.withScope((scope) => {
            scope.setContext('feedback', {
              feedbackId: feedbackRecord.id,
              referenceType: feedback.referenceType,
              userId: userId,
              organisationId: feedback.organisationId,
              locationId: feedback.locationId,
            });
            scope.setTag('feedback_email_failed', 'true');
            scope.setLevel('error');
            Sentry.captureException(error);
          });
        });

      request.log.info({
        msg: 'Feedback submitted',
        feedbackId: feedbackRecord.id,
        referenceType: feedback.referenceType,
        userId,
        organisationId: feedback.organisationId,
        locationId: feedback.locationId,
      });

      return reply.send({
        success: true,
        message: 'Feedback submitted successfully',
      });
    } catch (error: any) {
      request.log.error({
        msg: 'Failed to submit feedback',
        error: error.message,
        stack: error.stack,
      });

      return reply.code(500).send({
        success: false,
        message: 'Failed to submit feedback',
      });
    }
  },
};

