/**
 * Compatibility patches that must run after `prisma db push`.
 *
 * The hosted deployment intentionally treats db push as authoritative and
 * records migration history without replaying old SQL. That means raw SQL
 * constraints and data-only migrations need one explicit, idempotent home.
 * Keep this list small, static, and safe to run on every boot.
 */

export interface PostPushPatchClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export const POST_PUSH_PATCHES = [
  {
    // Prisma's schema DSL cannot express PostgreSQL extensions. Keep required
    // extensions here because baseline deployments reconcile migration history
    // instead of replaying raw-SQL migrations on every database.
    name: 'required-pg-trgm-extension',
    sql: 'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
  },
  {
    name: 'messages-source-check',
    sql: `
DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'messages'
     AND c.conname = 'messages_source_check';

  IF definition IS NULL OR position('game' IN definition) = 0
                         OR position('discord' IN definition) = 0
                         OR position('hud' IN definition) = 0
                         OR position('relay' IN definition) = 0
                         OR position('mcp' IN definition) = 0
                         OR position('ws' IN definition) = 0
                         OR position('bot' IN definition) = 0 THEN
    IF definition IS NOT NULL THEN
      ALTER TABLE messages DROP CONSTRAINT messages_source_check;
    END IF;

    ALTER TABLE messages
      ADD CONSTRAINT messages_source_check
      CHECK (source = ANY (ARRAY[
        'game'::text,
        'discord'::text,
        'hud'::text,
        'relay'::text,
        'mcp'::text,
        'ws'::text,
        'bot'::text
      ]));
  END IF;
END $$;`,
  },
  {
    name: 'default-targeted-automod-policy',
    sql: `
UPDATE "automod_rules"
   SET "trigger_metadata" = '{"presets":["SLURS"],"require_target":true}'::jsonb
 WHERE "id" = 'a0000000-0000-0000-0000-000000000002'
   AND "trigger_type" = 'KEYWORD_PRESET'
   AND COALESCE("trigger_metadata", '{}'::jsonb) IN (
         '{"presets":["PROFANITY","SEXUAL_CONTENT","SLURS"],"allow_list":["ass","damn","fuck","hell","shit"]}'::jsonb,
         '{"presets":["SEXUAL_CONTENT","SLURS"]}'::jsonb
       );`,
  },
  {
    name: 'ai-moderation-safe-defaults',
    sql: `
INSERT INTO "moderation_settings" ("key", "value", "updated_at")
VALUES
  ('ai_moderation_enabled', 'false', NOW()),
  ('ai_moderation_mode', 'shadow', NOW())
ON CONFLICT ("key") DO NOTHING;`,
  },
  {
    name: 'remove-legacy-broad-chat-profanity-filters',
    sql: `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "moderation_settings"
     WHERE "key" = 'chat_profanity_literal_cleanup_v1'
  ) THEN
    DELETE FROM "word_filter"
     WHERE NOT "is_regex"
       AND lower("phrase") IN ('fuck', 'shit', 'bastard', 'assh');

    INSERT INTO "moderation_settings" ("key", "value", "updated_at")
    VALUES ('chat_profanity_literal_cleanup_v1', 'applied', NOW())
    ON CONFLICT ("key") DO NOTHING;
  END IF;
END $$;`,
  },
  {
    name: 'embed-assets-normalize-status',
    sql: `
UPDATE "embed_assets" SET "status" = 'ready' WHERE "status" NOT IN ('pending', 'ready');`,
  },
  {
    name: 'embed-assets-remove-invalid-pending',
    sql: `DELETE FROM "embed_assets" WHERE "status" = 'pending' AND ("claim_token" IS NULL OR "lease_expires_at" IS NULL);`,
  },
  {
    name: 'embed-assets-clear-ready-leases',
    sql: `UPDATE "embed_assets" SET "claim_token" = NULL, "lease_expires_at" = NULL WHERE "status" = 'ready';`,
  },
  {
    name: 'embed-assets-status-constraint',
    sql: `DO $$ BEGIN
  ALTER TABLE "embed_assets" ADD CONSTRAINT "embed_assets_status_check"
    CHECK ("status" IN ('pending', 'ready'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
  },
  {
    name: 'embed-assets-pending-lease-constraint',
    sql: `DO $$ BEGIN
  ALTER TABLE "embed_assets" ADD CONSTRAINT "embed_assets_pending_lease_check" CHECK (
    ("status" = 'pending' AND "claim_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR ("status" = 'ready' AND "claim_token" IS NULL AND "lease_expires_at" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
  },
  {
    name: 'mcp-oauth-s256-constraint',
    sql: `DO $$ BEGIN
  ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_s256_check"
    CHECK ("code_challenge_method" = 'S256');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
  },
  {
    name: 'mcp-oauth-code-scopes-constraint',
    sql: `DO $$ BEGIN
  ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_scopes_check"
    CHECK ("scopes" <@ ARRAY['fcm:read','fcm:discord:write','fcm:moderation:write']::TEXT[]);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
  },
  {
    name: 'mcp-oauth-grant-scopes-constraint',
    sql: `DO $$ BEGIN
  ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_scopes_check"
    CHECK ("scopes" <@ ARRAY['fcm:read','fcm:discord:write','fcm:moderation:write']::TEXT[]);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
  },
] as const;

export async function applyPostPushPatches(client: PostPushPatchClient): Promise<void> {
  for (const patch of POST_PUSH_PATCHES) {
    await client.$executeRawUnsafe(patch.sql);
  }
}

async function main(): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await applyPostPushPatches(prisma);
    console.log(`[post-push] applied ${POST_PUSH_PATCHES.length} idempotent compatibility patch(es)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[post-push] fatal:', err?.message || String(err));
    process.exit(1);
  });
}
