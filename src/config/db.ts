import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

/**
 * Keep each server instance's connection pool small. Supabase's session pooler only allows ~15 clients in
 * total, and a deploy briefly runs two instances at once. An explicit `connection_limit` in DATABASE_URL wins.
 */
const withPoolLimit = (url: string | undefined): string | undefined => {
  if (!url || /[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=3`;
};

export const prisma = new PrismaClient({
  datasourceUrl: withPoolLimit(process.env.DATABASE_URL),
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'stdout', level: 'info' },
    { emit: 'stdout', level: 'warn' },
    { emit: 'stdout', level: 'error' },
  ],
});

// Log prisma queries through winston logger
(prisma as any).$on('query', (e: any) => {
  logger.info(`Prisma SQL: ${e.query} | Params: ${e.params} | Duration: ${e.duration}ms`);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects with retries. If the database is briefly out of connections (e.g. during a deploy while the
 * old instance is still shutting down) we wait and try again instead of crash-looping and hammering it.
 */
export const connectDB = async (): Promise<void> => {
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.$connect();
      logger.info('📡 PostgreSQL Connected successfully via Prisma.');
      return;
    } catch (error) {
      logger.error(`❌ PostgreSQL connection failed (attempt ${attempt}/${maxAttempts}): ${(error as Error).message.split(String.fromCharCode(10)).pop()}`);
      if (attempt === maxAttempts) {
        process.exit(1);
      }
      await sleep(Math.min(5_000 * attempt, 30_000));
    }
  }
};

export const disconnectDB = async (): Promise<void> => {
  try {
    await prisma.$disconnect();
  } catch {
    /* already closed */
  }
};
