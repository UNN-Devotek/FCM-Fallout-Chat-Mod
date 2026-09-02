/**
 * Pure supporter-tier rules. Runs under node:test via src/testRunner.ts (npm run
 * test:unit) — no Prisma, no Redis, no Discord.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSupporterTier,
  hasConfiguredCosmeticsRole,
  normalizeTier,
  tierAtLeast,
  tierLabel,
  privilegesActive,
  TIER_ORDER,
} from '../supporterTier';

const ROLES = {
  supporterRoleId: 'ROLE_SUP',
  overseerCircleRoleId: 'ROLE_OVR',
  adminRoleId: 'ROLE_ADMIN',
};

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

  test('the configured admin role receives the full overseer cosmetics tier', () => {
    assert.equal(resolveSupporterTier(['ROLE_ADMIN'], ROLES), 'overseer');
    assert.equal(resolveSupporterTier(['ROLE_ADMIN', 'ROLE_SUP'], ROLES), 'overseer');
    assert.equal(hasConfiguredCosmeticsRole(['ROLE_ADMIN'], ROLES), true);
  });

  test('unrelated roles never grant a tier', () => {
    assert.equal(resolveSupporterTier(['ROLE_MOD', 'ROLE_OTHER'], ROLES), 'none');
  });

  test('an unconfigured role id must NOT match — a half-configured env grants nothing', () => {
    // The dangerous failure would be an empty env var matching an empty entry in the
    // member's role array and handing the paid tier to everyone.
    assert.equal(resolveSupporterTier([''], { supporterRoleId: '', overseerCircleRoleId: '', adminRoleId: '' }), 'none');
    assert.equal(resolveSupporterTier([''], { supporterRoleId: null, overseerCircleRoleId: undefined, adminRoleId: null }), 'none');
    assert.equal(
      resolveSupporterTier(['ROLE_SUP'], { supporterRoleId: '', overseerCircleRoleId: '', adminRoleId: '' }),
      'none',
    );
    assert.equal(
      resolveSupporterTier(['ROLE_ADMIN'], { supporterRoleId: '', overseerCircleRoleId: '', adminRoleId: '' }),
      'none',
    );
  });

  test('overseer still resolves when only the supporter role is unconfigured', () => {
    assert.equal(
      resolveSupporterTier(['ROLE_OVR'], { supporterRoleId: '', overseerCircleRoleId: 'ROLE_OVR', adminRoleId: '' }),
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
