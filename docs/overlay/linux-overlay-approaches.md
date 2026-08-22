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
2. **KWin force-Layer window rule (the fix — verified on KWin 6.7.1):** `fcm-keepabove`
   (`wmclass=fallout-chat-mod`, `layer=overlay`, `layerrule=2`=Force) puts the overlay in KWin's
   `OverlayLayer(9)`, ABOVE the active-fullscreen game, WITHOUT demoting the game — so FO76 keeps
   normal fullscreen stacking (above the panel) and the overlay keeps keyboard focus (window type
   stays Normal). Added in KWin 6.0 (KDE Bug 441074). Combined into the SAME rule as a plain
   `above=true` belt-and-suspenders property (both always target the overlay window, so one KWin
   rule carries both — earlier builds split them into `fcm-keepabove` + `fcm-overlay-layer`; now
   merged). The rule is **session- and output-scoped**: installed only while FO76 runs and shares
   the overlay's display, removed otherwise (game exit, or overlay dragged elsewhere), not a
   permanent startup rule. On a different monitor the overlay is a normal window. KWin's
   `isActiveFullScreen()` is per-output aware, so a fullscreen game stays promoted even when a
   different-output window has focus.
   The old `fcm-game-below` (`below=true` on the game) has been **removed entirely** — it
   worked but also dropped the game under the taskbar and every other window; the install script
   still strips a stale copy from old opted-in installs.
   Neither affects the cursor lock — stacking only. (Empirically: a matched window jumps from
   `layer=2` to `layer=9`; an earlier "layer/layerrule ignored by KWin 6" note was never actually
   tested with this rule and is wrong.)
3. **Enable Wine's own mouse capture via protontricks — an explicit, user-initiated step,
   never automatic.** The overlay never writes to the FO76 Proton/Wine prefix on its own (not on
   install, not on launch) — see [README.md](README.md) — EULA-safe overlay scope: no
   game-memory reading, no game-file modification, no code injection, no network/port scanning;
   writing `GrabFullscreen`/`GrabPointer` is a Wine/Proton *compatibility-layer* registry setting,
   not a game-file modification. Two ways to apply it, both user-initiated:
   - **Tray → "Fix FO76 cursor lock (Wayland)"** (`main.js` `fixFo76CursorLock` /
     `applyFo76Grab`, needs FO76 closed) — one click runs the same commands below and reports
     the result (`applied` / `fo76-running` / `no-prefix` / `no-protontricks` / `error`) via a
     dialog. This is the recommended path.
   - **Manual**, for anyone who prefers to run it themselves: the winetricks verb
     `protontricks 1151340 grabfullscreen=y` (the winecfg "Automatically capture the mouse in
     full-screen windows" setting; internally `HKCU\Software\Wine\X11 Driver` `GrabFullscreen`=`Y`)
     for Fullscreen, PLUS `GrabPointer`=`Y` for Borderless-Windowed via
     `protontricks 1151340 -c 'wine reg add "HKCU\Software\Wine\X11 Driver" /v GrabPointer /t REG_SZ /d Y /f && wineserver -w'`
     (no winetricks verb exists for GrabPointer; `wineserver -w` flushes `user.reg` — Wine only
     persists the registry on shutdown). The manual steps are printed by
     `Packaging/linux/install.sh` (`print_cursor_manual_steps`) and documented in
     `INSTALL-LINUX.txt` — the installer itself still never applies them automatically.

   **Wine** then confines the cursor to the game whenever FO76 is focused and releases it when
   focus leaves (overlay stays usable). Confirmed: cursor held on fast flicks, free movement in
   menus, frees for the overlay — all by Wine, independent of KWin's broken pointer constraint.
   **Recommended:** run FO76 on the latest **Proton 11.x** available in Steam (Properties →
   Compatibility → Force the use of a specific Steam Play compatibility tool), or a
   well-maintained community build like **Proton-CachyOS** or **GE-Proton** — newer Wine/DXVK
   builds are more reliable at persisting these settings. X11 doesn't need it. (History: earlier
   builds hand-edited `user.reg`, then auto-applied via protontricks unconditionally from the
   installer; that install-time auto-apply and the tray button were both removed for mutating the
   prefix without an explicit per-use action; the tray button was reinstated as an
   explicit/on-demand-only action, while the installer stays manual-instructions-only.) The KWin
   rules in step 2 handle stacking and are unrelated to this step.

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

## Phase-0 spike (2026-07) — re-testing the native-Wayland conclusion with `FCM_NATIVE_WAYLAND=1`

The "not achievable" conclusion above was last measured before two things changed: Electron
bumped to **42.5.0** (we were on ~39 when the XWayland-relaunch approach was built), which
**fixed `GlobalShortcutsPortal`** (broken in the 40.x–41.x regression, electron#49806, fixed in
42.0.0) — so native-Wayland global hotkeys are worth re-testing, not assumed dead. And KWin rule
matching turns out to already be app_id-aware (see below) — so stacking is likely not the
blocker people assumed either. **KDE bug 485409 (the cursor-lock issue) is still open — checked
2026-07, status CONFIRMED, no fix version** — so that piece of the "not achievable" conclusion
still stands until proven otherwise. This spike exists to test the *remaining* unknown
empirically rather than re-assert the old conclusion from a stale Electron baseline.

**What's implemented (code, no behavior change for existing users):**
- `FCM_NATIVE_WAYLAND=1` (env var) — `main.js`'s `KDE_WAYLAND` relaunch block skips the
  XWayland relaunch (`overlay-core.js: planOzoneRelaunch({ nativeWaylandOptIn: true })` returns
  `null`) and instead enables `--enable-features=GlobalShortcutsPortal`. Unset (the default),
  behavior is byte-for-byte unchanged — still relaunches into XWayland.
- **app_id pinning:** `package.json`'s top-level `desktopName: "fallout-chat-mod.desktop"`
  field (read by Electron itself at startup, electron/electron#49988, landed by our 42.5.0 pin)
  pins the native-Wayland `app_id` to `fallout-chat-mod` — the same string as the X11 WM_CLASS
  the existing `fcm-keepabove` KWin rule already matches. (This is a *different* field from
  `build.linux.desktopName`, which only names the installed `.desktop` file.)
- **KWin rule:** `buildKwinKeepAboveScript()` in `overlay-core.js` is **unmodified**. KWin's
  rule engine matches `wmclass` against `Window::resourceClass()`, an accessor implemented for
  both `X11Window` (X11 `WM_CLASS`) and `XdgToplevelWindow` (Wayland `app_id`) — the same
  abstraction that lets System Settings → Window Rules → Detect Window Properties show a
  "Window class" for native-Wayland apps (Konsole, Chrome, Discord) today. With the app_id
  pinned to `fallout-chat-mod`, the existing rule is expected to match a native-Wayland overlay
  window with no changes — **unverified until tested live.**

**Manual test protocol (the actual GO/NO-GO gate — requires real KDE Plasma 6 Wayland + FO76
under Proton hardware; not automatable):**
1. Launch with `FCM_NATIVE_WAYLAND=1`; confirm the `[ozone]` diagnostic log line shows the
   native-Wayland path was taken (not a relaunch).
2. System Settings → Window Management → Window Rules → Add New… → Detect Window Properties →
   click the overlay window → confirm **Window class = `fallout-chat-mod`** (same workflow used
   for Konsole/Chrome/Discord).
3. Run `setupKdeKeepAbove` (tray → "KDE: keep overlay above game") and confirm the overlay
   stacks **above** a focused fullscreen/borderless FO76.
4. **The gate:** with FO76 running and mouselook active, does the game **keep its cursor lock**
   with the native-Wayland overlay on top (click-through)? Per KDE bug 485409 this is expected
   to fail — confirm whether it actually does on current KWin.
5. If the lock survives: Insert → chat → type → Escape → confirm the lock **returns cleanly**.
6. Confirm portal-granted global hotkeys fire while FO76 has focus (expect a KDE consent
   prompt on first use — our defaults are bare keys, which portals are typically warier about
   granting than modifier combos; this may need a native-mode-only keybind default change).
7. Watch for direct-scanout/game-lag regression vs. the XWayland build.

**Decision:** if step 4 fails, native-Wayland interactive play is not shippable (matches the
"not achievable" conclusion above) — this doc's XWayland-relaunch solution remains the shipped
default, unconditionally, and the opt-in flag stays a dev-only spike tool. If step 4 holds,
proceed to a full migration plan.

**Result (2026-07-04, real KDE Plasma 6 Wayland + FO76/Proton hardware): step 4 (the gate)
holds — the game keeps its cursor lock with the native-Wayland overlay on top.** This is a
partial GO: the one blocker research couldn't resolve without hardware (KDE bug 485409 is
still CONFIRMED/unfixed upstream, per the check earlier in this section) did not manifest here.
Two things remain open before calling this a full GO for Phase 1:
- **Mechanism unconfirmed.** It's not yet known whether this held because Wine's own
  `GrabFullscreen`/`GrabPointer` X11-level grab (see the "SOLUTION" section above — a
  *different* locking path than the `zwp_pointer_constraints_v1` protocol bug 485409 is about)
  was already applied to the test prefix, or because the native-Wayland surface genuinely
  doesn't trigger the compositor-side revocation the bug describes. These have different
  implications: the former means native-Wayland migration is safe **only if** the install/setup
  flow keeps steering users to the Wine grab fix (tray → "Fix in-game cursor lock"); the latter
  would mean the bug doesn't apply to this stacking arrangement at all. Follow-up: re-test with
  a **vanilla Proton prefix (no `GrabFullscreen`/`GrabPointer` set)** to isolate which mechanism
  is responsible.
- **Steps 3/5/6/7 not yet confirmed** (stacking above the fullscreen game, lock returning
  cleanly after chat, portal-granted hotkeys firing, scanout/lag regression). Only the cursor
  lock (step 4) has been checked so far.

Given the above, treat this as **GO on the critical blocker, not yet a full GO for Phase 1** —
the automatic-fallback design in Phase 1 should assume the mechanism is Wine-grab-dependent
(the conservative reading) until the vanilla-prefix retest says otherwise, and stacking/hotkeys
still need their own hardware confirmation before Phases 2–3 are built out.

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
