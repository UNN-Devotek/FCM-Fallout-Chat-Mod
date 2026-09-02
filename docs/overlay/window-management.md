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

On **Linux**, where CSS drag can drift under fractional DPI scaling, move events are routed through `overlay:move-start` / `overlay:move-tick` / `overlay:move-end`. The main process reads the authoritative cursor position via `screen.getCursorScreenPoint()` on each tick and applies the result through the guarded bounds helper (`setWindowBoundsGuarded` in `main.js`).

A `isDragging` flag suppresses the z-order heartbeat during drags. `setAlwaysOnTop` on a transparent window triggers a DWM recomposition on Windows that causes a visible flash; skipping it during the drag eliminates the flicker (`main.js:613`).

**Known limitation.** On Linux, `isDragging` never becomes `true` during a drag. The JS-driven `move-start`/`move-tick`/`move-end` path doesn't trigger Electron's `will-move`/`moved` events, which are what set it. Pre-existing, unrelated to focus-gated visibility, noted here for reference rather than fixed.

Bounds are **persisted** (debounced) to `overlay-state.json` on every move/resize, and on quit (`persistBounds`, `main.js:785`). Every runtime `setBounds` and move path is routed through `setWindowBoundsGuarded`, which re-resolves the destination display and clamps the full rect to its work area. This includes collapse animation and modal-fit writes, so the overlay top can never move above the selected display's work-area origin after a drag, resize, restore, or DPI change.

**Drift suppression on fractional scaling (issue #427).** On a fractionally-scaled display the
DIP -> physical -> DIP round-trip does not return the value we asked for: commanding `560x720`
reads back as `562x722`. Persisting that made it the input to the next `setBounds`, so the window
grew about **1px per axis per cycle, forever, and never shrank** — measured on a 1.247x display,
`536x480` at session start became `552x498` after ~27 `setBounds` events. Relaunches compounded it
too, since startup clamps the persisted value and commands it again.

`persistBounds()` now runs the size through `resolvePersistedSize(observed, lastPersisted)`
(`overlay-core.js`): if the observation is within `BOUNDS_DRIFT_TOLERANCE_PX` (2) of the last
persisted size on **both** axes, it is rounding noise and the previous value is kept, so the error
can never accumulate. A change beyond the tolerance on *either* axis is a real resize and is stored
normally.

Two deliberate choices:

- **The loop is closed at the persist boundary, not at the 11 `setBounds` call sites.** Several of
  those are per-frame collapse-animation writes that must not be mistaken for user intent.
- **`lastPersistedSize` is seeded in `createWindow()`** from the size the window actually opens at.
  Without that seed the first save of each session has no reference and banks one drift step per
  launch.

Skipped while collapsed or modal-inflated, where the persisted value is already a *remembered* size
rather than a live measurement. Tradeoff: a deliberate resize of <=2px is also ignored — at a
fractional scale factor that is under one physical pixel of handle movement, and unbounded growth is
the worse failure. Covered by `__tests__/bounds-drift.test.js`, including a 200-iteration
feedback-loop test that fails if accumulation returns.

---

## Modal-fit growth (temporary resize for settings / onboarding)

The shell settings (`#shell-settings`) and onboarding (`#shell-onboarding`) panels are
plain DOM rendered **inside the overlay's own BrowserWindow**, so their CSS caps
(`max-width: 96vw`, `max-height: 90vh` in `index.html`) resolve against the *overlay*, not
the screen. An overlay kept compact for gameplay — it can go down to
`MIN_WIDTH` x `MIN_HEIGHT` (320x280) — squeezes the settings panel to roughly 307x252,
which made settings impractical to use without first resizing the overlay
([#374](https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod/issues/374)).

Portalling cannot fix this: nothing rendered in the renderer can paint outside its own OS
window. So the main process grows the window while a modal is open and restores the
user's size on close, riding the existing `overlay:set-modal` signal:

| Behavior | Detail |
| --- | --- |
| Trigger | `overlay:set-modal` — the same IPC that drives the modal-interactive pin |
| Target size | `MODAL_FIT_WIDTH` x `MODAL_FIT_HEIGHT` = 560x720 (`overlay-core.js`) |
| Grow only | Never shrinks a window the user already made large enough, per axis |
| Clamped | Result passes through `clampToWorkArea`, so it stays on-screen |
| Restore | Size only — live x/y is kept, so a window moved while the modal was open is not teleported back |
| Explicit size wins | A **position-preset hotkey** (`window:set-bounds`, Shift+F1..F8) is global and still fires while a modal is open; it carries its own width/height, so it drops the restore snapshot and the preset sticks. `overlay:resize-bounds` clears the snapshot too, though the shell already disables the edge-resize zones while a modal is open (`rzVisible = !collapsed && !modalOpen`), so that path is defensive only |
| Never persisted | While inflated, `persistBounds()` writes the **pre-modal** size, so the temporary size can't leak into `overlay-state.json` via the debounced save or the before-quit save |
| Collapsed / animating | Skipped while idle-collapsed **and** while a collapse/expand animation is running. `animateHeightTo()` freezes the width at animation start and re-applies it every frame, so growing mid-flight would be fought and reverted — and the snapshot would capture a meaningless interim size that we would then "restore" |
| Drift-corrected baseline | `growWindowForModal()` runs the live `getBounds()` width/height through `resolvePersistedSize()` (the same tolerance-snap [drift suppression](#drag-and-resize) issue #427 uses for the disk-persist boundary) against `modalFitLastGoodSize`, a baseline that — unlike `modalFitPrevBounds` — survives across grow/restore cycles. See below. |

The sizing decision is the pure `modalFitBounds(current, workArea, need)` in
`overlay-core.js` (returns `null` when no growth is needed or possible, meaning there is
nothing to restore); `main.js` holds the snapshot in `modalFitPrevBounds` and does the
Electron wiring. Covered by `__tests__/overlay-modal-fit.test.js`.

**Live-cycle drift suppression (HOME-key-spam regression).** The HOME key toggles the
settings modal open/closed on every press (`toggleSettings()` in `shell.ts`), so each press
drives one full `growWindowForModal()`/`restoreWindowAfterModal()` round-trip. On a
fractionally-scaled Linux session `setBounds()` doesn't return what was commanded — issue
#427's own bug report captured this happening in this exact path:

```
[modal-fit] growing   538x482 -> 560x720 for modal
[modal-fit] restoring 562x722 -> 538x482 after modal
```

`restoreWindowAfterModal()` correctly *commanded* `538x482`, but the compositor echoed back
`540x484` on the next read. #427's fix (`resolvePersistedSize`) only protects what gets
*persisted* to `overlay-state.json`, not this in-memory grow/restore loop — so
`growWindowForModal()` re-reading a live, already-drifted `getBounds()` as its baseline let
the size creep ~1-2px **per HOME press**, forever. `growWindowForModal()` now resolves its
live baseline through `resolvePersistedSize()` against `modalFitLastGoodSize` (a variable
declared alongside `modalFitPrevBounds`) before deciding how much to grow, snapping out
rounding noise the same way the persist boundary does. Both `window:set-bounds` (position
presets) and `overlay:resize-bounds` clear `modalFitLastGoodSize` alongside
`modalFitPrevBounds`, so a genuine mid-cycle resize isn't snapped back to a stale baseline.
Covered by the "drift suppression across repeated open/close cycles" tests in
`__tests__/overlay-modal-fit.test.js`.

Note this affects the **Electron shell** panels only. On the website/dashboard the React
`SettingsModal` in `ChatOverlay.tsx` sizes against the browser viewport, which is already
large, so no change was needed there.

---

## Idle-collapse (auto-hide to header strip)

After a configurable idle delay (default 25 s, range 5–120 s) with no mouse, keyboard, or scroll activity the overlay collapses to the header/tab strip height. It expands again on any interaction, when a new message arrives in the active channel, or when any @mention of the user arrives (see Mention auto-appear below).

Controlled by a JS idle timer in `shell.ts` that sends `overlay:collapse` / `overlay:expand` IPC messages to the main process. The main process animates the height change, keeping the top edge anchored so the overlay grows downward.

**Reset on re-show.** The idle tick keeps firing while hidden (focus-gated hide, tray, game-exit). `shell.ts` listens for `overlay:visibility` (`relayBridge.onVisibility`) and calls `markActivity()` on `true`, so a long tab-away doesn't re-show already collapsed. `false` must not call it; that would expand the window while it's hiding. Predicate: `shouldResetIdleOnVisibility` in `shell-core.ts` (unit-tested). ChatOverlay.tsx listens to the same IPC for its WS reconnect gate; idle-collapse stays shell-owned, not shared.

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

**Typing indicator while collapsed (issue #420).** The normal typing indicator is a `flexShrink:0` sibling *below* the message list, so `applyCollapsedHidden()` hides it along with everything after the sub-tab row. A compact indicator is therefore also rendered **inside** the sub-tab row itself (`[data-fcm-subtab-row]`), which survives collapse by construction — no change to `headerStripHeight()`, deliberately, since that function has a history of zoom double-apply bugs (see above). It is gated on `ShellSettings.showTypingWhenCollapsed` (default **off** — opt in via Settings → "Show typing indicator while collapsed") and is Electron-shell-only; nothing collapses on the website. The shell emits `fcm-overlay-collapse-state` with `{ collapsed }` on **both** transitions for this — kept separate from the older one-way `fcm-overlay-collapsed` signal, which existing listeners treat as "close your floating panels" and which must not fire on expand.

The "Auto-hide chat when idle" setting (`ShellSettings.fadeWhenIdle`, default `true`) toggles this behavior and maps to `OverlayConfig.FadeWhenIdle` in the WinForms desktop overlay.

**Auto-hide mode.** The Electron Appearance panel stores `ShellSettings.autoHideMode` as
`full` (the default) or `subtabs`. `subtabs` keeps the existing two-row navigation strip
visible. `full` adds `fcm-full-auto-hidden` to the renderer and asks the main process to
animate the native window to the guarded `FULL_AUTO_HIDE_HEIGHT` of 1 DIP. It does not call
the user-hidden/tray path: the renderer and relay remain alive, so `markActivity()` can
expand the complete window when a new message, mention, or explicit interaction arrives.
The global focus/Insert path also force-expands it. Switching back to `subtabs` or resetting
defaults is safe because the normal expand path restores native minimum/maximum sizing and
removes the full-hide class.

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

On KDE-Wayland a **second** gate sits on top: `nextGameFocusState` hides the overlay when FO76 loses focus, even while `canShowOverlay()` is true. See [Focus-gated visibility](#focus-gated-visibility-hide--show).

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

### KDE Plasma / Wayland — active-window detection (`kdotool` / `xdotool`)

On **KDE Wayland**, Wayland's security model forbids clients from querying the active window, so the Windows foreground poll does not apply. [`kdotool`](https://github.com/jinliu/kdotool) (KWin D-Bus) is **preferred**: it sees **every** window — native-Wayland (Konsole, Wayland Firefox) *and* XWayland (FO76 under Proton) — so hotkeys release correctly whichever kind of app you tab to. The standard X11 tool [`xdotool`](https://github.com/jordansissel/xdotool) is the fallback: because FO76 and the overlay run under XWayland it can read the *game's* WM_CLASS, but it **cannot see native-Wayland windows** — with the game running, tabbing to a native-Wayland app reads as "no active X window", which the `(null)`-class heuristic treats as "probably the fullscreen game", so **hotkeys stay captured** in that app. Both tools share the syntax `<tool> getactivewindow getwindowclassname` and are polled at ~300ms intervals.

The same poller also runs on **plain X11** sessions (any window manager: i3, xfwm, openbox, KDE-X11, GNOME-X11, etc.). X11 exposes the active window without a portal, so `xdotool` is preferred there (`kdotool` is only a fallback). X11 never needed a KWin stacking rule: there is no active-fullscreen-window promotion outside KWin to fight. What is new for X11 is hide-on-alt-tab and hotkey-release once a tool is present. Without `xdotool` (or `kdotool`), X11 keeps the old `gameRunning` fallback.

On **Hyprland** (Wayland, not KWin) the poller uses `hyprctl` instead: `hyprctl activewindow -j` for the focused class, `hyprctl clients -j` for FO76's `{x,y}` (same-output probe), and `hyprctl dispatch pin address:<addr>` to pin the overlay while the game runs on the same output. The display probe is fail-closed: stacking remains ordinary until the shared output is known. Before dispatching, the overlay's `pinned` state is read and the result is queried again afterward, because `dispatch pin` is toggle-like; an unknown or failed helper leaves the last confirmed state unchanged and retries on a later probe. Implemented as best-effort; **not verified on real Hyprland hardware**, so the Linux `setAlwaysOnTop` heartbeat stays active there as a fallback (see `main.js` `_startLinuxZOrderHeartbeat`). Missing or failing `hyprctl` logs a diagnostic and no-ops.

This signal now also drives **overlay visibility**, not just hotkeys. `nextGameFocusState` (`overlay-core.js`) hides the overlay when FO76 loses focus to a recognized other window and shows it again when focus returns. Typing into the overlay counts as "still focused," so it never disappears mid-use.

**How it works:**  
`_startForegroundPoller()` is called from `startForegroundZOrder()` when `KDE_WAYLAND`, `IS_X11`, or `IS_HYPRLAND` is true. It probes for **all three** tools (`command -v kdotool; command -v xdotool; command -v hyprctl`) so the crash circuit-breaker (below) can fall back to an alternate when one is installed. `preferredForegroundTools()` sets the order: `hyprctl` only on Hyprland, `kdotool` first on KDE-Wayland, `xdotool` first on X11.

- **tool present:** Sets `foregroundDetect = true` and records `fgTool`. `_runForegroundPoll()` spawns the tool every 300ms. The printed WM_CLASS is lowercased into `lastForegroundProc`, and `applyZOrder()` / `applyFocusClickThrough()` / `refreshShortcuts()` (and the focus-gated visibility reducer) are called on each change, mirroring the win32 PowerShell path. Empty output on a clean exit is a valid "not the game" signal (kdotool: genuinely no active window; xdotool: no active *X* window, see the caveat above).
- **neither tool present:** Logs a single diagnostic and leaves `foregroundDetect = false`. `refreshShortcuts()` falls back to `gameRunning` as the gate for hotkey registration (the pre-existing behavior — no regression).

**Crash circuit-breaker (issue #272):**
On some distros (confirmed **Fedora 44**, xdotool 3.x) the chained `getactivewindow getwindowclassname` aborts **inside libxdo** — a double-free in `xdo_get_window_classname` → `XFree` → `SIGABRT` — whenever the active window's WM_CLASS can't be read cleanly (routine under XWayland when a native-Wayland window is focused). Because the overlay re-spawns the tool every 300ms, this produces a **coredump storm** (≈3/sec, plus a burst during shutdown). Our JS error-handling can't prevent the per-spawn coredump, so the breaker stops re-spawning into the crash:

- The `close` handler distinguishes a **crash** (terminated by a signal) from a normal **non-zero exit** (no active X window — *not* a crash). Only signal deaths count.
- After `MAX_CONSEC_CRASHES = 3` back-to-back crashes, `decideForegroundPollerAction()` (`overlay-core.js`, unit-tested) returns either **`switch-tool`** — switch to the alternate tool (kdotool↔xdotool) if it's installed, tracked so it never ping-pongs back — or **`disable`** — stop the poller, set `foregroundDetect = false`, and fall back to `gameRunning` gating. Either way the coredump storm stops after ≤3 cores. A clean poll resets the streak.
- On `disable`, a single diagnostic recommends installing the alternate tool (`kdotool` preferred — Wayland-native, no X11 double-free).

**WM_CLASS matching:**  
Under XWayland + Proton, FO76 reports its WM_CLASS as `steam_app_1151340` (confirmed on CachyOS; some Proton/Wine versions report `fallout76.exe`, and `project76_gamepass.exe` for the Game Pass build). `isGameClass()` in `overlay-core.js` matches all of these: `isGameProcess()` strips the `.exe` suffix for the exe-name forms, and `XWAYLAND_GAME_CLASSES` covers `steam_app_1151340`.

The overlay's own WM_CLASS (`Fallout Chat Mod` under XWayland) does **not** match `isGameClass()`, so the overlay window being focused is handled separately via `mainWindow.isFocused()`.

**Installing an active-window tool (KDE Wayland):**

`kdotool` is **recommended and preferred when both are installed** — it talks to KWin over D-Bus, sees native-Wayland windows (so keys release correctly in Konsole/Firefox), and has none of the libxdo X11 double-free problem described above, so it never produces the coredump storm. `xdotool` also works as the fallback, with the native-Wayland blindness caveat; on distros where it crashes, the breaker will auto-switch to `kdotool` if present, or disable detection otherwise.

```bash
# kdotool (preferred) — https://github.com/jinliu/kdotool
paru -S kdotool            # Arch / CachyOS / Manjaro (AUR; or yay -S kdotool)
sudo dnf install kdotool   # Fedora (official repos)
#                          # others: build from source (cargo)

# xdotool (fallback — cannot see native-Wayland windows)
sudo pacman -S xdotool     # Arch / CachyOS / Manjaro
sudo dnf install xdotool   # Fedora / RPM-based
sudo apt install xdotool   # Ubuntu / Debian
```

Without either tool (or after the breaker disables a crashing tool with no alternate), global hotkeys (Insert/Delete/Home) remain registered for the entire FO76 session — they work correctly but are not released when you switch to Konsole or Discord. This is a graceful degradation, not a failure.

### Known limitation — gamescope grabs input below X11 (hotkeys/drag cannot work)

Running FO76 inside **gamescope** with `--force-grab-cursor` (definitive) or `-f` fullscreen (likely) makes gamescope grab the keyboard/mouse at the **evdev level, below X11** — so while in-game the overlay can never receive its global hotkeys (Insert/Delete/Home/PgUp/PgDn) or window-drag events, no matter what the overlay does. This is a hard limitation, not a bug the overlay can work around. The overlay **detects** this (`classifyInputGrab()` in `overlay-core.js`, unit-tested, fed from the game-scan's `ps` output) and logs an actionable `[input-grab]` diagnostic: remove `--force-grab-cursor` from the FO76 launch options and/or run **borderless windowed** instead of `gamescope -f`. See also the general guidance: do **not** run the game inside gamescope for overlay purposes — its nested compositor isolates the game (README).

---

## Z-order controller

`desiredTopmost()` (`overlay-core.js`, unit-tested) keeps a visible overlay above normal desktop windows so it can receive a click even when another app is foreground. `setAlwaysOnTop` maps to `_NET_WM_STATE_ABOVE` (KWin `AboveLayer`). Mouse input remains ignored while the game is foreground (or manual click-through is enabled), so topmost does not steal gameplay clicks. On KWin 6 that alone loses to a *focused fullscreen* game, so the overlay being above the game is achieved by the **`fcm-keepabove` rule's force-Layer property** (see below), not by `setAlwaysOnTop`. The Force `layer` rule still trumps any `setAlwaysOnTop(false)`; visibility gating, not lowering, controls whether the overlay is present.

`applyZOrder()` is idempotent (tracks `overlayIsTopmost`) and suppressed during drags. **When the overlay is hidden to tray, `applyZOrder()` RELEASES `setAlwaysOnTop` on Linux** (and stops the z-order heartbeat) instead of leaving the flag stuck — a hidden window must not keep holding the game out of exclusive fullscreen. On Windows the flag is kept while hidden (a hidden window doesn't affect stacking and re-toggling would DWM-flash on the next show). The overlay is a **NORMAL** window on all platforms (we tried `type:'notification'` for KDE stacking but reverted it — KWin's NotificationLayer is *below* the active-fullscreen layer, and notification windows are excluded from Alt-Tab/taskbar and non-focusable, so users couldn't tab into the chat).

**Windows**: calls `mainWindow.setAlwaysOnTop(want, 'screen-saver')` — the highest standard Electron level, avoids DWM recomposition flash.

**Linux/Proton**: tries `'pop-up-menu'` first (a higher XWayland stacking layer than `'screen-saver'`), falling back to `'screen-saver'`. Also re-calls `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` on every topmost assertion because some compositors reset this flag when the game window raises. A **3-second heartbeat timer** (`_linuxZOrderHeartbeat`) force-re-applies topmost while the game is running, catching cases where the X11/XWayland compositor silently drops `_NET_WM_STATE_ABOVE` on game-raise events. **Skipped on KDE-Wayland**, where the Force-layer rule self-heals via KWin's window-raise and other property-change handling. Still runs on **non-KDE Linux**, which has no rule to lean on. Where it runs, it starts when `desiredTopmost()` first returns `true` and stops when it returns `false`. On the `'show'` event (restore from tray), `overlayIsTopmost` is force-cleared so `applyZOrder()` always re-asserts the correct level immediately.

---

## Click-through

`setIgnoreMouseEvents(ignore, { forward })` is wrapped in a single `setMouseIgnore()` helper that tracks the last applied state and skips no-op calls (`main.js:405`). This eliminates the DWM recomposition flash that occurs on Windows when the function is called redundantly.

Two modes:

| Mode | When active |
|---|---|
| **Interactive** | Overlay focused, or a non-game app is foreground |
| **Click-through** | Game is foreground, or manual click-through is enabled |

Manual click-through (`End` key or tray item) overrides the automatic logic and forces click-through until the user toggles it off. On Linux, the active-window detector is used when available; without one, the process-running state is the fallback. Keeping the overlay interactive over other apps is required so a user click can focus it and trigger the topmost re-assertion.

A **modal-interactive pin** (`overlay:set-modal` IPC) forces full interactivity while the settings or onboarding panel is open, so slider drags work regardless of click-through state (`main.js:1125`). The same signal also drives [modal-fit growth](#modal-fit-growth-temporary-resize-for-settings--onboarding).

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

**The fix — force the OVERLAY to the Overlay layer (the `fcm-keepabove` rule's `layer` property).** KWin **6.0** added a Force **"Layer"** window rule (KDE Bug 441074 — the sanctioned "stay above fullscreen" mechanism for picture-in-picture). A `layer=overlay` + `layerrule=2` (2 = Force) property matched on `wmclass=fallout-chat-mod` puts the overlay in `OverlayLayer(9)` — **above** the active-fullscreen game — while the game **keeps its normal fullscreen stacking** (`ActiveLayer(5)`, which is above the panel), so there is **no "game below the taskbar."** The overlay also **keeps keyboard/text focus** because focusability derives from window *type* (still Normal), not layer — which is exactly why the old `type:'notification'` attempt failed. **Verified on KWin 6.7.1**: a matched window jumps from `layer=2` to `layer=9`. (An earlier code comment claimed `layer`/`layerrule` was "ignored by KWin 6" — that was never tested with this exact rule; it works.) Optionally `layer=critical-notification(7)` still beats the game while leaving system OSDs/critical notifications above the chat; we default to `overlay`. This force-Layer property is combined into the **same rule** as the plain keep-above property below (both always target the same overlay window, so one KWin rule is enough) — earlier builds shipped them as two separate named groups (`fcm-keepabove` + `fcm-overlay-layer`); they were merged.

**Game demotion is fully REMOVED — the game's stacking is never touched.** History, for anyone reading old logs/configs: the original fix was `fcm-game-demote` (`fullscreen=false` Force), which fought the game's fullscreen state and flickered endlessly (issue #272); it was replaced by `fcm-game-below` (`below=true`, `BelowLayer(1)`), which worked but also dropped the game below the panel *and every other window*, so it was demoted to an opt-in fallback once the force-Layer rule landed — and has now been **removed entirely** (the force-Layer rule covers all supported setups; Plasma 5 lacks `kwriteconfig6`, so the fallback could never apply there anyway). The rule-install script still **strips a stale `fcm-game-below`** from installs that had opted in, on the next launch. If a setup ever genuinely needs it, the manual System Settings → Window Rules import path remains available.

### Focus-gated visibility (hide / show)

Visibility is **focus-gated** via a debounced reducer, `nextGameFocusState` (`overlay-core.js`):

- **Hides** when FO76 loses focus to a recognized other window; **shows** again when focus returns.
- Typing into the overlay counts as "still focused," so it never disappears mid-use.
- Hide/show, not `setAlwaysOnTop(false)`. The Force `layer` rule would trump any always-on-top flip.

The `fcm-keepabove` rule is no longer installed permanently at startup. It installs only while the game runs **and** the overlay shares its monitor, and is removed otherwise (game exit, or overlay dragged elsewhere).

On a **different monitor**, no rule installs at all. The overlay is a plain window (default KWin stacking). This is safe because KWin's `isActiveFullScreen()` (`window.cpp`) is already **per-output aware**, so a fullscreen game stays promoted even when focus moves to a *different*-output window. There's no stacking contest to win there.

### How the rule gets applied (session- and output-scoped)

`setupKdeKeepAbove(onDone)` writes the rule into `~/.config/kwinrulesrc` via `kwriteconfig6`, then `qdbus org.kde.KWin /KWin reconfigure` (falls back to `qdbus6`/`qdbus-qt6`):

- `fcm-keepabove`: ONE rule on the overlay (`wmclass=fallout-chat-mod`) combining `above=true` (belt-and-suspenders) and `layer=overlay`/`layerrule=2` (THE fix, putting the overlay above the fullscreen game without demoting it). **Installed only while FO76 runs and the overlay shares its display**; removed on game exit or a monitor change.

**KWin 6 format (verified):** the authoritative rule list is `[General] rules=`, a **comma-separated list of group NAMES** (plus a matching `count`). Writing numbered groups with only `count` is **not** enough — KWin rewrites `count` and drops the rules. We use a **stable named group** (so re-runs are idempotent and never collide with the user's own numbered rules) and **append** our name to any existing `rules=` list (preserving user rules). `buildKwinKeepAboveScript()` (unit-tested) emits exactly the one `fcm-keepabove` rule; its idempotency check matches that rule set exactly, so any stale FCM rule (numbered groups, `fcm-game-demote`, `fcm-game-below`, or a pre-merge `fcm-overlay-layer` from older builds) forces the strip + rewrite path.

**Native-Wayland spike (opt-in, off by default):** everything above describes the shipped
default — the overlay always relaunches into XWayland on KDE-Wayland first (see above), so
`wmclass` always means the X11 property. There is a dev-only `FCM_NATIVE_WAYLAND=1` env flag
that skips that relaunch and stays on native Wayland instead; `buildKwinKeepAboveScript()` is
unmodified for that path because KWin's `wmclass` matcher is expected to also catch the
Wayland `app_id` (pinned to the same `fallout-chat-mod` string via `package.json`'s top-level
`desktopName`). This is an experimental, unverified spike, not a supported mode — see the "Phase-0 spike"
section of [linux-overlay-approaches.md](linux-overlay-approaches.md) for the manual test
protocol and the open blocker (KDE bug 485409, cursor-lock coexistence).

- **Automatic:** on **KDE+Wayland** the rule installs/removes as game/output conditions change (not a one-shot at `app.whenReady`). **Idempotent**: exits early when `rules=` already matches, so repeated installs never duplicate or reconfigure needlessly. A matching remove path strips `fcm-keepabove` when the overlay should be ordinary.
- **Manual fallback (e.g. Plasma 5, missing `kwriteconfig6`):** the `.kwinrule` file is written to userData on every launch (`writeLinuxHelperFiles`); import it by hand via System Settings → Window Rules → Import, then `qdbus org.kde.KWin /KWin reconfigure`.

All paths are best-effort and no-op gracefully when the KDE tools are absent. Non-KDE-Wayland Linux sessions only get the helper files written to userData (no `kwinrulesrc` edit).

### Optional: hide the taskbar while in-game (KDE)

The force-Layer rule lifts the *overlay* above the game, but it doesn't move the *game* — and KWin's fullscreen promotion is **focus-gated**: a borderless FO76 (which still sets `_NET_WM_STATE_FULLSCREEN`) ranks in `ActiveLayer(5)` — above the panel — **only while it is the active window**. The moment it loses focus, it drops to `NormalLayer(2)`, below the panel (`Above(3)`), and the taskbar's edge pops over the game. The overlay itself triggers this constantly: **focusing the chat to type** takes active status away from the game, so the taskbar appears over the game exactly while you're typing. Opt-in tray toggle **"Hide taskbar while in-game (KDE)"** (`settings.kdePanelHideInGame`, **default OFF**) sets every Plasma panel to `autohide` while the overlay is visible over a running game, and restores the user's exact per-panel modes afterward.

- Mechanism: plasmashell `evaluateScript` over D-Bus (`qdbus6`/`qdbus-qt6`/`qdbus`, probed). Pure `overlayCore.buildPanelHidingSaveScript` / `parsePanelHidingSave` / `buildPanelHidingSetScript` / `buildPanelHidingRestoreScript` (unit-tested) build/parse the JS; `main.js` runs it.
- Gated by `overlayCore.shouldHidePanelInGame({ gameRunning, overlayVisible, enabled })` and driven by `syncPanelHideInGame()` on window show/hide + game-gate transitions (never the heartbeat). Note: this is **independent of any game demotion** — the panel outranking an *inactive* fullscreen-state window is normal KWin layering, so this feature stands on its own.
- **Crash-safe:** the captured original per-panel modes are written to `userData/.fcm-panel-hiding.json` *before* switching to autohide; that file's existence means "panels hidden, not yet restored." It's restored (and deleted) when the game exits / overlay hides / app quits (`before-quit`), and — if a crash skipped that — on the **next startup**. Handles multiple panels/monitors; skips gracefully if Plasma widgets are locked.

> **XWayland forcing has a side effect: drag-to-move under fractional scaling.** Forcing XWayland (required for stacking) means the overlay no longer gets native-Wayland fractional scaling. On mixed-DPI KDE setups (e.g. monitors at 1.0 + 1.25 + 1.45), a frameless drive-the-move-from-JS drag that re-reads `getBounds()` each tick feeds geometry back through KWin's scale and the window **grows on every move event**. Fix: the drag handler captures the window size **once** at `overlay:move-start` and commands that exact size every `overlay:move-tick` via `setBounds` (never re-reading `getBounds` mid-drag), so the size can't compound.

---

## Cross-links

- Keybind system: `keybinds.md`
- Update notification: `auto-update.md`
- Overview: `README.md`
