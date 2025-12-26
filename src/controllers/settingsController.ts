import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../infrastructure/prismaClient';

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
    const { organisationId } = this.validateOrgAccess(request);
    const { scope, supplierId, q, limit = 50, cursor } = request.query as {
      scope?: 'ORG' | 'SUPPLIER';
      supplierId?: string;
      q?: string;
      limit?: number;
      cursor?: string;
    };

    // Build where clause
    const where: any = {
      organisationId,
    };

    // Filter by scope
    if (scope === 'ORG') {
      where.scopeKey = 'ORG';
    } else if (scope === 'SUPPLIER') {
      where.scopeKey = { not: 'ORG' };
    }

    // Filter by supplier
    if (supplierId) {
      where.supplierId = supplierId;
    }

    // Search by phrase (case-insensitive)
    if (q) {
      where.phrase = {
        contains: q,
        mode: 'insensitive' as any,
      };
    }

    // Cursor-based pagination
    if (cursor) {
      where.id = {
        gt: cursor,
      };
    }

    // Fetch entries with supplier relation
    const entries = await prisma.organisationLexiconEntry.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        lastSeenAt: 'desc',
      },
      take: limit + 1, // Fetch one extra to check if there's more
    });

    const hasMore = entries.length > limit;
    const data = hasMore ? entries.slice(0, limit) : entries;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return reply.send({
      data: data.map(entry => ({
        id: entry.id,
        phrase: entry.phrase,
        scope: entry.scopeKey === 'ORG' ? 'ORG' : 'SUPPLIER',
        supplierId: entry.supplierId,
        supplierName: entry.supplier?.name || null,
        addedOn: entry.createdAt,
        lastSeen: entry.lastSeenAt,
        timesSeen: entry.timesSeen,
      })),
      pagination: {
        cursor: nextCursor,
        hasMore,
      },
    });
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

