'use strict';

/**
 * Fallout Chat Mod — cross-platform overlay PROTOTYPE (Electron main process).
 *
 * This shell mounts the REAL admin-dashboard ChatOverlay React component in the
 * renderer (see src/main.tsx). The component uses the dashboard's own data layer
 * (`services/api` over `fetch`, plus its own `new WebSocket(...)`). Rather than
 * fork the component, the main process acts as a TRANSPARENT PROXY so that the
 * component's unmodified network calls reach the live production relay:
 *
 *   - HTTP: the renderer's shimmed `fetch` forwards /api/* and /auth/ws-ticket
 *     requests here; we replay them to the relay with the `X-Auth-Token` header
 *     (instead of the dashboard's cookie session).
 *   - WebSocket: the renderer's shimmed `WebSocket` opens a logical socket here;
 *     we open the real relay socket (`wss://falloutchatmod.com/ws`) with the
 *     `X-Auth-Token` header (browsers/renderers cannot set WS headers) and pipe
 *     frames both ways.
 *
 * Auth handshake (replicated from ChatOverlay/Services/DeviceAuth.cs +
 * backend/src/controllers/usersController.ts `register`):
 *   1. Generate an anonymous install-token UUID (persisted per install).
 *   2. POST /api/users { username, installToken } with header X-App-Client-Key.
 *      (Brand-new install → not enrolled for device-keypair signing → the shared
 *      client-key path is accepted.) Response: { data: { userId, token } }.
 *   3. Use that session token as X-Auth-Token on every relay HTTP + the WS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OS-INTEGRATION FEATURES & THE WSLg LIMITATION (read this)
 * ─────────────────────────────────────────────────────────────────────────────
 * The web `ChatOverlay.tsx` has NO window chrome — no title bar, minimize/close,
 * global hotkeys, click-through or focus management. Those were the desktop
 * WinForms app's job, so the Electron shell provides them here:
 *   • Window controls  → system tray (Show/Hide/Quit) + an in-renderer ✕/− strip
 *                        (IPC: window:close / window:minimize / window:hide).
 *   • Global hotkeys    → `Insert` (focus-to-chat) + `Ctrl/Cmd+Shift+\` (toggle
 *                        show/hide) + a click-through toggle.
 *   • Click-through     → setIgnoreMouseEvents so clicks pass to the game behind.
 *
 * ⚠️  WSLg CANNOT exercise the OS-integration features. WSLg runs the app inside a
 *     sandboxed Wayland/X server isolated from the real Windows desktop, so:
 *       - GLOBAL hotkeys are not delivered (the Windows desktop owns Insert etc.).
 *       - FOCUS-FROM-GAME / always-on-top OVER a real game does not apply.
 *       - CLICK-THROUGH over a Windows game window does nothing (no shared desktop).
 *     The code below WIRES all of these correctly; they light up on a NATIVE
 *     Windows Electron build (or a native Linux X11 desktop). Inside WSLg, use
 *     the tray menu and the in-renderer ✕/− strip — those DO work.
 */

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, MenuItem, screen, nativeImage, shell, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Pure logic lives in overlay-core (no electron / no side effects). Required up
// here so the logger below can use resolveLogLevel/shouldRotateLog.
const overlayCore = require('./overlay-core');

// ─── Diagnostic logging ───────────────────────────────────────────────────────
// Always-on file log so failures on machines we can't access (especially
// Linux/Proton, where game detection + window behavior differ) are diagnosable.
// Path: per-user logs dir — Linux ~/.config/Fallout Chat Mod/logs/main.log,
// Windows %APPDATA%\Fallout Chat Mod\logs\main.log.
//
// Two levels:
//   diag()  — INFO, always on. Lifecycle + state TRANSITIONS (startup, tray,
//             visibility, hotkeys, game on/off, kwin, ozone, relay). Low-frequency,
//             so a normal user's log stays lean but still tells the story.
//   vdiag() — VERBOSE, opt-in (FCM_DEBUG=1 / --debug / Settings → Debug logging).
//             Per-tick spam (z-order re-applies, game scans, foreground polls) for
//             deep debugging sessions. Off by default to keep the log small.
// The file rotates to main.log.1 at ~2MB (mid-session, not just at startup) so a
// user report retains the relevant tail without the file growing without bound.
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
let _logLevel = 'info';       // refined by refreshLogLevel() from env/argv/settings
let _diagWrites = 0;
let _diagPath = null;
function diagPath() {
  if (_diagPath) return _diagPath;
  let dir;
  try { dir = path.join(app.getPath('userData'), 'logs'); }
  catch { dir = path.join(os.tmpdir(), 'FalloutChatMod-logs'); }
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  _diagPath = path.join(dir, 'main.log');
  // Rotate a large log left over from a previous session ONCE, on first resolution.
  try {
    const st = fs.statSync(_diagPath);
    if (overlayCore.shouldRotateLog(st.size, LOG_ROTATE_BYTES)) rotateLog();
  } catch { /* no existing log */ }
  return _diagPath;
}
// Rename the current log to .1 (keep one prior session) and start fresh. Falls back
// to truncation if the rename can't happen (e.g. cross-device / locked file).
function rotateLog() {
  if (!_diagPath) return;
  try { fs.renameSync(_diagPath, _diagPath + '.1'); }
  catch { try { fs.writeFileSync(_diagPath, ''); } catch { /* ignore */ } }
}
function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(diagPath());
    if (overlayCore.shouldRotateLog(st.size, LOG_ROTATE_BYTES)) rotateLog();
  } catch { /* ignore */ }
}
function diag(...parts) {
  const line = '[' + new Date().toISOString() + '] ' +
    parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  try { fs.appendFileSync(diagPath(), line + '\n'); } catch { /* ignore */ }
  try { console.log(line); } catch { /* ignore */ }
  // Throttled size check (statSync every write would be wasteful).
  if ((++_diagWrites % 50) === 0) rotateLogIfNeeded();
}
// VERBOSE log line — only written when verbose logging is enabled.
function vdiag(...parts) { if (_logLevel === 'verbose') diag(...parts); }
function isVerboseLogging() { return _logLevel === 'verbose'; }
// Recompute the level from env/argv (immediate) and, once available, persisted
// settings. Safe to call repeatedly; logs the level on change so the log itself
// records whether verbose was active.
function refreshLogLevel(settings) {
  const next = overlayCore.resolveLogLevel({ env: process.env, argv: process.argv, settings: settings || null });
  if (next !== _logLevel) {
    _logLevel = next;
    try { diag('[log] level=' + _logLevel + (next === 'verbose' ? ' (verbose — per-tick logging ON)' : '')); } catch { /* ignore */ }
  }
}
// Initialize from env/argv at module load (settings are applied later once state loads).
refreshLogLevel(null);
const IS_LINUX = process.platform === 'linux';
const crypto = require('crypto');
const https = require('https');

// REGRESSION GUARD: the KDE-Plasma-Wayland-specific stacking workarounds below
// (forced XWayland, type:'notification', setFocusable toggling) must ONLY apply
// on KDE + Wayland — the one configuration where the overlay renders BEHIND the
// game. On every other Linux setup the previous behavior already worked (X11
// WMs, GNOME, CachyOS/EndeavourOS, etc.), and these workarounds would REGRESS
// them: type:'notification' removes taskbar/alt-tab and isn't honored by Mutter,
// setFocusable(false) on a normal window breaks chat keyboard input, and forced
// XWayland costs native-Wayland HiDPI/clipboard. So we detect KDE+Wayland from
// the session env (available at module load) and gate strictly on it. Anything
// NOT KDE-Wayland keeps the exact old code path. The .kwinrule/README/tray items
// are additive (no runtime effect unless the user imports the rule) so they stay
// Linux-wide.
const _xdgDesktop = (process.env.XDG_CURRENT_DESKTOP || process.env.XDG_SESSION_DESKTOP || '').toLowerCase();
const _xdgSession = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
const IS_KDE = _xdgDesktop.includes('kde') || _xdgDesktop.includes('plasma');
const IS_WAYLAND = _xdgSession === 'wayland' || !!process.env.WAYLAND_DISPLAY;
// The single switch that turns the new behavior on. KDE + Wayland only.
const KDE_WAYLAND = IS_LINUX && IS_KDE && IS_WAYLAND;
// Phase-0 spike opt-in (see docs/overlay/linux-overlay-approaches.md): when set, stay
// on native Wayland instead of relaunching into XWayland. Off by default — every
// existing user keeps the XWayland relaunch below unchanged. This exists to let us
// empirically test the one open blocker (does FO76's Proton mouse-lock survive a
// native-Wayland overlay above it — KDE bug 485409) before committing to a migration.
const NATIVE_WAYLAND_OPT_IN = KDE_WAYLAND && process.env.FCM_NATIVE_WAYLAND === '1';

// KDE+WAYLAND ONLY: force the XWayland (X11) Ozone backend. On a native Wayland
// session Chromium uses the Wayland backend, where an external window cannot
// reliably stack above a fullscreen/borderless game, our X11 window hints
// (_NET_WM_WINDOW_TYPE_NOTIFICATION, KWin "keep above" rules) don't apply, AND —
// critically — the window cannot self-focus and global shortcuts (XGrabKey) /
// window drag (setPosition) are blocked by Wayland's security model.
//
// REGRESSION FIX (Electron 31→39): Electron 38 (Chromium 140) flipped the default
// --ozone-platform from x11 to `auto`, so on a Wayland session Electron 39 runs
// NATIVE Wayland by default — where the overlay can't stack over the game, AND its
// presence forces KWin out of direct scanout (→ game lag with NO visible overlay).
//
// CRITICAL: Chromium picks its Ozone platform from the REAL argv during early C++
// bootstrap — BEFORE this main.js runs. So app.commandLine.appendSwitch('ozone-platform',
// 'x11') here is TOO LATE and silently ignored, and the deprecated 'ozone-platform-hint'
// is ignored on 39+ too. VERIFIED on Electron 39.8.10: ONLY `--ozone-platform=x11` present
// on the actual argv forces XWayland. So if it's missing we relaunch ourselves ONCE with
// it appended; the relaunched process boots XWayland, KWin matches the overlay's X11
// WM_CLASS, and the keep-above rule works (exactly as it did on Electron 31).
//   • argv guard → the child (which HAS the flag) never relaunches again.
//   • runs BEFORE requestSingleInstanceLock so the exiting parent holds no lock.
//   • AppImage: process.execPath is the transient /tmp/.mount_* path (gone after exit),
//     so relaunch via $APPIMAGE when set.
// NOT applied on other Linux setups (X11/GNOME already worked; XWayland would cost them
// native-Wayland fractional HiDPI + clipboard bridging). Fine on KDE-Wayland because FO76
// under Proton is itself XWayland — sharing the XWayland root is what makes stacking work.
// (Caveat: even under XWayland, KWin only forwards MODIFIER-bearing global keys between
// XWayland clients, so bare keys may need follow-up — see docs.)
if (KDE_WAYLAND && NATIVE_WAYLAND_OPT_IN) {
  // Phase-0 spike path: skip the XWayland relaunch entirely and stay native. Enable
  // Chromium's GlobalShortcutsPortal (fixed in Electron 42.0.0 — we're pinned to
  // 42.5.0, see package.json) so globalShortcut has a chance of working without
  // XGrabKey. Belt-and-suspenders ozone-platform switches are deliberately NOT set
  // here — setting them would force XWayland, defeating the opt-in.
  try { app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal'); } catch { /* ignore */ }
  try {
    // Electron has no public API to read back the app_id it actually sent via
    // xdg_toplevel.set_app_id() — package.json's top-level "desktopName" (see the
    // comment near app.setName() above) is what we PIN it to, but the only reliable
    // ground truth is what KWin itself reports. Phase-0 tester: open System Settings
    // -> Window Management -> Window Rules -> Add New... -> Detect Window Properties,
    // click the overlay window, and confirm "Window class" reads fallout-chat-mod —
    // same workflow already used to inspect Konsole/Chrome/Discord.
    diag('[ozone] FCM_NATIVE_WAYLAND=1 — staying on native Wayland (skipping XWayland relaunch); ' +
      'GlobalShortcutsPortal feature enabled; expected app_id=fallout-chat-mod (verify via ' +
      'System Settings -> Window Rules -> Detect Window Properties on this window).');
  } catch { /* logger not ready */ }
} else if (KDE_WAYLAND) {
  // overlayCore is required further down; this runs at module load, so inline the
  // same pure logic via a local require to keep the relaunch decision testable.
  // NATIVE_WAYLAND_OPT_IN is always false here (the branch above already handled the
  // true case) — planOzoneRelaunch's nativeWaylandOptIn param isn't passed since this
  // path is unconditionally the XWayland-relaunch decision.
  const _ozoneRelaunch = require('./overlay-core').planOzoneRelaunch({
    kdeWayland: KDE_WAYLAND, argv: process.argv, appImagePath: process.env.APPIMAGE || null,
    execPath: process.execPath,
  });
  if (_ozoneRelaunch && _ozoneRelaunch.safe === false) {
    // UNSAFE re-exec (issue #272): the only binary is a transient AppImage FUSE mount
    // (/tmp/.mount_*) and $APPIMAGE is unset, so app.exit(0) would unmount it before the
    // child starts → the app "launches once, then the shortcut does nothing". Do NOT
    // exit; stay on native Wayland (stacking may be degraded) rather than vanish. This
    // happens with some AppImageLauncher / wrapper launches; the .deb avoids it entirely.
    try {
      diag('[ozone] XWayland relaunch needed but UNSAFE — execPath=' + process.execPath +
        ' is a transient AppImage mount and $APPIMAGE is unset; staying on native Wayland ' +
        'to avoid disappearing on exit. Reinstall via the .deb or install.sh for reliable launch.');
    } catch { /* logger not ready */ }
  } else if (_ozoneRelaunch) {
    // NOTE: app.relaunch() does NOT work for an AppImage here — the relaunched instance
    // never reaches app.ready (verified). Re-exec manually via child_process instead, with
    // a CLEANED env: drop the AppImage-runtime vars (APPDIR/APPIMAGE/ARGV0/OWD point at the
    // transient /tmp/.mount_* path that's gone after we exit) so the fresh AppImage runtime
    // repopulates them, and APPIMAGELAUNCHER_DISABLE (it makes the binfmt handler misfire on
    // the re-exec). detached + unref + ignored stdio so the child outlives this process.
    const exe = _ozoneRelaunch.execPath || process.execPath;
    try {
      const cp = require('child_process');
      const env = { ...process.env, ...(_ozoneRelaunch.env || {}) };
      for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'APPIMAGELAUNCHER_DISABLE']) delete env[k];
      // Diagnostic BEFORE the spawn — if the child fails to start (FUSE/binfmt/launcher
      // issues) this is the last line we log, which pinpoints the cause from a user report.
      try {
        diag('[ozone] relaunching for XWayland: exe=' + exe + ' $APPIMAGE=' + (process.env.APPIMAGE || '(unset)') +
          ' args=' + JSON.stringify(_ozoneRelaunch.args));
      } catch { /* logger not ready */ }
      const child = cp.spawn(exe, _ozoneRelaunch.args, { detached: true, stdio: 'ignore', env });
      child.unref();
      app.exit(0);
    } catch (e) {
      // re-exec failed — log it (previously swallowed silently) and fall through to the
      // best-effort switches below so we at least keep running.
      try { diag('[ozone] relaunch spawn FAILED for exe=' + exe + ': ' + (e && e.message ? e.message : String(e))); } catch { /* ignore */ }
    }
  }
  // Belt-and-suspenders: no-op on the relaunched X11 process; the route that actually
  // worked on older Electron (<=37, where the hint still selected X11).
  try { app.commandLine.appendSwitch('ozone-platform', 'x11'); } catch { /* ignore */ }
  try { app.commandLine.appendSwitch('ozone-platform-hint', 'x11'); } catch { /* ignore */ }
}

// Disable QUIC / HTTP-3. Our origin is behind Cloudflare, which advertises HTTP/3;
// Electron's QUIC stack intermittently fails relay/fetch requests with
// net::ERR_QUIC_PROTOCOL_ERROR. Forcing HTTP/1.1·2 over TCP makes those requests
// reliable. WSS is TCP-based and unaffected. Must run before app 'ready'.
try { app.commandLine.appendSwitch('disable-quic'); } catch { /* ignore */ }

// Dev-only: expose the Chrome DevTools Protocol on :9222 so the live renderer can
// be inspected remotely (e.g. Playwright connectOverCDP, chrome://inspect). NEVER
// enabled in packaged builds. `remote-allow-origins=*` is required by Chromium
// 111+ for non-browser CDP clients to attach.
if (!app.isPackaged) {
  try { app.commandLine.appendSwitch('remote-debugging-port', '9222'); } catch { /* ignore */ }
  try { app.commandLine.appendSwitch('remote-allow-origins', '*'); } catch { /* ignore */ }
}

// Safety net: a transient main-process error — especially a network blip from the
// relay's net layer (ERR_QUIC_PROTOCOL_ERROR / ECONNRESET / ETIMEDOUT via
// Cloudflare) — must NOT crash the app with Electron's default error dialog. Log
// and continue; the relay retries on its own schedule.
// NOTE: do NOT call app.setName() here. The app name feeds app.getPath('userData')
// (→ ~/.config/Fallout Chat Mod), so renaming it would orphan every existing
// user's session/settings/keybinds on all platforms. On XWayland (the default KDE
// path) KWin matches the overlay by its X11 WM_CLASS ("fallout-chat-mod") via the
// bundled keep-above rule's exact-name match — no app_id override is needed there.
// The top-level "desktopName" field in package.json (bundled via build.files, read
// by Electron itself at startup — electron/electron#49988) pins the NATIVE-WAYLAND
// app_id to the same "fallout-chat-mod" string, independently of app.getName()/
// userData. build.linux.desktopName (electron-builder config, below in package.json)
// is a THIRD, separate thing — it only controls the installed .desktop file's name
// and does not affect the runtime app_id. See FCM_NATIVE_WAYLAND / NATIVE_WAYLAND_OPT_IN
// above and docs/overlay/linux-overlay-approaches.md.

process.on('uncaughtException', (err) => {
  const msg = (err && err.message) ? err.message : String(err);
  try { diag('[uncaught] ' + msg); } catch { /* logger not ready */ }
});
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) ? reason.message : String(reason);
  try { diag('[unhandledRejection] ' + msg); } catch { /* logger not ready */ }
});

// LINUX/KDE: the importable KWin rule + setup note. Written to the stable
// userData dir on startup (an AppImage has no install dir, and asar contents
// aren't user-reachable) so users can import the rule and read the guide. Also
// surfaced via the tray ("KDE: keep overlay above game"). Keep in sync with
// cross-platform-overlay/assets/fallout-chatmod-keepabove.kwinrule + docs.
// NOTE: kept byte-consistent with assets/fallout-chatmod-keepabove.kwinrule
// (sans comments — KWin's INI parser ignores them). ONE rule, on the OVERLAY
// (wmclass "fallout-chat-mod"), combining two properties:
//   1) keep-above (above=true) — belt-and-suspenders.
//   2) force-Layer=Overlay (layer=overlay, layerrule=2 Force) — THE KWin-6 fix
//      (KDE Bug 441074): lifts the overlay above an active-fullscreen game WITHOUT
//      demoting the game, so FO76 keeps normal fullscreen stacking above the panel.
// The overlay AUTO-APPLIES this on startup (setupKdeKeepAbove); this file is the
// manual-import fallback.
const KWINRULE_TEXT = `[Fallout Chat Mod - keep above games]
Description=Fallout Chat Mod - keep above games
wmclass=fallout-chat-mod
wmclassmatch=2
wmclasscomplete=false
above=true
aboverule=3
layer=overlay
layerrule=2
`;
const LINUX_README_TEXT = `Fallout Chat Mod — Linux / KDE setup
=====================================

On KDE Plasma (Wayland) the overlay configures itself AUTOMATICALLY — there is
normally nothing to do. This note explains what it does and how to fix the rare
cases, because it's compositor behavior, not an app bug (Electron can't set window
stacking on Wayland — only KWin can).

----------------------------------------------------------------------
1) KEEP THE OVERLAY ABOVE THE GAME  (automatic — one KWin rule)
----------------------------------------------------------------------
On first launch the overlay forces the XWayland backend and installs ONE KWin
rule into ~/.config/kwinrulesrc, then reloads KWin — no manual steps. The rule
("keep above games") combines two properties on the OVERLAY window:

  - keeps the overlay window above others, AND
  - forces the OVERLAY into KWin's Overlay layer, so it stays on top even
    while the GAME is focused fullscreen. The game is NOT demoted — FO76
    keeps its normal fullscreen stacking (above the panel).

Why the force-Layer property: borderless games (incl. FO76) still tell KWin
they are fullscreen (_NET_WM_STATE_FULLSCREEN), and KWin ranks a FOCUSED
fullscreen window above any plain "keep above" window. The force-Layer
property (KWin 6+) is the sanctioned way to out-rank it without touching the
game's own stacking.
Run FO76 in BORDERLESS WINDOWED (not exclusive fullscreen).

If it ever ends up behind the game (e.g. the auto-apply couldn't run), import the
bundled rule by hand, or use the tray menu -> "KDE: keep overlay above game":

  1. System Settings -> Window Management -> Window Rules -> Import...
  2. Select: fallout-chatmod-keepabove.kwinrule  (in this same folder)
  3. Apply, then run:  qdbus org.kde.KWin /KWin reconfigure   (or log out/in)

Uninstalling? The uninstaller removes this rule; FO76's fullscreen is restored.

----------------------------------------------------------------------
2) STOP THE OVERLAY STEALING KEYS IN OTHER APPS  (install kdotool)
----------------------------------------------------------------------
By default the overlay's hotkeys (Insert / Delete / Home, etc.) stay registered
the whole time Fallout 76 is running — so they get intercepted even when you tab
to Konsole, Discord, a browser, etc. Wayland hides the active window from apps,
so the overlay needs "kdotool" to tell when you're NOT in the game/overlay and
release the keys.

  Install kdotool, then relaunch the overlay:
    Arch / CachyOS:  paru -S kdotool       (AUR; or: yay -S kdotool)
    Fedora:          sudo dnf install kdotool

kdotool is PREFERRED: it asks KWin directly, so it sees every window. xdotool
also works as a fallback (sudo pacman -S xdotool / apt install xdotool), but it
only sees XWayland windows — when you tab to a native-Wayland app (Konsole,
Firefox) while the game runs, it can't tell and the hotkeys stay captured.

Without kdotool (or xdotool) everything still works EXCEPT this key-release
behavior — the overlay falls back to holding the hotkeys while the game runs (no
crash, no other change). Install kdotool for the best experience on KDE Wayland.

----------------------------------------------------------------------
Notes
----------------------------------------------------------------------
  - Borderless Windowed is fully supported; exclusive fullscreen is not
    recommended (no overlay on any OS can draw over an exclusive-fullscreen
    surface that grabs the GPU output).
  - Do NOT run the game inside gamescope for overlay purposes — its nested
    compositor isolates the game and no external overlay can draw over it.
  - The overlay only auto-shows while Fallout 76 is running (detected fine
    under Proton). With the game closed it stays hidden by design.

Tray menu -> "KDE: keep overlay above game" opens this folder and tries to
import the rule for you automatically.
`;

// Write the helper files into userData (Linux only). Returns the rule path.
function writeLinuxHelperFiles() {
  if (!IS_LINUX) return null;
  try {
    const dir = app.getPath('userData');
    const rulePath = path.join(dir, 'fallout-chatmod-keepabove.kwinrule');
    const readmePath = path.join(dir, 'LINUX-KDE-SETUP.txt');
    fs.writeFileSync(rulePath, KWINRULE_TEXT);
    fs.writeFileSync(readmePath, LINUX_README_TEXT);
    diag('[linux] wrote KDE helper files to ' + dir);
    return rulePath;
  } catch (e) { diag('[linux] writeLinuxHelperFiles failed:', String(e && e.message || e)); return null; }
}

// Apply the KWin keep-above layer rule. Two entry points:
//   • Auto, at startup on KDE+Wayland (interactive=false) — so the overlay sits
//     above the game for EVERY user with no manual step. This is the path that
//     makes it "just work"; previously the rule was only written to disk and the
//     user had to discover the tray item, so most installs left it behind the game.
//   • Tray "KDE: keep overlay above game" (interactive=true) — additionally opens
//     the helper folder so the user can import the .kwinrule by hand if the auto
//     path failed (older KWin / missing kwriteconfig6 / non-KDE).
//
// IDEMPOTENT (required now that it runs on every launch): KWin stores rules as
// NUMBERED groups ([1], [2], …) enumerated by [General] count — NOT named groups
// (a named group is an orphan KWin ignores). The script first greps kwinrulesrc for
// our Description and EXITS if it's already there; without that guard, each startup
// would append a duplicate rule group and reconfigure KWin needlessly. Only when the
// rule is missing does it append group [N+1], bump count, and reconfigure. All
// best-effort: on GNOME / missing tools / older KWin it no-ops (the interactive path
// still opens the folder so the manual System-Settings → Import remains available).
// The `fcm-keepabove` rule's force-Layer property (layer=overlay) keeps the overlay above a
// focused fullscreen game WITHOUT demoting the game (so the game keeps normal fullscreen above
// the panel) — the primary KWin-6 fix, always applied. (The old opt-in "keep game below"
// fallback rule was removed: it dropped FO76 to BelowLayer, under EVERY window and the
// panel. The install script still strips a stale fcm-game-below from old installs.)
function setupKdeKeepAbove({ interactive = false } = {}) {
  if (!IS_LINUX) return;
  const rulePath = writeLinuxHelperFiles();
  if (interactive) {
    const dir = (() => { try { return app.getPath('userData'); } catch { return null; } })();
    if (dir) { try { shell.openPath(dir); } catch { /* ignore */ } }
  }
  try {
    const { exec } = require('child_process');
    // Shared, unit-tested script builder (idempotency guard + named-group write
    // + count bump + KWin reconfigure). See overlay-core.buildKwinKeepAboveScript.
    const script = overlayCore.buildKwinKeepAboveScript({});
    exec(script, { timeout: 8000, shell: '/bin/sh' }, (err, stdout) => {
      const out = String(stdout || '');
      if (err) diag('[kwin] keep-above auto-apply failed (use System Settings → Window Rules → Import): ' + String(err.message || err));
      else if (out.includes('fcm-rule-present')) diag('[kwin] keep-above rule already present — skipped');
      else diag('[kwin] keep-above rule installed + KWin reconfigured');
    });
  } catch (e) { diag('[kwin] setupKdeKeepAbove exec failed:', String(e && e.message || e)); }
  diag('[kwin] setupKdeKeepAbove: rule at ' + rulePath + ' (interactive=' + interactive + ')');
}

// Is the overlay window actually on screen right now (not hidden to tray / minimized)?
// Used to gate the panel auto-hide: a hidden overlay must not keep the panels retracted.
function overlayVisibleForZOrder() {
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
}

// --- KDE panel auto-hide while in-game (opt-in, default OFF) ------------------
// KWin's fullscreen promotion is FOCUS-GATED: a borderless FO76 is above the panel only
// while it is the ACTIVE window; when it loses focus — e.g. the user focuses THIS overlay
// to type in chat — it drops to NormalLayer and the taskbar pops over the game's edge.
// When enabled, set every Plasma panel to "autohide" while the overlay is visible over a
// running game, and restore the user's exact per-panel modes on exit. Crash-safe: the
// saved modes are persisted to userData, so a crash-then-relaunch restores them (see
// restore-on-startup + before-quit). (Independent of any game demotion — this is normal
// KWin layering for an inactive fullscreen-state window.)
let _qdbusBin = null;
function resolveQdbusBin() {
  if (_qdbusBin !== null) return _qdbusBin;
  const { execSync } = require('child_process');
  _qdbusBin = '';
  for (const b of ['qdbus6', 'qdbus-qt6', 'qdbus']) {
    try { execSync('command -v ' + b, { shell: '/bin/sh', stdio: 'ignore' }); _qdbusBin = b; break; } catch { /* next */ }
  }
  return _qdbusBin;
}
// Run a plasmashell evaluateScript. Returns { ok, out, locked }.
function plasmaEval(js) {
  const bin = resolveQdbusBin();
  if (!bin) return { ok: false, out: '' };
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync(bin, ['org.kde.plasmashell', '/PlasmaShell', 'org.kde.PlasmaShell.evaluateScript', js],
      { timeout: 6000, encoding: 'utf8' });
    if (/Widgets are locked/i.test(out || '')) return { ok: false, locked: true, out: String(out || '') };
    return { ok: true, out: String(out || '') };
  } catch (e) {
    const msg = String((e && (e.stdout || e.message)) || e);
    return { ok: false, locked: /Widgets are locked/i.test(msg), out: msg };
  }
}
function isPanelHideInGameEnabled() {
  try { const s = loadState().settings; return !!(s && s.kdePanelHideInGame === true); } catch { return false; }
}
// Persisted saved per-panel modes (its EXISTENCE means "panels hidden, not yet restored").
function panelHidingStatePath() {
  try { return path.join(app.getPath('userData'), '.fcm-panel-hiding.json'); } catch { return null; }
}
function readSavedPanelHiding() {
  const p = panelHidingStatePath();
  try { return (p && fs.existsSync(p)) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch { return null; }
}
function writeSavedPanelHiding(map) { const p = panelHidingStatePath(); if (p) { try { fs.writeFileSync(p, JSON.stringify(map)); } catch { /* ignore */ } } }
function clearSavedPanelHiding() { const p = panelHidingStatePath(); if (p) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } } }

let _panelHidingActive = false;
function applyPanelHideInGame() {
  if (_panelHidingActive) return;
  // Capture current modes only if we don't already have a saved map (a stale one from a
  // crash is the authoritative restore target and must not be overwritten with "autohide").
  if (!readSavedPanelHiding()) {
    const r = plasmaEval(overlayCore.buildPanelHidingSaveScript());
    if (!r.ok) { if (r.locked) diag('[panel-hide] skipped — Plasma widgets are locked'); return; }
    const map = overlayCore.parsePanelHidingSave(r.out);
    if (!Object.keys(map).length) return;                 // no panels → nothing to do
    if (Object.values(map).every(m => m === 'autohide')) { // already all autohide → treat as active, no-op
      writeSavedPanelHiding(map); _panelHidingActive = true; return;
    }
    writeSavedPanelHiding(map);
  }
  const s = plasmaEval(overlayCore.buildPanelHidingSetScript('autohide'));
  if (s.ok) { _panelHidingActive = true; diag('[panel-hide] taskbar set to autohide while in-game'); }
}
function restorePanelHiding() {
  const map = readSavedPanelHiding();
  if (!map || !Object.keys(map).length) { clearSavedPanelHiding(); _panelHidingActive = false; return; }
  const js = overlayCore.buildPanelHidingRestoreScript(map);
  const r = js ? plasmaEval(js) : { ok: true };
  if (r.ok || r.locked) { clearSavedPanelHiding(); _panelHidingActive = false; diag('[panel-hide] restored user panel modes'); }
}
// Drive on every game/visibility transition (NOT the heartbeat). Also restores a stale
// saved map (e.g. the setting was turned off, or a previous crash) when we shouldn't hide.
function syncPanelHideInGame(reason) {
  if (!IS_LINUX) return;
  const want = overlayCore.shouldHidePanelInGame({
    gameRunning, overlayVisible: overlayVisibleForZOrder(), enabled: isPanelHideInGameEnabled(),
  });
  if (want && !_panelHidingActive) { diag('[panel-hide] hide (' + (reason || '') + ')'); applyPanelHideInGame(); }
  else if (!want && (_panelHidingActive || readSavedPanelHiding())) { diag('[panel-hide] restore (' + (reason || '') + ')'); restorePanelHiding(); }
}

// FO76 in-game cursor lock (Wayland) — explicit, tray-triggered only (see
// overlay-core.js FO76 comment block). The overlay never writes to FO76's
// Proton/Wine prefix automatically; this only runs when the user presses the
// tray's "Fix in-game cursor lock" action. Detects if FO76 is running so we
// don't fight a live Wine session.
function fo76IsRunning() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('ps -A -o comm=', { timeout: 4000 }).toString();
    return out.split('\n').some(l => l.trim().toLowerCase() === 'fallout76.exe');
  } catch { return false; }
}

// Locate protontricks: native `protontricks`, else the flatpak. Returns the argv prefix
// (e.g. ['protontricks'] or ['flatpak','run','com.github.Matoking.protontricks']) or null.
function findProtontricks() {
  const { execSync } = require('child_process');
  try { execSync('command -v protontricks', { shell: '/bin/sh', stdio: 'ignore' }); return ['protontricks']; }
  catch { /* not native */ }
  try { execSync('flatpak info com.github.Matoking.protontricks', { stdio: 'ignore' }); return ['flatpak', 'run', 'com.github.Matoking.protontricks']; }
  catch { /* not flatpak */ }
  return null;
}

// Enable the in-game cursor lock via protontricks' winetricks verb `grabfullscreen=y`
// (the winecfg "Automatically capture the mouse in full-screen windows" setting) — no
// hand-editing of Wine config. Needs protontricks + FO76's prefix (game launched once) +
// FO76 closed + a display (the overlay runs under XWayland, so DISPLAY is set). Surfaced
// via the tray only — never automatic. Returns { status }:
// 'applied'|'fo76-running'|'no-prefix'|'no-protontricks'|'error'.
function applyFo76Grab() {
  if (fo76IsRunning()) return { status: 'fo76-running' };
  const pt = findProtontricks();
  if (!pt) return { status: 'no-protontricks' };
  const { execFileSync } = require('child_process');
  const run = (args) => execFileSync(pt[0], [...pt.slice(1), ...args],
    { timeout: 120000, encoding: 'utf8', env: { ...process.env } });
  try {
    // GrabFullscreen via the winetricks verb (locks the cursor in Fullscreen mode).
    const out = run([overlayCore.FO76_APPID, 'grabfullscreen=y']);
    if (overlayCore.protontricksIndicatesNoPrefix(out)) return { status: 'no-prefix' };
    // GrabPointer via a raw reg add so the lock ALSO holds in Borderless-Windowed (no
    // winetricks verb exists for it). See overlay-core.js buildFo76GrabPointerRegArgs.
    run(overlayCore.buildFo76GrabPointerRegArgs());
    diag('[cursor-fix] protontricks grabfullscreen=y + GrabPointer=Y applied for FO76');
    return { status: 'applied' };
  } catch (e) {
    const msg = String((e && (e.stdout || e.message)) || e);
    if (overlayCore.protontricksIndicatesNoPrefix(msg)) return { status: 'no-prefix' };
    diag('[cursor-fix] protontricks failed: ' + msg.slice(0, 200));
    return { status: 'error', error: e };
  }
}

// Tray action: same core, with explicit dialog feedback per status. This is the ONLY
// way the cursor lock gets applied — never on install, never on launch (installer
// only prints the manual steps; see Packaging/linux/install.sh).
function fixFo76CursorLock() {
  if (!IS_LINUX) return;
  const { dialog } = require('electron');
  const r = applyFo76Grab();
  const { type, message, detail } = overlayCore.cursorLockStatusMessage(r.status, r.error && r.error.message);
  try { dialog.showMessageBox({ type, title: 'Fallout Chat Mod — in-game cursor lock', message, detail: detail || '', buttons: ['OK'] }); }
  catch { diag('[cursor-fix] ' + message + (detail ? ' — ' + detail : '')); }
}

const http = require('http');
const { URL } = require('url');
// Helper: pick http or https module based on the relay URL protocol.
// Required for local dev where RELAY_HTTP=http://localhost:7076.
function httpModule(urlOrString) {
  const proto = typeof urlOrString === 'string' ? urlOrString.startsWith('https') : (urlOrString.protocol === 'https:');
  return proto ? https : http;
}
const WebSocket = require('ws');
// Pure main-process helpers (side-effect-free, no electron). Single source of
// truth — see overlay-core.js. main.js adapts these to its module state / the
// electron `screen` API at the call sites below. (overlayCore is require()d at the
// top of the file so the logger can use it.)

// Version FOLLOWS the main desktop app (ChatOverlay/ChatOverlay.csproj <Version>,
// patched by build-installer.ps1). Falls back to this package's version if the
// source .csproj isn't present (e.g. a packaged build). Keeps the main process,
// the renderer (__APP_VERSION__ via vite.config), and the desktop client aligned.
const APP_VERSION = overlayCore.resolveAppVersion(fs, __dirname, path);

// Nexus Mods page for Fallout Chat Mod — opened when the user clicks the update
// notification toast. Users download new versions manually from here.
const NEXUS_MOD_URL = 'https://www.nexusmods.com/fallout76/mods/4082';

// ─── Configuration ──────────────────────────────────────────────────────────
// Relay URL is env-driven: set RELAY_HTTP / RELAY_WS to point at any backend.
// Path A (dev:cloud, non-CF-Access dev backend): https://dev.falloutchatmod.com
// Path B (dev:local):                            http://localhost:7177
// Production default (no override):              https://falloutchatmod.com
const BUILD_CHANNEL = (() => {
  try { return require('./package.json').fcmChannel || process.env.BUILD_CHANNEL || 'stable'; }
  catch { return process.env.BUILD_CHANNEL || 'stable'; }
})();
const { relayHttp: RELAY_HTTP, relayWs: RELAY_WS } = overlayCore.resolveRelayUrls(process.env, BUILD_CHANNEL);
const RELAY_HOST = new URL(RELAY_HTTP).host;

// Stable, identifiable User-Agent for every outbound request from the main
// process. Cloudflare WAF can allowlist on this string. The Electron version is
// baked in at runtime so CF can also gate on the electron/ token if needed.
const APP_UA = `FalloutChatMod-Overlay/${APP_VERSION} (Electron ${process.versions.electron}; +https://falloutchatmod.com)`;
// ── Default keybind constants ────────────────────────────────────────────────
// All binds use SINGLE keys from the navigation cluster (not used by FO76
// gameplay) so they don't interfere while the game window has focus.
//
// These constants are the compile-time FALLBACKS only. At runtime the live
// values always come from `currentKeybinds` (loaded from overlay-state.json
// on startup and updated whenever the user rebinds). All registrations are done
// by ACTION, not by literal key, so rebinding automatically carries the full
// behavior — you never need to update the functions below.
//
// Behavior summary:
//   Delete   (toggle)       - hide-to-tray. The app stays running in the system
//                             tray; it does NOT quit. Sets userHidden=true so the
//                             game-gate won't auto-show until the user explicitly
//                             restores (Insert, tray click, or game relaunch).
//   Insert   (focus)        - focus-to-chat: show the overlay if hidden, clear
//                             userHidden, expand if collapsed, focus the input.
//   End      (clickThrough) - toggle click-through (interactive <-> pass-through).
//   PageDown (nextChannel)  - advance to the next sub-channel tab (renderer-driven).
//   PageUp   (prevChannel)  - go to the previous sub-channel tab (renderer-driven).
//   Home     (settings)     - open the settings panel (renderer-driven).
//   \        (recentParty)  - jump to the party that last posted in the General feed.
//   /        (goFo76)       - jump to the Fallout 76 (General) tab.
//
// Toggle show/hide of the overlay window. Hide = to tray (not quit).
const TOGGLE_SHORTCUT = 'Delete';
// Click-through (interactive <-> pass-through) toggle.
const CLICKTHROUGH_SHORTCUT = 'End';
// Focus-to-chat: show + clear userHidden + focus + make interactive so the user can type.
const FOCUS_SHORTCUT = 'Insert';
// Next / previous channel (sub-tab) and open settings — driven through the
// renderer because channel + settings state live inside the React component.
const NEXT_CHANNEL_SHORTCUT = 'PageDown';
const PREV_CHANNEL_SHORTCUT = 'PageUp';
const SETTINGS_SHORTCUT = 'Home';
// Jump to the party that last posted in the General feed (renderer-driven).
const RECENT_PARTY_SHORTCUT = '\\';
// Jump to the Fallout 76 (General) tab — single printable char, focus-gated.
const GO_FO76_SHORTCUT = '/';
// Bump to force every existing user's keybinds back to these defaults ONCE.
// MUST match KEYBIND_RESET_VERSION in src/shell.ts. (v4: adds goFo76='/')
const KEYBIND_RESET_VERSION = 4;
const DEFAULT_KEYBINDS = {
  focus: FOCUS_SHORTCUT, toggle: TOGGLE_SHORTCUT, clickThrough: CLICKTHROUGH_SHORTCUT,
  prevChannel: PREV_CHANNEL_SHORTCUT, nextChannel: NEXT_CHANNEL_SHORTCUT,
  settings: SETTINGS_SHORTCUT, recentParty: RECENT_PARTY_SHORTCUT,
  goFo76: GO_FO76_SHORTCUT,
  party1: '', party2: '', party3: '', party4: '',
  party5: '', party6: '', party7: '', party8: '',
};
// The currently-registered keybind map (pushed to the renderer for the footer).
let currentKeybinds = { ...DEFAULT_KEYBINDS };
// userHidden: true when the user EXPLICITLY hid the overlay (Delete / /hide / tray Hide).
// reevaluateVisibility() will NOT auto-show while this is true.
// Cleared on: focusToChat (Insert), toggleWindow→show, tray Show, or game-launch TRANSITION.
let userHidden = false;

// ── Overlay visibility signal (WS lifecycle, hybrid gate) ─────────────────────
// Renderer connects the WS when the overlay is VISIBLE *or* FO76 is running, and
// disconnects only when hidden-to-tray AND the game is closed. This signal feeds
// the "visible" half. A 20s grace on the hide path prevents WS thrash on brief
// hide→show; the show path is immediate (cancels any pending hide signal).
let _visibilityGraceTimer = null;
function emitVisibility(isVisible) {
  const decision = overlayCore.emitVisibilityDecision(isVisible, _visibilityGraceTimer !== null);
  if (decision === 'show-immediate') {
    if (_visibilityGraceTimer !== null) { clearTimeout(_visibilityGraceTimer); _visibilityGraceTimer = null; }
    diag('[visibility] emit visible=true (immediate)');
    sendToRenderer('overlay:visibility', true);
  } else if (decision === 'noop') {
    // already pending
  } else { // 'schedule-hide'
    diag('[visibility] scheduling visible=false after 20s grace');
    _visibilityGraceTimer = setTimeout(() => {
      _visibilityGraceTimer = null;
      diag('[visibility] emit visible=false (grace elapsed)');
      sendToRenderer('overlay:visibility', false);
    }, 20_000);
  }
}
const APP_TITLE = app.isPackaged ? 'Fallout Chat Mod' : 'Fallout Chat Mod [DEV]';
const RENDERER_URL = process.env.RENDERER_URL || null; // set for `vite` dev server

// The real product icon. Platform-specific formats for best results:
//   • Windows: fcm.ico  (multi-resolution ICO, nativeImage handles it)
//   • macOS:   fcm.icns (use assets/fcm.icns — see BUILD.md for how to generate)
//              macOS also uses the app bundle icon from the .app, not BrowserWindow
//              icon — the icon here is for the Dock / Cmd+Tab switcher.
//   • Linux:   fcm-linux.png (512×512 PNG — see BUILD.md for generation)
// Falls back gracefully: if the platform-preferred asset is missing, tries the
// .ico, then gives up and returns null (the window gets Electron's default icon).
let _appIcon = null;
function appIcon() {
  if (_appIcon) return _appIcon;
  // Try the platform-preferred format first, then fall back to the .ico.
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(path.join(__dirname, 'assets', 'fcm.icns'));
  } else if (process.platform === 'linux') {
    candidates.push(path.join(__dirname, 'assets', 'fcm-linux.png'));
  }
  candidates.push(path.join(__dirname, 'assets', 'fcm.ico'));
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) { _appIcon = img; return _appIcon; }
    } catch { /* try next */ }
  }
  return null;
}

const STATE_FILE    = path.join(app.getPath('userData'), 'overlay-state.json');
const KEYBINDS_FILE = path.join(app.getPath('userData'), 'keybinds.cfg');

// Default window size — kept modest so the channel-tab bar at the top is always
// on-screen. (The old 600x680 default pushed the top off the work area.)
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 500;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;

let mainWindow = null;
let tray = null;
let trayAvailable = false;        // true once new Tray() succeeds (SNI host present)
let clickThrough = false;
let autoClickThrough = false;
// ─── Idempotent setIgnoreMouseEvents ──────────────────────────────────────────
// setIgnoreMouseEvents on a TRANSPARENT window triggers a DWM recomposition that
// visibly FLASHES the overlay. This runs on every focus/blur/show + the ~300ms
// foreground poll, so calling it redundantly (e.g. focusing an already-interactive
// overlay) caused a flash on every click. Route ALL ignore-mouse changes through
// this single helper so a no-op change is skipped → no flash. Tracking is correct
// only because nothing else calls mainWindow.setIgnoreMouseEvents directly.
let _lastIgnore = null;
let _lastForward = null;
function setMouseIgnore(ignore, forward) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  forward = ignore ? !!forward : false; // forward is only meaningful while ignoring
  if (_lastIgnore === ignore && _lastForward === forward) return;
  _lastIgnore = ignore; _lastForward = forward;
  try { mainWindow.setIgnoreMouseEvents(ignore, { forward }); } catch { /* ignore */ }
}
// True while a renderer modal (settings/onboarding) is open — pins the window
// fully interactive so slider drags etc. work regardless of click-through.
let modalInteractive = false;
let sessionToken = null;
let isQuitting = false;
// Once-per-session guard: prevents the update toast from re-firing on WS reconnects
// within the same app launch. Reset to false on each app start.
let updateNotifiedThisSession = false;
/** Latched when an update fires — renderer can query this on init to catch
 *  signals that arrived before its onUpdateAvailable listener was registered. */
let pendingRendererUpdateVersion = null;
// Track whether the chat input was focused before a reload so we can re-focus it.
let inputWasFocused = false;
// User role from register response (null = regular user). Used to show the
// mod/admin tray item ("Start overlay — no game").
let userRole = null;
// Force-visible flag set by the tray "Start overlay (no game)" item. When true,
// the game-process gating is bypassed and the overlay stays visible + topmost.
let forceVisible = false;
// True once the renderer signals that the user is authenticated AND past
// onboarding/login (i.e. the chat overlay is actively in use). Reset to false
// on each renderer reload. Used by canShowOverlay() to distinguish a fully-set-up
// user (enforce the game gate) from a new/unauthenticated user (allow show so
// onboarding and the login screen are always reachable).
let chatActive = false;

// ─── Game-gate helpers ────────────────────────────────────────────────────────
// isPrivileged: moderators, admins, and owners bypass all game-gate checks.
function isPrivileged() {
  return overlayCore.isPrivilegedRole(userRole);
}

// canShowOverlay: single gate deciding whether the overlay may be shown.
// Returns true when ANY of the following is true:
//   1. forceVisible   — explicitly set by a mod/admin/owner via tray
//   2. isPrivileged() — mod/admin/owner always allowed
//   3. gameRunning    — FO76 detected in process list
//   4. !chatActive    — user not yet fully set up (onboarding / login must be reachable)
// A fully-set-up regular user with the game closed → false (overlay hides). This
// is intentional: onboarding stays visible (chatActive=false), then the overlay
// closes the instant onboarding completes (chatActive=true) if FO76 isn't running.
function canShowOverlay() {
  return overlayCore.canShowOverlay({ forceVisible, role: userRole, gameRunning, chatActive });
}

// Throttled tray balloon: shown when a regular user tries to open the overlay
// while FO76 is not running. Windows-only (tray.displayBalloon); harmless no-op
// on Linux where the API is absent.
let _lastGameRequiredNotifyMs = 0;
function notifyGameRequired() {
  const now = Date.now();
  if (now - _lastGameRequiredNotifyMs < 8000) return;
  _lastGameRequiredNotifyMs = now;
  diag('[gate] show suppressed — FO76 not running');
  if (tray && typeof tray.displayBalloon === 'function') {
    try {
      tray.displayBalloon({
        title: 'Fallout Chat Mod',
        content: 'Launch Fallout 76 to open the overlay.',
        iconType: 'info',
      });
    } catch { /* ignore — Linux / headless tray */ }
  }
}

// ─── Foreground-aware z-order state ───────────────────────────────────────────
const { spawn, exec } = require('child_process');
const { GAME_PROCESSES, isGameProcess, isGameClass } = overlayCore;
let zorderProc = null;            // long-lived PowerShell foreground poller (win32)
let fgPoller = null;              // active-window poller child (KDE-Wayland only)
let fgPollTimer = null;           // setInterval driving the active-window poll
let fgTool = null;                // resolved tool name: 'xdotool' | 'kdotool'
let kdeWaylandForegroundDetect = false; // true once a foreground tool is confirmed present
let zorderTimer = null;           // fallback JS timer (re-applies desired state)
let lastForegroundProc = '';      // last reported foreground process name (lower)
// ── win32 foreground-poller self-heal + fail-safe (issue #136) ───────────────
let lastForegroundAt = 0;         // ms ts of the last foreground line from the win32 poller
let pollerStartedAt = 0;          // ms ts the current win32 poller child was spawned
let pollerEverEmitted = false;    // current win32 poller child produced >= 1 line
let pollerRestartCount = 0;       // consecutive win32 poller restarts (backoff index; resets on a healthy line)
let pollerRestartTimer = null;    // pending win32 poller relaunch timer
let fgWatchdogTimer = null;       // win32 fail-safe staleness watchdog interval
let fgFailClosed = false;         // true while the watchdog has released keys (poller silent)
const FG_STALE_MS = 4000;         // no foreground line for this long → fail closed (release hotkeys)
let overlayIsTopmost = false;     // current applied alwaysOnTop state
let lastUserFocusMs = 0;          // ts of last explicit user focus (Insert/focusToChat)
const FOCUS_GUARD_MS = 800;       // window after a user focus during which the overlay stays interactive (beats the 100ms foreground poll)

// ─── Cross-platform game process detection ────────────────────────────────────
// On Windows the foreground-window poll already drives z-order; we also run a
// process-list scan so macOS/Linux (Wine/Proton/CrossOver) can detect FO76.
// On macOS/Linux: overlay is topmost while the game PROCESS exists (no reliable
// foreground-window-process API without native modules). Standalone/no-game mode
// always remains usable regardless of whether the game is found.
let gameRunning = false;           // true when Fallout76.exe is in the process list
let gameScanTimer = null;          // interval handle for the process scanner
let _scanCount = 0;                // diagnostic: number of game scans run
let _lastDiagFound = null;         // diagnostic: last logged detection state
let _inputGrabWarned = false;      // diagnostic: warned once about gamescope exclusive input grab
let _presenceCandidate = null;     // pending gameRunning value awaiting confirmation (hysteresis)
let _presenceStableCount = 0;      // consecutive scans agreeing on _presenceCandidate
const PRESENCE_FLIP_SCANS_ON = 2;  // scans (×2.5s) a LAUNCH must persist before we flip gameRunning→true
const PRESENCE_FLIP_SCANS_OFF = 3; // scans an EXIT must persist (held longer so a transient miss mid-game can't drop the overlay)

function scanForGame() {
  if (process.platform === 'win32') {
    // On Windows: use tasklist (already available; no extra dependencies).
    // tasklist /FI filters by name; "No tasks" means not running.
    // Run one query per known exe name in parallel; resolve true if any matches.
    let _found = false;
    let _pending = GAME_PROCESSES.length;
    for (const proc of GAME_PROCESSES) {
      const exe = proc + '.exe';
      exec(
        `tasklist /FI "IMAGENAME eq ${exe}" /FO CSV /NH`,
        { windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (!err && stdout.toLowerCase().includes(exe.toLowerCase())) _found = true;
          if (--_pending === 0) onGamePresenceChanged(_found);
        }
      );
    }
  } else {
    // macOS / Linux (Wine/Proton/CrossOver): the .exe name appears in the process
    // command column even under Wine, so a case-insensitive grep works reliably.
    exec(
      'ps -A -o command=',
      { timeout: 4000 },
      (err, stdout) => {
        if (err) {
          // A ps failure/timeout carries NO information about the game — do NOT read it
          // as "game gone" (that would drop the overlay mid-game on a transient hiccup).
          // Keep the committed state; a real change still needs fresh confirmations.
          onGamePresenceChanged(null);
          vdiag('[game-scan] ps error — keeping gameRunning=' + gameRunning + ': ' + String(err.message || err));
          return;
        }
        // Match the EXECUTABLE (Fallout76.exe), not a bare "fallout76" substring —
        // otherwise opening a file with "76" in the name (e.g. Fallout76.ini /
        // Fallout76Custom.ini in an editor under Wine) is a false positive that
        // pops the overlay open. The game runs as Fallout76.exe under Proton.
        const found = /fallout76\.exe/i.test(stdout || '');
        _scanCount++;
        // Linux/Proton diagnostics: dump candidate process lines (fallout/wine/
        // proton/steam/fo76) so if FO76-via-Proton isn't detected we can see EXACTLY
        // what name it runs as. On a detection TRANSITION this is logged at info (rare,
        // high-value); the periodic ~60s heartbeat dump is VERBOSE-only (it was the #1
        // source of log bloat — see [zorder] too).
        const _gsTransition = found !== _lastDiagFound;
        if (IS_LINUX && (_gsTransition || _scanCount % 24 === 1)) {
          _lastDiagFound = found;
          if (err) diag('[game-scan] ps error:', String(err.message || err));
          const cand = (stdout || '').split('\n')
            .filter(l => /fallout|wine|proton|steam|fo76|gamescope|umu/i.test(l))
            .map(l => l.trim().slice(0, 240));
          const msg = '[game-scan] found=' + found +
            (cand.length ? ' — candidate processes:\n  ' + cand.join('\n  ')
                         : ' — no fallout/wine/proton/steam processes visible to ps');
          if (_gsTransition) diag(msg); else vdiag(msg);
        }
        // Diagnose the #1 cause of "hotkeys + window drag don't work in-game" on
        // Linux: gamescope's exclusive evdev input grab. `--force-grab-cursor` (and
        // gamescope -f fullscreen) grabs the keyboard/mouse below X11, so the
        // overlay's XGrabKey global shortcuts never fire and pointer-drag never gets
        // events. No overlay-side code can beat an evdev grab — the user must change
        // their launch options. Warn ONCE per game session (reset when it exits).
        if (IS_LINUX) {
          if (found) {
            const grab = !_inputGrabWarned ? overlayCore.classifyInputGrab(stdout) : null;
            if (grab === 'force-grab') {
              _inputGrabWarned = true;
              diag('[input-grab] gamescope --force-grab-cursor detected — it grabs the keyboard/mouse at the evdev level, BELOW X11. While in-game the overlay CANNOT receive global hotkeys (Insert/Delete/Home/PgUp/PgDn) or window drag. Fix: remove --force-grab-cursor from the FO76 launch options (and/or run borderless windowed instead of gamescope -f fullscreen).');
            } else if (grab === 'gamescope-fullscreen') {
              _inputGrabWarned = true;
              diag('[input-grab] gamescope -f (fullscreen) detected — if global hotkeys or window drag stop working once in-game, gamescope is likely grabbing input exclusively. Try borderless windowed, or remove the -f / --force-grab-cursor launch flags.');
            }
          } else {
            _inputGrabWarned = false; // game exited — re-evaluate on next launch
          }
        }
        onGamePresenceChanged(found);
      }
    );
  }
}

// `found`: true (game seen) | false (not seen) | null (scan FAILED — no information).
// Hysteresis lives in the pure overlay-core.nextPresenceState reducer: a single bad scan
// used to flip gameRunning instantly, churning z-order + visibility (reads as the overlay
// flashing/bouncing). A launch must persist PRESENCE_FLIP_SCANS_ON scans, an exit
// PRESENCE_FLIP_SCANS_OFF (held longer), and a scan failure never drops the game.
function onGamePresenceChanged(found) {
  const r = overlayCore.nextPresenceState({
    found,
    gameRunning,
    candidate: _presenceCandidate,
    stableCount: _presenceStableCount,
    appearScans: PRESENCE_FLIP_SCANS_ON,
    disappearScans: PRESENCE_FLIP_SCANS_OFF,
  });
  _presenceCandidate = r.candidate;
  _presenceStableCount = r.stableCount;
  if (!r.commit) {
    if (found != null && found !== gameRunning) {
      diag('[game-gate] presence candidate=' + found + ' (' + _presenceStableCount + '/' +
        (found ? PRESENCE_FLIP_SCANS_ON : PRESENCE_FLIP_SCANS_OFF) + ') — awaiting confirm, current=' + gameRunning);
    }
    return;
  }
  const wasRunning = gameRunning;
  gameRunning = r.gameRunning;
  diag('[game-gate] gameRunning changed to ' + gameRunning + ' chatActive=' + chatActive + ' isPrivileged=' + isPrivileged() + ' forceVisible=' + forceVisible);
  // On game-launch transition (not-running → running), clear userHidden so alt-tabbing
  // back into the game brings the overlay back after the user had hidden it with Delete.
  if (gameRunning && !wasRunning) {
    diag('[game-gate] game launched — clearing userHidden');
    userHidden = false;
  }
  // Re-evaluate keybind registration: on non-win32 the keys are gated on game-
  // RUNNING (no foreground API), so they must (un)register when the game launches
  // or exits. Harmless on Windows (foreground poll drives it there).
  refreshShortcuts();
  // Push the updated game state to the renderer so it can report inGame via
  // client:status over the WS — this is how the backend knows whether to count
  // this user as "online" for party presence.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay:game-state', gameRunning);
  }
  // On non-Windows where we have no foreground-window API: mirror game-running
  // state onto lastForegroundProc so the existing desiredTopmost() logic works.
  // While the game is running → act topmost; when it stops → drop back.
  if (process.platform !== 'win32') {
    lastForegroundProc = gameRunning ? GAME_PROCESSES[0].toLowerCase() : '';
    applyZOrder();
  }
  // Re-evaluate overlay visibility for ALL platforms:
  //   game launched → show (now allowed for regular users)
  //   game closed   → hide if fully set up and not privileged/force-visible
  reevaluateVisibility();
  // Apply/restore the panel auto-hide (opt-in) to match the new state (Linux).
  syncPanelHideInGame('game-' + (gameRunning ? 'launch' : 'exit'));
}

function startGameScan() {
  if (gameScanTimer) return; // already running
  scanForGame(); // immediate first scan
  gameScanTimer = setInterval(scanForGame, 2500);
}

// ─── Idle-collapse state (window-height anchored to the header) ───────────────
let collapsed = false;            // true → window shrunk to the header strip
let expandedHeight = DEFAULT_HEIGHT; // remembered full height to restore on expand
// Full pre-collapse bounds snapshot — set at collapse time, cleared on expand.
// Restoring the full rect (not just height) means the overlay returns to the exact
// position AND size it had before hiding, regardless of where it was on screen.
let expandedBounds = null;        // { x, y, width, height } captured at collapse
let collapseAnim = null;          // active height-animation interval
let collapseAnimTarget = null;    // target height of the active animation (null when idle)

// ─── JS drag-move state (Linux) ──────────────────────────────────────────────
// The renderer's drag handler drives moves through the main process so the math
// uses screen.getCursorScreenPoint() (authoritative DIP coords) instead of the
// renderer's screenX/Y, which can drift under fractional scaling. While a move is
// active we also suppress idle-collapse so the wake-up height animation can't fight
// the move's setPosition (that was the "window dances + expands while dragging" bug).
let movingActive = false;         // true between overlay:move-start and move-end
let moveAnchor = null;            // { cursor:{x,y}, win:{x,y} } captured at move-start
// ─── Drag-in-progress guard for z-order heartbeat ─────────────────────────────
// setAlwaysOnTop on a transparent Electron window triggers a DWM recomposition on
// Windows that causes a visible color flash / dim while the window is being dragged.
// We suppress the z-order heartbeat's forced re-apply during an active drag.
let isDragging = false;

// Active proxied relay sockets, keyed by a renderer-supplied id.
const relaySockets = new Map();

// Per-socket CONNECTING-state send buffers.
// Key: socket id  Value: string[] (frames queued while upstream readyState === CONNECTING)
// Bounded at PROXY_SEND_BUF_MAX frames; frames beyond that are logged and dropped.
const relaySendBuffers = new Map();
const PROXY_SEND_BUF_MAX = 64;

// Pending proxy:ws:open requests that arrived before sessionToken was ready.
// Each entry is the renderer-supplied socket id. Processed in FIFO order once
// a token is available. Bounded at PROXY_OPEN_QUEUE_MAX to prevent unbounded
// growth if the renderer spins without a token appearing.
const pendingWsOpens = [];
const PROXY_OPEN_QUEUE_MAX = 8;

// ─── App client key resolution (no hardcoded secrets) ─────────────────────────
// The shared TOFU app-client key the backend accepts for first-enrolment
// (POST /api/users). Same value the WinForms client hardcodes
// (OverlayConfig.AppClientKey) and what backend/.env's APP_CLIENT_KEY holds.
// It is NOT a secret (it ships inside the desktop client binary already); it
// just identifies the official client for trust-on-first-use. Used as the
// final fallback so the PACKAGED app (no repo / no backend/.env beside it)
// can still register — the dev paths below take precedence when present.
// The default key + resolution logic live in overlay-core.js (single source of
// truth); resolveAppClientKey() below adapts it with this process' env/fs.

function resolveAppClientKey() {
  return overlayCore.resolveAppClientKey(process.env, fs, __dirname, path);
}

// ─── Persisted install + window state ─────────────────────────────────────────
function loadState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = {};
  }
  if (typeof state !== 'object' || state === null) state = {};
  // Self-heal the install identity. The file can EXIST and parse but still lack
  // installToken/username (e.g. only bounds/theme/displayName were ever persisted
  // via saveState) — in that case register() would POST an empty body and 400
  // with "username/installToken required", bricking the overlay at the relay
  // screen. Generate + persist them whenever missing, not only when the file is
  // absent/unparseable.
  let changed = false;
  if (!state.installToken) { state.installToken = crypto.randomUUID(); changed = true; }
  if (!state.username) { state.username = 'Overlay' + crypto.randomInt(1000, 10000); changed = true; }
  if (changed) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* best-effort */ } }
  return state;
}

let _ownWriteMs = 0; // timestamp of our last saveState() write — suppresses the file watcher
function saveState(patch) {
  _ownWriteMs = Date.now();
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* fresh */ }
  Object.assign(state, patch);
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
}

// ─── keybinds.cfg — human-editable plain-text keybind file ───────────────────
// Users can open this file in any text editor and change values. The overlay
// watches it and reloads shortcuts live — no restart needed.
//
// Format:  action=KeyName   (one per line; blank value = unbound; # = comment)
// Example: focus=Insert     nextChannel=PageDown   party1=Shift+F1

const CFG_HEADER = `# Fallout Chat Mod — Overlay Keybinds
# Edit this file to customise your hotkeys. Changes are picked up live.
#
# Key names (case-sensitive):
#   Function .... F1-F24
#   Navigation .. Insert  Delete  Home  End  PageUp  PageDown
#   Arrows ...... Left  Right  Up  Down
#   Editing ..... Tab  Backspace  Return  Space
#   Letters ..... A-Z   Numbers: 0-9
#   Symbols ..... / \\ [ ] ; ' , . \` - =
#   Modifiers ... CommandOrControl  Alt  Shift  (combine: Shift+F1, Alt+Delete)
#
# Leave a value blank to unbind that action entirely.
# Blocked (cannot bind): Escape  CapsLock  NumLock  ScrollLock  Pause
#
`;

const CFG_ACTIONS = [
  'toggle', 'focus', 'clickThrough',
  'nextChannel', 'prevChannel', 'settings',
  'recentParty', 'goFo76',
  'party1', 'party2', 'party3', 'party4',
  'party5', 'party6', 'party7', 'party8',
];

function parseKeybindsCfg(raw) {
  const kb = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key) kb[key] = val;
  }
  return kb;
}

let _ownWriteCfgMs = 0;
// The exact file content the app most recently wrote. Used to detect whether a
// fs.watch notification is a genuine external edit vs. an echo of our own write
// (the _ownWriteCfgMs 2000ms grace alone can be raced when the system is slow).
let _lastWrittenCfgContent = '';
function writeKeybindsCfg(kb) {
  _ownWriteCfgMs = Date.now();
  const lines = [CFG_HEADER];
  for (const action of CFG_ACTIONS) {
    lines.push(`${action}=${(kb && kb[action] != null) ? kb[action] : ''}`);
  }
  const content = lines.join('\n') + '\n';
  _lastWrittenCfgContent = content;
  try { fs.writeFileSync(KEYBINDS_FILE, content); }
  catch (e) { diag('[keybinds-cfg] write failed:', String(e && e.message || e)); }
}

// ─── Live keybind reload ──────────────────────────────────────────────────────
// Watch keybinds.cfg for external edits. Editors write in multiple flushes so
// changes are debounced by 400ms. Own writes are suppressed via two guards:
//   1. _ownWriteCfgMs — time-based 2000ms grace (Windows FS events can arrive
//      500-1500ms after the write completes).
//   2. _lastWrittenCfgContent — content comparison inside the debounce so that
//      even if the timing guard is raced the file content check short-circuits.
// Exactly ONE watcher is kept alive: startKeybindFileWatch() is idempotent —
// calling it again closes the previous watcher before creating a new one.
let _keybindWatchTimer = null;
let _keybindWatcher = null; // single watcher handle; guarded to prevent accumulation
function startKeybindFileWatch() {
  // Idempotency: close any existing watcher before creating a new one so we
  // never accumulate multiple watchers that each fire on every file change.
  if (_keybindWatcher) {
    try { _keybindWatcher.close(); } catch { /* ignore */ }
    _keybindWatcher = null;
  }

  // On first launch (or after a reset), write the cfg so the file exists for the user.
  if (!fs.existsSync(KEYBINDS_FILE)) writeKeybindsCfg(currentKeybinds);

  try {
    _keybindWatcher = fs.watch(KEYBINDS_FILE, () => {
      // Guard 1 — time-based: skip FS events that arrive within 2000ms of our own
      // write (Windows FS events can arrive 500-1500ms after the write completes).
      if (Date.now() - _ownWriteCfgMs < 2000) return;
      // Coalesce burst events (editors + Windows multi-fire) into one re-register.
      if (_keybindWatchTimer) clearTimeout(_keybindWatchTimer);
      _keybindWatchTimer = setTimeout(() => {
        _keybindWatchTimer = null;
        try {
          const raw = fs.readFileSync(KEYBINDS_FILE, 'utf8');
          // Guard 2 — content-based: if the file now contains exactly what the app
          // last wrote, this was an echo of our own write (timing guard was raced,
          // e.g. slow system where the FS event arrived >2s after writeFileSync).
          // Prevents the write→watch→write→watch self-trigger storm.
          if (raw === _lastWrittenCfgContent) return;
          const newKb = parseKeybindsCfg(raw);
          if (!newKb || !Object.keys(newKb).length) return;
          // Only re-register if keybinds actually changed. JSON.stringify key order
          // differs between parseKeybindsCfg (CFG_ACTIONS order) and buildKeybindMap
          // (object literal order), so a string comparison always returns false and
          // creates an infinite write→watch→write loop. Compare values directly instead.
          const allKeys = new Set([...Object.keys(newKb), ...Object.keys(currentKeybinds)]);
          if ([...allKeys].every(k => newKb[k] === currentKeybinds[k])) return;
          diag('[keybind-watch] external edit detected — re-registering shortcuts');
          registerHotkeys(newKb, (loadState().settings || {}).presets);
          // Persist back to overlay-state.json so settings survive a restart.
          saveState({ settings: { ...((loadState().settings) || {}), keybinds: newKb } });
        } catch (e) {
          diag('[keybind-watch] reload failed:', String(e && e.message || e));
        }
      }, 400);
    });
    diag('[keybind-watch] watching', KEYBINDS_FILE);
  } catch (e) {
    diag('[keybind-watch] could not start watcher:', String(e && e.message || e));
  }
}

// ─── Auto-launch (start on login) ─────────────────────────────────────────────
// Run the overlay automatically when the user logs in, so it's always running and
// ready to show over the game — users shouldn't have to open it by hand each
// session (the #1 confusion: "it works, but only if I launch it manually"). ON by
// default; persisted as `autoLaunch` in overlay-state.json and toggleable from the
// tray. Skipped in dev (don't register the throwaway electron.exe) and on Linux
// (setLoginItemSettings is unreliable for AppImages — handled by the install
// script's .desktop entry instead).
function isAutoLaunchEnabled() {
  try { return loadState().autoLaunch !== false; } catch { return true; } // default ON
}
function applyAutoLaunch(enabled) {
  if (!app.isPackaged || process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    diag('[auto-launch] openAtLogin=' + !!enabled);
  } catch (e) { diag('[auto-launch] failed:', String(e && e.message || e)); }
}
function setAutoLaunch(enabled) {
  saveState({ autoLaunch: !!enabled });
  applyAutoLaunch(enabled);
}

// ─── One-time userData migration (productName rename) ─────────────────────────
// v1.3.62 renamed the Electron productName from "Fallout ChatMod" (no space) to
// "Fallout Chat Mod" (with space). Electron derives the userData dir from the
// product name, so after an auto-update the dir moved from
//   %APPDATA%\Fallout ChatMod      → %APPDATA%\Fallout Chat Mod   (Windows)
//   ~/.config/Fallout ChatMod      → ~/.config/Fallout Chat Mod   (Linux)
// orphaning the persisted install token + Discord link + settings, so the user
// came up as a fresh anonymous "OverlayNNNN" with discordLinked=false.
//
// Fix: on startup, BEFORE any loadState()/register runs, copy the legacy state
// over when the CURRENT state is either MISSING or a provably-pristine
// freshly-minted default (auto-generated "OverlayNNNN", not Discord-linked, no
// meaningful settings). This recovers users who already auto-updated once and
// got a fresh anonymous state in the new dir. Idempotent + safe: NEVER overwrites
// a current state that has real user data. Fully wrapped in try/catch (non-fatal).
//
// "Has real data" = discordLinked true OR a non-default username (not /^Overlay\d+$/)
// OR a populated settings object (a non-empty plain object).
const stateHasRealData = overlayCore.stateHasRealData;

function migrateLegacyUserData() {
  try {
    const currentDir = app.getPath('userData');
    // Derive the legacy dir generically: replace the productName segment
    // "Fallout Chat Mod" with the old "Fallout ChatMod" in the userData path.
    if (!currentDir.includes('Fallout Chat Mod')) return;
    const legacyDir = currentDir.replace('Fallout Chat Mod', 'Fallout ChatMod');
    if (legacyDir === currentDir) return;

    const currentState = STATE_FILE; // path.join(currentDir, 'overlay-state.json')
    const legacyState = path.join(legacyDir, 'overlay-state.json');

    if (!fs.existsSync(legacyState)) {
      diag('[migrate] no legacy overlay-state.json at', legacyState, '— nothing to migrate');
      return;
    }

    // Sanity-check the legacy state parses and carries an install token before copying.
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(legacyState, 'utf8')); } catch { /* corrupt */ }
    if (!parsed || typeof parsed !== 'object') {
      diag('[migrate] legacy overlay-state.json unparseable — skip');
      return;
    }
    // Only worth recovering if the LEGACY file actually holds real user data.
    if (!stateHasRealData(parsed)) {
      diag('[migrate] legacy overlay-state.json has no real user data — skip');
      return;
    }

    // Decide whether the CURRENT state may be replaced.
    let reason = null;
    if (!fs.existsSync(currentState)) {
      reason = 'missing';
    } else {
      // Current exists — only overwrite if it's a provably-pristine default.
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(currentState, 'utf8')); } catch { /* treat as pristine below */ }
      if (cur && stateHasRealData(cur)) {
        diag('[migrate] current overlay-state.json has real user data — skip (never overwrite)');
        return;
      }
      reason = 'pristine-current';
    }

    try { fs.mkdirSync(currentDir, { recursive: true }); } catch { /* ignore */ }
    fs.copyFileSync(legacyState, currentState);
    diag('[migrate] recovered overlay-state.json from legacy userData (reason=' + reason + ')',
      'legacyDir=' + legacyDir,
      'installToken=' + (parsed.installToken ? parsed.installToken.slice(0, 8) + '…' : 'none'),
      'username=' + (parsed.username || '?'),
      'discordLinked=' + (parsed.discordLinked === true),
      'userRole=' + (parsed.userRole || 'none'),
      'hasSettings=' + (parsed.settings && Object.keys(parsed.settings).length > 0 ? Object.keys(parsed.settings).length + ' keys' : 'no'),
      'hasBounds=' + (parsed.bounds || (parsed.width && parsed.height) ? 'yes' : 'no'));
  } catch (e) {
    try { diag('[migrate] non-fatal migration error:', e && e.message ? e.message : String(e)); } catch { /* ignore */ }
  }
}

// Persist the current window bounds so it reopens where the user left it.
// While COLLAPSED (idle-faded), persist the remembered EXPANDED height instead
// of the shrunken header height — otherwise a reopen / next launch would be
// stuck at header height. x/y/width still track live.
// Modal-fit restore snapshot — see the "Temporary modal-fit growth" block below.
// Declared up here because persistBounds() reads it. Non-null ONLY while we are
// holding the window inflated for a modal.
let modalFitPrevBounds = null;

// While temporarily grown to fit a modal (see modalFitPrevBounds), persist the
// user's real PRE-MODAL size — never the inflated one. Without this the debounced
// resize save (and the before-quit save) would bake the temporary size in as the
// user's window size. x/y still track live so moving the window while a modal is
// open is kept.
// Last size actually written to overlay-state.json. Seeded from the loaded state
// at startup so the very first save after launch already has a reference point —
// otherwise the launch-time setBounds would bank one drift step per run.
let lastPersistedSize = null;

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  const b = mainWindow.getBounds();
  const width = modalFitPrevBounds ? modalFitPrevBounds.width : b.width;
  const baseHeight = modalFitPrevBounds ? modalFitPrevBounds.height : b.height;
  const height = collapsed ? (expandedHeight || baseHeight) : baseHeight;

  // Suppress fractional-scaling round-trip drift (#427): a size within a couple of
  // px of what we last wrote is rounding noise, not a resize. Persisting it would
  // feed the next setBounds and grow the window ~1px per cycle, forever. Skipped
  // while collapsed / modal-inflated, where the value above is already a remembered
  // size rather than a live measurement.
  const usingRememberedSize = collapsed || !!modalFitPrevBounds;
  const size = usingRememberedSize
    ? { width, height }
    : overlayCore.resolvePersistedSize({ width, height }, lastPersistedSize);

  lastPersistedSize = { width: size.width, height: size.height };
  saveState({ bounds: { x: b.x, y: b.y, width: size.width, height: size.height } });
}

// Clamp a desired bounds rect to the work area of whatever display it lands on,
// so the window never exceeds the screen and its top is never above y=0. Returns
// a sanitized { x, y, width, height }.
function clampToWorkArea(desired) {
  // Pick the display nearest the desired position (falls back to primary).
  const point = { x: desired.x ?? 60, y: desired.y ?? 60 };
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
  // Pure clamping math lives in overlay-core.js; inject the resolved work area.
  return overlayCore.clampToWorkArea(desired, display.workArea);
}

// ─── Temporary modal-fit growth (issue #374) ──────────────────────────────────
// The shell settings / onboarding panels live inside this window, so their
// `max-width: 96vw` / `max-height: 90vh` caps are relative to the OVERLAY, not
// the screen. Kept compact for gameplay (down to 320x280) the settings panel is
// squeezed to ~307x252 and becomes impractical to use. Nothing in the renderer
// can paint outside its own OS window, so the fix has to happen here: grow the
// window while a modal is open, then put the user's size back.
//
// State lives in `modalFitPrevBounds` (declared above persistBounds, which reads
// it): it doubles as the restore snapshot and as the "don't persist this size"
// flag.
function growWindowForModal() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (modalFitPrevBounds) return;  // already grown — don't stack snapshots
  // Idle-collapse owns the height while collapsed; opening a modal marks
  // activity and expands first, so leave the collapsed case alone entirely.
  if (collapsed) return;
  // Also stay out of the way of a running collapse/expand animation.
  // animateHeightTo() freezes the width at animation start and re-applies it on
  // every frame, so growing mid-flight would be fought and reverted — and worse,
  // the snapshot we took would be a meaningless interim size that we'd then
  // "restore" on close. Skipping just means no growth for this one open.
  if (collapseAnim) return;
  const cur = mainWindow.getBounds();
  const point = { x: cur.x, y: cur.y };
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
  const grown = overlayCore.modalFitBounds(cur, display.workArea);
  if (!grown) return;  // already big enough (or the display can't fit more)
  modalFitPrevBounds = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
  diag('[modal-fit] growing ' + cur.width + 'x' + cur.height
    + ' -> ' + grown.width + 'x' + grown.height + ' for modal');
  try { mainWindow.setBounds(grown); } catch { /* ignore */ }
}

function restoreWindowAfterModal() {
  const prev = modalFitPrevBounds;
  modalFitPrevBounds = null;
  if (!prev) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Restore the SIZE only — keep the live x/y, since the user may have dragged
  // the window while the modal was open and we must not teleport it back.
  const cur = mainWindow.getBounds();
  const target = clampToWorkArea({ x: cur.x, y: cur.y, width: prev.width, height: prev.height });
  diag('[modal-fit] restoring ' + cur.width + 'x' + cur.height
    + ' -> ' + target.width + 'x' + target.height + ' after modal');
  try { mainWindow.setBounds(target); } catch { /* ignore */ }
}

// ─── Register: POST /api/users → session token ────────────────────────────────
// CF/edge response handling: treat 403/503 (challenge/WAF block) and 429
// (rate-limit) as transient connectivity conditions so callers can surface them
// through relay:status with a clear message rather than crashing. Detection:
//   • 429 → rate-limited; caller should backoff before retry.
//   • 403/503 with cf-mitigated header OR text/html body → CF challenge/WAF block.
const isCfChallenge = overlayCore.isCfChallenge;

function registerForToken(state, clientKey) {
  return new Promise((resolve, reject) => {
    const _isDev = !app.isPackaged;
    const _regBody = { username: state.username, installToken: state.installToken };
    // DEV-ONLY (local backend only): the backend's POST /api/users enforces a
    // Discord-link gate that can't be satisfied without Discord OAuth, which isn't
    // configured for local dev. When unpackaged AND the relay is localhost, attach
    // a synthetic, deterministic discordId (derived from the installToken) so a
    // local dev overlay can register without Discord. NEVER sent to a non-local
    // relay (prod / dev.falloutchatmod.com) — isLocalRelay() gates on loopback.
    if (_isDev && overlayCore.isLocalRelay(RELAY_HTTP)) {
      _regBody.discordId = overlayCore.syntheticDevDiscordId(state.installToken);
      _regBody.discordUsername = 'LocalDev';
      try { diag('[relay] LOCAL dev backend — synthetic discordId sent to bypass the Discord-link gate'); } catch { /* ignore */ }
    }
    const body = JSON.stringify(_regBody);
    const url = new URL(RELAY_HTTP + '/api/users');
    // Dev-mode rate-limit bypass — AUTOMATIC. When the overlay runs unpackaged
    // (app.isPackaged === false, i.e. `electron .` / `npm start`), it's a dev/test
    // client that relaunches constantly and would otherwise trip the registration
    // limiter ("Too many registrations"). We flag it with X-Overlay-Dev so the
    // backend skips rate limiting. Installed/packaged builds (real users) are
    // packaged → never send this → stay rate-limited. No tokens or env needed.
    const _regHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-App-Client-Key': clientKey,
      'User-Agent': APP_UA,
      'Origin': RELAY_HTTP,
    };
    if (_isDev) {
      _regHeaders['X-Overlay-Dev'] = '1';
      try { diag('[relay] dev mode (unpackaged) — sending X-Overlay-Dev to bypass rate limit'); } catch { /* ignore */ }
    }
    const req = httpModule(url).request(
      {
        hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'POST',
        headers: _regHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          // Cloudflare / edge transient conditions — surface with a clear label so
          // the retry UI shows a useful message instead of a JSON parse error.
          if (res.statusCode === 429) {
            return reject(Object.assign(new Error(`register HTTP 429: rate-limited — please wait a moment`), { cfTransient: true, statusCode: 429 }));
          }
          // Discord-gate: check BEFORE isCfChallenge — the backend returns a JSON 403
          // for unlinked accounts, which isCfChallenge would otherwise swallow.
          if (res.statusCode === 403) {
            try {
              const body403 = JSON.parse(data);
              if (body403 && body403.discord_auth_required) {
                return reject(Object.assign(new Error('discord_auth_required'), { discordAuthRequired: true }));
              }
            } catch { /* fall through */ }
          }
          if (isCfChallenge(res.statusCode, res.headers, data)) {
            return reject(Object.assign(new Error(`register HTTP ${res.statusCode}: connection blocked by edge (CF challenge/WAF) — please retry`), { cfTransient: true, statusCode: res.statusCode }));
          }
          if (res.statusCode !== 201 && res.statusCode !== 200) return reject(new Error(`register HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          try {
            const json = JSON.parse(data);
            if (!json?.data?.token) return reject(new Error('register: no token'));
            resolve({
              token: json.data.token,
              userId: json.data.userId,
              displayName: json.data.displayName,
              discordLinked: !!json.data.discordLinked,
              discordName: json.data.discordDisplayName || json.data.discordUsername || null,
              discordUsername: json.data.discordUsername || null,
              discordDisplayName: json.data.discordDisplayName || null,
              discordAvatarUrl: json.data.discordAvatarUrl || null,
              username: json.data.username || null,
              // Role field (null for regular users). Added backend v1.3.57.
              userRole: json.data.role || null,
              // Server-stored avatar URL (Discord CDN or same-origin /avatars path).
              // Same field the chat/party UI uses; surfaced to the renderer user ctx.
              avatarUrl: json.data.avatarUrl || null,
            });
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    // Guard against a CONNECTED-but-stalled socket (CF edge hang, half-open
    // connection, slow-loris). Without this the request never resolves OR rejects
    // and startRelay()'s await hangs forever — stranding the user on the
    // "Authenticating with relay…" screen with no error and no RETRY. On timeout
    // we destroy the socket with an ETIMEDOUT error, which startRelay() treats as
    // a network error and retries with exponential backoff.
    req.setTimeout(15000, () => {
      req.destroy(Object.assign(new Error('register timeout: relay did not respond within 15s'), { code: 'ETIMEDOUT' }));
    });
    req.write(body);
    req.end();
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ─── HTTP proxy for the renderer's shimmed fetch ──────────────────────────────
// Handles the real component's /api/* (via services/api) and /auth/ws-ticket.
// We answer /auth/ws-ticket locally (no dashboard session exists) so the
// component proceeds to open its WebSocket, which we then proxy.
ipcMain.handle('proxy:http', async (_evt, reqDesc) => {
  const { method, path: reqPath, body, headers } = reqDesc;

  // The component fetches /auth/ws-ticket to get a one-time WS ticket. We don't
  // have a dashboard session; return a synthetic ok response so it proceeds to
  // open its socket. The real auth happens on the proxied WS (X-Auth-Token).
  if (reqPath.startsWith('/auth/ws-ticket')) {
    return { status: 200, body: JSON.stringify({ data: { ticket: 'proxy' } }) };
  }

  // SSRF guard: reqPath is renderer-controlled. Resolve it strictly against the
  // relay origin and refuse anything pointing at a different host — otherwise a
  // hostile renderer could redirect the request (and the X-Auth-Token attached
  // below) to an attacker server via e.g. `@evil.com/api` or `//evil.com/api`.
  const url = overlayCore.resolveRelayProxyUrl(reqPath, RELAY_HTTP);
  if (!url) {
    return { status: 400, body: JSON.stringify({ detail: 'Refusing to proxy to a non-relay origin' }) };
  }

  return new Promise((resolve) => {
    const outHeaders = overlayCore.filterProxyHeaders(headers);
    if (sessionToken) outHeaders['X-Auth-Token'] = sessionToken;
    outHeaders['X-Client-Version'] = APP_VERSION;
    outHeaders['User-Agent'] = APP_UA;
    outHeaders['Origin'] = RELAY_HTTP;
    // Keep every proxied request from an unpackaged overlay in the same bounded
    // dev allowance as registration. The native Appearance panel issues a PATCH
    // for each deliberate picker choice; without this header only registration
    // received the dev allowance and normal cosmetic testing could trip the
    // production-sized API/cosmetics buckets. Packaged builds never send it.
    if (!app.isPackaged) outHeaders['X-Overlay-Dev'] = '1';
    // cookie is never in the allowlist, but delete defensively in case the
    // allowlist is widened in future without re-auditing this call site.
    delete outHeaders['cookie'];
    const payload = body != null ? Buffer.from(body) : null;
    if (payload) outHeaders['Content-Length'] = payload.length;
    const req = httpModule(url).request(
      { hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: method || 'GET', headers: outHeaders },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          // Keep an RFC 7807 429 from our backend intact. The old implementation
          // rewrote *every* 429 as an "edge" failure, which hid the actual limiter
          // and made a normal cosmetics-write cap look like a Cloudflare problem.
          // Non-JSON 429s are still an edge/proxy condition, so keep their safe
          // generic message rather than passing an HTML response into the renderer.
          if (res.statusCode === 429) {
            try {
              const parsed = JSON.parse(data);
              if (parsed && typeof parsed === 'object') {
                return resolve({ status: 429, body: data });
              }
            } catch { /* edge response was not JSON */ }
            return resolve({ status: 429, body: JSON.stringify({ detail: 'Rate-limited by edge — please wait a moment before retrying.' }), cfTransient: true });
          }
          if (isCfChallenge(res.statusCode, res.headers, data)) {
            return resolve({ status: res.statusCode, body: JSON.stringify({ detail: `Connection blocked by edge (CF challenge/WAF, HTTP ${res.statusCode}) — please retry.` }), cfTransient: true });
          }
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 599, body: JSON.stringify({ detail: err.message }) }));
    // A TCP connection can be established yet never produce a response (for
    // example a stalled edge connection). Without a deadline the renderer's
    // Appearance picker awaits this IPC promise forever and remains disabled.
    // Keep the proxy aligned with registerRelay's established 15s deadline.
    req.setTimeout(15_000, () => {
      req.destroy(new Error('Request timed out: the relay did not respond within 15 seconds.'));
    });
    if (payload) req.write(payload);
    req.end();
  });
});

// ─── WebSocket proxy for the renderer's shimmed WebSocket ─────────────────────

/**
 * Open a relay WebSocket for the given renderer socket id.
 * Called directly from the proxy:ws:open handler and from flushPendingWsOpens()
 * once a sessionToken becomes available.
 */
function openRelaySocket(id) {
  const sock = new WebSocket(RELAY_WS, {
    headers: {
      'X-Auth-Token': sessionToken,
      'X-Client-Version': APP_VERSION,
      'User-Agent': APP_UA,
      'Origin': RELAY_HTTP,
    },
  });
  relaySockets.set(id, sock);
  relaySendBuffers.set(id, []);
  sock.on('open', () => {
    // Flush any frames that arrived while the socket was CONNECTING.
    const buf = relaySendBuffers.get(id) || [];
    relaySendBuffers.delete(id);
    for (const frame of buf) {
      try { sock.send(frame); } catch { /* socket closed between open and flush */ break; }
    }
    sendToRenderer('proxy:ws:open', { id });
  });
  sock.on('message', (raw) => {
    const data = raw.toString();
    // Intercept app:update-available (sent by the backend on WS connect) to show a
    // passive OS notification when a newer version exists. The message is still
    // forwarded to the renderer as normal.
    try {
      const msg = JSON.parse(data);
      if (msg && msg.type === 'app:update-available' && msg.payload && typeof msg.payload.latestVersion === 'string') {
        const latestVersion = msg.payload.latestVersion;
        if (!updateNotifiedThisSession && overlayCore.cmpVersions(latestVersion, APP_VERSION) > 0) {
          updateNotifiedThisSession = true;
          pendingRendererUpdateVersion = latestVersion;
          showUpdateNotification(latestVersion);
          sendToRenderer('relay:update-available', { latestVersion });
        }
      }
    } catch { /* not JSON or not an update event — ignore */ }
    sendToRenderer('proxy:ws:message', { id, data });
  });
  sock.on('close', (code, reason) => {
    relaySockets.delete(id);
    relaySendBuffers.delete(id);
    // Golden-build lock: the dev backend rejected this build as outdated. This is
    // terminal — do NOT auto-reconnect. Tell the user to grab the current QA build.
    if (code === 4003) {
      diag('[relay] WS closed 4003 OUTDATED_BUILD — prompting update');
      try { showUpdateNotification((reason && reason.toString().split(':')[1]) || ''); } catch { /* ignore */ }
      sendToRenderer('relay:status', { state: 'error', message: 'This QA build is no longer active. Download the current QA build from the dev Discord.' });
      sendToRenderer('proxy:ws:close', { id, code, reason: reason && reason.toString() });
      return;
    }
    sendToRenderer('proxy:ws:close', { id, code, reason: reason && reason.toString() });
  });
  sock.on('error', (err) => sendToRenderer('proxy:ws:error', { id, message: err.message }));
}

/**
 * Process all pending proxy:ws:open requests that were queued because
 * sessionToken was not yet available when they arrived. Call this immediately
 * after sessionToken is set.
 */
function flushPendingWsOpens() {
  while (pendingWsOpens.length > 0) {
    const id = pendingWsOpens.shift();
    openRelaySocket(id);
  }
}

ipcMain.on('proxy:ws:open', (_evt, id) => {
  if (!sessionToken) {
    // Queue the open request instead of immediately closing with 4001.
    // flushPendingWsOpens() will process it once a token arrives.
    if (pendingWsOpens.length >= PROXY_OPEN_QUEUE_MAX) {
      // Queue full — drop oldest and close that id, accept the new one.
      const dropped = pendingWsOpens.shift();
      sendToRenderer('proxy:ws:close', { id: dropped, code: 4001, reason: 'open queue overflow' });
    }
    pendingWsOpens.push(id);
    return;
  }
  openRelaySocket(id);
});

ipcMain.on('proxy:ws:send', (_evt, { id, data }) => {
  const sock = relaySockets.get(id);
  if (!sock) return;
  if (sock.readyState === WebSocket.OPEN) {
    sock.send(data);
  } else if (sock.readyState === WebSocket.CONNECTING) {
    // Buffer the frame; it will be flushed when the socket fires 'open'.
    const buf = relaySendBuffers.get(id);
    if (buf) {
      if (buf.length >= PROXY_SEND_BUF_MAX) {
        // Buffer full — drop the oldest frame to make room.
        buf.shift();
        diag(`[proxy:ws] send buffer overflow for socket ${id} — oldest frame dropped`);
      }
      buf.push(data);
    }
  }
  // CLOSING / CLOSED: silently drop — the renderer will get a close event.
});

ipcMain.on('proxy:ws:close', (_evt, { id }) => {
  // Also clear any queued pending-open for this id.
  const idx = pendingWsOpens.indexOf(id);
  if (idx !== -1) pendingWsOpens.splice(idx, 1);
  const sock = relaySockets.get(id);
  if (sock) try { sock.close(); } catch { /* ignore */ }
  relaySockets.delete(id);
  relaySendBuffers.delete(id);
});

// Synchronous read of the durably-persisted shell settings (overlay-state.json
// → settings). The renderer seeds itself from this when localStorage is empty —
// e.g. a fresh install or a rebuild where the state file (identity + settings)
// survived/migrated but localStorage didn't. This keeps the user's applied
// settings AND skips onboarding (the `onboarded` flag lives in these settings),
// so an already-set-up user isn't run through onboarding again.
ipcMain.on('overlay:saved-settings-sync', (e) => {
  try { e.returnValue = (loadState() || {}).settings || null; }
  catch { e.returnValue = null; }
});

ipcMain.handle('overlay:get-info', () => ({
  clickThrough, toggleShortcut: currentKeybinds.toggle || TOGGLE_SHORTCUT, platform: process.platform, relayHost: RELAY_HOST,
  appVersion: APP_VERSION, keybinds: currentKeybinds, isDev: !app.isPackaged,
}));
// Let the renderer query the pending update version on init, catching any
// update signal that fired before the onUpdateAvailable listener was registered.
ipcMain.handle('overlay:get-pending-update', () => pendingRendererUpdateVersion);
// Synchronous version — used by bridge.ts to set relayBase before first render.
ipcMain.on('overlay:get-relay-host-sync', (evt) => { evt.returnValue = RELAY_HOST; });

// ─── Dev-only overlay login bypass ────────────────────────────────────────────
// Only callable in unpackaged builds. Calls the backend /api/dev/login-as endpoint
// and stores the returned session token exactly as a normal register flow would.
ipcMain.handle('overlay:dev-login-as', async (_evt, persona) => {
  if (app.isPackaged) return { ok: false, error: 'Not in dev mode' };
  const state = loadState();
  if (!state.installToken) return { ok: false, error: 'No installToken' };
  const body = JSON.stringify({ persona, installToken: state.installToken });
  return new Promise((resolve) => {
    const url = new URL(RELAY_HTTP + '/api/dev/login-as');
    const req = httpModule(url).request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Origin': RELAY_HTTP,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json?.data?.token) {
              sessionToken = json.data.token;
              flushPendingWsOpens();
              saveState({ discordLinked: true, discordName: json.data.displayName || '', userRole: json.data.role || null });
              userRole = json.data.role || null;
              rebuildTray();
              sendToRenderer('relay:status', {
                state: 'authenticated',
                displayName: json.data.displayName || '',
                discordLinked: true,
                role: json.data.role || null,
                userId: json.data.userId || null,
              });
              resolve({ ok: true });
            } else {
              resolve({ ok: false, error: data.slice(0, 200) });
            }
          } catch { resolve({ ok: false, error: 'parse error' }); }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(15000, () => req.destroy(Object.assign(new Error('dev-login timeout'), { code: 'ETIMEDOUT' })));
    req.write(body);
    req.end();
  });
});

// ─── Window-control IPC (the in-renderer ✕ / − strip) ─────────────────────────
// These give the user real window controls even under WSLg, where global hotkeys
// and the OS title bar are unavailable.
// Renderer tells us whether the chat input is focused (so we can re-focus after reload).
ipcMain.on('overlay:input-focus-state', (_evt, focused) => { inputWasFocused = !!focused; });

ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window:hide', () => hideWindowUserExplicit());
ipcMain.on('window:close', () => quitApp());
// `/hide` slash behaviour: the renderer detects the typed command and asks us to
// hide the window (re-show via tray "Show" or the toggle hotkey on native builds).
ipcMain.on('window:hide-via-slash', () => hideWindowUserExplicit());
ipcMain.on('overlay:set-click-through', (_evt, enabled) => setClickThrough(!!enabled));

// Auto click-through: the renderer streams hover state (true = pointer over
// interactive UI). When auto mode is on, an empty-space pointer makes the window
// click-through so clicks reach the game behind; hovering the UI re-enables it.
// (Native builds only — no shared desktop under WSLg.)
// IMPORTANT: when the manual click-through flag is ON, auto-interactive must NOT
// override it — a hover over the UI would otherwise re-enable mouse events while
// the user explicitly set click-through mode.
ipcMain.on('overlay:set-interactive', (_evt, interactive) => {
  if (modalInteractive) return;  // a modal (settings/onboarding) pins full interactivity
  if (!autoClickThrough || !mainWindow) return;
  if (clickThrough) return; // manual click-through takes precedence
  setMouseIgnore(!interactive, true);
});

// Modal-interactive PIN. While the settings / onboarding modal is open the
// window must be fully interactive (ignoreMouseEvents=false) so drags — e.g.
// range sliders — work, REGARDLESS of auto/manual click-through. Without this,
// `overlay:set-interactive` is a no-op when autoClickThrough is off (the common
// case) and the window stays in whatever ignore-state click-through left it in,
// so slider drags never reach the renderer. On close we restore the click-
// through state. The set-interactive + reassert + blur paths all respect this.
// Also drives the temporary modal-fit growth (#374): the same signal that pins
// interactivity tells us a full-size panel is on screen, so grow the window to
// fit it and restore the user's size on close.
ipcMain.on('overlay:set-modal', (_evt, open) => {
  modalInteractive = !!open;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (open) setMouseIgnore(false, false);
    else setMouseIgnore(clickThrough, true);
  } catch { /* ignore */ }
  // Outside the try above so a setMouseIgnore throw can't strand the window
  // inflated with no restore.
  try {
    if (open) growWindowForModal();
    else restoreWindowAfterModal();
  } catch { /* ignore */ }
});

// Idle collapse/expand driven by the renderer's idle timer + activity detector.
// { collapsed: true, headerHeight } → shrink to header (top anchored).
// { collapsed: false, focusInput? } → grow back downward (top anchored).
ipcMain.on('overlay:collapse', (_evt, { headerHeight }) => collapseToHeader(headerHeight));
ipcMain.on('overlay:expand', (_evt, { focusInput }) => expandFromHeader(!!focusInput));

// Cross-channel @mention: renderer asks main to show the overlay from tray.
// Respects canShowOverlay() — won't pop over the desktop when FO76 isn't running
// (unless the user is privileged / forceVisible). Clears userHidden the same way
// a game-launch transition does so a single mention gesture un-hides the overlay
// once; the user must explicitly re-hide it (Delete / tray Hide) to suppress again.
// Uses showInactive() so the overlay appears but keyboard focus stays with the game.
ipcMain.on('overlay:show-for-mention', () => {
  diag('[mention] overlay:show-for-mention — canShow=' + canShowOverlay() + ' userHidden=' + userHidden + ' gameRunning=' + gameRunning);
  if (!canShowOverlay()) {
    diag('[mention] skipped — canShowOverlay() false (game not running / not set up)');
    return;
  }
  // Clear userHidden so the overlay stays visible after the show (same as game-launch).
  userHidden = false;
  diag('[mention] showing overlay for cross-channel mention — userHidden cleared');
  showWindowInactive();
});

// ─── Position presets (SET POS capture + snap-to-preset hotkeys) ──────────────
// The renderer's "SET POS" reads the live window bounds; a preset hotkey
// (Shift+F1..F8) snaps the window back to a saved rect. Get/set go through main.
ipcMain.handle('window:get-bounds', () => (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.getBounds() : null);
ipcMain.on('window:set-bounds', (_evt, b) => {
  if (!mainWindow || mainWindow.isDestroyed() || !b) return;
  // Preset hotkeys are global, so they still fire while a modal is open (unlike
  // the edge-resize zones, which the shell disables then). A preset carries its
  // own width/height, so it supersedes our temporary growth: drop the restore
  // snapshot or closing the modal would undo the preset the user just snapped to.
  modalFitPrevBounds = null;
  const wa = clampToWorkArea({ x: b.x, y: b.y, width: b.width, height: b.height });
  try { mainWindow.setBounds(wa); } catch { /* ignore */ }
});

// In-app edge resize from the renderer's resize zones (shell.ts). Receives the
// proposed new bounds already computed by the renderer (pointer position math),
// clamps to MIN_WIDTH/MIN_HEIGHT and work area, applies, then debounce-persists
// so the new size survives the next launch. Mirrors the drag-guard: suppress the
// z-order heartbeat while the resize is active (isDragging already covers this
// via the will-resize / resized events, but belt-and-suspenders here too).
ipcMain.on('overlay:resize-bounds', (_evt, b) => {
  if (!mainWindow || mainWindow.isDestroyed() || !b) return;
  // A deliberate resize while a modal is open supersedes our temporary growth:
  // drop the restore snapshot so closing the modal keeps the size the user just
  // chose instead of snapping back to the pre-modal one.
  modalFitPrevBounds = null;
  const wa = clampToWorkArea({
    x: typeof b.x === 'number' ? b.x : mainWindow.getBounds().x,
    y: typeof b.y === 'number' ? b.y : mainWindow.getBounds().y,
    width: Math.max(MIN_WIDTH, typeof b.width === 'number' ? b.width : mainWindow.getBounds().width),
    height: Math.max(MIN_HEIGHT, typeof b.height === 'number' ? b.height : mainWindow.getBounds().height),
  });
  try { mainWindow.setBounds(wa); } catch { /* ignore */ }
});

// WM-independent pointer-drag MOVE (ticket #104). Receives the desired top-left
// position {x, y} from the renderer (computed from screenX/Y deltas), clamps to
// work area, and applies via setPosition. Mirrors overlay:resize-bounds but only
// repositions — width/height are kept from the current bounds.
// isDragging is already set by the 'will-move' event on WM-driven moves; for the
// pointer-drag path we don't need to toggle it separately because this IPC fires
// at pointer-move frequency (not on every frame) and setPosition does not trigger
// 'will-move' on Wayland/frameless windows. The z-order heartbeat skips while
// isDragging=true (set from will-move on WM drag), so we only suppress it here
// if a move is in progress — done by checking the isDragging flag set by will-move
// on platforms where it fires. Additive: on WM-drag platforms both paths are safe.
ipcMain.on('overlay:move-bounds', (_evt, pos) => {
  if (!mainWindow || mainWindow.isDestroyed() || !pos) return;
  if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
  const cur = mainWindow.getBounds();
  const wa = clampToWorkArea({ x: pos.x, y: pos.y, width: cur.width, height: cur.height });
  try { mainWindow.setPosition(wa.x, wa.y); } catch { /* ignore */ }
});

// ─── Main-process drag-move (Linux) ──────────────────────────────────────────
// Renderer sends move-start on pointerdown, move-tick on each pointermove, and
// move-end on pointerup. We read the cursor from screen.getCursorScreenPoint()
// (authoritative DIP, consistent with getBounds/setPosition) instead of trusting
// the renderer's screenX/Y, which can drift under fractional scaling and make the
// window jitter ("dance"). Only setPosition is used, so width/height never change.
ipcMain.on('overlay:move-start', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  movingActive = true;
  // If the overlay is idle-collapsed, expand it INSTANTLY (no animation) before the
  // drag begins. The animated wake-up grow used a frozen x/y per frame and would
  // fight the move's setPosition — snapping to full height up front avoids that
  // entirely, so the drag is pure position with a stable size.
  if (collapsed || collapseAnim) {
    if (collapseAnim) { clearInterval(collapseAnim); collapseAnim = null; collapseAnimTarget = null; }
    collapsed = false;
    try { mainWindow.setMinimumSize(MIN_WIDTH, MIN_HEIGHT); } catch { /* ignore */ }
    const targetH = (expandedHeight && expandedHeight >= MIN_HEIGHT) ? expandedHeight
      : (expandedBounds && expandedBounds.height >= MIN_HEIGHT ? expandedBounds.height : DEFAULT_HEIGHT);
    expandedBounds = null;
    const b0 = mainWindow.getBounds();
    try { mainWindow.setBounds({ x: b0.x, y: b0.y, width: b0.width, height: targetH }); } catch { /* ignore */ }
    sendToRenderer('overlay:force-expand', true); // sync the renderer's collapsed state
  }
  try {
    const c = screen.getCursorScreenPoint();
    const b = mainWindow.getBounds();
    // Capture the size ONCE at drag-start. On XWayland fractional scaling (mixed-DPI
    // KDE setups) the per-tick move feeds geometry back through KWin's scale and the
    // frameless window GROWS on every move event. We pin this captured size on every
    // tick (below) so the size can't compound — never re-reading getBounds() mid-drag.
    moveAnchor = { cursor: { x: c.x, y: c.y }, win: { x: b.x, y: b.y }, size: { width: b.width, height: b.height } };
  } catch { moveAnchor = null; }
  diag('[move] start anchor=' + JSON.stringify(moveAnchor));
});
ipcMain.on('overlay:move-tick', () => {
  if (!movingActive || !moveAnchor || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const c = screen.getCursorScreenPoint();
    const nx = Math.round(moveAnchor.win.x + (c.x - moveAnchor.cursor.x));
    const ny = Math.round(moveAnchor.win.y + (c.y - moveAnchor.cursor.y));
    // Use the LOCKED start-size (not getBounds, which may already be inflated by the
    // XWayland scaling feedback) and command it explicitly via setBounds so the window
    // is re-pinned to its real size every tick — setPosition alone let it grow on KDE
    // fractional-scaled XWayland.
    const w = moveAnchor.size.width, h = moveAnchor.size.height;
    const wa = clampToWorkArea({ x: nx, y: ny, width: w, height: h });
    mainWindow.setBounds({ x: wa.x, y: wa.y, width: w, height: h });
  } catch { /* ignore */ }
});
ipcMain.on('overlay:move-end', () => {
  movingActive = false; moveAnchor = null;
  try {
    const b = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
    diag('[move] end bounds=' + JSON.stringify(b ? { x: b.x, y: b.y } : null));
  } catch { /* ignore */ }
});

// Chrome Opacity — sends --fcm-chrome-bg-alpha CSS variable to the renderer so
// the dark panel/tab BACKGROUNDS become more transparent while text stays
// full-opacity. We keep window opacity at 1.0 (no longer call setOpacity).
ipcMain.on('window:set-opacity', (_evt, v) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const o = Math.max(0, Math.min(1, Number(v)));
  if (!Number.isFinite(o)) return;
  try {
    mainWindow.webContents.executeJavaScript(
      `document.documentElement.style.setProperty('--fcm-chrome-bg-alpha', '${o}');`
    );
  } catch { /* ignore */ }
});

// Return-to-game: after a user sends a message, hand keyboard/mouse focus back
// to Fallout 76 so they can keep playing without manually re-focusing the game.
// Only acts when the game is actually running ("if they came from the game") —
// in standalone/no-game testing there's nothing to return to, so we no-op.
//
//   • Windows: blur() releases foreground; the OS hands focus to the window
//     directly beneath (the game), and our always-on-top overlay stays visible.
//   • Linux (X11/Wayland): blurring an always-on-top window does NOT reliably
//     transfer focus to the game, so we additionally ask the window manager to
//     activate the FO76 window via wmctrl/xdotool (best-effort; silent if the
//     tool isn't installed — blur is still applied as a fallback).
ipcMain.on('overlay:return-to-game', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!gameRunning) { diag('[return-to-game] skipped — game not running'); return; }
  diag('[return-to-game] returning focus to FO76, clickThrough=' + clickThrough + ' platform=' + process.platform);
  try { mainWindow.blur(); } catch { /* ignore */ }
  // Force the renderer to blur whichever DOM element currently has focus.
  // On Linux/XWayland, mainWindow.blur() does NOT reliably deliver a DOM blur
  // event to document.activeElement — the XWayland compositor (KWin) may never
  // send FocusOut to the Chromium Aura layer, leaving the chat input as
  // document.activeElement. tickIdle() then sees typing=true and permanently
  // blocks idle-collapse. On Windows the async PowerShell helper means focus
  // leaves after blur() returns, so the DOM element may also not blur in time.
  // Sending overlay:blur-input forces the renderer to call .blur() on the active
  // element immediately, matching OS reality. (Pattern used by PoE/Exchange2.)
  sendToRenderer('overlay:blur-input');

  if (process.platform === 'win32') {
    // blur() alone does NOT reliably foreground the game on Windows (focus lands
    // on the desktop instead of the always-on-top overlay's predecessor). Spawn a
    // one-shot helper that finds Fallout76's window and SetForegroundWindow()s it.
    // The synthetic ALT tap is the standard workaround for Windows' foreground-
    // lock (which otherwise blocks a background process from stealing foreground).
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;',
      'public class FG{',
      ' [DllImport("user32")] public static extern bool SetForegroundWindow(IntPtr h);',
      ' [DllImport("user32")] public static extern bool ShowWindow(IntPtr h,int n);',
      ' [DllImport("user32")] public static extern void keybd_event(byte k,byte s,uint f,IntPtr e);',
      '}',
      '"@',
      "$p=Get-Process Fallout76,Project76_GamePass -EA SilentlyContinue | ?{$_.MainWindowHandle -ne 0} | select -First 1",
      'if($p){$h=$p.MainWindowHandle;',
      '[FG]::keybd_event(0x12,0,0,[IntPtr]::Zero);[FG]::keybd_event(0x12,0,2,[IntPtr]::Zero);',
      '[FG]::ShowWindow($h,9);[FG]::SetForegroundWindow($h)}',
    ].join('\n');
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true });
      child.on('error', (e) => diag('[return-to-game] win32 activate failed: ' + String(e && e.message || e)));
    } catch (e) { diag('[return-to-game] win32 spawn threw: ' + String(e && e.message || e)); }
  }

  if (IS_LINUX) {
    // wmctrl matches the window title substring; xdotool matches by name/class.
    // Try wmctrl first (most common), then xdotool. FO76 under Proton shows a
    // window titled "Fallout76.exe"/"Fallout76". Both are no-ops if absent.
    exec('wmctrl -a Fallout76', (err) => {
      if (err) {
        exec("xdotool search --name 'Fallout76' windowactivate", () => { /* best-effort */ });
      }
    });
  }

  // Re-apply click-through (blur may cause Electron to reset mouse-ignore),
  // unless a modal is open (it pins full interactivity).
  if (clickThrough && !modalInteractive) {
    try { setMouseIgnore(true, true); } catch { /* ignore */ }
  }
});

// Open a URL in the user's default browser (Discord OAuth link/relink/login).
ipcMain.on('shell:open-external', (_evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    try { shell.openExternal(url); } catch { /* ignore */ }
  }
});

// Renderer → main diagnostic log bridge. Lets the React renderer surface key events
// (e.g. a ChatOverlay remount / history reload) into main.log, which is the file users
// send us — renderer console.log never reaches it. Truncated + tagged to keep it tidy.
ipcMain.on('shell:diag', (_evt, msg) => {
  try { diag('[renderer] ' + String(msg).slice(0, 300)); } catch { /* ignore */ }
});

// Discord account link/relink — opens an in-app BrowserWindow so the user
// completes the Discord OAuth flow without leaving the overlay.
//
// Completion detection: we watch did-navigate / will-redirect / did-redirect-navigation
// for the backend's link/callback URL.  The callback serves a PIP_BOY_HTML success
// page at   /auth/discord/link/callback   (on success) or the same URL on error/cancel.
// Either way, arriving at that URL means the OAuth round-trip is done — we close
// the window and immediately fire discord:refresh-status so linked state updates.
//
// Note: the callback URL lives on RELAY_HTTP (the same host as the relay), not on
// localhost or a custom scheme, so a normal https: BrowserWindow can reach it fine.
ipcMain.on('discord:link', () => {
  const st = loadState();
  if (!st || !st.installToken) return;
  const linkUrl = `${RELAY_HTTP}/auth/discord/link?installToken=${encodeURIComponent(st.installToken)}`;
  // The backend's success callback lands on /auth/discord/link/callback (any status).
  const callbackPath = '/auth/discord/link/callback';

  let oauthWin = null;
  try {
    oauthWin = new BrowserWindow({
      width: 520, height: 720,
      parent: mainWindow || undefined,
      modal: false, // true would block the parent — keep it non-modal so the overlay stays usable
      title: 'Link Discord — Fallout Chat Mod',
      icon: appIcon() || undefined,
      resizable: true,
      center: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // No preload — this is a plain browser window for the Discord OAuth flow.
      },
    });
  } catch (e) {
    // BrowserWindow creation failed (rare — e.g. headless environment). Fall back.
    try { shell.openExternal(linkUrl); } catch { /* ignore */ }
    return;
  }

  const wc = oauthWin.webContents;

  // Detect navigation to the callback URL (success or error from the backend).
  // We key on the path portion so it works regardless of query params / fragments.
  const checkNav = (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === callbackPath) {
        // Give the success/error page a moment to render (UX), then close + refresh.
        setTimeout(() => {
          if (oauthWin && !oauthWin.isDestroyed()) oauthWin.close();
        }, 1200);
      }
    } catch { /* ignore invalid URLs */ }
  };

  wc.on('did-navigate', (_evt, url) => checkNav(url));
  wc.on('will-redirect', (_evt, url) => checkNav(url));
  wc.on('did-redirect-navigation', (_evt, url) => checkNav(url));

  // If the OAuth page itself fails to load (network / DNS / CF challenge), don't
  // leave a blank window the user can't act on. Fall back to their default browser
  // (which has working network + existing Discord cookies) and show a short note
  // in the window explaining what happened.
  let _oauthFellBack = false;
  const oauthFallback = (why) => {
    if (_oauthFellBack) return;
    _oauthFellBack = true;
    diag('[discord-link] OAuth window failed (' + why + ') — falling back to external browser');
    try { shell.openExternal(linkUrl); } catch { /* ignore */ }
    try {
      if (oauthWin && !oauthWin.isDestroyed()) {
        const safe = String(why).replace(/[<>&]/g, ' ');
        oauthWin.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          '<body style="font-family:system-ui,Segoe UI,sans-serif;background:#0b0f0b;color:#18FF62;padding:24px;line-height:1.5">' +
          '<h3 style="margin-top:0">Opening Discord in your browser…</h3>' +
          '<p>The in-app login could not load (' + safe + '). We opened the link in your default browser instead — ' +
          'finish linking there, then return to the overlay.</p>' +
          '<p style="opacity:.6;font-size:12px">You can close this window.</p></body>'
        )).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
  };
  wc.on('did-fail-load', (_evt, errorCode, errorDesc, _url, isMainFrame) => {
    // errorCode -3 (ABORTED) fires on our own programmatic close/redirects — ignore.
    if (!isMainFrame || errorCode === -3) return;
    oauthFallback('load error ' + errorCode + ' ' + (errorDesc || ''));
  });
  // Renderer process of the OAuth window crashed — also fall back.
  wc.on('render-process-gone', (_evt, details) => oauthFallback('render gone: ' + (details && details.reason || 'unknown')));

  // User closed the window manually before completing — treat as cancel (no crash).
  oauthWin.on('closed', () => {
    oauthWin = null;
    // Refresh discord status regardless: if they DID complete in the window before
    // closing it early, we still pick up the linked state.
    ipcMain.emit('discord:refresh-status');
  });

  oauthWin.loadURL(linkUrl).catch((e) => oauthFallback(String(e && e.message || e)));
});

// ─── QA login (golden dev build) ──────────────────────────────────────────────
// Opens the QA Discord OAuth in a window, then polls /api/auth/qa-status until the
// backend hands back a role-gated session token (or 426 OUTDATED_BUILD).
function startQaLogin() {
  const st = loadState();
  if (!st || !st.installToken) return;
  const startUrl = `${RELAY_HTTP}/auth/discord/qa/start?installToken=${encodeURIComponent(st.installToken)}`;
  const callbackPath = '/auth/discord/qa/callback';
  sendToRenderer('relay:status', { state: 'qa_required' });

  let win = null;
  try {
    win = new BrowserWindow({
      width: 520, height: 720, parent: mainWindow || undefined, modal: false,
      title: 'QA Login — Fallout Chat Mod', icon: appIcon() || undefined, center: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
  } catch {
    try { shell.openExternal(startUrl); } catch { /* ignore */ }
    pollQaStatus(0);
    return;
  }
  const wc = win.webContents;
  const checkNav = (url) => {
    try {
      if (new URL(url).pathname === callbackPath) {
        setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, 1200);
      }
    } catch { /* ignore */ }
  };
  wc.on('did-navigate', (_e, url) => checkNav(url));
  wc.on('will-redirect', (_e, url) => checkNav(url));
  wc.on('did-redirect-navigation', (_e, url) => checkNav(url));
  win.on('closed', () => { win = null; pollQaStatus(0); });
  win.loadURL(startUrl).catch(() => { try { shell.openExternal(startUrl); } catch { /* ignore */ } pollQaStatus(0); });
}

function pollQaStatus(attempt = 0) {
  const st = loadState();
  if (!st || !st.installToken) return;
  const MAX = 20;
  const url = new URL(`${RELAY_HTTP}/api/auth/qa-status/${encodeURIComponent(st.installToken)}`);
  const req = httpModule(url).request(
    { hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Client-Version': APP_VERSION } },
    (res) => {
      if (res.statusCode === 426) {
        res.resume();
        diag('[qa-status] 426 OUTDATED_BUILD');
        try { showUpdateNotification(''); } catch { /* ignore */ }
        sendToRenderer('relay:status', { state: 'error', message: 'This QA build is no longer active. Download the current QA build from the dev Discord.' });
        return;
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let d = {};
        try { d = (JSON.parse(data).data) || {}; } catch { /* ignore */ }
        if (d.authorized && d.token) {
          sessionToken = d.token;
          flushPendingWsOpens();
          saveState({ discordLinked: true, displayName: d.displayName || '', userRole: d.role || null });
          userRole = d.role || null;
          rebuildTray();
          sendToRenderer('relay:status', { state: 'authenticated', displayName: d.displayName || '', discordLinked: true, role: d.role || null });
          return;
        }
        if (attempt + 1 < MAX) setTimeout(() => pollQaStatus(attempt + 1), 1500);
        else sendToRenderer('relay:status', { state: 'error', message: 'QA login timed out. Click to retry.' });
      });
    },
  );
  req.on('error', () => { if (attempt + 1 < MAX) setTimeout(() => pollQaStatus(attempt + 1), 1500); });
  req.setTimeout(12000, () => req.destroy(new Error('qa-status timeout')));
  req.end();
}

ipcMain.handle('overlay:qa-login', async () => { startQaLogin(); return { ok: true }; });

// Discord link status refresh: poll /api/auth/discord-status/:installToken and
// broadcast the real linked state to the renderer as 'relay:discord-status'. The
// renderer calls this (via ipcMain 'discord:refresh-status') after returning from
// the OAuth flow. Poll with BOUNDED RETRIES — the user has just returned from the
// OAuth flow, so a single failed poll must NOT strand them on the login wall —
// retry a few times with short backoff before giving up. On final failure we tell
// the renderer the status is unavailable (it keeps the last known link state)
// rather than silently dropping the result.
function refreshDiscordStatus(attempt = 0) {
  const st = loadState();
  if (!st || !st.installToken) return;
  const MAX_STATUS_ATTEMPTS = 4;
  const retry = (why) => {
    if (attempt + 1 >= MAX_STATUS_ATTEMPTS) {
      diag('[discord-status] giving up after ' + MAX_STATUS_ATTEMPTS + ' attempts (' + why + ')');
      sendToRenderer('relay:discord-status', { linked: !!st.discordLinked, discordName: st.discordName || '', error: 'status-unavailable' });
      return;
    }
    const backoff = 1500 * (attempt + 1);
    diag('[discord-status] ' + why + ' — retry ' + (attempt + 1) + '/' + MAX_STATUS_ATTEMPTS + ' in ' + backoff + 'ms');
    setTimeout(() => refreshDiscordStatus(attempt + 1), backoff);
  };
  const url = new URL(RELAY_HTTP + '/api/auth/discord-status/' + encodeURIComponent(st.installToken));
  const req = httpModule(url).request(
    { hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'GET', headers: { 'Content-Type': 'application/json' } },
    (res) => {
      // Non-2xx (incl. CF challenge / 5xx) → retry rather than parse an error body.
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) { res.resume(); retry('HTTP ' + res.statusCode); return; }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const d = json?.data || {};
          const linked = !!d.linked;
          const discordName = d.discordDisplayName || d.discordUsername || '';
          const discordDisplayName = d.discordDisplayName || '';
          // Persist so the state file reflects reality.
          saveState({ discordLinked: linked, discordName });
          // Include discordDisplayName so the onboarding step-3 prefill can
          // default the FO76 name input to the user's Discord display name.
          sendToRenderer('relay:discord-status', { linked, discordName, discordDisplayName });

          // If the Discord link state just changed (false → true), the installToken
          // may have been RECLAIMED onto an existing account (e.g. "Devotek-").
          // Re-register to rebind our SESSION to that account and broadcast a fresh
          // authenticated status so the chat WS reconnects as the new identity.
          //
          // IMPORTANT: only re-register when the link state CHANGED (was unlinked,
          // now linked). Skipping the re-register for users who were ALREADY linked
          // prevents needlessly creating a new backend session on every window-focus
          // status check (throttled to 1/min). Each new session caused the backend
          // to close the existing relay WS connection, producing the "blank chat
          // after return-to-game" symptom (WS dies → user must hit Refresh).
          if (linked && !st.discordLinked) {
            const fo76 = (typeof d.username === 'string' && d.username) ? d.username : null;
            if (fo76) saveState({ username: fo76 });
            if (d.displayName) saveState({ displayName: d.displayName });
            if (d.discordAvatarUrl != null) saveState({ discordAvatarUrl: d.discordAvatarUrl || '' });
            const clientKey = resolveAppClientKey();
            const st2 = loadState();
            if (clientKey && st2 && st2.installToken) {
              registerForToken(st2, clientKey).then((r) => {
                sessionToken = r.token;
                flushPendingWsOpens();
                saveState({ displayName: r.displayName || st2.displayName, discordLinked: !!r.discordLinked, discordName: r.discordName || discordName });
                if (r.username != null) saveState({ username: r.username });
                if (r.discordAvatarUrl != null) saveState({ discordAvatarUrl: r.discordAvatarUrl || '' });
                // Adopt the resolved role + avatar from the re-register so mod
                // controls appear immediately after a Discord link (no restart).
                if (r.userRole) saveState({ userRole: r.userRole }); else saveState({ userRole: null });
                if (r.avatarUrl != null) saveState({ avatarUrl: r.avatarUrl || '' });
                const prevRoleLink = userRole;
                userRole = r.userRole || null;
                if (userRole !== prevRoleLink) rebuildTray();
                sendToRenderer('relay:status', {
                  state: 'authenticated',
                  displayName: r.displayName || d.displayName || discordName,
                  discordLinked: !!r.discordLinked,
                  discordName: r.discordName || discordName,
                  discordUsername: r.discordUsername || '',
                  discordDisplayName: r.discordDisplayName || '',
                  discordAvatarUrl: r.discordAvatarUrl || d.discordAvatarUrl || null,
                  username: r.username || fo76 || '',
                  role: r.userRole || null,
                  avatarUrl: r.avatarUrl || loadState()?.avatarUrl || null,
                });
              }).catch((e) => {
                // The link succeeded on the backend (relay:discord-status already
                // told the renderer), but rebinding our SESSION to the reclaimed
                // account failed. Don't leave the user in limbo — recover the
                // session via the fully-retrying startRelay(), which re-registers
                // and re-broadcasts authenticated status once the relay responds.
                diag('[discord-status] post-link re-register failed: ' + String(e && e.message || e) + ' — recovering via startRelay()');
                startRelay().catch(() => { /* startRelay surfaces its own errors */ });
              });
            }
          }
        } catch { retry('parse error'); }
      });
    },
  );
  req.on('error', () => retry('network error'));
  // Same stalled-socket guard as registerForToken — a hung poll must fall into the
  // retry path, not block forever.
  req.setTimeout(12000, () => req.destroy(new Error('discord-status timeout')));
  req.end();
}
ipcMain.on('discord:refresh-status', () => refreshDiscordStatus(0));

// Identity: set the FO76 character name as the chat display name.
// Re-registers with the backend using the entered name as `username` (the
// backend upserts by installToken and calls refreshClientIdentity to update any
// open WS sockets in place). On success we update the in-memory session token
// (a fresh one is issued by register) and broadcast a new 'relay:status' so the
// renderer remounts the component with the updated displayName.
//
// Graceful conflict handling: the backend returns 409 when the name is already
// taken by another user (and it isn't a Discord self-reclaim). We surface that
// as { ok: false, reason: 'taken' } so onboarding can show a gentle note WITHOUT
// blocking completion — the user keeps their existing generated name.
ipcMain.handle('identity:set-name', async (_evt, rawName) => {
  const name = (typeof rawName === 'string' ? rawName : '').trim();
  if (!name) return { ok: false, reason: 'empty' };
  const clientKey = resolveAppClientKey();
  if (!clientKey) return { ok: false, reason: 'no-client-key' };

  const st = loadState();
  if (!st || !st.installToken) return { ok: false, reason: 'no-install-token' };

  // Re-register with the new username. registerForToken posts { username,
  // installToken }; the backend upserts by installToken so this RENAMES the row.
  const renameState = { ...st, username: name };
  try {
    const { token, displayName, discordLinked, discordName, discordUsername, discordDisplayName, discordAvatarUrl, username: savedUsername, userRole: renameRole, avatarUrl: renameAvatarUrl } =
      await registerForToken(renameState, clientKey);
    sessionToken = token;
    flushPendingWsOpens();
    // Persist the new username + resolved display name so future launches use it.
    saveState({ username: name, displayName: displayName || name });
    saveState({ discordLinked: !!discordLinked, discordName: discordName || '' });
    if (discordUsername != null) saveState({ discordUsername: discordUsername || '' });
    if (discordDisplayName != null) saveState({ discordDisplayName: discordDisplayName || '' });
    if (discordAvatarUrl != null) saveState({ discordAvatarUrl: discordAvatarUrl || '' });
    if (renameRole) saveState({ userRole: renameRole }); else saveState({ userRole: null });
    if (renameAvatarUrl != null) saveState({ avatarUrl: renameAvatarUrl || '' });
    const prevRoleRename = userRole;
    userRole = renameRole || null;
    if (userRole !== prevRoleRename) rebuildTray();
    // Re-broadcast authenticated status so the renderer remounts the overlay and
    // the chat now renders under the new name. The WS identity was already
    // refreshed server-side by register → refreshClientIdentity.
    sendToRenderer('relay:status', {
      state: 'authenticated',
      displayName: displayName || name,
      discordLinked: !!discordLinked,
      discordName: discordName || '',
      discordUsername: discordUsername || '',
      discordDisplayName: discordDisplayName || '',
      discordAvatarUrl: discordAvatarUrl || null,
      username: savedUsername || name,
      role: renameRole || null,
      avatarUrl: renameAvatarUrl || loadState()?.avatarUrl || null,
    });
    return { ok: true, displayName: displayName || name };
  } catch (err) {
    const msg = String(err && err.message || err);
    // registerForToken rejects with "register HTTP 409: ..." when the name is
    // taken by another (non-self) user. Treat that as a soft failure.
    if (/HTTP 409/.test(msg)) return { ok: false, reason: 'taken' };
    return { ok: false, reason: 'error', message: msg };
  }
});

// Renderer signals whether the user is fully set up (authenticated + past
// onboarding). When true the game-gate is enforced; when false the overlay is
// always allowed (so onboarding / login are never suppressed).
ipcMain.on('overlay:chat-active', (_evt, active) => {
  const prev = chatActive;
  chatActive = !!active;
  if (chatActive !== prev) {
    diag('[game-gate] chatActive → ' + chatActive + ' gameRunning=' + gameRunning + ' isPrivileged=' + isPrivileged());
    // If the user just finished setup and the game isn't running, apply the gate.
    reevaluateVisibility();
  }
});

// Show a native OS notification (Windows toast / Linux libnotify). No-op if the
// platform doesn't support it. Used to guide the user after onboarding.
function showSystemNotification(title, body) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) {
      diag('[notify] not supported — skipping: ' + title);
      return;
    }
    const n = new Notification({ title, body, icon: appIcon() || undefined, silent: false });
    // Clicking the toast brings the overlay forward (useful once the game is up).
    n.on('click', () => { try { focusToChat(); } catch { /* non-fatal */ } });
    n.show();
    diag('[notify] shown: ' + title + ' — ' + body);
  } catch (e) {
    diag('[notify] failed: ' + String(e && e.message || e));
  }
}

// Module-level reference so the Notification object survives garbage collection
// until the user clicks/closes it. On Linux the click (default action) arrives
// asynchronously over D-Bus, often well after showUpdateNotification() returns —
// if the local object had been GC'd, the click handler would silently never fire
// (which is exactly why an earlier build's toast "did nothing" when clicked).
let _activeUpdateNotification = null;

// Show a passive OS notification when the backend reports a newer version on WS
// connect. Clicking the toast opens the Nexus mod page so the user can download
// the update manually. Downloads and installs nothing.
function showUpdateNotification(version) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) {
      diag('[notify] not supported — skipping update notification v' + version);
      return;
    }
    const title = `Update!  v${version}`;
    const body = 'A new version of Fallout Chat Mod is available. Click to get it on Nexus Mods.';
    const n = new Notification({ title, body, icon: appIcon() || undefined, silent: false });
    _activeUpdateNotification = n; // keep alive until clicked/closed (see note above)
    const openNexus = (src) => {
      diag('[notify] ' + src + ' → opening Nexus: ' + NEXUS_MOD_URL);
      try { shell.openExternal(NEXUS_MOD_URL); }
      catch (e) { diag('[notify] shell.openExternal failed: ' + String(e && e.message || e)); }
    };
    n.on('click', () => openNexus('click'));
    n.on('action', () => openNexus('action')); // macOS action button (no-op elsewhere)
    n.on('close', () => { if (_activeUpdateNotification === n) _activeUpdateNotification = null; });
    n.show();
    diag('[notify] update available: v' + version + ' — shown (click opens Nexus)');
  } catch (e) {
    diag('[notify] update notification failed: ' + String(e && e.message || e));
  }
}

// Onboarding just completed. Engage the game gate (chatActive=true), then guide
// the user with a system notification:
//   • FO76 already running → overlay stays up; tell them it's active.
//   • FO76 not running     → overlay drops to the tray; tell them to launch the
//     game and it will appear automatically (the game-gate auto-shows it when
//     FO76 starts — userHidden stays false here so reevaluateVisibility restores
//     it on the not-running→running transition).
// Privileged/force-visible users are never gated, so the guidance is skipped.
ipcMain.on('overlay:onboarding-complete', () => {
  const prev = chatActive;
  chatActive = true;
  diag('[onboarding] complete — chatActive=true gameRunning=' + gameRunning + ' isPrivileged=' + isPrivileged() + ' forceVisible=' + forceVisible);
  if (prev !== true) reevaluateVisibility();

  if (isPrivileged() || forceVisible) return;

  if (gameRunning) {
    showSystemNotification('Fallout Chat Mod — setup complete', 'Fallout 76 is already running. The chat overlay is active in-game.');
  } else {
    showSystemNotification('Fallout Chat Mod — setup complete', 'Launch Fallout 76 and the chat overlay will appear automatically.');
  }
});

// Persist the full settings superset to the state file and re-register the
// global shortcuts from the (possibly changed) keybinds.
ipcMain.on('overlay:save-settings', (_evt, settings) => {
  if (!settings || typeof settings !== 'object') return;
  saveState({ settings });
  if (settings.keybinds) registerHotkeys(settings.keybinds, settings.presets);
});

// ─── Bootstrap: resolve key → register → tell renderer it can connect ─────────
// CF/edge transient handling: if registerForToken rejects with cfTransient=true
// (CF challenge, WAF block, or rate-limit), we surface a clear message through
// relay:status and schedule an auto-retry with a short backoff so the user sees
// the retry UI rather than a silent failure. Backoff: 429 → 10 s, other → 5 s.
async function startRelay(retryCount = 0) {
  const clientKey = resolveAppClientKey();
  if (!clientKey) {
    sendToRenderer('relay:status', { state: 'error', message: 'No APP_CLIENT_KEY (set env or run from inside the repo).' });
    return;
  }
  try {
    const { token, userId: regUserId, displayName, discordLinked, discordName, discordUsername, discordDisplayName, discordAvatarUrl, username: regUsername, userRole: role, avatarUrl: regAvatarUrl } = await registerForToken(loadState(), clientKey);
    sessionToken = token;
    flushPendingWsOpens();
    diag('[relay] registered OK — displayName=' + (displayName || '(none)') + ' discordLinked=' + !!discordLinked + ' role=' + (role || 'user'));
    // Persist the resolved display name (may be FO76 name or Discord display name)
    // so the settings panel can pre-populate the fo76Name field on next launch.
    if (displayName) saveState({ displayName });
    // Persist real Discord link state so it survives a renderer reload.
    saveState({ discordLinked: !!discordLinked, discordName: discordName || '' });
    if (discordUsername != null) saveState({ discordUsername: discordUsername || '' });
    if (discordDisplayName != null) saveState({ discordDisplayName: discordDisplayName || '' });
    if (discordAvatarUrl != null) saveState({ discordAvatarUrl: discordAvatarUrl || '' });
    // Persist role so the tray item can be rebuilt on next launch.
    if (role) saveState({ userRole: role }); else saveState({ userRole: null });
    // Persist the server-stored avatar URL so non-register status paths can fall
    // back to it.
    if (regAvatarUrl != null) saveState({ avatarUrl: regAvatarUrl || '' });
    // Update the live role and rebuild the tray if needed.
    const prevRole = userRole;
    userRole = role || null;
    if (userRole !== prevRole) rebuildTray();
    // If the user is privileged, re-evaluate visibility now so they can open the
    // overlay without the game from the moment register completes.
    if (isPrivileged()) reevaluateVisibility();
    sendToRenderer('relay:status', {
      state: 'authenticated',
      displayName: displayName || '',
      discordLinked: !!discordLinked,
      discordName: discordName || '',
      discordUsername: discordUsername || '',
      discordDisplayName: discordDisplayName || '',
      discordAvatarUrl: discordAvatarUrl || null,
      username: regUsername || '',
      role: role || null,
      userId: regUserId || null,
      avatarUrl: regAvatarUrl || loadState()?.avatarUrl || null,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (err && err.discordAuthRequired) {
      // Backend Discord-gate: this install has no linked Discord account.
      // Tell the renderer to show the blocking login wall. Never auto-retry —
      // the user must complete Discord OAuth first.
      diag('[relay] discord auth required — showing login wall');
      sendToRenderer('relay:status', { state: 'discord_required' });
      return;
    }
    if (err && err.cfTransient) {
      // Cloudflare / edge transient condition (challenge, WAF block, rate-limit).
      // Clamp retries to avoid hammering CF during an outage; surface to retry UI.
      const backoffMs = err.statusCode === 429 ? 10_000 : 5_000;
      const maxRetries = 3;
      sendToRenderer('relay:status', {
        state: 'error',
        message: msg,
        cfTransient: true,
        // Signal the renderer that an auto-retry is coming so it can show a
        // "retrying…" note rather than a hard failure.
        autoRetryMs: retryCount < maxRetries ? backoffMs : 0,
      });
      if (retryCount < maxRetries) {
        setTimeout(() => startRelay(retryCount + 1), backoffMs);
      }
      return;
    }
    // Network-level failure (ECONNREFUSED, AggregateError, socket hang up) —
    // the server is temporarily unreachable. Retry with exponential backoff up
    // to ~2 minutes, then give up and show the error so the user knows.
    const isNetworkError = (
      err instanceof AggregateError ||
      (err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT')) ||
      msg.includes('ECONNREFUSED') || msg.includes('socket hang up') || msg.includes('AggregateError') ||
      msg.includes('ETIMEDOUT') || msg.includes('timeout')
    );
    const MAX_NET_RETRIES = 8;
    if (isNetworkError && retryCount < MAX_NET_RETRIES) {
      // Exponential backoff: 5s, 10s, 20s, 30s, 60s, 60s, 60s, 60s
      const backoffMs = Math.min(60_000, 5_000 * Math.pow(2, Math.min(retryCount, 3)));
      diag(`[relay] register FAILED (network): ${msg} — retry ${retryCount + 1}/${MAX_NET_RETRIES} in ${backoffMs / 1000}s`);
      sendToRenderer('relay:status', { state: 'error', message: 'register failed: ' + msg, autoRetryMs: backoffMs });
      setTimeout(() => startRelay(retryCount + 1), backoffMs);
      return;
    }
    diag('[relay] register FAILED: ' + msg);
    sendToRenderer('relay:status', { state: 'error', message: 'register failed: ' + msg });
  }
}

// ─── Window show / focus helpers ──────────────────────────────────────────────
// _doShow: unconditional show, bypassing the game gate. Used internally by
// showWindow (after gate check) and reevaluateVisibility (after canShowOverlay).
// Never call this directly from hotkeys or tray — use showWindow() instead.
// ── Transparent-window blur fix (Windows) ─────────────────────────────────────
// Electron transparent BrowserWindows on Windows are composited through
// DirectComposition/DWM. With no input, DWM presents a CACHED (stale) frame of the
// surface and does not re-rasterize — so the overlay looks blurry/soft at rest and
// snaps sharp the instant the cursor moves over it or focus changes (the user's
// "it unblurs when I move my cursor over it"). webContents.invalidate() schedules a
// fresh paint; running it on a low-frequency timer while the overlay is visible keeps
// the surface crisp. Cost is near-zero (Chromium no-ops the tick when nothing is
// dirty). Win32-only — the DWM stale-surface issue does not occur on macOS/Linux, and
// invalidate() does NOT call setAlwaysOnTop, so it cannot cause the DWM-recomposition
// flash the z-order code carefully avoids.
let repaintTimer = null;
function repaintNow() {
  if (process.platform !== 'win32') return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.invalidate(); } catch { /* ignore */ }
}
function startRepaintTimer() {
  if (process.platform !== 'win32') return;
  if (repaintTimer) return; // already running
  repaintTimer = setInterval(repaintNow, 250); // 4 fps — imperceptible CPU, beats DWM staleness
}
function stopRepaintTimer() {
  if (repaintTimer) { clearInterval(repaintTimer); repaintTimer = null; }
}

function _doShow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  try { mainWindow.setFocusable(true); } catch { /* not critical */ }
  mainWindow.show();
  emitVisibility(true);
  startRepaintTimer(); // keep the transparent surface from going stale/blurry while visible
}

// showWindow: gated show. If the user is fully set up but FO76 is not running
// (and they're not privileged / force-visible), suppress the show and notify.
function showWindow() {
  if (!canShowOverlay()) {
    notifyGameRequired();
    return;
  }
  userHidden = false; // tray Show clears explicit-hide flag
  _doShow();
}

// Like showWindow() but does NOT activate/focus the overlay — used by the tab-
// navigation keybinds (/, \, per-party) so they make the overlay visible/topmost
// while leaving keyboard focus with the GAME (the user presses Insert to type).
// mainWindow.show() focuses the window (and the input regains DOM focus);
// showInactive() avoids that.
// Game gate is bypassed — these are all explicit hotkey actions; blocking them
// when FO76 isn't running would silently swallow deliberate key presses.
function showWindowInactive() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  try { mainWindow.showInactive(); } catch { _doShow(); return; }
  emitVisibility(true);
  startRepaintTimer(); // keep the transparent surface crisp while visible
}

function hideWindow() {
  diag('[hide] hiding to tray');
  stopRepaintTimer(); // window is hidden — no need to keep forcing repaints
  if (mainWindow) mainWindow.hide();
  emitVisibility(false);
}

// hideWindowUserExplicit: called when the USER intentionally hides (Delete / /hide / tray Hide).
// Sets userHidden=true so reevaluateVisibility won't auto-restore until game-launch or Insert/Show.
function hideWindowUserExplicit() {
  userHidden = true;
  diag('[hide] user explicit hide — userHidden=true');
  hideWindow();
}

// toggleWindow: bound to the Delete key (and the tray click).
// HIDE path: calls hideWindowUserExplicit() which sets userHidden=true -- the
//   app moves to the system tray but does NOT quit. The game-gate will not
//   auto-restore the overlay until userHidden is cleared (Insert / tray Show /
//   game-launch transition).
// SHOW path: clears userHidden and bypasses canShowOverlay() because an
//   explicit hotkey press should always restore the overlay regardless of state.
function toggleWindow() {
  if (!mainWindow) return;
  const visible = mainWindow.isVisible() && !mainWindow.isMinimized();
  diag('[toggle] visible=' + visible + ' -> ' + (visible ? 'hide' : 'show'));
  if (visible) {
    hideWindowUserExplicit(); // Delete = explicit hide-to-tray (not quit)
  } else {
    userHidden = false; // show clears the flag
    _doShow(); // bypass gate -- explicit hotkey should always show
  }
}

// reevaluateVisibility: re-check canShowOverlay and show or hide accordingly.
// Called after game-detection changes or after auth/setup completes.
// NOTE: does NOT auto-show while userHidden=true (user explicitly hid with Delete/tray).
function reevaluateVisibility() {
  if (overlayCore.visibilityDecision(canShowOverlay(), userHidden) === 'show') _doShow();
  else hideWindow();
}

// Focus-to-chat (the desktop overlay's "Insert opens chat input" behaviour):
// show, take focus, and become interactive so the user can type immediately.
// If the overlay is currently collapsed (idle-faded), expand it FIRST — growing
// the height downward with the top anchored (no upward jump) — then focus the
// input. The renderer also fires its own activity reset.
//
// Windows focus-steal note: Windows restricts which processes can call
// SetForegroundWindow (the "foreground lock"). An always-on-top overlay sitting
// behind an active game cannot steal foreground with mainWindow.focus() alone
// — focus stays on the game and the user still must Alt-Tab. The fix is
// app.focus({ steal: true }), which Electron implements by first calling
// AllowSetForegroundWindow(pid) on the calling process (bypassing the lock),
// then forwarding to SetForegroundWindow. We call this on BOTH the
// hidden (restore-from-tray) and visible (already-shown) paths so Insert
// always delivers real foreground focus to the chat input on win32.
function _stealForegroundWin32() {
  if (process.platform !== 'win32') return;
  // app.focus({ steal: true }) is the Electron-blessed way to bypass the
  // Windows foreground-lock for a background/overlay process. It must be
  // called AFTER the window is already shown/focusable.
  try { app.focus({ steal: true }); } catch { /* ignore — older Electron */ }
}

function dispatchFocusInput(reason) {
  diag('[focusToChat] dispatch overlay:focus-input reason=' + reason);
  sendToRenderer('overlay:focus-input', true);
}

function focusToChat() {
  if (!mainWindow) return;
  // Treat the window as hidden if it is not visible OR if it is hidden-to-tray
  // (userHidden=true means the user pressed Delete; the window should be hidden
  // but defend against edge cases where isVisible() is true yet tray-hidden).
  const wasHidden = !mainWindow.isVisible() || mainWindow.isMinimized() || (userHidden && !mainWindow.isFocused());
  if (wasHidden) {
    diag('[focusToChat] hidden/tray branch — collapsed=' + collapsed + ' userHidden=' + userHidden + ' isVisible=' + mainWindow.isVisible());
    // One-press Insert restore: show the overlay and focus the input immediately.
    // Clear userHidden so the overlay stays visible after an explicit-hide.
    userHidden = false;
    lastUserFocusMs = Date.now();
    try { mainWindow.setFocusable(true); } catch { /* not critical */ }
    setClickThrough(false);
    if (mainWindow.isMinimized()) mainWindow.restore();
    // showInactive first for correct z-order on Windows (avoids DWM flash from a
    // full show()), then immediately focus so the user can type without a second press.
    try { mainWindow.showInactive(); } catch { mainWindow.show(); }
    // Re-assert always-on-top so the overlay is above the game before we steal focus.
    overlayIsTopmost = false; // force applyZOrder to re-apply
    applyZOrder();
    // focus() after showInactive so the window is focusable before we call it.
    mainWindow.focus();
    // Windows: use app.focus({steal:true}) to bypass the foreground-lock that
    // prevents an overlay from pulling focus away from the active game window.
    // Without this the user still has to Alt-Tab even though Insert was pressed.
    _stealForegroundWin32();
    // Tell the renderer the overlay is visible again so the WS gate reconnects.
    // Without this the renderer's overlayVisible stays false after the 20s grace
    // fires (hide→show via Insert) and the WS stays disconnected with no live chat.
    emitVisibility(true);
    dispatchFocusInput('focusToChat:hidden-immediate');
    if (collapsed) {
      sendToRenderer('overlay:force-expand', true);
      expandFromHeader(true);
    }
    return;
  }
  // Overlay already visible (the common idle-collapsed case): re-enable focus,
  // disable click-through, and focus the input IMMEDIATELY.
  diag('[focusToChat] visible branch — collapsed=' + collapsed + ' focused=' + mainWindow.isFocused());
  lastUserFocusMs = Date.now();
  try { mainWindow.setFocusable(true); } catch { /* not critical */ }
  setClickThrough(false);
  // Do NOT call _doShow()/show() here: the window is already visible, and calling
  // show() on a transparent window triggers a DWM recomposition that reads as the
  // chat "reloading". Focus NOW — don't defer behind the 240ms expand animation, or
  // the 300ms foreground poll wins the race and bounces focus back to the game.
  mainWindow.focus();
  // Windows: bypass the foreground-lock even on the already-visible path.
  // When the game is foreground, mainWindow.focus() alone does not pull focus
  // to the overlay — the OS denies it. app.focus({steal:true}) overrides this.
  _stealForegroundWin32();
  dispatchFocusInput('focusToChat:visible-immediate');
  if (collapsed) {
    sendToRenderer('overlay:force-expand', true);
    expandFromHeader(true);
  }
}

// Channel navigation + settings are owned by the React component; the renderer
// translates these commands into tab clicks / the settings ⚙ button.
//
// nextChannel / prevChannel / recentParty / goFo76 / goPartyIndex: show the
// overlay (so it is visible/topmost) and fire the renderer command, but do NOT
// steal keyboard focus or disable click-through. The user presses Insert
// (focusToChat) when they actually want to type. This mirrors how the desktop
// WinForms overlay handles tab-navigation hotkeys — the overlay flashes into
// view on top of the game and switches tabs, but the game keeps keyboard focus.
function nextChannel() { _doShow(); sendToRenderer('overlay:command', 'channel:next'); }
function prevChannel() { _doShow(); sendToRenderer('overlay:command', 'channel:prev'); }
// Jump to the party that last posted in the General feed (renderer owns the
// "last party" tracking + the tab switch). Show only — no focus steal.
function recentParty() {
  showWindowInactive();
  sendToRenderer('overlay:command', 'party:recent');
}
// Jump to the Fallout 76 (General) tab — show + tab:fo76 command, no focus.
function goFo76() {
  showWindowInactive();
  sendToRenderer('overlay:command', 'tab:fo76');
}
// Jump directly to a numbered party (1-based index). Show only — no focus.
function goPartyIndex(n) {
  showWindowInactive();
  sendToRenderer('overlay:command', 'party:index:' + n);
}
function openSettings() { _doShow(); setClickThrough(false); sendToRenderer('overlay:command', 'settings:open'); }

function quitApp() {
  const stack = (new Error().stack || '').split('\n').slice(1, 3).join(' | ');
  diag('[quit] quitApp() called — caller: ' + stack);
  isQuitting = true;
  persistBounds();
  app.quit();
}

// Returns true for single-printable-character accelerators (e.g. '/', '\').
// These need focus-gating — globally intercepting a bare printable char blocks
// the user from typing that character in the overlay input. Multi-key combos and
// named keys (Insert, Delete, PageUp/Down, F-keys) are safe to keep always-on.
const isSinglePrintableChar = overlayCore.isSinglePrintableChar;

// All keybinds to (de)register: { accel, fn, isChar }. isChar = single printable
// char (/, \, etc.) which must be FREE while the overlay is focused so the user can
// type it in the chat input. Rebuilt on each registerHotkeys call.
let _allBinds = [];
let _shortcutState = null;

// Keybinds are GLOBAL shortcuts — a registered key is stolen from EVERY app. To
// avoid hijacking keys (/, \, PageUp, PageDown, …) from other applications, keep
// them registered ONLY while the GAME or the OVERLAY is the active context;
// otherwise unregister so the focused app receives the key normally. Char binds
// (/, \) are additionally released while the overlay itself is focused (typing).
//   Windows: "game active" = the game is the FOREGROUND window (foreground poll).
//   Linux/macOS: no foreground-process API → use game-RUNNING as the proxy.
function refreshShortcuts() {
  const overlayFocused = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  // shouldRegisterShortcuts handles all platform/detection-availability cases:
  //   win32             → game active = foreground window is the game
  //   linux KDE-Wayland + xdotool/kdotool present → same as win32 (fgPoller running)
  //   linux fallback    → game active = game process is running (old behavior)
  const active = overlayCore.shouldRegisterShortcuts({
    platform: process.platform,
    kdeWayland: KDE_WAYLAND,
    hasForegroundDetect: kdeWaylandForegroundDetect,
    gameRunning,
    foregroundProc: lastForegroundProc,
    overlayFocused,
  });
  const stateKey = active + '|' + overlayFocused + '|' + trayAvailable;
  if (stateKey === _shortcutState) return; // idempotent — no churn on the 300ms poll
  _shortcutState = stateKey;
  globalShortcut.unregisterAll();
  if (!active) {
    // RECOVERABILITY (issue #272 follow-up): with NO system tray (no SNI host) the
    // only way back to a hidden overlay is a global hotkey. So even while another app
    // is foreground, keep the summon binds (focus/toggle) registered so the overlay
    // is never strandable. With a tray present we release ALL keys (the tray is the
    // fallback) so other apps keep Insert/Delete etc.
    if (!trayAvailable) {
      let kept = 0;
      for (const b of _allBinds) {
        if (b.action === 'focus' || b.action === 'toggle') {
          try { if (globalShortcut.register(b.accel, b.fn)) kept++; } catch { /* skip */ }
        }
      }
      diag('[hotkeys] inactive context + no tray — kept ' + kept + ' summon bind(s) registered for recoverability');
    } else {
      diag('[hotkeys] inactive context — released all global shortcuts (tray is the fallback)');
    }
    return; // another app is foreground — let it have the (non-summon) keys
  }
  // Register EVERY bind while the game or overlay is the active context — including the
  // channel-cycle (PageUp/PageDown), settings (Home), and party/preset binds. These were
  // previously suppressed unless the overlay itself was focused, which made them dead while
  // in-game (only Insert/Delete/End worked). Per product decision, all keybinds must work
  // in-game. They are STILL released for OTHER apps: when neither the game nor overlay is
  // the active context, `active` is false above → unregisterAll, so we only reserve these
  // keys while you're actually in FCM or the game. (`overlayOnly` is retained on the bind
  // records for reference but no longer gates registration.) Char binds (/ \) stay released
  // while the overlay is focused so they remain typeable in chat.
  let reg = 0, fail = 0;
  for (const b of _allBinds) {
    if (b.isChar && overlayFocused) continue; // keep / and \ typeable in the overlay
    try { if (globalShortcut.register(b.accel, b.fn)) reg++; else fail++; } catch { fail++; }
  }
  diag('[hotkeys] active context (overlayFocused=' + overlayFocused + ') — registered ' + reg +
    (fail ? ', ' + fail + ' FAILED (already held by another app?)' : ''));
}

// Register the global shortcuts from a keybind map (settings panel) or the
// defaults. Unregisters first so a settings change re-binds cleanly. Each
// register is wrapped so one bad accelerator can't abort the rest.
function registerHotkeys(kb, presets) {
  const map = overlayCore.buildKeybindMap(kb, {
    toggle: TOGGLE_SHORTCUT,
    clickThrough: CLICKTHROUGH_SHORTCUT,
    focus: FOCUS_SHORTCUT,
    nextChannel: NEXT_CHANNEL_SHORTCUT,
    prevChannel: PREV_CHANNEL_SHORTCUT,
    settings: SETTINGS_SHORTCUT,
    recentParty: RECENT_PARTY_SHORTCUT,
    goFo76: GO_FO76_SHORTCUT,
  });
  currentKeybinds = map;
  // Keep keybinds.cfg in sync with every programmatic change (settings UI, reset, IPC).
  writeKeybindsCfg(map);
  // Push the live binds to the renderer so the footer help text can show them.
  sendToRenderer('overlay:keybinds', map);
  _allBinds = [];

  // Find the action name for an accel for diagnostic logging.
  const accelToAction = (a) => overlayCore.accelToAction(map, a);
  // Throttle rapid hotkey repeats: holding or hammering a key (esp. Insert/Delete
  // → focus/toggle) fires the OS auto-repeat dozens of times per second, which
  // thrashes show/hide + the WS gate (connect/teardown storm) and can leave the
  // overlay looking dead. Collapse repeats of the same action to ~4/sec.
  const KEYBIND_THROTTLE_MS = 250;
  const lastFireMs = Object.create(null);
  // overlayOnly=true means the bind only fires when the overlay has OS focus and is
  // not in click-through passthrough mode. Global binds (toggle/focus/clickThrough)
  // stay active while the game is foreground so the user can reach the overlay.
  const bind = (accel, fn, overlayOnly = false) => {
    if (!accel) return;
    const action = accelToAction(accel);
    const wrappedFn = () => {
      const now = Date.now();
      if (now - (lastFireMs[action] || 0) < KEYBIND_THROTTLE_MS) {
        diag('[keybind] action=' + action + ' accel=' + accel + ' throttled');
        return;
      }
      lastFireMs[action] = now;
      diag('[keybind] action=' + action + ' accel=' + accel + ' fired');
      // Defer the (heavy: show/hide + setIgnoreMouseEvents DWM recomposition) work
      // off the globalShortcut callback so it returns instantly. Blocking the main
      // thread here makes Electron drop subsequent hotkey events — which is why
      // mashing Insert/Delete made the keys stop responding after a few presses.
      setImmediate(fn);
    };
    _allBinds.push({ accel, fn: wrappedFn, isChar: isSinglePrintableChar(accel), overlayOnly, action });
  };

  // Global binds — active whenever the game or overlay is the foreground context.
  bind(map.toggle,      () => toggleWindow());
  bind(map.clickThrough, () => { autoClickThrough = false; setClickThrough(!clickThrough); });
  bind(map.focus,       () => focusToChat());
  // Overlay-only binds — suppressed while the game has OS focus so they can't
  // intercept game keystrokes (e.g. Tab bound to cycle channel vs. game Tab key).
  bind(map.nextChannel, () => nextChannel(),   true);
  bind(map.prevChannel, () => prevChannel(),   true);
  bind(map.settings,    () => openSettings(),  true);
  bind(map.recentParty, () => recentParty());
  bind(map.goFo76,      () => goFo76());
  for (let i = 1; i <= 8; i++) {
    const accel = map['party' + i];
    if (accel) {
      const n = i; // capture loop var
      bind(accel, () => goPartyIndex(n), true);
    }
  }

  // Position-preset hotkeys (Shift+F1..F8): snap the window to a saved rect.
  if (Array.isArray(presets)) {
    for (const p of presets) {
      if (!p || !p.keybind || typeof p.x !== 'number') continue;
      bind(p.keybind, () => {
        const wa = clampToWorkArea({ x: p.x, y: p.y, width: p.w, height: p.h });
        if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.setBounds(wa); } catch { /* ignore */ } }
      }, true);
    }
  }

  // Actually (de)register based on the current foreground/focus state — the keys
  // are only live while the game or overlay is the active context.
  _shortcutState = null; // force a re-register after a keybind change
  refreshShortcuts();
}

// ─── Click-through toggle ─────────────────────────────────────────────────────
function setClickThrough(enabled) {
  clickThrough = !!enabled;
  if (!mainWindow) return;
  // NOTE: works over a real game window only on a NATIVE build. Under WSLg there
  // is no shared desktop, so this has no visible effect there.
  // Always apply — do NOT skip even if the value didn't change, because other
  // code paths (focus handlers, overlay:set-interactive) may have overridden the
  // OS state without updating the clickThrough flag.
  try {
    setMouseIgnore(clickThrough, true);
    diag('[click-through] setIgnoreMouseEvents(' + clickThrough + ')');
  } catch (e) { diag('[click-through] setIgnoreMouseEvents failed:', String(e && e.message || e)); }
  sendToRenderer('overlay:click-through', clickThrough);
}

// ─── Foreground-aware click-through ──────────────────────────────────────────
// An in-game overlay must NOT capture mouse clicks while the GAME is the active
// window — a cursor passing over the overlay would eat a click meant for the game
// (firing/aiming). But when the user ALT-TABS OUT of the game (desktop or another
// app is foreground), or the overlay itself is focused, the overlay must be
// CLICKABLE so a click lands on it (and focuses it).
//   Windows: click-through ONLY while the GAME is the foreground process; clickable
//            otherwise (overlay focused, desktop, or another app). Driven by the
//            foreground-process poll (lastForegroundProc) + focus/blur/show events.
//   Non-win32: no foreground-process API → focus-driven (click-through when the
//            overlay is blurred, interactive when focused).
// A modal pins interactive; manual "Click-through (always)" (clickThrough=true)
// keeps it click-through even when clickable-eligible.
function applyFocusClickThrough(focusedHint) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (modalInteractive) { setMouseIgnore(false, false); return; }
  // If the user just pressed Insert (focusToChat), treat the overlay as focused for a
  // short guard window so the 300ms foreground poll can't flip it back to click-through/
  // inert before mainWindow.focus() actually lands (the "type, but it went to the game" bug).
  const recentlyFocused = (Date.now() - lastUserFocusMs) < FOCUS_GUARD_MS;
  const overlayFocused = recentlyFocused || (typeof focusedHint === 'boolean' ? focusedHint : mainWindow.isFocused());
  let ignore;
  if (process.platform === 'win32') {
    const gameForeground = !overlayFocused && isGameProcess(lastForegroundProc);
    ignore = gameForeground ? true : clickThrough; // clickable unless the game is foreground
  } else {
    ignore = overlayFocused ? clickThrough : true; // focus-driven fallback
  }
  // forward:true forwards mouse-MOVE to the renderer while click-through so it can
  // show :hover states — but that's exactly the "still reacting while the game has
  // focus" bug. Only forward when the hover-to-interactive mode is explicitly on;
  // otherwise a click-through overlay is fully inert (no hover, no events).
  setMouseIgnore(ignore, ignore && autoClickThrough);
}

// ─── Foreground-aware z-order controller (native Windows; no new deps) ────────
// The overlay behaves like an in-game overlay: it is TOPMOST only when the GAME
// (Fallout76.exe) is the foreground window, OR when the overlay itself is
// focused. When any other app is foreground (a browser, etc.), the overlay is a
// NORMAL window so that app can cover it. If the game isn't running, the overlay
// is NOT topmost. This is native-only: under WSLg the app runs in a sandboxed
// Wayland/X server isolated from the Windows desktop, so the foreground poll
// only ever sees the WSLg compositor and the controller no-ops gracefully.
function desiredTopmost() {
  // Decision is pure (see overlay-core); main.js only supplies live state.
  // forceVisible overrides game gating; while the GAME IS RUNNING stay topmost no
  // matter what (avoids true→false→true flips on tab-in that trigger DWM flashes);
  // overlay focused → topmost; game is the foreground process → topmost.
  return overlayCore.desiredTopmost({
    hasWindow: !!(mainWindow && !mainWindow.isDestroyed()),
    forceVisible,
    gameRunning,
    windowFocused: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
    foregroundIsGame: isGameClass(lastForegroundProc),
    foregroundUnknown: overlayCore.isUnknownForegroundClass(lastForegroundProc),
    // Focus-aware lowering is DISABLED on KDE-Wayland by design: the fcm-keepabove KWin
    // rule's force-Layer property FORCES the overlay into OverlayLayer (layerrule=2),
    // which trumps any setAlwaysOnTop(false) we could issue — so we use session-long "game running →
    // topmost" (the chosen "above the game, no flicker" behavior; confirmed 2026-07).
    // Hotkey gating still uses the foreground class (see shouldRegisterShortcuts).
    focusAwareTopmost: false,
  });
}

// Linux always-on-top heartbeat: re-assert topmost on a short interval while
// the game is running. On some X11 WMs and under Proton/XWayland the
// _NET_WM_STATE_ABOVE hint can be silently dropped when the game window raises
// itself (e.g. on game-launch or alt-tab). The heartbeat catches this by
// forcing a re-apply every few seconds — idempotent on Windows (guarded by
// overlayIsTopmost) but explicitly re-forced on Linux where stacking races are
// more common. Only active on Linux; Windows has the 1500ms applyZOrder timer
// already plus the DWM-flash constraint that prohibits frequent forced re-apply.
let _linuxZOrderTimer = null;
function _startLinuxZOrderHeartbeat() {
  if (!IS_LINUX) return;
  if (_linuxZOrderTimer) return;
  _linuxZOrderTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || isDragging) return;
    if (!desiredTopmost()) return; // game not running / not needed
    // Force re-apply by clearing the cached state so applyZOrder() always calls
    // setAlwaysOnTop. This is safe on Linux — there is no DWM-recomposition flash.
    overlayIsTopmost = false;
    applyZOrder({ heartbeat: true });
  }, 3000); // 3s — short enough to catch a game-raise, long enough not to spam
}
function _stopLinuxZOrderHeartbeat() {
  if (!IS_LINUX || !_linuxZOrderTimer) return;
  clearInterval(_linuxZOrderTimer);
  _linuxZOrderTimer = null;
}

function applyZOrder(opts) {
  // The 3s Linux heartbeat re-applies topmost every tick; route ITS logs through
  // vdiag (verbose) so they don't flood the log — a real z-order CHANGE still logs
  // at info. (Heartbeat re-applies were the #1 source of log bloat.)
  const zlog = (opts && opts.heartbeat) ? vdiag : diag;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) {
    // Overlay hidden to tray. On Linux, RELEASE always-on-top (and stop the heartbeat) so
    // a hidden window doesn't keep holding the game out of exclusive fullscreen — otherwise
    // the flag stayed stuck from when it was visible and FO76 stayed under the panel even
    // after hiding. On Windows we keep the flag: a hidden window doesn't affect stacking and
    // re-toggling it would DWM-flash on the next show.
    if (IS_LINUX && overlayIsTopmost) {
      overlayIsTopmost = false;
      _stopLinuxZOrderHeartbeat();
      try { mainWindow.setAlwaysOnTop(false); } catch { /* ignore */ }
      diag('[zorder] linux: released always-on-top (overlay hidden)');
    }
    return;
  }
  // Suppress z-order changes while the user is dragging the window. On Windows,
  // calling setAlwaysOnTop on a transparent window triggers a DWM recomposition
  // that flashes/dims the overlay visuals mid-drag. We skip the re-apply until
  // the drag completes; the 'moved' event will call applyZOrder again.
  if (isDragging) return;
  const want = desiredTopmost();
  if (want === overlayIsTopmost) return;
  overlayIsTopmost = want;
  try {
    if (IS_LINUX && want) {
      // Linux/Proton z-order: try 'pop-up-menu' first — it maps to a higher
      // _NET_WM_WINDOW_TYPE layer on most X11/XWayland compositors and sits
      // above borderless-windowed game surfaces including Proton/XWayland ones.
      // Fall back to 'screen-saver' (the next highest standard level) if
      // 'pop-up-menu' throws (it can fail on older Electron/Chromium builds).
      // Also call setVisibleOnAllWorkspaces again: some compositors reset this
      // flag when the window is hidden/shown or another fullscreen window raises.
      try {
        mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
        zlog('[zorder] linux: setAlwaysOnTop(true, pop-up-menu) — gameRunning=' + gameRunning + ' focused=' + mainWindow.isFocused());
      } catch {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        zlog('[zorder] linux: setAlwaysOnTop(true, screen-saver) fallback — gameRunning=' + gameRunning);
      }
      try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
      _startLinuxZOrderHeartbeat();
    } else {
      if (IS_LINUX && !want) {
        _stopLinuxZOrderHeartbeat();
        zlog('[zorder] linux: setAlwaysOnTop(false) — gameRunning=' + gameRunning + ' focused=' + mainWindow.isFocused());
      }
      // 'screen-saver' is the highest standard level so we sit above a
      // fullscreen-borderless game. setAlwaysOnTop does not steal focus
      // (no activate), satisfying the SWP_NOACTIVATE requirement.
      mainWindow.setAlwaysOnTop(want, 'screen-saver');
    }
  } catch (e) { if (IS_LINUX) diag('[zorder] setAlwaysOnTop failed:', String(e && e.message || e)); }
}

// KDE-Wayland active-window poller using kdotool (preferred) or xdotool.
//
// `kdotool` (https://github.com/jinliu/kdotool) talks to KWin over D-Bus, so it
// sees EVERY window — native-Wayland (Konsole, Wayland Firefox) AND XWayland
// (FO76 under Proton) — and reads the game's class reliably. It is PREFERRED.
// `xdotool` is the X11 fallback: it only sees the XWayland side, so when a
// native-Wayland window is focused it reports NO active window — with the game
// running, the "(null)"-class heuristic then treats that as "probably the
// fullscreen game" and the hotkeys stay captured in the other app. It also hits
// a libxdo double-free crash on some builds (see the circuit-breaker below).
// Both tools share the same subcommand syntax:
//   <tool> getactivewindow getwindowclassname
// Output: the window class of the currently active window, e.g.
//   steam_app_1151340   (FO76 under Proton — confirmed on CachyOS)
//   fallout76.exe       (FO76 under some Proton/Wine versions)
//   org.kde.konsole     (kdotool reports native-Wayland apps by app-id;
//                        xdotool would report X11-style "konsole" — neither
//                        matches isGameClass(), which is all that matters)
//   fallout chat mod    (our own overlay — must NOT match isGameClass(); the
//                        overlay-focused case is covered separately via isFocused())
//
// Graceful degradation: if neither tool is on PATH, we log a single diagnostic and
// leave kdeWaylandForegroundDetect=false so refreshShortcuts falls back to the
// pre-existing "game running → keys active" behavior (no regression).
function _startForegroundPoller() {
  if (!KDE_WAYLAND) return; // only on KDE+Wayland
  // Resolve which tools are available — prefer kdotool (KWin D-Bus: sees native-
  // Wayland windows too, so hotkeys release correctly in Konsole/Firefox; no libxdo
  // crash), then xdotool. We detect BOTH (not just the first) so the crash
  // circuit-breaker below can auto-switch to the alternate tool if the primary keeps
  // aborting. `;` (not `||`) runs both probes; `command -v` prints the path when found.
  exec('command -v kdotool; command -v xdotool', { shell: '/bin/sh' }, (_err, stdout) => {
    const found = (stdout || '').split('\n').map((s) => s.trim().split('/').pop()).filter(Boolean);
    const available = ['kdotool', 'xdotool'].filter((t) => found.includes(t)); // kdotool first
    if (available.length === 0) {
      // Neither tool installed — log once and leave detection disabled.
      diag('[foreground] kdotool/xdotool not found on PATH — KDE-Wayland active-window detection disabled.');
      diag('[foreground] Install kdotool (recommended — Arch: AUR, Fedora: dnf install kdotool) for precise hotkey-release support; xdotool also works with caveats.');
      diag('[foreground] Falling back to game-running detection (hotkeys stay registered while FO76 is open).');
      return;
    }
    fgTool = available[0];
    kdeWaylandForegroundDetect = true;
    const altNote = available.length > 1 ? ' (fallback available: ' + available.filter((t) => t !== fgTool).join(',') + ')' : '';
    diag('[foreground] ' + fgTool + ' found — KDE-Wayland active-window detection ENABLED (~300ms poll).' + altNote);
    // `tried` tracks tools we've already polled with so the breaker never ping-pongs
    // back to a tool that already crashed (xdotool→kdotool→xdotool…).
    _runForegroundPoll(available, new Set([fgTool]));
  });
}

// Drive the ~300ms active-window poll with the currently-selected fgTool, guarded by a
// crash circuit-breaker. On some distros (Fedora 44, xdotool 3.x) the chained
// `getactivewindow getwindowclassname` aborts INSIDE libxdo (double-free in
// xdo_get_window_classname → SIGABRT). We can't stop the per-spawn coredump, so after
// MAX_CONSEC_CRASHES back-to-back signal deaths we either switch to the alternate tool
// (if one is installed) or disable detection entirely — both stop the coredump storm.
function _runForegroundPoll(available, tried) {
  const POLL_INTERVAL_MS = 300;
  const MAX_CONSEC_CRASHES = 3;
  let consecutiveCrashes = 0;
  // Poll by spawning the tool each interval. Each spawn is cheap (< 1ms startup)
  // vs. a long-lived subprocess that could die silently.
  fgPollTimer = setInterval(() => {
    if (isQuitting) return;
    let done = false;
    let out = '';
    try {
      fgPoller = spawn(fgTool, ['getactivewindow', 'getwindowclassname']);
      fgPoller.stdout.on('data', (d) => { out += d.toString(); });
      // Drain stderr: a crashing xdotool prints a libc backtrace to stderr, and the
      // default piped-but-unread stderr could fill and block the child before our
      // 500ms kill. Discard it.
      if (fgPoller.stderr) fgPoller.stderr.on('data', () => { /* discard */ });
      fgPoller.on('close', (code, signal) => {
        if (done) return;
        done = true;
        // A SIGNAL death (SIGABRT from the libxdo double-free, SIGSEGV, …) is a crash.
        // A non-zero EXIT CODE with no signal is NOT a crash — xdotool returns 1 when
        // there's simply no active X window (a native-Wayland window is focused), which
        // is the normal "not the game" state. Our own 500ms timeout kill sets done=true
        // first, so its SIGTERM never reaches here.
        if (signal) {
          consecutiveCrashes += 1;
          const untried = available.filter((t) => !tried.has(t));
          const action = overlayCore.decideForegroundPollerAction({
            crashed: true, consecutiveCrashes, maxCrashes: MAX_CONSEC_CRASHES, hasAltTool: untried.length > 0,
          });
          if (action === 'switch-tool') {
            const alt = untried[0];
            diag('[foreground] ' + fgTool + ' crashed ' + consecutiveCrashes + 'x (' + signal +
              ', likely libxdo getwindowclassname double-free) — switching to ' + alt + '.');
            if (fgPollTimer) { clearInterval(fgPollTimer); fgPollTimer = null; }
            fgTool = alt;
            tried.add(alt);
            _runForegroundPoll(available, tried);
          } else if (action === 'disable') {
            diag('[foreground] ' + fgTool + ' crashed ' + consecutiveCrashes + 'x (' + signal +
              ', likely libxdo getwindowclassname double-free) — disabling active-window detection to stop coredump spam.');
            diag('[foreground] Install the alternate tool to restore precise hotkey-release — kdotool preferred (Arch: AUR, Fedora: dnf): https://github.com/jinliu/kdotool');
            diag('[foreground] Falling back to game-running detection (hotkeys stay registered while FO76 is open).');
            if (fgPollTimer) { clearInterval(fgPollTimer); fgPollTimer = null; }
            kdeWaylandForegroundDetect = false;
            lastForegroundProc = '';
            refreshShortcuts();
          }
          // action === 'continue' (still under threshold): keep polling; don't act on
          // this spawn's (absent) output.
          return;
        }
        // Clean exit — reset the crash streak. Empty output is a valid signal:
        // kdotool → genuinely no active window; xdotool → no active X window,
        // which ALSO happens when a native-Wayland window is focused (xdotool
        // can't see those) or when a fullscreen game exposes no WM_CLASS — the
        // "(null)" heuristic in shouldRegisterShortcuts handles that ambiguity.
        consecutiveCrashes = 0;
        const line = out.trim().toLowerCase();
        // Only update and act when the value actually changed — avoids redundant
        // applyZOrder / refreshShortcuts churn every 300ms.
        if (line !== lastForegroundProc) {
          // Verbose: the raw active-window class drives z-order + hotkey gating. A
          // fullscreen game reads "(null)"/empty here (no WM_CLASS) — logging it makes
          // "overlay won't stay above the game" diagnosable without a manual capture.
          vdiag('[foreground] active-window class changed: "' + lastForegroundProc + '" → "' + line +
            '" (isGame=' + isGameClass(line) + ' unknown=' + overlayCore.isUnknownForegroundClass(line) + ' gameRunning=' + gameRunning + ')');
          lastForegroundProc = line;
          if (gameRunning) applyZOrder();
          applyFocusClickThrough();
          refreshShortcuts();
        }
      });
      fgPoller.on('error', () => { done = true; /* ignore — tool may have vanished */ });
      // Safety timeout: if the process doesn't close in 500ms, kill it.
      setTimeout(() => {
        if (!done) {
          done = true;
          try { fgPoller && fgPoller.kill(); } catch { /* ignore */ }
        }
      }, 500);
    } catch { /* ignore spawn errors */ }
  }, POLL_INTERVAL_MS);
}

// Build + spawn the long-lived PowerShell foreground poller (win32). Extracted from
// startForegroundZOrder so it can be RELAUNCHED after a death (issue #136): the
// poller is the ONLY thing that updates lastForegroundProc, so if it dies with no
// restart the last-known foreground (the game, while keys were registered) freezes
// and the global hotkeys are never released again. Each healthy line resets the
// restart backoff and clears any fail-closed state (the watchdog re-engages if the
// lines stop again).
function spawnWindowsForegroundPoller() {
  if (process.platform !== 'win32' || isQuitting) return;
  const ps = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
'@
Add-Type $sig
while ($true) {
  try {
    $h = [Fg]::GetForegroundWindow()
    $pid2 = 0
    [void][Fg]::GetWindowThreadProcessId($h, [ref]$pid2)
    $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
    if ($p) { Write-Output $p.ProcessName } else { Write-Output '' }
  } catch { Write-Output '' }
  Start-Sleep -Milliseconds 100
}`;
  pollerStartedAt = Date.now();
  lastForegroundAt = Date.now(); // grace: give the poller FG_STALE_MS to emit its first line before the watchdog trips
  pollerEverEmitted = false;
  try {
    zorderProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    diag('[foreground] win32 poller started (pid=' + (zorderProc && zorderProc.pid) + ')');
    let buf = '';
    zorderProc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // A line arrived → the poller is healthy. Stamp the watchdog clock, reset the
        // restart backoff, and clear any fail-closed state from a previous silence.
        lastForegroundAt = Date.now();
        pollerRestartCount = 0;
        if (!pollerEverEmitted) { pollerEverEmitted = true; diag('[foreground] win32 poller: first line ("' + line.toLowerCase() + '")'); }
        if (fgFailClosed) { fgFailClosed = false; diag('[foreground] win32 poller recovered — re-evaluating hotkeys'); }
        lastForegroundProc = line.toLowerCase();
        if (gameRunning) applyZOrder();
        applyFocusClickThrough();
        refreshShortcuts();
      }
    });
    zorderProc.on('error', (err) => handleWindowsPollerDown('error', err && err.message));
    zorderProc.on('exit', (code) => handleWindowsPollerDown('exit', code));
  } catch (e) {
    handleWindowsPollerDown('spawn-throw', String(e && e.message || e));
  }
}

// Relaunch the win32 poller after a death, with capped backoff (1s → 2s → 5s). A
// poller that exits immediately and never emitted a line is the BLOCKED signature
// (PowerShell Constrained Language Mode rejecting `Add-Type`, or AppLocker/AV
// blocking powershell.exe) — log an actionable hint and keep retrying; the watchdog
// meanwhile fails closed so the hotkeys are released regardless of WHY it failed.
function handleWindowsPollerDown(reason, detail) {
  zorderProc = null;
  if (isQuitting) return;
  const kind = overlayCore.classifyPollerExit({ msSinceStart: Date.now() - pollerStartedAt, everEmitted: pollerEverEmitted });
  const backoff = overlayCore.nextPollerBackoffMs(pollerRestartCount);
  if (kind === 'blocked-or-clm') {
    diag('[foreground] win32 poller ' + reason + ' immediately with no output (' + detail + ') — powershell.exe likely blocked ' +
      '(Constrained Language Mode / AppLocker). Hotkeys released as a fail-safe; in-game hotkeys need a working foreground poll. Retrying in ' + (backoff / 1000) + 's.');
  } else {
    diag('[foreground] win32 poller ' + reason + ' (' + detail + ') — restarting in ' + (backoff / 1000) + 's.');
  }
  pollerRestartCount += 1;
  if (pollerRestartTimer) clearTimeout(pollerRestartTimer);
  pollerRestartTimer = setTimeout(() => {
    pollerRestartTimer = null;
    spawnWindowsForegroundPoller();
  }, backoff);
}

// Fail-safe watchdog (win32) — the real #136 fix, independent of WHY the poller
// failed. The poller is a single point of failure: if it dies, is blocked, or never
// starts, lastForegroundProc freezes and refreshShortcuts() stops firing, so the
// global hotkeys are never released and fire in every app. Once per second, if no
// foreground line has arrived for FG_STALE_MS, FORGET the stale foreground
// (lastForegroundProc='') and re-run refreshShortcuts() — which releases the hotkeys
// (keeping only the summon binds when there's no tray). When the poller recovers, its
// stdout handler clears fgFailClosed and re-registers.
function startWindowsForegroundWatchdog() {
  if (process.platform !== 'win32' || fgWatchdogTimer) return;
  fgWatchdogTimer = setInterval(() => {
    if (isQuitting) return;
    if (!overlayCore.isForegroundStale({ lastLineAt: lastForegroundAt, now: Date.now(), staleMs: FG_STALE_MS })) return;
    if (!fgFailClosed) {
      fgFailClosed = true;
      diag('[foreground] win32 poller silent > ' + (FG_STALE_MS / 1000) + 's — releasing global hotkeys (fail-safe, #136)');
    }
    if (lastForegroundProc !== '') lastForegroundProc = '';
    refreshShortcuts();
  }, 1000);
}

// Spawn a long-lived PowerShell that prints the foreground window's process name
// (~300ms cadence). We read its stdout lines and update lastForegroundProc.
function startForegroundZOrder() {
  if (process.platform !== 'win32') {
    // Non-Windows (incl. WSLg's Linux Electron): no foreground-window-process API
    // that maps to the Windows desktop. Use the process-scan-based game detection
    // (startGameScan) to drive always-on-top: topmost while the game is running.
    // Focus/blur also flip topmost so the user can always interact with chat.
    // KDE-Wayland exception: we additionally start a kdotool poller so we CAN
    // detect the active window and release hotkeys when another app is foreground.
    lastForegroundProc = '';
    if (mainWindow) {
      // CRITICAL for Linux (Wayland/Bazzite) + macOS: let the overlay float over
      // a FULLSCREEN game. Plain alwaysOnTop is not enough over a fullscreen
      // window — `visibleOnFullScreen` is the option that lets the window appear
      // above other apps' fullscreen surfaces. Without this the overlay simply
      // never shows over the game (the user's "I have to keep hitting insert").
      // NOTE: works best when FO76 runs in BORDERLESS/WINDOWED, not exclusive
      // fullscreen — exclusive fullscreen grabs the GPU output and no overlay
      // (on any OS) can draw above it.
      try {
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        diag('[zorder] non-win32: setVisibleOnAllWorkspaces(visibleOnFullScreen=true) applied');
      } catch (e) { diag('[zorder] setVisibleOnAllWorkspaces failed:', String(e && e.message || e)); }
      mainWindow.on('focus', () => { applyZOrder(); applyFocusClickThrough(true); refreshShortcuts(); });
      mainWindow.on('blur', () => { applyZOrder(); applyFocusClickThrough(false); refreshShortcuts(); });
      // On 'show' (restore from tray or first show), force-clear the cached
      // z-order state so applyZOrder always re-asserts the correct level.
      // This is critical on Linux/Proton: the compositor may have dropped our
      // _NET_WM_STATE_ABOVE hint while the window was hidden; re-asserting on
      // every show ensures the overlay is above the game surface immediately.
      mainWindow.on('show', () => {
        overlayIsTopmost = false; // force re-apply even if state is unchanged
        applyZOrder();
        applyFocusClickThrough(mainWindow.isFocused());
        syncPanelHideInGame('show'); // hide the taskbar (opt-in) now that we're over the game
        diag('[zorder] linux: show event — re-asserting always-on-top');
      });
      // On hide-to-tray, applyZOrder releases always-on-top and the panel auto-hide
      // restores while nothing is shown.
      mainWindow.on('hide', () => {
        applyZOrder();
        syncPanelHideInGame('hide'); // restore the taskbar while nothing is shown
        diag('[zorder] linux: hide event — released always-on-top');
      });
    }
    applyZOrder();
    startGameScan();
    // KDE-Wayland: start the xdotool/kdotool poller for active-window detection.
    // This is the key difference from other Linux setups: it gives us a real
    // foreground window class so refreshShortcuts() can release hotkeys when the
    // user switches to Konsole, Discord, etc. — just like the win32 PS poller does.
    _startForegroundPoller();
    return;
  }
  // Windows: also run the process scanner as a supplement (confirms game is
  // actually present, not just in foreground — handles Proton/Wine sub-processes).
  startGameScan();

  // Spawn the foreground poller and start the fail-safe watchdog (issue #136).
  // The poller self-heals (restart-with-backoff on death) and the watchdog releases
  // the global hotkeys whenever the poller goes silent, so a dead/blocked poller can
  // never strand the hotkeys "registered everywhere".
  spawnWindowsForegroundPoller();
  startWindowsForegroundWatchdog();

  // Focus/blur of the overlay also flips topmost (user interacting with chat).
  // On focus/show Electron can reset setIgnoreMouseEvents back to interactive,
  // which silently broke manual click-through after leaving + returning to the
  // window. Re-assert it so click-through survives a blur→focus cycle.
  const reassertClickThrough = () => {
    if (modalInteractive) return;  // never re-ignore mouse while a modal is open
    if (clickThrough && mainWindow && !mainWindow.isDestroyed()) {
      try { setMouseIgnore(true, true); } catch { /* ignore */ }
    }
  };
  if (mainWindow) {
    mainWindow.on('focus', () => {
      // The overlay just gained OS focus, which means the game CANNOT be the foreground
      // window right now. If the foreground poll's cached value still says the game is
      // foreground (up to 100ms stale), clear it eagerly. This prevents the subsequent
      // applyFocusClickThrough(true) call from seeing a stale gameForeground=true and
      // ensures the poll's next tick is an idempotent no-op rather than a duplicate
      // setIgnoreMouseEvents call that would trigger a second DWM recomposition flash.
      if (isGameProcess(lastForegroundProc)) {
        lastForegroundProc = '';
      }
      // Only call applyZOrder() when the game is running. When gameRunning=false,
      // desiredTopmost() flips true→false on blur and false→true on focus, causing two
      // setAlwaysOnTop calls (one per transition). On a transparent Windows window each
      // setAlwaysOnTop triggers a DWM recomposition that visibly flashes the overlay —
      // this is the "click an idle overlay and it flashes" bug. When the game IS running,
      // gameRunning=true makes desiredTopmost() always true regardless of focus, so
      // applyZOrder() on focus/blur is always a no-op anyway. The 1500ms fallback timer
      // handles any no-game z-order corrections without causing per-click flashes.
      if (gameRunning) applyZOrder();
      applyFocusClickThrough(true); refreshShortcuts();
      repaintNow(); // force a fresh composite so the transparent surface isn't left stale/blurry
    });
    mainWindow.on('blur', () => {
      if (gameRunning) applyZOrder();
      applyFocusClickThrough(false); refreshShortcuts();
      repaintNow();
    });
    mainWindow.on('show', () => { applyZOrder(); applyFocusClickThrough(mainWindow.isFocused()); repaintNow(); });
  }
  // Fallback re-apply timer. IMPORTANT: this used to FORCE a setAlwaysOnTop every
  // tick (overlayIsTopmost = !desiredTopmost()), which on a transparent Windows
  // window triggers a DWM recomposition — i.e. the overlay visibly flashed/"reloaded"
  // every 1.5s and especially when tabbing in/out. Now we call applyZOrder() WITHOUT
  // forcing: it no-ops when the desired state already matches (the common case while
  // playing), so there's no periodic flash. It still corrects the z-order the moment
  // the desired state genuinely changes (game launch/close, focus, force-visible).
  if (zorderTimer) clearInterval(zorderTimer);
  zorderTimer = setInterval(() => {
    if (isDragging) return;
    // Guard matches focus/blur/poll: only correct z-order when the game is
    // running. Without the guard, clicking the idle overlay makes it focused
    // (windowFocused=true → desiredTopmost=true) while overlayIsTopmost is
    // still false, so the next timer tick calls setAlwaysOnTop → DWM flash.
    if (gameRunning) applyZOrder();
  }, 1500);
}

// ─── Idle collapse — shrink the WINDOW height to the header (top anchored) ────
// Replaces the old CSS-only collapse (which left a full box). The renderer
// reports collapse/expand + the header strip height; we resize the BrowserWindow
// so ONLY the header/tab strip remains, with the window's TOP edge FIXED and the
// height growing/shrinking DOWNWARD — never moving the window up/off-screen.
function animateHeightTo(targetH, onDone) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (collapseAnim) { clearInterval(collapseAnim); collapseAnim = null; }
  collapseAnimTarget = targetH;
  const b = mainWindow.getBounds();
  const startH = b.height;
  // x/y are read LIVE each frame (below) rather than frozen here, so a concurrent
  // drag-move (which changes x/y via setPosition) is never fought by this height
  // animation — only WIDTH is held from the start. The window top still stays put
  // when not moving because live x/y == the captured value in that case.
  const w = b.width;
  if (Math.abs(startH - targetH) < 2) {
    const c = mainWindow.getBounds();
    try { mainWindow.setBounds({ x: c.x, y: c.y, width: w, height: targetH }); } catch { /* ignore */ }
    collapseAnimTarget = null;
    if (onDone) onDone();
    return;
  }
  // Time-based easing (not fixed steps) so the motion stays smooth even if the
  // timer jitters — each tick computes height from elapsed time, ease-out cubic.
  const DURATION = 240; // ms
  const start = Date.now();
  collapseAnim = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(collapseAnim); collapseAnim = null; collapseAnimTarget = null; return; }
    const t = Math.min(1, (Date.now() - start) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const h = Math.round(startH + (targetH - startH) * eased);
    const c = mainWindow.getBounds(); // live x/y so a drag-move isn't reset
    try { mainWindow.setBounds({ x: c.x, y: c.y, width: w, height: h }); } catch { /* ignore */ }
    if (t >= 1) {
      clearInterval(collapseAnim); collapseAnim = null; collapseAnimTarget = null;
      const f = mainWindow.getBounds();
      try { mainWindow.setBounds({ x: f.x, y: f.y, width: w, height: targetH }); } catch { /* ignore */ }
      if (onDone) onDone();
    }
  }, 12);
}

function collapseToHeader(headerH) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Never collapse mid-drag — a height change while the user is moving the window
  // produces the "dance + expand" jitter. Idle behaviour resumes on move-end.
  if (movingActive) return;
  // If already collapsed, ignore (idempotent — prevents double-snapshot of height).
  if (collapsed) return;
  diag('[collapse] idle-collapse to header h=' + Math.round(headerH) + ' focused=' + mainWindow.isFocused());
  // Cancel any running height animation first. If one WAS running we may be
  // reading a partial (mid-animation) frame, so remember its target to use
  // instead of the partial height below.
  const animWasRunning = !!collapseAnim;
  const animTarget = collapseAnimTarget;
  if (collapseAnim) {
    clearInterval(collapseAnim);
    collapseAnim = null;
    collapseAnimTarget = null;
  }
  const b = mainWindow.getBounds();
  // Snapshot the EXACT current expanded size as the restore target, so expand
  // returns to the LAST height the user set — whether they grew OR shrank the
  // window. (The old logic used Math.max, so it only ever kept the largest
  // height and a resize-smaller never stuck — that was the pop-out regression.)
  // If an animation was mid-flight we'd otherwise capture a partial frame, so
  // prefer that animation's target when it's larger than the current frame.
  const currentH = (animWasRunning && animTarget && animTarget > b.height) ? animTarget : b.height;
  expandedBounds = { x: b.x, y: b.y, width: b.width, height: currentH };
  expandedHeight = currentH;
  collapsed = true;
  const target = Math.max(24, Math.round(headerH));
  // Two things clamp the collapse height and leave dead black space below the
  // tab strip:
  //   1. our own minHeight (MIN_HEIGHT) — lower it to the target.
  //   2. Windows' MIN TRACKING SIZE for a WS_THICKFRAME (resizable) window —
  //      ~64px at this DPI, which is why it stopped at 64. Dropping the resize
  //      border (setResizable(false)) removes that OS floor so the window can
  //      shrink to just the header. Aero Snap isn't needed while idle-collapsed.
  try { mainWindow.setMinimumSize(MIN_WIDTH, target); } catch { /* ignore */ }
  animateHeightTo(target);
}

function expandFromHeader(focusInput) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  diag('[expand] expandFromHeader focusInput=' + !!focusInput + ' collapsed=' + collapsed);
  // If a collapse animation is still running (e.g. the renderer requested expand
  // before collapseToHeader finished), cancel it cleanly first.
  if (collapseAnim) {
    clearInterval(collapseAnim);
    collapseAnim = null;
  }
  collapsed = false;
  // Restore the normal minimum height + the resize border (Aero Snap) before
  // growing back, so the window is fully resizable/snappable again.
  try { mainWindow.setMinimumSize(MIN_WIDTH, MIN_HEIGHT); } catch { /* ignore */ }
  // ONLY the HEIGHT is restored. The window's x/y/WIDTH are left exactly as they
  // are right now — collapse never changed them, and the user may have moved or
  // narrowed the window while it was collapsed/idle. Restoring the snapshot width
  // was a bug: a width the user shrank would "pop back out" to the old width on
  // hover. Keep the user's chosen width; animate height only.
  const targetH = (expandedHeight && expandedHeight >= MIN_HEIGHT) ? expandedHeight
    : (expandedBounds && expandedBounds.height >= MIN_HEIGHT ? expandedBounds.height : DEFAULT_HEIGHT);
  expandedBounds = null; // clear so a manual resize while expanded isn't accidentally restored
  animateHeightTo(targetH, () => {
    if (focusInput) { mainWindow.focus(); dispatchFocusInput('expandFromHeader:post-animation'); }
  });
}

// ─── Tray menu rebuild (called on role change or force-visible toggle) ─────────
// Builds + sets the context menu from current state (role, clickThrough, etc.).
function rebuildTrayMenu() {
  if (!tray) return;
  const MOD_ROLES = ['moderator', 'admin', 'owner'];
  const isModOrAdmin = MOD_ROLES.includes(userRole || '');
  const template = [
    { label: `Fallout Chat Mod v${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => showWindow() },
    { label: 'Hide', click: () => hideWindowUserExplicit() },
    { type: 'separator' },
    { label: 'Focus to chat (Insert)', click: () => focusToChat() },
    { label: 'Click-through (always)', type: 'checkbox', checked: clickThrough, click: (mi) => { autoClickThrough = false; setClickThrough(mi.checked); } },
    { label: 'Auto click-through (interactive on hover)', type: 'checkbox', checked: autoClickThrough, click: (mi) => { autoClickThrough = mi.checked; if (!autoClickThrough) setClickThrough(false); } },
    // Start-on-login: Windows/macOS only (Linux auto-start is handled by the CLI
    // installer's .desktop entry). Lets users opt out of auto-launch.
    ...(process.platform !== 'linux' ? [
      { label: process.platform === 'darwin' ? 'Start at login' : 'Start with Windows', type: 'checkbox', checked: isAutoLaunchEnabled(), click: (mi) => { setAutoLaunch(mi.checked); rebuildTrayMenu(); } },
    ] : []),
    // Task 4: "Start overlay (no game)" — only for moderators, admins, and owners.
    // Toggles the force-visible flag so the overlay stays topmost without FO76 running.
    ...(isModOrAdmin ? [
      { type: 'separator' },
      {
        label: forceVisible ? '✓ Force-visible (no game) — click to disable' : 'Start overlay (no game)',
        type: 'normal',
        click: () => {
          forceVisible = !forceVisible;
          if (forceVisible) {
            showWindow();
            setClickThrough(false);
            applyZOrder();
          } else {
            applyZOrder();
          }
          rebuildTrayMenu(); // update checkmark
        },
      },
    ] : []),
    // Linux/KDE helper: imports the "keep above" KWin rule so the overlay sits
    // above the game, and opens the folder with the rule + setup note.
    ...(IS_LINUX ? [
      { type: 'separator' },
      { label: 'Linux fixes', enabled: false },
      { label: 'KDE: keep overlay above game', click: () => setupKdeKeepAbove({ interactive: true }) },
      // Cursor-lock fix: enable Wine's own mouse capture in the FO76 prefix so the cursor
      // stays locked to the game on KWin Wayland (KWin revokes the game's pointer constraint
      // when the overlay is on top). Explicit, on-demand only — never automatic (installer
      // only prints the manual steps). One-click, idempotent; needs FO76 closed (implicit —
      // this is a Proton-prefix fix, so it only makes sense between game sessions).
      { label: 'Fix FO76 cursor lock (Wayland)', click: () => fixFo76CursorLock() },
      // Optional: hide the KDE taskbar/panel while in-game so it can't pop over a BORDERLESS
      // game whenever the game loses focus (e.g. while typing in the chat overlay — KWin's
      // above-the-panel fullscreen promotion only holds while the game is ACTIVE).
      // Restores your exact panel modes when the game exits / overlay hides / app quits.
      { label: 'Hide taskbar while in-game (KDE)', type: 'checkbox', checked: isPanelHideInGameEnabled(), click: (mi) => {
        try { const st = loadState(); const settings = { ...(st.settings || {}), kdePanelHideInGame: !!mi.checked }; saveState({ settings }); } catch { /* ignore */ }
        syncPanelHideInGame('toggle');     // hide now if in-game, or restore if turned off
        rebuildTrayMenu();
      } },
    ] : []),
    // Diagnostics: surface the log for bug reports + let users enable verbose
    // (per-tick) logging without a relaunch. The toggle persists to settings so it
    // survives a restart; FCM_DEBUG=1 / --fcm-debug do the same from the CLI.
    { type: 'separator' },
    { label: 'Debug logging (verbose)', type: 'checkbox', checked: isVerboseLogging(), click: (mi) => {
      try { const st = loadState(); const settings = { ...(st.settings || {}), debugLogging: !!mi.checked }; saveState({ settings }); refreshLogLevel(settings); } catch { /* ignore */ }
      rebuildTrayMenu();
    } },
    { label: 'Open log folder', click: () => { try { shell.openPath(path.dirname(diagPath())); } catch { /* ignore */ } } },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() },
  ];
  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

// Rebuild the tray (called when role changes after register).
function rebuildTray() {
  rebuildTrayMenu();
}

// ─── Tray (works under WSLg too) ──────────────────────────────────────────────
function createTray() {
  // Use the real product icon (fcm.ico) for the tray. Fall back to a tiny
  // generated dot only if the asset can't be loaded (headless/odd platforms).
  let icon = appIcon();
  if (!icon) {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const x = i % size, y = (i / size) | 0;
      const dx = x - 7.5, dy = y - 7.5;
      const inside = dx * dx + dy * dy <= 36; // radius ~6
      const o = i * 4;
      buf[o] = 0xC8; buf[o + 1] = 0xA8; buf[o + 2] = 0x40; buf[o + 3] = inside ? 0xFF : 0x00;
    }
    try {
      icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
    } catch {
      icon = nativeImage.createEmpty();
    }
  }
  // Tray icons render best at ~16px; resize the .ico down so it's crisp.
  const iconSource = appIcon() ? 'app-icon' : (icon && !icon.isEmpty() ? 'generated-dot' : 'empty');
  try {
    if (icon && !icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  } catch { /* ignore */ }
  try {
    tray = new Tray(icon);
    trayAvailable = true;
    diag('[tray] created (iconSource=' + iconSource + ')');
  } catch (e) {
    // Some setups lack a StatusNotifierItem host (many wlroots/Wayland compositors,
    // GNOME without an AppIndicator extension, headless/WSLg) — `new Tray()` then
    // throws or no-ops. Logged because a missing tray is the #1 reason a Linux user
    // gets "stuck" with no way to re-show the overlay. refreshShortcuts() compensates
    // by keeping the summon hotkey registered (see its [hotkeys] recoverability path).
    tray = null;
    trayAvailable = false;
    diag('[tray] FAILED to create — no system tray / StatusNotifierItem host (iconSource=' + iconSource + '): ' +
      String(e && e.message ? e.message : e) + '. Overlay stays recoverable via the always-on summon hotkey.');
    return;
  }
  tray.setToolTip(`Fallout Chat Mod Overlay v${APP_VERSION}`);
  rebuildTrayMenu();
  tray.on('click', () => toggleWindow());
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const state = loadState();
  const bounds = clampToWorkArea(state.bounds || { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  // Seed the drift reference (#427) with the size we are about to open at, so the
  // first save of the session compares against a real value instead of banking one
  // drift step per launch.
  lastPersistedSize = { width: bounds.width, height: bounds.height };

  mainWindow = new BrowserWindow({
    width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y,
    minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT,
    // A transparent + frameless window can default to a tool-window style that is
    // hidden from the taskbar / alt-tab. We explicitly:
    //   • give it a title + skipTaskbar:false so it appears in the taskbar,
    //   • set `minimizable`/`maximizable` so the OS treats it as a normal app
    //     window (this is the Electron-supported equivalent of WS_EX_APPWINDOW —
    //     a non-tool window with a taskbar button + alt-tab entry).
    title: APP_TITLE,
    // NORMAL window on every platform. We tried `type:'notification'` on KDE-Wayland
    // to out-rank a focused fullscreen game (KWin's NotificationLayer), but it is
    // actually BELOW KWin's active-fullscreen layer (so it only helped while the overlay
    // had focus) AND a notification window is excluded from Alt-Tab / the taskbar and is
    // non-focusable — users couldn't tab into the chat. The correct KWin-6 fix is the
    // force-Layer property (on the fcm-keepabove KWin rule): it lifts the OVERLAY to OverlayLayer,
    // above the active-fullscreen game without demoting it, so a NORMAL overlay sits
    // above the game with no flicker — and stays a normal, focusable, tab-able window.
    // See overlay-core.buildKwinKeepAboveScript + window-management.md.
    type: undefined,
    icon: appIcon() || undefined, // real product icon for taskbar / alt-tab
    // show:false — don't flash the window open before we know whether FO76 is
    // running. reevaluateVisibility() in did-finish-load shows it only if allowed.
    show: false,
    transparent: true, frame: false, resizable: true, hasShadow: false,
    skipTaskbar: false, minimizable: true, maximizable: true,
    // `thickFrame:true` — Windows-only BrowserWindow option (Electron silently
    // ignores it on macOS/Linux). On Windows it keeps the WS_THICKFRAME window
    // style (resize border) so the frameless window is Aero-Snap-able — drag it
    // to a screen edge/top to snap to a pane. Combined with maximizable:true
    // (WS_MAXIMIZEBOX) this gives as much native snap as a transparent/frameless
    // window can get. macOS/Linux resize is handled by Electron's own drag logic.
    thickFrame: true,
    // NOT alwaysOnTop at creation — the foreground-aware controller decides.
    alwaysOnTop: false, backgroundColor: '#00000000',
    // backgroundThrottling:false — the overlay is almost always UNFOCUSED (it sits
    // over the game), and Chromium throttles painting/timers/rAF for unfocused
    // windows. That made live chat not visually update until the user focused the
    // window (e.g. hit Insert). Disable throttling so messages render in real time.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  mainWindow.setTitle(APP_TITLE);

  // TASK 87: Prevent window.open / target="_blank" from opening a new Electron
  // BrowserWindow (which would appear as a detached window outside the overlay).
  // Image links in chat now use the in-app lightbox; all other external URLs
  // open in the user's default browser via shell.openExternal.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(url); } catch { /* ignore */ }
    return { action: 'deny' };
  });

  // Belt-and-suspenders: force the taskbar button on after creation. On a native
  // Windows build this is what keeps the transparent/frameless window in the
  // taskbar + alt-tab switcher (not excluded as a tool window).
  try { mainWindow.setSkipTaskbar(false); } catch { /* ignore */ }
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* not all platforms */ }
  // Foreground-aware z-order: the overlay is topmost ONLY when the GAME
  // (Fallout76.exe) or the overlay itself is foreground — like a real in-game
  // overlay. When another app (e.g. a browser) is foreground, it must be able
  // to cover the chat. Driven by a foreground-process poll (native only).
  startForegroundZOrder();

  // Persist size/position so the window reopens where the user left it. Debounced
  // via a short timer so we don't write on every resize/move tick.
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistBounds, 400);
  };
  mainWindow.on('move', scheduleSave);
  mainWindow.on('resize', scheduleSave);

  // ── Drag guard: suppress z-order heartbeat churn while the user is dragging ──
  // On Windows, setAlwaysOnTop on a transparent window triggers a DWM repaint /
  // recomposition that flashes the overlay dim/colors. By setting isDragging=true
  // from will-move we prevent the 1500ms heartbeat and any focus/blur applyZOrder
  // calls from calling setAlwaysOnTop while the mouse button is held. Once the
  // drag ends ('moved') we re-apply the desired z-order once cleanly.
  mainWindow.on('will-move', () => { isDragging = true; });
  mainWindow.on('moved', () => {
    isDragging = false;
    // Unconditionally re-sync z-order now that the drag has settled. We force
    // overlayIsTopmost to the opposite of what we want so applyZOrder will always
    // call setAlwaysOnTop exactly once (the guard check `want === overlayIsTopmost`
    // would otherwise skip it if the state didn't actually change).
    overlayIsTopmost = !desiredTopmost();
    applyZOrder();
  });

  // Hide-to-tray instead of destroying on the OS close gesture (X button on
  // platforms that draw one). Real quit goes through quitApp()/tray.
  mainWindow.on('close', (e) => {
    diag('[close] close event isQuitting=' + isQuitting);
    if (!isQuitting) { e.preventDefault(); hideWindowUserExplicit(); }
  });

  // Optional: forward renderer console to a file (debug smoke tests).
  if (process.env.OVERLAY_DEBUG) {
    const logPath = path.join(__dirname, 'overlay-debug.log');
    try { fs.writeFileSync(logPath, ''); } catch { /* ignore */ }
    const append = (line) => { try { fs.appendFileSync(logPath, line + '\n'); } catch { /* ignore */ } };
    mainWindow.webContents.on('console-message', (...args) => {
      // Electron 31: (event, level, message, line, sourceId)
      const msg = typeof args[2] === 'string' ? args[2] : (args[0] && args[0].message);
      append('[renderer] ' + msg);
    });
    mainWindow.webContents.on('render-process-gone', (_e, d) => append('[renderer-gone] ' + JSON.stringify(d)));
  }

  if (RENDERER_URL) {
    mainWindow.loadURL(RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-renderer', 'index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    // Reset chatActive on every load — the renderer will re-signal once it
    // authenticates and passes onboarding. Until then, canShowOverlay() returns
    // true (not-set-up bypass) so login/onboarding are always reachable.
    chatActive = false;
    // Push the current game-running state so the renderer can immediately send
    // the correct client:status inGame value once the WS connects.
    mainWindow.webContents.send('overlay:game-state', gameRunning);
    // Show or hide based on current state (game running, privilege, setup state).
    // For a brand-new user chatActive=false → canShowOverlay()=true → shows.
    // For a returning set-up user without the game it will show for login, then
    // hide once the renderer signals chatActive=true and FO76 is not running.
    reevaluateVisibility();
    setClickThrough(false); // start interactive so the user can see/drag it
    // A fresh load ALWAYS starts the renderer expanded (collapsed=false in JS).
    // If the window was left collapsed (e.g. a hot-reload while idle-hidden, or a
    // crash mid-collapse), the window would otherwise stay header-tall while the
    // renderer paints the full overlay into it — clipping the tab bar. Reset to a
    // full height so the two never disagree.
    try {
      if (collapseAnim) { clearInterval(collapseAnim); collapseAnim = null; }
      collapsed = false;
      mainWindow.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
      const b = mainWindow.getBounds();
      if (b.height < MIN_HEIGHT) {
        mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: expandedHeight || DEFAULT_HEIGHT });
      }
    } catch { /* ignore */ }
    // Re-apply the saved Chrome Opacity as a CSS variable (--fcm-chrome-bg-alpha).
    // We no longer use window.setOpacity for chrome opacity — text must stay full
    // alpha; only the panel/tab backgrounds get more transparent.
    try {
      const wo = (loadState().settings || {}).windowOpacity;
      if (typeof wo === 'number') {
        const o = Math.max(0, Math.min(1, wo));
        mainWindow.webContents.executeJavaScript(
          `document.documentElement.style.setProperty('--fcm-chrome-bg-alpha', '${o}');`
        ).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
    if (BUILD_CHANNEL === 'qa') {
      startQaLogin();
    } else {
      startRelay();
    }
    // Re-focus the chat input after a reload if it was focused before.
    // We fire this after startRelay so the component has received relay:status
    // and re-mounted before we ask it to focus. A short delay lets the React
    // render cycle complete before the focus event arrives.
    if (inputWasFocused) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          dispatchFocusInput('post-reload-refocus');
        }
      }, 800);
    }
  });

  // Debug: capture a PNG of the rendered overlay for visual-parity checks.
  if (process.env.OVERLAY_SHOT) {
    mainWindow.setBackgroundColor('#0A0F0A'); // opaque bg so the capture isn't transparent
    setTimeout(async () => {
      try {
        // Debug: optionally fire a renderer event before capturing (e.g. open the
        // settings panel) so visual-parity shots can include transient UI.
        if (process.env.OVERLAY_FIRE) {
          const f = process.env.OVERLAY_FIRE;
          const code = f.startsWith('js:') ? f.slice(3) : `window.dispatchEvent(new CustomEvent('${f}'))`;
          try { await mainWindow.webContents.executeJavaScript(code); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 900));
        }
        // Force a fresh composite, then discard the first capture (the transparent
        // surface can retain a stale frame) and keep the second.
        mainWindow.webContents.invalidate();
        await mainWindow.webContents.capturePage();
        await new Promise(r => setTimeout(r, 400));
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, process.env.OVERLAY_SHOT), img.toPNG());
      } catch (e) { /* ignore */ }
      app.quit();
    }, Number(process.env.OVERLAY_SHOT_DELAY) || 7000);
  }
}

// Set the Windows AppUserModelID so all our windows group under a single taskbar
// button with the right icon, regardless of how Electron is launched.
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.falloutchatmod.overlay'); } catch { /* ignore */ }
}

// ─── Application menu — provides Edit accelerators (Ctrl+C/V/X/A/Z etc.) ─────
// The overlay window is frameless so there is no OS-drawn menu bar by default,
// which means Electron never registers the standard edit roles (Ctrl+C/V/X/A,
// Delete). Setting an application menu with a hidden menu bar wires those
// keyboard shortcuts without showing a visible bar.
function buildApplicationMenu() {
  const template = [
    {
      label: 'Application',
      submenu: [
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { role: 'delete' },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  // Hide the menu bar visually (accelerators still fire).
  if (mainWindow) {
    try { mainWindow.setMenuBarVisibility(false); } catch { /* ignore */ }
    try { mainWindow.setAutoHideMenuBar(true); } catch { /* ignore */ }
  }
}

// Input right-click context menu (renderer sends 'input:context-menu').
// Provides Cut / Copy / Paste / Select All for mouse users.
ipcMain.on('input:context-menu', (_evt, { x, y }) => {
  const menu = Menu.buildFromTemplate([
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'selectAll' },
  ]);
  menu.popup({ window: mainWindow || undefined, x: x ?? undefined, y: y ?? undefined });
});

// ─── Single-instance lock ────────────────────────────────────────────────────
// Without this, every NSIS post-install launch or Windows auto-start fires a
// new process on top of whatever is already running in the tray, producing
// duplicate windows and paired events (expand/collapse/mention all fire twice).
// If the lock is already held by another instance, quit immediately. The primary
// instance handles second-instance signals by restoring/focusing the window.
const _gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!_gotSingleInstanceLock) {
  // Another instance already holds the lock — this process hands off and exits. Logged
  // so a "won't launch" report (issue #272) can be distinguished from a silent quit
  // here vs. a failed AppImage mount / Ozone relaunch upstream.
  try { diag('[singleton] lock not acquired (another instance is running) — exiting this process'); } catch { /* logger not ready */ }
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // Startup diagnostics — first lines of every session's log. Critical for
  // diagnosing Linux/Proton installs we can't access directly.
  try {
    diag('=== Fallout Chat Mod overlay starting ===');
    diag('version=' + APP_VERSION, 'platform=' + process.platform, 'arch=' + process.arch,
      'electron=' + process.versions.electron, 'node=' + process.versions.node);
    diag('packaged=' + app.isPackaged, 'relayHost=' + RELAY_HOST, 'userData=' + app.getPath('userData'));
    diag('logFile=' + diagPath(), 'logLevel=' + _logLevel, 'execPath=' + process.execPath);
    if (IS_LINUX) {
      diag('[startup] desktop=' + (process.env.XDG_CURRENT_DESKTOP || '?'),
        'sessionDesktop=' + (process.env.XDG_SESSION_DESKTOP || '?'),
        'session=' + (process.env.XDG_SESSION_TYPE || '?'),
        'waylandDisplay=' + (process.env.WAYLAND_DISPLAY || '(unset)'),
        'x11Display=' + (process.env.DISPLAY || '(unset)'),
        'gdkBackend=' + (process.env.GDK_BACKEND || '(unset)'),
        'ozoneHint=' + (process.env.ELECTRON_OZONE_PLATFORM_HINT || '(unset)'));
      diag('[startup] kdeWaylandXWayland=' + KDE_WAYLAND +
        ' ozoneX11Arg=' + process.argv.includes('--ozone-platform=x11') +
        ' (KDE_WAYLAND true + ozoneX11Arg true → running XWayland via argv relaunch; ' +
        'ozoneX11Arg false on KDE_WAYLAND → still native Wayland, relaunch failed)');
      diag('[startup] appimage=' + (process.env.APPIMAGE || '(unset)'),
        'appdir=' + (process.env.APPDIR || '(unset)'),
        'argv0=' + (process.env.ARGV0 || '(unset)'),
        'appImageLauncherDisable=' + (process.env.APPIMAGELAUNCHER_DISABLE || '(unset)'));
      diag('[startup] argv=' + JSON.stringify(process.argv));
      // Async (don't block startup): the two most common Linux launch blockers —
      // missing libfuse2 (Fedora ships fuse3 → AppImage "launches once then dead",
      // issue #272) and AppImageLauncher (its "Integrate & run" conflicts with our
      // installer/relaunch). Logged so a user report shows them without asking.
      try {
        exec('ldconfig -p 2>/dev/null | grep -c "libfuse\\.so\\.2"; command -v AppImageLauncher >/dev/null 2>&1 && echo AIL || true',
          { shell: '/bin/sh', timeout: 4000 }, (_e, out) => {
            const lines = String(out || '').trim().split('\n');
            const fuse2 = (parseInt(lines[0], 10) || 0) > 0;
            const ail = lines.includes('AIL') || !!process.env.APPIMAGELAUNCHER_DISABLE;
            diag('[startup] libfuse2=' + (fuse2 ? 'present' : 'MISSING (AppImage may not mount — prefer the .deb)') +
              ' appImageLauncher=' + (ail ? 'present (avoid its Integrate&run for this app)' : 'not detected'));
          });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // Linux: drop the KWin "keep above" rule + setup note into userData so KDE
  // users can import it manually if needed (tray → "KDE: keep overlay above game").
  // On KDE+Wayland — the one config where the overlay renders BEHIND a fullscreen-
  // promoted game — auto-apply the keep-above layer rule + reconfigure KWin so the
  // overlay sits above the game for EVERYONE without any manual step. Idempotent:
  // skips if already installed (see setupKdeKeepAbove). Other Linux setups just get
  // the helper files written (setupKdeKeepAbove writes them on its first line too).
  if (KDE_WAYLAND) setupKdeKeepAbove({ interactive: false });
  else writeLinuxHelperFiles();
  // Crash recovery: if a previous run set panels to autohide and died before restoring, the
  // saved-modes file still exists — restore the user's panels now (before the game-gate runs).
  if (IS_LINUX && readSavedPanelHiding()) { diag('[panel-hide] stale saved state at startup — restoring'); restorePanelHiding(); }
  // One-time userData migration (productName "Fallout ChatMod" → "Fallout Chat Mod").
  // MUST run before any loadState()/register so the migrated install token is used
  // and the user stays on their real account (discordLinked carries over).
  migrateLegacyUserData();
  // Restore persisted role so the tray menu is correct even before register completes.
  // Also apply the persisted "Debug logging" toggle so verbose survives a restart
  // (env FCM_DEBUG / --fcm-debug still override and were already applied at load).
  try { const st = loadState(); userRole = st.userRole || null; refreshLogLevel(st.settings || null); } catch { /* ignore */ }
  createWindow();
  buildApplicationMenu();
  createTray();
  startKeybindFileWatch();
  // Register/refresh start-on-login (default ON) so the overlay auto-launches each
  // session instead of requiring a manual open. Existing users pick this up the
  // first time they run a build that includes it.
  applyAutoLaunch(isAutoLaunchEnabled());

  // ── Global hotkeys ──────────────────────────────────────────────────────────
  // ⚠️ These register fine but are NOT delivered under WSLg (the Windows desktop
  // owns the keystrokes). They work on a native Windows/Linux desktop build.
  // Read persisted keybinds (set from the settings panel) if present.
  let kb = null, presets = null;
  try {
    const rootState = loadState();
    const saved = rootState.settings || {};
    kb = saved.keybinds || null;
    presets = saved.presets || null;
    // One-time forced reset: if the persisted keybinds predate the current reset
    // version (old multi-key combos), restore the single-key defaults exactly
    // once and persist so the registered hotkeys + the state file both update.
    //
    // keybindsResetVersion is stored at the ROOT of overlay-state.json (not inside
    // settings) so that the overlay:save-settings IPC handler — which writes
    // { settings } and replaces that entire key — cannot accidentally clobber it.
    if (((rootState.keybindsResetVersion) ?? 0) < KEYBIND_RESET_VERSION) {
      kb = { ...DEFAULT_KEYBINDS };
      try {
        saveState({ settings: { ...(rootState.settings || {}), keybinds: kb }, keybindsResetVersion: KEYBIND_RESET_VERSION });
      } catch { /* best-effort persist */ }
      diag('[keybinds] one-time reset to single-key defaults (v' + KEYBIND_RESET_VERSION + ')');
    }
    // keybinds.cfg is authoritative: if the user edited it while the app was closed,
    // those changes win over what's stored in overlay-state.json.
    try {
      if (fs.existsSync(KEYBINDS_FILE)) {
        const cfgKb = parseKeybindsCfg(fs.readFileSync(KEYBINDS_FILE, 'utf8'));
        if (cfgKb && Object.keys(cfgKb).length) {
          kb = cfgKb;
          diag('[keybinds] loaded from keybinds.cfg');
        }
      }
    } catch (e) { diag('[keybinds] could not read keybinds.cfg:', String(e && e.message || e)); }
  } catch { /* defaults */ }
  registerHotkeys(kb, presets);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { isQuitting = true; persistBounds(); if (IS_LINUX) restorePanelHiding(); });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopRepaintTimer();
  if (zorderTimer) clearInterval(zorderTimer);
  if (gameScanTimer) { clearInterval(gameScanTimer); gameScanTimer = null; }
  if (collapseAnim) clearInterval(collapseAnim);
  if (zorderProc) { try { zorderProc.kill(); } catch { /* ignore */ } zorderProc = null; }
  // win32 foreground-poller self-heal + watchdog cleanup (issue #136).
  if (pollerRestartTimer) { clearTimeout(pollerRestartTimer); pollerRestartTimer = null; }
  if (fgWatchdogTimer) { clearInterval(fgWatchdogTimer); fgWatchdogTimer = null; }
  // KDE-Wayland kdotool poller cleanup.
  if (fgPollTimer) { clearInterval(fgPollTimer); fgPollTimer = null; }
  if (fgPoller) { try { fgPoller.kill(); } catch { /* ignore */ } fgPoller = null; }
  for (const s of relaySockets.values()) try { s.close(); } catch { /* ignore */ }
});

// Keep running in the tray when the window is hidden/closed; only the tray Quit
// (or quitApp) actually exits.
app.on('window-all-closed', () => { /* stay alive in tray */ });
