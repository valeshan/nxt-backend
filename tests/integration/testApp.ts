import { buildApp } from '../../src/app';
import prisma from '../../src/infrastructure/prismaClient';

export async function buildTestApp() {
  const app = buildApp();
  await app.ready();
  return app;
}

export async function resetDb() {
  // Truncate all tables
  await prisma.xeroLocationLink.deleteMany();
  await prisma.xeroConnection.deleteMany();
}

export async function teardown() {
  await prisma.$disconnect();
}

