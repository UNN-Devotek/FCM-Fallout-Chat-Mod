import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  relayMissedPongLimit,
  shouldReapSubscriber,
  supersededSubscriptions,
  relayEvictIdleMs,
  evictableRelaySlot,
} from '../relaySubscriberLiveness';

describe('relay subscriber liveness', () => {
  test('missed-pong limit defaults to 8 and rejects malformed values', () => {
    assert.equal(relayMissedPongLimit(undefined), 8);
    assert.equal(relayMissedPongLimit('3'), 3);
    assert.equal(relayMissedPongLimit('0'), 0);
    assert.equal(relayMissedPongLimit('-1'), 8);
    assert.equal(relayMissedPongLimit('abc'), 8);
    assert.equal(relayMissedPongLimit('2.5'), 8);
  });

  test('only a socket that answered pings and then stopped is reaped', () => {
    assert.equal(shouldReapSubscriber(true, 8, 8), true);
    assert.equal(shouldReapSubscriber(true, 7, 8), false, 'still inside the window');
    assert.equal(shouldReapSubscriber(false, 100, 8), false, 'client stack that never answers pings');
    assert.equal(shouldReapSubscriber(true, 100, 0), false, 'disabled');
  });

  test('a new subscription replaces only older ones of the same identity', () => {
    const current = { userId: 'user_a', id: 3 };
    const all = [{ userId: 'user_a', id: 1 }, { userId: 'user_b', id: 2 }, current, { userId: 'user_a', id: 4 }];
    assert.deepEqual(supersededSubscriptions(current, all).map(s => s.id), [1, 4]);
    assert.deepEqual(supersededSubscriptions(current, [current]), []);
  });

  test('eviction idle window defaults to 30 s and rejects malformed values', () => {
    assert.equal(relayEvictIdleMs(undefined), 30_000);
    assert.equal(relayEvictIdleMs('500'), 500);
    assert.equal(relayEvictIdleMs('0'), 0);
    assert.equal(relayEvictIdleMs('-5'), 30_000);
    assert.equal(relayEvictIdleMs('soon'), 30_000);
  });

  test('a full IP gives up only its longest-silent slot, and never a live one', () => {
    const now = 100_000;
    const slots = [
      { id: 'live', lastActivityAt: now - 1_000 },
      { id: 'silent', lastActivityAt: now - 40_000 },
      { id: 'oldest', lastActivityAt: now - 90_000 },
    ];
    assert.equal(evictableRelaySlot(slots, now, 30_000)?.id, 'oldest');
    assert.equal(evictableRelaySlot([slots[0]], now, 30_000), null, 'all slots live');
    assert.equal(evictableRelaySlot(slots, now, 0), null, 'disabled');
    assert.equal(evictableRelaySlot([], now, 30_000), null);
  });
});
