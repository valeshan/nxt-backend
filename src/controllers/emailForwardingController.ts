import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { EmailForwardingVerificationStatus, LocationForwardingStatus } from '@prisma/client';

export const emailForwardingController = {
  async getVerificationStatus(
    request: FastifyRequest<{ Params: { locationId: string } }>,
    reply: FastifyReply
  ) {
    const { locationId } = request.params;
    const userId = request.authContext.userId;

    // Verify location belongs to user's org
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        organisationId: true,
        forwardingStatus: true,
        organisation: {
          select: {
            members: {
              where: { userId },
              select: { id: true }
            }
          }
        }
      }
    });

    if (!location || location.organisation.members.length === 0) {
      return reply.status(404).send({ error: 'Location not found' });
    }

    // Get latest PENDING verification
    const verification = await prisma.emailForwardingVerification.findFirst({
      where: {
        locationId,
        status: EmailForwardingVerificationStatus.PENDING
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        verificationLink: true,
        expiresAt: true,
        createdAt: true,
      }
    });

    return reply.send({
      verification: verification ? {
        ...verification,
        expiresAt: verification.expiresAt.toISOString(),
        createdAt: verification.createdAt.toISOString(),
      } : null,
      locationStatus: location.forwardingStatus,
    });
  },

  async confirmVerification(
    request: FastifyRequest<{ Params: { locationId: string } }>,
    reply: FastifyReply
  ) {
    const { locationId } = request.params;
    const userId = request.authContext.userId;

    // Verify location belongs to user's org
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        organisationId: true,
        organisation: {
          select: {
            members: {
              where: { userId },
              select: { id: true }
            }
          }
        }
      }
    });

    if (!location || location.organisation.members.length === 0) {
      return reply.status(404).send({ error: 'Location not found' });
    }

    // Check if there is a pending verification
    const pendingVerification = await prisma.emailForwardingVerification.findFirst({
      where: {
        locationId,
        status: EmailForwardingVerificationStatus.PENDING
      }
    });

    if (!pendingVerification) {
      return reply.status(400).send({ error: 'No pending verification found' });
    }

    // Update verification and location status
    await prisma.$transaction(async (tx) => {
      const updateResult = await tx.emailForwardingVerification.updateMany({
        where: {
          locationId,
          status: EmailForwardingVerificationStatus.PENDING
        },
        data: {
          status: EmailForwardingVerificationStatus.COMPLETED
        }
      });

      // Only update location if at least one verification was updated
      if (updateResult.count > 0) {
        await tx.location.update({
          where: { id: locationId },
          data: {
            forwardingStatus: LocationForwardingStatus.VERIFIED,
            forwardingVerifiedAt: new Date()
          }
        });
      }
    });

    return reply.send({ success: true });
  },
};
