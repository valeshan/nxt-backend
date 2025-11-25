import prisma from '../infrastructure/prismaClient';
import { UserSettings, Prisma } from '@prisma/client';

export const userSettingsRepository = {
  async createDefaultForUser(userId: string): Promise<UserSettings> {
    return prisma.userSettings.create({
      data: {
        userId,
        // Defaults are handled by schema
      },
    });
  },

  async getForUser(userId: string): Promise<UserSettings | null> {
    return prisma.userSettings.findUnique({
      where: { userId },
    });
  },

  async upsertForUser(userId: string, data: Partial<Prisma.UserSettingsCreateInput>): Promise<UserSettings> {
    return prisma.userSettings.upsert({
      where: { userId },
      create: {
        userId,
        ...data,
      } as Prisma.UserSettingsCreateInput,
      update: data,
    });
  }
};

