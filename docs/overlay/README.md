# Electron Overlay — Overview

Header actions and online counts: [header controls](header-controls.md).

Desktop shortcut: `/s message` sends to the currently backend-confirmed Server
room without changing the selected tab. It uses the normal authorized bridge send
path; unavailable/offline Server chat preserves the draft and reports an error,
never queues for later or falls back to General. `/s` alone sends nothing.

Idle auto-hide defaults **off** for new profiles. If enabled without a saved mode,
it defaults to **sub-tabs collapse**, retaining the header and channel rows.
Explicit existing preferences remain unchanged. Full auto-hide remains an opt-in
mode that hides all renderer layers, including portaled content; collapsed mode
suppresses the full-window dim/scanline layers, including the shared dashboard's
`body::before` vignette and `body::after` scanlines, to avoid a residual rectangle.
The isolated Electron `test:interaction` suite exercises three collapse/expand
cycles in each mode, asserting header/sub-tab visibility, hidden effect layers,
and a visible writable composer after expansion. This is desktop-renderer
coverage, not Windows game-focus or multi-monitor acceptance.

Position presets capture the chat's pre-modal size, not the temporary settings
panel enlargement, while keeping the live x/y position. Resize gestures still
read live geometry. Previously overwritten presets must be recaptured; their
original dimensions cannot be reconstructed from the saved enlarged rectangle.

Focus recovery: every explicit Open Chat/Insert focus request first reveals the
renderer, independently of the native window's collapse flag. Portable builds
honor user-enabled idle collapse while the game is running, exactly like installed
builds. The former portable-only suppression sent `force-expand` after every
collapse, causing a repeating blink; it is removed. Regression coverage is
`cross-platform-overlay/__tests__/focus-collapse-recovery.test.js` (repeated
requests and both idle-hide modes), included in the overlay unit suite. Electron
interaction tests also inspect pseudo-element visibility and delayed wake-up. Native
Windows collapse → Insert → send → return-to-game acceptance remains required
before treating a packaged build as verified.

AutoHide candidate verification (2026-09-18): 1,237 overlay unit tests and the
complete isolated Electron interaction suite passed. The new tests reproduced
the portable forced-wake and visible body pseudo-element failures before fixes.
Windows portable 1.4.0 was built natively and installed on the laptop with an
exact-file/profile backup; installed EXE SHA-256 is
`e8470771ac39d1947555d6e7738159658abec39754919f0042617b0ea88bfcf0`.
Fresh native logs show full-hide reaching 1 DIP without the suppression loop;
later wake triggers are not logged and still require user acceptance. The desktop
Downloads portable ZIP was updated with checksums and no private profile data.
No backend/HUD change or public release is part of this candidate.

Follow-up animation/scroll correction: visible collapse now uses a 240 ms
compositor clip and full-hide uses a whole-body fade, before native resizing.
Delayed completion is cancelled on wake, including focus during expansion.
Scroll intent is tracked from input rather than resize-generated scroll events;
saved-size changes keep bottom-follow, while intentional history reading remains
unpinned. The test relay covers sending two messages large, shrinking, and seeing
the newest without Insert. See [window management](window-management.md#idle-collapse-auto-hide-to-header-strip)
for tests and the isolated Windows packaged-executable runner.

Follow-up verification (2026-09-18): 1,241 overlay and 443 dashboard unit tests
pass, with TypeScript checks and the complete Linux Electron interaction suite.
The Windows isolated portable run verifies the send-then-shrink sequence, repeated
size switching, retained reading intent and visible compositor transitions.
Measured Windows collapse samples contain 8–19 intermediate clip states; full
hide contains 40–49 intermediate opacity samples across three cycles. These are
sampled transition states, not a claim of guaranteed frame rate under arbitrary
load. The animation fixture settles settings before measuring idle collapse;
concurrent settings redraw/build load is not an idle-frame-rate benchmark.
Release CI and manual live-game visual/focus acceptance remain separate gates.

Final isolated interaction runs passed on Linux at `2026-09-18T08:02:17Z` and
native Windows at `2026-09-18T08:03:16Z`, with no renderer exceptions. Both include
ten reconnects, restart persistence, font/window sizes and hidden-message recovery.
The latest local laptop candidate supersedes the earlier AutoHide binary above:
portable 1.4.0, 101,301,701 bytes, SHA-256
`8ae62abf5d741160d81331d717288170efccc0df8730d51b0e3412646576cad4`.
It was installed with an EXE/profile backup and launched; fresh logs confirm
successful authenticated relay registration and running-game detection. Install
identity and settings match the backup. The desktop Downloads ZIP now contains
this binary (ZIP SHA-256
`80bfd8442cb6e72c99d5fa91a74a4b5e674f7f366d910515529e94bf366682a3`),
unchanged optional bridge/docs, updated checksums, and no private profile data.
Test profiles/relays and temporary build/test/launch scheduled tasks were torn
down. No public release, backend deployment, commit or push was performed.

Channel controls and review status: [sub-tab customization and bridge safety](subtab-customization-and-bridge-review.md).

Performance work: [idle renderer performance spec](idle-renderer-performance-spec.md)
defines the desktop CPU investigation, draft budgets and regression gates.
[Windows focus-return performance](windows-focus-performance.md) covers the reusable
helper and opt-in bounded local CPU/bridge-read capture for portable and installed builds.
The [implementation and profiling results](idle-renderer-performance-results.md) distinguish
verified local regressions from pending native performance acceptance.

Fallout Chat Mod ships a transparent, frameless Electron application (`cross-platform-overlay/`) that renders the community chat overlay above Fallout 76 on Windows and Linux. It is built and maintained as a standalone package that mounts the **same** React component the website uses.

---

## Repository layout

```
cross-platform-overlay/
├── main.js          — Electron main process: window creation, game detection,
│                       keybinds, IPC handlers, HTTP/WS proxy, update notification
├── preload.js       — contextBridge: exposes a safe `window.electronAPI` surface
│                       to the renderer; no nodeIntegration in the renderer
├── src/
│   ├── main.tsx     — Renderer entry: mounts ChatOverlay with required React providers
│   ├── shell.ts     — ShellSettings model + defaults; idle-collapse logic; settings parity
│   ├── supporterAppearance.ts — Settings → Appearance cosmetics editor; reads the signed-in overlay account only
│   ├── bridge.ts    — Renderer-side shims: patches global fetch + WebSocket to route
│   │                   through IPC proxy; sets window.__FCM_OVERLAY_SHELL__ flag
│   └── onboarding.ts — Onboarding UI (Discord/Steam link, theme, identity) and completion IPC
├── assets/          — App icons (fcm.ico, fcm-linux.png, fcm.icns) + KWin rule
└── vite.config.ts   — @dashboard alias → ../admin-dashboard/src; dedupes React/TanStack
```

---

## What the app does

The Electron shell provides everything the web `ChatOverlay.tsx` component does not:

- **Window chrome** — transparent/frameless BrowserWindow, drag strip, tray icon, min/close buttons
- **Game-process detection** — the existing Windows foreground helper checks a process-only OS metadata snapshot every 2.5 seconds for `Fallout76.exe` / `Project76_GamePass.exe`; bounded `tasklist` fallback remains for startup or unavailable/stale helpers. Linux uses `ps -A`. Existing launch/exit hysteresis still controls automatic visibility; no game memory is read.
- **Experimental contained portable mode** — explicit portable builds keep FCM-owned durable state beside the artifact under `FCMData/`, while retaining normal process-triggered visibility. This dev-relay experiment neither imports installed state nor registers auto-start; see [building.md](building.md#fully-contained-portable-experiment).
- **Global hotkeys** — navigation-cluster keys (Insert, Delete, End, PageUp/Down, Home, `\`, `/`) intercepted before the game receives them
- **Click-through** — `setIgnoreMouseEvents` so clicks pass through to the game behind
- **Update notification** — passive OS toast (Windows / Linux libnotify / macOS) when a newer version is available; version delivered over the chat WebSocket (`app:update-available`); downloads/installs nothing; clicking opens Nexus Mods for a manual download. See `auto-update.md`.
- **HTTP + WebSocket proxy** — shimmed `fetch`/`WebSocket` in the renderer route through IPC so the main process can inject `X-Auth-Token` (browsers cannot set WS headers). Renderer-supplied HTTP headers are **allowlisted** before forwarding (`filterProxyHeaders` in `overlay-core.js`: only `content-type`, `accept`, `accept-language`, `cache-control`, `x-requested-with`, with CRLF stripped); the main process then sets `X-Auth-Token`/`User-Agent`/`Origin` *after* filtering, so a compromised renderer cannot override the auth headers or inject others. The renderer-supplied request **path** is likewise resolved strictly against the relay origin (`resolveRelayProxyUrl`) and refused if it points anywhere else, so it cannot redirect the request — and the attached `X-Auth-Token` — to another host. Every proxied HTTP request has a 15-second deadline: a stalled relay becomes an error rather than leaving a settings control in a permanent saving state. Cookies are never forwarded, so staff menu actions (kick, mute, unmute, message delete, View Profile) rely on backend routes gated by `requireStaffRole`, which accepts the token for staff ([../backend/auth.md](../backend/auth.md)).
- **Provider sign-in** — first-run onboarding, the login wall, and Settings can open the server-verified Steam OpenID link flow; Discord remains available alongside it. The Electron main process never receives or trusts a Steam ID from the renderer. After the browser callback binds the install token, the overlay polls status, re-registers, and opens the authenticated chat session.
- **In-game cursor lock (Linux, opt-in)** — tray → "Fix FO76 cursor lock (Wayland)" runs `protontricks` to set FO76's own Wine `GrabFullscreen`/`GrabPointer` registry values **on demand**, only when the user presses it (FO76 must be closed). After FO76 exits, a read-only check of the prefix can show a one-time system notification whose click runs that same tray action. See below and [linux-overlay-approaches.md](linux-overlay-approaches.md).

**No game-memory reading, no game-file modification, no code injection, no network/port scanning.** The only game interaction is a process-name check (`Fallout76.exe`) to drive show/hide. This includes Fallout 76's Proton/Wine prefix — the overlay never writes to it **automatically** (not on install, not on launch, not from the one-time detection nudge); it offers an **explicit, user-initiated action** (tray item, or a click on the post-exit notification) that applies the community-standard `protontricks` setting **on demand** — a Wine/Proton compatibility-layer setting, not a game-file modification (see [linux-overlay-approaches.md](linux-overlay-approaches.md)).

---

## Privacy — no telemetry

Fallout Chat Mod does not collect telemetry or performance data from the app or its users. The desktop overlay only checks whether the `Fallout76` process is running (to show/hide the overlay); it does not read game state and reports nothing about your device or usage.

---

## The single shared component

`src/main.tsx` imports the chat overlay directly from the dashboard tree:

```ts
import ChatOverlay from '@dashboard/features/chat/ChatOverlay';
import '@dashboard/index.css';
```

The `@dashboard` alias in `vite.config.ts` resolves to `../admin-dashboard/src`. The component runs unmodified, wrapped in the same React providers the dashboard gives it (`QueryClientProvider`, `MemoryRouter`, outlet context). Any change to `ChatOverlay.tsx` is automatically reflected in the Electron overlay.

The global `window.__FCM_OVERLAY_SHELL__` (set in `bridge.ts`) gates desktop-only header chrome (refresh/min/close icons, amber main-tab style). On the website that global is absent, so the header keeps its original appearance.

## Provider sign-in and HUD linking

The overlay requires a verified Discord or Steam provider before the backend issues its
install session. On a fresh install, the login wall and first-run onboarding expose both
options. **LINK STEAM** opens `/auth/steam/link?installToken=<uuid>`; the backend validates
Steam's OpenID assertion server-side, checks the provider deny-list, and binds the verified
SteamID64 to the FCM account. Returning to the overlay triggers a status poll and session
re-registration automatically; **REFRESH STATUS** is available if the external browser was
used.

The optional `.ba2` HUD track remains separate from this desktop overlay. To link it, the user
opens the website `/link`, signs in with Discord, Nexus, or Steam, and redeems the device code
shown by the HUD mod. Steam-only users receive basic chat access; dashboard and in-game
moderation roles remain Discord-role gated.

Unlinking Discord from Overlay Settings is a server-side account action, not just a local
display reset. The backend clears the Discord identity, revokes the active overlay session,
evicts live relay connections, and returns the overlay to its Steam/Discord provider login
wall. The FCM account and its Discord-keyed entitlements are retained.

Settings also exposes Steam unlink. When Discord (or another provider) remains linked, Steam is
removed without interrupting the session. When Steam is the last provider, the backend revokes
the session and the overlay returns to the provider login wall.

## Font selection

**Settings → Appearance → Font** selects Theme default, System sans, Arial,
Verdana, or Monospace, with a sample preview. The picker supports arrow keys,
Home/End, Enter/Space and Escape. Explicit choices survive color-theme changes;
Theme default preserves the previous theme typography. Fonts use local system
stacks with Linux fallbacks, without downloading font files.

The validated `fontId` setting is saved in shell/browser settings and the native
`overlay-state.json` mirror. Missing or invalid values resolve to Theme default.
Changes apply to the shared chat, composer, tabs, footer and shell controls without
remounting chat, replacing its socket or clearing the draft. The existing Scale
control remains the single Electron zoom multiplier. Deliberate fixed-width
wiki labels and launch-code digits retain their formatting.

## Chat appearance in Settings

**Settings → Appearance → Chat appearance** is the desktop equivalent of Profile →
**Chat appearance** and the Discord `/cosmetics` command. It loads the catalog and the
signed-in account's active Discord tier through the overlay's install-token proxy; it
does not accept a user id from the renderer. Free swatches remain usable by everyone,
while Supporter and Overseer's Circle choices stay visible but locked until the matching
Discord role is active. The supporter marker is always a `★`, with its colour chosen
independently from the username colour. Colour and tag render in the in-game HUD; visual
effects are labelled desktop-only because the HUD implements solid colors and tags, not those
animated effects. This is an FCM feature boundary, not a universal Scaleform limitation.
The name- and star-colour pickers each provide a consistently sized **Reset to default**
button beneath their swatches; the same controls are available on the website profile.
Selecting a value updates the local preview immediately. The save then replaces that preview
with the server-authoritative result; transient network/server failures retry a bounded number
of times, while validation or entitlement errors roll the preview back and release the busy
state with an actionable message. Discord role presentation is queued separately, so a slow
Discord API cannot leave the settings panel waiting after the FCM appearance is saved.

Discord link and relink attempts use a fresh, non-cacheable OAuth start URL so a browser
cannot replay consumed CSRF state. On successful linking, the backend downloads the current
Discord avatar into MinIO (`avatars/<discordId>.png`); the Identity card prefers the
same-origin `/avatars/<discordId>` route and falls back to the Discord CDN or initials.

Full auto-hide also hides the renderer's dim and scanline layers. Its transparent one-pixel
edge remains pointer-active so moving the mouse over it restores the overlay.

---

## Z-order requirement

The overlay window uses `setAlwaysOnTop(true, 'screen-saver')` — the highest standard level — and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. This only works reliably when Fallout 76 runs in **Windowed Borderless** mode. Exclusive Fullscreen gives the game exclusive GPU output; no window on any OS can render above it.

On **KDE Plasma (Wayland)** the overlay forces the XWayland backend and one KWin rule, installed automatically while FO76 runs and the overlay shares its display. See below and **[window-management.md](window-management.md#kde-plasma--wayland--keep-above-the-game-kwin-layer-rule)** for the full mechanism.

---

## Linux / Proton — Z-order by compositor

### KDE Plasma (Wayland) — automatic

On KDE+Wayland the overlay configures itself on first launch — **no manual steps**. It:

1. **Forces the XWayland Ozone backend** via a one-time argv relaunch (`--ozone-platform=x11`) — `appendSwitch` is too late on Electron 39, so it re-execs once with the flag. Without XWayland the overlay can't stack over the game *and* breaks KWin direct scanout (game lag). See [window-management.md](window-management.md).
2. **Installs one KWin rule while FO76 runs and the overlay shares its display** (removed on game exit or a monitor change), into `~/.config/kwinrulesrc` (`setupKdeKeepAbove` → `overlayCore.buildKwinKeepAboveScript`, then `qdbus org.kde.KWin /KWin reconfigure`):
   - `fcm-keepabove` — on the overlay (`wmclass=fallout-chat-mod`), combining `above=true` (keeps it above other windows) with a force-Layer `layer=overlay`/`layerrule=2` property, which is what actually keeps the overlay on top of a **focused fullscreen** FO76 **while you play** (KWin 6's sanctioned "stay above fullscreen" mechanism, KDE Bug 441074). The game itself is never demoted — FO76 keeps its normal fullscreen stacking above the panel.

The install is idempotent and self-healing (cleans stale FCM rules from older builds, preserves the user's own rules). **Uninstalling removes the rule** (`buildKwinRemoveRulesScript` / `Packaging/linux/uninstall.sh`), restoring FO76's fullscreen stacking.

**Fallback** if the auto-apply couldn't run: import `~/.config/Fallout Chat Mod/fallout-chatmod-keepabove.kwinrule` via System Settings → Window Rules → Import, then `qdbus org.kde.KWin /KWin reconfigure`.

**Run FO76 in Windowed Borderless** — Exclusive Fullscreen blocks any overlay on any OS. **Do NOT** run the game inside **gamescope** — its nested compositor isolates the game and the overlay cannot render over it.

### Hyprland — automatic (pin-based, unverified on hardware)

On Hyprland the overlay configures itself: `hyprctl activewindow -j` for focus, `hyprctl clients -j` for the same-output probe, and `hyprctl dispatch pin address:<addr>` to keep the overlay above the workspace while FO76 runs on the same display (un-pin otherwise). **Not verified on real Hyprland hardware.** No machine was available to confirm that `pin` beats a fullscreen Proton game the way KWin's Force-Layer rule was empirically confirmed to. The Linux z-order heartbeat (`setAlwaysOnTop`) stays active under Hyprland as a fallback until that is verified. Missing `hyprctl` logs a diagnostic and no-ops.

### GNOME / non-KDE compositors — conditional Steam launch option

On GNOME or other non-KDE compositors, if the overlay won't stay on top, set this Steam Launch Option for Fallout 76 (**Steam → Fallout 76 → Properties → General → Launch Options**):

```
PROTON_NO_WM_DECORATION=1 %command%
```

This strips Proton's window decoration so the desktop compositor can composit the overlay above the game window normally.

> **KDE Plasma users must NOT set this.** On KDE, `PROTON_NO_WM_DECORATION=1` is not needed and has been confirmed to push the overlay *behind* the game. Use the KWin rule instead.

**Windowed Borderless is still required.** `PROTON_NO_WM_DECORATION` removes window chrome but does not override Exclusive Fullscreen. FO76 must run in **Windowed Borderless** mode on all compositors.

On a **plain X11** session (any window manager, not Wayland/GNOME), installing `xdotool` now gives the same hide-on-alt-tab and hotkey-release behavior KDE-Wayland users get. `PROTON_NO_WM_DECORATION` is a stacking workaround only; it is unrelated to focus detection.

Both requirements are documented on the install page (SYSTEM → INSTALL).

---

## WSLg limitation

WSLg runs Electron inside a sandboxed Wayland/X server isolated from the real Windows desktop. Inside WSLg:

- Global hotkeys are not delivered (the Windows desktop owns Insert/Delete/etc.)
- Click-through has no effect over a real game window
- Always-on-top over a fullscreen game does not apply

These features are correctly wired and light up on native Windows builds or native Linux X11 desktops. Use the tray menu and in-renderer `−` / `✕` strip for WSLg testing.

---

## QA build channel

The overlay ships in two build channels: `stable` (the default production build) and `qa`
(a special dev-only build for QA testers connecting to `dev.falloutchatmod.com`).

### Building the QA artifact

```bash
cd cross-platform-overlay
npm run dist:qa
```

`dist:qa` runs `scripts/build-qa.mjs`, which:

- Computes a **unique per-build version** `<base>-qa.<UTC-timestamp>` (e.g.
  `1.3.91-qa.20260626014530`) so the golden-build lock can tell a fresh build from a
  retired one (the lock matches the version string exactly — without a unique stamp,
  rebuilding the same `package.json` version could not retire the old build).
- Injects that version into BOTH the renderer (`FCM_BUILD_VERSION` -> `__APP_VERSION__`)
  and the packaged app (`-c.extraMetadata.version` -> the packed `package.json`, which
  `main.js` reads and sends as the `x-client-version` header the lock checks).
- Sets `BUILD_CHANNEL=qa` (renderer `__BUILD_CHANNEL__`) and `-c.extraMetadata.fcmChannel=qa`
  (packed `package.json`), and names the app `Fallout Chat Mod QA`.

On completion it prints the line to bless the build, e.g.
`QA_ACTIVE_VERSION=1.3.91-qa.20260626014530` — set that on the dev backend (env or
`POST /api/admin/qa/active-version`) to make this build the active golden build.

An explicit `FCM_BUILD_VERSION` overrides the auto-stamp — use it to pin ONE version
across a coordinated Linux + Windows golden release (so a single `QA_ACTIVE_VERSION`
admits both), or to match an already-blessed lock value:

```bash
FCM_BUILD_VERSION=1.3.91-qa.20260626 npm run dist:qa
```

**Windows QA build:** run the **Build Windows QA** workflow (`.github/workflows/build-windows-qa.yml`,
`workflow_dispatch`, owner-only) on the self-hosted `[self-hosted, windows, unn]` runner —
it runs `dist:qa` and uploads the unsigned NSIS + portable `.exe` as a workflow artifact.
Its optional `version` input maps to `FCM_BUILD_VERSION` (pin it to match the active lock).
Wine cannot build Electron 31+ on Linux, so Windows QA builds use the runner.

### Runtime channel detection

The main process reads the channel at startup:

```js
const BUILD_CHANNEL = (() => {
  try { return require('./package.json').fcmChannel || process.env.BUILD_CHANNEL || 'stable'; }
  catch { return process.env.BUILD_CHANNEL || 'stable'; }
})();
```

When `BUILD_CHANNEL === 'qa'` the overlay resolves relay URLs to the dev backend
(`dev.falloutchatmod.com`) instead of production.

### QA login flow

A `qa`-channel build does not use the standard Discord OAuth link flow. Instead, it
presents an in-app "QA Login" button that:

1. Opens `/auth/discord/qa/start` in the operating system's default browser (on the dev
   backend). Discord authentication is never embedded in an Electron `BrowserWindow`, so the
   browser can reuse the user's existing Discord login and passkey session.
2. The user completes Discord OAuth; the dev backend verifies they hold the `DEV_QA_ROLE_ID`
   role in the dev guild and stores a one-time session grant in Redis.
3. The overlay polls `GET /api/auth/qa-status/:installToken` (with
   `X-Client-Version: <version>`) until the backend returns an `authorized: true`
   response with a session token.
4. If the backend returns HTTP 426 (`OUTDATED_BUILD`), the build version does not match
   the active QA version and the overlay shows an update prompt instead of completing login.

The standard Discord link/relink flow follows the same external-browser rule. Because its OAuth
state is bound to the install token on the backend, the overlay polls link status for up to the
state's five-minute lifetime and re-registers automatically after linking succeeds.

### `X-Client-Version` header

`qa`-channel builds send `X-Client-Version: <APP_VERSION>` on:

- The WS upgrade request (`main.js`, alongside `X-Auth-Token`)
- The QA status poll (`GET /api/auth/qa-status/:installToken`)

The dev backend uses this header to enforce the golden-build lock (`QA_BUILD_LOCK`). A
build whose version string does not match `QA_ACTIVE_VERSION` is rejected:

- **WS upgrade:** closed with code `4003`; close reason is `OUTDATED_BUILD:<activeVersion>`.
  The overlay logs `[relay] WS closed 4003 OUTDATED_BUILD` and shows an update prompt.
- **QA status poll:** HTTP 426 response; the overlay aborts login and shows an update prompt.

`stable`-channel builds also send `X-Client-Version` on the WS upgrade but the production
backend never checks it (`QA_BUILD_LOCK` defaults to false in production).

---

## Cross-links

- Chat overlay React component internals: `../frontend/chat-overlay.md`
- Release pipeline (packaging, publishing, VirusTotal): `../deployment/`
- Update notification (passive OS toast, Nexus ToS compliance): `auto-update.md`
- Build instructions: `building.md`
- Keybind reference: `keybinds.md`
- Window management: `window-management.md`
- In-game HUD chat (separate opt-in `.ba2` track): `zfe/README.md` — ZFE `chat.v1` works on native
  Windows (0.9.9+) but is Proton/Wine-blocked (#326), so this desktop overlay stays the Linux chat path.

Onboarding accepts either Steam or Discord. The in-game name field is optional: leaving it
blank uses the linked Steam display name (when the backend profile lookup is configured),
then Discord, then `Wanderer`. A provider default is not saved as a custom in-game name.
HUD linking instructions likewise offer Steam or Discord at `/link`.

## Optional background Server bridge

The local FCMServerBridge 0.1.0 candidate uses a separate invisible HUDModLoader mod to supply
a fresh native room lease. The shared desktop ChatOverlay renders Server and includes the same
canonical messages in General. No mod is installed by the desktop app. See
[bridge setup and acceptance](zfe/background-server-bridge.md); hosted deployment and two-client
ZFE/xScal validation remain pending.
