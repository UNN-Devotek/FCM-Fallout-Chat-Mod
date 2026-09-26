import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPostPushPatches, POST_PUSH_PATCHES } from '../applyPostPushPatches';

test('post-push patch set is static, ordered, and complete', () => {
  assert.deepEqual(
    POST_PUSH_PATCHES.map((patch) => patch.name),
    [
      'required-pg-trgm-extension',
      'messages-source-check',
      'default-targeted-automod-policy',
      'ai-moderation-safe-defaults',
      'remove-legacy-broad-chat-profanity-filters',
      'embed-assets-normalize-status',
      'embed-assets-remove-invalid-pending',
      'embed-assets-clear-ready-leases',
      'embed-assets-status-constraint',
      'embed-assets-pending-lease-constraint',
      'mcp-oauth-s256-constraint',
      'mcp-oauth-code-scopes-constraint',
      'mcp-oauth-grant-scopes-constraint',
      'restore-missing-event-commands',
    ],
  );

  assert.match(POST_PUSH_PATCHES[0].sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  const sourceSql = POST_PUSH_PATCHES[1].sql;
  for (const source of ['game', 'discord', 'hud', 'relay', 'mcp', 'ws', 'bot']) {
    assert.match(sourceSql, new RegExp(`'${source}'`));
  }
  assert.match(sourceSql, /position\('bot' IN definition\) = 0/);
  assert.match(POST_PUSH_PATCHES[2].sql, /require_target/);
  assert.match(POST_PUSH_PATCHES[3].sql, /ON CONFLICT/);
  assert.match(POST_PUSH_PATCHES[4].sql, /fuck/);
  assert.match(POST_PUSH_PATCHES[4].sql, /assh/);
  assert.match(POST_PUSH_PATCHES[4].sql, /chat_profanity_literal_cleanup_v1/);
  for (const constraint of [
    'embed_assets_status_check',
    'embed_assets_pending_lease_check',
  ]) {
    assert.ok(POST_PUSH_PATCHES.some((patch) => new RegExp(constraint).test(patch.sql)));
  }
  for (const constraint of [
    'mcp_oauth_codes_s256_check',
    'mcp_oauth_codes_scopes_check',
    'mcp_oauth_grants_scopes_check',
  ]) {
    assert.ok(POST_PUSH_PATCHES.some((patch) => new RegExp(constraint).test(patch.sql)));
  }
  const migration = readFileSync(join(process.cwd(),
    'prisma/migrations/20260926000000_restore_missing_event_commands/migration.sql'), 'utf8');
  const seed = POST_PUSH_PATCHES.find((patch) => patch.name === 'restore-missing-event-commands');
  assert.equal(seed?.sql.trim(), migration.slice(migration.indexOf('INSERT INTO chat_commands')).trim());
});

test('bot giveaway announcements are accepted by the idempotent migration', () => {
  const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20260925193000_allow_bot_message_source/migration.sql'), 'utf8');
  assert.match(sql, /position\('bot' IN definition\) = 0/);
  for (const source of ['game', 'discord', 'hud', 'relay', 'mcp', 'ws', 'bot']) {
    assert.match(sql, new RegExp(`'${source}'::text`));
  }
});

test('applyPostPushPatches executes every patch exactly once', async () => {
  const executed: string[] = [];
  await applyPostPushPatches({
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql);
    },
  });

  assert.deepEqual(executed, POST_PUSH_PATCHES.map((patch) => patch.sql));
});
