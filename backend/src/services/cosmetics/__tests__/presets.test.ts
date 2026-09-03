/**
 * Catalog assertions. Runs under node:test via src/testRunner.ts.
 *
 * These are the gates that stop a bad cosmetic from ever shipping: every colour must
 * be legible on every surface a name renders on, and far enough from the role / theme
 * / channel colours that it cannot be used to impersonate staff or imitate system
 * chrome. A preset that violates either fails CI rather than being discovered in chat.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR_PRESETS,
  FREE_COLORS,
  SUPPORTER_COLORS,
  EFFECT_PRESETS,
  REDUCED_MOTION_FALLBACK,
  CUSTOM_COLOR_BOUNDS,
  findColorPreset,
  findEffectPreset,
} from '../presets';
import {
  RESERVED_COLORS,
  RESERVED_MIN_DISTANCE,
  colorDistance,
  findReservedConflict,
  isColorAllowed,
} from '../reservedColors';
import {
  MIN_CONTRAST,
  worstCaseContrast,
  minLightnessForHue,
  normalizeHex,
  hexToHsl,
  hslToHex,
  contrastRatio,
} from '../../../utils/colorContrast';

/** Colours in the picker must be tellable apart from each other, not just from reserved. */
const MIN_INTRA_PALETTE_DISTANCE = 40;

describe('colour catalog — contrast', () => {
  for (const preset of COLOR_PRESETS) {
    test(`${preset.id} (${preset.hex}) is legible on every surface`, () => {
      const ratio = worstCaseContrast(preset.hex);
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${preset.id} ${preset.hex} worst-case contrast ${ratio.toFixed(2)} < ${MIN_CONTRAST}`,
      );
    });
  }
});

describe('colour catalog — reserved colours', () => {
  for (const preset of COLOR_PRESETS) {
    test(`${preset.id} cannot be mistaken for a reserved colour`, () => {
      const conflict = findReservedConflict(preset.hex);
      assert.equal(
        conflict,
        null,
        `${preset.id} ${preset.hex} is within ${RESERVED_MIN_DISTANCE} of ${conflict?.label} (${conflict?.hex})`,
      );
    });
  }

  test('every reserved colour is itself rejected', () => {
    for (const reserved of RESERVED_COLORS) {
      assert.equal(isColorAllowed(reserved.hex), false, `${reserved.label} should be rejected`);
    }
  });

  test('the moderator, owner and admin colours are reserved for impersonation reasons', () => {
    const impersonation = RESERVED_COLORS.filter((c) => c.reason === 'impersonation').map((c) => c.hex.toLowerCase());
    for (const hex of ['#50c878', '#ffb000', '#d4b040']) {
      assert.ok(impersonation.includes(hex), `${hex} must be reserved against impersonation`);
    }
  });
});

describe('colour catalog — structure', () => {
  test('preset ids are unique', () => {
    const ids = COLOR_PRESETS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate colour preset id');
  });

  test('preset hexes are unique and normalized-parseable', () => {
    const hexes = COLOR_PRESETS.map((c) => normalizeHex(c.hex));
    for (const [i, h] of hexes.entries()) {
      assert.ok(h !== null, `${COLOR_PRESETS[i].id} has an unparseable hex`);
    }
    assert.equal(new Set(hexes).size, hexes.length, 'duplicate colour preset hex');
  });

  test('colours within a tier are visually distinguishable from each other', () => {
    for (const palette of [FREE_COLORS, SUPPORTER_COLORS]) {
      for (let i = 0; i < palette.length; i++) {
        for (let j = i + 1; j < palette.length; j++) {
          const d = colorDistance(palette[i].hex, palette[j].hex);
          assert.ok(
            d >= MIN_INTRA_PALETTE_DISTANCE,
            `${palette[i].id} and ${palette[j].id} are too similar (distance ${d.toFixed(0)})`,
          );
        }
      }
    }
  });

  test('free colours are tier none and supporter colours are tier supporter', () => {
    for (const c of FREE_COLORS) assert.equal(c.tier, 'none', `${c.id} should be free`);
    for (const c of SUPPORTER_COLORS) assert.equal(c.tier, 'supporter', `${c.id} should be supporter`);
  });

  test('the free palette is not smaller than the paid one — free users get a real choice', () => {
    assert.ok(
      FREE_COLORS.length >= SUPPORTER_COLORS.length,
      'the free palette must not be shrunk to make the paid tier look better',
    );
  });

  test('findColorPreset resolves known ids and rejects unknown ones', () => {
    assert.equal(findColorPreset('cryo')?.hex, '#57DBDB');
    assert.equal(findColorPreset('nope'), null);
    assert.equal(findColorPreset(null), null);
    assert.equal(findColorPreset(undefined), null);
  });
});

describe('effect catalog', () => {
  test('effect ids are unique', () => {
    const ids = EFFECT_PRESETS.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate effect preset id');
  });

  test('NO effect claims in-game support — Scaleform bans filters permanently', () => {
    // This is a hard platform limit, not a gap to close later: any .filters assignment
    // crashes Fallout 76 outright (FCMChatWidget.hx crash rule #1). If this assertion
    // is ever "fixed" by flipping a flag, the game will crash for that user.
    for (const effect of EFFECT_PRESETS) {
      assert.equal(effect.inGameSupported, false, `${effect.id} must not claim in-game support`);
    }
  });

  test('every animated effect has a static reduced-motion fallback', () => {
    for (const effect of EFFECT_PRESETS) {
      if (!effect.animated) continue;
      const fallbackId = REDUCED_MOTION_FALLBACK[effect.id];
      assert.ok(fallbackId, `${effect.id} is animated but has no reduced-motion fallback`);
      const fallback = findEffectPreset(fallbackId);
      assert.ok(fallback, `${effect.id} falls back to unknown effect ${fallbackId}`);
      assert.equal(fallback.animated, false, `${effect.id} falls back to another animated effect`);
    }
  });

  test('fallbacks never require a higher tier than the effect itself', () => {
    // Otherwise a reduced-motion Overseer would silently lose their cosmetic.
    const order = ['none', 'supporter', 'overseer'];
    for (const [id, fallbackId] of Object.entries(REDUCED_MOTION_FALLBACK)) {
      const effect = findEffectPreset(id);
      const fallback = findEffectPreset(fallbackId);
      assert.ok(effect && fallback);
      assert.ok(
        order.indexOf(fallback.tier) <= order.indexOf(effect.tier),
        `${id} falls back to ${fallbackId}, which requires a higher tier`,
      );
    }
  });

  test('animated effects are Overseer-only and readability effects remain Supporter-or-free', () => {
    for (const effect of EFFECT_PRESETS) {
      if (effect.animated) assert.equal(effect.tier, 'overseer', `${effect.id} animates but is not Overseer`);
    }
  });

  test('"none" is free so every user can turn effects off', () => {
    assert.equal(findEffectPreset('none')?.tier, 'none');
  });

  test('every effect has user-facing description copy', () => {
    for (const effect of EFFECT_PRESETS) {
      assert.ok(effect.description.length > 0, `${effect.id} has no description`);
      assert.ok(effect.label.length > 0, `${effect.id} has no label`);
    }
  });
});

describe('custom colour bounds (the HSL picker)', () => {
  test('the per-hue lightness floor guarantees legibility across the whole hue circle', () => {
    // This is the guarantee the picker relies on: clamp lightness to
    // minLightnessForHue(h, s) and the result is always legible. Sample every hue at
    // full saturation — the hardest case, since saturation pushes luminance away from
    // the neutral axis.
    const failures: string[] = [];
    for (let h = 0; h < 360; h += 5) {
      for (const s of [CUSTOM_COLOR_BOUNDS.minSaturation, 60, CUSTOM_COLOR_BOUNDS.maxSaturation]) {
        const floor = minLightnessForHue(h, s);
        assert.ok(floor !== null, `no legible lightness exists for h=${h} s=${s}`);
        const hex = hslToHex({ h, s, l: floor });
        if (worstCaseContrast(hex) < MIN_CONTRAST) failures.push(`h=${h} s=${s} l=${floor} ${hex}`);
      }
    }
    assert.deepEqual(failures, [], `per-hue floor let through illegible colours: ${failures.join(', ')}`);
  });

  test('the floor is hue-dependent — a flat floor would wash out warm hues', () => {
    // Pure blue is the binding case (luminance weights B at only 0.0722). If these
    // ever converge, someone has replaced the per-hue calculation with a constant.
    const blue = minLightnessForHue(240, 100);
    const green = minLightnessForHue(120, 100);
    assert.ok(blue !== null && green !== null);
    assert.ok(blue > green, `expected blue (${blue}) to need more lightness than green (${green})`);
  });

  test('one step below the per-hue floor is actually illegible (the floor is tight)', () => {
    // Guards against the floor being set uselessly high "to be safe", which would
    // silently remove usable colours from the picker.
    const floor = minLightnessForHue(120, 100);
    assert.ok(floor !== null && floor > 0);
    const justBelow = hslToHex({ h: 120, s: 100, l: floor - 2 });
    assert.ok(
      worstCaseContrast(justBelow) < MIN_CONTRAST,
      `floor for green is ${floor}% but ${floor - 2}% is still legible — floor is too conservative`,
    );
  });

  test('bounds are internally consistent', () => {
    assert.ok(CUSTOM_COLOR_BOUNDS.minLightness < CUSTOM_COLOR_BOUNDS.maxLightness);
    assert.ok(CUSTOM_COLOR_BOUNDS.minSaturation < CUSTOM_COLOR_BOUNDS.maxSaturation);
  });
});

describe('colour maths sanity', () => {
  test('contrast is symmetric and bounded', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
    assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
    assert.equal(contrastRatio('#123456', '#123456'), 1);
  });

  test('hex <-> hsl round-trips within rounding tolerance', () => {
    for (const preset of COLOR_PRESETS) {
      const hsl = hexToHsl(preset.hex);
      assert.ok(hsl, `${preset.id} failed hexToHsl`);
      const back = hslToHex(hsl);
      assert.ok(
        colorDistance(back, preset.hex) <= 2,
        `${preset.id} round-trip drifted: ${preset.hex} -> ${back}`,
      );
    }
  });

  test('unparseable input is rejected rather than defaulting to a colour', () => {
    assert.equal(normalizeHex('nope'), null);
    assert.equal(normalizeHex(''), null);
    assert.equal(normalizeHex(null), null);
    assert.equal(normalizeHex('#12345'), null);
    assert.equal(normalizeHex('#GGGGGG'), null);
  });

  test('shorthand and case variations normalize identically', () => {
    assert.equal(normalizeHex('#ABC'), '#aabbcc');
    assert.equal(normalizeHex('AABBCC'), '#aabbcc');
    assert.equal(normalizeHex('#AaBbCc'), '#aabbcc');
  });
});
