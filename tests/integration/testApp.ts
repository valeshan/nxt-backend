import { buildApp } from '../../src/app';
import prisma from '../../src/infrastructure/prismaClient';

export async function buildTestApp() {
  const app = buildApp();
  await app.ready();
  return app;
}

export async function resetDb() {
  // Truncate all tables (order matters due to foreign keys)
  // Deleting userSettings first because it references user
  await prisma.userSettings.deleteMany();
  
  await prisma.xeroLocationLink.deleteMany();
  await prisma.xeroConnection.deleteMany();
  
  await prisma.userOrganisation.deleteMany();
  await prisma.location.deleteMany();
  await prisma.organisation.deleteMany();
  
  // User must be last if referenced by others (which it is by UserSettings, UserOrganisation)
  await prisma.user.deleteMany();
}

export async function teardown() {
  await prisma.$disconnect();
}
