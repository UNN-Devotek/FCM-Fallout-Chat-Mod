# Cross-Platform Overlay — Prototype

A **cross-platform Electron shell** (Windows / macOS / Linux X11) that mounts the
**actual** Fallout Chat Mod web-overlay React component — the very same
`admin-dashboard/src/features/chat/ChatOverlay.tsx` that renders on the website —
and feeds it live chat from the Fallout Chat Mod relay. The **shipped** binary
connects to the production relay; for development, use your own local backend or
the isolated hosted DEV backend (see "Run it" below) — never point a dev build at
the production relay.

Because it renders the real component (not a lookalike), it is visually identical
to the website overlay **by construction**: same Pip-Boy two-row tab bar, the
per-channel `[Tag]` colors, phosphor-green theme, scanline, fonts, input row with
the ☢ counter — all of it comes straight from the dashboard source.

> Everything is inside `cross-platform-overlay/`. It does **not** modify the
> dashboard, backend, or .NET overlay. It *imports* the dashboard component
> (read-only, via a Vite `@dashboard` alias) and *calls* the relay's public
> register + WebSocket endpoints, exactly like the real desktop client.

---

## Run it (development — against your LOCAL backend)

Bring up the local stack first (see the repo README "Dev Setup" — `docker compose`
on `localhost:7076`), then:

```bash
cd cross-platform-overlay
npm install

# Hot reload — ONE command: Vite renderer (HMR) + Electron, against localhost:7076
npm run dev:local

# Or a built renderer (no HMR), still against your local backend:
npm run start:local
```

Both `:local` scripts point the overlay at `http://localhost:7076`. Develop
**only** against your local backend.

### Hosted DEV overlay

To run the hot-reloading overlay against the isolated hosted DEV environment:

```bash
export DEV_PERSONA_LOGIN_SECRET='<value from the hosted fcm-dev Dokploy env>'
npm run dev:cloud
```

This is still an unpackaged Electron build. The **DEV ACCOUNTS** buttons work here
and immediately issue synthetic DEV sessions; they do not open Discord. The
`DEV_PERSONA_LOGIN_SECRET` export is required for this remote hosted-DEV request;
local `npm run dev:local` requests use loopback and do not need it. They are
available only in unpackaged builds targeting the local backend or the exact hosted
DEV relay, and are never available in packaged production builds.

> `npm start` and `npm run dist:*` build the **shipped end-user binary**, which
> targets the production relay. They are a release step, **not** a dev workflow —
> don't use them to connect a local/dev build to production.

### Requirements
- Node.js 18+ and npm. Electron is downloaded by the dev-dependency on first install.
- **App client key:** registration needs `APP_CLIENT_KEY`. In the repo it's resolved
  automatically (no secret in source): the `APP_CLIENT_KEY` env var if set, otherwise
  it reads `../backend/.env` / `../.env` — so a local `cp .env.example .env` (which
  ships the dev default) is enough.

### Controls

The web `ChatOverlay.tsx` has **no window chrome of its own** — no title bar,
minimize/close, hotkeys, click-through or focus management (those were the
desktop WinForms app's job). The Electron **shell** provides them:

**Window controls (work everywhere, incl. WSLg):**
- **Shell control strip** — a slim draggable bar at the very top of the window.
  Drag it to move the window. On the right it has **− (minimize)** and **✕
  (close → quits the app)**.
- **System tray icon** (a small phosphor-green dot) — right-click for
  **Show / Hide / Focus to chat / Toggle click-through / Quit**. Left-click the
  tray icon to toggle show/hide. The app keeps running in the tray when the
  window is hidden; **Quit** (tray or the ✕ button) is the only thing that exits.
- **`/hide`** — type `/hide` in the chat input and press Enter to hide the
  window (re-show from the tray, or via the toggle hotkey on a native build).

**Header window controls (in the overlay's own top row — desktop-overlay parity):**
The overlay header renders, right-aligned in the main-tab row, four icon buttons
matching the WinForms overlay: **↻ Refresh** (re-fetch channels + history),
**⚙ Settings** (opens the full settings panel below), **− Minimize**, **✕ Close**
(quit). To their left is the connection status dot. The single **"Fallout 76"**
main tab (an amber outlined box) sits on the left of the same row; the four
sub-channels (GENERAL / TRADING / EVENTS / RAIDS) are in the row below.

**Global hotkeys (native builds only — see WSLg note below; rebindable in Settings):**
- **`Insert`** → *focus to chat*: shows + focuses the window and makes it
  interactive so you can type immediately (mirrors the desktop overlay).
- **`Ctrl/Cmd+Shift+\`** → toggle the overlay **show/hide**.
- **`Ctrl/Cmd+Shift+X`** → toggle **click-through** (`INTERACTIVE` ↔ clicks pass
  to whatever is behind the overlay). Use click-through in-game; toggle back to type.

When the overlay is visible over another desktop app, it remains clickable so a
click can focus it and bring it above that app. Automatic click-through is reserved
for the game foreground; manual click-through still always passes clicks through.
- **`Ctrl/Cmd+Shift+]`** / **`Ctrl/Cmd+Shift+[`** → **next / previous channel**
  (drives the sub-tab row).
- **`Ctrl/Cmd+Shift+,`** → **open settings** (the full desktop-parity panel).

**Settings panel (full desktop-overlay parity — `⚙` or `Ctrl/Cmd+Shift+,`):**
A Pip-Boy-styled modal that always fits inside the window (caps its height and
scrolls internally). Exposes, mapped from the desktop `SettingsForm.cs` /
`OverlayConfig.cs`:
- **Appearance:** Theme (default **Fallout 76 amber**; also Vault-Tec Green /
  Amber / White), Window Opacity, Text Opacity, **Background Dim**, **Scanline
  Intensity**, Font Size, and supporter star colour when the account has a
  supporter badge.
- **Behaviour:** Show hint bar, **Fade / collapse when idle** (on by default).
- **Filters:** Blocked users, Hidden channels.
- **Keybinds:** the global-shortcut set (toggle / focus / click-through / next /
  prev / settings) — shown for reference (native-only; see WSLg note).
All settings persist (localStorage + the Electron state file) and apply live
(theme/opacity/font remount the component; dim/scanline are CSS layers).

**Auto-collapse (idle fade — desktop `_idleFaded` parity):** after ~25 s with no
activity the overlay folds to just the header / tab strip; it expands again on
any interaction (mouse / key / scroll) **or** a new message in the active
channel. Toggle via **Fade when idle** in Settings. **Auto-hide mode** next to
that toggle selects either **Full auto-hide** (the default; hides the whole
overlay, including the navigation, while keeping the relay connected so a new
message can restore the window) or **Sub-tabs collapse** (leaves the navigation
visible).

**Window size / position:**
- Default size is **520 × 500** (kept modest so the channel-tab bar at the top
  is always on-screen). Draggable (drag the thin top strip, or move via the OS),
  resizable; minimum **320 × 280**.
- Size **and position are clamped to the current display's work area** and
  **persisted** to `overlay-state.json` in the app's userData dir.
- **Taskbar + alt-tab:** the window has a title ("Fallout Chat Mod"),
  `skipTaskbar:false`, and `minimizable/maximizable:true` (the Electron-supported
  equivalent of `WS_EX_APPWINDOW` — a normal, non-tool window), so a
  transparent/frameless window still appears in the OS taskbar and alt-tab switcher.
- **Always-on-top:** `setAlwaysOnTop(true, 'screen-saver')` is **re-asserted**
  while the overlay is visible, so it can be clicked above normal desktop windows
  and stays above a fullscreen-borderless game (native only — see WSLg note).

**Popovers stay in-frame:** the emoji picker, GIF picker, right-click context
menu, @mention / slash-command autocomplete, and the settings modal all reposition
to stay fully inside the window — they flip/clamp away from edges and, if taller
than the available space, cap their height and scroll internally.

**Send:** type in the component's input box and press Enter (Shift+Enter for a
newline); subject to the relay's 2 msg/sec rate limit.

---

## How it renders the REAL component

`src/main.tsx` imports the component straight from the dashboard tree:

```ts
import ChatOverlay from '@dashboard/features/chat/ChatOverlay';   // the REAL file
import '@dashboard/index.css';                                    // Tailwind v4 + theme vars
```

(`@dashboard` → `../admin-dashboard/src`, set in `vite.config.ts`.)

It is mounted with the same providers the dashboard gives it, so it runs unchanged:
- **`QueryClientProvider`** (`@tanstack/react-query`) — for its `useQuery` channel/
  feed/commands calls.
- **`MemoryRouter` + an `Outlet context={{ user }}`** — the component calls
  `useOutletContext<{ user }>()` and `Link`; the dashboard mounts it under
  `<Outlet context={{ user }} />` at `/chat`, which we replicate. A stub
  `AuthUser` with `role: 'user'` is supplied (so no moderator buttons show, which
  matches the marketing screenshots).
- **Single-instance dedupe** — `vite.config.ts` dedupes `react`, `react-dom`,
  `react-router-dom`, and `@tanstack/react-query` so the dashboard source and this
  app share one module instance (otherwise React context breaks:
  "No QueryClient set").
- The product default **Fallout 76 (amber/wasteland)** theme is seeded into
  `localStorage` (`fcm_web_overlay_settings.themeId = 'fo76-wasteland'`) before
  mount, matching the component's own default.

**Minimal, website-safe edits to the shared component.** Two dashboard files are
touched additively — `admin-dashboard/src/features/chat/ChatOverlay.tsx` and
`GifPicker.tsx`. Every change is gated so the **website renders identically**:
- **In-frame popover clamping** (emoji/GIF picker anchor + context-menu position):
  the clamps only adjust a popover *when it would overflow* a window edge; when
  there's room the values are untouched (same as before). `GifPicker` gains an
  optional `style` prop (the website passes nothing → unchanged).
- **Desktop-overlay header parity** (the FALLOUT 76 outlined main tab, the
  refresh/min/close icons, amber sub-tab treatment) is gated behind
  `window.__FCM_OVERLAY_SHELL__`, a global **only this Electron shell sets**
  (in `src/bridge.ts`). On the website that global is absent, so the header keeps
  its original look and only the settings cog shows.

---

## Live data — how it flows (this is the real, working part)

The component owns its own data layer: `services/api` (over `fetch`) for channels,
and its own `new WebSocket(...)` for chat. We did **not** fork that. Instead the
Electron main process is a **transparent proxy**, and `src/bridge.ts` shims the
renderer's global `fetch` + `WebSocket` to route through it:

1. **Register (main process):** generate an anonymous install-token UUID →
   `POST /api/users { username, installToken }` with header `X-App-Client-Key`
   (the TOFU/client-key path a fresh, unenrolled install is allowed to use) →
   `{ data: { userId, token } }`. (Mirrors `ChatOverlay/Services/DeviceAuth.cs`
   + `backend/src/controllers/usersController.ts`.)
2. **HTTP proxy:** the component's `api.get('/api/channels')` → shimmed `fetch`
   → IPC → main process replays it to the relay with `X-Auth-Token: <token>`.
   So the **real channel tree (tab names + per-channel tag colors)** loads live.
3. **WS ticket:** the component fetches `/auth/ws-ticket` first; the proxy answers
   that locally (there's no dashboard cookie session) so the component proceeds
   to open its socket.
4. **WebSocket proxy:** the component's `new WebSocket(...)` → shimmed
   `ProxiedWebSocket` → IPC → main process opens the relay socket — the host is
   `RELAY_WS` (`ws://localhost:7076/ws` in dev, production in the shipped build) —
   with the `X-Auth-Token` **header** (a browser/
   renderer WebSocket can't set headers — that's why the socket lives in main).
   Frames are piped both ways, so the component's own `onmessage`/`chat:history`/
   `chat:message`/`chat:send` handling all run on **real live data**.

**Confirmed working:** an end-to-end test against `falloutchatmod.com` returns the
live channel tree and real `chat:history` + `chat:message` frames, and a headless
Electron smoke run rendered the real component showing live messages
(`[General] Devotek-: …`, `[Discord] MouseyPaige: …`, etc.).

---

## What works vs what's stubbed

**Works (real, live):**
- Renders the **actual website ChatOverlay component**, unmodified.
- Live channels (real tab names + tag colors), live `chat:history`, live incoming
  `chat:message`, and **sending** via the component's input.
- All of the component's native behavior: per-channel `[Tag]` colors, `[Discord]`
  purple tag, display-name resolution, scanline, glow, emoji rendering, the
  emoji/GIF picker buttons, settings cog, character counter — it's the real UI.
- Transparent / frameless / always-on-top window + click-through toggle.

**Stubbed / simplified:**
- The signed-in user is a stub (`role: 'user'`), so moderator/admin controls and
  the admin "All Servers" feed are not exercised. No Discord OAuth.
- The "Server" sub-channel has been fully removed (world-detection was retired in v1.3.30).
- No game-process detection (show/hide on `Fallout76.exe`) — Phase-2.
- The display name is an auto-generated `Overlay####` handle persisted per install.

---

## What works in WSLg vs what needs a native build

The owner inspects this prototype through **WSLg** (the WSL2 GUI bridge). WSLg
runs the app inside a **sandboxed Wayland/X server that is isolated from the real
Windows desktop**. That sandbox is invisible to — and cannot interact with — the
Windows game window or the Windows input stack. So three OS-integration features
are **wired correctly in code but cannot be exercised under WSLg**; they light up
on a **native Windows Electron build** (or a native Linux X11 desktop):

| Feature | WSLg | Native Windows / Linux X11 | Why |
|---|---|---|---|
| Header window controls (↻ ⚙ − ✕) | ✅ works | ✅ works | In-renderer → IPC, no OS hooks |
| System tray (Show/Hide/Quit) | ✅ works* | ✅ works | Tray lives in the app |
| `/hide` slash command | ✅ works | ✅ works | Renderer → IPC, no OS hooks |
| Settings panel + persistence | ✅ works | ✅ works | Pure renderer + state file |
| Theme / opacity / font / scanline live apply | ✅ works | ✅ works | localStorage + remount + CSS layers |
| Auto-collapse (idle fade) | ✅ works | ✅ works | JS idle timer + CSS state |
| In-frame popovers (picker/menu/autocomplete) | ✅ works | ✅ works | Pure layout clamping |
| Resize + persist + clamp | ✅ works | ✅ works | Pure window management |
| **Taskbar + alt-tab entry** | ⚠️ host-dependent | ✅ works | Needs a real window manager/taskbar; flags set correctly |
| Live chat (channels + WS) | ✅ works | ✅ works | Proxied to the live relay |
| **Global hotkeys** (toggle / Insert / click-through / next-prev channel / settings) | ❌ not delivered | ✅ works | Windows desktop owns the keystrokes; WSLg never sees them |
| **Focus-from-game** (Insert → take focus to chat) | ❌ N/A | ✅ works | No shared desktop / game window under WSLg |
| **Click-through over a game** (manual or auto-on-hover) | ❌ no effect | ✅ works | No shared desktop to pass clicks through |
| **Always-on-top OVER a fullscreen-borderless game** | ❌ N/A | ✅ works | WSLg is sandboxed from the Windows game; re-assert only matters natively |

\* The tray depends on a tray/notification host being present; most WSLg sessions
provide one, but if none exists the tray is skipped (best-effort) and you still
have the − / ✕ shell strip and `/hide`.

**Bottom line for WSLg inspection:** use the **shell strip** and the **tray** to
move / minimize / hide / quit the window, and `/hide` from the input. To validate
global hotkeys, focus-from-game, and click-through, run a **native build** (a
Windows-packaged Electron, or a native Linux desktop) — the same `main.js` code
drives them there.

## Window flags & cross-platform caveats

`main.js` BrowserWindow: `transparent: true`, `frame: false`, `hasShadow: false`,
`backgroundColor: '#00000000'`, `alwaysOnTop: true` +
`setAlwaysOnTop(true, 'screen-saver')`, `setVisibleOnAllWorkspaces(true, {
visibleOnFullScreen: true })`. Window size/position are clamped to the active
display's `workArea` and persisted to `overlay-state.json`. Click-through:
`setIgnoreMouseEvents(enabled, { forward: true })` toggled by a `globalShortcut`
(native only) **or** the tray "Toggle click-through" item (works under WSLg).
Drag + window controls: the shell strip uses CSS `-webkit-app-region: drag` with
no-drag − / ✕ buttons that call `window:minimize` / `window:close` over IPC; a
**system tray** (Show / Hide / Focus to chat / Toggle click-through / Quit) gives
the same controls without any hotkey. See the WSLg-vs-native table above.

**Caveats:**
- **Linux X11:** transparency + always-on-top + click-through work with a
  compositor running. Runs **natively — no Wine.**
- **Linux Wayland:** native Wayland can't stack over the game or do click-through
  reliably, so on **KDE+Wayland the app auto-forces XWayland** via a one-time argv
  relaunch (`--ozone-platform=x11`) — `appendSwitch` is too late on Electron 39+ — and
  installs one KWin rule on the overlay (keep-above + force-Layer, combined). See `docs/overlay/window-management.md`.
- **Steam Deck:** Desktop-Mode / second-screen tool, **not** a Game-Mode
  (gamescope) overlay.
- **Exclusive Fullscreen (any OS):** no window can render above a true
  exclusive-fullscreen game; use Windowed-Borderless (same as the .NET overlay).

---

## Path to production

This validates the cross-platform direction *and* proves the existing React
overlay can be reused verbatim. A shippable build would:

- **Switch to Tauri** for the production target: the same renderer (this exact
  component) on a Rust core → ~3–10 MB binaries and far lower RAM than Electron.
  The fetch/WS proxy bridge becomes a small Rust command layer.
- **Game-process detection** per OS (`tasklist` / `/proc` / `pgrep`) to show/hide.
- **Real auth + identity:** Discord OAuth linking, real display-name resolution,
  enable moderator controls for staff.
- **Native hotkeys** + per-OS click-through hardening (esp. a Wayland strategy).
- **Packaging & signing** (electron-builder / Tauri bundler; the repo tracks a
  Windows signing plan in `docs/CODE-SIGNING.md`).
