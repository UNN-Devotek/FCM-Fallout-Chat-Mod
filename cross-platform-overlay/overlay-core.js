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
//   • 503 → always a CF challenge page.
//   • 403 with cf-mitigated header OR text/html body OR cf-browser-verification
//     in the body → CF challenge/WAF block.
//   • 403 with JSON body → legitimate backend 403, not CF.
function isCfChallenge(statusCode, resHeaders, body) {
  if (statusCode === 503) return true;
  if (statusCode === 403) {
    if (resHeaders && resHeaders['cf-mitigated']) return true;
    const ct = (resHeaders && (resHeaders['content-type'] || '')) || '';
    if (ct.includes('text/html')) return true;
    if (typeof body === 'string' && body.includes('cf-browser-verification')) return true;
    return false;
  }
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

// Read the baked relay target (build.extraMetadata.fcmRelay merged into the
// shipped package.json by electron-builder) for dev/test packages. Returns the
// { relayHttp, relayWs } object or null. Read via fs (same pattern as
// resolveAppVersion) rather than a relative require of the local package.json so
// build-files.test.js does not flag it as a missing build.files entry. null in
// dev (no merge) and in prod builds (no extraMetadata) -> falls through to prod.
function resolveBakedRelay(fs, dir, path) {
  // eslint-disable-next-line global-require
  path = path || require('path');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return (pkg && pkg.fcmRelay) || null;
  } catch { return null; }
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
// windowFocused, foregroundIsGame }. Returns true when the overlay should be
// always-on-top. No window → false. Precedence: forceVisible → gameRunning →
// windowFocused → game is the foreground process.
function desiredTopmost(state) {
  state = state || {};
  if (!state.hasWindow) return false;
  if (state.forceVisible) return true;
  if (state.gameRunning) return true;
  if (state.windowFocused) return true;
  return state.foregroundIsGame === true;
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
    gameActive = isGameClass(foregroundProc);
  } else {
    // Fallback: no reliable foreground API — treat "game running" as "game active".
    // This matches the pre-kdotool Linux behavior exactly (no regression).
    gameActive = !!gameRunning;
  }
  return gameActive || !!overlayFocused;
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
// Baked override (dev/test packages — see build.extraMetadata.fcmRelay):
//   A packaged build can bake a relay target into package.json (electron-builder
//   `extraMetadata.fcmRelay`) so a dev/test installer points at e.g.
//   https://dev.falloutchatmod.com without the user setting any env var. main.js
//   passes that object as `baked`. Precedence: env override > baked > prod default.
//   A normal/prod build bakes nothing, so it is byte-for-byte the prod default.
//
// Production (default — no env override, no bake):
//   relayHttp = 'https://falloutchatmod.com'
//   relayWs   = 'wss://falloutchatmod.com/ws'
function resolveRelayUrls(env, baked) {
  const b = baked || {};
  return {
    relayHttp: env.RELAY_HTTP || b.relayHttp || 'https://falloutchatmod.com',
    relayWs:   env.RELAY_WS   || b.relayWs   || 'wss://falloutchatmod.com/ws',
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
//   • "keep above" on the OVERLAY (wmclass=fallout, title="Fallout Chat Mod"): above=true.
//     (The `layer=8`/`layerrule=2` CriticalNotification force that older KWin honored is
//     IGNORED by KWin 6, so keep-above ALONE loses to a focused fullscreen game.)
//   • "demote game" on the GAME (wmclass=steam_app_1151340): fullscreen=false (Force).
//     This stops KWin promoting the focused game to the active-fullscreen layer (6), so the
//     overlay's keep-above (4) wins even while you're playing. THIS is the rule that fixes
//     "overlay drops under when I click the game".
//
// FORMAT (KWin 6, also verified): the authoritative rule list is [General] `rules=` — a
// COMMA-SEPARATED list of group NAMES — plus a matching `count`. Writing numbered groups +
// only `count` is NOT enough (KWin rewrites count and drops the rules). We use STABLE NAMED
// groups (fcm-keepabove / fcm-game-demote).
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

// Install (clean + apply) script. Removes any stale FCM rules, then writes the two current
// named rules, preserving the user's own rules. Idempotent: if the active FCM rules are
// already EXACTLY our two current named groups, it prints fcm-rule-present and skips the
// reconfigure (so startup doesn't flash KWin on every launch).
function buildKwinKeepAboveScript({ file = 'kwinrulesrc', title = 'Fallout Chat Mod', overlayWmclass = 'fallout', gameWmclass = 'steam_app_1151340' } = {}) {
  const ABOVE = 'fcm-keepabove';      // stable group name (overlay keep-above rule)
  const DEMOTE = 'fcm-game-demote';   // stable group name (game fullscreen-demote rule)
  const w = (grp, key, val) => `kwriteconfig6 --file ${file} --group ${grp} --key ${key} ${val}`;
  return [
    ...kwinPartitionSnippet(file),
    // Idempotency: already exactly our two current named rules (nothing stale) → skip.
    `N=$(printf '%s' "$FCM" | tr ' ' '\\n' | grep -c .)`,
    `case " $FCM " in *" ${ABOVE} "*) A=1 ;; *) A=0 ;; esac`,
    `case " $FCM " in *" ${DEMOTE} "*) D=1 ;; *) D=0 ;; esac`,
    `if [ "$N" = "2" ] && [ "$A" = "1" ] && [ "$D" = "1" ]; then echo fcm-rule-present; exit 0; fi`,
    // Clear stale FCM groups (old numbered/named) so they don't linger as orphaned sections —
    // awk-strip them (kwriteconfig6 can't delete a section). We then re-write our two fresh below.
    ...awkStripFcmSectionLines(),
    // Overlay keep-above rule.
    w(ABOVE, 'Description', `"Fallout Chat Mod - keep above games"`),
    w(ABOVE, 'title', `"${title}"`),
    w(ABOVE, 'titlematch', '2'),
    w(ABOVE, 'wmclass', `"${overlayWmclass}"`),
    w(ABOVE, 'wmclassmatch', '2'),
    w(ABOVE, 'wmclasscomplete', 'false'),
    w(ABOVE, 'above', 'true'),
    w(ABOVE, 'aboverule', '3'),
    // Game fullscreen-demote rule (the one that actually keeps us above the focused game).
    w(DEMOTE, 'Description', `"Fallout Chat Mod - demote game from fullscreen layer"`),
    w(DEMOTE, 'wmclass', `"${gameWmclass}"`),
    w(DEMOTE, 'wmclassmatch', '2'),
    w(DEMOTE, 'wmclasscomplete', 'false'),
    w(DEMOTE, 'fullscreen', 'false'),
    w(DEMOTE, 'fullscreenrule', '2'),
    // rules = preserved user rules + our two; count = its length.
    `NEWR="\${KEEP:+$KEEP,}${ABOVE},${DEMOTE}"`,
    `kwriteconfig6 --file ${file} --group General --key rules "$NEWR"`,
    `COUNT=$(printf '%s' "$NEWR" | tr ',' '\\n' | grep -c .)`,
    `kwriteconfig6 --file ${file} --group General --key count "$COUNT"`,
    KWIN_RECONF,
    `echo fcm-rule-installed`,
  ].join('\n');
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

function planOzoneRelaunch({ kdeWayland, argv = [], appImagePath = null } = {}) {
  const FLAG = '--ozone-platform=x11';
  if (!kdeWayland) return null;
  if (argv.includes(FLAG)) return null;
  const opts = { args: argv.slice(1).concat(FLAG) };
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
  shouldRegisterShortcuts,
  stateHasRealData,
  isCfChallenge,
  isSinglePrintableChar,
  resolveAppClientKey,
  resolveAppVersion,
  isPrivilegedRole,
  canShowOverlay,
  clampToWorkArea,
  buildKeybindMap,
  accelToAction,
  visibilityDecision,
  emitVisibilityDecision,
  desiredTopmost,
  resolveRelayUrls,
  resolveBakedRelay,
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
