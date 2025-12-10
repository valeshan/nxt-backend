import { PrismaClient } from '@prisma/client';
import { config } from '../config/env';

// Prevent multiple instances of Prisma Client in development
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const prisma =
  // @ts-ignore
  global.prisma ||
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' }, // 🔥 always emit query events
      'error',
      'warn',
    ],
  });

// 🔍 Always log timing for now
prisma.$on('query', (e) => {
  console.log(
    `[PRISMA] ${e.duration} ms\n${e.query}\nparams: ${e.params}\n`
  );
});

if (config.NODE_ENV !== 'production') {
  // @ts-ignore
  global.prisma = prisma;
}

export default prisma;