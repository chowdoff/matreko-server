import { PrismaClient } from '@prisma/client';
import { env } from '@/config/env';

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: env.isDev ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.isDev) {
  global.prisma = prisma;
}
