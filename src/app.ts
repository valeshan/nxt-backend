import Fastify, { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import xeroRoutes from './routes/xeroRoutes';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  // Setup Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register Routes
  app.register(xeroRoutes);

  // Health Check
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    if (error.validation) {
       return reply.status(400).send({
         error: {
           code: 'VALIDATION_ERROR',
           message: 'Invalid request data',
           details: error.validation
         }
       });
    }

    // If the error was explicitly thrown with a status code (like 401/403 from our logic)
    if (reply.statusCode && reply.statusCode >= 400 && reply.statusCode < 500) {
        // If response is already sent or set, we might just return.
        // But here we format the error.
        // If the error object already has the shape { error: { ... } } we should return it.
        // However, standard Error objects don't.
        // Our controller/plugins might send response directly.
    }

    const statusCode = error.statusCode || 500;
    const code = (error as any).code || 'INTERNAL_ERROR';
    const message = error.message || 'Something went wrong';

    return reply.status(statusCode).send({
      error: {
        code,
        message,
      },
    });
  });

  return app;
}

