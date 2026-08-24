// Unit tests for Hyprland hyprctl helpers in overlay-core.
// Pure JSON/argv only - no hyprctl binary required. Covers the foreground
// probe shape, stdout parsing (including fail-closed malformed JSON),
// clients-list lookup for FO76 position + overlay address, and the
// hyprland branch of preferredForegroundTools.

import core from '../overlay-core.js';

const {
  buildForegroundProbe,
  parseForegroundOutput,
  findHyprctlClient,
  getHyprlandPinState,
  preferredForegroundTools,
} = core;

describe('buildForegroundProbe', () => {
  it('hyprctl uses activewindow -j (JSON)', () => {
    expect(buildForegroundProbe('hyprctl')).toEqual({ cmd: 'hyprctl', args: ['activewindow', '-j'] });
  });

  it('kdotool keeps the chained getactivewindow getwindowclassname argv', () => {
    expect(buildForegroundProbe('kdotool')).toEqual({
      cmd: 'kdotool', args: ['getactivewindow', 'getwindowclassname'],
    });
  });

  it('xdotool keeps the chained getactivewindow getwindowclassname argv', () => {
    expect(buildForegroundProbe('xdotool')).toEqual({
      cmd: 'xdotool', args: ['getactivewindow', 'getwindowclassname'],
    });
  });
});

describe('parseForegroundOutput', () => {
  it('hyprctl extracts class from JSON and lowercases it', () => {
    expect(parseForegroundOutput('hyprctl', '{"class":"steam_app_1151340"}')).toBe('steam_app_1151340');
  });

  it('hyprctl "null" (nothing focused) → empty string', () => {
    expect(parseForegroundOutput('hyprctl', 'null')).toBe('');
  });

  it('hyprctl empty stdout → empty string', () => {
    expect(parseForegroundOutput('hyprctl', '')).toBe('');
  });

  it('hyprctl malformed JSON → empty string (must not throw)', () => {
    expect(() => parseForegroundOutput('hyprctl', 'not json{{{')).not.toThrow();
    expect(parseForegroundOutput('hyprctl', 'not json{{{')).toBe('');
  });

  it('xdotool bare class is lowercased (existing behavior preserved)', () => {
    expect(parseForegroundOutput('xdotool', 'Fallout76\n')).toBe('fallout76');
  });
});

const GAME_PATTERN = 'Fallout76|steam_app_1151340';
const OVERLAY_PATTERN = 'fallout-chat-mod';

describe('findHyprctlClient', () => {
  it('returns the matching client object (position and address both readable)', () => {
    const json = JSON.stringify([
      { class: 'kitty', at: [0, 0], address: '0xaaa' },
      { class: 'steam_app_1151340', at: [1920, 108], address: '0xbbb' },
    ]);
    expect(findHyprctlClient(json, GAME_PATTERN)).toEqual({ class: 'steam_app_1151340', at: [1920, 108], address: '0xbbb' });
  });

  it('matches the overlay by its own class pattern', () => {
    const json = JSON.stringify([
      { class: 'kitty', at: [0, 0], address: '0xaaa' },
      { class: 'fallout-chat-mod', at: [100, 200], address: '0x61e0a0c0e080' },
    ]);
    expect(findHyprctlClient(json, OVERLAY_PATTERN).address).toBe('0x61e0a0c0e080');
  });

  it('returns null when no client matches the class pattern', () => {
    const json = JSON.stringify([{ class: 'kitty', at: [0, 0] }]);
    expect(findHyprctlClient(json, GAME_PATTERN)).toBeNull();
  });

  it('returns null on malformed JSON (must not throw)', () => {
    expect(() => findHyprctlClient('not json{{{', GAME_PATTERN)).not.toThrow();
    expect(findHyprctlClient('not json{{{', GAME_PATTERN)).toBeNull();
  });

  it('returns null on an empty clients array', () => {
    expect(findHyprctlClient('[]', GAME_PATTERN)).toBeNull();
  });
});

describe('getHyprlandPinState', () => {
  it('returns the reported boolean pin state', () => {
    expect(getHyprlandPinState({ pinned: true })).toBe(true);
    expect(getHyprlandPinState({ pinned: false })).toBe(false);
  });

  it('returns unknown when the compositor omits or corrupts the field', () => {
    expect(getHyprlandPinState({})).toBeNull();
    expect(getHyprlandPinState(null)).toBeNull();
    expect(getHyprlandPinState({ pinned: 'true' })).toBeNull();
  });
});

describe('preferredForegroundTools', () => {
  it('Hyprland prefers hyprctl only', () => {
    expect(preferredForegroundTools({ hyprland: true, kdeWayland: false, x11: false })).toEqual(['hyprctl']);
  });

  it('hyprland wins even if kdeWayland/x11 are also set', () => {
    expect(preferredForegroundTools({ hyprland: true, kdeWayland: true, x11: true })).toEqual(['hyprctl']);
  });

  it('KDE-Wayland prefers kdotool then xdotool (unchanged)', () => {
    expect(preferredForegroundTools({ kdeWayland: true, x11: false })).toEqual(['kdotool', 'xdotool']);
  });

  it('X11 prefers xdotool then kdotool (unchanged)', () => {
    expect(preferredForegroundTools({ kdeWayland: false, x11: true })).toEqual(['xdotool', 'kdotool']);
  });

  it('returns empty when no session type applies (unchanged)', () => {
    expect(preferredForegroundTools({ kdeWayland: false, x11: false })).toEqual([]);
  });
});
