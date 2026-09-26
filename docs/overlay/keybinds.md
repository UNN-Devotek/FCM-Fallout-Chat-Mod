# Keybinds

The Electron overlay uses **global shortcuts** (Electron `globalShortcut`) registered to navigation-cluster keys that Fallout 76 does not bind by default. All keys are user-rebindable from the Settings panel.

---

## Default keybind table

| Default key | Action name | Behavior |
|-------------|-------------|----------|
| `Insert` | `focus` | **Focus-to-chat**: shows the overlay if hidden **or in tray** (clears `userHidden`), re-asserts always-on-top, expands if collapsed, focuses the chat input. On Windows, uses `app.focus({ steal: true })` to bypass the foreground-lock so the user can type immediately without Alt-Tabbing. |
| `Delete` | `toggle` | **Hide/show**: hides to tray and sets `userHidden = true`. If the overlay was accepting keyboard input, requests return to the running game before hiding. Press again to restore for reading without taking game focus; outside gameplay, restores as an active standalone window. `Insert` remains the focus-to-chat action. |
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
does not rely on raw keyboard events for gameplay input. Its supported paths are (1) the one native open
key polled by ZFE, (2) named Fallout 76 control-map **actions** the loader forwards as
`HUDMod::UserEvent`, and (3) the extender `Input.*` physical-key compatibility path used when a
configured scroll token has a Windows virtual-key mapping. The native loader exposes `EventName`/`IsKeyDown` getters; the widget also accepts
`actionName`/`isDown` compatibility fields using accessor-aware reads.
Configure them in `Data/FCMChat.ini` (`[FCMChat]` section).

### Start typing and HUDModLoader menu

With Fallout 76 focused, press `Insert` to open the widget's native input and start typing. Press
`Enter` to send or `Escape` to cancel. The packaged defaults require both `Data/FCMChat.ini`
`openKey=INSERT` and the ZFE fragment's `OpenChatKey=INSERT`; keep them in sync. If
`Data/configuration/zfe.ini` has a `[TextChat]` `OpenChatKey` override, it must match as well.
Press `F11` to
open the HUDModLoader menu, then use `FCM → Customize...` for settings, `FCM → Scroll to newest`
for the feed, and `FCM → Customize... → Reset all settings` to restore the packaged defaults. Use
the loader reload control for live widget changes; replacing the BA2 or ZFE fragment requires
exiting and restarting Fallout 76.

If Insert shows or restores the HUD feed but typing does not start, the open key has already
worked. Close the F11 HUDModLoader menu and any game menu, then retry once. On xScal, repeated
`xScal text session busy` lines in `xscal.log` mean `Input.BeginInput` did not grant an editor
session. Fully exit and restart Fallout 76; changing `openKey` does not address that response.
If the same response appears on a fresh launch, collect the new `xscal.log` and installed HUD
mod list to investigate why the editor remains unavailable. FCM does not open a second editor
while xScal reports busy.

The native xScal 0.2.18 editor worked in the Linux/Steam Proton test but returned
`input_unavailable` on the tested Windows laptop. As a temporary Windows workaround,
set `xscalInputMode=shared` in `Data/FCMChat.ini` and restart. This selects
HUDModLoader's keyboard editor; controller text entry is unsupported in this mode.

All eight HUD key lines are editable in `Data/FCMChat.ini`. Use a named key such as
`openKey=PERIOD` or `openKey=COMMA`, or `VK_###` for a decimal Windows virtual-key code
from 1 through 254. `scrollBottomKey=` and `hideKey=` may be blank. Restart Fallout
and check the `physical navigation poll started` line in `xscal.log` or `zfe.log`
to confirm the effective registration. Key rebinding controls when the widget calls
`Input.BeginInput`; it cannot make a refused native text session accept input.

Customize actions are repeatable while the submenu remains open. The HUDTools one-shot behavior is
given a short cooldown by FCM, so position, size, opacity, and theme controls no longer become
permanently grey after one activation. Auto-hide reports its live state on the next F11 open; the
menu closes after a toggle to force that label to be rebuilt.

After opening input, `/g`, `/t`, `/e`, `/i`, `/r`, and `/s` (or `/server` after a current
server/world binding is confirmed) switch the destination channel before the rest of the message
is sent; `/hide` hides the feed and the open key restores it. The generated HUD ZIP includes these
steps in the selected provider's `INSTALL.txt` and the ZIP root `README.txt`.

| Default | Action / config key | Behavior |
|---------|---------------------|----------|
| `Insert` | `openKey` (native ZFE key) | **Open / restore.** On ZFE, opens the native chat input and restores a hidden panel through `isChatKeyPressed`; use a supported alternative such as `DELETE` if Insert conflicts, and keep native/widget values aligned. `PAGE_DOWN` conflicts with the default next-channel key. On xScal, the same `openKey` value is mapped through `Input.RegisterKey`/`Input.IsKeyPressed`; see the provider note below. |
| `Page Down` | `channelNextKey` = `NextPage` | Advance to the next channel. Physical `PageDown` aliases are accepted. Works while idle or while input is open; an open draft is preserved. |
| `Page Up` | `channelPrevKey` = `PrevPage` | Go to the previous channel. Physical `PageUp` aliases are accepted. Works while idle or while input is open; an open draft is preserved. |
| `Arrow Up` / `Arrow Down` | `scrollUpKey=Up` / `scrollDownKey=Down` | After `Insert` opens the typing session, scroll the active feed one line. Arrow/Cursor/Dpad aliases match the default action. Before then they remain game controls. |
| (optional) newest key | `scrollBottomKey` | Return the feed to the newest message. **Default is UNSET**; choose `Home`, `End`, `F12`, or a forwarded action to enable it. Before `Insert`, the key remains a game control. |
| `/hide` + `F11` | (`/hide` slash command; F11 HUDModLoader menu) | Hide the panel. Feed keeps running in the background; restore with the open key (`Insert`). |
| `Delete` | `hideKey=DELETE` | Hides the HUD while idle. During an active typing session the hide binding is suspended and Delete edits the draft. Both providers poll its physical VK edge when available; named loader actions remain supported. Set the value blank to disable keyboard hiding. |
| Mouse-wheel | (not a keybind) | Scroll the feed history. F11 **Scroll to newest** remains available even when `scrollBottomKey` is unset. |

`Enter` (send), `Esc` (cancel), and Delete/Backspace editing are not rebindable. The 2.10.117
controller test uses ZFE's owner-scoped `input.v1` session when both text and release-barrier
capabilities are present. Older ZFE and xScal use SharedHUDTools; xScal text entry remains
best-effort with a controller because its documented suppression API applies only to gamepad
buttons. FCM closes its owned editor on send/cancel and every failure/menu/unload path.

**Deliverable action set** — `channelNextKey` / `channelPrevKey` / `hideKey` continue to accept
the forwarded loader actions `NextPage` (Page Down), `PrevPage` (Page Up), `Console` (`~`),
`TeamChat` (`T`), and `DiagnosticSnapshot` (F12). `scrollUpKey`, `scrollDownKey`, and
`scrollBottomKey` accept a forwarded action name or a safe physical token. The defaults are
`Up`, `Down`, and blank. An empty scroll value disables that direction; changing `scrollUpKey`
or `scrollDownKey` releases the corresponding arrow alias instead of retaining it as a second
binding. For xScal and the ZFE Input.* compatibility path, physical tokens with a Windows
virtual-key mapping are registered and polled through `Input.RegisterKey`/`Input.IsKeyPressed`.
Registration does not suppress the underlying keyboard action, so test bare gameplay keys.

Keep `Data/ZFE/TextChat/fragments/FCMChatWidget.ini` `OpenChatKey` aligned with `FCMChat.ini`
`openKey`; both default to `INSERT`. The widget registers mapped physical open keys through
`Input.*` for either provider, so keys such as F12 still work when ZFE's narrower native watcher
rejects the runtime update. Full key catalog (colors / geometry / opacity / limits / toggles / keybinds):
see [zfe/ingame-chat-appearance.md](zfe/ingame-chat-appearance.md) and the commented
`Data/FCMChat.ini`.

The 2.10.117 controller test uses ZFE's public
[hotkey contract](https://www.nexusmods.com/fallout76/articles/270) for supported configured keys
and retains `Input.*` for unsupported tokens such as arrows. `zfe-input-v1` remains a separate
owner-scoped text-session API. See the [provider guide](zfe/modder-guide.md).

### xScal open-chat key

xScal has no `OpenChatKey` setting in `xscal.ini`. For the xScal provider, the widget maps
`Data/FCMChat.ini` `[FCMChat] openKey` to the documented numeric Windows virtual-key interface
(`Input.RegisterKey` and `Input.IsKeyPressed`) and opens on the physical press edge. The named
`HUDMod::UserEvent` action remains a compatibility fallback. The mapping accepts `INSERT`,
`DELETE`, `HOME`, `END`, page keys, arrows, `ESCAPE`, `TAB`, `SPACE`, `PERIOD` (the `.` key), `F1`–`F12`, letters, and digits;
the same physical token catalog is available to the scroll key settings. Unknown control-map-only
action names still work through the named-action path but do not create an xScal physical binding.
The registration is polling bookkeeping and does not
suppress keyboard input from the game. xScal's documented suppression functions apply to
gamepad buttons, so test the chosen key for gameplay conflicts. The widget unregisters the key
when it unloads. Do not add a fabricated `OpenChatKey` entry to `xscal.ini`. See the
[xScal Input interface, Nexus article 268](https://www.nexusmods.com/fallout76/articles/268)
for the provider's registration, polling, and suppression scope.

The verified xScal rebind flow is: exit Fallout 76, keep `[Chat] enabled=true` and the correct
`relayEndpoint` in the root `xscal.ini`, change the existing keys in `Data/FCMChat.ini`, then fully
restart the game. Do not add `OpenChatKey` to `xscal.ini`. On 2026-09-15, FCMChatWidget 2.10.96
accepted and manually exercised a complete rotated profile—F2 open, F3/F4 channels, F5/F6 scroll,
F7 newest, F8 selected-link activation, and F12 hide—against hosted Dev. `xscal.log` recorded
accepted VKs 113–119 and 123, `provider=xscal`, and completed the multi-poll history replay.

---

## Cross-links

- Visibility gating and `canShowOverlay`: `window-management.md`
- In-game HUD chat widget config catalog: [zfe/ingame-chat-appearance.md](zfe/ingame-chat-appearance.md)
- Overview: `README.md`
