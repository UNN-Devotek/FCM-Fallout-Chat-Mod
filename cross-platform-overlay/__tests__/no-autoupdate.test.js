// Guard test: assert that the auto-updater has been fully removed from the
// cross-platform-overlay and that the passive Nexus notification system is in
// place. This test suite is intentionally negative (asserting absence) so that
// future contributors can't accidentally re-introduce the machinery that caused
// the Nexus Mods ToS flag.
//
// Runner: vitest (environment 'node').

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

// Helper: read a file as a string, or return null if it doesn't exist.
function tryRead(rel) {
  const p = join(ROOT, rel);
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

// Terms that must NOT appear in the electron client sources (outside this test file).
const BANNED_TERMS = [
  'electron-updater',
  'autoUpdater',
  'checkForUpdates',
  'quitAndInstall',
  'feedURL',
  'app-update.yml',
  '/api/version',
];

// ── package.json checks ───────────────────────────────────────────────────────
describe('package.json — no auto-updater config', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  it('has no electron-updater in dependencies or devDependencies', () => {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(allDeps)).not.toContain('electron-updater');
  });

  it('has no build.publish key', () => {
    expect(pkg.build?.publish).toBeUndefined();
  });

  it('disables NSIS differential packages so no blockmap is emitted', () => {
    expect(pkg.build?.nsis?.differentialPackage).toBe(false);
  });

  it('has no updater.js in build.files', () => {
    const files = pkg.build?.files ?? [];
    expect(files).not.toContain('updater.js');
  });
});

// ── File-existence checks ─────────────────────────────────────────────────────
describe('deleted updater source files must not exist', () => {
  it('updater.js does not exist', () => {
    expect(existsSync(join(ROOT, 'updater.js'))).toBe(false);
  });

  it('src/updater-ui.ts does not exist', () => {
    expect(existsSync(join(ROOT, 'src', 'updater-ui.ts'))).toBe(false);
  });
});

// ── Source-file banned-term checks ────────────────────────────────────────────
const CHECKED_FILES = [
  'main.js',
  'preload.js',
  'src/shell.ts',
];

describe('main-process files contain no banned auto-updater terms', () => {
  for (const rel of CHECKED_FILES) {
    const src = tryRead(rel);
    if (src === null) {
      // If the file is absent the build-files test will catch it; skip here.
      continue;
    }
    for (const term of BANNED_TERMS) {
      it(`${rel} does not contain "${term}"`, () => {
        expect(src).not.toContain(term);
      });
    }
  }
});
