import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  relayHudCosmetics,
  relayHudCosmeticTransport,
  relayHudEventForClient,
  withoutRelayHudCosmetics,
} from '../relayCosmetics';

describe('relayHudCosmetics', () => {
  test('projects the Overseer tag and selected supporter star colour', () => {
    assert.deepEqual(relayHudCosmetics({
      tag: 'X', badges: ['overseer'], starColor: '#FD4DA6',
      nameColor: '#58FDFD', effectId: 'glitch',
    }), { tag: 'X', supporterStar: true, starColor: '#FD4DA6' });
  });

  test('accepts the supporter tier and rejects an invalid star colour', () => {
    assert.deepEqual(relayHudCosmetics({ badges: ['supporter'], starColor: 'url(evil)' }), {
      supporterStar: true,
    });
  });

  test('does not create a star from arbitrary badge values', () => {
    assert.deepEqual(relayHudCosmetics({ tag: '', badges: ['moderator', 'star'] }), {});
  });
});

test('withoutRelayHudCosmetics removes only additive HUD fields', () => {
  assert.deepEqual(withoutRelayHudCosmetics({
    id: 4, body: 'hello', tag: 'X', supporterStar: true, starColor: '#7EA8F7',
  }), { id: 4, body: 'hello' });
});

test('native HUD transport encodes the validated projection in targetUserId', () => {
  assert.equal(
    relayHudCosmeticTransport({ tag: 'X;Y', supporterStar: true, starColor: '#FD4DA6' }),
    'FCMHUD/1;s=1;c=%23FD4DA6;t=X%3BY',
  );
  assert.equal(relayHudCosmeticTransport({}), '');
});

test('native HUD transport is capability-gated per event', () => {
  const source = {
    id: 5,
    body: 'hello',
    targetUserId: '',
    tag: 'X',
    supporterStar: true as const,
    starColor: '#FD4DA6',
    badges: ['supporter'],
  };
  assert.deepEqual(relayHudEventForClient(source, true), {
    ...source,
    targetUserId: 'FCMHUD/1;s=1;c=%23FD4DA6;t=X',
  });
  assert.deepEqual(relayHudEventForClient(source, false), {
    id: 5,
    body: 'hello',
    targetUserId: '',
    tag: 'X',
    supporterStar: true,
    starColor: '#FD4DA6',
    badges: ['supporter'],
  });
});
