/** Pure tests for the catalog-to-Discord-role contract. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_ROLE_DEFINITIONS,
  EFFECT_ROLE_DEFINITIONS,
  COSMETIC_ROLE_DEFINITIONS,
  buildCosmeticRoleSyncPlan,
  desiredCosmeticRoleNames,
} from '../roleDefinitions';

describe('cosmetic Discord role definitions', () => {
  test('covers every colour and every real effect, but not effect=none', () => {
    assert.equal(COLOR_ROLE_DEFINITIONS.length, 23);
    assert.equal(EFFECT_ROLE_DEFINITIONS.length, 8);
    assert.equal(COSMETIC_ROLE_DEFINITIONS.length, 31);
    assert.ok(!EFFECT_ROLE_DEFINITIONS.some((role) => role.presetId === 'none'));
  });

  test('uses unique, user-facing names across both role families', () => {
    const names = COSMETIC_ROLE_DEFINITIONS.map((role) => role.name.toLowerCase());
    assert.equal(new Set(names).size, names.length);
  });
});

describe('desiredCosmeticRoleNames', () => {
  test('selects exactly one colour role and one selected effect role', () => {
    assert.deepEqual(
      desiredCosmeticRoleNames({ nameColor: '#57DBDB', effectId: 'glow-hard' }),
      ['Cryo', 'Hard Glow'],
    );
  });

  test('does not create an effect role for none or an arbitrary custom colour', () => {
    assert.deepEqual(
      desiredCosmeticRoleNames({ nameColor: '#123456', effectId: 'none' }),
      [],
    );
  });
});

describe('buildCosmeticRoleSyncPlan', () => {
  const roles = [
    { id: 'color-old', name: 'Rose Quartz' },
    { id: 'color-new', name: 'Cryo' },
    { id: 'effect-old', name: 'Soft Glow' },
    { id: 'effect-new', name: 'Hard Glow' },
    { id: 'effect-other', name: 'Glitch' },
    { id: 'managed', name: 'Pulse Glow', managed: true },
  ];

  test('adds only the chosen roles and removes stale roles in their families', () => {
    assert.deepEqual(
      buildCosmeticRoleSyncPlan(
        roles,
        ['color-old', 'effect-old', 'effect-other'],
        ['Cryo', 'Hard Glow'],
      ),
      {
        addRoleIds: ['color-new', 'effect-new'],
        removeRoleIds: ['color-old', 'effect-old', 'effect-other'],
        missingRoleNames: [],
      },
    );
  });

  test('clearing an effect removes all effect roles without touching colour', () => {
    assert.deepEqual(
      buildCosmeticRoleSyncPlan(roles, ['color-old', 'effect-old'], ['Rose Quartz']),
      {
        addRoleIds: [],
        removeRoleIds: ['effect-old'],
        missingRoleNames: [],
      },
    );
  });

  test('does not remove an old family role when the newly selected role is missing', () => {
    assert.deepEqual(
      buildCosmeticRoleSyncPlan(roles, ['color-old', 'effect-old'], ['Rose Quartz', 'Pulse Glow']),
      {
        addRoleIds: [],
        removeRoleIds: [],
        missingRoleNames: ['Pulse Glow'],
      },
    );
  });
});
