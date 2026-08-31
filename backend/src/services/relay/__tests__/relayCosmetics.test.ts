import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { relayHudCosmetics, withoutRelayHudCosmetics } from '../relayCosmetics';

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
