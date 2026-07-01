# Showing the chat overlay over a game on Linux — approaches & decision

Research notes (code-inspected) on how other overlays render over games on Linux, why a
desktop overlay window fights the game's cursor lock on Wayland, and the easiest shippable
path for FCM. See also [window-management.md](window-management.md) (KWin z-order) and the
in-game HUD track in [zfe/](zfe/README.md).

## ✅ SOLUTION (validated 2026-06-30) — XWayland overlay + Wine mouse-grab

Works on the user's **native KWin Wayland session, no desktop-type change, NO custom daemon**.
Three parts, all shippable from the installer:

1. **Force the FCM overlay into XWayland** (`ELECTRON_OZONE_PLATFORM_HINT=x11` + `--ozone-platform=x11`;
   the overlay already relaunches into XWayland on KDE-Wayland). It then displays on top of FO76
   correctly (transparent, always-on-top, click-through).
2. **Two KWin window rules (both load-bearing — verified):** `fcm-keepabove`
   (`wmclass=fallout-chat-mod`, `above=true`, Force) AND `fcm-game-below`
   (`wmclass=steam_app_1151340`, `below=true`). Dropping `fcm-game-below` makes the overlay slip
   BEHIND a *focused* fullscreen FO76 (KWin's active-fullscreen promotion wins). Neither affects
   the cursor lock — stacking only.
3. **Enable Wine's own mouse capture in the FO76 Proton prefix** — in
   `…/compatdata/1151340/pfx/user.reg` under `[Software\\Wine\\X11 Driver]`:
   `"GrabFullscreen"="Y"` and `"GrabPointer"="Y"` (the registry form of winecfg → Graphics →
   "Automatically capture the mouse in full-screen windows"). **Wine** then confines the cursor to
   the game whenever FO76 is focused and releases it when focus leaves (overlay stays usable).
   Confirmed: cursor held on fast flicks, free movement in menus, frees for the overlay — all by
   Wine, independent of KWin's broken pointer constraint. **Applied by the Linux installer**
   (`Packaging/linux/install.sh` → `apply_fo76_cursor_lock`) on any Wayland session — the
   community-standard winecfg "Automatically capture the mouse in full-screen windows" setting.
   Best-effort: needs FO76's prefix to exist + FO76 closed (Proton rewrites user.reg on exit);
   otherwise the installer prints the manual `protontricks 1151340 winecfg` → Input-tab steps.
   Idempotent, backs up `user.reg`. Re-apply any time via the tray "Fix in-game cursor lock
   (Wayland)" (`main.js` `fixFo76CursorLock` / `applyFo76Grab`, on the unit-tested
   `overlay-core.buildFo76GrabUserReg` + `fo76GrabStatus` helpers). X11 doesn't need it.
   (History: the overlay used to auto-apply this on every launch; moved to the installer +
   tray-only per the community protontricks approach.) Manual
   equivalent: `protontricks 1151340 winecfg` → Graphics → "Automatically capture the mouse …".

### What did NOT work (dead ends, for the record)
- **Patched KWin** — works but a forked compositor is unshippable (reverted).
- **Client-side cursor-jail / warp daemon** — `XGrabPointer confine_to` is IGNORED under KWin
  (KWin owns the real pointer even for a successful grab); pure `XWarpPointer` clamping leaks on
  fast flicks (polling gap); warp-to-center holds but pins the cursor (breaks menus).
- **XFixes pointer barriers** — created OK (XFixes 6.0) but superseded by the Wine fix before
  confirming; not needed.

The Wine `GrabPointer` setting is the clean answer: it's Wine performing the X grab from inside
the game's own context, which KWin honors, where our *external* grab/warp did not. So the heavier
Candidate B / Vulkan-layer and the custom-daemon plans are dropped for the default overlay.

This was only reachable once BOTH the game and overlay are XWayland clients on the same X server
(global hotkeys also work again via X11 `XGrabKey` / Electron `globalShortcut`, unlike native
Wayland).

## The core problem (measured on this stack)

On **KDE Plasma 6 / KWin Wayland**, a Proton game (Fallout 76, XWayland) holds an exclusive
pointer lock for mouselook (`XGrabPointer` → `zwp_pointer_constraints_v1`). KWin only keeps
that lock active while the locked window is the focused/active one
(`canConstrain = m_enableConstraints && focus() == activeWindow()`, `pointer_input.cpp`).
The instant **any** other surface — an Electron/XWayland window OR a true wlr-layer-shell
surface, full-screen or corner, click-through or not — takes pointer focus, KWin revokes the
lock and the cursor escapes. This is upstream **KDE bug 485409** (open). Verified empirically
here: game alone = cursor locks; any overlay window up = cursor escapes, regardless of
click-through.

Client-side workarounds that were tried and **proven dead**: every overlay window type;
an evdev "cursor-jail" (grab the mouse + re-inject via `uinput`) — dead because **FO76 reads
mouselook via the libinput cursor, not raw evdev**, so feeding the game necessarily moves the
cursor, and confinement is the compositor's job.

## How other overlays actually do it (code-inspected)

| Overlay | Mechanism | Interactive over locked cursor? | Linux? |
| --- | --- | --- | --- |
| **Steam / Discord / Overwolf / NVIDIA / AMD / Medal** | Inject a DLL into the game, hook `IDXGISwapChain::Present()`/`wglSwapBuffers`, render UI into the game's own frame, and **hook Win32 `ClipCursor`/`SetCapture`** to intercept input on the hotkey | Yes (Win32 input hook) | **Windows only.** No Linux port. Overwolf (also Electron, CEF-offscreen→shared texture→`Present()`) explicitly does not run on Linux. |
| **MangoHud / vkBasalt** | Implicit **Vulkan layer**: hook `vkQueuePresentKHR`, draw ImGui onto the swapchain image (`LOAD_OP_LOAD` preserves the game frame). Enabled via `MANGOHUD=1` + `mangohud %command%` | **No — display only.** Source has no `XGrabKeyboard`/evdev/`uinput`; it can *observe* keys (`XQueryKeymap`, or `wl_keyboard` only while the game is focused) but cannot steal text input. | Yes (Proton/DXVK). |
| **gamescope external overlay** (`GAMESCOPE_EXTERNAL_OVERLAY` atom) | Nested micro-compositor composites the overlay client at z=2 above the game | **No — display only.** Code-confirmed: an `isExternalOverlay` window is *never* assigned `inputFocusWindow`; only the private Steam `isOverlay` path or the game gets input (`steamcompmgr.cpp`). | Yes, but Valve-ecosystem, NVIDIA-flaky, multi-monitor placement bugs. |
| **Discover (Discord overlay, GTK + gtk-layer-shell)** | `wlr-layer-shell` OVERLAY surface; click-through via **empty input region** + `keyboard_mode=NONE`; interactive via `ON_DEMAND` + a small input region | Partly — but clicking it steals focus → breaks a game's cursor lock anyway. Officially "X11 + wlroots", **not KDE**. | wlroots/X11. |
| **Awakened PoE Trade (Electron overlay)** | Uses the **`electron-overlay-window`** native addon: frameless+transparent+always-on-top, attach-by-title, and an **activate/deactivate input grab** (not `setIgnoreMouseEvents`); global hotkeys via **`uiohook-napi`** | Yes | **X11 / XWayland only** (the addon uses X11 attach-by-title). No native-Wayland support. |

**The universal truth:** every overlay that is *interactive over a cursor-locked game* either
(a) renders **inside the game** (Win32 `Present()` hook, or a Vulkan layer, or a game mod), or
(b) relies on **X11's exclusive `XGrabPointer`**, where a separate always-on-top window
coexists with the lock. On **native Wayland** there is no easy interactive path.

## What this means for FCM

- A **native-Wayland (KWin)** interactive desktop overlay over a locked-cursor game is not
  achievable without owning the compositor (patch KWin / nested compositor) or rendering in
  the game (Vulkan layer / `.ba2`). All of these are heavy or not shippable.
- On **X11 / XWayland sessions**, a normal always-on-top Electron window **coexists** with the
  game's cursor lock (X11 grab is exclusive — a separate window doesn't break it), and
  interactivity is toggled by grabbing/releasing input. This is exactly how shipping Electron
  game overlays work, and it installs as a plain npm dependency — **no compositor, no sudo,
  no system changes.**

## Decision — two real shippable candidates

Both avoid a patched/nested compositor. The choice is a product trade-off (install ease vs
build effort vs whether the user must switch session type vs native-Wayland support).

### Candidate A — `electron-overlay-window` + X11/XWayland session (least build effort)
Adopt `electron-overlay-window` + `uiohook-napi` in the existing overlay.
- On X11 the overlay sits on top of FO76, the game keeps its cursor lock (chat feed shown
  click-through), and a hotkey toggles "interact" (grab input → cursor frees → type →
  release → game re-locks). Same model as Steam Shift-Tab / PoE Trade.
- **Install:** trivial — plain npm deps inside the current app. No sudo, no compositor.
- **Cost:** the user must run an **X11 session** (KDE: `plasma-x11-session` + `kwin-x11`,
  pick "Plasma (X11)" at login). On native Wayland it degrades to a normal window.
- **Effort:** ~2–4 days of integration. Reuses the existing React ChatOverlay as-is.

### Candidate B — custom Vulkan layer + Electron offscreen render (works on native Wayland)
A MangoHud-style implicit Vulkan layer hooks `vkQueuePresentKHR` and composites our chat UI
into the game's own frame; the existing React UI is rendered **offscreen by Electron**
(`offscreen:true` → `paint` bitmap → POSIX shared memory → the layer uploads it as a texture,
the `obs-vkcapture` IPC pattern). Keyboard input is captured by an in-layer `evdev` thread +
`libxkbcommon` (read-only `/dev/input/event*`, no grab needed) and forwarded to Electron.
- **Works while the cursor is locked, on the user's current Wayland session** — it renders
  *inside* the game frame, so there's no second surface and nothing for KWin to revoke. This
  is the thing that actually shows chat *while playing*.
- **Install:** like MangoHud — a package (`.so` + implicit-layer manifest in
  `~/.local/share/vulkan/implicit_layer.d/`) + an `FCM_OVERLAY=1 %command%` launch option.
  No sudo after install, no compositor patch.
- **Cost / effort:** a real build — ~8–13 dev-days (layer skeleton from MangoHud, shm
  transport, OSR integration, texture upload, evdev keyboard thread). Mouse interaction over a
  locked cursor stays limited; scope v1 to keyboard-driven chat.
- **EULA:** this is the **in-game / opt-in modding track** (renders into the swapchain), not
  the EULA-safe default overlay. FO76 has no kernel anti-cheat and a Linux-side Vulkan layer
  is outside Wine's Windows process space (structurally invisible to FO76's user-level DLL
  scan), so it is safe — but it must ship as an explicit, separate opt-in, never bundled with
  the default overlay. Same classification as the `.ba2`/ZFE track.

### Recommendation
- If running an **X11 session** is acceptable → **Candidate A** ships fastest and reuses
  everything. Best default.
- If it must work on the **current Wayland session and show chat while in mouselook** →
  **Candidate B** (more build, but the genuine in-game experience; opt-in modding track).

### Not pursued
Patched KWin (proven to work but a forked compositor is not shippable); custom nested
compositor (weeks of work, NVIDIA-flaky); a full CEF→Vulkan-layer (no production
implementation exists — Candidate B sidesteps it by rendering the React UI in Electron and
shipping only the bitmap to the layer).

### Anti-cheat note
FO76 ships **no kernel anti-cheat** (no BattlEye/EAC), so a Vulkan layer or `LD_PRELOAD`
overlay is safe with it — relevant only if option 2's Vulkan layer is ever pursued.

### Sources
electron-overlay-window; Awakened PoE Trade (`OverlayWindow.ts`); MangoHud (`src/vulkan.cpp`,
`src/keybinds.h`, `src/wayland_keybinds.cpp`); gamescope (`src/steamcompmgr.cpp`,
`src/wlserver.cpp`); trigg/Discover (`overlay.py`); gtk-layer-shell / layer-shell-qt;
Overwolf docs; Fred Emmott "In-Game Overlays: How They Work"; KDE bug 485409.

## Repository review — 20 repos inspected, ranked viable options

One agent per repo cloned + read the source. Only three strategies survive for "native KWin
Wayland, no desktop-type change." Full per-repo verdicts in the table at the end.

### Option 1 — XWayland-island Electron overlay  (cheapest, untested, NO desktop change)
Force **both** FO76 and the FCM Electron overlay into **XWayland** on the current Wayland
session (`ELECTRON_OZONE_PLATFORM_HINT=x11`; FO76 is already XWayland under Proton). Attach the
overlay to the game window with the Awakened-PoE-Trade technique (`electron-overlay-window`'s
`attachByTitle` / `activateOverlay` / `focusTarget`) and use an **evdev** hotkey listener (the
foot-pedal PTT daemon pattern — NOT `uiohook-napi`, which is X11/XRecord-only and silent on
Wayland). The bet: two **sibling X11 clients** share the X server's exclusive `XGrabPointer`,
so the game's cursor lock may hold — which is materially different from what broke earlier (a
*native-Wayland* Electron surface over an XWayland game). Reuses the React UI as-is. If the
lock holds: **days, not weeks.** Make-or-break = a ~10-minute test (no code changes). Repos:
`SnosMe/awakened-poe-trade`, `SnosMe/electron-overlay-window` (X11-only — patterns/attach).

### Option 2 — Vulkan overlay layer  (robust, in-frame, ~8–13 days) — see Candidate B above
Fork **vkBasalt** (`DadSchoorse/vkBasalt`, **zlib** — cleanest minimal layer skeleton: implicit
layer manifest + `vkQueuePresentKHR` hook + dispatch tables) and composite our UI into the
game's frame. Feed the React UI via Electron offscreen render → shared-memory/DMA-BUF using the
**obs-vkcapture** (`nowrep/obs-vkcapture`, GPL-2) texture-share pattern run in reverse (it only
captures *out* today — the composite-*in* path is new work). Keyboard via in-layer evdev +
libxkbcommon. Architecture blueprint: `hiitiger/goverlay` + `momo5502/gameoverlay` (Windows,
reference-only). Works on native Wayland, installs like MangoHud, no desktop change. EULA
opt-in track. License steer: base on vkBasalt (zlib), avoid copying GPL obs-vkcapture code
(pattern only). MangoHud (`flightlessmango/MangoHud`, MIT) is a heavier alternative base that
already has an ImGui Vulkan backend if going native-UI instead of Electron-OSR.

### Option 3 — Nested compositor  (heaviest, ~2–4 weeks)
Strip Smithay's `anvil` (`Smithay/smithay`, MIT) into a single-game host (~1.5–2.5k LOC Rust):
it already implements XWayland, `zwp_pointer_constraints_v1`, wlr-layer-shell, and
keyboard-shortcuts-inhibit. Run FO76 + an interactive layer-shell overlay inside it, nested in
KWin (no login-session change, but a per-game launch wrapper). Powerful and fully interactive,
but a bulky binary to ship — last resort. `cage` is a lighter wlroots base but lacks pointer
constraints AND layer-shell (too much missing); `gamescope` external overlays are provably
**display-only** (input only ever routes to the Steam overlay) so it can't host an interactive
overlay.

### Display-only fallback (no typing)
`oddlama/whisper-overlay` and `trigg/Discover` prove the layer-shell display-only trick
(`keyboard_mode=None` + empty input region = no focus steal, lock survives) — but reliable only
on wlroots; on KWin both fall back to XWayland, and the layer-shell client libs
(`gtk-layer-shell`, KDE `layer-shell-qt`) cannot host an Electron/Chromium surface anyway.

### Per-repo verdicts
VIABLE/PARTIAL (contribute to a path): vkBasalt (zlib, best layer base), obs-vkcapture (GPL-2,
hook+IPC proof), MangoHud (MIT, pattern), awakened-poe-trade (MIT, Option-1 patterns), Smithay
(MIT, Option-3 base), hiitiger/goverlay + momo5502/gameoverlay (Windows, architecture blueprint
only), whisper-overlay (MIT, display-only pattern).
NOT-VIABLE: electron-overlay-window & uiohook-napi (X11-only on Linux), gtk-layer-shell &
layer-shell-qt (can't host Electron), trigg/Discover & discern (XWayland-fallback on KWin /
vaporware injector), cage & gamescope (compositor gaps / display-only), evkoverlay,
input-overlay-wayland, wlx-overlay-s (VR), goverlay-config (install-UX reference only).
