import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FeedbackRequest } from '../dtos/feedbackDtos';
import { GmailSmtpProvider } from '../services/emailProviders/gmailSmtpProvider';
import { buildFeedbackEmail } from '../services/emailTemplates/feedbackTemplates';
import { config } from '../config/env';

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

      // Use client-provided email for debugging, fallback to unknown
      const userEmail = feedback.userEmail || 'unknown@example.com';

      // Build email
      const { subject, html, text } = buildFeedbackEmail(
        feedback,
        userId,
        userEmail
      );

      // Send email
      await emailProvider.sendEmail({
        to: recipientEmail,
        subject,
        html,
        text,
      });

      request.log.info({
        msg: 'Feedback submitted',
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

