import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';
import { normalizePhrase } from '../utils/descriptionQuality';

export class SettingsController {
  // Helper for org access validation
  private validateOrgAccess(request: FastifyRequest) {
    const { organisationId } = request.authContext;
    
    if (!organisationId) {
      throw { statusCode: 403, message: 'Forbidden: Organisation context required' };
    }
    
    return { organisationId };
  }

  listLexiconEntries = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { organisationId } = this.validateOrgAccess(request);
      const { q, limit = 50, cursor } = request.query as {
        q?: string;
        limit?: number;
        cursor?: string;
      };

      // Parse limit safely
      const take = Math.min(200, Math.max(1, Number(limit) || 50));

      // Build where clause
      const where: any = {
        organisationId,
      };

      // Search by phrase (normalize search input for consistent matching)
      if (q) {
        const normalizedQuery = normalizePhrase(q);
        where.phrase = {
          contains: normalizedQuery,
          mode: 'insensitive' as any,
        };
      }

      // Cursor-based pagination (stable: order by id desc, cursor uses lt)
      if (cursor) {
        where.id = {
          lt: cursor,
        };
      }

      // Fetch entries
      const entries = await prisma.organisationLexiconEntry.findMany({
        where,
        orderBy: {
          id: 'desc', // Stable ordering for pagination
        },
        take: take + 1, // Fetch one extra to check if there's more
      });

      const hasMore = entries.length > take;
      const data = hasMore ? entries.slice(0, take) : entries;
      const nextCursor = hasMore ? data[data.length - 1].id : null;

      return reply.send({
        data: data.map(entry => ({
          id: entry.id,
          phrase: entry.phrase,
          addedOn: entry.createdAt,
          lastSeen: entry.lastSeenAt,
          timesSeen: entry.timesSeen,
        })),
        pagination: {
          cursor: nextCursor,
          hasMore,
        },
      });
    } catch (error: any) {
      console.error('[SettingsController] Error listing lexicon entries:', error);
      return reply.status(500).send({ 
        error: 'Failed to fetch lexicon entries',
        message: error.message,
        code: error.code 
      });
    }
  };


  deleteLexiconEntry = async (request: FastifyRequest, reply: FastifyReply) => {
    const { organisationId } = this.validateOrgAccess(request);
    const { id } = request.params as { id: string };

    // Verify entry belongs to organisation
    const entry = await prisma.organisationLexiconEntry.findUnique({
      where: { id },
      select: { organisationId: true },
    });

    if (!entry) {
      return reply.status(404).send({ error: 'Lexicon entry not found' });
    }

    if (entry.organisationId !== organisationId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    await prisma.organisationLexiconEntry.delete({
      where: { id },
    });

    return reply.send({ success: true });
  };
}

