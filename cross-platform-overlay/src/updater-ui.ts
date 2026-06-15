/**
 * Update prompt UI — Electron overlay only.
 *
 * In a PACKAGED build, electron-updater handles everything automatically:
 *   • download starts the moment a newer version is found
 *   • the app quits-and-installs automatically (no user action required)
 * The banner here is INFORMATIONAL ONLY — it shows the current phase
 * ("Downloading update…", "Restarting to vX.Y.Z…") and no dismiss gate.
 *
 * In a DEV / UNPACKAGED build (Vite dev server), the banner retains a
 * fallback "Open download page" link so developers can still test the UI.
 *
 * The "Check for updates" button in the settings footer remains for manual
 * inspection; it reports what electron-updater last found.
 */

import type { UpdaterResult, UpdaterStatus } from './bridge';

// ── Banner element ────────────────────────────────────────────────────────────

let bannerEl: HTMLElement | null = null;

function removeBanner() {
  bannerEl?.remove();
  bannerEl = null;
}

/**
 * Show or update the informational update banner.
 * In packaged mode this is driven by updater:status phase events.
 * In dev/unpackaged mode it falls back to showing the old download link.
 */
function showUpdateBanner(opts: {
  version: string;
  message: string;
  /** If provided (dev/fallback only), show an "Open download page" link. */
  downloadUrl?: string;
}) {
  if (bannerEl) {
    // Update the message in place — don't stack banners.
    const msgEl = bannerEl.querySelector<HTMLElement>('.upd-msg');
    if (msgEl) msgEl.textContent = opts.message;
    const verEl = bannerEl.querySelector<HTMLElement>('.upd-version');
    if (verEl) verEl.textContent = `v${opts.version}`;
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'shell-update-banner';
  banner.className = 'upd-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const icon = document.createElement('span');
  icon.className = 'upd-icon';
  icon.textContent = '⬆';

  const versionSpan = document.createElement('span');
  versionSpan.className = 'upd-version';
  versionSpan.textContent = `v${opts.version}`;

  const msg = document.createElement('span');
  msg.className = 'upd-msg';
  msg.textContent = opts.message;

  banner.append(icon, versionSpan, msg);

  // Dev/fallback: show an "Open download page" button if a URL was provided.
  if (opts.downloadUrl) {
    const openBtn = document.createElement('button');
    openBtn.className = 'upd-btn upd-btn-install';
    openBtn.textContent = 'Open download page';
    openBtn.title = 'Open the download page in your browser';
    openBtn.addEventListener('click', () => {
      window.relayBridge.installUpdate?.(opts.downloadUrl!);
      removeBanner();
    });
    banner.append(openBtn);
  }

  bannerEl = banner;

  // Insert before the shell bar so it appears at the very top.
  const root = document.getElementById('root');
  const shellBar = document.getElementById('shell-bar');
  if (root && shellBar) {
    root.insertBefore(banner, shellBar);
  } else {
    (root || document.body).prepend(banner);
  }
}

// ── Settings footer "Check for updates" button ────────────────────────────────

let checkBtnEl: HTMLButtonElement | null = null;
let checkStatusEl: HTMLElement | null = null;

function showCheckResult(result: UpdaterResult | null) {
  if (!checkStatusEl) return;
  if (!result) {
    checkStatusEl.textContent = '';
    return;
  }
  if (result.available) {
    checkStatusEl.textContent = `Update available: v${result.version}`;
    checkStatusEl.style.color = '#C8A840';
  } else {
    checkStatusEl.textContent = 'Up to date';
    checkStatusEl.style.color = '#18FF62';
  }
  // Auto-clear after 6 s.
  setTimeout(() => {
    if (checkStatusEl) checkStatusEl.textContent = '';
  }, 6000);
}

/**
 * Append a "CHECK FOR UPDATES" button + status line to the settings panel footer.
 * Must be called after buildSettingsPanel() has run (the footer must exist in DOM).
 *
 * @param footerEl — the `.ss-footer` element
 */
export function mountCheckForUpdatesButton(footerEl: HTMLElement) {
  if (checkBtnEl) return; // already mounted

  const btn = document.createElement('button');
  btn.className = 'ss-fbtn';
  btn.textContent = 'CHECK FOR UPDATES';
  btn.title = 'Check for a newer version of this overlay';
  checkBtnEl = btn;

  const status = document.createElement('span');
  status.className = 'ss-update-status';
  checkStatusEl = status;

  btn.addEventListener('click', async () => {
    btn.textContent = 'Checking…';
    btn.setAttribute('disabled', 'true');
    try {
      const result = await window.relayBridge.checkForUpdates?.();
      if (result?.available) {
        showUpdateBanner({
          version: result.version,
          message: '— update found, downloading…',
          downloadUrl: result.downloadUrl,
        });
      }
      showCheckResult(result ?? null);
    } catch {
      if (checkStatusEl) {
        checkStatusEl.textContent = 'Check failed — try again later';
        checkStatusEl.style.color = '#FF6644';
        setTimeout(() => { if (checkStatusEl) checkStatusEl.textContent = ''; }, 5000);
      }
    } finally {
      btn.textContent = 'CHECK FOR UPDATES';
      btn.removeAttribute('disabled');
    }
  });

  // Insert before the "RESET DEFAULTS" button so it's in the left of the footer.
  const resetBtn = footerEl.querySelector<HTMLElement>('.ss-fbtn');
  if (resetBtn) {
    footerEl.insertBefore(status, resetBtn);
    footerEl.insertBefore(btn, resetBtn);
  } else {
    footerEl.prepend(status, btn);
  }
}

// ── Listener wiring ───────────────────────────────────────────────────────────

/**
 * Register the main-process updater listeners and surface informational banners.
 * Call once at startup (e.g. from initShell / main.tsx useEffect).
 *
 * updater:result  — update check outcome (available / not-available)
 * updater:status  — phase transitions (downloading / progress / restart)
 */
export function initUpdaterUI() {
  // updater:result — emitted by both packaged (electron-updater) and dev (fake hook).
  window.relayBridge.onUpdaterResult?.((result) => {
    if (result.available) {
      // Show the banner; phase messages will update it via onUpdaterStatus below.
      showUpdateBanner({
        version: result.version,
        message: '— downloading update…',
        downloadUrl: result.downloadUrl, // undefined in packaged; set in dev fallback
      });
    }
    // A "not available" result while a banner is open: leave the banner (the
    // user might be mid-download; we never auto-dismiss on a negative check).
  });

  // updater:status — packaged-only phase transitions from electron-updater events.
  window.relayBridge.onUpdaterStatus?.((status) => {
    if (status.phase === 'downloading') {
      showUpdateBanner({ version: status.version, message: '— downloading update…' });
    } else if (status.phase === 'progress') {
      // Update the message to show download progress (if banner is open).
      const msgEl = bannerEl?.querySelector<HTMLElement>('.upd-msg');
      if (msgEl) msgEl.textContent = `— downloading… ${status.percent}%`;
    } else if (status.phase === 'restart') {
      const secs = Math.round(status.delayMs / 1000);
      showUpdateBanner({
        version: status.version,
        message: `— update downloaded. Restarting in ${secs}s…`,
      });
      // Auto-remove the banner just before restart so it doesn't linger.
      setTimeout(removeBanner, Math.max(0, status.delayMs - 500));
    }
  });

  // Restore the banner if there was an update pending when the renderer was loaded.
  window.relayBridge.getUpdaterLastResult?.().then((result) => {
    if (result?.available && !bannerEl) {
      showUpdateBanner({
        version: result.version,
        message: '— update available, will install on restart',
        downloadUrl: result.downloadUrl,
      });
    }
  }).catch(() => { /* ignore — best effort */ });
}

// ── CSS injection ─────────────────────────────────────────────────────────────
// Injected once via a <style> tag. Theming matches the Pip-Boy amber palette.
(function injectUpdaterStyles() {
  if (document.getElementById('upd-styles')) return;
  const style = document.createElement('style');
  style.id = 'upd-styles';
  style.textContent = `
/* Update informational banner — Pip-Boy amber / notification strip */
.upd-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: rgba(20, 18, 4, 0.92);
  border-bottom: 1px solid rgba(200, 168, 64, 0.55);
  font-family: "Courier New", Courier, monospace;
  font-size: 11px;
  color: #C8A840;
  letter-spacing: 0.05em;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
}
.upd-icon {
  font-size: 13px;
  color: #C8A840;
  flex-shrink: 0;
}
.upd-version {
  font-weight: bold;
  color: #FFD860;
  flex-shrink: 0;
}
.upd-msg {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upd-btn {
  margin-left: 4px;
  padding: 2px 8px;
  font-family: "Courier New", Courier, monospace;
  font-size: 10px;
  letter-spacing: 0.07em;
  cursor: pointer;
  border-radius: 2px;
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
}
.upd-btn-install {
  background: rgba(200, 168, 64, 0.18);
  border: 1px solid rgba(200, 168, 64, 0.7);
  color: #C8A840;
}
.upd-btn-install:hover {
  background: rgba(200, 168, 64, 0.32);
  color: #FFD860;
}
/* "Check for updates" status line in the settings footer */
.ss-update-status {
  font-size: 10px;
  font-family: "Courier New", Courier, monospace;
  letter-spacing: 0.04em;
  margin-right: auto;
  align-self: center;
}
`;
  document.head.appendChild(style);
})();
