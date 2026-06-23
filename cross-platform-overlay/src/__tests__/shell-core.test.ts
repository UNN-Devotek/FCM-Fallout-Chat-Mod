import { describe, it, expect } from 'vitest';
import {
  BASE_FONT,
  RESIZE_MIN_WIDTH,
  RESIZE_MIN_HEIGHT,
  SHELL_PALETTE,
  SHELL_PALETTE_FALLBACK,
  chromeThemeVars,
  accelFromEvent,
  prettyAccel,
  collectChannels,
  nextNavIndex,
  scaleZoomValue,
  chromeBgAlpha,
  textOpacityValue,
  scanlineOpacityValue,
  clampIdleCollapseSeconds,
  IDLE_COLLAPSE_SECONDS_MIN,
  IDLE_COLLAPSE_SECONDS_MAX,
  IDLE_COLLAPSE_SECONDS_DEFAULT,
  shellToWebSettings,
  resolveCollapsedHeight,
  computeResizeBounds,
  isDragTarget,
  shouldExitTextEntryOnEscape,
  detectLinuxRenderer,
  BLOCKED_KEYS,
  type Bounds,
  type DragTargetEl,
  type ResizeEdge,
} from '../shell-core';

// ── chromeThemeVars ──────────────────────────────────────────────────────────

describe('chromeThemeVars', () => {
  it('resolves each known theme to its palette + dim alpha', () => {
    for (const [id, pal] of Object.entries(SHELL_PALETTE)) {
      const v = chromeThemeVars(id);
      expect(v.primary).toBe(pal.primary);
      expect(v.text).toBe(pal.text);
      expect(v.primaryDim).toBe(pal.primary + '2E');
    }
  });

  it('falls back to green for unknown / undefined / empty ids', () => {
    const fb = SHELL_PALETTE_FALLBACK;
    for (const id of [undefined, '', 'does-not-exist']) {
      const v = chromeThemeVars(id as string | undefined);
      expect(v.primary).toBe(fb.primary);
      expect(v.text).toBe(fb.text);
      expect(v.primaryDim).toBe(fb.primary + '2E');
    }
  });
});

// ── accelFromEvent ───────────────────────────────────────────────────────────
// Comprehensive: every key category a user could realistically bind.
// DOM KeyboardEvent.key values → Electron accelerator strings.

describe('accelFromEvent', () => {
  // ── Invalid / reserved ────────────────────────────────────────────────────

  it('returns null for bare modifier keys (including with their own flag set)', () => {
    for (const key of ['Control', 'Shift', 'Alt', 'Meta']) {
      expect(accelFromEvent({ key })).toBeNull();
      expect(accelFromEvent({ key, ctrlKey: true })).toBeNull();
    }
  });

  it('returns null for Escape — reserved for clear-bind, never a valid accelerator', () => {
    expect(accelFromEvent({ key: 'Escape' })).toBeNull();
    expect(accelFromEvent({ key: 'Escape', shiftKey: true })).toBeNull();
    expect(accelFromEvent({ key: 'Escape', ctrlKey: true })).toBeNull();
  });

  // ── Alpha keys (a–z) ─────────────────────────────────────────────────────

  it('upper-cases every lower-case alpha key', () => {
    for (let c = 97; c <= 122; c++) {
      const char = String.fromCharCode(c); // 'a'..'z'
      expect(accelFromEvent({ key: char })).toBe(char.toUpperCase());
    }
  });

  it('leaves already-upper-cased alpha keys unchanged', () => {
    expect(accelFromEvent({ key: 'A' })).toBe('A');
    expect(accelFromEvent({ key: 'Z' })).toBe('Z');
  });

  // ── Digit keys (0–9) ─────────────────────────────────────────────────────

  it('passes digit keys through unchanged', () => {
    for (let d = 0; d <= 9; d++) {
      expect(accelFromEvent({ key: String(d) })).toBe(String(d));
    }
  });

  // ── Function keys (F1–F24) ───────────────────────────────────────────────

  it('passes F1–F24 through verbatim', () => {
    for (let n = 1; n <= 24; n++) {
      expect(accelFromEvent({ key: `F${n}` })).toBe(`F${n}`);
    }
  });

  // ── Arrow keys — DOM 'ArrowX' → Electron 'X' ─────────────────────────────

  it('maps DOM Arrow* keys to Electron Left/Right/Up/Down', () => {
    expect(accelFromEvent({ key: 'ArrowLeft'  })).toBe('Left');
    expect(accelFromEvent({ key: 'ArrowRight' })).toBe('Right');
    expect(accelFromEvent({ key: 'ArrowUp'    })).toBe('Up');
    expect(accelFromEvent({ key: 'ArrowDown'  })).toBe('Down');
  });

  it('applies modifiers to arrow keys correctly', () => {
    expect(accelFromEvent({ key: 'ArrowLeft',  ctrlKey: true  })).toBe('CommandOrControl+Left');
    expect(accelFromEvent({ key: 'ArrowRight', shiftKey: true })).toBe('Shift+Right');
    expect(accelFromEvent({ key: 'ArrowUp',    altKey: true   })).toBe('Alt+Up');
    expect(accelFromEvent({ key: 'ArrowDown',  ctrlKey: true, shiftKey: true })).toBe('CommandOrControl+Shift+Down');
  });

  // ── Navigation / editing named keys ──────────────────────────────────────

  it('passes navigation keys through verbatim', () => {
    for (const key of ['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(accelFromEvent({ key })).toBe(key);
    }
  });

  it('applies modifiers to navigation keys correctly', () => {
    expect(accelFromEvent({ key: 'Insert',   shiftKey: true })).toBe('Shift+Insert');
    expect(accelFromEvent({ key: 'Delete',   ctrlKey: true  })).toBe('CommandOrControl+Delete');
    expect(accelFromEvent({ key: 'Home',     altKey: true   })).toBe('Alt+Home');
    expect(accelFromEvent({ key: 'End',      ctrlKey: true  })).toBe('CommandOrControl+End');
    expect(accelFromEvent({ key: 'PageUp',   shiftKey: true })).toBe('Shift+PageUp');
    expect(accelFromEvent({ key: 'PageDown', ctrlKey: true  })).toBe('CommandOrControl+PageDown');
  });

  // ── Tab and Backspace ─────────────────────────────────────────────────────

  it('passes Tab and Backspace through verbatim', () => {
    expect(accelFromEvent({ key: 'Tab' })).toBe('Tab');
    expect(accelFromEvent({ key: 'Backspace' })).toBe('Backspace');
    expect(accelFromEvent({ key: 'Tab', shiftKey: true })).toBe('Shift+Tab');
    expect(accelFromEvent({ key: 'Backspace', ctrlKey: true })).toBe('CommandOrControl+Backspace');
  });

  // ── Enter / Return — DOM 'Enter' → Electron 'Return' ─────────────────────

  it('maps DOM Enter to Electron Return', () => {
    expect(accelFromEvent({ key: 'Enter' })).toBe('Return');
    expect(accelFromEvent({ key: 'Enter', ctrlKey: true  })).toBe('CommandOrControl+Return');
    expect(accelFromEvent({ key: 'Enter', shiftKey: true })).toBe('Shift+Return');
    expect(accelFromEvent({ key: 'Enter', altKey: true   })).toBe('Alt+Return');
  });

  // ── Space ─────────────────────────────────────────────────────────────────

  it('maps the space key to Space', () => {
    expect(accelFromEvent({ key: ' ' })).toBe('Space');
    expect(accelFromEvent({ key: ' ', ctrlKey:  true })).toBe('CommandOrControl+Space');
    expect(accelFromEvent({ key: ' ', shiftKey: true })).toBe('Shift+Space');
  });

  // ── Punctuation / symbol keys ─────────────────────────────────────────────

  it('passes single-char punctuation/symbol keys through (unchanged by toUpperCase)', () => {
    for (const key of ['/', '\\', '[', ']', ';', "'", ',', '.', '`', '-', '=']) {
      expect(accelFromEvent({ key })).toBe(key);
    }
  });

  it('applies modifiers to symbol keys', () => {
    expect(accelFromEvent({ key: '/',  ctrlKey:  true })).toBe('CommandOrControl+/');
    expect(accelFromEvent({ key: '[',  altKey:   true })).toBe('Alt+[');
    expect(accelFromEvent({ key: ';',  shiftKey: true })).toBe('Shift+;');
  });

  // ── Modifier ordering: CommandOrControl → Alt → Shift ────────────────────

  it('orders modifiers CommandOrControl + Alt + Shift', () => {
    expect(accelFromEvent({ key: 'k', ctrlKey: true, altKey: true, shiftKey: true }))
      .toBe('CommandOrControl+Alt+Shift+K');
    expect(accelFromEvent({ key: 'k', altKey: true, shiftKey: true }))
      .toBe('Alt+Shift+K');
    expect(accelFromEvent({ key: 'F5', altKey: true }))
      .toBe('Alt+F5');
  });

  it('maps ctrl and meta both to CommandOrControl', () => {
    expect(accelFromEvent({ key: 'a', ctrlKey: true  })).toBe('CommandOrControl+A');
    expect(accelFromEvent({ key: 'a', metaKey: true  })).toBe('CommandOrControl+A');
  });

  // ── PrintScreen (allowed) / CapsLock (blocked) ───────────────────────────

  it('passes PrintScreen through verbatim', () => {
    expect(accelFromEvent({ key: 'PrintScreen' })).toBe('PrintScreen');
  });

  it('returns null for CapsLock — lock key, blocked', () => {
    expect(accelFromEvent({ key: 'CapsLock' })).toBeNull();
  });

  // ── Media / volume keys ───────────────────────────────────────────────────

  it('passes Electron-recognized media/volume key names through verbatim', () => {
    for (const key of [
      'MediaPlayPause', 'MediaStop', 'MediaNextTrack', 'MediaPreviousTrack',
      'VolumeUp', 'VolumeDown', 'VolumeMute',
    ]) {
      expect(accelFromEvent({ key })).toBe(key);
    }
  });
});

// ── BLOCKED_KEYS / accelFromEvent guard ──────────────────────────────────────

describe('BLOCKED_KEYS / accelFromEvent — blocked key list', () => {
  it('BLOCKED_KEYS contains all modifier key names', () => {
    for (const k of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Hyper', 'Super']) {
      expect(BLOCKED_KEYS.has(k)).toBe(true);
    }
  });

  it('BLOCKED_KEYS contains all lock keys', () => {
    for (const k of ['CapsLock', 'NumLock', 'ScrollLock']) {
      expect(BLOCKED_KEYS.has(k)).toBe(true);
    }
  });

  it('BLOCKED_KEYS contains keys Electron cannot register', () => {
    for (const k of ['Pause', 'ContextMenu', 'Escape']) {
      expect(BLOCKED_KEYS.has(k)).toBe(true);
    }
  });

  it('BLOCKED_KEYS contains incomplete/IME/unknown key values', () => {
    for (const k of ['Unidentified', 'Dead', 'Process', 'Compose']) {
      expect(BLOCKED_KEYS.has(k)).toBe(true);
    }
  });

  it('BLOCKED_KEYS contains power/brightness OS keys', () => {
    for (const k of [
      'Power', 'Standby', 'WakeUp', 'Hibernate', 'SleepModeToggle',
      'BrightnessDown', 'BrightnessUp',
    ]) {
      expect(BLOCKED_KEYS.has(k)).toBe(true);
    }
  });

  it('accelFromEvent returns null for every key in BLOCKED_KEYS', () => {
    for (const key of BLOCKED_KEYS) {
      expect(accelFromEvent({ key }), `expected null for blocked key "${key}"`).toBeNull();
      // Also with modifiers held — still null.
      expect(accelFromEvent({ key, ctrlKey: true }), `expected null for Ctrl+${key}`).toBeNull();
      expect(accelFromEvent({ key, shiftKey: true }), `expected null for Shift+${key}`).toBeNull();
    }
  });

  it('accelFromEvent returns null for all Dead* variant key names', () => {
    for (const key of ['Dead`', "Dead'", 'Dead~', 'Dead^', 'Dead"']) {
      expect(accelFromEvent({ key })).toBeNull();
      expect(accelFromEvent({ key, shiftKey: true })).toBeNull();
    }
  });

  it('BLOCKED_KEYS does NOT contain normal bindable keys', () => {
    // Sanity check: none of these should be blocked.
    for (const k of [
      'F1', 'F12', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'Tab', 'Backspace', 'Return', 'Space', 'Left', 'Right', 'Up', 'Down',
      'A', 'Z', '0', '9',
    ]) {
      expect(BLOCKED_KEYS.has(k), `expected "${k}" to NOT be blocked`).toBe(false);
    }
  });
});

// ── prettyAccel ──────────────────────────────────────────────────────────────

describe('prettyAccel', () => {
  it('renders CommandOrControl as Ctrl off Mac and Cmd on Mac', () => {
    expect(prettyAccel('CommandOrControl+K', false)).toBe('Ctrl + K');
    expect(prettyAccel('CommandOrControl+K', true)).toBe('Cmd + K');
  });

  it('spaces out every + separator', () => {
    expect(prettyAccel('CommandOrControl+Alt+Shift+K', false)).toBe('Ctrl + Alt + Shift + K');
    expect(prettyAccel('Shift+F1', false)).toBe('Shift + F1');
  });

  it('leaves a separator-free accelerator untouched', () => {
    expect(prettyAccel('Space', false)).toBe('Space');
    expect(prettyAccel('', false)).toBe('');
  });
});

// ── collectChannels ──────────────────────────────────────────────────────────

describe('collectChannels', () => {
  it('always includes the four defaults, sorted', () => {
    expect(collectChannels([])).toEqual(['Events', 'General', 'Raids', 'Trading']);
  });

  it('Title-cases raw uppercase labels', () => {
    expect(collectChannels(['RAIDS', 'EVENTS'])).toEqual(['Events', 'General', 'Raids', 'Trading']);
    expect(collectChannels(['NUKAWORLD'])).toContain('Nukaworld');
  });

  it('dedupes against defaults regardless of casing', () => {
    const out = collectChannels(['general', 'GENERAL', 'General']);
    expect(out.filter(c => c === 'General')).toHaveLength(1);
  });

  it('trims whitespace and drops empties', () => {
    const out = collectChannels(['  ', '', '  squad  ']);
    expect(out).toContain('Squad');
    expect(out).not.toContain('');
  });

  it('sorts merged set with locale compare', () => {
    const out = collectChannels(['alpha', 'zulu']);
    expect(out).toEqual([...out].sort((a, b) => a.localeCompare(b)));
    expect(out[0]).toBe('Alpha');
  });
});

// ── nextNavIndex ─────────────────────────────────────────────────────────────

describe('nextNavIndex', () => {
  it('returns -1 (no-op signal) when there are zero tabs', () => {
    expect(nextNavIndex(0, 1, 0)).toBe(-1);
    expect(nextNavIndex(3, -1, 0)).toBe(-1);
  });

  it('advances and wraps forward', () => {
    expect(nextNavIndex(0, 1, 4)).toBe(1);
    expect(nextNavIndex(3, 1, 4)).toBe(0); // wrap past end
  });

  it('advances and wraps backward', () => {
    expect(nextNavIndex(1, -1, 4)).toBe(0);
    expect(nextNavIndex(0, -1, 4)).toBe(3); // wrap before start
  });

  it('clamps a negative current index to 0 first', () => {
    expect(nextNavIndex(-1, 1, 4)).toBe(1);
    expect(nextNavIndex(-5, -1, 4)).toBe(3);
  });

  it('with a single tab always lands on 0', () => {
    expect(nextNavIndex(0, 1, 1)).toBe(0);
    expect(nextNavIndex(0, -1, 1)).toBe(0);
  });
});

// ── scaleZoomValue ───────────────────────────────────────────────────────────

describe('scaleZoomValue', () => {
  it('returns "" (unset) at the base font size', () => {
    expect(scaleZoomValue(BASE_FONT)).toBe('');
  });

  it('returns "" within the unset epsilon of 1.0', () => {
    // 14.05/14 = 1.00357 → within 0.005
    expect(scaleZoomValue(14.05)).toBe('');
  });

  it('returns the scale string when meaningfully different from 1', () => {
    expect(scaleZoomValue(28)).toBe('2'); // 28/14 = 2
    expect(scaleZoomValue(7)).toBe('0.5'); // 7/14 = 0.5
  });

  it('clamps to SCALE_MIN .. SCALE_MAX', () => {
    expect(scaleZoomValue(1)).toBe('0.5');   // 1/14 ≈ 0.07 → floored to 0.5
    expect(scaleZoomValue(1000)).toBe('2.5'); // huge → capped at 2.5
  });
});

// ── opacity / intensity clamps ───────────────────────────────────────────────

describe('chromeBgAlpha', () => {
  it('clamps to 0..1', () => {
    expect(chromeBgAlpha(0.5)).toBe(0.5);
    expect(chromeBgAlpha(-1)).toBe(0);
    expect(chromeBgAlpha(2)).toBe(1);
  });
});

describe('textOpacityValue', () => {
  it('floors at 0.1 and caps at 1 (never fully invisible)', () => {
    expect(textOpacityValue(0.7)).toBe(0.7);
    expect(textOpacityValue(0)).toBe(0.1);
    expect(textOpacityValue(-3)).toBe(0.1);
    expect(textOpacityValue(5)).toBe(1);
  });
});

describe('scanlineOpacityValue', () => {
  it('clamps to 0..1', () => {
    expect(scanlineOpacityValue(0.3)).toBe(0.3);
    expect(scanlineOpacityValue(-0.5)).toBe(0);
    expect(scanlineOpacityValue(1.5)).toBe(1);
  });
});

describe('clampIdleCollapseSeconds', () => {
  it('passes through in-range values (rounded)', () => {
    expect(clampIdleCollapseSeconds(25)).toBe(25);
    expect(clampIdleCollapseSeconds(60)).toBe(60);
    expect(clampIdleCollapseSeconds(40.4)).toBe(40);
    expect(clampIdleCollapseSeconds(40.6)).toBe(41);
  });
  it('clamps below min and above max', () => {
    expect(clampIdleCollapseSeconds(0)).toBe(IDLE_COLLAPSE_SECONDS_MIN);
    expect(clampIdleCollapseSeconds(-10)).toBe(IDLE_COLLAPSE_SECONDS_MIN);
    expect(clampIdleCollapseSeconds(9999)).toBe(IDLE_COLLAPSE_SECONDS_MAX);
  });
  it('falls back to the default for non-finite / missing values', () => {
    expect(clampIdleCollapseSeconds(NaN)).toBe(IDLE_COLLAPSE_SECONDS_DEFAULT);
    expect(clampIdleCollapseSeconds(Infinity)).toBe(IDLE_COLLAPSE_SECONDS_DEFAULT);
    expect(clampIdleCollapseSeconds(undefined)).toBe(IDLE_COLLAPSE_SECONDS_DEFAULT);
    expect(clampIdleCollapseSeconds(null)).toBe(IDLE_COLLAPSE_SECONDS_DEFAULT);
  });
});

describe('shellToWebSettings (mirror)', () => {
  const input = {
    themeId: 'amber',
    textOpacity: 0.7,
    showHints: false,
    showTimestamps: true,
    timestampFormat: '24h' as const,
    channelFilters: ['Trading', 'Events'],
  };
  it('carries the message-timestamp prefs into the mirror (regression: were dropped on reload)', () => {
    const w = shellToWebSettings(input);
    expect(w.showTimestamps).toBe(true);
    expect(w.timestampFormat).toBe('24h');
  });
  it('carries (a copy of) channelFilters into the mirror', () => {
    const w = shellToWebSettings(input);
    expect(w.channelFilters).toEqual(['Trading', 'Events']);
    expect(w.channelFilters).not.toBe(input.channelFilters); // copied, not aliased
  });
  it('forces windowOpacity=1 and base font (shell drives those itself)', () => {
    const w = shellToWebSettings(input);
    expect(w.windowOpacity).toBe(1);
    expect(w.fontSize).toBe(BASE_FONT);
  });
  it('passes through theme / textOpacity / showHints', () => {
    const w = shellToWebSettings(input);
    expect(w.themeId).toBe('amber');
    expect(w.textOpacity).toBe(0.7);
    expect(w.showHints).toBe(false);
  });
});

describe('resolveCollapsedHeight (idle-collapse zoom math)', () => {
  const bounds = { safeVisual: 62, minVisual: 24, maxVisual: 160 };
  // shell bar ~22px; sub-tab strip ~45 raw px below host top at the user's scale.

  it('modern Chromium (rects already scaled): NO double-apply at zoom > 1', () => {
    // rectToVisual=1 → header = rawDelta as-is. At a 1.5 scale the rawDelta is
    // already the visual 66px, so the window is 22+66+1 = 89, NOT 22+99+1.
    const h = resolveCollapsedHeight({ barH: 22, rawDelta: 66, rectToVisual: 1, ...bounds });
    expect(h).toBe(89);
  });

  it('the OLD bug: multiplying scaled rects again would over-tall the window', () => {
    // Demonstrates the regression we fixed — same measurement, wrong factor (1.5)
    // pushes 66 → 99 (in-band) → a 22+99+1 = 122px window that reveals the input.
    const buggy = resolveCollapsedHeight({ barH: 22, rawDelta: 66, rectToVisual: 1.5, ...bounds });
    const fixed = resolveCollapsedHeight({ barH: 22, rawDelta: 66, rectToVisual: 1, ...bounds });
    expect(buggy).toBeGreaterThan(fixed);
  });

  it('legacy Chromium (unscaled rects): zoom factor IS applied', () => {
    // rawDelta is unscaled CSS-px (44); ×1.5 → 66 visual → 22+66+1 = 89.
    expect(resolveCollapsedHeight({ barH: 22, rawDelta: 44, rectToVisual: 1.5, ...bounds })).toBe(89);
  });

  it('falls back to the safe height when unmeasurable (null) or out of band', () => {
    expect(resolveCollapsedHeight({ barH: 22, rawDelta: null, rectToVisual: 1, ...bounds })).toBe(22 + 62 + 1);
    // 400 visual is above maxVisual(160) → safe fallback (never reveal the body).
    expect(resolveCollapsedHeight({ barH: 22, rawDelta: 400, rectToVisual: 1, ...bounds })).toBe(22 + 62 + 1);
    // 5 visual is below minVisual(24) → safe fallback.
    expect(resolveCollapsedHeight({ barH: 22, rawDelta: 5, rectToVisual: 1, ...bounds })).toBe(22 + 62 + 1);
  });
});

// ── computeResizeBounds ──────────────────────────────────────────────────────

describe('computeResizeBounds', () => {
  const start: Bounds = { x: 100, y: 100, width: 800, height: 600 };

  it('east edge changes width only', () => {
    expect(computeResizeBounds(['e'], start, 50, 999)).toEqual({
      x: 100, y: 100, width: 850, height: 600,
    });
  });

  it('south edge changes height only', () => {
    expect(computeResizeBounds(['s'], start, 999, 40)).toEqual({
      x: 100, y: 100, width: 800, height: 640,
    });
  });

  it('north edge moves y and shrinks height by dy', () => {
    expect(computeResizeBounds(['n'], start, 0, 30)).toEqual({
      x: 100, y: 130, width: 800, height: 570,
    });
    // Negative dy grows upward.
    expect(computeResizeBounds(['n'], start, 0, -30)).toEqual({
      x: 100, y: 70, width: 800, height: 630,
    });
  });

  it('west edge moves x and shrinks width by dx', () => {
    expect(computeResizeBounds(['w'], start, 25, 0)).toEqual({
      x: 125, y: 100, width: 775, height: 600,
    });
  });

  it('NW corner combines north + west deltas', () => {
    expect(computeResizeBounds(['n', 'w'], start, 20, 30)).toEqual({
      x: 120, y: 130, width: 780, height: 570,
    });
  });

  it('SE corner combines south + east deltas', () => {
    expect(computeResizeBounds(['s', 'e'], start, 20, 30)).toEqual({
      x: 100, y: 100, width: 820, height: 630,
    });
  });

  it('clamps east-only width to the minimum without moving x', () => {
    const out = computeResizeBounds(['e'], start, -10000, 0);
    expect(out.width).toBe(RESIZE_MIN_WIDTH);
    expect(out.x).toBe(100);
  });

  it('clamps west width to min and re-anchors x to the right edge', () => {
    // Right edge = x+width = 900; dragging west past min must keep it at 900.
    const out = computeResizeBounds(['w'], start, 10000, 0);
    expect(out.width).toBe(RESIZE_MIN_WIDTH);
    expect(out.x).toBe(900 - RESIZE_MIN_WIDTH);
  });

  it('clamps north height to min and re-anchors y to the bottom edge', () => {
    // Bottom edge = y+height = 700; dragging north past min must keep it at 700.
    const out = computeResizeBounds(['n'], start, 0, 10000);
    expect(out.height).toBe(RESIZE_MIN_HEIGHT);
    expect(out.y).toBe(700 - RESIZE_MIN_HEIGHT);
  });

  it('clamps south height to min without moving y', () => {
    const out = computeResizeBounds(['s'], start, 0, -10000);
    expect(out.height).toBe(RESIZE_MIN_HEIGHT);
    expect(out.y).toBe(100);
  });

  it('honors custom min width/height args', () => {
    const out = computeResizeBounds(['e', 's'], start, -10000, -10000, 200, 150);
    expect(out.width).toBe(200);
    expect(out.height).toBe(150);
  });

  it('returns raw (un-rounded) values', () => {
    const out = computeResizeBounds(['e'], start, 0.7, 0);
    expect(out.width).toBeCloseTo(800.7);
  });
});

// ── isDragTarget ─────────────────────────────────────────────────────────────

// Build a fake DragTargetEl chain without a real DOM. The last element is the
// `stop` sentinel (document root) — the walk excludes it.
function makeEl(props: {
  classes?: string[];
  tag?: string;
  contentEditable?: boolean;
  id?: string;
  appRegion?: string;
  parent?: DragTargetEl | null;
}): DragTargetEl {
  return {
    classList: { contains: (t: string) => (props.classes ?? []).includes(t) },
    tagName: props.tag ?? 'DIV',
    isContentEditable: props.contentEditable ?? false,
    id: props.id ?? '',
    style: { webkitAppRegion: props.appRegion } as DragTargetEl['style'],
    parentElement: props.parent ?? null,
  };
}

describe('isDragTarget', () => {
  const root = makeEl({ id: 'root-sentinel' });

  it('returns false for null target', () => {
    expect(isDragTarget(null, root)).toBe(false);
  });

  it('returns true for #shell-bar', () => {
    const bar = makeEl({ id: 'shell-bar', parent: root });
    expect(isDragTarget(bar, root)).toBe(true);
  });

  it('returns true for an element with inline webkitAppRegion drag', () => {
    const row = makeEl({ appRegion: 'drag', parent: root });
    expect(isDragTarget(row, root)).toBe(true);
  });

  it('walks ancestors up to (not including) the stop sentinel', () => {
    const bar = makeEl({ id: 'shell-bar', parent: root });
    const child = makeEl({ tag: 'SPAN', parent: bar });
    expect(isDragTarget(child, root)).toBe(true);
  });

  it('stops at the sentinel and returns false when nothing matched', () => {
    const plain = makeEl({ tag: 'SPAN', parent: root });
    expect(isDragTarget(plain, root)).toBe(false);
  });

  it('opts out for resize zones (.shell-rz)', () => {
    const rz = makeEl({ classes: ['shell-rz'], parent: root });
    expect(isDragTarget(rz, root)).toBe(false);
  });

  it('opts out for shell buttons (.shell-btn)', () => {
    const btn = makeEl({ classes: ['shell-btn'], parent: root });
    expect(isDragTarget(btn, root)).toBe(false);
  });

  it('opts out for interactive tags', () => {
    for (const tag of ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']) {
      expect(isDragTarget(makeEl({ tag, parent: root }), root)).toBe(false);
    }
  });

  it('opts out for contentEditable elements', () => {
    const ce = makeEl({ contentEditable: true, parent: root });
    expect(isDragTarget(ce, root)).toBe(false);
  });

  it('opts out for modal backdrops', () => {
    for (const id of ['shell-settings-backdrop', 'shell-onboarding-backdrop']) {
      expect(isDragTarget(makeEl({ id, parent: root }), root)).toBe(false);
    }
  });

  it('an opt-out ancestor wins even under a drag-eligible header', () => {
    // child INPUT inside #shell-bar: the INPUT (hit first) opts out.
    const bar = makeEl({ id: 'shell-bar', parent: root });
    const input = makeEl({ tag: 'INPUT', parent: bar });
    expect(isDragTarget(input, root)).toBe(false);
  });

  it('a button nested inside a drag row still opts out (button reached first)', () => {
    const row = makeEl({ appRegion: 'drag', parent: root });
    const btn = makeEl({ tag: 'BUTTON', parent: row });
    expect(isDragTarget(btn, root)).toBe(false);
  });
});

// ── shouldExitTextEntryOnEscape ──────────────────────────────────────────────

describe('shouldExitTextEntryOnEscape', () => {
  const root = makeEl({ id: 'root-sentinel' });
  const host = makeEl({ id: 'shell-overlay-host', parent: root });

  it('returns true for bare Escape from the chat textarea inside the overlay host', () => {
    const textarea = makeEl({ tag: 'TEXTAREA', parent: host });
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', target: textarea })).toBe(true);
  });

  it('returns true for bare Escape from a contentEditable chat input descendant', () => {
    const richInput = makeEl({ contentEditable: true, parent: host });
    const child = makeEl({ tag: 'SPAN', parent: richInput });
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', target: child })).toBe(true);
  });

  it('returns false for Escape outside the overlay host', () => {
    const textarea = makeEl({ tag: 'TEXTAREA', parent: root });
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', target: textarea })).toBe(false);
  });

  it('returns false for Escape in settings or onboarding inputs', () => {
    for (const id of ['shell-settings-backdrop', 'shell-onboarding-backdrop']) {
      const backdrop = makeEl({ id, parent: root });
      const input = makeEl({ tag: 'INPUT', parent: backdrop });
      expect(shouldExitTextEntryOnEscape({ key: 'Escape', target: input })).toBe(false);
    }
  });

  it('returns false for non-editable overlay UI', () => {
    const span = makeEl({ tag: 'SPAN', parent: host });
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', target: span })).toBe(false);
  });

  it('returns false for modified Escape chords', () => {
    const textarea = makeEl({ tag: 'TEXTAREA', parent: host });
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', shiftKey: true, target: textarea })).toBe(false);
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', ctrlKey: true, target: textarea })).toBe(false);
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', altKey: true, target: textarea })).toBe(false);
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', metaKey: true, target: textarea })).toBe(false);
  });

  it('returns false for non-Escape keys and already-handled events', () => {
    const textarea = makeEl({ tag: 'TEXTAREA', parent: host });
    expect(shouldExitTextEntryOnEscape({ key: 'Enter', target: textarea })).toBe(false);
    expect(shouldExitTextEntryOnEscape({ key: 'Escape', defaultPrevented: true, target: textarea })).toBe(false);
  });
});

// ── exported constants sanity ────────────────────────────────────────────────

describe('shared constants', () => {
  it('match the values used by shell.ts / main.js', () => {
    expect(BASE_FONT).toBe(14);
    expect(RESIZE_MIN_WIDTH).toBe(320);
    expect(RESIZE_MIN_HEIGHT).toBe(280);
  });

  it('ResizeEdge type accepts the four edges (compile-time)', () => {
    const edges: ResizeEdge[] = ['n', 's', 'e', 'w'];
    expect(edges).toHaveLength(4);
  });
});

// ── detectLinuxRenderer (drag/resize gate, navigator.platform hardening) ─────
describe('detectLinuxRenderer', () => {
  it('detects Linux from navigator.platform', () => {
    expect(detectLinuxRenderer('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(true);
  });
  it('falls back to the userAgent when platform is reduced to empty (Electron 39+)', () => {
    expect(detectLinuxRenderer('', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit')).toBe(true);
    expect(detectLinuxRenderer(null, 'X11; Linux x86_64')).toBe(true);
  });
  it('is false on Windows / macOS', () => {
    expect(detectLinuxRenderer('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(detectLinuxRenderer('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)')).toBe(false);
  });
  it('is false when both inputs are empty/nullish', () => {
    expect(detectLinuxRenderer('', '')).toBe(false);
    expect(detectLinuxRenderer(null, undefined)).toBe(false);
  });
});
