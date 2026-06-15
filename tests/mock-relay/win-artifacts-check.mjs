/**
 * tests/mock-relay/win-artifacts-check.mjs
 *
 * Static verification of Windows NSIS build artifacts.
 *
 * Run after `electron-builder --win nsis` to assert that every file
 * electron-updater needs for a Windows auto-update is present, non-empty,
 * and contains the expected values.
 *
 * Why this exists instead of a Wine execution test:
 *   Running a packaged Electron 31+ exe under Wine is not a supported pattern —
 *   electron-builder's own test suite runs Windows tests on real Windows runners
 *   and explicitly documents that Wine "is not capable of installing or running
 *   Windows executables."  The Linux E2E job (overlay-autoupdate-e2e) already
 *   exercises the electron-updater code path end-to-end with the AppImage build.
 *   This job covers Windows-specific build correctness: the right files are
 *   present, the right URLs are in the config, and the feed manifest is valid.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'cross-platform-overlay', 'dist-electron');

const EXPECTED_PROVIDER = 'generic';
const EXPECTED_URL = 'https://falloutchatmod.com/downloads/electron/';
const EXPECTED_CHANNEL = 'latest';
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

// ── 2. app-update.yml (the config electron-updater reads in a packaged build) ─

console.log('\n[win-check] 2. app-update.yml');
const appUpdateYmlPath = path.join(DIST, 'win-unpacked', 'resources', 'app-update.yml');
let appUpdateYml = '';
check('app-update.yml exists', () => {
  if (!fs.existsSync(appUpdateYmlPath)) throw new Error(`not found: ${appUpdateYmlPath}`);
  appUpdateYml = fs.readFileSync(appUpdateYmlPath, 'utf8');
  pass(`exists: ${appUpdateYmlPath}`);
});
if (appUpdateYml) {
  check('provider: generic', () => {
    if (!appUpdateYml.includes(`provider: ${EXPECTED_PROVIDER}`))
      throw new Error(`missing "provider: ${EXPECTED_PROVIDER}"\n${appUpdateYml}`);
    pass(`provider: ${EXPECTED_PROVIDER}`);
  });
  check('url field', () => {
    if (!appUpdateYml.includes(EXPECTED_URL))
      throw new Error(`expected URL "${EXPECTED_URL}" not found\n${appUpdateYml}`);
    pass(`url: ${EXPECTED_URL}`);
  });
  check('channel: latest', () => {
    if (!appUpdateYml.includes(`channel: ${EXPECTED_CHANNEL}`))
      throw new Error(`missing "channel: ${EXPECTED_CHANNEL}"\n${appUpdateYml}`);
    pass(`channel: ${EXPECTED_CHANNEL}`);
  });
}

// ── 3. latest.yml (the update feed electron-updater fetches for Windows) ─────

console.log('\n[win-check] 3. latest.yml feed manifest');
const latestYmlPath = path.join(DIST, 'latest.yml');
let latestYml = '';
check('latest.yml exists', () => {
  if (!fs.existsSync(latestYmlPath)) throw new Error(`not found: ${latestYmlPath}`);
  latestYml = fs.readFileSync(latestYmlPath, 'utf8');
  pass(`exists: ${latestYmlPath}`);
});
if (latestYml) {
  for (const field of ['version:', 'sha512:', 'size:', 'path:']) {
    check(`contains ${field}`, () => {
      if (!latestYml.includes(field)) throw new Error(`"${field}" not found in latest.yml\n${latestYml}`);
      pass(`contains ${field}`);
    });
  }
  // Extract and print version for visibility
  const versionMatch = latestYml.match(/^version:\s*(.+)$/m);
  if (versionMatch) console.log(`  → version: ${versionMatch[1].trim()}`);
}

// ── 4. NSIS installer .exe ────────────────────────────────────────────────────

console.log('\n[win-check] 4. NSIS installer');
let installerFound = false;
check('installer .exe exists', () => {
  const entries = fs.existsSync(DIST) ? fs.readdirSync(DIST) : [];
  // electron-builder names it: "Fallout Chat Mod Setup <version>.exe"
  const installer = entries.find(f => f.endsWith('.exe') && f.includes('Setup'));
  if (!installer) throw new Error(`no Setup *.exe found in ${DIST} — files: ${entries.join(', ')}`);
  const installerPath = path.join(DIST, installer);
  const { size } = fs.statSync(installerPath);
  if (size < MIN_INSTALLER_BYTES) throw new Error(`${installer}: too small: ${size} bytes`);
  pass(`${installer} — ${(size / 1024 / 1024).toFixed(1)} MB`);
  installerFound = true;
});

// ── Result ────────────────────────────────────────────────────────────────────

console.log('');
if (failures > 0) {
  console.error(`[win-check] FAIL — ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('[win-check] PASS — all Windows build artifact checks passed');
  process.exit(0);
}
