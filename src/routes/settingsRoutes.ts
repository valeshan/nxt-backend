import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SettingsController } from '../controllers/settingsController';
import authContextPlugin from '../plugins/authContext';
import z from 'zod';

const settingsController = new SettingsController();

export default async function settingsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.register(async (protectedApp) => {
    protectedApp.register(authContextPlugin);
    const typedApp = protectedApp.withTypeProvider<ZodTypeProvider>();

    typedApp.get(
      '/lexicon',
      {
        schema: {
          querystring: z.object({
            q: z.string().optional(),
            limit: z.coerce.number().min(1).max(200).optional().default(50),
            cursor: z.string().optional(),
          }),
        },
      },
      settingsController.listLexiconEntries
    );

    typedApp.delete(
      '/lexicon/:id',
      {
        schema: {
          params: z.object({
            id: z.string().uuid(),
          }),
        },
      },
      settingsController.deleteLexiconEntry
    );
  });
}

