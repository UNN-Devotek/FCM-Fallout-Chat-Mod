/**
 * .github/scripts/win-artifacts-check.mjs
 *
 * Static verification of Windows NSIS build artifacts.
 *
 * Run after `electron-builder --win nsis` to assert that the packaged installer
 * and executable are present and non-trivial, AND that NO auto-update feed files
 * are emitted — the overlay no longer auto-updates (Nexus Mods ToS compliance);
 * it shows a passive OS notification instead (see docs/overlay/auto-update.md).
 *
 * Why a static check instead of a Wine execution test:
 *   Running a packaged Electron 31+ exe under Wine is not a supported pattern —
 *   electron-builder's own test suite runs Windows tests on real Windows runners
 *   and explicitly documents that Wine "is not capable of installing or running
 *   Windows executables." This job covers Windows-specific BUILD correctness.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'cross-platform-overlay', 'dist-electron');

const MIN_EXE_BYTES = 50 * 1024 * 1024;   // 50 MB — sanity floor; real build ~200 MB
const MIN_INSTALLER_BYTES = 50 * 1024 * 1024;

let failures = 0;

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  failures++;
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function check(label, fn) {
  try {
    fn();
  } catch (e) {
    fail(`${label}: ${e.message}`);
  }
}

// ── 1. Main executable ────────────────────────────────────────────────────────

console.log('\n[win-check] 1. win-unpacked executable');
const exePath = path.join(DIST, 'win-unpacked', 'Fallout Chat Mod.exe');
check('exe exists', () => {
  if (!fs.existsSync(exePath)) throw new Error(`not found: ${exePath}`);
  pass(`exists: ${exePath}`);
});
check('exe size', () => {
  const { size } = fs.statSync(exePath);
  if (size < MIN_EXE_BYTES) throw new Error(`too small: ${size} bytes (expected ≥ ${MIN_EXE_BYTES})`);
  pass(`size: ${(size / 1024 / 1024).toFixed(1)} MB`);
});

// ── 2. NSIS installer .exe ────────────────────────────────────────────────────

console.log('\n[win-check] 2. NSIS installer');
check('installer .exe exists', () => {
  const entries = fs.existsSync(DIST) ? fs.readdirSync(DIST) : [];
  // electron-builder names it: "Fallout Chat Mod Setup <version>.exe"
  const installer = entries.find(f => f.endsWith('.exe') && f.includes('Setup'));
  if (!installer) throw new Error(`no Setup *.exe found in ${DIST} — files: ${entries.join(', ')}`);
  const installerPath = path.join(DIST, installer);
  const { size } = fs.statSync(installerPath);
  if (size < MIN_INSTALLER_BYTES) throw new Error(`${installer}: too small: ${size} bytes`);
  pass(`${installer} — ${(size / 1024 / 1024).toFixed(1)} MB`);
});

// ── 3. NO auto-update feed files (compliance: the build must not emit a feed) ──
// Inverted assertion: app-update.yml / latest.yml / latest-linux.yml must be ABSENT.
// electron-updater + build.publish were removed, so electron-builder no longer
// generates these. If any reappear, an updater feed crept back in — fail.

console.log('\n[win-check] 3. no auto-update feed files');
const forbidden = [
  path.join(DIST, 'win-unpacked', 'resources', 'app-update.yml'),
  path.join(DIST, 'latest.yml'),
  path.join(DIST, 'latest-linux.yml'),
  path.join(DIST, 'latest-mac.yml'),
];
for (const f of forbidden) {
  check(`absent: ${path.relative(REPO_ROOT, f)}`, () => {
    if (fs.existsSync(f)) throw new Error(`auto-update feed file present (should NOT exist): ${f}`);
    pass(`absent: ${path.relative(REPO_ROOT, f)}`);
  });
}

// ── Result ────────────────────────────────────────────────────────────────────

console.log('');
if (failures > 0) {
  console.error(`[win-check] FAIL — ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('[win-check] PASS — all Windows build artifact checks passed');
  process.exit(0);
}
