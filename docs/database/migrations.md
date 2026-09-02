# Migrations — Idempotency Rules

**This is critical contributor guidance.** Every migration in `backend/prisma/migrations/` MUST be idempotent. Non-idempotent migrations cause `already exists` errors in Postgres logs on every redeploy (and can block boot in edge cases).

## Why Idempotency Is Required

`backend/baseline-migrations.sh` runs the schema sync, compatibility patches, and history
reconciliation on every container startup:

```sh
npx prisma db push --skip-generate                    # authoritative schema sync; failure stops boot
node dist/scripts/applyPostPushPatches.js              # raw constraints + safe data defaults
node dist/scripts/reconcileMigrations.js                # record pending migrations as applied (non-fatal)
```

`prisma db push` is the authoritative step — it diffs `schema.prisma` against the live DB and applies the difference directly, so the schema is already correct before the second step runs. `baseline-migrations.sh` uses `set -eu` and refuses to start the backend when this command fails. It deliberately does **not** pass `--accept-data-loss`; destructive schema drift must be reviewed and applied explicitly rather than silently accepted during a production boot.

Some compatibility changes are not represented by Prisma's schema diff: raw `CHECK` constraints
and data-only repairs. After `db push`, `baseline-migrations.sh` runs
[`src/scripts/applyPostPushPatches.ts`](../../backend/src/scripts/applyPostPushPatches.ts), and
the server applies the same patch set during startup. These patches are static, idempotent, and
fail-closed. The current set keeps `messages.source` aligned with all producers (`game`,
`discord`, `hud`, `relay`, `mcp`, `ws`), repairs only the untouched stock automod rule to
target-gated slur protection, removes only the four exact legacy chat-profanity literal rows
(`fuck`, `shit`, `bastard`, `assh`) once (tracked by a dedicated cleanup marker), and inserts
disabled/shadow AI moderation defaults.

**The second step reconciles migration *history*, it does NOT re-apply migrations.** Because db push already created every object, the old `prisma migrate deploy` would try to replay each migration's SQL, fail with `42P07` (`already exists`), record a *failed* row, and surface `P3009` ("failed migrations") on every subsequent boot. Instead, [`src/scripts/reconcileMigrations.ts`](../../backend/src/scripts/reconcileMigrations.ts) records each pending or previously-failed migration as **applied** (`prisma migrate resolve --applied`) — history bookkeeping only, no schema change. It resolves *only* the pending ones (steady state = 0), so it is a no-op on normal boots and never reintroduces the ~150s cold-start that a resolve-every-migration loop once caused.

Idempotent DDL is still required: it keeps `db push` clean and makes a manual `prisma migrate deploy` (e.g. in local dev) safe against an already-present schema.

## Required Patterns

### Tables and Indexes

Always use `IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS "my_table" ( ... );
CREATE INDEX IF NOT EXISTS "my_idx" ON "my_table"("col");
CREATE UNIQUE INDEX IF NOT EXISTS "my_uniq" ON "my_table"("col");
```

### Columns

```sql
ALTER TABLE "my_table" ADD COLUMN IF NOT EXISTS "new_col" TEXT;
```

### Constraints (no `IF NOT EXISTS` support in Postgres)

Wrap in a `DO $$` block:

```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'my_fkey'
  ) THEN
    ALTER TABLE "foo" ADD CONSTRAINT "my_fkey"
      FOREIGN KEY ("col") REFERENCES "bar"("id") ON DELETE CASCADE;
  END IF;
END $$;
```

### Seed Inserts

Use `ON CONFLICT DO NOTHING` AND include every NOT NULL column (including `updated_at`):

```sql
INSERT INTO "moderation_settings" ("key", "value", "updated_at") VALUES
  ('spam_message_limit', '6', NOW()),
  ('spam_window_ms', '10000', NOW())
ON CONFLICT ("key") DO NOTHING;
```

Omitting a NOT NULL column causes a Postgres error even if the row would be skipped by the conflict clause.

## Real Examples from This Codebase

**Idempotent table + index + seed** (`20260510000000_add_name_blacklist/migration.sql`):
```sql
CREATE TABLE IF NOT EXISTS "name_blacklist" ( ... );
CREATE UNIQUE INDEX IF NOT EXISTS "name_blacklist_pattern_key" ON "name_blacklist"("pattern");
INSERT INTO "name_blacklist" ("pattern", "match_type", "note") VALUES (...)
ON CONFLICT ("pattern") DO NOTHING;
```

**Idempotent table only** (`20260527140000_add_temp_voice_channels/migration.sql`):
```sql
CREATE TABLE IF NOT EXISTS "temp_voice_channels" ( ... );
```

**Older migration (NOT idempotent — for reference, do not copy)** (`20260405000000_add_admin_users/migration.sql`):
```sql
-- Note: no IF NOT EXISTS — this relies on db push having already created the table.
CREATE TABLE "admin_users" ( ... );
CREATE UNIQUE INDEX "admin_users_discord_id_key" ON "admin_users"("discord_id");
```

The older Prisma-generated migrations (before this rule was established) omit `IF NOT EXISTS`. They work because `prisma db push` already applied the schema; the history reconciliation step records them without replaying their SQL. **All new migrations must use the idempotent patterns** to avoid log noise and to be safe for manual `migrate deploy` runs.

## Generating a New Migration

```bash
# From the backend/ directory
npx prisma migrate dev --name describe_the_change
```

Then **manually edit** the generated SQL file to add `IF NOT EXISTS` to every DDL statement before committing. The Prisma generator does not add these guards automatically.

## Migration Directory

Migrations live in `backend/prisma/migrations/`. Each directory is named `YYYYMMDDHHMMSS_description`. The `migration.sql` inside is the raw SQL applied by `migrate deploy`.

Current migration count as of the last audit: 40+ migrations covering schema additions from the initial setup through temp voice channels, Discord embeds, and reaction role panels.
