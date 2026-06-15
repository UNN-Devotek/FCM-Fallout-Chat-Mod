'use strict';

/**
 * Regression tests for the "Data" false-positive incident (2026-05-01).
 *
 * User "Devotek-" was briefly broadcast under the name "Data" for ~90 s
 * because the FO76 memory scanner misread the engine string "Data" from heap
 * and the old provider-leak filter did not recognise it as a bad candidate.
 *
 * These tests verify the isProviderLeakUsername() predicate in nameBlacklist.ts
 * which guards the /api/users (register) endpoint — the backend backstop layer.
 *
 * Tests import from dist/ (compiled output) matching the rest of the test suite.
 */

const { isProviderLeakUsername, SHORT_ALPHA_BLACKLIST } =
  require('../dist/utils/nameBlacklist');

describe('nameBlacklist — isProviderLeakUsername (v1.1.33 regression guard)', () => {
  // ── Blacklisted words ────────────────────────────────────────────────────

  test('"Data" is flagged as a provider leak', () => {
    expect(isProviderLeakUsername('Data')).toBe(true);
  });

  test('"Player" is flagged as a provider leak', () => {
    expect(isProviderLeakUsername('Player')).toBe(true);
  });

  test('"Wanderer" is flagged as a provider leak', () => {
    expect(isProviderLeakUsername('Wanderer')).toBe(true);
  });

  test.each([
    'Body', 'Head', 'Stash', 'Inventory', 'Stats', 'Perks', 'Map',
    'Menu', 'None', 'True', 'False', 'Core', 'Info', 'State',
  ])('"%s" is flagged as a provider leak', (word) => {
    expect(isProviderLeakUsername(word)).toBe(true);
  });

  // ── Scaleform pattern (pre-existing) ────────────────────────────────────

  test('Scaleform provider identifier "ScreenResolutionData" is flagged', () => {
    expect(isProviderLeakUsername('ScreenResolutionData')).toBe(true);
  });

  test('camelCase method "showUnlockableSlot" is flagged', () => {
    expect(isProviderLeakUsername('showUnlockableSlot')).toBe(true);
  });

  test('m_-prefixed field is flagged', () => {
    expect(isProviderLeakUsername('m_LastContextMenuOption')).toBe(true);
  });

  test('"characterName" exact match is flagged', () => {
    expect(isProviderLeakUsername('characterName')).toBe(true);
  });

  // ── Legitimate player names pass through ────────────────────────────────

  test('"Devotek-" passes (has hyphen — real FO76 name)', () => {
    expect(isProviderLeakUsername('Devotek-')).toBe(false);
  });

  test('"MouseyPaige" passes (long mixed-case)', () => {
    expect(isProviderLeakUsername('MouseyPaige')).toBe(false);
  });

  test('"Kat47" passes (has digit)', () => {
    expect(isProviderLeakUsername('Kat47')).toBe(false);
  });

  test('"Vault_Dweller" passes (has underscore)', () => {
    expect(isProviderLeakUsername('Vault_Dweller')).toBe(false);
  });

  test('"RealName99-" passes (mixed)', () => {
    expect(isProviderLeakUsername('RealName99-')).toBe(false);
  });

  // ── SHORT_ALPHA_BLACKLIST completeness ───────────────────────────────────

  test('SHORT_ALPHA_BLACKLIST contains "Data"', () => {
    expect(SHORT_ALPHA_BLACKLIST.has('Data')).toBe(true);
  });

  test('SHORT_ALPHA_BLACKLIST does not contain "Devotek-"', () => {
    expect(SHORT_ALPHA_BLACKLIST.has('Devotek-')).toBe(false);
  });
});
