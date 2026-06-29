# Keybinds

The Electron overlay uses **global shortcuts** (Electron `globalShortcut`) registered to navigation-cluster keys that Fallout 76 does not bind by default. All keys are user-rebindable from the Settings panel.

---

## Default keybind table

| Default key | Action name | Behavior |
|-------------|-------------|----------|
| `Insert` | `focus` | **Focus-to-chat**: shows the overlay if hidden **or in tray** (clears `userHidden`), re-asserts always-on-top, expands if collapsed, focuses the chat input. On Windows, uses `app.focus({ steal: true })` to bypass the foreground-lock so the user can type immediately without Alt-Tabbing. |
| `Delete` | `toggle` | **Hide-to-tray**: hides the window to the system tray. The app keeps running; it does NOT quit. Sets `userHidden = true` so the game gate will not auto-restore the overlay. |
| `End` | `clickThrough` | Toggle click-through: interactive mode ↔ pass-through (mouse events fall to the game behind). |
| `PageDown` | `nextChannel` | Advance to the next sub-channel tab (renderer-driven via `overlay:command`). |
| `PageUp` | `prevChannel` | Go to the previous sub-channel tab (renderer-driven). |
| `Home` | `settings` | Open the Settings panel (renderer-driven). |
| `\` | `recentParty` | Jump to the party that last posted in the General combined feed (renderer-driven). |
| `/` | `goFo76` | Jump to the Fallout 76 (General) main tab (renderer-driven). |

Source: `main.js:274–323`, `src/shell.ts:114–150`.

Up to 8 **party direct-access** slots (`party1`–`party8`) can also be bound; these default to empty (unregistered).

`Escape` is **not** a global keybind and is not user-bindable. It is handled only inside the renderer when the chat input already has DOM focus: pressing bare `Escape` exits text-entry mode, blurs the input, and uses the same return-to-game focus path as sending a message. If Fallout 76 or another app has focus, the overlay does not capture `Escape`.

**Recoverability without a system tray.** Normally global shortcuts are released while another app is foreground (so they reach that app), and the system tray is the fallback for re-showing a hidden overlay. On desktops with **no StatusNotifierItem host** (where `new Tray()` fails — many wlroots/Wayland compositors, GNOME without an AppIndicator extension), `refreshShortcuts()` instead keeps the **summon binds** (`focus`/`toggle`, i.e. Insert/Delete by default) registered even while another app is foreground, so the overlay is never strandable. See [diagnostics-logging.md](diagnostics-logging.md#recoverability-without-a-tray) (`[hotkeys]` / `[tray]` log lines).

---

## `userHidden` flag

`userHidden` is a boolean in the main process that records whether the user **explicitly** hid the overlay.

**Set to `true` by:**
- Pressing `Delete` (toggle → hide path, `main.js:1820`)
- Typing `/hide` in the chat input and pressing Enter
- Clicking "Hide" in the tray menu

**Cleared by:**
- Pressing `Insert` (`focusToChat`, `main.js:1823` — both hidden/tray and visible paths)
- Pressing `Delete` again when the overlay is hidden (toggle → show path, `main.js:1840`)
- Clicking "Show" in the tray menu (`showWindow`, `main.js:1794`)
- The not-running → running game-launch transition (`onGamePresenceChanged`, `main.js:563`)

While `userHidden = true`, `reevaluateVisibility()` will not auto-restore the overlay even when the game is running. This prevents the overlay from popping back over the game immediately after the user explicitly hid it.

---

## Action-based rebinding

All shortcuts are registered by **action**, not by literal key. The `currentKeybinds` map holds the live mapping from action name to accelerator string. `registerHotkeys(kb, presets)` (`main.js:1985`) rebuilds `_allBinds` and calls `refreshShortcuts()`.

Because the registration loop reads `currentKeybinds` at runtime, rebinding a key in Settings carries the full behavior automatically — no code changes are required when a user assigns a different key to an action.

Single printable-character accelerators (`/`, `\`, any letter, digit, or symbol) are detected by `isSinglePrintableChar()` (`main.js:1941`) and marked `isChar = true`. These keys are automatically **unregistered while the overlay itself is focused**, so the user can type `/` or `\` in the chat input without the global shortcut intercepting them (`main.js:1977`).

### Game-reserved-key warning

When binding a key in Settings, a **bare** (modifier-less) Fallout 76 gameplay key — `Tab` (Pip-Boy), `Space`, `E`, `R`, `Q`, `W/A/S/D`, etc. — triggers a **warning** (`gameReservedWarning` in `shell-core.ts`; the editor in `shell.ts` shows a confirm). It **does not block** — the user can bind it anyway — but it prevents the silent footgun from issue #136, where `Tab`=nextChannel meant every in-game Pip-Boy open also popped the overlay. A modifier combo (e.g. `Alt+Tab`'s OS handling aside, `Ctrl+E`) is never flagged because the game never receives it.

### Non-destructive one-time reset

`KEYBIND_RESET_VERSION` (`shell.ts`) triggers a one-time keybind reset when a user's persisted version is older. The reset is **non-destructive** (issue #136 §3.1, `mergeKeybindDefaults` in `shell-core.ts`): it fills only **unset/blank** binds with the current defaults and **preserves every bind the user customised**. The old behavior wiped the whole map back to defaults, so a reinstall re-broke a working config; it now never clobbers a customised bind.

---

## Shortcut registration scope

Global shortcuts steal the key from every application system-wide. To avoid interfering with other apps, the shortcuts are registered **only while the game or the overlay is the active context** (`refreshShortcuts`, `main.js:1965`):

- **Windows**: "active" = game is the foreground process (detected via the ~100ms PowerShell foreground poll) OR the overlay window is focused.
- **Linux/macOS**: no foreground-process API; "active" = `gameRunning` (process-list scan) OR overlay focused.

`refreshShortcuts()` is idempotent: it tracks the last registered state in `_shortcutState` and skips if nothing has changed, preventing churn on the Windows poll.

### Windows foreground-poller resilience (self-heal + fail-safe — issue #136)

On Windows the foreground process is read by a **single long-lived `powershell.exe` child** (`spawnWindowsForegroundPoller`), and it is the **only** thing that updates `lastForegroundProc`. If that poller died — or never started: PowerShell **Constrained Language Mode** blocks its `Add-Type`, and **AppLocker/AV** can block `powershell.exe` — the old code just nulled the handle with no restart, no watchdog, and no log. The last-known foreground (the game, while keys were registered) then froze and `refreshShortcuts()` stopped firing, so the global hotkeys were **never released** and fired in **every** app (issue #136). Two mechanisms now guarantee the keys are released:

1. **Self-heal — restart with backoff.** When the poller dies it is relaunched with capped backoff (1s → 2s → 5s; `overlayCore.nextPollerBackoffMs`). A healthy line resets the backoff. So a transient PowerShell death can't permanently strand the hotkeys.
2. **Fail-safe watchdog.** A 1-second interval (`startWindowsForegroundWatchdog`) checks `overlayCore.isForegroundStale(...)`: if **no foreground line has arrived for ~4s**, the poller is treated as dead/blocked → `lastForegroundProc` is cleared and `refreshShortcuts()` releases the hotkeys (keeping only the summon binds when there is no tray). This is the real fix — it releases the keys **regardless of why** the poller failed, including CLM/AppLocker where the poller can never run.

The poller lifecycle is logged (`[foreground] win32 poller started / first line / exit / silent … / recovered`) so a silent death is diagnosable from `main.log`. A poller that exits immediately and never emitted a line is classified as `blocked-or-clm` (`overlayCore.classifyPollerExit`) and logs an actionable hint. **Trade-off:** on a machine where the poller can never run (CLM/AppLocker), the fail-safe means **in-game** hotkeys won't fire (the overlay can't tell the game is foreground) — only overlay-focused binds and (tray-less) summon binds work. That is the accepted degradation versus keys firing in every app.

**All keybinds work in-game.** Once the context is active, *every* bind is registered — including the channel-cycle (PageUp/PageDown), settings (Home), and party/preset binds. (These were previously gated behind `overlayOnly` so they only fired while the overlay itself was focused, which left them dead during gameplay — only Insert/Delete/End worked in-game.) Because the active-context gate still releases all keys when neither the game nor overlay is focused, these keys are only reserved while you're actually in FCM or the game — other apps are unaffected. The `isChar` exception still applies: `/` and `\` are released while the overlay is focused so they stay typeable in chat. Trade-off: a key bound to an FCM action (e.g. PageUp/PageDown) is **not** delivered to the game while playing; rebind in Settings if it conflicts with an in-game control.

---

## Onboarding completion / game-gate handoff

During onboarding and login the renderer calls `notifyChatActive(false)` (IPC `overlay:chat-active`, `false`). This keeps `chatActive = false`, which means `canShowOverlay()` returns `true` unconditionally — the user can complete setup without Fallout 76 running.

When the user finishes onboarding, `onboarding.ts` calls `notifyOnboardingComplete()` (IPC `overlay:onboarding-complete`, `main.js:1629`):

1. Sets `chatActive = true`
2. Calls `reevaluateVisibility()` to enforce the game gate for the first time
3. Fires a native OS notification guiding the user:
   - **Game already running**: "Fallout 76 is already running. The chat overlay is active in-game." — overlay stays visible.
   - **Game not running**: "Launch Fallout 76 and the chat overlay will appear automatically." — overlay hides to tray. `userHidden` stays `false` so the not-running → running game-launch transition auto-shows it.

Privileged users (moderator / admin / owner / developer) and force-visible users skip the game-gate entirely and receive neither the notification nor the hide.

---

## Position presets (Shift+F1–F8)

Position presets are an optional keybind slot type. Each preset stores a saved window rect; pressing the assigned key clamps the rect to the current work area and snaps the window. Registered alongside the action binds in `registerHotkeys()` (`main.js:2035`). Stored as `ShellSettings.presets` in `overlay-state.json`.

---

## In-game HUD chat widget keybinds (`.ba2` track)

These are **separate** from the Electron overlay's global shortcuts above. The in-game HUD chat
widget (`FCMChatWidget`, the explicit-opt-in `.ba2` install) runs on a Scaleform HUD layer that
receives **no raw keyboard events** — its input surface is restricted to (1) the one native open
key polled by ZFE and (2) named Fallout 76 control-map **actions** the loader forwards as
`HUDMod::UserEvent`. Configure them in `Data/FCMChat.ini` (`[FCMChat]` section).

| Default | Action / config key | Behavior |
|---------|---------------------|----------|
| `Insert` | `openKey` (native ZFE key) | **Open / restore.** Opens the native chat input; if the panel is hidden, restores it first. The only freely-choosable physical key (ZFE `isChatKeyPressed`). `PAGE_DOWN` is the known-good fallback if `INSERT` does not fire in-game. |
| `Page Down` | `channelNextKey` = `NextPage` | Advance to the next channel. |
| `Page Up` | `channelPrevKey` = `PrevPage` | Go to the previous channel. |
| `/hide` + `F12` | (`/hide` slash command; F12 "Hide chat" menu) | Hide the panel. Feed keeps running in the background; restore with the open key (`Insert`). |
| (optional) `hideKey` | `hideKey` = `<action>` | Optional power-user hide bind; default **UNSET**. Accepts a forwarded action only; hide is always available via `/hide` + F12 regardless. |
| Mouse-wheel | (not a keybind) | Scroll the feed history. F12 "Scroll to newest" + auto-scroll are the menu fallbacks. |

`Enter` (send) and `Esc` (cancel) stay native to the game's chat input session and are **not**
rebindable.

**Deliverable action set** — the only values `channelNextKey` / `channelPrevKey` / `hideKey`
accept (forwarded by the loader as `HUDMod::UserEvent`): `NextPage` (Page Down), `PrevPage`
(Page Up), `Console` (`~`), `TeamChat` (`T`), `DiagnosticSnapshot` (F12 — collides with the
HUDTools menu, avoid as `hideKey`). Any other physical key must be remapped to one of these
actions in Fallout 76's control settings, then set the matching action name here.

Two open-key bindings must agree: `Data/ZFE/TextChat/fragments/FCMChatWidget.ini` `OpenChatKey`
(authoritative native key) and `FCMChat.ini` `openKey` (the `HUDMod::UserEvent` path) — both
default `INSERT`. Full key catalog (colors / geometry / opacity / limits / toggles / keybinds):
see [zfe/ingame-chat-appearance.md](zfe/ingame-chat-appearance.md) and the commented
`Data/FCMChat.ini`.

---

## Cross-links

- Visibility gating and `canShowOverlay`: `window-management.md`
- In-game HUD chat widget config catalog: [zfe/ingame-chat-appearance.md](zfe/ingame-chat-appearance.md)
- Overview: `README.md`
