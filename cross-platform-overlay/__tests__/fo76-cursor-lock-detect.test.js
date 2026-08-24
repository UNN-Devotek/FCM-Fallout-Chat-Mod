// Unit tests for FO76 cursor-lock detection (read-only prefix check).
//
// Scope: parse Wine user.reg GrabFullscreen/GrabPointer, decide whether the
// one-time Wayland notification should fire, and assemble candidate prefix
// paths. No writes, no filesystem, no protontricks. The write path stays
// applyFo76Grab via an explicit click (tray or notification). See
// docs/overlay/linux-overlay-approaches.md.
//
// Runner: vitest (environment 'node').

import { join } from 'path';
import { describe, it, expect } from 'vitest';
import core from '../overlay-core.js';

const {
  FO76_APPID,
  fo76UserRegCandidates,
  parseWineGrabSettings,
  shouldPromptCursorLock,
} = core;

function x11DriverSection(keys) {
  const lines = ['[Software\\\\Wine\\\\X11 Driver] 1787385377', '#time=1dd320bb6901bfe'];
  for (const [k, v] of keys) lines.push(`"${k}"="${v}"`);
  return lines.join('\n');
}

describe('parseWineGrabSettings', () => {
  it('both set (GrabFullscreen=Y and GrabPointer=Y) → both true', () => {
    const text = x11DriverSection([
      ['GrabFullscreen', 'Y'],
      ['GrabPointer', 'Y'],
    ]);
    expect(parseWineGrabSettings(text)).toEqual({ grabFullscreen: true, grabPointer: true });
  });

  it('accepts lowercase y from winetricks grabfullscreen=y', () => {
    const text = x11DriverSection([
      ['GrabFullscreen', 'y'],
      ['GrabPointer', 'Y'],
    ]);
    expect(parseWineGrabSettings(text)).toEqual({ grabFullscreen: true, grabPointer: true });
  });

  it('one set / one absent', () => {
    const onlyFull = x11DriverSection([['GrabFullscreen', 'Y']]);
    expect(parseWineGrabSettings(onlyFull)).toEqual({ grabFullscreen: true, grabPointer: false });
    const onlyPtr = x11DriverSection([['GrabPointer', 'Y']]);
    expect(parseWineGrabSettings(onlyPtr)).toEqual({ grabFullscreen: false, grabPointer: true });
  });

  it('neither set (GrabFullscreen=N)', () => {
    const text = x11DriverSection([
      ['GrabFullscreen', 'N'],
      ['GrabPointer', 'N'],
    ]);
    expect(parseWineGrabSettings(text)).toEqual({ grabFullscreen: false, grabPointer: false });
  });

  it('section entirely absent → both false', () => {
    const text = [
      'WINE REGISTRY Version 2',
      '[Software\\\\Wine\\\\DllOverrides] 1769000000',
      '"d3d11"="native,builtin"',
    ].join('\n');
    expect(parseWineGrabSettings(text)).toEqual({ grabFullscreen: false, grabPointer: false });
  });

  it('malformed / garbage text → both false, does not throw', () => {
    expect(() => parseWineGrabSettings('{ this is not a reg file [[[')).not.toThrow();
    expect(parseWineGrabSettings('{ this is not a reg file [[[')).toEqual({
      grabFullscreen: false,
      grabPointer: false,
    });
  });

  it('empty string → both false', () => {
    expect(parseWineGrabSettings('')).toEqual({ grabFullscreen: false, grabPointer: false });
  });

  it('null / undefined input → does not throw, both false', () => {
    expect(() => parseWineGrabSettings(null)).not.toThrow();
    expect(() => parseWineGrabSettings(undefined)).not.toThrow();
    expect(parseWineGrabSettings(null)).toEqual({ grabFullscreen: false, grabPointer: false });
    expect(parseWineGrabSettings(undefined)).toEqual({ grabFullscreen: false, grabPointer: false });
  });

  it('realistic multi-section user.reg does not leak values across section boundaries', () => {
    const text = [
      'WINE REGISTRY Version 2',
      ';; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000',
      '',
      '[Software\\\\Wine\\\\AppDefaults\\\\Fallout76.exe\\\\X11 Driver] 1767580384',
      '#time=1dc7deb9ebf1018',
      '"GrabFullscreen"="Y"',
      '"GrabPointer"="Y"',
      '',
      '[Software\\\\Wine\\\\DllOverrides] 1769000000',
      '#time=1dc800000000000',
      '"d3d11"="native,builtin"',
      '"GrabFullscreen"="Y"',
      '"GrabPointer"="Y"',
      '',
      '[Software\\\\Wine\\\\X11 Driver] 1787385377',
      '#time=1dd320bb6901bfe',
      '"GrabFullscreen"="Y"',
      '"UseTakeFocus"="N"',
      '',
      '[Software\\\\Wine\\\\Direct3D] 1769123999',
      '#time=1dc8a3b4c5d6e7f1',
      '"GrabPointer"="Y"',
      '"csmt"="0x1"',
    ].join('\n');
    expect(parseWineGrabSettings(text)).toEqual({ grabFullscreen: true, grabPointer: false });
  });
});

describe('shouldPromptCursorLock', () => {
  const missing = { grabFullscreen: false, grabPointer: false, alreadyPrompted: false };

  it('wayland:false → always false regardless of other params', () => {
    expect(shouldPromptCursorLock({ wayland: false, ...missing })).toBe(false);
    expect(shouldPromptCursorLock({
      wayland: false, grabFullscreen: false, grabPointer: false, alreadyPrompted: false,
    })).toBe(false);
    expect(shouldPromptCursorLock({
      wayland: false, grabFullscreen: true, grabPointer: true, alreadyPrompted: false,
    })).toBe(false);
  });

  it('alreadyPrompted:true → always false', () => {
    expect(shouldPromptCursorLock({
      wayland: true, grabFullscreen: false, grabPointer: false, alreadyPrompted: true,
    })).toBe(false);
    expect(shouldPromptCursorLock({
      wayland: true, grabFullscreen: true, grabPointer: true, alreadyPrompted: true,
    })).toBe(false);
  });

  it('wayland + not yet prompted, both grab settings true → false', () => {
    expect(shouldPromptCursorLock({
      wayland: true, grabFullscreen: true, grabPointer: true, alreadyPrompted: false,
    })).toBe(false);
  });

  it('wayland + not yet prompted, one or both grab settings false → true', () => {
    expect(shouldPromptCursorLock({
      wayland: true, grabFullscreen: false, grabPointer: true, alreadyPrompted: false,
    })).toBe(true);
    expect(shouldPromptCursorLock({
      wayland: true, grabFullscreen: true, grabPointer: false, alreadyPrompted: false,
    })).toBe(true);
    expect(shouldPromptCursorLock({
      wayland: true, grabFullscreen: false, grabPointer: false, alreadyPrompted: false,
    })).toBe(true);
  });
});

describe('fo76UserRegCandidates', () => {
  const home = '/fake/home';
  const steam = join(home, '.steam', 'steam', 'steamapps', 'compatdata', FO76_APPID, 'pfx', 'user.reg');
  const xdg = join(home, '.local', 'share', 'Steam', 'steamapps', 'compatdata', FO76_APPID, 'pfx', 'user.reg');

  it('assembles the two common Steam library paths from a fake home dir', () => {
    const got = fo76UserRegCandidates(home);
    expect(got).toContain(steam);
    expect(got).toContain(xdg);
    expect(got).toHaveLength(2);
  });
});
