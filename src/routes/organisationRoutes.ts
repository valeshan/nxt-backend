import { FastifyInstance } from 'fastify';
import { organisationController } from '../controllers/organisationController';
import { CreateOrganisationRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';
import { z } from 'zod';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import { OrganisationRole } from '@prisma/client';
import prisma from '../infrastructure/prismaClient';

const manualOnboardRequest = z.object({
  venueName: z.string().min(1),
  onboardingSessionId: z.string().optional(),
});

export default async function organisationRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Public Routes
  app.post('/onboard/manual', {
    schema: {
        body: manualOnboardRequest
    }
  }, organisationController.manualOnboard);

  // Protected Routes
  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.post('/', {
      schema: {
        body: CreateOrganisationRequest,
      },
    }, organisationController.create);

    typedApp.get('/', organisationController.list);

    // Email management schema
    const emailSchema = z.object({
      email: z.string().email('Invalid email format').max(254, 'Email too long').toLowerCase().trim(),
    });

    // Add email to shared reports
    typedApp.post('/:id/report-emails', {
      schema: {
        params: z.object({ id: z.string() }),
        body: emailSchema,
      }
    }, async (request, reply) => {
      const { id: organisationId } = request.params;
      const { email } = request.body;
      const { userId } = request.authContext;

      // 1. Authorization: Verify membership and role
      const membership = await userOrganisationRepository.findMembership(userId, organisationId);
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      // 2. Fetch current organisation to dedupe
      const org = await prisma.organisation.findUnique({
        where: { id: organisationId },
        select: { sharedReportEmails: true }
      });

      if (!org) return reply.status(404).send({ error: 'Organisation not found' });

      // 3. Validation: Check duplicates and max limit
      if (org.sharedReportEmails.includes(email)) {
        // Idempotent: return success with current list
        return reply.send({ success: true, data: org.sharedReportEmails });
      }
      
      if (org.sharedReportEmails.length >= 10) {
        return reply.status(400).send({ error: 'Maximum limit of 10 shared emails reached' });
      }

      // 4. Update atomically (add email to array)
      const updatedEmails = [...org.sharedReportEmails, email];
      const updatedOrg = await prisma.organisation.update({
        where: { id: organisationId },
        data: {
          sharedReportEmails: updatedEmails
        },
        select: { sharedReportEmails: true }
      });

      return { success: true, data: updatedOrg.sharedReportEmails };
    });

    // Remove email from shared reports
    typedApp.delete('/:id/report-emails', {
      schema: {
        params: z.object({ id: z.string() }),
        body: emailSchema,
      }
    }, async (request, reply) => {
      const { id: organisationId } = request.params;
      const { email } = request.body;
      const { userId } = request.authContext;

      // 1. Authorization
      const membership = await userOrganisationRepository.findMembership(userId, organisationId);
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      // 2. Fetch current list
      const org = await prisma.organisation.findUnique({
        where: { id: organisationId },
        select: { sharedReportEmails: true }
      });

      if (!org) return reply.status(404).send({ error: 'Organisation not found' });

      // 3. Filter and Update (idempotent: if email not found, return current list)
      const updatedEmails = org.sharedReportEmails.filter(e => e !== email);

      if (updatedEmails.length === org.sharedReportEmails.length) {
        // Email not found, return current list (idempotent)
        return reply.send({ success: true, data: org.sharedReportEmails });
      }

      const updatedOrg = await prisma.organisation.update({
        where: { id: organisationId },
        data: {
          sharedReportEmails: updatedEmails
        },
        select: { sharedReportEmails: true }
      });

      return { success: true, data: updatedOrg.sharedReportEmails };
    });
  });
}
