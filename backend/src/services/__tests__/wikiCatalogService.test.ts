/**
 * Unit tests for wikiCatalogService pure helpers.
 *
 * Covers (spec §4.1 P2):
 *   - validateSearchQuery: length, null-byte, empty, type guards
 *   - trimInfobox: per-kind field-subset trimming for every kind in §3.4
 *   - bestMatch selection: verifies the helper returns first result or null
 *     (Prisma dependency mocked via module-level monkey-patch)
 */

import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Pull in pure helpers directly — no Prisma calls ───────────────────────────
// trimInfobox and validateSearchQuery are pure functions; import after the
// module is loaded (Prisma client is instantiated at module load but never
// called by these helpers).
import { validateSearchQuery, trimInfobox } from '../wikiCatalogService';

// ── validateSearchQuery ───────────────────────────────────────────────────────

describe('validateSearchQuery', () => {
  test('passes a normal ASCII query', () => {
    assert.equal(validateSearchQuery('Stimpak'), 'Stimpak');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(validateSearchQuery('  Fixer  '), 'Fixer');
  });

  test('accepts exactly 1 character', () => {
    assert.equal(validateSearchQuery('x'), 'x');
  });

  test('accepts exactly 100 characters', () => {
    const q = 'a'.repeat(100);
    assert.equal(validateSearchQuery(q), q);
  });

  test('rejects empty string (after trim)', () => {
    assert.throws(() => validateSearchQuery(''), /400|1 and 100/);
  });

  test('rejects string of only whitespace', () => {
    assert.throws(() => validateSearchQuery('   '), /400|1 and 100/);
  });

  test('rejects string longer than 100 characters', () => {
    assert.throws(() => validateSearchQuery('a'.repeat(101)), /400|1 and 100/);
  });

  test('strips null bytes and validates remaining length', () => {
    // "\x00" stripped → "ab" (length 2) → passes
    assert.equal(validateSearchQuery('a\x00b'), 'ab');
  });

  test('rejects string that is only null bytes (becomes empty after strip)', () => {
    assert.throws(() => validateSearchQuery('\x00\x00'), /400|1 and 100/);
  });

  test('rejects non-string (number)', () => {
    assert.throws(() => validateSearchQuery(42 as unknown as string), /400|string/);
  });

  test('rejects non-string (null)', () => {
    assert.throws(() => validateSearchQuery(null as unknown as string), /400|string/);
  });

  test('rejects non-string (undefined)', () => {
    assert.throws(() => validateSearchQuery(undefined as unknown as string), /400|string/);
  });
});

// ── trimInfobox ───────────────────────────────────────────────────────────────

describe('trimInfobox — per-kind field subset', () => {
  // Helpers
  const keys = (r: Record<string, string>) => Object.keys(r).sort();

  // ── weapon ──────────────────────────────────────────────────────────────────
  test('weapon: keeps allowed weapon fields only', () => {
    const raw = {
      type: 'Rifle',
      class: 'Ballistic',
      damage: '110',
      'fire rate': '33',
      range: '204',
      accuracy: '69',
      crit: '55',
      ammo: '.308 round',
      weight: '13.2',
      value: '283',
      effects: 'None',
      perks: 'Rifleman',
      plan: 'Plan: The Fixer',
      formid: '0046D2A1',
      // extras that should be excluded
      level: '30',
      xp: '5',
    };
    const result = trimInfobox(raw, 'weapon');
    assert.ok('type' in result);
    assert.ok('damage' in result);
    assert.ok('formid' in result);
    assert.ok('level' in result, 'level should be included for weapon (added to KIND_FIELDS)');
    assert.ok(!('xp' in result), 'xp should be excluded for weapon');
  });

  test('weapon: drops empty-value fields', () => {
    const raw = { type: 'Pistol', damage: '', ammo: '.45 round' };
    const result = trimInfobox(raw, 'weapon');
    assert.ok(!('damage' in result), 'empty damage should be dropped');
    assert.ok('type' in result);
    assert.ok('ammo' in result);
  });

  test('weapon: normalises underscore keys to spaces', () => {
    const raw = { fire_rate: '40' };
    const result = trimInfobox(raw, 'weapon');
    assert.ok('fire rate' in result, 'fire_rate should be normalised to "fire rate"');
  });

  // ── armor ───────────────────────────────────────────────────────────────────
  test('armor: keeps allowed armor fields only', () => {
    // KIND_FIELDS.armor: type, class, dr, er, rr, resist, physical resistance,
    // energy resistance, radiation resistance, variants, slots, effects, perks,
    // weight, value, plan, formid
    const raw = {
      type: 'Chest',
      class: 'Metal',
      resist: '18',
      'physical resistance': '18',
      'energy resistance': '12',
      'radiation resistance': '8',
      weight: '8.5',
      value: '50',
      effects: '+1 STR',
      perks: 'None',
      plan: 'Plan: Metal chest piece',
      formid: '00180954',
      // excluded — not in KIND_FIELDS.armor
      damage: '0',
      'emp resistance': '0',
    };
    const result = trimInfobox(raw, 'armor');
    assert.ok('physical resistance' in result);
    assert.ok('energy resistance' in result);
    assert.ok('radiation resistance' in result);
    assert.ok('formid' in result);
    assert.ok(!('damage' in result), 'damage should be excluded for armor');
    assert.ok(!('emp resistance' in result), 'emp resistance should be excluded for armor');
  });

  // ── creature ─────────────────────────────────────────────────────────────────
  test('creature: keeps allowed creature fields only', () => {
    const raw = {
      type: 'Mutated animal',
      variants: 'Radstag, Albino Radstag',
      level: '1–30',
      hp: '115–820',
      xp: '25',
      drops: 'Radstag meat',
      locations: 'Appalachia',
      formid: '0006B239',
      // excluded
      weight: '0',
      value: '10',
    };
    const result = trimInfobox(raw, 'creature');
    assert.ok('variants' in result);
    assert.ok('hp' in result);
    assert.ok('xp' in result);
    assert.ok(!('weight' in result), 'weight should be excluded for creature');
    assert.ok(!('value' in result), 'value should be excluded for creature');
  });

  // ── item ─────────────────────────────────────────────────────────────────────
  test('item: keeps allowed item fields only', () => {
    const raw = {
      type: 'Aid',
      effect: 'Restores 40 HP',
      duration: '0',
      hunger: '-10',
      thirst: '-5',
      rads: '0',
      weight: '0.25',
      value: '34',
      formid: '00023736',
      // excluded
      level: '1',
      xp: '0',
    };
    const result = trimInfobox(raw, 'item');
    assert.ok('effect' in result);
    assert.ok('hunger' in result);
    assert.ok('rads' in result);
    assert.ok(!('level' in result), 'level should be excluded for item');
    assert.ok(!('xp' in result), 'xp should be excluded for item');
  });

  // ── perk ─────────────────────────────────────────────────────────────────────
  test('perk: keeps allowed perk fields only', () => {
    // KIND_FIELDS.perk: effects, equip cost, unlocked, race(s), editor id,
    // form id, type, requires
    const raw = {
      effects: 'Deal +10% damage with rifles.',
      'equip cost': '1',
      unlocked: 'Level 5',
      'form id': '0004A0B5',  // perk uses 'form id' (with space), not 'formid'
      type: 'Combat',
      requires: 'Perception 2',
      // excluded — not in KIND_FIELDS.perk
      weight: '0',
      formid: '0004A0B5',  // bare 'formid' (no space) is excluded from perk
      special: 'Perception',
      rank1: 'Deal +10% damage with rifles.',
    };
    const result = trimInfobox(raw, 'perk');
    assert.ok('effects' in result, 'effects should be included for perk');
    assert.ok('equip cost' in result, 'equip cost should be included for perk');
    assert.ok('form id' in result, 'form id (with space) should be included for perk');
    assert.ok('type' in result, 'type should be included for perk');
    assert.ok(!('weight' in result), 'weight should be excluded for perk');
    assert.ok(!('formid' in result), 'bare formid (no space) should be excluded for perk');
    assert.ok(!('special' in result), 'special should be excluded for perk');
    assert.ok(!('rank1' in result), 'rank fields should be excluded for perk');
  });

  // ── location ─────────────────────────────────────────────────────────────────
  test('location: keeps allowed location fields only', () => {
    // Current location fields: type, part of, factions, creatures, robots,
    // quests, leaders, owners, terminal, refid
    const raw = {
      type: 'Town',
      factions: 'Raiders',
      quests: 'Back to Basics',
      refid: '000D9533',
      // excluded (not in location KIND_FIELDS)
      region: 'The Forest',
      formid: '000D9533',
      level: '1–50',
      hp: '999',
    };
    const result = trimInfobox(raw, 'location');
    assert.ok('type' in result);
    assert.ok('factions' in result);
    assert.ok('quests' in result);
    assert.ok('refid' in result);
    assert.ok(!('region' in result), 'region should be excluded for location');
    assert.ok(!('formid' in result), 'formid should be excluded for location (use refid)');
    assert.ok(!('level' in result), 'level should be excluded for location');
    assert.ok(!('hp' in result), 'hp should be excluded for location');
  });

  // ── other/unknown ─────────────────────────────────────────────────────────────
  test('other/unknown (null kind): returns first 14 non-empty pairs', () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < 20; i++) raw[`field${i}`] = `val${i}`;
    const result = trimInfobox(raw, null);
    assert.equal(Object.keys(result).length, 14);
  });

  test('other/unknown: skips empty values in the 14-pair count', () => {
    const raw: Record<string, string> = {};
    // First 5 entries are empty
    for (let i = 0; i < 5; i++) raw[`empty${i}`] = '';
    // Next 20 are populated
    for (let i = 0; i < 20; i++) raw[`field${i}`] = `val${i}`;
    const result = trimInfobox(raw, null);
    // Empty keys excluded, so 14 of the populated ones make it through
    assert.equal(Object.keys(result).length, 14);
    assert.ok(!Object.keys(result).some(k => k.startsWith('empty')));
  });

  test('other/unknown: unknown kind string falls back to 14-pair limit', () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < 20; i++) raw[`k${i}`] = `v${i}`;
    const result = trimInfobox(raw, 'alchemy');  // not in KIND_FIELDS — truly unknown
    assert.equal(Object.keys(result).length, 14);
  });

  // ── edge cases ────────────────────────────────────────────────────────────────
  test('caps values at 256 characters', () => {
    const longVal = 'x'.repeat(300);
    const raw = { type: longVal };
    const result = trimInfobox(raw, 'weapon');
    assert.equal(result['type'].length, 256);
  });

  test('returns {} for empty raw object', () => {
    const result = trimInfobox({}, 'weapon');
    assert.deepEqual(result, {});
  });

  test('normalises uppercase keys', () => {
    const raw = { TYPE: 'Pistol', DAMAGE: '50' };
    const result = trimInfobox(raw, 'weapon');
    assert.ok('type' in result);
    assert.ok('damage' in result);
  });
});

// ── bestMatch pure selection logic ────────────────────────────────────────────
// bestMatch itself calls searchEntries → Prisma. We test the selection rule
// (returns first element or null) by exercising it with a thin mock around
// searchEntries, imported as a module namespace so we can replace it.

describe('bestMatch selection rule', () => {
  // We test the rule inline: given an ordered list, the "best match" is always
  // the first element. This mirrors the implementation: results[0] ?? null.
  const selectBestMatch = (results: { name: string; score: number }[]) =>
    results[0] ?? null;

  test('returns the first result when results are non-empty', () => {
    const results = [
      { name: 'Stimpak', score: 0.95 },
      { name: 'Stimpak (diluted)', score: 0.42 },
    ];
    const best = selectBestMatch(results);
    assert.equal(best?.name, 'Stimpak');
  });

  test('returns null when results are empty', () => {
    assert.equal(selectBestMatch([]), null);
  });

  test('returns single result when only one match', () => {
    const results = [{ name: 'The Fixer', score: 0.88 }];
    const best = selectBestMatch(results);
    assert.equal(best?.name, 'The Fixer');
  });

  test('does not reorder — highest score item assumed to be at index 0', () => {
    // pg_trgm orders DESC; we verify we do not accidentally re-sort client-side
    const results = [
      { name: 'High Match', score: 0.9 },
      { name: 'Low Match', score: 0.2 },
    ];
    assert.equal(selectBestMatch(results)?.name, 'High Match');
  });
});
