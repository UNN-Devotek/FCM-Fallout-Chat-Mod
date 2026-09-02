/**
 * Pure Discord /cosmetics helpers. Runs under node:test via src/testRunner.ts.
 *
 * There were previously NO tests for Discord interactions anywhere in this repo.
 * Keeping the decidable parts pure is what makes this surface testable at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCosmeticId,
  parseCosmeticId,
  buildColorChoices,
  buildEffectChoices,
  reasonToMessage,
  AUTOCOMPLETE_LIMIT,
  clearCosmeticPatch,
  COSMETICS_CLEAR_FIELD_CHOICES,
} from '../cosmeticsCommandHelpers';
import { COLOR_PRESETS, EFFECT_PRESETS } from '../cosmetics/presets';

describe('customId codec', () => {
  test('round-trips action and arg', () => {
    assert.deepEqual(parseCosmeticId(buildCosmeticId('name')), { isOurs: true, action: 'name', arg: null });
    assert.deepEqual(parseCosmeticId(buildCosmeticId('color', 'cryo')), { isOurs: true, action: 'color', arg: 'cryo' });
  });

  test('rejects other services\' customIds so listeners do not cross-fire', () => {
    // ticketService and voiceService attach their own interactionCreate listeners to
    // the same client; without this guard each would try to handle the others' events.
    for (const foreign of ['ticket:open:bug', 'fcmvoice:rename', 'something', '']) {
      assert.equal(parseCosmeticId(foreign).isOurs, false, `${foreign} should not be ours`);
    }
    assert.equal(parseCosmeticId(null).isOurs, false);
    assert.equal(parseCosmeticId(undefined).isOurs, false);
  });

  test('preserves colons inside the arg', () => {
    assert.equal(parseCosmeticId('fcmcos:x:a:b:c').arg, 'a:b:c');
  });
});

describe('autocomplete choices', () => {
  test('never exceeds the Discord limit of 25', () => {
    // This is why the command uses autocomplete rather than a select menu: the full
    // catalog already exceeds what a select menu can hold.
    const choices = buildColorChoices(COLOR_PRESETS, 'overseer', '');
    assert.ok(choices.length <= AUTOCOMPLETE_LIMIT, `got ${choices.length}`);
  });

  test('shows locked options rather than hiding them', () => {
    // Same rule as the frosted web picker: a user should see what the tier buys.
    const choices = buildColorChoices(COLOR_PRESETS, 'none', '');
    const locked = choices.filter((c) => c.name.includes('locked'));
    assert.ok(locked.length > 0, 'free users should still see supporter colours, marked locked');
  });

  test('sorts unlocked options first', () => {
    const choices = buildColorChoices(COLOR_PRESETS, 'none', '');
    const firstLockedIndex = choices.findIndex((c) => c.name.includes('locked'));
    const lastUnlockedIndex = choices.map((c) => c.name.includes('locked')).lastIndexOf(false);
    if (firstLockedIndex !== -1) {
      assert.ok(lastUnlockedIndex < firstLockedIndex, 'unlocked choices must come first');
    }
  });

  test('an overseer sees nothing marked locked', () => {
    const choices = buildColorChoices(COLOR_PRESETS, 'overseer', '');
    assert.equal(choices.filter((c) => c.name.includes('locked')).length, 0);
  });

  test('filters by label, id and hex', () => {
    assert.ok(buildColorChoices(COLOR_PRESETS, 'overseer', 'cryo').some((c) => c.value === 'cryo'));
    assert.ok(buildColorChoices(COLOR_PRESETS, 'overseer', 'Cryo').some((c) => c.value === 'cryo'));
    assert.ok(buildColorChoices(COLOR_PRESETS, 'overseer', '#57DBDB').some((c) => c.value === 'cryo'));
  });

  test('an unmatched query yields no choices rather than the whole list', () => {
    assert.deepEqual(buildColorChoices(COLOR_PRESETS, 'overseer', 'zzzzz-nope'), []);
  });

  test('effect choices state that effects are desktop only', () => {
    // Nobody should buy a tier expecting effects to appear where they actually play.
    const choices = buildEffectChoices(EFFECT_PRESETS, 'overseer', '');
    const real = choices.filter((c) => c.value !== 'none');
    assert.ok(real.length > 0);
    for (const c of real) {
      assert.ok(c.name.includes('desktop only'), `${c.value} should be marked desktop only`);
    }
  });

  test('the "none" effect is not marked desktop only', () => {
    const none = buildEffectChoices(EFFECT_PRESETS, 'none', '').find((c) => c.value === 'none');
    assert.ok(none);
    assert.ok(!none.name.includes('desktop only'));
  });
});

describe('reasonToMessage', () => {
  // The CTA values below are opaque sentinels rather than real URLs on purpose. It
  // makes the assertion stronger (it proves the EXACT value we passed is what gets
  // interpolated, not merely that some URL-ish text appears), and it avoids writing
  // `msg.includes('https://...')`, which CodeQL flags as incomplete URL sanitization —
  // a fair heuristic, since that pattern is a real vulnerability when it guards a
  // security decision instead of asserting on copy.
  const SHOP_SENTINEL = 'SHOP-CTA-SENTINEL';
  const LINK_SENTINEL = 'LINK-CTA-SENTINEL';

  test('tier_locked names the tier and includes the shop link when available', () => {
    const msg = reasonToMessage('tier_locked', { requiredTier: 'overseer' }, { shopUrl: SHOP_SENTINEL });
    assert.ok(msg.includes("Overseer's Circle"));
    assert.ok(msg.includes(SHOP_SENTINEL));
  });

  test('tier_locked omits the CTA when the tier is not for sale yet', () => {
    const msg = reasonToMessage('tier_locked', { requiredTier: 'supporter' }, {});
    assert.ok(msg.includes('Supporter'));
    assert.ok(!msg.includes(SHOP_SENTINEL));
  });

  test('blacklisted NEVER reveals which pattern matched', () => {
    // Echoing the matched pattern would turn the command into an oracle for probing
    // the name blacklist and automod filters.
    const msg = reasonToMessage('blacklisted', { message: 'That name is not allowed. Please choose another.' }, {});
    assert.ok(!/pattern|regex|match|filter|blacklist/i.test(msg), `leaked filter internals: ${msg}`);
  });

  test('blacklisted falls back to safe copy when no message is supplied', () => {
    const msg = reasonToMessage('blacklisted', {}, {});
    assert.ok(msg.length > 0);
    assert.ok(!/pattern|regex|blacklist/i.test(msg));
  });

  test('not_linked points at the link page when known', () => {
    assert.ok(reasonToMessage('not_linked', {}, { linkUrl: LINK_SENTINEL }).includes(LINK_SENTINEL));
    assert.ok(reasonToMessage('not_linked', {}, {}).length > 0);
  });

  test('every known reason produces non-empty copy', () => {
    for (const reason of [
      'tier_locked', 'blacklisted',
      'invalid_color', 'invalid_tag', 'not_linked', 'not_found', 'rate_limited', 'wat',
    ]) {
      assert.ok(reasonToMessage(reason, {}, {}).length > 0, `${reason} produced empty copy`);
    }
  });

});

describe('appearance clear rules', () => {
  test('clears the independently selected supporter star colour', () => {
    assert.deepEqual(clearCosmeticPatch('star'), { starColorPresetId: null });
    assert.ok(COSMETICS_CLEAR_FIELD_CHOICES.some((choice) => choice.value === 'star'));
  });

  test('all resets every appearance field, including star colour', () => {
    assert.deepEqual(clearCosmeticPatch('all'), {
      colorPresetId: null,
      customColorHex: null,
      starColorPresetId: null,
      effectId: null,
      customTag: null,
    });
  });
});
