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

---

## Shortcut registration scope

Global shortcuts steal the key from every application system-wide. To avoid interfering with other apps, the shortcuts are registered **only while the game or the overlay is the active context** (`refreshShortcuts`, `main.js:1965`):

- **Windows**: "active" = game is the foreground process (detected via the ~300ms PowerShell foreground poll) OR the overlay window is focused.
- **Linux/macOS**: no foreground-process API; "active" = `gameRunning` (process-list scan) OR overlay focused.

`refreshShortcuts()` is idempotent: it tracks the last registered state in `_shortcutState` and skips if nothing has changed, preventing churn on the 300ms Windows poll.

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

## Cross-links

- Visibility gating and `canShowOverlay`: `window-management.md`
- Overview: `README.md`
