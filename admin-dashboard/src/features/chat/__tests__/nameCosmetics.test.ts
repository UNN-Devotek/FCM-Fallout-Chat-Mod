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
import { nameCosmeticProps } from '../ChatOverlay';
import { supporterBadge, supporterStarColor, SUPPORTER_STAR_GLYPH } from '../supporterBadge';

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
    expect(css).toContain('.fcm-message-prefix {\n  display: inline-flex;\n  align-items: center;\n  flex: 0 0 auto;');
    expect(css).toContain('.fcm-name-identity {\n  display: inline-flex;\n  align-items: center;');
    expect(css).toContain('vertical-align: middle;');
  });
});
