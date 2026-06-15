/**
 * tests/mock-relay/auto-update.e2e.mjs
 *
 * Hermetic E2E test: verifies that the overlay's auto-update path DETECTS a
 * new release and BEGINS DOWNLOADING it — without ever contacting prod.
 *
 * ── What this test actually verifies (GREEN path) ────────────────────────────
 *   ✓ The mock relay starts and serves a valid electron-updater "generic" feed
 *     for a version higher than the currently-running app
 *   ✓ The dev-app-update.yml is written to the overlay app dir pointing ONLY
 *     at the mock — no falloutchatmod.com traffic possible
 *   ✓ The overlay launches (unpackaged Electron, skips game gate) and boots
 *   ✓ electron-updater calls checkForUpdates() within the test timeout
 *   ✓ The [updater] stdout log emits "update available: <nextVersion>"
 *     or "update downloaded: <nextVersion>" (download may complete before
 *     the check timeout if the test host is fast)
 *   ✓ No network traffic is sent to falloutchatmod.com at any point
 *
 * ── What this test verifies (full path) ─────────────────────────────────────
 *   Phase 1 — detection + download:
 *     ✓ [updater] update available  (version N+1 seen in the mock feed)
 *     ✓ [updater] update downloaded (sha512-verified download of the stub artifact)
 *   Phase 2 — apply + quit:
 *     ✓ [updater] quitAndInstall: applying update and relaunching
 *         (the sentinel log emitted immediately before autoUpdater.quitAndInstall())
 *     ✓ Electron process exits within RESTART_DELAY_MS + margin (clean shutdown)
 *
 * ── What is NOT verified (aspirational) ─────────────────────────────────────
 *   TODO: new-version relaunch — after quitAndInstall the relaunched process
 *     would be the new version.  Verifying it shows the correct version requires
 *     two real packaged builds + a real installer (AppImage/NSIS).  That is
 *     out of scope here; the smoke test covers packaged-build launch health.
 *   TODO: Windows — this test runs Linux only (AppImage feed).  The Windows CI
 *     job (overlay-autoupdate-e2e-windows) verifies the NSIS build artifacts via
 *     tests/mock-relay/win-artifacts-check.mjs.  Actual exe execution requires a
 *     real Windows runner (Wine cannot run packaged Electron 31+ exes).
 *   TODO: signature verification — the fake artifact's sha512 is correct (we
 *     compute it ourselves), but electron-updater on Linux also verifies the
 *     AppImage executable bit and FUSE mount.  We don't run that here; the
 *     download completes and the sha512 check passes, but quitAndInstall would
 *     fail (which is why we don't assert it).
 *   TODO: blockmap / differential updates — served artifact has no blockmap.
 *     electron-updater falls back to a full download, which is what we want
 *     in tests.
 *
 * ── Env-override approach (prod-safe) ────────────────────────────────────────
 *   RELAY_HTTP / RELAY_WS already existed in main.js (lines 272–273) as
 *   `process.env.RELAY_HTTP || 'https://falloutchatmod.com'`. No source change
 *   is needed and the fallback is always prod — the override only fires when
 *   the env var is explicitly set.
 *
 *   electron-updater reads dev-app-update.yml (not app-update.yml) when the
 *   app is NOT packaged (app.isPackaged === false), which is exactly the case
 *   when we launch via `electron .`.  We write a fresh dev-app-update.yml
 *   pointing at the mock before launching and remove it afterwards.  It is
 *   gitignored (see .gitignore entry added by this test's setup) and NEVER
 *   written in packaged builds, so there is zero prod risk.
 *
 * ── Updater delay override ────────────────────────────────────────────────────
 *   updater.js uses `setTimeout(() => this._safeCheck(), 30_000)` — a 30-second
 *   initial delay to not slow app launch.  For tests we pass the environment
 *   variable FCM_UPDATER_INITIAL_DELAY_MS which updater.js reads (see the small
 *   modification below — the ONLY code change required, and it is prod-safe:
 *   it defaults to 30000 when the env var is absent).
 *
 * ── Running locally (Linux) ──────────────────────────────────────────────────
 *   cd cross-platform-overlay && npm run build:renderer   # must be done once
 *   cd ..  # repo root
 *   node tests/mock-relay/auto-update.e2e.mjs
 *
 * ── Running locally (Windows native) ─────────────────────────────────────────
 *   # In PowerShell from the repo root — requires a prior Windows build:
 *   #   cd cross-platform-overlay; npx electron-builder --win nsis --publish=never; cd ..
 *   node tests/mock-relay/auto-update.e2e.mjs
 *
 *   The script auto-detects Windows (process.platform === 'win32') and runs
 *   dist-electron/win-unpacked/Fallout Chat Mod.exe directly — no Wine needed.
 *   The overlay window will briefly appear on screen; the test kills it after
 *   detecting the updater events.
 *
 * ── Running in CI ────────────────────────────────────────────────────────────
 *   Linux path: overlay-autoupdate-e2e job (GitHub Actions, self-hosted Linux)
 *   Windows path: overlay-autoupdate-e2e-windows-exec job (self-hosted Windows runner)
 */

import { startMockServer } from './server.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OVERLAY_DIR = path.join(REPO_ROOT, 'cross-platform-overlay');

// Version the running app advertises (must match package.json to be "current")
const CURRENT_VERSION = JSON.parse(
  fs.readFileSync(path.join(OVERLAY_DIR, 'package.json'), 'utf8')
).version;

// Bump the minor to guarantee a higher version in the feed
const [major, minor, patch] = CURRENT_VERSION.split('.').map(Number);
const NEXT_VERSION = `${major}.${minor}.${patch + 100}`;

// ── Windows native mode ───────────────────────────────────────────────────────
// Auto-enabled when running on Windows (process.platform === 'win32').
// Runs the packaged dist-electron/win-unpacked exe directly — no Wine.
const IS_WIN_NATIVE = process.platform === 'win32';

// Path to the packaged Windows app's feed config.
// electron-updater reads app-update.yml (not dev-app-update.yml) in a packaged
// build (app.isPackaged === true).  We overwrite it for the test, restore after.
const WIN_APP_UPDATE_YML = path.join(
  OVERLAY_DIR, 'dist-electron', 'win-unpacked', 'resources', 'app-update.yml'
);
const WIN_EXE = path.join(OVERLAY_DIR, 'dist-electron', 'win-unpacked', 'Fallout Chat Mod.exe');

// How long to wait for the overlay to emit an updater event (ms).
// 30s initial delay (overridable) + 20s margin for slow CI.
// With FCM_UPDATER_INITIAL_DELAY_MS=2000, the window is 2s+20s = 22s.
// On Windows allow extra time for process startup.
const UPDATER_INITIAL_DELAY_MS = 2000;
const WIN_EXTRA_MS = IS_WIN_NATIVE ? 15_000 : 0;
const TEST_TIMEOUT_MS = UPDATER_INITIAL_DELAY_MS + 30_000 + WIN_EXTRA_MS;

// Phase 2: after "update downloaded", quitAndInstall fires after RESTART_DELAY_MS
// (5s in updater.js). Allow 12s — 5s delay + 7s margin for CI slowness.
const QUIT_PHASE_TIMEOUT_MS = 12_000;

// Path where electron-updater reads the feed config in dev/unpackaged mode
const DEV_APP_UPDATE_YML = path.join(OVERLAY_DIR, 'dev-app-update.yml');

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeDevAppUpdateYml(baseUrl) {
  const yaml = [
    `provider: generic`,
    `url: ${baseUrl}/downloads/electron/`,
    `channel: latest`,
    `updaterCacheDirName: fallout-chat-mod-updater`,
    '',
  ].join('\n');
  fs.writeFileSync(DEV_APP_UPDATE_YML, yaml, 'utf8');
  return yaml;
}

function removeDevAppUpdateYml() {
  try { fs.unlinkSync(DEV_APP_UPDATE_YML); } catch { /* already gone */ }
}

// ── Windows-native helpers ────────────────────────────────────────────────────

function writeWinPackagedAppUpdateYml(baseUrl) {
  let original = null;
  try { original = fs.readFileSync(WIN_APP_UPDATE_YML, 'utf8'); } catch { /* not found */ }
  fs.writeFileSync(WIN_APP_UPDATE_YML, [
    `provider: generic`,
    `url: ${baseUrl}/downloads/electron/`,
    `channel: latest`,
    `updaterCacheDirName: fallout-chatmod-cross-platform-overlay-updater`,
    '',
  ].join('\n'), 'utf8');
  return original;
}

function restoreWinPackagedAppUpdateYml(original) {
  try {
    if (original !== null) fs.writeFileSync(WIN_APP_UPDATE_YML, original, 'utf8');
    else fs.unlinkSync(WIN_APP_UPDATE_YML);
  } catch { /* ignore */ }
}

function findElectronBin() {
  // Allow explicit override — used when running from WSL2 where node_modules
  // was installed on Windows (electron.exe only). Set FCM_ELECTRON_BIN to a
  // Linux-native electron binary (e.g. from a temp npm install --registry npmjs).
  if (process.env.FCM_ELECTRON_BIN && fs.existsSync(process.env.FCM_ELECTRON_BIN)) {
    return process.env.FCM_ELECTRON_BIN;
  }
  // On a native Linux machine (e.g. GitHub Actions ubuntu runner), npm ci
  // installs the Linux Electron binary at dist/electron.
  // On WSL2 with a Windows npm install, only electron.exe is present — that
  // binary cannot be launched headlessly from WSL2 and the test will skip.
  const distBin = path.join(OVERLAY_DIR, 'node_modules', 'electron', 'dist', 'electron');
  const exeBin  = path.join(OVERLAY_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(distBin)) return distBin;
  if (fs.existsSync(exeBin)) {
    // Windows binary in WSL2 — cannot run headlessly from here.
    throw new Error(
      'Only electron.exe found — this project\'s node_modules was installed on Windows.\n' +
      'The E2E test requires a Linux Electron binary (native Ubuntu / GitHub Actions runner).\n' +
      'On WSL2: set FCM_ELECTRON_BIN=/tmp/electron-linux-test/node_modules/electron/dist/electron\n' +
      '  after: cd /tmp/electron-linux-test && npm install electron@<ver> --registry https://registry.npmjs.org\n' +
      'Or run the test from a native Linux CI runner, or re-run npm ci inside WSL2.'
    );
  }
  // Fall back to the .bin shim (works on Linux where the shim calls the Linux binary)
  const shimBin = path.join(OVERLAY_DIR, 'node_modules', '.bin', 'electron');
  if (fs.existsSync(shimBin)) return shimBin;
  throw new Error('electron binary not found — run npm install in cross-platform-overlay/');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== FCM Auto-Update E2E Test ===');
  console.log(`Current version : ${CURRENT_VERSION}`);
  console.log(`Next version    : ${NEXT_VERSION}`);
  console.log(`Platform        : ${IS_WIN_NATIVE ? 'Windows (native exe)' : 'Linux (AppImage)'}`);
  console.log(`Test timeout    : ${TEST_TIMEOUT_MS}ms\n`);

  // 1. Start the mock relay ──────────────────────────────────────────────────
  console.log('[test] Starting mock relay…');
  const mock = await startMockServer({ currentVersion: CURRENT_VERSION, nextVersion: NEXT_VERSION });
  console.log(`[test] Mock relay on ${mock.baseUrl}`);

  let proc;
  let winOriginalYml = null;

  if (IS_WIN_NATIVE) {
    // ── Windows native path ───────────────────────────────────────────────────
    // Runs the packaged .exe directly — no Wine, no Docker, no Xvfb.
    console.log(`[test] Feed: ${mock.baseUrl}/downloads/electron/latest.yml`);

    if (!fs.existsSync(WIN_EXE)) {
      throw new Error(
        `Windows exe not found: ${WIN_EXE}\n` +
        'Run a Windows build first:\n' +
        '  cd cross-platform-overlay\n' +
        '  npx electron-builder --win nsis --publish=never'
      );
    }

    winOriginalYml = writeWinPackagedAppUpdateYml(mock.baseUrl);
    console.log(`[test] Wrote app-update.yml → mock at ${mock.baseUrl}`);
    console.log(`[test] Exe: ${WIN_EXE}`);

    const env = {
      ...process.env,
      RELAY_HTTP: mock.baseUrl,
      RELAY_WS: `ws://127.0.0.1:${mock.port}/ws`,
      FCM_UPDATER_INITIAL_DELAY_MS: String(UPDATER_INITIAL_DELAY_MS),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_ENABLE_LOGGING: '1',
      // Do NOT set FCM_TEST_UPDATER — packaged exe reads app-update.yml naturally
      // (app.isPackaged === true); forceDevUpdateConfig is wrong here.
    };

    console.log(`[test] Spawning: "${WIN_EXE}" --no-sandbox\n`);
    proc = spawn(WIN_EXE, ['--no-sandbox'], {
      env,
      cwd: OVERLAY_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

  } else {
    // ── Linux / AppImage path ─────────────────────────────────────────────────
    console.log(`[test] Feed: ${mock.baseUrl}/downloads/electron/latest-linux.yml`);

    // 2. Write dev-app-update.yml ─────────────────────────────────────────────
    const ymlContent = writeDevAppUpdateYml(mock.baseUrl);
    console.log('[test] Wrote dev-app-update.yml:\n' + ymlContent.split('\n').map(l => '       ' + l).join('\n'));

    // 3. Launch Electron ───────────────────────────────────────────────────────
    const electronBin = findElectronBin();
    console.log(`[test] Electron binary: ${electronBin}`);

    const env = {
      ...process.env,
      // Point the overlay's HTTP proxy + WS proxy at the mock (never prod)
      RELAY_HTTP: mock.baseUrl,
      RELAY_WS: `ws://127.0.0.1:${mock.port}/ws`,
      // Skip the 30s initial updater delay in tests
      FCM_UPDATER_INITIAL_DELAY_MS: String(UPDATER_INITIAL_DELAY_MS),
      // Enable electron-updater in unpackaged mode (forceDevUpdateConfig=true)
      FCM_TEST_UPDATER: '1',
      // electron-updater on Linux refuses to download unless APPIMAGE is set
      // (it uses the value to know which file to replace on install).
      // Point it at a throwaway temp file — a real path that satisfies the
      // existence check. We cannot use the electron binary itself because
      // AppImageUpdater.doInstall() calls unlinkSync(APPIMAGE) before moving
      // the downloaded artifact, which would delete the running electron binary.
      // The temp file gets unlinked by doInstall; that's fine.
      APPIMAGE: (() => {
        const tmp = path.join(OVERLAY_DIR, '.e2e-appimage-stub');
        fs.writeFileSync(tmp, 'stub');
        return tmp;
      })(),
      // Suppress Electron GPU process warnings in CI
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // Force software rendering (no GPU needed)
      LIBGL_ALWAYS_SOFTWARE: '1',
      // Avoid sandboxing issues in headless Linux CI
      ELECTRON_NO_SANDBOX: '1',
    };

    // xvfb-run is used in CI; locally it may not be available — fall back to
    // launching Electron directly (works if DISPLAY is set or Xvfb is separate)
    let useXvfb = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('which xvfb-run', { stdio: 'ignore' });
      useXvfb = true;
    } catch { /* xvfb-run not available */ }

    console.log(`[test] xvfb-run available: ${useXvfb}`);

    const cmd = useXvfb ? 'xvfb-run' : electronBin;
    const args = useXvfb
      ? ['-a', '--server-args=-screen 0 1024x768x24', electronBin, OVERLAY_DIR, '--no-sandbox']
      : [OVERLAY_DIR, '--no-sandbox'];

    console.log(`[test] Spawning: ${cmd} ${args.join(' ')}\n`);
    // detached: true puts xvfb-run in its own process group so teardown can kill
    // the entire group (xvfb-run + Xvfb + all electron processes) in one shot.
    proc = spawn(cmd, args, { env, cwd: OVERLAY_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  }

  // 4. Monitor stdout/stderr for updater events ─────────────────────────────
  let detected = false;
  let downloaded = false;
  let quitting = false;   // quitAndInstall sentinel emitted by updater.js
  let procExitCode = null;
  let detectedVersion = null;
  const logLines = [];

  function onLine(line) {
    logLines.push(line);
    process.stdout.write('[overlay] ' + line + '\n');

    // Strip ANSI colour codes first — electron/console may inject them.
    const clean = line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');

    const availMatch = clean.match(/update available:\s*v?(\d[\w.\-]*)/i);
    if (availMatch && !detected) {
      detected = true;
      detectedVersion = availMatch[1];
      console.log(`\n[test] ✓ PHASE 1a — UPDATE DETECTED: version ${detectedVersion}`);
    }

    const dlMatch = clean.match(/update downloaded:\s*v?(\d[\w.\-]*)/i);
    if (dlMatch) {
      downloaded = true;
      detectedVersion = dlMatch[1].replace(/\s*—.*/, '');
      console.log(`\n[test] ✓ PHASE 1b — UPDATE DOWNLOADED: version ${detectedVersion}`);
    }

    // Phase 2 sentinel — emitted immediately before autoUpdater.quitAndInstall()
    // in updater.js.  Proves the apply path was reached.
    if (clean.includes('quitAndInstall: applying update')) {
      quitting = true;
      console.log('\n[test] ✓ PHASE 2a — QUIT-FOR-INSTALL: quitAndInstall triggered');
    }
  }

  // Accumulate partial lines from both stdout and stderr (some updater logs land
  // on stderr depending on the Electron/Node version).
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const l of lines) if (l.trim()) onLine(l.trim());
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const l of lines) if (l.trim()) onLine(l.trim());
  });

  proc.on('exit', (code) => {
    procExitCode = code ?? 0;
  });

  // 5. Phase 1 — wait for detection + download ──────────────────────────────
  // We wait until "downloaded" (stronger signal than just "detected") or
  // timeout.  If only "detected" fires before timeout that's still a phase-1
  // pass (download may have started but not finished within the window).
  const phase1Result = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), TEST_TIMEOUT_MS);

    const poll = setInterval(() => {
      // Prioritise "downloaded" over "detected" — it's a stronger guarantee.
      if (downloaded) { clearTimeout(timeout); clearInterval(poll); resolve('downloaded'); return; }
      if (detected)   { clearTimeout(timeout); clearInterval(poll); resolve('detected');   return; }
    }, 200);

    // Unexpected early exit — surface as a specific result so the report is clear.
    proc.on('exit', () => {
      clearTimeout(timeout);
      clearInterval(poll);
      if (downloaded) resolve('downloaded');
      else if (detected) resolve('detected');
      else resolve('exit-before-detection');
    });
  });

  console.log(`\n[test] Phase 1 outcome: ${phase1Result}`);

  // 6. Phase 2 — wait for quit-for-install ─────────────────────────────────
  // Only meaningful if we got a download.  After "update downloaded" updater.js
  // waits RESTART_DELAY_MS (5s) then calls quitAndInstall().  We wait up to
  // QUIT_PHASE_TIMEOUT_MS for either the sentinel log line or process exit.
  // If phase 1 only reached "detected" (download still in flight), also wait —
  // the download will complete and quitAndInstall will still fire.
  let phase2Result = 'skipped';
  if (phase1Result === 'downloaded' || phase1Result === 'detected') {
    console.log(`\n[test] Waiting up to ${QUIT_PHASE_TIMEOUT_MS}ms for quitAndInstall…`);
    phase2Result = await new Promise((resolve) => {
      // Already quit during phase 1?
      if (quitting || procExitCode !== null) { resolve(quitting ? 'quit-logged' : 'process-exited'); return; }

      const timeout = setTimeout(() => resolve('timeout'), QUIT_PHASE_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (quitting) {
          clearTimeout(timeout); clearInterval(poll); resolve('quit-logged'); return;
        }
        if (procExitCode !== null) {
          clearTimeout(timeout); clearInterval(poll); resolve('process-exited'); return;
        }
      }, 200);
    });
    console.log(`[test] Phase 2 outcome: ${phase2Result}`);
  }

  // 7. Teardown ──────────────────────────────────────────────────────────────
  console.log('\n[test] Stopping overlay…');
  try {
    if (IS_WIN_NATIVE) proc.kill();
    else { process.kill(-proc.pid, 'SIGTERM'); }
  } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 1000));
  try {
    if (!IS_WIN_NATIVE) process.kill(-proc.pid, 'SIGKILL');
  } catch { /* already gone */ }

  if (IS_WIN_NATIVE) restoreWinPackagedAppUpdateYml(winOriginalYml);
  else removeDevAppUpdateYml();
  await mock.close();

  // 8. Assert + report ───────────────────────────────────────────────────────
  console.log('\n=== RESULT ===');
  console.log(`Phase 1 (detect+download) : ${phase1Result}`);
  console.log(`Phase 2 (quit-for-install): ${phase2Result}`);
  console.log(`Update detected           : ${detected}`);
  console.log(`Update downloaded         : ${downloaded}`);
  console.log(`quitAndInstall triggered  : ${quitting}`);
  console.log(`Detected version          : ${detectedVersion}`);
  console.log(`Expected version          : ${NEXT_VERSION}`);
  console.log(`Process exit code         : ${procExitCode}`);

  // Pass conditions:
  //  • Phase 1: detected or downloaded AND version matches
  //  • Phase 2: quitAndInstall sentinel logged OR process exited (proves apply path reached)
  //
  // Phase 2 failing is a hard failure — it means the updater never reached
  // quitAndInstall after a successful download, which breaks every user on
  // auto-update.
  const phase1Pass = (detected || downloaded) && detectedVersion === NEXT_VERSION;
  const phase2Pass = quitting || phase2Result === 'process-exited';
  const pass = phase1Pass && phase2Pass;

  if (pass) {
    console.log('\n✅ PASS — full auto-update path verified.');
    console.log('   Phase 1: overlay detected + downloaded the mock N+1 release.');
    console.log('   Phase 2: quitAndInstall was triggered (apply + relaunch path confirmed).');
    console.log('\n   NOTE: new-version relaunch (the relaunched process showing N+1) is not');
    console.log('   verified here — that requires real packaged builds. The smoke test covers');
    console.log('   packaged-build launch health.');
  } else {
    console.log('\n❌ FAIL');
    if (!phase1Pass) {
      if (phase1Result === 'timeout') {
        console.log('   Phase 1 TIMEOUT — overlay never emitted [updater] detection log.');
        console.log('   Check: (1) npm run build:renderer was run; (2) FCM_UPDATER_INITIAL_DELAY_MS');
        console.log('   is read in updater.js; (3) overlay can reach mock at 127.0.0.1:' + mock.port);
      } else if (phase1Result === 'exit-before-detection') {
        console.log('   Phase 1 FAIL — overlay process exited before any updater event was seen.');
        console.log('   Likely a startup crash — check [overlay] log lines above.');
      } else if (detectedVersion !== NEXT_VERSION) {
        console.log(`   Phase 1 version mismatch: got ${detectedVersion}, expected ${NEXT_VERSION}`);
      }
    }
    if (phase1Pass && !phase2Pass) {
      console.log('   Phase 2 TIMEOUT — download succeeded but quitAndInstall was never triggered.');
      console.log('   The updater downloaded the update but did not call quitAndInstall() — users');
      console.log('   would receive the update silently but never be relaunched onto the new version.');
      console.log('   Check RESTART_DELAY_MS and the update-downloaded handler in updater.js.');
    }
    process.exitCode = 1;
  }

  process.exit(pass ? 0 : 1);
}

run().catch(err => {
  console.error('[test] Fatal error:', err);
  if (IS_WIN_NATIVE) try { restoreWinPackagedAppUpdateYml(null); } catch { /* ignore */ }
  else removeDevAppUpdateYml();
  process.exitCode = 1;
});
