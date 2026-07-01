# Window Management

Details how the Electron main process (`main.js`) manages the overlay window's position, size, visibility, z-order, click-through state, and idle-collapse behavior.

---

## BrowserWindow flags

The window is created with:

```js
transparent: true, frame: false, hasShadow: false,
backgroundColor: '#00000000',
alwaysOnTop: true,
skipTaskbar: false,    // window appears in OS taskbar + alt-tab
minimizable: true, maximizable: true
```

Default size: **520 × 500** (minimum: 320 × 280). Chosen so the channel-tab bar at the top is always on-screen (`main.js:387`).

Bounds are loaded from `overlay-state.json` at launch and **clamped to the active display's work area** via `clampToWorkArea()` (`main.js:795`). This prevents the overlay from spawning off-screen after a monitor configuration change.

---

## Drag and resize

The renderer's shell strip uses CSS `-webkit-app-region: drag`. Edge resize zones in `shell.ts` compute new bounds on pointer move and send them through IPC (`overlay:resize-bounds`).

On **Linux**, where CSS drag can drift under fractional DPI scaling, move events are routed through `overlay:move-start` / `overlay:move-tick` / `overlay:move-end`. The main process reads the authoritative cursor position via `screen.getCursorScreenPoint()` on each tick and calls `setPosition()` (`main.js:1192`).

A `isDragging` flag suppresses the z-order heartbeat during drags. `setAlwaysOnTop` on a transparent window triggers a DWM recomposition on Windows that causes a visible flash; skipping it during the drag eliminates the flicker (`main.js:613`).

Bounds are **persisted** (debounced) to `overlay-state.json` on every move/resize, and on quit (`persistBounds`, `main.js:785`).

---

## Idle-collapse (auto-hide to header strip)

After a configurable idle delay (default 25 s, range 5–120 s) with no mouse, keyboard, or scroll activity the overlay collapses to the header/tab strip height. It expands again on any interaction, when a new message arrives in the active channel, or when any @mention of the user arrives (see Mention auto-appear below).

Controlled by a JS idle timer in `shell.ts` that sends `overlay:collapse` / `overlay:expand` IPC messages to the main process. The main process animates the height change, keeping the top edge anchored so the overlay grows downward.

**Collapse height + the CSS-zoom gotcha.** The collapsed window height is computed by `headerStripHeight()` (`shell.ts`) = shell-bar height + the two tab rows, clamped to a plausible band (24–160 visual px) so a bad mid-reflow measurement can never reveal the message body/input. The strip is measured with `getBoundingClientRect()` on elements inside the CSS-`zoom`ed `#root`. **Whether that rect already includes the zoom depends on the Chromium build** — Chromium ≤127 (Electron ≤31) returned UNSCALED CSS-px; Chromium 138 (Electron 39, the current pin) returns zoom-SCALED px. `rectsAreZoomScaled()` detects this once (an offscreen `zoom:2` probe), and the pure `resolveCollapsedHeight()` (in `shell-core.ts`, unit-tested both ways) applies the zoom factor **only** when rects are unscaled. The earlier code multiplied unconditionally, which after the Electron 31→39 bump **double-applied** the zoom and left the window tall enough to reveal the text input at Scale > 1 — the "collapses to the input box instead of the tabs" bug.

**State variables** (`main.js:596`):

| Variable | Meaning |
|---|---|
| `collapsed` | `true` when the window is shrunken to header height |
| `expandedHeight` | Full height remembered before collapse |
| `expandedBounds` | Full `{x,y,width,height}` snapshot saved at collapse time |
| `collapseAnim` | Active height-animation interval handle |

When **collapsed**, `persistBounds()` stores `expandedHeight` (not the shrunken height) so a restart opens at the correct full size.

If a move or scroll-to-bottom command arrives while collapsed, the main process expands instantly (no animation) before processing the move, preventing the "window dances while dragging" bug (`main.js:1199`).

The "Auto-hide chat when idle" setting (`ShellSettings.fadeWhenIdle`, default `true`) toggles this behavior and maps to `OverlayConfig.FadeWhenIdle` in the WinForms desktop overlay.

The **"Auto-hide delay"** slider (Settings → Appearance) controls how long the overlay waits before collapsing. It is persisted as `ShellSettings.idleCollapseSeconds` (default 25, bounded 5–120 by `clampIdleCollapseSeconds` in `shell-core.ts`). The idle timer reads the live `idleFadeMs` value, which is updated immediately as the slider drags (`applyLive`) and on commit — no restart needed. Out-of-range or corrupted persisted values fall back to the default via the clamp.

---

## Mention auto-appear

When a live WebSocket `chat:message` arrives that mentions the current user,
`ChatOverlay.tsx` dispatches the appear event for **every** such mention — both
active-channel and cross-channel. Rationale: a collapsed/hidden overlay hides even
the active channel, so a mention there must still pop the overlay out.

```js
window.dispatchEvent(new CustomEvent('fcm-mention-appear', { detail: { chId } }))
```

> The unread badge / central "Jump to mention" button remain **cross-channel only**
> (gated on the mention NOT being in the active view). Only the appear trigger covers
> all mentions.

`shell.ts` listens for `fcm-mention-appear` and:

1. Calls `markActivity()` — resets the idle timer and un-collapses the header strip if collapsed.
2. Calls `window.relayBridge.showForMention?.()` — sends `overlay:show-for-mention` IPC to main.

`main.js` handles `overlay:show-for-mention`:

- Checks `canShowOverlay()`. If `false` (game not running, user not privileged / `forceVisible`), the request is ignored and logged.
- Clears `userHidden` — matching the game-launch transition behavior so the overlay stays visible once shown.
- Calls `showWindowInactive()` — shows the window without stealing keyboard focus from the game.
- Logs `[mention] showing overlay for cross-channel mention` to `main.log`.

**Constraints:**
- Does NOT pop the overlay over the desktop when Fallout 76 is not running (for regular users).
- Does NOT steal keyboard focus — `showWindowInactive()` not `showWindow()`.
- Clearing `userHidden` means if the user had explicitly hidden the overlay (Delete/tray Hide), a single @mention un-hides it once. The user must press Delete again to re-hide.
- When the overlay is already visible on the active channel, the trigger is a no-op — `markActivity()` just resets the idle timer; `showForMention`'s already-visible / `canShowOverlay` path does nothing. No flicker, no focus steal.

> **Device testing required.** The tray-unhide path cannot be verified in the browser/dashboard surface — it requires a real Electron overlay session with Fallout 76 running. Test: hide the overlay to tray, then receive an @mention (active channel AND a different channel); overlay should appear in both cases without stealing focus.

---

## Visibility gating (`canShowOverlay` / `reevaluateVisibility`)

The game gate decides whether a regular user's overlay may be shown. Implemented in `canShowOverlay()` (`main.js:448`):

```
Returns true when ANY of the following is true:
  1. forceVisible   — set by a mod/admin/owner via tray "Start overlay (no game)"
  2. isPrivileged() — role is moderator/admin/owner/developer
  3. gameRunning    — Fallout76.exe is in the process list
  4. !chatActive    — user has not completed onboarding/login yet
```

`reevaluateVisibility()` (`main.js:1848`) calls this gate and calls `_doShow()` or `hideWindow()` accordingly. It fires after:

- Game-detection state changes (`onGamePresenceChanged`)
- `chatActive` changes (`overlay:chat-active` IPC)
- Onboarding completion (`overlay:onboarding-complete` IPC)
- Authentication role update (after `startRelay` or Discord link)

---

## Game-process detection

A periodic scan runs every **2.5 seconds** via `scanForGame()` (`main.js:500`):

- **Windows**: `tasklist /FI "IMAGENAME eq Fallout76.exe" /FO CSV /NH`
- **Linux/macOS**: `ps -A -o command=` filtered for `/fallout76\.exe/i` (matches Proton)

To prevent flickering on transient scan failures, `onGamePresenceChanged()` uses **hysteresis** via the pure, unit-tested `overlayCore.nextPresenceState()` reducer:

- A **launch** must persist `PRESENCE_FLIP_SCANS_ON = 2` consecutive scans before `gameRunning` flips to `true`; an **exit** must persist `PRESENCE_FLIP_SCANS_OFF = 3` (held longer, so a single transient miss mid-game can't drop the overlay).
- A **failed scan** (`ps` error/timeout → `scanForGame` passes `found = null`) carries **no information**: it keeps the committed `gameRunning` and clears any pending flip. Previously a scan error was read as `found = false`, so a transient `ps` hiccup could flip the game "off" and yank the overlay — that was the game-scan flap.

On the **not-running → running transition**, `userHidden` is cleared automatically so the overlay auto-shows when the user launches the game (even if they previously hid it with Delete, `main.js:563`).

On **Windows**, a long-lived PowerShell process polls the foreground window via `GetForegroundWindow` + `GetWindowThreadProcessId` at ~300ms cadence. This drives z-order (topmost while the game is foreground, normal window otherwise) and click-through state.

### KDE Plasma / Wayland — active-window detection (`xdotool` / `kdotool`)

On **KDE Wayland**, Wayland's security model forbids clients from querying the active window, so the Windows foreground poll does not apply. Because FO76 (Proton) **and** the overlay itself run under **XWayland** on KDE, the standard X11 tool [`xdotool`](https://github.com/jordansissel/xdotool) can read the active window's WM_CLASS here; [`kdotool`](https://github.com/jinliu/kdotool) (a pure-Wayland, KWin D-Bus counterpart) is used as a fallback. Both share the syntax `<tool> getactivewindow getwindowclassname` and are polled at ~300ms intervals.

**How it works:**  
`_startForegroundPoller()` is called from `startForegroundZOrder()` when `KDE_WAYLAND` is true. It probes for **both** tools (`command -v xdotool; command -v kdotool`) so the crash circuit-breaker (below) can fall back to the other one, preferring `xdotool` when present:

- **tool present:** Sets `kdeWaylandForegroundDetect = true` and records `fgTool`. `_runForegroundPoll()` spawns the tool every 300ms; the printed WM_CLASS is lowercased into `lastForegroundProc`, and `applyZOrder()` / `applyFocusClickThrough()` / `refreshShortcuts()` are called on each change — mirroring the win32 PowerShell path. When a native-Wayland window is active, `xdotool getactivewindow` exits non-zero with no output (no active X window) — treated as "not the game", so the hotkeys are released.
- **neither tool present:** Logs a single diagnostic and leaves `kdeWaylandForegroundDetect = false`. `refreshShortcuts()` falls back to `gameRunning` as the gate for hotkey registration (the pre-existing behavior — no regression).

**Crash circuit-breaker (issue #272):**  
On some distros (confirmed **Fedora 44**, xdotool 3.x) the chained `getactivewindow getwindowclassname` aborts **inside libxdo** — a double-free in `xdo_get_window_classname` → `XFree` → `SIGABRT` — whenever the active window's WM_CLASS can't be read cleanly (routine under XWayland when a native-Wayland window is focused). Because the overlay re-spawns the tool every 300ms, this produces a **coredump storm** (≈3/sec, plus a burst during shutdown). Our JS error-handling can't prevent the per-spawn coredump, so the breaker stops re-spawning into the crash:

- The `close` handler distinguishes a **crash** (terminated by a signal) from a normal **non-zero exit** (no active X window — *not* a crash). Only signal deaths count.
- After `MAX_CONSEC_CRASHES = 3` back-to-back crashes, `decideForegroundPollerAction()` (`overlay-core.js`, unit-tested) returns either **`switch-tool`** — switch to the alternate tool (kdotool↔xdotool) if it's installed, tracked so it never ping-pongs back — or **`disable`** — stop the poller, set `kdeWaylandForegroundDetect = false`, and fall back to `gameRunning` gating. Either way the coredump storm stops after ≤3 cores. A clean poll resets the streak.
- On `disable`, a single diagnostic recommends installing **`kdotool`** (Wayland-native, no X11 double-free).

**WM_CLASS matching:**  
Under XWayland + Proton, FO76 reports its WM_CLASS as `steam_app_1151340` (confirmed on CachyOS; some Proton/Wine versions report `fallout76.exe`, and `project76_gamepass.exe` for the Game Pass build). `isGameClass()` in `overlay-core.js` matches all of these: `isGameProcess()` strips the `.exe` suffix for the exe-name forms, and `XWAYLAND_GAME_CLASSES` covers `steam_app_1151340`.

The overlay's own WM_CLASS (`Fallout Chat Mod` under XWayland) does **not** match `isGameClass()`, so the overlay window being focused is handled separately via `mainWindow.isFocused()`.

**Installing an active-window tool (KDE Wayland):**

`kdotool` is **recommended on Wayland** — it talks to KWin over D-Bus and has none of the libxdo X11 double-free problem described above, so it never produces the coredump storm. `xdotool` also works (and is preferred when both are installed, for parity with the dev's verified setup), but on distros where it crashes the breaker will auto-switch to `kdotool` if present, or disable detection otherwise.

```bash
# kdotool (recommended on Wayland) — https://github.com/jinliu/kdotool
#   Arch (AUR):  paru -S kdotool      Fedora/others: build from source (cargo)

# xdotool (alternative)
sudo pacman -S xdotool     # Arch / CachyOS / Manjaro
sudo dnf install xdotool   # Fedora / RPM-based
sudo apt install xdotool   # Ubuntu / Debian
```

Without either tool (or after the breaker disables a crashing `xdotool`), global hotkeys (Insert/Delete/Home) remain registered for the entire FO76 session — they work correctly but are not released when you switch to Konsole or Discord. This is a graceful degradation, not a failure.

---

## Z-order controller

`desiredTopmost()` (`overlay-core.js`, unit-tested) decides whether `setAlwaysOnTop` should be `true`: topmost while `forceVisible`, the overlay is focused, the game is the foreground process, or the game is `gameRunning` (session-long). `setAlwaysOnTop` maps to `_NET_WM_STATE_ABOVE` (KWin `AboveLayer`). On KWin 6 that alone loses to a *focused fullscreen* game, so the overlay being above the game is achieved by the **game keep-below KWin rule** (see below), not by `setAlwaysOnTop`. (`focusAwareTopmost` exists in the pure function for completeness but is **not** enabled — the overlay is a normal keep-above window above a kept-below game.)

`applyZOrder()` is idempotent (tracks `overlayIsTopmost`) and suppressed during drags. **When the overlay is hidden to tray, `applyZOrder()` RELEASES `setAlwaysOnTop` on Linux** (and stops the z-order heartbeat) instead of leaving the flag stuck — otherwise a hidden window kept holding the game demoted below the panel. On Windows the flag is kept while hidden (a hidden window doesn't affect stacking and re-toggling would DWM-flash on the next show). The overlay is a **NORMAL** window on all platforms (we tried `type:'notification'` for KDE stacking but reverted it — KWin's NotificationLayer is *below* the active-fullscreen layer, and notification windows are excluded from Alt-Tab/taskbar and non-focusable, so users couldn't tab into the chat).

**Windows**: calls `mainWindow.setAlwaysOnTop(want, 'screen-saver')` — the highest standard Electron level, avoids DWM recomposition flash.

**Linux/Proton**: tries `'pop-up-menu'` first (a higher XWayland stacking layer than `'screen-saver'`), falling back to `'screen-saver'`. Also re-calls `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` on every topmost assertion because some compositors reset this flag when the game window raises. A **3-second heartbeat timer** (`_linuxZOrderHeartbeat`) force-re-applies topmost while the game is running, catching cases where the X11/XWayland compositor silently drops `_NET_WM_STATE_ABOVE` on game-raise events. The heartbeat starts when `desiredTopmost()` first returns `true` and stops when it returns `false`. On the `'show'` event (restore from tray), `overlayIsTopmost` is force-cleared so `applyZOrder()` always re-asserts the correct level immediately.

---

## Click-through

`setIgnoreMouseEvents(ignore, { forward })` is wrapped in a single `setMouseIgnore()` helper that tracks the last applied state and skips no-op calls (`main.js:405`). This eliminates the DWM recomposition flash that occurs on Windows when the function is called redundantly.

Two modes:

| Mode | When active |
|---|---|
| **Interactive** | Overlay focused, or user pressed Insert |
| **Click-through** | Game is foreground (Windows) or overlay is blurred (Linux) |

Manual click-through (`End` key or tray item) overrides the automatic logic and forces click-through until the user toggles it off.

A **modal-interactive pin** (`overlay:set-modal` IPC) forces full interactivity while the settings or onboarding panel is open, so slider drags work regardless of click-through state (`main.js:1125`).

An 800ms focus guard (`FOCUS_GUARD_MS`) prevents the ~300ms foreground poll from flipping the overlay back to click-through immediately after the user presses Insert (`main.js:484`).

---

## Tray icon

A system tray icon (`tray`) provides:

- Left-click: toggle show/hide
- Right-click menu: Show / Hide / Focus to chat / Toggle click-through / Start overlay (no game, privileged only) / Check for updates / Quit

`hideWindow()` hides the window to the tray without quitting. The app stays running. **Quit** (tray or `✕` button) is the only way to exit.

---

## Scroll-to-bottom

`fcm-scroll-bottom` is an IPC-triggered command sent to the renderer (`overlay:command`, value `'scroll:bottom'`). The shell sends it automatically when the overlay is shown from a hidden state, so the user always sees the latest messages without manually scrolling.

---

## Opacity

Window opacity is implemented as a CSS variable rather than `setOpacity()`. The main process injects `--fcm-chrome-bg-alpha` via `executeJavaScript` when the opacity slider changes (`window:set-opacity` IPC, `main.js:1232`). This keeps text at full opacity while making the panel backgrounds more transparent.

---

## Position presets

Up to 8 position presets (Shift+F1..F8) can be saved. "SET POS" reads the current live bounds via `window:get-bounds` IPC; a preset hotkey sends `window:set-bounds` which clamps to the work area and applies. Presets are stored inside `ShellSettings.presets` in `overlay-state.json`.

---

## Insert focus-steal (Windows foreground-lock bypass)

Windows restricts which processes may call `SetForegroundWindow`. An overlay running behind an active fullscreen game cannot pull focus with `mainWindow.focus()` alone — the OS denies the request and focus stays with the game.

`_stealForegroundWin32()` is called on **both** paths of `focusToChat()` (hidden/tray restore AND already-visible): it calls `app.focus({ steal: true })`, Electron's built-in wrapper around `AllowSetForegroundWindow` + `SetForegroundWindow`, which bypasses the foreground-lock for the overlay process. Without this, pressing Insert does not deliver real keyboard focus to the chat input; the user still had to Alt-Tab.

The sequence in `focusToChat()` for the hidden/tray path is:
1. Clear `userHidden`
2. `mainWindow.setFocusable(true)` + `setClickThrough(false)`
3. `mainWindow.showInactive()` — shows the window without activating, preserving z-order
4. Force-clear `overlayIsTopmost` and call `applyZOrder()` — re-asserts always-on-top before stealing focus
5. `mainWindow.focus()` — standard Electron focus
6. `_stealForegroundWin32()` — `app.focus({ steal: true })` to bypass foreground-lock
7. `emitVisibility(true)` — signals the renderer that the overlay is visible again, allowing the hybrid WS gate to reconnect if it had been torn down by the 20s grace after an explicit hide. Without this the renderer's `overlayVisible` stays `false` and the WS never reconnects after a hide→Insert restore.
8. `sendToRenderer('overlay:focus-input', true)` — moves DOM focus to the chat input

## Return-to-game focus

After sending a chat message, the renderer sends `overlay:return-to-game` IPC. If the game is running, the main process:

1. Calls `mainWindow.blur()`
2. On **Windows**: spawns a one-shot PowerShell using `SetForegroundWindow` + `ShowWindow` + a synthetic ALT keypress (the standard workaround for Windows foreground-lock) to foreground `Fallout76.exe`
3. On **Linux**: tries `wmctrl -a Fallout76`, falling back to `xdotool search`

---

## KDE Plasma / Wayland — keep-above-the-game (KWin layer rule)

On KDE+Wayland the overlay forces the XWayland Ozone backend so it shares the same compositor stack as Fallout 76 under Proton. KWin therefore matches the overlay by its **X11 WM_CLASS**, which is `fallout-chat-mod`. The bundled rule (`assets/fallout-chatmod-keepabove.kwinrule`, also written to userData on launch) matches `wmclass=fallout-chat-mod`; the game is `wmclass=steam_app_1151340`, so the rules are exclusive.

> **Forcing XWayland on Electron 39 requires an argv relaunch — `appendSwitch` is too late.** Chromium 140 (Electron 38+) picks its Ozone platform from the real `argv` during early C++ bootstrap, *before* `main.js` runs. So `app.commandLine.appendSwitch('ozone-platform', 'x11')` (and the deprecated `ozone-platform-hint=x11`, which still worked on Electron ≤37) are **silently ignored** — the app stays on native Wayland, where it can't stack over the game *and* forces KWin out of direct scanout (game lag with no visible overlay). Verified on 39.8.10: only `--ozone-platform=x11` present on the actual argv forces XWayland. So when `KDE_WAYLAND` and that flag is absent from `process.argv`, `main.js` re-execs itself via `child_process.spawn` with `--ozone-platform=x11` appended + `app.exit(0)` once (argv-guarded so the child never re-relaunches; runs before `requestSingleInstanceLock` so the exiting parent holds no lock; uses `$APPIMAGE` because `process.execPath` is the transient `/tmp/.mount_*` path). `planOzoneRelaunch()` (`overlay-core.js`, unit-tested) decides this and also carries `env: { ELECTRON_OZONE_PLATFORM_HINT: 'x11' }` for the child — a belt-and-suspenders force in case a launcher (AppImageLauncher, a wrapper `.desktop`) mangles argv. The `appendSwitch` calls are kept as a no-op fallback / the route that still works on Electron ≤37.
>
> **Re-exec safety guard (issue #272 — "launches once, then the shortcut does nothing").** `planOzoneRelaunch()` returns `safe: false` when the only binary available is a transient AppImage FUSE mount (`/tmp/.mount_*`) **and** `$APPIMAGE` is unset — because `app.exit(0)` would unmount it before the child can start, so the child vanishes. In that case `main.js` does **not** re-exec/exit; it logs `[ozone] … UNSAFE …` and stays on native Wayland (degraded stacking) rather than disappearing. This is rare (the AppImage runtime normally exports `$APPIMAGE`); it shows up with some AppImageLauncher / wrapper launches. The `[ozone] relaunching for XWayland: exe=… $APPIMAGE=… args=…` diagnostic logged immediately before the spawn (and the failure log in the `catch`) pinpoint a launch failure from a user report. **The `.deb` avoids this path entirely** (no FUSE mount).

> **Do NOT call `app.setName()` to change the app_id.** The app name feeds `app.getPath('userData')` (`~/.config/Fallout Chat Mod`), so renaming it orphans every user's session/settings/keybinds on all platforms. KWin matches the XWayland WM_CLASS, so no app_id override is needed.

### Why "keep above" alone fails, and the force-Layer fix

Per KWin's `Window::layer()` the layer order (KWin 6.7) low→high is `Desktop(0) < Below(1) < Normal(2) < Above(3) < Notification(4) < Active/fullscreen(5) < Popup(6) < CriticalNotification(7) < OnScreenDisplay(8) < Overlay(9)`. Panels/docks resolve to `Above(3)`. Borderless-windowed games (FO76 included) routinely still set `_NET_WM_STATE_FULLSCREEN`, so a **focused** FO76 ranks in `ActiveLayer(5)` — above any `keepAbove` overlay (`Above(3)`) **and** above a `type:'notification'` overlay (`Notification(4)`). Nothing about `keepAbove` or window *type* can beat a focused active-fullscreen window.

**The fix — force the OVERLAY to the Overlay layer (`fcm-overlay-layer`).** KWin **6.0** added a Force **"Layer"** window rule (KDE Bug 441074 — the sanctioned "stay above fullscreen" mechanism for picture-in-picture). A rule of `layer=overlay` + `layerrule=2` (2 = Force) matched on `wmclass=fallout-chat-mod` puts the overlay in `OverlayLayer(9)` — **above** the active-fullscreen game — while the game **keeps its normal fullscreen stacking** (`ActiveLayer(5)`, which is above the panel), so there is **no "game below the taskbar."** The overlay also **keeps keyboard/text focus** because focusability derives from window *type* (still Normal), not layer — which is exactly why the old `type:'notification'` attempt failed. **Verified on KWin 6.7.1**: a matched window jumps from `layer=2` to `layer=9`. (An earlier code comment claimed `layer`/`layerrule` was "ignored by KWin 6" — that was never tested with this exact rule; it works.) Optionally `layer=critical-notification(7)` still beats the game while leaving system OSDs/critical notifications above the chat; we default to `overlay`.

**`fcm-game-below` is now an OPT-IN FALLBACK (default OFF).** The old fix forced the *game* `below=true` (`BelowLayer(1)`) so a keep-above overlay out-ranked it — but `BelowLayer` is also below the panel, so the game appeared under the taskbar. The force-Layer rule makes that unnecessary, so game-below is off by default; it remains a toggle for the rare setup where the force-Layer rule doesn't take. When enabled it is **visibility-gated** (pure `overlayCore.shouldForceGameBelow({ gameRunning, overlayVisible, gameBelowEnabled })`, unit-tested): `syncKwinGameBelow()` (window `hide`/`show` + game-gate) only applies it while the overlay is visible over a running game, and `applyZOrder()` releases `setAlwaysOnTop` when the overlay hides. This replaced the retired `fcm-game-demote` (`fullscreen=false` Force) rule, which fought the game's fullscreen state and flickered (issue #272).

### How the rules get applied (automatic on startup)

`setupKdeKeepAbove({ interactive })` writes the rule(s) into `~/.config/kwinrulesrc` via `kwriteconfig6`, then `qdbus org.kde.KWin /KWin reconfigure` (falls back to `qdbus6`/`qdbus-qt6`):

- `fcm-keepabove` — keep-above on the overlay (`wmclass=fallout-chat-mod`, `above=true`). **Always applied** (belt-and-suspenders under the force-Layer rule).
- `fcm-overlay-layer` — **force `layer=overlay` on the overlay** (`wmclass=fallout-chat-mod`, `layerrule=2`). **Always applied** — THE fix; overlay above the fullscreen game, game not demoted.
- `fcm-game-below` — keep-below on the game (`wmclass=steam_app_1151340`, `below=true` Force). **Opt-in fallback, default OFF** (`settings.kwinGameBelow`; tray → "Fallback: force game below overlay"; the CLI installer also prompts). When on, it is visibility-gated (`shouldForceGameBelow`) and removed when the overlay hides.

**KWin 6 format (verified):** the authoritative rule list is `[General] rules=`, a **comma-separated list of group NAMES** (plus a matching `count`). Writing numbered groups with only `count` is **not** enough — KWin rewrites `count` and drops the rules. We use **stable named groups** (so re-runs are idempotent and never collide with the user's own numbered rules) and **append** our names to any existing `rules=` list (preserving user rules). `buildKwinKeepAboveScript({ includeBelow })` (unit-tested) emits keep-above + overlay-layer always, game-below only when opted in; its idempotency check matches the expected rule set exactly so toggling the option always rewrites.

- **Automatic:** on **KDE+Wayland** it runs at startup (`app.whenReady`, `interactive: false`) so the overlay sits above the game for every user with **no manual step**. **Idempotent** — it exits early when `rules=` already holds exactly the expected set, so repeated launches never duplicate rules or reconfigure needlessly.
- **Manual retry:** tray → **"KDE: keep overlay above game"** (`interactive: true`) additionally opens the userData folder for a hand import (System Settings → Window Rules → Import) if the automatic path fails (older KWin, missing `kwriteconfig6`, non-KDE).

All paths are best-effort and no-op gracefully when the KDE tools are absent. Non-KDE-Wayland Linux sessions only get the helper files written to userData (no `kwinrulesrc` edit).

> **XWayland forcing has a side effect: drag-to-move under fractional scaling.** Forcing XWayland (required for stacking) means the overlay no longer gets native-Wayland fractional scaling. On mixed-DPI KDE setups (e.g. monitors at 1.0 + 1.25 + 1.45), a frameless drive-the-move-from-JS drag that re-reads `getBounds()` each tick feeds geometry back through KWin's scale and the window **grows on every move event**. Fix: the drag handler captures the window size **once** at `overlay:move-start` and commands that exact size every `overlay:move-tick` via `setBounds` (never re-reading `getBounds` mid-drag), so the size can't compound.

---

## Cross-links

- Keybind system: `keybinds.md`
- Update notification: `auto-update.md`
- Overview: `README.md`
