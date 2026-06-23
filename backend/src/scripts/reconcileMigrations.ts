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
 * Decide the reconcile work. Pure.
 *  - `toInsert`: migrations on disk with no row in the table yet (INSERT as applied).
 *  - `failedCount`: EVERY not-applied row in the table (finished_at IS NULL or
 *    rolled_back_at set). Counted table-wide — not just the on-disk subset —
 *    because a migration can fail and later be removed from disk, leaving an
 *    orphaned failed row that still emits P3009 and must be marked applied.
 */
export function planReconcile(
  onDisk: DiskMigration[],
  rows: Array<{ migration_name: string; applied: boolean }>,
): { toInsert: DiskMigration[]; failedCount: number } {
  const present = new Set(rows.map((r) => r.migration_name));
  const toInsert = onDisk.filter((m) => !present.has(m.name));
  const failedCount = rows.reduce((n, r) => (r.applied ? n : n + 1), 0);
  return { toInsert, failedCount };
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
    // Some environments are managed purely by `prisma db push` and never ran
    // `migrate deploy`, so the _prisma_migrations table simply does not exist
    // (e.g. the hosted dev stack). There is no history to reconcile there.
    const reg = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists",
    );
    if (!reg[0]?.exists) {
      console.log('[reconcile] no _prisma_migrations table (schema is db-push-managed) — nothing to reconcile');
      return;
    }

    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string; applied: boolean }>>(
      'SELECT migration_name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied FROM _prisma_migrations',
    );
    const { toInsert, failedCount } = planReconcile(onDisk, rows);

    if (toInsert.length === 0 && failedCount === 0) {
      console.log(`[reconcile] all ${onDisk.length} migrations applied, no failed rows — no-op`);
      return;
    }

    if (failedCount > 0) {
      // Existing failed/unfinished rows already carry the correct checksum — just
      // mark them applied (clears P3009). Targets the table directly so orphaned
      // (no-longer-on-disk) failed rows are fixed too, not only the on-disk set.
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
      console.warn('[reconcile] non-fatal:', err?.message || String(err));
      process.exit(0);
    });
}
