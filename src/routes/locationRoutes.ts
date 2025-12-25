import { FastifyInstance } from 'fastify';
import { locationController } from '../controllers/locationController';
import { CreateLocationRequest } from '../dtos/authDtos';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import authContextPlugin from '../plugins/authContext';
import z from 'zod';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';
import prisma from '../infrastructure/prismaClient';

export default async function locationRoutes(fastify: FastifyInstance) {
  fastify.register(authContextPlugin);
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/locations', {
    schema: {
      // No URL params – organisation is derived from auth context
      body: CreateLocationRequest,
      response: {
        201: z.object({
          id: z.string(),
          name: z.string(),
          organisationId: z.string(),
          sharedReportEmails: z.array(z.string()),
          createdAt: z.date(),
          updatedAt: z.date(),
          integrations: z.array(z.object({
            type: z.string(),
            name: z.string(),
            status: z.string(),
          })),
        }),
      },
    },
  }, locationController.create);

  app.get('/locations', {
    schema: {
      response: {
        200: z.array(z.object({
          id: z.string(),
          name: z.string(),
          organisationId: z.string(),
          sharedReportEmails: z.array(z.string()),
          createdAt: z.date(),
          updatedAt: z.date(),
          forwardingStatus: z.enum(['NOT_CONFIGURED', 'PENDING_VERIFICATION', 'VERIFIED']).nullable(),
          industry: z.enum(['CAFE', 'RESTAURANT', 'BAR', 'BAKERY', 'RETAIL', 'HOTEL', 'CATERING', 'OTHER']).nullable(),
          region: z.string().nullable(),
          autoApproveCleanInvoices: z.boolean(),
          integrations: z.array(z.object({
            type: z.string(),
            name: z.string(),
            status: z.string()
          }))
        }))
      }
    },
  }, locationController.listMine);

  app.get('/organisations/:organisationId/locations', {
    schema: {
      params: z.object({ organisationId: z.string() }),
      response: {
        200: z.array(z.object({
          id: z.string(),
          name: z.string(),
          organisationId: z.string(),
          sharedReportEmails: z.array(z.string()),
          createdAt: z.date(),
          updatedAt: z.date(),
          forwardingStatus: z.enum(['NOT_CONFIGURED', 'PENDING_VERIFICATION', 'VERIFIED']).nullable(),
          industry: z.enum(['CAFE', 'RESTAURANT', 'BAR', 'BAKERY', 'RETAIL', 'HOTEL', 'CATERING', 'OTHER']).nullable(),
          region: z.string().nullable(),
          autoApproveCleanInvoices: z.boolean(),
          integrations: z.array(z.object({
            type: z.string(),
            name: z.string(),
            status: z.string()
          }))
        }))
      }
    },
  }, locationController.list);

  app.put('/locations/:id', {
    schema: {
      params: z.object({ id: z.string() }),
      body: z.object({ 
        name: z.string().min(1).optional(),
        industry: z.enum(['CAFE', 'RESTAURANT', 'BAR', 'BAKERY', 'RETAIL', 'HOTEL', 'CATERING', 'OTHER']).nullable().optional(),
        region: z.string().nullable().optional(),
        autoApproveCleanInvoices: z.boolean().optional(),
      }),
    },
  }, locationController.update);

  app.delete('/locations/:id', {
    schema: {
      params: z.object({ id: z.string() }),
    },
  }, locationController.deleteLocationHandler);

  // Email management schema
  const emailSchema = z.object({
    email: z.string().email('Invalid email format').max(254, 'Email too long').toLowerCase().trim(),
  });

  // Add email to shared reports for a location
  app.post('/locations/:id/report-emails', {
    schema: {
      params: z.object({ id: z.string() }),
      body: emailSchema,
    }
  }, async (request, reply) => {
    const { id: locationId } = request.params;
    const { email } = request.body;
    const { userId } = request.authContext;

    // 1. Fetch location and verify it exists
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: { 
        id: true,
        organisationId: true,
        sharedReportEmails: true
      }
    });

    if (!location) {
      return reply.status(404).send({ error: 'Location not found' });
    }

    // 2. Authorization: Verify user is admin/owner of the location's organisation
    const membership = await userOrganisationRepository.findMembership(userId, location.organisationId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return reply.status(403).send({ error: 'Insufficient permissions' });
    }

    // 3. Validation: Check duplicates and max limit
    const normalizedEmail = email.toLowerCase().trim();
    if (location.sharedReportEmails.includes(normalizedEmail)) {
      // Idempotent: return success with current list
      return reply.send({ success: true, data: location.sharedReportEmails });
    }
    
    if (location.sharedReportEmails.length >= 10) {
      return reply.status(400).send({ error: 'Maximum limit of 10 shared emails reached' });
    }

    // 4. Update atomically (add email to array)
    const updatedEmails = [...location.sharedReportEmails, normalizedEmail];
    const updatedLocation = await prisma.location.update({
      where: { id: locationId },
      data: {
        sharedReportEmails: updatedEmails
      },
      select: { sharedReportEmails: true }
    });

    return { success: true, data: updatedLocation.sharedReportEmails };
  });

  // Remove email from shared reports for a location
  app.delete('/locations/:id/report-emails', {
    schema: {
      params: z.object({ id: z.string() }),
      body: emailSchema,
    }
  }, async (request, reply) => {
    const { id: locationId } = request.params;
    const { email } = request.body;
    const { userId } = request.authContext;

    // 1. Fetch location and verify it exists
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: { 
        id: true,
        organisationId: true,
        sharedReportEmails: true
      }
    });

    if (!location) {
      return reply.status(404).send({ error: 'Location not found' });
    }

    // 2. Authorization: Verify user is admin/owner of the location's organisation
    const membership = await userOrganisationRepository.findMembership(userId, location.organisationId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return reply.status(403).send({ error: 'Insufficient permissions' });
    }

    // 3. Filter and Update (idempotent: if email not found, return current list)
    const normalizedEmail = email.toLowerCase().trim();
    const updatedEmails = location.sharedReportEmails.filter(e => e !== normalizedEmail);

    if (updatedEmails.length === location.sharedReportEmails.length) {
      // Email not found, return current list (idempotent)
      return reply.send({ success: true, data: location.sharedReportEmails });
    }

    const updatedLocation = await prisma.location.update({
      where: { id: locationId },
      data: {
        sharedReportEmails: updatedEmails
      },
      select: { sharedReportEmails: true }
    });

    return { success: true, data: updatedLocation.sharedReportEmails };
  });
}
