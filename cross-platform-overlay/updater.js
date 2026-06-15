'use strict';

/**
 * Auto-updater for the cross-platform Electron overlay.
 *
 * Uses electron-updater (autoUpdater) for fully-automatic, no-user-interaction
 * updates. Behaviour:
 *
 *   • autoDownload = true  — download begins the moment a newer version is found.
 *   • autoInstallOnAppQuit = true  — installed on the next quit as a backstop.
 *   • On 'update-downloaded': show a ~5-second informational banner
 *     ("Update downloaded — restarting to vX.Y.Z"), then call quitAndInstall()
 *     automatically. The user never has to click anything.
 *
 * Two triggers:
 *   1. App start / periodic poll (every 4 h) → checkForUpdates().
 *   2. relay 'release:published' WS message → checkForUpdates() immediately.
 *      This covers every currently-connected user at publish time.
 *
 * Dev/unpackaged guard: electron-updater throws
 *   "Dev mode: skip checking for updates"
 * when the app is not packaged (e.g. `npm start` / Vite dev server). We catch
 * this and no-op silently so the app still runs normally.
 *
 * PRODUCT DISTINCTION:
 * The publish feed is the Electron app's OWN channel at
 *   https://falloutchatmod.com/downloads/electron/
 * which is SEPARATE from the WinForms 1.3.x releases. The electron-builder
 * publish config bakes an `app-update.yml` into the packaged app pointing at
 * this URL; electron-updater reads it at runtime.
 */

// electron-updater is a peer of electron-builder and must be required at runtime
// (not bundled by Vite). In a packaged build it lives in node_modules inside the
// asar; in dev it's in node_modules/ beside main.js.
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
  // If electron-updater is not installed (e.g. running a very minimal dev env
  // without devDeps), degrade gracefully — the old manual check still works.
  autoUpdater = null;
}

/** How often to poll automatically (ms). 4 hours. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** ms to show the "restarting…" banner before calling quitAndInstall(). */
const RESTART_DELAY_MS = 5000;

class Updater {
  /**
   * @param {object} opts
   * @param {string}   opts.appVersion      — running semver
   * @param {string}   opts.relayHttp       — relay base URL (unused now but kept for compat)
   * @param {Function} opts.sendToRenderer  — (channel, payload) → void
   * @param {Function} opts.openExternal    — (url) → void (fallback only)
   */
  constructor({ appVersion, relayHttp, sendToRenderer, openExternal, _autoUpdater }) {
    this._appVersion = appVersion;
    this._relayHttp = relayHttp;
    this._sendToRenderer = sendToRenderer;
    this._openExternal = openExternal;
    this._checkTimer = null;
    this._lastResult = null;
    this._updateDownloaded = false;
    // Allow tests to inject a fake autoUpdater without reloading the module.
    if (_autoUpdater !== undefined) autoUpdater = _autoUpdater;
  }

  // ── Public API (unchanged from the old Updater so main.js callers still work) ─

  start() {
    if (!autoUpdater) {
      console.log('[updater] electron-updater not available — auto-update disabled');
      return;
    }

    this._configure();

    // Initial check after 30 s (don't slow app launch).
    // FCM_UPDATER_INITIAL_DELAY_MS overrides the delay — used by the E2E test
    // harness (tests/mock-relay/) so the test doesn't wait 30s. This env var
    // is NEVER set in packaged/prod builds — the default 30 000 ms always applies.
    const _initialDelay = Number(process.env.FCM_UPDATER_INITIAL_DELAY_MS) || 30_000;
    setTimeout(() => this._safeCheck(), _initialDelay);

    // Periodic check every 4 hours.
    this._checkTimer = setInterval(() => this._safeCheck(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
  }

  /**
   * Triggered by the relay's release:published WS broadcast.
   * Re-runs checkForUpdates() immediately so connected users update right away.
   */
  onRelasePublished() {
    this._safeCheck();
  }

  /**
   * Manual check (e.g. tray menu "Check for updates" or settings panel).
   * Returns a result object compatible with the old API:
   *   { available: false } | { available: true, version }
   */
  async check() {
    return this._safeCheck();
  }

  /** Returns the last known result (may be null before the first check). */
  getLastResult() { return this._lastResult; }

  /**
   * DEV hook: inject a fake update result to exercise the banner UI.
   * In packaged mode this is unused; in dev the old renderer still calls
   * window.relayBridge.onUpdaterResult for the banner, so we fire it directly.
   */
  notifyFakeUpdate(release) {
    const result = { available: true, ...release };
    this._lastResult = result;
    this._sendToRenderer('updater:result', result);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _configure() {
    // autoDownload + autoInstallOnAppQuit are the critical flags.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // E2E test hook: when FCM_TEST_UPDATER=1 (set only by the test harness),
    // enable forceDevUpdateConfig so electron-updater doesn't skip checkForUpdates
    // in the unpackaged app.  This NEVER fires in a packaged build (app.isPackaged
    // is already true there, so forceDevUpdateConfig has no effect anyway).
    if (process.env.FCM_TEST_UPDATER === '1') {
      autoUpdater.forceDevUpdateConfig = true;
      console.log('[updater] FCM_TEST_UPDATER=1: forceDevUpdateConfig enabled (test mode)');
    }

    // In dev (not packaged) electron-updater will throw or warn; that's caught
    // in _safeCheck. Disable the default logger to keep the console clean and
    // use our own events instead.
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => {
      console.log('[updater] checking for update…');
    });

    autoUpdater.on('update-available', (info) => {
      console.log(`[updater] update available: ${info.version}`);
      const result = { available: true, version: info.version, releaseNotes: info.releaseNotes || '' };
      this._lastResult = result;
      // Notify renderer: "Downloading update vX.Y.Z…" (informational — no action needed).
      this._sendToRenderer('updater:result', result);
      this._sendToRenderer('updater:status', { phase: 'downloading', version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[updater] up to date');
      const result = { available: false };
      this._lastResult = result;
      this._sendToRenderer('updater:result', result);
    });

    autoUpdater.on('download-progress', (progress) => {
      // Optional: forward progress to renderer for a progress indicator.
      this._sendToRenderer('updater:status', { phase: 'progress', percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[updater] update downloaded: ${info.version} — restarting in ${RESTART_DELAY_MS}ms`);
      this._updateDownloaded = true;
      const result = { available: true, version: info.version, releaseNotes: info.releaseNotes || '' };
      this._lastResult = result;

      // Tell renderer to show the "Updating… restarting shortly" banner.
      this._sendToRenderer('updater:result', result);
      this._sendToRenderer('updater:status', { phase: 'restart', version: info.version, delayMs: RESTART_DELAY_MS });

      // Auto-apply: quit & install after a brief informational pause.
      setTimeout(() => {
        try {
          // E2E sentinel — the test harness watches for this exact line to verify
          // the apply path was reached (quitAndInstall is the "apply + relaunch" step).
          console.log('[updater] quitAndInstall: applying update and relaunching');
          // isSilent=true → no UAC if the installer is per-user; forceRunAfter=true → relaunch.
          autoUpdater.quitAndInstall(/* isSilent */ true, /* isForceRunAfter */ true);
        } catch (e) {
          console.error('[updater] quitAndInstall failed:', e.message);
        }
      }, RESTART_DELAY_MS);
    });

    autoUpdater.on('error', (err) => {
      // Surface only in dev; in production this is usually a network/cert blip.
      console.error('[updater] error:', err.message);
      // Don't surface to renderer — no-op errors are not actionable by users.
    });
  }

  async _safeCheck() {
    if (!autoUpdater) return { available: false };
    try {
      // checkForUpdates() returns a promise resolving to UpdateCheckResult.
      // In an unpackaged/dev build it throws "Dev mode: skip checking for updates".
      await autoUpdater.checkForUpdates();
      // Result is communicated through the event listeners above.
      return this._lastResult || { available: false };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/dev mode|skip check|not packaged/i.test(msg)) {
        // Expected in dev — silent no-op.
        console.log('[updater] dev/unpackaged: skipping update check');
      } else {
        console.warn('[updater] checkForUpdates error:', msg);
      }
      return { available: false };
    }
  }
}

module.exports = { Updater };
