// overlay-core.js — pure, side-effect-free helpers extracted from main.js.
//
// This module MUST NOT require('electron') or perform any module-load side
// effects. It is the single source of truth for the pure main-process logic so
// it can be unit-tested under vitest without an Electron runtime. main.js
// require()s these and adapts them to its module state / the `screen` API.

'use strict';

// ── Default keybind / sizing / key constants ─────────────────────────────────
const DEFAULT_APP_CLIENT_KEY = 'fo76-chat-desktop-v1';
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 500;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;

// Roles that bypass all game-gate checks.
const PRIVILEGED_ROLES = ['moderator', 'admin', 'owner', 'developer'];

// All known FO76 executable names (no .exe), case-insensitive.
// Fallout76          = Steam / Bethesda.net / standard install
// Project76_GamePass = Xbox Game Pass / Microsoft Store
const GAME_PROCESSES = ['Fallout76', 'Project76_GamePass'];

// True when the given process name (with or without .exe) matches any known
// FO76 executable. Used by both the tasklist scanner and the foreground-window
// z-order checks.
function isGameProcess(name) {
  const lower = (name || '').toLowerCase().replace(/\.exe$/i, '');
  return GAME_PROCESSES.some(p => p.toLowerCase() === lower);
}

// "Has real data" = discordLinked true OR a non-default username (not
// /^Overlay\d+$/) OR a populated settings object (a non-empty plain object).
function stateHasRealData(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.discordLinked === true) return true;
  if (typeof s.username === 'string' && s.username && !/^Overlay\d+$/.test(s.username)) return true;
  if (s.settings && typeof s.settings === 'object' && Object.keys(s.settings).length > 0) return true;
  return false;
}

// CF/edge response classification. 429 is NOT a CF challenge (rate-limit).
//   • Only a 403 or 503 can be a Cloudflare edge block/challenge, and ONLY when a
//     CF MARKER is present (cf-mitigated header OR text/html challenge/error page
//     OR a cf-browser-verification body) — never on the status code alone.
//   • A JSON 403/503 (RFC 7807 Problem Details) is a real backend error and is
//     surfaced with its actual message, NOT masked as "blocked by edge". e.g. a
//     503 "Registration unavailable: server misconfigured" must reach the user.
function isCfChallenge(statusCode, resHeaders, body) {
  if (statusCode !== 403 && statusCode !== 503) return false;
  if (resHeaders && resHeaders['cf-mitigated']) return true;
  const ct = (resHeaders && (resHeaders['content-type'] || '')) || '';
  if (ct.includes('text/html')) return true;
  if (typeof body === 'string' && body.includes('cf-browser-verification')) return true;
  return false;
}

// True for single-printable-character accelerators (e.g. '/', '\'). Named keys
// and modifier-prefixed combos return false.
function isSinglePrintableChar(accel) {
  if (!accel || typeof accel !== 'string') return false;
  const named = /^(Insert|Delete|Home|End|PageUp|PageDown|F\d+|Escape|Tab|Space|Backspace|Enter|Return|Up|Down|Left|Right|Plus|Minus|Equal|NumLock|CapsLock|PrintScreen|Pause|ScrollLock|num\d|numadd|numsub|nummult|numdiv|numdec|numeq)$/i;
  if (named.test(accel)) return false;
  if (/^(CommandOrControl|Ctrl|Shift|Alt|Super|Meta)\+/i.test(accel)) return false;
  return accel.length === 1;
}

// Resolve the TOFU app-client key. Pure: env + fs + dir are injected.
//   env  : process.env-like object
//   fs   : { readFileSync } (only readFileSync is used)
//   dir  : the equivalent of main.js __dirname (cross-platform-overlay/)
//   path : { join } module (defaults to node's path)
// Precedence: APP_CLIENT_KEY env > backend/.env > ../.env > default. Trims.
function resolveAppClientKey(env, fs, dir, path) {
  // eslint-disable-next-line global-require
  path = path || require('path');
  if (env && env.APP_CLIENT_KEY) return String(env.APP_CLIENT_KEY).trim();
  for (const p of [path.join(dir, '..', 'backend', '.env'), path.join(dir, '..', '.env')]) {
    try {
      const m = fs.readFileSync(p, 'utf8').match(/^APP_CLIENT_KEY=(.*)$/m);
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* try next */ }
  }
  return DEFAULT_APP_CLIENT_KEY;
}

// Resolve the app version. Pure: fs + dir injected.
//   Precedence: ChatOverlay/ChatOverlay.csproj <Version> → package.json version
//   → '0.0.0'. The .csproj lives one level up from `dir`.
function resolveAppVersion(fs, dir, path) {
  // eslint-disable-next-line global-require
  path = path || require('path');
  try {
    const csproj = fs.readFileSync(path.join(dir, '..', 'ChatOverlay', 'ChatOverlay.csproj'), 'utf8');
    const m = csproj.match(/<Version>\s*([^<\s]+)\s*<\/Version>/);
    if (m) return m[1];
  } catch { /* fall back to package.json */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg && pkg.version) return pkg.version;
  } catch { /* fall back to default */ }
  return '0.0.0';
}

// Pure form of registerHotkeys' `map` build + the per-bind `accelToAction` and
// `isChar` derivation. Given a (possibly partial) keybind map, returns:
//   { map, binds } where `map` is the fully-resolved accelerator map (defaults
//   filled in, party1..8 included) and `binds` is an array of
//   { accel, action, isChar } for every non-blank, registerable accelerator.
//   `actionToFn` wiring stays in main.js; this is just the decision/derivation.
//   `defaults` supplies the fallback accelerator per action (main.js's *_SHORTCUT
//   constants). goFo76 uses `!== undefined` so an explicitly-blank goFo76 unbinds.
function buildKeybindMap(kb, defaults) {
  kb = kb || {};
  defaults = defaults || {};
  const map = {
    toggle:       (kb.toggle       !== undefined) ? kb.toggle       : defaults.toggle,
    clickThrough: (kb.clickThrough !== undefined) ? kb.clickThrough : defaults.clickThrough,
    focus:        (kb.focus        !== undefined) ? kb.focus        : defaults.focus,
    nextChannel:  (kb.nextChannel  !== undefined) ? kb.nextChannel  : defaults.nextChannel,
    prevChannel:  (kb.prevChannel  !== undefined) ? kb.prevChannel  : defaults.prevChannel,
    settings:     (kb.settings     !== undefined) ? kb.settings     : defaults.settings,
    recentParty:  (kb.recentParty  !== undefined) ? kb.recentParty  : defaults.recentParty,
    goFo76:       (kb.goFo76       !== undefined) ? kb.goFo76       : defaults.goFo76,
  };
  for (let i = 1; i <= 8; i++) {
    const key = 'party' + i;
    map[key] = (kb[key] !== undefined) ? kb[key] : '';
  }
  return map;
}

// Pure form of registerHotkeys' inner `accelToAction`: reverse-lookup of the
// first action whose accelerator equals `accel`, else `accel` itself (used for
// diagnostic logging). Mirrors `Object.entries(map)` iteration order.
function accelToAction(map, accel) {
  for (const [k, v] of Object.entries(map || {})) {
    if (v === accel) return k;
  }
  return accel;
}

// Pure form of the reevaluateVisibility decision. Returns 'show' when the
// overlay may be shown AND the user has not explicitly hidden it; 'hide'
// otherwise. (canShow is the result of canShowOverlay().)
function visibilityDecision(canShow, userHidden) {
  return (canShow && !userHidden) ? 'show' : 'hide';
}

// Pure form of emitVisibility's branch decision. The actual timer lives in
// main.js; this only decides what to do:
//   isVisible=true  → 'show-immediate' (and main.js cancels any pending hide).
//   isVisible=false → 'noop' if a hide is already pending (pendingHide=true),
//                     else 'schedule-hide' (main.js starts the 20s grace timer).
function emitVisibilityDecision(isVisible, pendingHide) {
  if (isVisible) return 'show-immediate';
  if (pendingHide) return 'noop';
  return 'schedule-hide';
}

// Pure form of desiredTopmost. state = { hasWindow, forceVisible, gameRunning,
// windowFocused, foregroundIsGame, focusAwareTopmost }. Returns true when the
// overlay should be always-on-top. No window → false.
//
// Two modes:
//   focusAwareTopmost=true  (Linux KDE-Wayland with active-window detection): float
//     above the game ONLY while the GAME is actually the foreground window, so
//     tabbing to another app lowers the overlay (no more "above ALL windows"). Safe
//     on Linux — topmost flips don't cause a DWM-recomposition flash there.
//   focusAwareTopmost=false (Windows, or Linux without detection): stay topmost for
//     the whole session while the game is RUNNING. On Windows this is deliberate —
//     it avoids true→false→true flips on tab-in that trigger DWM flashes; on bare
//     Linux/X11 there's no foreground API to do better.
// In both modes forceVisible and the overlay being focused force topmost.
function desiredTopmost(state) {
  state = state || {};
  if (!state.hasWindow) return false;
  if (state.forceVisible) return true;
  if (state.windowFocused) return true;
  if (state.focusAwareTopmost) {
    if (state.foregroundIsGame === true) return true;
    // A FULLSCREEN game often exposes no readable WM_CLASS to xdotool (foreground
    // reads empty / "(null)"). If the game is running and the foreground is
    // unreadable, it's almost certainly the game in fullscreen → stay on top. Only a
    // RECOGNIZED other window (a real, non-game class) lowers the overlay.
    if (state.gameRunning && state.foregroundUnknown === true) return true;
    return false;
  }
  if (state.gameRunning) return true;
  return state.foregroundIsGame === true;
}

// Whether the KWin "keep game below" rule should be active right now. It drops FO76 to
// KWin's BelowLayer so the overlay shows over a focused fullscreen game — but BelowLayer
// is also below the panel, so while it's applied the game sits under the taskbar. We
// therefore only want it while the overlay is ACTUALLY visible over the game: game
// running AND overlay visible AND the user hasn't opted out. When the overlay is hidden
// to tray there's nothing to show, so the rule comes off and FO76 returns to normal
// fullscreen stacking (above the panel). See main.js syncKwinGameBelow / applyZOrder.
function shouldForceGameBelow({ gameRunning, overlayVisible, gameBelowEnabled } = {}) {
  return !!(gameBelowEnabled && gameRunning && overlayVisible);
}

// Pure hysteresis reducer for FO76 presence detection. A single bad scan must NOT flip
// the overlay's game-state — that churns z-order + visibility (reads as the overlay
// flashing/bouncing). `found` is the scan result: true (game seen), false (not seen), or
// null when the scan itself FAILED (ps error/timeout) and therefore carries NO info — a
// failure keeps the committed state and drops any pending flip (a scan hiccup must never
// be read as "game exited"). A genuine change must persist across `appearScans` (launch)
// or `disappearScans` (exit) consecutive scans before it commits; disappearance is held
// longer so a transient miss mid-game can't drop the overlay. Returns the next
// accumulator + whether to commit, plus the resulting gameRunning.
function nextPresenceState({ found, gameRunning, candidate, stableCount, appearScans = 2, disappearScans = 3 } = {}) {
  if (found == null || found === gameRunning) {
    return { candidate: null, stableCount: 0, commit: false, gameRunning: !!gameRunning };
  }
  const nextCount = (found === candidate) ? (stableCount || 0) + 1 : 1;
  const need = found ? appearScans : disappearScans;
  if (nextCount < need) {
    return { candidate: found, stableCount: nextCount, commit: false, gameRunning: !!gameRunning };
  }
  return { candidate: null, stableCount: 0, commit: true, gameRunning: found };
}

// ── KDE panel auto-hide while in-game (opt-in) ───────────────────────────────
// Residual to the force-Layer rule: a BORDERLESS game sits in NormalLayer, BELOW the panel,
// so the taskbar's edge covers it. Opt-in: while the overlay is visible over a running game
// we set every Plasma panel to "autohide" (fully retracts) via plasmashell evaluateScript,
// and restore each panel's ORIGINAL mode afterward. Pure string/decision helpers here; the
// qdbus side effects + crash-safe persistence live in main.js.
const PANEL_HIDING_MODES = ['none', 'autohide', 'dodgewindows', 'windowsgobelow'];

// Hide the taskbar right now? Opt-in setting AND overlay visible over a running game (same
// gate as the game-below fallback). Off → restore the panel.
function shouldHidePanelInGame({ gameRunning, overlayVisible, enabled } = {}) {
  return !!(enabled && gameRunning && overlayVisible);
}

// evaluateScript JS: print each panel's `id=hidingMode`, comma-joined, so we can capture and
// later restore the user's EXACT per-panel modes. (`panelIds`/`panelById` are plasma globals.)
function buildPanelHidingSaveScript() {
  return 'var o=[];for(var i=0;i<panelIds.length;i++){try{o.push(panelIds[i]+"="+panelById(panelIds[i]).hiding);}catch(e){}}print(o.join(","));';
}

// Parse the save-script output ("424=autohide,7=none") into a { id: mode } map, keeping only
// KNOWN modes (defensive against ERR/garbage/partial output).
function parsePanelHidingSave(output) {
  const map = {};
  String(output == null ? '' : output).trim().split(',').forEach((pair) => {
    const m = /^\s*(\d+)=(\S+)\s*$/.exec(pair);
    if (m && PANEL_HIDING_MODES.includes(m[2])) map[m[1]] = m[2];
  });
  return map;
}

// evaluateScript JS: set EVERY panel to `mode` (validated; falls back to autohide).
function buildPanelHidingSetScript(mode) {
  const safe = PANEL_HIDING_MODES.includes(mode) ? mode : 'autohide';
  return 'for(var i=0;i<panelIds.length;i++){try{panelById(panelIds[i]).hiding="' + safe + '";}catch(e){}}';
}

// evaluateScript JS: restore each panel to its saved mode (per-id, guarded, validated). Returns
// '' when the map has nothing valid (caller can skip the call).
function buildPanelHidingRestoreScript(savedMap) {
  const lines = [];
  for (const id of Object.keys(savedMap || {})) {
    if (!/^\d+$/.test(id)) continue;
    const mode = savedMap[id];
    if (!PANEL_HIDING_MODES.includes(mode)) continue;
    lines.push('try{panelById(' + id + ').hiding="' + mode + '";}catch(e){}');
  }
  return lines.join('');
}

function isPrivilegedRole(role) {
  return PRIVILEGED_ROLES.includes(role || '');
}

// Pure form of canShowOverlay. state = { forceVisible, role, gameRunning,
// chatActive }. Returns true when forceVisible OR privileged role OR game
// running OR the user is not yet chat-active (onboarding/login reachable).
function canShowOverlay(state) {
  state = state || {};
  if (state.forceVisible) return true;
  if (isPrivilegedRole(state.role)) return true;
  if (state.gameRunning) return true;
  if (!state.chatActive) return true;
  return false;
}

// Pure clamp of a desired bounds rect to a given work area. workArea =
// { x, y, width, height } (the display work area in screen coords). Returns a
// sanitized { x, y, width, height } fully inside the work area.
function clampToWorkArea(desired, workArea) {
  desired = desired || {};
  const wa = workArea;

  const width = Math.max(MIN_WIDTH, Math.min(desired.width || DEFAULT_WIDTH, wa.width));
  const height = Math.max(MIN_HEIGHT, Math.min(desired.height || DEFAULT_HEIGHT, wa.height));

  let x = desired.x;
  let y = desired.y;
  if (typeof x !== 'number') x = wa.x + 60;
  if (typeof y !== 'number') y = wa.y + 60;

  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));

  return { x, y, width, height };
}

// ── Modal fit sizing (issue #374) ─────────────────────────────────────────────
// The shell settings / onboarding panels are plain DOM rendered INSIDE the
// overlay's own BrowserWindow, so their CSS caps (`max-width: 96vw`,
// `max-height: 90vh` on #shell-settings / #shell-onboarding) resolve against the
// OVERLAY WINDOW rather than the screen. A user who keeps the overlay compact
// during gameplay — it can go as small as MIN_WIDTH x MIN_HEIGHT (320x280) —
// gets the settings panel squeezed to roughly 307x252, which is what #374
// reports as "cramped, have to resize the overlay to use settings".
//
// Portalling cannot fix this: nothing rendered in the renderer can paint outside
// its own OS window. So instead the main process grows the window just enough to
// show the panel while it is open, and restores the user's size on close.
//
// Size a modal needs to render at its designed width. #shell-settings is 520px
// wide capped at 96vw, so the window must be at least 520/0.96 ~= 542px to show
// it un-squeezed; 560 leaves margin. 720 tall gives the settings list real room
// (90vh of 720 = 648px of panel).
const MODAL_FIT_WIDTH = 560;
const MODAL_FIT_HEIGHT = 720;

// Pure sizing decision for the temporary modal growth.
//   current  = live window bounds { x, y, width, height }
//   workArea = display work area  { x, y, width, height }
//   need     = { width, height } the modal wants (defaults to MODAL_FIT_*)
//
// GROWS ONLY — never shrinks a window the user already made large enough.
// Returns null when no growth is needed or possible, which the caller treats as
// "nothing was changed, so there is nothing to restore". Otherwise returns the
// grown rect, already clamped to the work area.
function modalFitBounds(current, workArea, need) {
  if (!current || !workArea) return null;
  const wantW = Math.max(Number(current.width) || 0, need?.width ?? MODAL_FIT_WIDTH);
  const wantH = Math.max(Number(current.height) || 0, need?.height ?? MODAL_FIT_HEIGHT);
  // Already big enough in both axes — leave the user's window alone.
  if (wantW <= current.width && wantH <= current.height) return null;

  const grown = clampToWorkArea(
    { x: current.x, y: current.y, width: wantW, height: wantH },
    workArea,
  );
  // A small work area can clamp the request straight back to the current size;
  // treat that as "no change" so we never record a pointless restore snapshot.
  if (grown.width === current.width && grown.height === current.height) return null;
  return grown;
}

// ── KDE-Wayland active-window (xdotool/kdotool) helpers ───────────────────────

// XWayland WM_CLASS values that FO76/Proton is known to use.  Under Steam Proton
// the active-window tool (xdotool/kdotool) reports "steam_app_1151340" (FO76's
// Steam AppID — confirmed on CachyOS); some Proton/Wine versions instead report
// the mapped Windows exe name "fallout76.exe".  The existing isGameProcess()
// already handles "fallout76.exe" via the .exe-stripping path; this set handles
// the steam_app_ form and lets callers do a quick pre-check before isGameProcess().
const XWAYLAND_GAME_CLASSES = [
  // Handled by existing isGameProcess() (strips .exe): fallout76.exe,
  // project76_gamepass.exe.  Listed here for documentation only — callers rely on
  // isGameProcess() for those.
  // Steam App ID fallback class:
  'steam_app_1151340',
];

// Extended isGameProcess check that also covers XWayland-specific WM_CLASS strings
// that isGameProcess() alone would not match (i.e. the steam_app_* form).
// Returns true when the given class name is a known FO76 surface — either via the
// standard exe-name check or the XWAYLAND_GAME_CLASSES list.
function isGameClass(name) {
  if (!name) return false;
  if (isGameProcess(name)) return true; // handles fallout76.exe, project76_gamepass.exe, etc.
  const lower = name.toLowerCase();
  return XWAYLAND_GAME_CLASSES.some(c => lower === c);
}

// True when the active-window class is UNREADABLE — empty, or the literal "(null)"
// that some xdotool builds print when the focused window exposes no WM_CLASS. A
// FULLSCREEN FO76 (Proton/XWayland) commonly does exactly this — confirmed on
// CachyOS: focused game → `xdotool getactivewindow getwindowclassname` returns
// "(null)" and xprop shows no WM_CLASS. So when the game is RUNNING and the
// foreground is unreadable, it's almost certainly the fullscreen game (not a real
// other app), and callers should keep the overlay on top / hotkeys live.
function isUnknownForegroundClass(name) {
  const s = (name == null ? '' : String(name)).trim().toLowerCase();
  return s === '' || s === '(null)';
}

// Pure function: should global hotkeys be registered right now?
//
// Inputs:
//   platform             : process.platform string ('win32', 'linux', …)
//   kdeWayland           : boolean — true when running on KDE+Wayland
//   hasForegroundDetect  : boolean — true when kdotool is confirmed present (Linux)
//   gameRunning          : boolean — game process is alive (tasklist scanner)
//   foregroundProc       : string  — last foreground class/proc name (lowercased)
//   overlayFocused       : boolean — the overlay window has OS focus
//
// Decision logic:
//   win32 → game active = game is the foreground window
//   linux + KDE-Wayland + kdotool present → same as win32
//   linux (fallback / no kdotool) → game active = game is running
//   In all cases: keys are active when (game active) OR (overlay focused).
function shouldRegisterShortcuts({ platform, kdeWayland, hasForegroundDetect, gameRunning, foregroundProc, overlayFocused }) {
  let gameActive;
  if (platform === 'win32') {
    gameActive = isGameClass(foregroundProc);
  } else if (kdeWayland && hasForegroundDetect) {
    // Same fullscreen-game caveat as desiredTopmost: a focused fullscreen FO76 reads
    // an unreadable class ("(null)"/empty), so treat "game running + unreadable
    // foreground" as the game being active (keeps hotkeys live in-game).
    gameActive = isGameClass(foregroundProc) || (!!gameRunning && isUnknownForegroundClass(foregroundProc));
  } else {
    // Fallback: no reliable foreground API — treat "game running" as "game active".
    // This matches the pre-kdotool Linux behavior exactly (no regression).
    gameActive = !!gameRunning;
  }
  return gameActive || !!overlayFocused;
}

// Pure decision: what to do after a KDE-Wayland active-window poll spawn ends.
//
// Why this exists: on some distros (confirmed Fedora 44, xdotool 3.x) the chained
// `xdotool getactivewindow getwindowclassname` hits a double-free *inside libxdo*
// (`xdo_get_window_classname` → `XFree` → abort/SIGABRT) whenever the active window's
// WM_CLASS can't be read cleanly — routine under XWayland when a native-Wayland
// window is focused. Our JS error-handling can't prevent the per-spawn coredump, so
// re-spawning into the crash every ~300ms produces a coredump storm. This breaker
// detects repeated crashes and stops hammering the broken tool.
//
// Inputs:
//   crashed            : boolean — the last spawn ended abnormally (signal set, or
//                        non-zero/null exit code). A clean exit is `crashed:false`.
//   consecutiveCrashes : number  — count of back-to-back crashes INCLUDING this one
//                        (caller increments before calling; resets to 0 on clean exit).
//   maxCrashes         : number  — threshold to trip the breaker (default 3).
//   hasAltTool         : boolean — the *other* tool (kdotool↔xdotool) is on PATH.
//
// Returns one of:
//   'continue'    — keep polling with the current tool (no trip, or a clean exit).
//   'switch-tool' — trip: the current tool keeps crashing, but the alternate tool is
//                   available, so switch to it and resume (gives crash-affected users
//                   kdotool automatically when installed).
//   'disable'     — trip with no alternate: stop the poller for this session and fall
//                   back to game-running detection (no regression vs. "no tool").
function decideForegroundPollerAction({ crashed, consecutiveCrashes, maxCrashes = 3, hasAltTool = false } = {}) {
  if (!crashed) return 'continue';
  if (consecutiveCrashes < maxCrashes) return 'continue';
  return hasAltTool ? 'switch-tool' : 'disable';
}

// ── Windows foreground-poller resilience (issue #136) ─────────────────────────
// On win32 the foreground process is read by a SINGLE long-lived powershell.exe
// child (the only thing that updates lastForegroundProc). If it dies — or never
// starts: PowerShell Constrained Language Mode blocks its `Add-Type`, and
// AppLocker/AV can block powershell.exe — the last-known foreground (the game,
// while keys were registered) freezes and refreshShortcuts() stops firing, so the
// global hotkeys are NEVER released and fire in every app (#136). These pure
// helpers back the self-heal: a capped restart backoff, a fail-safe staleness
// watchdog, and a diagnostic exit classifier. main.js owns the timers/spawns.

// Backoff (ms) before relaunching the win32 poller after its Nth death. Ramps
// 1s → 2s → 5s and caps at 5s, so a transient death recovers fast while a hard
// failure (blocked powershell) can't spin in a tight relaunch loop. restartCount
// is how many restarts have already happened (0 = first restart after first death).
function nextPollerBackoffMs(restartCount) {
  const schedule = [1000, 2000, 5000];
  const n = Number.isFinite(restartCount) && restartCount > 0 ? Math.floor(restartCount) : 0;
  return schedule[Math.min(n, schedule.length - 1)];
}

// Fail-safe watchdog test: has the foreground poller gone silent? When the poller
// is dead/blocked/never-started, no new lines arrive and lastForegroundProc is
// stuck. Treat "no line for longer than staleMs" as "we don't know the foreground"
// and tell the caller to fail closed (clear foreground → refreshShortcuts releases
// the global hotkeys). lastLineAt is the ms timestamp of the last line (0/null =
// never seen). Refuses to trip on invalid now/staleMs so a missing clock can't
// spuriously release a working user's keys.
function isForegroundStale({ lastLineAt, now, staleMs } = {}) {
  if (typeof now !== 'number' || typeof staleMs !== 'number' || staleMs <= 0) return false;
  const last = typeof lastLineAt === 'number' ? lastLineAt : 0;
  return (now - last) > staleMs;
}

// Classify a win32 poller exit for diagnostics. A poller that exits almost
// immediately and never emitted a single foreground line is the signature of a
// BLOCKED launch (Constrained Language Mode rejecting `Add-Type`, or AppLocker/AV
// blocking powershell.exe) — distinct from a normal mid-run crash. Lets main.js
// log an actionable hint instead of dying silently (why #136 was hard to spot).
// Returns 'blocked-or-clm' (fast exit, never emitted) | 'crashed' (everything else).
function classifyPollerExit({ msSinceStart, everEmitted, quickExitMs = 1500 } = {}) {
  const fast = typeof msSinceStart === 'number' && msSinceStart >= 0 && msSinceStart < quickExitMs;
  if (!everEmitted && fast) return 'blocked-or-clm';
  return 'crashed';
}

// ── Diagnostic logging level + rotation (pure; the logger in main.js is testable) ──

// Resolve the active log level from env, argv, and persisted settings.
//   'verbose' — per-tick logging on (deep debugging session).
//   'info'    — default; lifecycle + state transitions only.
// Precedence: explicit env (FCM_DEBUG / FCM_VERBOSE) or a launch flag
// (--fcm-debug, or the --debug / --verbose aliases) turn verbose ON; otherwise the
// persisted Settings → Debug logging toggle; else 'info'. Kept here (not main.js)
// so the precedence is unit-testable without electron.
function resolveLogLevel({ env = {}, argv = [], settings = null } = {}) {
  env = env || {};                              // tolerate an explicit null
  if (!Array.isArray(argv)) argv = [];
  const truthy = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'verbose' || s === 'debug';
  };
  if (truthy(env.FCM_DEBUG) || truthy(env.FCM_VERBOSE)) return 'verbose';
  // --fcm-debug is the namespaced, documented launch flag (safe to pass to the
  // AppImage / .deb binary / CLI: `"Fallout Chat Mod.AppImage" --fcm-debug`);
  // --debug / --verbose are accepted aliases. The KDE-Wayland XWayland relaunch
  // preserves user argv (planOzoneRelaunch concats), so the flag survives.
  if (Array.isArray(argv) && (argv.includes('--fcm-debug') || argv.includes('--debug') || argv.includes('--verbose'))) return 'verbose';
  if (settings && typeof settings === 'object' && settings.debugLogging === true) return 'verbose';
  return 'info';
}

// True when the log file should be rotated (renamed to .1 and started fresh). Pure
// so the rotation threshold is unit-testable; the caller supplies the current byte
// size and the cap. Guards against NaN / non-positive caps.
function shouldRotateLog(size, cap) {
  return typeof size === 'number' && typeof cap === 'number' && cap > 0 && size > cap;
}

// ── Relay URL resolution ───────────────────────────────────────────────────────
// Single source of truth for the two relay URL env-override patterns. main.js calls
// this at startup; tests call it directly to assert env override behaviour.
//
// Path A (dev:cloud — non-CF-Access dev backend):
//   env.RELAY_HTTP = 'https://dev.falloutchatmod.com'
//   env.RELAY_WS   = 'wss://dev.falloutchatmod.com/ws'
//   No Cloudflare Access headers required — the dev API/WS path bypasses CF Access;
//   the normal install-token/session auth flow is sufficient.
//
// Path B (dev:local):
//   env.RELAY_HTTP = 'http://localhost:7177'
//   env.RELAY_WS   = 'ws://localhost:7177/ws'
//
// Production (default — no env override needed):
//   relayHttp = 'https://falloutchatmod.com'
//   relayWs   = 'wss://falloutchatmod.com/ws'
function resolveRelayUrls(env, channel) {
  if (channel === 'qa') {
    return {
      relayHttp: env.RELAY_HTTP || 'https://dev.falloutchatmod.com',
      relayWs:   env.RELAY_WS   || 'wss://dev.falloutchatmod.com/ws',
    };
  }
  return {
    relayHttp: env.RELAY_HTTP || 'https://falloutchatmod.com',
    relayWs:   env.RELAY_WS   || 'wss://falloutchatmod.com/ws',
  };
}

// Classify whether the running game is under an exclusive input grab that the
// overlay cannot beat. gamescope's `--force-grab-cursor` (and -f fullscreen)
// grabs the keyboard/mouse at the evdev level, BELOW X11 — so the overlay's
// XGrabKey global hotkeys and pointer-drag never receive events while in-game.
// Returns 'force-grab' (definitive), 'gamescope-fullscreen' (likely), or null.
// Input is the `ps -A -o command=` output (or any process-command string).
function classifyInputGrab(psOutput) {
  const s = String(psOutput || '');
  if (/--?force-grab-cursor/i.test(s)) return 'force-grab';
  if (/(^|\s)gamescope(\s|$)/i.test(s) && /(^|\s)-f(\s|$)/.test(s)) return 'gamescope-fullscreen';
  return null;
}

// Build the /bin/sh script that installs the KDE keep-above-the-game KWin rules.
// Pure (string in → string out) so the exact commands are unit-testable without
// spawning anything. main.js runs the result via child_process.exec on KDE.
//
// TWO rules are needed on Plasma 6 (verified on KWin 6.6.5):
//   • "keep above" on the OVERLAY (wmclass=fallout-chat-mod): above=true.
//   • "keep game below" on the GAME (wmclass=steam_app_1151340): below=true (Force).
//     KWin evaluates keepBelow() BEFORE isActiveFullScreen(), so dropping the game to
//     BelowLayer(1) prevents it from ever reaching ActiveLayer(6) — the overlay's
//     keepAbove(4) wins even while the game is focused, with NO flicker.
//     (Replaces the retired fcm-game-demote / fullscreen=false Force rule, which fought the
//     game's own fullscreen state and caused endless flicker — issue #272.)
//
// FORMAT (KWin 6, also verified): the authoritative rule list is [General] `rules=` — a
// COMMA-SEPARATED list of group NAMES — plus a matching `count`. Writing numbered groups +
// only `count` is NOT enough (KWin rewrites count and drops the rules). We use STABLE NAMED
// groups (fcm-keepabove / fcm-game-below).
//
// SELF-HEALING CLEANUP: both builders below first PARTITION the existing `rules=` list into
// the user's own rules (KEEP) vs FCM-authored rules (matched by a "Fallout Chat Mod" prefix
// in each group's Description — this catches the NUMBERED-group rules our 1.3.89–1.3.93
// experimental builds wrote, not just the current named groups). The shared partition snippet
// loops the rule names, reads each group's Description via kreadconfig6, and builds `$KEEP`
// (kept, comma-joined) and `$FCM` (space-joined FCM group names to clear). The qdbus
// reconfigure name varies by distro/Qt, so we try qdbus / qdbus6 / qdbus-qt6.
const KWIN_RECONF = `(qdbus org.kde.KWin /KWin reconfigure || qdbus6 org.kde.KWin /KWin reconfigure || qdbus-qt6 org.kde.KWin /KWin reconfigure) 2>/dev/null || true`;
function kwinPartitionSnippet(file) {
  return [
    // $RULES = the on-disk path (kwriteconfig6 --file is relative to ~/.config; awk needs the path).
    `RULES="\${XDG_CONFIG_HOME:-$HOME/.config}/${file}"`,
    `R=$(kreadconfig6 --file ${file} --group General --key rules 2>/dev/null)`,
    `KEEP=""; FCM=""`,
    `for g in $(printf '%s' "$R" | tr ',' ' '); do`,
    `  d=$(kreadconfig6 --file ${file} --group "$g" --key Description 2>/dev/null)`,
    `  case "$d" in`,
    `    "Fallout Chat Mod"*) FCM="$FCM $g" ;;`,
    `    *) KEEP="\${KEEP:+$KEEP,}$g" ;;`,
    `  esac`,
    `done`,
  ];
}

// Strip the INI sections named in $FCM from $RULES by rewriting the file with awk. REQUIRED
// because kwriteconfig6 CANNOT remove an INI section: `--key X --delete` AND `--group G --delete`
// both silently no-op (verified), leaving orphaned [section] blocks. Matching is on the exact
// whole [section] name (the FCM group names from the partition). No-op when $FCM is empty.
function awkStripFcmSectionLines() {
  return [
    `if [ -n "$FCM" ]; then`,
    `  awk -v drop=" $FCM " '/^\\[.*\\]$/{name=$0;sub(/^\\[/,"",name);sub(/\\]$/,"",name);skip=index(drop," " name " ")>0} !skip' "$RULES" > "$RULES.fcmtmp" && mv "$RULES.fcmtmp" "$RULES"`,
    `fi`,
  ];
}

// Install (clean + apply) script. Removes any stale FCM rules, then writes the current
// named rules, preserving the user's own rules. Idempotent: if the active FCM rules are
// already EXACTLY our current named groups, it prints fcm-rule-present and skips the
// reconfigure (so startup doesn't flash KWin on every launch).
//
// THE KWin-6 FIX for "overlay hidden behind a focused fullscreen game" is the force-Layer
// rule `fcm-overlay-layer` (`layer=overlay`, `layerrule=2`=Force): it puts the OVERLAY in
// KWin's OverlayLayer, ABOVE the active-fullscreen game, WITHOUT demoting the game — so the
// game keeps its normal fullscreen stacking (above the panel) and the overlay keeps keyboard
// focus (its window TYPE stays Normal). Added in KWin 6.0 (KDE Bug 441074, the sanctioned
// "stay above fullscreen" mechanism); verified on KWin 6.7.1 (a matched window jumps to
// stackingLayer 9). Always applied alongside the plain keep-above rule.
//
// includeBelow (default FALSE): an OPT-IN FALLBACK "keep game below" rule (fcm-game-below,
// `below=true`) for the rare setup where the force-Layer rule doesn't take. It drops the game
// to BelowLayer, which also puts it below the PANEL — so it's off by default now that the
// force-Layer rule handles the common case. (settings.kwinGameBelow / tray toggle.)
function buildKwinKeepAboveScript({ file = 'kwinrulesrc', overlayWmclass = 'fallout-chat-mod', gameWmclass = 'steam_app_1151340', includeBelow = false, overlayLayer = 'overlay' } = {}) {
  const ABOVE = 'fcm-keepabove';       // overlay keep-above (belt-and-suspenders)
  const LAYER = 'fcm-overlay-layer';   // overlay force-Layer=Overlay — beats fullscreen WITHOUT demoting the game
  const BELOW = 'fcm-game-below';      // opt-in fallback: demote the game (also drops it below the panel)
  const w = (grp, key, val) => `kwriteconfig6 --file ${file} --group ${grp} --key ${key} ${val}`;
  const lines = [
    ...kwinPartitionSnippet(file),
    // Idempotency: keep-above + overlay-layer are ALWAYS wanted; game-below present iff
    // requested → skip. Otherwise strip + rewrite so toggling the option on/off works.
    `N=$(printf '%s' "$FCM" | tr ' ' '\\n' | grep -c .)`,
    `case " $FCM " in *" ${ABOVE} "*) A=1 ;; *) A=0 ;; esac`,
    `case " $FCM " in *" ${LAYER} "*) L=1 ;; *) L=0 ;; esac`,
    `case " $FCM " in *" ${BELOW} "*) B=1 ;; *) B=0 ;; esac`,
    includeBelow
      ? `if [ "$N" = "3" ] && [ "$A" = "1" ] && [ "$L" = "1" ] && [ "$B" = "1" ]; then echo fcm-rule-present; exit 0; fi`
      : `if [ "$N" = "2" ] && [ "$A" = "1" ] && [ "$L" = "1" ] && [ "$B" = "0" ]; then echo fcm-rule-present; exit 0; fi`,
    // Clear stale FCM groups (old numbered/named, the retired fcm-game-demote, and a
    // now-unwanted fcm-game-below) — awk-strip them (kwriteconfig6 can't delete a section).
    ...awkStripFcmSectionLines(),
    // Overlay keep-above rule (always). Harmless belt-and-suspenders below the force-Layer rule.
    w(ABOVE, 'Description', `"Fallout Chat Mod - keep above games"`),
    w(ABOVE, 'wmclass', `"${overlayWmclass}"`),
    w(ABOVE, 'wmclassmatch', '2'),
    w(ABOVE, 'wmclasscomplete', 'false'),
    w(ABOVE, 'above', 'true'),
    w(ABOVE, 'aboverule', '3'),
    // Overlay force-Layer = Overlay (always) — THE fix. Above active-fullscreen, no demotion.
    w(LAYER, 'Description', `"Fallout Chat Mod - overlay layer"`),
    w(LAYER, 'wmclass', `"${overlayWmclass}"`),
    w(LAYER, 'wmclassmatch', '2'),
    w(LAYER, 'wmclasscomplete', 'false'),
    w(LAYER, 'layer', overlayLayer),
    w(LAYER, 'layerrule', '2'),
  ];
  // Opt-in fallback: keep game below (also drops it below the panel — hence off by default).
  if (includeBelow) {
    lines.push(
      w(BELOW, 'Description', `"Fallout Chat Mod - keep game below"`),
      w(BELOW, 'wmclass', `"${gameWmclass}"`),
      w(BELOW, 'wmclassmatch', '2'),
      w(BELOW, 'wmclasscomplete', 'false'),
      w(BELOW, 'below', 'true'),
      w(BELOW, 'belowrule', '2'),
    );
  }
  // rules = preserved user rules + ours; count = its length.
  const NEWR = includeBelow
    ? `\${KEEP:+$KEEP,}${ABOVE},${LAYER},${BELOW}`
    : `\${KEEP:+$KEEP,}${ABOVE},${LAYER}`;
  lines.push(
    `NEWR="${NEWR}"`,
    `kwriteconfig6 --file ${file} --group General --key rules "$NEWR"`,
    `COUNT=$(printf '%s' "$NEWR" | tr ',' '\\n' | grep -c .)`,
    `kwriteconfig6 --file ${file} --group General --key count "$COUNT"`,
    KWIN_RECONF,
    `echo fcm-rule-installed`,
  );
  return lines.join('\n');
}

// Removal script (for uninstall). Strips ALL FCM-authored rules (current named + any stale
// numbered ones from older builds) from kwinrulesrc, leaving the user's own rules intact, and
// reconfigures KWin so the change takes effect live (e.g. FO76 is no longer force-demoted from
// fullscreen). Pure → unit-testable. Prints fcm-rules-removed (or fcm-no-rules if none found).
function buildKwinRemoveRulesScript({ file = 'kwinrulesrc' } = {}) {
  return [
    ...kwinPartitionSnippet(file),
    `if [ -z "$FCM" ]; then echo fcm-no-rules; exit 0; fi`,
    // Remove the FCM sections entirely (awk-strip — kwriteconfig6 can't delete a section).
    ...awkStripFcmSectionLines(),
    // rules = only the preserved (non-FCM) rules; count = its length (0 if none).
    `kwriteconfig6 --file ${file} --group General --key rules "$KEEP"`,
    `COUNT=$(printf '%s' "$KEEP" | tr ',' '\\n' | grep -c .)`,
    `kwriteconfig6 --file ${file} --group General --key count "$COUNT"`,
    KWIN_RECONF,
    `echo fcm-rules-removed`,
  ].join('\n');
}

// Decide whether the overlay must relaunch itself to force the XWayland Ozone backend.
// Electron 38+ reads --ozone-platform from the REAL argv during early bootstrap (before
// main.js), so appendSwitch is too late — only an argv flag works. Pure so the decision
// is unit-testable. Returns null when no relaunch is needed, else the app.relaunch()
// options { args, [execPath] }:
//   • kdeWayland=false                       → null (other setups already work on X11/GNOME)
//   • flag already on argv                   → null (this IS the relaunched X11 process)
//   • else → { args: argv.slice(1) + flag, execPath: appImagePath when set }
// appImagePath is process.env.APPIMAGE — on AppImage builds process.execPath is the
// transient /tmp/.mount_* path (gone after exit), so relaunch must target $APPIMAGE.
// ─── HTTP proxy header filter ─────────────────────────────────────────────────
// The renderer's shimmed fetch supplies headers that the main process forwards to
// the relay. We must NOT blindly spread them: the renderer could override
// X-Auth-Token (session hijack), inject Host / Transfer-Encoding / Content-Length
// (request smuggling), or embed CRLF sequences (header injection). Instead we
// whitelist the small set of headers the ChatOverlay component legitimately sends
// and strip everything else. The caller then overlays the auth/UA/Origin headers
// on top of the filtered result, so those are always main-process-controlled.
const PROXY_HEADER_ALLOWLIST = new Set([
  'content-type',
  'accept',
  'accept-language',
  'cache-control',
  'x-requested-with',
]);

function filterProxyHeaders(rendererHeaders) {
  if (!rendererHeaders || typeof rendererHeaders !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(rendererHeaders)) {
    const lower = k.toLowerCase();
    if (!PROXY_HEADER_ALLOWLIST.has(lower)) continue;
    // Strip CR/LF (header injection) plus any other control chars Node's HTTP
    // layer rejects (\0, \v, \f, DEL, …) — keep tab + printable/high bytes only.
    // Sanitising rather than only stripping CRLF avoids a renderer-triggered
    // ERR_INVALID_CHAR throw on the outbound request.
    const safe = String(v).replace(/[^\t\x20-\x7e\x80-\xff]/g, '');
    if (safe) out[lower] = safe;
  }
  return out;
}

// ─── HTTP proxy URL guard (SSRF) ──────────────────────────────────────────────
// The renderer also controls the request *path*. Building the outbound URL by
// string concatenation (`relayHttp + reqPath`) let a hostile renderer redirect
// the request to another host — e.g. `@evil.com/api` or `//evil.com/api` parse
// into a different authority — and since the main process attaches X-Auth-Token,
// that leaks the session token to the attacker. Resolve reqPath strictly against
// the relay base and reject anything that lands on a different origin. Returns a
// URL pinned to the relay, or null to refuse the request.
function resolveRelayProxyUrl(reqPath, relayHttp) {
  let base;
  try { base = new URL(relayHttp); } catch { return null; }
  let url;
  try { url = new URL(reqPath, base); } catch { return null; }
  if (url.origin !== base.origin) return null;
  return url;
}

function planOzoneRelaunch({ kdeWayland, argv = [], appImagePath = null, execPath = null } = {}) {
  const FLAG = '--ozone-platform=x11';
  if (!kdeWayland) return null;
  if (argv.includes(FLAG)) return null;
  // The binary the child would re-exec: the persistent $APPIMAGE when known, else the
  // current process's execPath.
  const effectiveExec = appImagePath || execPath || null;
  // Re-exec is UNSAFE when the only available binary is a transient AppImage FUSE mount
  // (/tmp/.mount_*) AND $APPIMAGE is unset: app.exit(0) unmounts it before the child can
  // start, so the child vanishes — the "launches once, then the shortcut does nothing"
  // failure (issue #272). When unsafe, the caller must NOT exit; staying on native
  // Wayland (degraded stacking) beats disappearing entirely.
  const isTransientMount = !!effectiveExec && /\/\.mount_[^/]*\//.test(effectiveExec);
  const safe = !!appImagePath || !isTransientMount;
  const opts = {
    args: argv.slice(1).concat(FLAG),
    // Belt-and-suspenders alongside the argv flag: the env var also forces XWayland,
    // in case a launcher (AppImageLauncher, a wrapper .desktop) mangles argv.
    env: { ELECTRON_OZONE_PLATFORM_HINT: 'x11' },
    safe,
  };
  if (appImagePath) opts.execPath = appImagePath;
  return opts;
}

// Compare two semver-like version strings. Returns a positive number when `a` is
// newer than `b`, negative when `a` is older, and 0 when they are equal.
// Uses locale-aware numeric comparison so '1.3.10' > '1.3.9' (not string-ordered).
// Malformed / non-string inputs are treated as '0.0.0' — they will never appear
// newer than any real version.
function cmpVersions(a, b) {
  const normalize = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '0.0.0');
  return normalize(a).localeCompare(normalize(b), undefined, { numeric: true, sensitivity: 'base' });
}

// True when the relay URL points at a LOCAL backend (localhost / loopback). Used
// to gate dev-only behavior so it can NEVER affect a production or hosted-dev
// build (which target falloutchatmod.com / dev.falloutchatmod.com).
function isLocalRelay(relayHttp) {
  try {
    const h = new URL(String(relayHttp)).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

// DEV-ONLY: derive a deterministic, per-install synthetic Discord id (18 digits,
// matches the backend's /^\d{15,22}$/) from the installToken. Lets a local dev
// overlay satisfy the backend's Discord-link gate on POST /api/users without
// real Discord OAuth. discordId is @unique in the DB, so deriving it from the
// (unique) installToken keeps each local install collision-free and stable.
function syntheticDevDiscordId(installToken) {
  const hex = String(installToken || '').replace(/[^0-9a-f]/gi, '');
  let dec;
  try {
    dec = hex ? BigInt('0x' + hex).toString() : '0';
  } catch {
    dec = '0';
  }
  return '9' + dec.slice(-17).padStart(17, '0'); // always an 18-digit string
}

// NOTE: the in-game cursor lock is applied via protontricks' `grabfullscreen=y` verb
// (installer + tray, see main.js applyFo76Grab) — no user.reg editing — so the former
// buildFo76GrabUserReg / fo76UserRegCandidates / fo76GrabStatus helpers were removed.

module.exports = {
  DEFAULT_APP_CLIENT_KEY,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  PRIVILEGED_ROLES,
  GAME_PROCESSES,
  XWAYLAND_GAME_CLASSES,
  isGameProcess,
  isGameClass,
  isUnknownForegroundClass,
  shouldRegisterShortcuts,
  decideForegroundPollerAction,
  nextPollerBackoffMs,
  isForegroundStale,
  classifyPollerExit,
  resolveLogLevel,
  shouldRotateLog,
  stateHasRealData,
  isCfChallenge,
  isSinglePrintableChar,
  resolveAppClientKey,
  resolveAppVersion,
  isPrivilegedRole,
  canShowOverlay,
  clampToWorkArea,
  MODAL_FIT_WIDTH,
  MODAL_FIT_HEIGHT,
  modalFitBounds,
  buildKeybindMap,
  accelToAction,
  visibilityDecision,
  emitVisibilityDecision,
  desiredTopmost,
  shouldForceGameBelow,
  nextPresenceState,
  shouldHidePanelInGame,
  buildPanelHidingSaveScript,
  parsePanelHidingSave,
  buildPanelHidingSetScript,
  buildPanelHidingRestoreScript,
  resolveRelayUrls,
  classifyInputGrab,
  buildKwinKeepAboveScript,
  buildKwinRemoveRulesScript,
  planOzoneRelaunch,
  cmpVersions,
  isLocalRelay,
  syntheticDevDiscordId,
  filterProxyHeaders,
  resolveRelayProxyUrl,
};
