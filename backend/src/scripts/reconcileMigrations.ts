/**
 * Reconcile Prisma migration history WITHOUT re-applying schema.
 *
 * `baseline-migrations.sh` runs `prisma db push` first, which is AUTHORITATIVE
 * for the schema — every table/column already exists by the time this runs.
 * This script only repairs the `_prisma_migrations` BOOKKEEPING so that
 * `prisma migrate status` / `migrate deploy` stay clean and never emit P3009
 * ("failed migrations"):
 *
 *   - a migration present on disk but ABSENT from the table  -> INSERT as applied
 *   - a migration recorded as FAILED (finished_at IS NULL, or
 *     rolled_back_at IS NOT NULL)                            -> UPDATE to applied
 *
 * Nothing is re-run and the schema is left untouched. Steady state = 0 changes
 * (pure no-op). It is implemented as ONE read + batched writes — NOT the prisma
 * CLI once per migration, which is what caused the old ~150s cold-start restart
 * loop (see baseline-migrations.sh). Invoked non-fatally (`|| true`) on boot.
 *
 * Prisma's stored checksum is `sha256(migration.sql)` in lowercase hex — verified
 * against live `_prisma_migrations` rows.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

export interface DiskMigration {
  name: string;
  checksum: string;
}

/** Read migration dirs (those with a migration.sql) + compute their Prisma checksums. */
export function readMigrations(dir: string): DiskMigration[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'migration.sql')))
    .map((d) => ({
      name: d.name,
      checksum: createHash('sha256')
        .update(readFileSync(path.join(dir, d.name, 'migration.sql')))
        .digest('hex'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Split the on-disk migrations into those that need an INSERT (no row yet) vs a
 * mark-as-applied UPDATE (row exists but is not successfully applied). Pure.
 */
export function planReconcile(
  onDisk: DiskMigration[],
  present: Set<string>,
  appliedOk: Set<string>,
): { toInsert: DiskMigration[]; toFix: string[] } {
  const toInsert: DiskMigration[] = [];
  const toFix: string[] = [];
  for (const m of onDisk) {
    if (!present.has(m.name)) toInsert.push(m);
    else if (!appliedOk.has(m.name)) toFix.push(m.name);
  }
  return { toInsert, toFix };
}

async function main(): Promise<void> {
  const dir = path.resolve(process.cwd(), 'prisma/migrations');
  const onDisk = readMigrations(dir);
  if (onDisk.length === 0) {
    console.log('[reconcile] no migrations on disk — nothing to do');
    return;
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string; applied: boolean }>>(
      'SELECT migration_name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied FROM _prisma_migrations',
    );
    const present = new Set(rows.map((r) => r.migration_name));
    const appliedOk = new Set(rows.filter((r) => r.applied).map((r) => r.migration_name));
    const { toInsert, toFix } = planReconcile(onDisk, present, appliedOk);

    if (toInsert.length === 0 && toFix.length === 0) {
      console.log(`[reconcile] all ${onDisk.length} migrations already applied — no-op`);
      return;
    }

    if (toFix.length > 0) {
      // Failed/unfinished rows already carry the correct checksum — just mark
      // them applied (clears P3009). Targets exactly the not-applied rows.
      const fixed = await prisma.$executeRawUnsafe(
        'UPDATE _prisma_migrations SET finished_at = now(), rolled_back_at = NULL, logs = NULL, applied_steps_count = 1 WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL',
      );
      console.log(`[reconcile] marked ${fixed} failed/unfinished migration(s) as applied`);
    }

    for (const m of toInsert) {
      await prisma.$executeRawUnsafe(
        'INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), now(), 1)',
        randomUUID(),
        m.checksum,
        m.name,
      );
    }
    if (toInsert.length > 0) {
      console.log(`[reconcile] recorded ${toInsert.length} pending migration(s) as applied: ${toInsert.map((m) => m.name).join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (not when imported by the unit test).
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.warn('[reconcile] non-fatal:', err?.message ?? err);
      process.exit(0);
    });
}
