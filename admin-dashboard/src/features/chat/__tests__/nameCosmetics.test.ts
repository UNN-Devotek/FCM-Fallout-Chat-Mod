/**
 * nameCosmeticProps — the function that turns resolved cosmetics into the className /
 * style / data attributes on a username span.
 *
 * The two behaviours worth locking down:
 *   1. A user with NO cosmetics renders byte-identically to before this feature
 *      existed. Almost every user is in that state.
 *   2. When an effect IS present, the outline is handed to CSS via a custom property
 *      instead of being set inline — otherwise the inline text-shadow would silently
 *      win over the stylesheet and every effect would render as a plain name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nameCosmeticProps, nameEffectOutline } from '../ChatOverlay';
import { supporterBadge, supporterStarColor, SUPPORTER_STAR_GLYPH } from '../supporterBadge';
import { nameEffectMotion, NAME_EFFECT_MOTION_BOUNDS } from '../nameEffectMotion';

const THEME = {
  primaryText: 'rgba(245,203,91,0.9)',
  primaryColor: '#F5CB5B',
  textAlpha: 0.9,
  textOutline: '0 0 2px #000, 0 0 3px #000',
  glowEnabled: true,
};

describe('nameCosmeticProps — no cosmetics (the overwhelming majority of users)', () => {
  it('uses the theme colour and sets the inline text-shadow, exactly as before', () => {
    const { className, style, dataName } = nameCosmeticProps({}, THEME, 'Wanderer');
    expect(className).toBe('');
    expect(style.color).toBe(THEME.primaryText);
    expect(style.textShadow).toContain(THEME.textOutline);
    expect(dataName).toBeUndefined();
  });

  it('honours the glow setting', () => {
    const on = nameCosmeticProps({}, THEME, 'A').style.textShadow as string;
    const off = nameCosmeticProps({}, { ...THEME, glowEnabled: false }, 'A').style.textShadow as string;
    expect(on).toContain('0 0 3px');
    expect(off).toBe(THEME.textOutline);
  });

  it('treats null and empty-string cosmetics as absent', () => {
    for (const msg of [{ nameColor: null, effectId: null }, { nameColor: '', effectId: '' }]) {
      expect(nameCosmeticProps(msg, THEME, 'A').className).toBe('');
      expect(nameCosmeticProps(msg, THEME, 'A').style.color).toBe(THEME.primaryText);
    }
  });
});

describe('nameCosmeticProps — colour only', () => {
  it('applies the custom colour but keeps the inline shadow (no effect class)', () => {
    const { className, style } = nameCosmeticProps({ nameColor: '#57DBDB' }, THEME, 'A');
    expect(className).toBe('');
    expect(style.color).toBe('#57DBDB');
    expect(style.textShadow).toContain(THEME.textOutline);
  });
});

describe('nameCosmeticProps — with an effect', () => {
  const props = nameCosmeticProps({ nameColor: '#FD1CFD', effectId: 'glitch' }, THEME, 'Vaultie');

  it('emits the effect class', () => {
    expect(props.className).toBe('fcm-name-fx--glitch');
  });

  it('does NOT set an inline text-shadow — the class must own it', () => {
    // If this regresses, the inline style wins the cascade and every effect silently
    // renders as an ordinary name.
    expect(props.style.textShadow).toBeUndefined();
  });

  it('hands the outline and colour to CSS as custom properties', () => {
    const style = props.style as Record<string, unknown>;
    expect(style['--fcm-name-color']).toBe('#FD1CFD');
    expect(style['--fcm-name-outline']).toBe(THEME.textOutline);
  });

  it('exposes the name via dataName, which the glitch pseudo-elements read', () => {
    // .fcm-name-fx--glitch::before/::after use content: attr(data-fcm-name).
    expect(props.dataName).toBe('Vaultie');
  });

  it('falls back to the theme colour when an effect has no colour set', () => {
    const p = nameCosmeticProps({ effectId: 'glow-soft' }, THEME, 'A');
    expect(p.style.color).toBe(THEME.primaryText);
    expect((p.style as Record<string, unknown>)['--fcm-name-color']).toBe(THEME.primaryText);
  });

  it('builds a class for every effect id without special-casing', () => {
    for (const id of ['glow-soft', 'glow-hard', 'outline-heavy', 'chroma-split', 'glow-pulse', 'crt-phosphor', 'glitch', 'shimmer']) {
      expect(nameCosmeticProps({ effectId: id }, THEME, 'A').className).toBe(`fcm-name-fx--${id}`);
    }
  });

  it('renders Heavy Outline as a visibly heavier face with a real dark stroke', () => {
    expect(nameCosmeticProps({ effectId: 'outline-heavy' }, THEME, 'A').style.fontWeight).toBe(900);
    expect(nameCosmeticProps({ effectId: 'glow-soft' }, THEME, 'A').style.fontWeight).toBe('bold');
  });

  it('uses a lighter effect outline when the overlay chrome is transparent', () => {
    const outline = nameEffectOutline(1, 0.3);
    const normal = nameEffectOutline(1, 1);

    expect(outline).toMatch(/^0 0 1px rgba\(0,0,0,0\.306\), 0 0 2px rgba\(0,0,0,0\.177\)$/);
    expect(outline).not.toBe(normal);

    const props = nameCosmeticProps(
      { effectId: 'shimmer' },
      { ...THEME, chromeBgAlpha: 0.3 },
      'Wanderer',
    );
    expect((props.style as Record<string, unknown>)['--fcm-name-effect-outline'])
      .toBe(nameEffectOutline(THEME.textAlpha, 0.3));
  });
});

describe('supporterBadge', () => {
  it('uses a compact immutable star rather than arbitrary badge text', () => {
    expect(supporterBadge(['supporter'])).toEqual({
      tier: 'supporter', glyph: SUPPORTER_STAR_GLYPH, label: 'Supporter',
    });
    expect(supporterBadge(['supporter', 'OWNER', 'not-a-glyph'])).toEqual({
      tier: 'supporter', glyph: SUPPORTER_STAR_GLYPH, label: 'Supporter',
    });
    expect(SUPPORTER_STAR_GLYPH).toBe('★');
  });

  it('uses the same star for Overseer and gives the higher tier precedence during a role transition', () => {
    expect(supporterBadge(['supporter', 'overseer'])).toEqual({
      tier: 'overseer', glyph: '★', label: "Overseer's Circle",
    });
  });

  it('does not render unknown or absent badges', () => {
    expect(supporterBadge(['moderator'])).toBeNull();
    expect(supporterBadge()).toBeNull();
  });
});

describe('supporterStarColor', () => {
  it('uses a valid selected hex and falls back by tier when absent', () => {
    expect(supporterStarColor(['supporter'], '#58FDFD')).toBe('#58FDFD');
    expect(supporterStarColor(['supporter'], null)).toBe('#7EA8F7');
    expect(supporterStarColor(['overseer'], 'not-css')).toBe('#FD4DA6');
  });

  it('never accepts arbitrary CSS or creates a star without a known tier badge', () => {
    expect(supporterStarColor(['supporter'], 'url(https://evil.invalid)')).toBe('#7EA8F7');
    expect(supporterStarColor(['◆'], '#58FDFD')).toBeNull();
  });
});

describe('chat identity alignment', () => {
  it('centres the channel tag, star, name, and body on the same line', () => {
    const component = readFileSync(resolve(__dirname, '..', 'ChatOverlay.tsx'), 'utf8');
    const css = readFileSync(resolve(__dirname, '..', 'nameEffects.css'), 'utf8');
    expect(component).toContain("data-fcm-message-line=\"true\"");
    expect(component).toContain('className="fcm-message-prefix"');
    expect(component).toContain("display: 'inline-flex', alignItems: 'center', height: '1em', lineHeight: 1");
    expect(component).toContain("data-fcm-message-body=\"true\"");
    expect(component).toContain("display: 'inline'");
    expect(component).toContain("marginLeft: '0.25em'");
    expect(css).toContain('.fcm-message-prefix {\n  display: inline-flex;\n  align-items: center;\n  flex: 0 0 auto;');
    expect(css).toContain('.fcm-name-identity {\n  display: inline-flex;\n  align-items: center;');
    expect(css).toContain('vertical-align: middle;');
  });
});

describe('supporter effect readability', () => {
  it('gives each animated effect a stable, per-message phase', () => {
    const first = nameEffectMotion('glow-pulse', 'message-1');
    const same = nameEffectMotion('glow-pulse', 'message-1');
    const next = nameEffectMotion('glow-pulse', 'message-2');

    expect(first).toEqual(same);
    expect(first['--fcm-effect-delay']).toMatch(/^-[0-9.]+s$/);
    expect(next['--fcm-effect-delay']).toMatch(/^-[0-9.]+s$/);
    expect(next['--fcm-effect-delay']).not.toBe(first['--fcm-effect-delay']);
    expect(nameEffectMotion('glow-soft', 'message-1')).toEqual({});
  });

  it('assigns glitch a stable pseudo-random cadence inside the longer interval bounds', () => {
    const one = nameEffectMotion('glitch', 'message-1');
    const two = nameEffectMotion('glitch', 'message-2');
    const duration = (value: string | undefined) => {
      if (value === undefined) throw new Error('Expected an effect duration');
      return Number.parseFloat(value);
    };

    expect(duration(one['--fcm-glitch-duration'])).toBeGreaterThanOrEqual(NAME_EFFECT_MOTION_BOUNDS.glitchMinSeconds);
    expect(duration(one['--fcm-glitch-duration'])).toBeLessThanOrEqual(NAME_EFFECT_MOTION_BOUNDS.glitchMaxSeconds);
    expect(duration(two['--fcm-glitch-duration'])).toBeGreaterThanOrEqual(NAME_EFFECT_MOTION_BOUNDS.glitchMinSeconds);
    expect(duration(two['--fcm-glitch-duration'])).toBeLessThanOrEqual(NAME_EFFECT_MOTION_BOUNDS.glitchMaxSeconds);
    expect(two['--fcm-glitch-duration']).not.toBe(one['--fcm-glitch-duration']);
  });

  it('keeps the heavy glow and pulse within the restrained readability budget', () => {
    const css = readFileSync(resolve(__dirname, '..', 'nameEffects.css'), 'utf8');
    const heavyGlow = css.match(/\.fcm-name-fx--glow-hard \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const pulse = css.match(/@keyframes fcm-glow-pulse \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const pulseBase = css.match(/\.fcm-name-fx--glow-pulse \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(heavyGlow).toContain('0 0 5px color-mix(in srgb, var(--fcm-fx-color) 65%, transparent)');
    expect(heavyGlow).toContain('0 0 10px color-mix(in srgb, var(--fcm-fx-color) 28%, transparent)');
    expect(heavyGlow).not.toContain('0 0 16px');

    expect(pulse).toContain('0 0 5px color-mix(in srgb, var(--fcm-fx-color) 72%, transparent)');
    expect(pulse).toContain('0 0 16px color-mix(in srgb, var(--fcm-fx-color) 22%, transparent)');
    expect(pulse).not.toContain('0 0 28px');
    expect(pulse).not.toContain('var(--fcm-fx-color) 100%');
    expect(pulseBase).toContain('animation: fcm-glow-pulse 2.8s ease-in-out infinite alternate');
  });

  it('makes chroma split visibly separate the channels while preserving the base name', () => {
    const css = readFileSync(resolve(__dirname, '..', 'nameEffects.css'), 'utf8');
    const chroma = css.match(/\.fcm-name-fx--chroma-split \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(chroma).toContain('-1px 0 0 rgba(255, 0, 64, 0.28)');
    expect(chroma).toContain('1px 0 0 rgba(0, 224, 255, 0.28)');
    expect(chroma).toContain('color: var(--fcm-fx-color);');
    expect(chroma).toContain('var(--fcm-fx-outline)');
  });

  it('gives chroma split a dim resting state and an occasional offset burst', () => {
    const css = readFileSync(resolve(__dirname, '..', 'nameEffects.css'), 'utf8');
    const chroma = css.match(/\.fcm-name-fx--chroma-split \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const burst = css.match(/@keyframes fcm-chroma-shift \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(chroma).toContain('animation: fcm-chroma-shift var(--fcm-chroma-duration, 12s) steps(1, end) infinite;');
    expect(chroma).toContain('animation-delay: var(--fcm-effect-delay, 0s);');
    expect(burst).toContain('82%');
    expect(burst).toContain('-2px 1px 0 rgba(255, 0, 64, 0.46)');
    expect(burst).toContain('2px -1px 0 rgba(0, 224, 255, 0.46)');
    expect(chroma).not.toContain('0 0 3px color-mix(in srgb, var(--fcm-fx-color) 68%, transparent)');
    expect(css).toContain('.fcm-name-fx--chroma-split.fcm-no-name-motion');
  });

  it('assigns chroma split a stable per-message cadence and phase', () => {
    const one = nameEffectMotion('chroma-split', 'message-1');
    const same = nameEffectMotion('chroma-split', 'message-1');
    const two = nameEffectMotion('chroma-split', 'message-2');
    const duration = (value: unknown) => Number.parseFloat(String(value));

    expect(one).toEqual(same);
    expect(duration(one['--fcm-chroma-duration'])).toBeGreaterThanOrEqual(NAME_EFFECT_MOTION_BOUNDS.chromaMinSeconds);
    expect(duration(one['--fcm-chroma-duration'])).toBeLessThanOrEqual(NAME_EFFECT_MOTION_BOUNDS.chromaMaxSeconds);
    expect(two['--fcm-chroma-duration']).not.toBe(one['--fcm-chroma-duration']);
    expect(two['--fcm-effect-delay']).not.toBe(one['--fcm-effect-delay']);
  });

  it('sweeps a slow readable gradient across shimmer glyphs without transparent text clipping', () => {
    const css = readFileSync(resolve(__dirname, '..', 'nameEffects.css'), 'utf8');

    expect(css).toContain('@keyframes fcm-shimmer-letter');
    expect(css).toContain('.fcm-name-fx--shimmer .fcm-shimmer-letter');
    expect(css).toContain('animation: fcm-shimmer-letter 8s linear infinite');
    expect(css).toContain('animation-delay: calc(var(--fcm-effect-delay, 0s) - (var(--fcm-shimmer-index) * 0.22s))');
    expect(css).toContain('35% {\n    color: color-mix(in srgb, var(--fcm-fx-color) 72%, #fff);');
    expect(css).toContain('50% {\n    color: #fff;');
    expect(css).toContain('var(--fcm-fx-outline)');
    expect(css).not.toContain('color: transparent');
    expect(css).not.toContain('-webkit-text-fill-color: transparent');
    expect(css).not.toContain('.fcm-name-fx--shimmer::after');
    expect(css).not.toContain('mix-blend-mode: multiply');
    expect(css).not.toContain('background: repeating-linear-gradient');
    expect(css).toContain('  .fcm-name-fx--shimmer {\n    /* The static fallback is painted by the letter spans; do not add a second\n       parent halo after the overlay has already adapted each letter\'s outline. */\n    text-shadow: none;\n  }');
    expect(css).toContain('.fcm-name-fx--shimmer.fcm-no-name-motion {\n  /* Keep viewer opt-out consistent with the reduced-motion fallback. */\n  text-shadow: none;\n}');
    expect(css).toContain('.fcm-name-fx--shimmer.fcm-no-name-motion .fcm-shimmer-letter');

    const component = readFileSync(resolve(__dirname, '..', 'ChatOverlay.tsx'), 'utf8');
    expect(component).toContain("Array.from(displayName).map((character, index)");
    expect(component).toContain('className="fcm-shimmer-letter"');
    expect(component).toContain("['--fcm-shimmer-index' as string]: index");
  });

  it('routes every animated effect through the shared motion variables', () => {
    const css = readFileSync(resolve(__dirname, '..', 'nameEffects.css'), 'utf8');
    expect(css).toContain('animation-delay: var(--fcm-effect-delay, 0s);');
    expect(css).toContain('var(--fcm-glitch-duration, 11.5s)');
    expect(css.match(/animation-delay: var\(--fcm-effect-delay, 0s\);/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
