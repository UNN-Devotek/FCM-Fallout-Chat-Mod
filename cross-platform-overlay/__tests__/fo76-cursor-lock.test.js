// Unit tests for the FO76 in-game cursor-lock tray action (Linux).
//
// Scope: the overlay never writes to Fallout 76's Proton/Wine prefix
// automatically (not on install, not on launch) — it's applied ONLY when the
// user explicitly presses the tray's "Fix in-game cursor lock" action. These
// tests cover the pure helpers in overlay-core.js (protontricks argv/regex/
// status-copy) plus a source-text guard confirming the tray wiring in
// main.js hasn't silently regressed. See docs/overlay/linux-overlay-approaches.md.
//
// Runner: vitest (environment 'node').

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';
import core from '../overlay-core.js';

const {
  FO76_APPID,
  buildFo76GrabPointerRegArgs,
  protontricksIndicatesNoPrefix,
  cursorLockStatusMessage,
} = core;

describe('FO76_APPID', () => {
  it('is the Fallout 76 Steam app id', () => {
    expect(FO76_APPID).toBe('1151340');
  });
});

describe('buildFo76GrabPointerRegArgs', () => {
  const args = buildFo76GrabPointerRegArgs();

  it('targets the FO76 prefix via -c (raw wine command)', () => {
    expect(args[0]).toBe('-c');
    expect(args).toContain(FO76_APPID);
  });

  it('writes GrabPointer=Y as a REG_SZ under the X11 Driver key', () => {
    const cmd = args.find((a) => typeof a === 'string' && a.includes('wine reg add'));
    expect(cmd).toContain('HKCU\\Software\\Wine\\X11 Driver');
    expect(cmd).toContain('/v GrabPointer');
    expect(cmd).toContain('/t REG_SZ');
    expect(cmd).toContain('/d Y');
    expect(cmd).toContain('/f');
  });

  it('flushes with wineserver -w (Wine only persists user.reg on shutdown)', () => {
    const cmd = args.find((a) => typeof a === 'string' && a.includes('wine reg add'));
    expect(cmd).toContain('wineserver -w');
  });
});

describe('protontricksIndicatesNoPrefix', () => {
  it('detects the common "no prefix" protontricks outputs', () => {
    expect(protontricksIndicatesNoPrefix('No Proton app was found for 1151340')).toBe(true);
    expect(protontricksIndicatesNoPrefix('Steam is not running')).toBe(true);
    expect(protontricksIndicatesNoPrefix('could not find the game')).toBe(true);
    expect(protontricksIndicatesNoPrefix('No installed games found')).toBe(true);
  });

  it('is false for normal/successful output', () => {
    expect(protontricksIndicatesNoPrefix('Executing grabfullscreen=y')).toBe(false);
    expect(protontricksIndicatesNoPrefix('')).toBe(false);
  });

  it('tolerates non-string / undefined input', () => {
    expect(protontricksIndicatesNoPrefix(undefined)).toBe(false);
    expect(protontricksIndicatesNoPrefix(null)).toBe(false);
  });
});

describe('cursorLockStatusMessage', () => {
  it('applied — info dialog confirming both registry values', () => {
    const { type, message, detail } = cursorLockStatusMessage('applied');
    expect(type).toBe('info');
    expect(message).toMatch(/enabled/i);
    expect(detail).toMatch(/GrabFullscreen/);
    expect(detail).toMatch(/GrabPointer/);
  });

  it('fo76-running — warns to close the game first', () => {
    const { type, message } = cursorLockStatusMessage('fo76-running');
    expect(type).toBe('warning');
    expect(message).toMatch(/running/i);
  });

  it('no-protontricks — warns it must be installed', () => {
    const { type, message, detail } = cursorLockStatusMessage('no-protontricks');
    expect(type).toBe('warning');
    expect(message).toMatch(/protontricks/i);
    expect(detail).toMatch(/pacman|dnf|pipx/);
  });

  it('no-prefix — warns to launch FO76 once first', () => {
    const { type, message } = cursorLockStatusMessage('no-prefix');
    expect(type).toBe('warning');
    expect(message).toMatch(/prefix/i);
  });

  it('error (and any unrecognized status) — error dialog carrying the detail through', () => {
    const { type, detail } = cursorLockStatusMessage('error', 'boom');
    expect(type).toBe('error');
    expect(detail).toBe('boom');
    expect(cursorLockStatusMessage('something-unexpected').type).toBe('error');
  });
});

// ── Source-text guard: the tray wiring must stay intact ─────────────────────
// main.js can't be imported directly (it creates Electron windows), so this
// guards against a silent regression the way no-autoupdate.test.js does.
describe('main.js — tray wiring for the cursor-lock action', () => {
  const ROOT = resolve(import.meta.dirname, '..');
  const src = readFileSync(join(ROOT, 'main.js'), 'utf8');

  it('defines the tray-triggered apply/fix functions', () => {
    expect(src).toContain('function fo76IsRunning');
    expect(src).toContain('function findProtontricks');
    expect(src).toContain('function applyFo76Grab');
    expect(src).toContain('function fixFo76CursorLock');
  });

  it('exposes the action as an explicit tray menu item (not automatic)', () => {
    expect(src).toContain("label: 'Fix FO76 cursor lock (Wayland)'");
    expect(src).toContain('click: () => fixFo76CursorLock()');
  });

  it('is gated inside the IS_LINUX-only tray block', () => {
    const trayItemIdx = src.indexOf("label: 'Fix FO76 cursor lock");
    const linuxBlockIdx = src.lastIndexOf('...(IS_LINUX ? [', trayItemIdx);
    expect(trayItemIdx).toBeGreaterThan(-1);
    expect(linuxBlockIdx).toBeGreaterThan(-1);
  });

  it('is not invoked anywhere during app.whenReady() startup (never automatic)', () => {
    const readyIdx = src.indexOf('app.whenReady()');
    const readyBlock = src.slice(readyIdx, readyIdx + 3000);
    expect(readyBlock).not.toContain('fixFo76CursorLock()');
    expect(readyBlock).not.toContain('applyFo76Grab()');
  });
});
