/** Tests for the bounded Discord cosmetics retry policy. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRetryableDiscordRoleSyncError,
  retryDiscordRoleSync,
} from '../discordRoleSyncService';

describe('Discord cosmetics retry policy', () => {
  test('retries transient failures and resolves once Discord recovers', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await retryDiscordRoleSync(async () => {
      attempts += 1;
      if (attempts < 3) throw { status: 503 };
      return 'synced';
    }, {
      delaysMs: [0, 25, 50],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
    });

    assert.equal(result, 'synced');
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [25, 50]);
  });

  test('does not retry permanent permission or missing-resource failures', async () => {
    assert.equal(isRetryableDiscordRoleSyncError({ status: 403 }), false);
    assert.equal(isRetryableDiscordRoleSyncError({ code: 50013 }), false);
    assert.equal(isRetryableDiscordRoleSyncError({ code: 10007 }), false);

    let attempts = 0;
    await assert.rejects(
      retryDiscordRoleSync(async () => {
        attempts += 1;
        throw { status: 403 };
      }, { delaysMs: [0, 25, 50], sleep: async () => undefined }),
      (error: unknown) => (error as { status?: number }).status === 403,
    );
    assert.equal(attempts, 1);
  });
});
