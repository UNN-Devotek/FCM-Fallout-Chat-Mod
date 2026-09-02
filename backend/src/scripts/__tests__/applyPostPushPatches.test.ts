import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPostPushPatches, POST_PUSH_PATCHES } from '../applyPostPushPatches';

test('post-push patch set is static, ordered, and complete', () => {
  assert.deepEqual(
    POST_PUSH_PATCHES.map((patch) => patch.name),
    [
      'messages-source-check',
      'default-targeted-automod-policy',
      'ai-moderation-safe-defaults',
      'remove-legacy-broad-chat-profanity-filters',
    ],
  );

  const sourceSql = POST_PUSH_PATCHES[0].sql;
  for (const source of ['game', 'discord', 'hud', 'relay', 'mcp', 'ws']) {
    assert.match(sourceSql, new RegExp(`'${source}'`));
  }
  assert.match(POST_PUSH_PATCHES[1].sql, /require_target/);
  assert.match(POST_PUSH_PATCHES[2].sql, /ON CONFLICT/);
  assert.match(POST_PUSH_PATCHES[3].sql, /fuck/);
  assert.match(POST_PUSH_PATCHES[3].sql, /assh/);
  assert.match(POST_PUSH_PATCHES[3].sql, /chat_profanity_literal_cleanup_v1/);
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
