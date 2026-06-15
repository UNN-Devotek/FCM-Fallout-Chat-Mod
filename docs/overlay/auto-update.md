# Auto-Update

The Electron overlay uses **electron-updater** for fully automatic, silent updates. The implementation is in `updater.js` and bootstrapped from `main.js`.

---

## Feed configuration

The updater uses electron-builder's `generic` provider. The feed is:

```
https://falloutchatmod.com/downloads/electron/
```

electron-builder bakes an `app-update.yml` into the packaged app at build time pointing to this URL. At runtime, electron-updater reads `latest.yml` (Windows) or `latest-linux.yml` (Linux) from that base URL to discover the current version.

This feed is **separate from the WinForms 1.3.x release channel**. The Electron app manages its own version independently.

---

## Update triggers

There are three triggers that cause the updater to call `checkForUpdates()` (`updater.js:96`):

| Trigger | Timing |
|---|---|
| App startup | 30 seconds after launch (avoids slowing cold start) |
| Periodic poll | Every 4 hours (`CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000`, `updater.js:48`) |
| `release:published` WebSocket broadcast | Immediately when the backend broadcasts a new release |

The `release:published` path means every currently-connected client checks for an update at publish time, without waiting for the 4-hour poll. The WS message is intercepted in the proxy (`main.js:993`) and calls `updater.onRelasePublished()`.

---

## Download and install behavior

```js
autoUpdater.autoDownload = true;         // download begins the moment a newer version is found
autoUpdater.autoInstallOnAppQuit = true; // backstop: installed on next quit if restart was skipped
```

On `update-downloaded`, the updater:

1. Notifies the renderer (`updater:status`, phase `'restart'`) so a banner appears
2. Waits **5 seconds** (`RESTART_DELAY_MS = 5000`, `updater.js:51`) to let the user see the banner
3. Calls `autoUpdater.quitAndInstall(true, true)` — `isSilent=true` (no UAC prompt for per-user installers), `isForceRunAfter=true` (relaunches after install)

The user never has to click anything. The banner is purely informational.

---

## Fast-forward design

`latest.yml` / `latest-linux.yml` always point to the **newest version**. A client many versions behind jumps straight to the latest; there is no per-version stepping. Every release **overwrites** `latest*.yml` — never point the feed at an intermediate version.

This design is intentional: it keeps the feed simple and ensures all users reach the current version in one update cycle.

---

## State persistence across updates

All client state is stored in a **single `overlay-state.json`** in Electron's `userData` directory:

- **Windows**: `%APPDATA%\Fallout Chat Mod\overlay-state.json`
- **Linux**: `~/.config/Fallout Chat Mod/overlay-state.json`

Contents include: `installToken`, `username`, `discordLinked`, `displayName`, `userRole`, `bounds`, `settings` (keybinds, theme, opacity, etc.), `autoLaunch`.

Because `userData` is outside the app package directory, it survives updates automatically. No migration is needed in the typical case.

---

## `productName` spacing caveat

The `productName` in `package.json` is **`"Fallout Chat Mod"`** (with spaces). Electron derives the `userData` directory from this name.

In v1.3.62 the name was changed from `"Fallout ChatMod"` (no space). This moved the `userData` directory, orphaning existing users' state. `migrateLegacyUserData()` (`main.js:721`) handles this one-time migration on startup:

1. Checks whether `%APPDATA%\Fallout ChatMod\overlay-state.json` exists and contains real user data
2. If the current state is missing or a pristine auto-generated default, copies the legacy file over
3. Never overwrites a current state that has real user data (`stateHasRealData`, `main.js:713`)

**Build and filename rule**: electron-builder output filenames, `latest*.yml` `url` fields, and any download link must use the exact spaced name `"Fallout Chat Mod"`. A mismatch produces a 404 silently saved as `.exe`, which users see as "file corrupted."

---

## Dev/unpackaged guard

electron-updater throws `"Dev mode: skip checking for updates"` when the app is not packaged (`app.isPackaged === false`). `_safeCheck()` (`updater.js:188`) catches this pattern and silently no-ops, so the development workflow is unaffected.

---

## IPC surface

| IPC channel | Direction | Purpose |
|---|---|---|
| `updater:check` (invoke) | Renderer → main | Manual check (settings panel "Check for updates") |
| `updater:get-last-result` (invoke) | Renderer → main | Fetch last known check result for settings panel |
| `updater:install` | Renderer → main | Fallback: open download URL in browser (used if auto-install path fails) |
| `updater:result` | Main → renderer | `{ available, version, releaseNotes }` |
| `updater:status` | Main → renderer | `{ phase: 'downloading' | 'progress' | 'restart', version, percent?, delayMs? }` |

---

## Diagnostic log

All update events are logged to the always-on diagnostic file:

- **Windows**: `%APPDATA%\Fallout Chat Mod\logs\main.log`
- **Linux**: `~/.config/Fallout Chat Mod/logs/main.log`

electron-updater's own logger is disabled (`autoUpdater.logger = null`) to avoid duplicate output; the `Updater` class logs through the same `diag()` function as the rest of `main.js`.

---

## Cross-links

- Full release pipeline (packaging, upload, `POST /admin/releases`): `../deployment/`
- Overview: `README.md`
