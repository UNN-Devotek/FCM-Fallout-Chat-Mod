import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import { existsSync } from 'node:fs';

// Startup scripts run in their own process without the application's env module.
// Prisma 7 no longer loads these files on the client's behalf.
dotenv.config({ quiet: true });
if (existsSync('.env.local')) dotenv.config({ path: '.env.local', override: true, quiet: true });

/** One adapter contract for the application, startup patches and maintainer tools. */
export function createPrismaClient(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for Prisma');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  }, { schema: url.searchParams.get('schema') || 'public' });
  return new PrismaClient({ adapter });
}
