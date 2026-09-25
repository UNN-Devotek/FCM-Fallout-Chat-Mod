import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { executeGiveawayButton, parseGiveawayButtonId, type GiveawayButtonService } from '../giveawayButtonAction';

describe('Discord giveaway buttons', () => {
  test('only bounded giveaway IDs are accepted', () => {
    assert.deepEqual(parseGiveawayButtonId('fcm:giveaway:join:ABC234'), { action: 'join', shortId: 'ABC234' });
    assert.equal(parseGiveawayButtonId('fcm:giveaway:join:ABC234:extra'), null);
    assert.equal(parseGiveawayButtonId('fcm:giveaway:join:O0I123'), null);
  });

  test('actions use linked account identity and carry moderator authority only for stop', async () => {
    const calls: unknown[] = [];
    const service: GiveawayButtonService = {
      async joinGiveaway(...args) { calls.push(['join', ...args]); return { entryCount: 2 }; },
      async leaveGiveaway(...args) { calls.push(['leave', ...args]); return { entryCount: 1 }; },
      async cancelGiveaway(...args) { calls.push(['stop', ...args]); },
    };
    const user = { id: 'linked-user', displayName: 'Wastelander', isMod: true };
    assert.match(await executeGiveawayButton({ action: 'join', shortId: 'ABC234' }, user, service), /Entries: 2/);
    assert.match(await executeGiveawayButton({ action: 'leave', shortId: 'ABC234' }, user, service), /Entries: 1/);
    assert.match(await executeGiveawayButton({ action: 'stop', shortId: 'ABC234' }, user, service), /cancelled/);
    assert.deepEqual(calls, [
      ['join', 'ABC234', 'linked-user', 'Wastelander'],
      ['leave', 'ABC234', 'linked-user'],
      ['stop', 'ABC234', 'linked-user', true],
    ]);
  });
});
