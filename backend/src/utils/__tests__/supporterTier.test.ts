/**
 * Pure supporter-tier rules. Runs under node:test via src/testRunner.ts (npm run
 * test:unit) — no Prisma, no Redis, no Discord.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSupporterTier,
  normalizeTier,
  tierAtLeast,
  tierLabel,
  nameCooldownMs,
  nameCooldownRemainingMs,
  privilegesActive,
  TIER_ORDER,
} from '../supporterTier';

const ROLES = { supporterRoleId: 'ROLE_SUP', overseerCircleRoleId: 'ROLE_OVR' };

describe('resolveSupporterTier', () => {
  test('returns none for empty / missing role lists', () => {
    assert.equal(resolveSupporterTier([], ROLES), 'none');
    assert.equal(resolveSupporterTier(null, ROLES), 'none');
    assert.equal(resolveSupporterTier(undefined, ROLES), 'none');
  });

  test('matches the supporter and overseer roles', () => {
    assert.equal(resolveSupporterTier(['ROLE_SUP'], ROLES), 'supporter');
    assert.equal(resolveSupporterTier(['ROLE_OVR'], ROLES), 'overseer');
  });

  test('highest tier wins when a member holds both', () => {
    assert.equal(resolveSupporterTier(['ROLE_SUP', 'ROLE_OVR'], ROLES), 'overseer');
    assert.equal(resolveSupporterTier(['ROLE_OVR', 'ROLE_SUP'], ROLES), 'overseer');
  });

  test('unrelated roles never grant a tier', () => {
    assert.equal(resolveSupporterTier(['ROLE_MOD', 'ROLE_ADMIN'], ROLES), 'none');
  });

  test('an unconfigured role id must NOT match — a half-configured env grants nothing', () => {
    // The dangerous failure would be an empty env var matching an empty entry in the
    // member's role array and handing the paid tier to everyone.
    assert.equal(resolveSupporterTier([''], { supporterRoleId: '', overseerCircleRoleId: '' }), 'none');
    assert.equal(resolveSupporterTier([''], { supporterRoleId: null, overseerCircleRoleId: undefined }), 'none');
    assert.equal(
      resolveSupporterTier(['ROLE_SUP'], { supporterRoleId: '', overseerCircleRoleId: '' }),
      'none',
    );
  });

  test('overseer still resolves when only the supporter role is unconfigured', () => {
    assert.equal(
      resolveSupporterTier(['ROLE_OVR'], { supporterRoleId: '', overseerCircleRoleId: 'ROLE_OVR' }),
      'overseer',
    );
  });
});

describe('normalizeTier', () => {
  test('accepts known tiers, case- and whitespace-insensitively', () => {
    assert.equal(normalizeTier('supporter'), 'supporter');
    assert.equal(normalizeTier('  OVERSEER '), 'overseer');
    assert.equal(normalizeTier('None'), 'none');
  });

  test('collapses anything unknown to none', () => {
    assert.equal(normalizeTier('admin'), 'none');
    assert.equal(normalizeTier(''), 'none');
    assert.equal(normalizeTier(null), 'none');
    assert.equal(normalizeTier(undefined), 'none');
    assert.equal(normalizeTier('supporter; DROP TABLE'), 'none');
  });
});

describe('tierAtLeast', () => {
  test('is reflexive', () => {
    for (const t of TIER_ORDER) assert.equal(tierAtLeast(t, t), true);
  });

  test('higher tiers satisfy lower requirements', () => {
    assert.equal(tierAtLeast('overseer', 'supporter'), true);
    assert.equal(tierAtLeast('overseer', 'none'), true);
    assert.equal(tierAtLeast('supporter', 'none'), true);
  });

  test('lower tiers do not satisfy higher requirements', () => {
    assert.equal(tierAtLeast('none', 'supporter'), false);
    assert.equal(tierAtLeast('none', 'overseer'), false);
    assert.equal(tierAtLeast('supporter', 'overseer'), false);
  });
});

describe('tierLabel', () => {
  test('gives user-facing names', () => {
    assert.equal(tierLabel('none'), 'Vault Dweller');
    assert.equal(tierLabel('supporter'), 'Supporter');
    assert.equal(tierLabel('overseer'), "Overseer's Circle");
  });
});

describe('name change cooldown', () => {
  const DAY = 24 * 60 * 60 * 1000;

  test('is 30d free, 7d supporter, 24h overseer', () => {
    assert.equal(nameCooldownMs('none'), 30 * DAY);
    assert.equal(nameCooldownMs('supporter'), 7 * DAY);
    assert.equal(nameCooldownMs('overseer'), DAY);
  });

  test('a user who never changed their name is not on cooldown', () => {
    assert.equal(nameCooldownRemainingMs(null, 'none', 1_000_000), 0);
    assert.equal(nameCooldownRemainingMs(undefined, 'none', 1_000_000), 0);
  });

  test('reports the remaining time mid-cooldown', () => {
    const now = 100 * DAY;
    const changedAt = new Date(now - 2 * DAY);
    assert.equal(nameCooldownRemainingMs(changedAt, 'supporter', now), 5 * DAY);
    // Overseer's 24h window has already elapsed for the same timestamp.
    assert.equal(nameCooldownRemainingMs(changedAt, 'overseer', now), 0);
  });

  test('returns 0 exactly at the boundary', () => {
    const now = 100 * DAY;
    assert.equal(nameCooldownRemainingMs(new Date(now - 7 * DAY), 'supporter', now), 0);
  });

  test('accepts an ISO string and ignores an unparseable value', () => {
    const now = Date.parse('2026-08-06T00:00:00.000Z');
    const changed = '2026-08-05T00:00:00.000Z';
    assert.equal(nameCooldownRemainingMs(changed, 'overseer', now), 0);
    assert.equal(nameCooldownRemainingMs('not-a-date', 'none', now), 0);
  });

  test('upgrading tier shortens an in-flight cooldown', () => {
    const now = 100 * DAY;
    const changedAt = new Date(now - 10 * DAY);
    assert.ok(nameCooldownRemainingMs(changedAt, 'none', now) > 0); // still waiting on free
    assert.equal(nameCooldownRemainingMs(changedAt, 'supporter', now), 0); // supporter is free to change
  });
});

describe('privilegesActive', () => {
  test('only an active entitlement grants privileges', () => {
    assert.equal(privilegesActive('active'), true);
    assert.equal(privilegesActive('lapsed'), false);
    assert.equal(privilegesActive('cancelled'), false);
    assert.equal(privilegesActive(null), false);
    assert.equal(privilegesActive(undefined), false);
    assert.equal(privilegesActive('ACTIVE'), false); // status is stored lowercase
  });
});
