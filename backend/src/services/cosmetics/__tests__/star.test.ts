import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STAR_COLORS, SUPPORTER_STAR_GLYPH, defaultStarColor } from '../star';
import { validateColorPreset } from '../validation';

describe('supporter star contract', () => {
  test('has one immutable glyph and stable tier defaults', () => {
    assert.equal(SUPPORTER_STAR_GLYPH, '★');
    assert.equal(defaultStarColor('supporter'), DEFAULT_STAR_COLORS.supporter);
    assert.equal(defaultStarColor('overseer'), DEFAULT_STAR_COLORS.overseer);
  });

  test('validates star colors against the same tier-gated catalog as name colors', () => {
    assert.deepEqual(validateColorPreset('cryo', 'supporter', 'starColorPresetId'), {
      ok: true,
      value: 'cryo',
    });
    const locked = validateColorPreset('solar-flare', 'none', 'starColorPresetId');
    assert.equal(locked.ok, false);
    if (!locked.ok) {
      assert.equal(locked.rejection.field, 'starColorPresetId');
      assert.equal(locked.rejection.code, 'tier_locked');
    }
  });
});
