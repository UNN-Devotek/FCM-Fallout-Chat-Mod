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
import { nameCosmeticProps } from '../ChatOverlay';

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
});
