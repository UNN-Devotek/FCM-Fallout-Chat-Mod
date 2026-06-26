// Guard: FCMBridge.swf — shape and version byte assertions.
//
// FCMBridge.swf is the in-game HUD chat widget (packed into FCM-standalone.ba2).
// Scaleform in Fallout 76 requires SWF version byte 32 at offset [3].
// Haxe writes byte 43 by default; the build must patch it to 32.
//
// This test asserts:
//   1. FCMBridge.swf is present in game-mods/FCMBridge/.
//   2. The SWF signature bytes are correct (FWS or CWS magic).
//   3. The version byte at offset [3] is 32.
//
// The test SKIPS (not fails) when FCMBridge.swf is absent — the SWF is
// compiled on Windows only (Haxe + Archive2 are not CI-available on Linux).
// It fails only when the file IS present but has a wrong version byte, which
// would brick the game on the next pack+deploy.
//
// Run via: npm test (vitest) in cross-platform-overlay/.

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SWF_PATH  = join(REPO_ROOT, 'game-mods', 'FCMBridge', 'FCMBridge.swf');

// SWF magic bytes: 'FWS' (uncompressed) or 'CWS' (zlib) or 'ZWS' (LZMA).
const SWF_MAGIC = [
  [0x46, 0x57, 0x53], // FWS
  [0x43, 0x57, 0x53], // CWS
  [0x5a, 0x57, 0x53], // ZWS
];

const SWF_VERSION_OFFSET = 3;
const SWF_VERSION_REQUIRED = 32;

describe('FCMBridge.swf shape guard', () => {
  const swfPresent = existsSync(SWF_PATH);

  it('FCMBridge.swf presence (skip if absent — compile is Windows-only)', () => {
    if (!swfPresent) {
      // Not a failure: the SWF is compiled on Windows.
      // Signal this clearly so CI logs show SKIP, not PASS.
      console.log(
        '[SKIP] FCMBridge.swf not found at ' + SWF_PATH + '.\n' +
        '       Compile on Windows with: haxe --main FCMBridge --swf FCMBridge.swf --swf-version 32\n' +
        '       Then patch version byte to 32 (see game-mods/FCMBridge/README.md).'
      );
      return;
    }
    expect(swfPresent).toBe(true);
  });

  it('FCMBridge.swf SWF magic bytes are valid (FWS/CWS/ZWS)', () => {
    if (!swfPresent) return; // skip when absent
    const buf = readFileSync(SWF_PATH);
    expect(buf.length).toBeGreaterThan(8);
    const magic = [buf[0], buf[1], buf[2]];
    const validMagic = SWF_MAGIC.some(m => m[0] === magic[0] && m[1] === magic[1] && m[2] === magic[2]);
    expect(
      validMagic,
      `FCMBridge.swf first 3 bytes are 0x${magic.map(b => b.toString(16).padStart(2, '0')).join('')} — ` +
      'expected FWS (465753), CWS (435753), or ZWS (5a5753).'
    ).toBe(true);
  });

  it('FCMBridge.swf version byte [3] must be 32 (Scaleform FO76 requirement)', () => {
    if (!swfPresent) return; // skip when absent
    const buf = readFileSync(SWF_PATH);
    const versionByte = buf[SWF_VERSION_OFFSET];
    expect(
      versionByte,
      `FCMBridge.swf version byte at offset 3 is ${versionByte}, expected 32.\n` +
      'Haxe writes byte 43 by default. After compiling, patch with:\n' +
      '  python3 -c "with open(\'FCMBridge.swf\',\'r+b\') as f: d=bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)"\n' +
      'A wrong version byte will crash Scaleform silently — the widget will not render in FO76.'
    ).toBe(SWF_VERSION_REQUIRED);
  });
});
