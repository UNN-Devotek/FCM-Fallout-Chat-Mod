#!/usr/bin/env node
/**
 * ci-launch-smoke.mjs — headless Electron overlay smoke test.
 *
 * Catches regressions like v1.3.82: "Cannot find module './overlay-core'"
 * (main process crash on launch before window creation).
 *
 * Usage:
 *   node cross-platform-overlay/scripts/ci-launch-smoke.mjs <path-to-executable>
 *   # or via env:
 *   OVERLAY_BIN=/path/to/linux-unpacked/fallout-chat-mod \
 *     node cross-platform-overlay/scripts/ci-launch-smoke.mjs
 *
 * Designed to run under `xvfb-run -a` in CI (Ubuntu), but also works without
 * Xvfb when Electron --headless is available (Electron ≥ 29, which this project uses).
 *
 * EXIT 0 = PASS  (process alive after WAIT_MS, startup marker found, no fatal errors)
 * EXIT 1 = FAIL  (early crash, "Cannot find module", uncaughtException, missing marker)
 */

import { spawn }       from 'child_process';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir }      from 'os';
import { join }        from 'path';

// ── Config ──────────────────────────────────────────────────────────────────
const WAIT_MS = 15_000;   // let the app settle before checking

// Any one of these in stdout/stderr/log = startup confirmed
const PASS_MARKERS = [
  /=== Fallout Chat Mod overlay starting ===/,
  /overlay starting/i,
];

// Any of these = fatal failure regardless of exit code
const FAIL_PATTERNS = [
  /Cannot find module/,
  /\[uncaught\]/,
  /uncaughtException/i,
  /Error: Cannot find/i,
  /MODULE_NOT_FOUND/,
];

// ── Resolve the binary ───────────────────────────────────────────────────────
const bin = process.argv[2] || process.env.OVERLAY_BIN;
if (!bin) {
  console.error('FAIL: provide path to overlay executable as argv[1] or $OVERLAY_BIN');
  process.exit(1);
}
if (!existsSync(bin)) {
  console.error(`FAIL: executable not found: ${bin}`);
  process.exit(1);
}

// ── Isolated home — fresh log, no cached state ───────────────────────────────
// electron-log / our diag() on Linux writes to:
//   $HOME/.config/Fallout Chat Mod/logs/main.log
// With a tmp HOME the path stays predictable and isolated per run.
const tmpHome = mkdtempSync(join(tmpdir(), 'fcm-smoke-'));
const logPath = join(tmpHome, '.config', 'Fallout Chat Mod', 'logs', 'main.log');

console.log('--- Overlay smoke test ---');
console.log(`Binary : ${bin}`);
console.log(`TmpHome: ${tmpHome}`);
console.log(`LogPath: ${logPath}`);
console.log(`Wait   : ${WAIT_MS}ms\n`);

// ── Environment ──────────────────────────────────────────────────────────────
const env = {
  ...process.env,
  HOME:                     tmpHome,
  XDG_CONFIG_HOME:          join(tmpHome, '.config'),
  ELECTRON_DISABLE_SANDBOX: '1',
  // If xvfb-run set DISPLAY, keep it. Otherwise fall back to :99 (CI standard).
  // The --headless flag below makes DISPLAY optional for the main process, but
  // some Chromium internals still query it on Linux.
  DISPLAY: process.env.DISPLAY || ':99',
};

// ── Launch args ──────────────────────────────────────────────────────────────
// --headless          → Electron 29+ headless shell mode; no real display needed.
//                       Works both with and without xvfb-run. The main process
//                       still runs to completion, logs are written as normal.
// --no-sandbox        → Required in most CI environments (no user namespace).
// --disable-gpu       → Avoid GPU init failures in headless CI.
// --disable-dev-shm-usage → /dev/shm is often tiny in CI; prevents OOM crashes.
const args = [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',
];

// ── Spawn ─────────────────────────────────────────────────────────────────────
let stdoutBuf = '';
let stderrBuf = '';
let exitedEarlyCode = null;

const child = spawn(bin, args, {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
});

child.stdout.on('data', d => { const s = d.toString(); stdoutBuf += s; process.stdout.write('[app:out] ' + s); });
child.stderr.on('data', d => { const s = d.toString(); stderrBuf += s; process.stderr.write('[app:err] ' + s); });
child.on('exit', (code, sig) => {
  if (code !== null) exitedEarlyCode = code;
  console.log(`\n[smoke] app exited — code=${code} signal=${sig}`);
});

// ── Wait ──────────────────────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, WAIT_MS));

// Kill the app (graceful → force)
try { child.kill('SIGTERM'); } catch { /* ignore */ }
await new Promise(r => setTimeout(r, 400));
try { child.kill('SIGKILL'); } catch { /* ignore */ }

// ── Read on-disk log ──────────────────────────────────────────────────────────
let fileLog = '';
try {
  fileLog = readFileSync(logPath, 'utf8');
  console.log(`\n--- Log file (${logPath}) [first 4 KB] ---`);
  console.log(fileLog.slice(0, 4000));
  if (fileLog.length > 4000) console.log('[... log truncated ...]');
} catch (e) {
  console.warn(`[smoke] log file not readable: ${e.message}`);
}

// ── Verdict ───────────────────────────────────────────────────────────────────
const combined = stdoutBuf + stderrBuf + fileLog;

// 1. Non-zero early exit
if (exitedEarlyCode !== null && exitedEarlyCode !== 0) {
  console.error(`\nFAIL: process exited with code ${exitedEarlyCode} before verdict window`);
  process.exit(1);
}

// 2. Fatal patterns
for (const pat of FAIL_PATTERNS) {
  if (pat.test(combined)) {
    console.error(`\nFAIL: fatal pattern matched — ${pat}`);
    process.exit(1);
  }
}

// 3. Startup marker
const markerFound = PASS_MARKERS.some(p => p.test(combined));
if (!markerFound) {
  console.error('\nFAIL: no startup marker found — app may have crashed silently or log was not written');
  console.error(`  Expected: ${PASS_MARKERS.map(p => p.toString()).join(' | ')}`);
  process.exit(1);
}

console.log('\nPASS: overlay launched cleanly — startup marker present, no fatal errors');
process.exit(0);
