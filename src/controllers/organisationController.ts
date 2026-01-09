import { FastifyRequest, FastifyReply } from 'fastify';
import { organisationService } from '../services/organisationService';
import { CreateOrganisationRequest, CreateOrganisationWithLocationRequest } from '../dtos/authDtos';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { resolveOrganisationEntitlements } from '../services/entitlements/resolveOrganisationEntitlements';
import { getSeatUsage } from '../services/entitlements/seatAccounting';
import { PLAN_LABELS } from '../config/plans';
import prisma from '../infrastructure/prismaClient';
import { userOrganisationRepository } from '../repositories/userOrganisationRepository';

const manualOnboardSchema = z.object({
  venueName: z.string().min(1),
  onboardingSessionId: z.string().optional(),
});

export const organisationController = {
  async create(request: FastifyRequest<{ Body: z.infer<typeof CreateOrganisationRequest> }>, reply: FastifyReply) {
    const { name } = request.body;
    const userId = request.authContext.userId;
    const result = await organisationService.createOrganisation(userId, name);
    return reply.code(201).send(result);
  },

  async createWithLocation(
    request: FastifyRequest<{ Body: z.infer<typeof CreateOrganisationWithLocationRequest> }>,
    reply: FastifyReply
  ) {
    const { name, locationName } = request.body;
    const userId = request.authContext.userId;
    const result = await organisationService.createOrganisationWithFirstLocation(userId, name, locationName);
    return reply.code(201).send(result);
  },

  async list(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.authContext.userId;
    const result = await organisationService.listForUser(userId);
    return reply.send(result);
  },

  async entitlements(
    request: FastifyRequest<{ Params: { orgId: string } }>,
    reply: FastifyReply
  ) {
    const { orgId } = request.params;
    const userId = request.authContext.userId;

    // Membership check (any role)
    const membership = await userOrganisationRepository.findMembership(userId, orgId);
    if (!membership) {
      return reply.code(403).send({ message: 'Not a member of this organisation' });
    }

    // Resolve entitlements
    const entitlements = await resolveOrganisationEntitlements(orgId);

    // Usage
    const { seatCount, pendingInvites, seatReservedCount } = await getSeatUsage(orgId);
    const locationCount = await prisma.location.count({ where: { organisationId: orgId } });

    const planLabel = PLAN_LABELS[entitlements.planKey] ?? entitlements.planKey;
    const accessPlanLabel = PLAN_LABELS[entitlements.accessPlanKey] ?? entitlements.accessPlanKey;
    const now = new Date();
    const willDowngradeAt =
      entitlements.billing.accessState === 'active' &&
      !entitlements.billing.isBillableActive &&
      entitlements.billing.currentPeriodEndsAt &&
      now < entitlements.billing.currentPeriodEndsAt
        ? entitlements.billing.currentPeriodEndsAt
        : null;
    const willDowngradeToPlanKey = willDowngradeAt ? 'free' : null;
    const willDowngradeToPlanLabel = willDowngradeAt ? PLAN_LABELS['free'] : null;

    return reply.send({
      planKey: entitlements.planKey,
      planLabel,
      accessPlanKey: entitlements.accessPlanKey,
      accessPlanLabel,
      willDowngradeToPlanKey,
      willDowngradeToPlanLabel,
      willDowngradeAt,
      caps: entitlements.caps,
      flags: entitlements.flags,
      billing: entitlements.billing,
      usage: {
        seatCount,
        pendingInvites,
        seatReservedCount,
        locationCount,
      },
    });
  },

  async manualOnboard(request: FastifyRequest<{ Body: z.infer<typeof manualOnboardSchema> }>, reply: FastifyReply) {
    const { venueName, onboardingSessionId } = request.body;
    
    // Check if user is authenticated (optional) to link them
    let userId: string | undefined;
    
    // Try to extract user from request.authContext (if plugin ran) or manually verify token (optional auth)
    // Since this route is public, plugin likely didn't run or didn't enforce auth.
    // Check header manually.
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const token = authHeader.split(' ')[1];
            const payload = jwt.verify(token, config.JWT_VERIFY_SECRET) as any;
            if (payload && payload.sub) {
                userId = payload.sub;
            }
        } catch (e) {
            // Ignore invalid token for optional auth
        }
    }

    const result = await organisationService.manualOnboard(venueName, onboardingSessionId, userId);
    return reply.code(201).send(result);
  },

  async updatePlan(
    request: FastifyRequest<{ Params: { orgId: string }; Body: { planKey: string } }>,
    reply: FastifyReply
  ) {
    const { orgId } = request.params;
    const { planKey } = request.body;
    const userId = request.authContext.userId;

    const membership = await userOrganisationRepository.findMembership(userId, orgId);
    if (!membership || membership.role !== 'owner') {
      return reply.code(403).send({ message: 'Insufficient permissions' });
    }

    const result = await organisationService.updatePlan(orgId, planKey);
    return reply.send(result);
  },

  async updateOverrides(
    request: FastifyRequest<{ Params: { orgId: string }; Body: unknown }>,
    reply: FastifyReply
  ) {
    const { orgId } = request.params;
    const overrides = request.body;
    const userId = request.authContext.userId;

    const membership = await userOrganisationRepository.findMembership(userId, orgId);
    if (!membership || membership.role !== 'owner') {
      return reply.code(403).send({ message: 'Insufficient permissions' });
    }

    try {
      const result = await organisationService.updateOverrides(orgId, overrides);
      return reply.send(result);
    } catch (e: any) {
      if (e.name === 'ZodError') {
        return reply.code(400).send({ message: 'Invalid override data', details: e.issues });
      }
      throw e;
    }
  }
};
