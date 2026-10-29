import * as dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Match application precedence. Generation can run without database access;
// commands that connect still require DATABASE_URL.
dotenv.config({ quiet: true });
if (existsSync('.env.local')) dotenv.config({ path: '.env.local', override: true, quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
