import { PrismaClient } from '@prisma/client';
import { config } from '../config/env';

// Prevent multiple instances of Prisma Client in development
declare global {
  var prisma: PrismaClient | undefined;
}

const prismaOptions = {
  log: config.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  // Connection pooling is configured via the connection string (e.g. ?connection_limit=10)
  // We use a single instance to avoid DB exhaustion under concurrent load.
};

// @ts-ignore
const prisma = global.prisma || new PrismaClient(prismaOptions);

if (config.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export default prisma;
