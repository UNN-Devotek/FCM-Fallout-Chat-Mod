// Tests for the FO76 Wine mouse-grab helpers — the cursor-lock fix for KWin Wayland.
// buildFo76GrabUserReg() is a pure, idempotent edit of a Proton prefix's user.reg that
// enables Wine's own mouse capture (GrabFullscreen/GrabPointer). See
// docs/overlay/linux-overlay-approaches.md.
import { describe, it, expect } from 'vitest';
import core from '../overlay-core.js';

describe('fo76UserRegCandidates', () => {
  it('maps Steam roots to the FO76 compatdata user.reg path', () => {
    const out = core.fo76UserRegCandidates(['/home/u/.local/share/Steam', '/mnt/lib/SteamLibrary/']);
    expect(out).toEqual([
      '/home/u/.local/share/Steam/steamapps/compatdata/1151340/pfx/user.reg',
      '/mnt/lib/SteamLibrary/steamapps/compatdata/1151340/pfx/user.reg',
    ]);
  });
  it('ignores falsy roots and trims trailing slashes', () => {
    expect(core.fo76UserRegCandidates(['', null, '/a//'])).toEqual([
      '/a/steamapps/compatdata/1151340/pfx/user.reg',
    ]);
  });
  it('uses the canonical FO76 AppID', () => {
    expect(core.FO76_APPID).toBe('1151340');
  });
});

describe('buildFo76GrabUserReg', () => {
  it('appends the [X11 Driver] section with both keys when absent', () => {
    const out = core.buildFo76GrabUserReg('WINE REGISTRY Version 2\n\n[Software\\\\Wine\\\\Direct3D] 0\n"csmt"=dword:00000003\n');
    expect(out).toContain('[Software\\\\Wine\\\\X11 Driver]');
    expect(out).toMatch(/^"GrabFullscreen"="Y"/m);
    expect(out).toMatch(/^"GrabPointer"="Y"/m);
    // preserves existing content
    expect(out).toContain('[Software\\\\Wine\\\\Direct3D]');
  });

  it('is idempotent — returns null when both keys already set', () => {
    const reg = '[Software\\\\Wine\\\\X11 Driver] 0\n#time=0\n"GrabFullscreen"="Y"\n"GrabPointer"="Y"\n';
    expect(core.buildFo76GrabUserReg(reg)).toBeNull();
  });

  it('adds only the missing key into an existing section', () => {
    const reg = '[Software\\\\Wine\\\\X11 Driver] 0\n#time=0\n"GrabFullscreen"="Y"\n';
    const out = core.buildFo76GrabUserReg(reg);
    expect(out).not.toBeNull();
    expect(out).toMatch(/^"GrabPointer"="Y"/m);
    // does not duplicate the already-present key
    expect((out.match(/"GrabFullscreen"="Y"/g) || []).length).toBe(1);
    // inserts into the existing section, not a new one
    expect((out.match(/\[Software\\\\Wine\\\\X11 Driver\]/g) || []).length).toBe(1);
  });

  it('handles empty / null input by creating the section', () => {
    for (const v of ['', null, undefined]) {
      const out = core.buildFo76GrabUserReg(v);
      expect(out).toMatch(/\[Software\\\\Wine\\\\X11 Driver\]/);
      expect(out).toMatch(/^"GrabFullscreen"="Y"/m);
      expect(out).toMatch(/^"GrabPointer"="Y"/m);
    }
  });
});
