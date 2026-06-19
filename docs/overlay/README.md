# Electron Overlay — Overview

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
│   ├── bridge.ts    — Renderer-side shims: patches global fetch + WebSocket to route
│   │                   through IPC proxy; sets window.__FCM_OVERLAY_SHELL__ flag
│   └── onboarding.ts — Onboarding UI component and notifyOnboardingComplete() IPC call
├── assets/          — App icons (fcm.ico, fcm-linux.png, fcm.icns) + KWin rule
└── vite.config.ts   — @dashboard alias → ../admin-dashboard/src; dedupes React/TanStack
```

---

## What the app does

The Electron shell provides everything the web `ChatOverlay.tsx` component does not:

- **Window chrome** — transparent/frameless BrowserWindow, drag strip, tray icon, min/close buttons
- **Game-process detection** — `tasklist` (Windows) / `ps -A` (Linux) to detect `Fallout76.exe`; shows or hides the overlay automatically when the game starts or exits
- **Global hotkeys** — navigation-cluster keys (Insert, Delete, End, PageUp/Down, Home, `\`, `/`) intercepted before the game receives them
- **Click-through** — `setIgnoreMouseEvents` so clicks pass through to the game behind
- **Update notification** — passive OS toast (Windows / Linux libnotify / macOS) when a newer version is available; version delivered over the chat WebSocket (`app:update-available`); downloads/installs nothing; clicking opens Nexus Mods for a manual download. See `auto-update.md`.
- **HTTP + WebSocket proxy** — shimmed `fetch`/`WebSocket` in the renderer route through IPC so the main process can inject `X-Auth-Token` (browsers cannot set WS headers). Renderer-supplied HTTP headers are **allowlisted** before forwarding (`filterProxyHeaders` in `overlay-core.js`: only `content-type`, `accept`, `accept-language`, `cache-control`, `x-requested-with`, with CRLF stripped); the main process then sets `X-Auth-Token`/`User-Agent`/`Origin` *after* filtering, so a compromised renderer cannot override the auth headers or inject others. The renderer-supplied request **path** is likewise resolved strictly against the relay origin (`resolveRelayProxyUrl`) and refused if it points anywhere else, so it cannot redirect the request — and the attached `X-Auth-Token` — to another host.

**No game-memory reading, no game-file modification, no code injection, no network/port scanning.** The only game interaction is a process-name check (`Fallout76.exe`) to drive show/hide.

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

---

## Z-order requirement

The overlay window uses `setAlwaysOnTop(true, 'screen-saver')` — the highest standard level — and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. This only works reliably when Fallout 76 runs in **Windowed Borderless** mode. Exclusive Fullscreen gives the game exclusive GPU output; no window on any OS can render above it.

On **KDE Plasma (Wayland)** the overlay forces the XWayland backend and installs two KWin rules automatically on first launch — see the dedicated section below and **[window-management.md](window-management.md#kde-plasma--wayland--keep-above-the-game-kwin-layer-rule)** for the full mechanism.

---

## Linux / Proton — Z-order by compositor

### KDE Plasma (Wayland) — automatic

On KDE+Wayland the overlay configures itself on first launch — **no manual steps**. It:

1. **Forces the XWayland Ozone backend** via a one-time argv relaunch (`--ozone-platform=x11`) — `appendSwitch` is too late on Electron 39, so it re-execs once with the flag. Without XWayland the overlay can't stack over the game *and* breaks KWin direct scanout (game lag). See [window-management.md](window-management.md).
2. **Installs two KWin rules** into `~/.config/kwinrulesrc` (`setupKdeKeepAbove` → `overlayCore.buildKwinKeepAboveScript`, then `qdbus org.kde.KWin /KWin reconfigure`):
   - `fcm-keepabove` — keeps the overlay window above others.
   - `fcm-game-demote` — forces `fullscreen=false` on the game (`steam_app_1151340`) so KWin doesn't promote the focused game to the active-fullscreen layer, which is what actually keeps the overlay on top **while you play**. (On KWin 6 the old `layer=8` override is ignored, so this demote rule — not a layer override — is the fix.)

The install is idempotent and self-healing (cleans stale FCM rules from older builds, preserves the user's own rules). **Uninstalling removes both rules** (`buildKwinRemoveRulesScript` / `Packaging/linux/uninstall.sh`), restoring FO76's fullscreen stacking.

**Fallback** if the auto-apply couldn't run: tray → **KDE: keep overlay above game**, or import `~/.config/Fallout Chat Mod/fallout-chatmod-keepabove.kwinrule` via System Settings → Window Rules → Import, then `qdbus org.kde.KWin /KWin reconfigure`.

**Run FO76 in Windowed Borderless** — Exclusive Fullscreen blocks any overlay on any OS. **Do NOT** run the game inside **gamescope** — its nested compositor isolates the game and the overlay cannot render over it.

### GNOME / non-KDE compositors — conditional Steam launch option

On GNOME or other non-KDE compositors, if the overlay won't stay on top, set this Steam Launch Option for Fallout 76 (**Steam → Fallout 76 → Properties → General → Launch Options**):

```
PROTON_NO_WM_DECORATION=1 %command%
```

This strips Proton's window decoration so the desktop compositor can composit the overlay above the game window normally.

> **KDE Plasma users must NOT set this.** On KDE, `PROTON_NO_WM_DECORATION=1` is not needed and has been confirmed to push the overlay *behind* the game. Use the KWin rule instead.

**Windowed Borderless is still required.** `PROTON_NO_WM_DECORATION` removes window chrome but does not override Exclusive Fullscreen. FO76 must run in **Windowed Borderless** mode on all compositors.

Both requirements are documented on the install page (SYSTEM → INSTALL).

---

## WSLg limitation

WSLg runs Electron inside a sandboxed Wayland/X server isolated from the real Windows desktop. Inside WSLg:

- Global hotkeys are not delivered (the Windows desktop owns Insert/Delete/etc.)
- Click-through has no effect over a real game window
- Always-on-top over a fullscreen game does not apply

These features are correctly wired and light up on native Windows builds or native Linux X11 desktops. Use the tray menu and in-renderer `−` / `✕` strip for WSLg testing.

---

## Cross-links

- Chat overlay React component internals: `../frontend/chat-overlay.md`
- Release pipeline (packaging, publishing, VirusTotal): `../deployment/`
- Update notification (passive OS toast, Nexus ToS compliance): `auto-update.md`
- Build instructions: `building.md`
- Keybind reference: `keybinds.md`
- Window management: `window-management.md`
