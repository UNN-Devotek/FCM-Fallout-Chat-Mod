# Overlay diagnostics & logging

The overlay writes a diagnostic log so failures on machines we can't access —
especially Linux/Proton, where launch, tray, and window behavior differ — are
diagnosable from a single user-supplied file.

## Where the log lives

| OS | Path |
| -- | ---- |
| Linux | `~/.config/Fallout Chat Mod/logs/main.log` |
| Windows | `%APPDATA%\Fallout Chat Mod\logs\main.log` |
| macOS | `~/Library/Application Support/Fallout Chat Mod/logs/main.log` |

The previous session is kept as `main.log.1`. The current path is also printed in the
log header (`logFile=…`) and reachable from the tray (**Open log folder**).

## Levels

Two levels, both written to the same file (`main.js` `diag()` / `vdiag()`):

- **info (default, always on)** — lifecycle and **state transitions**: startup
  environment, tray creation, hotkey (un)registration, game on/off, KWin setup,
  the XWayland (Ozone) relaunch, the single-instance lock, relay connect/disconnect.
  Low-frequency, so a normal user's log stays small but still tells the story.
- **verbose (opt-in)** — per-tick spam useful only for a deep debugging session:
  the 3 s z-order heartbeat re-applies, the ~60 s game-scan process dump, and
  foreground-window polls. Off by default (these were the #1 source of log bloat).

### Enabling verbose logging

Any one of these turns verbose on (`overlay-core.js` `resolveLogLevel`):

1. **Launch flag** — pass `--fcm-debug` to the binary (aliases: `--debug`,
   `--verbose`). Works for every Linux form:
   ```bash
   "Fallout Chat Mod.AppImage" --fcm-debug      # AppImage
   fallout-chat-mod --fcm-debug                 # .deb / installed binary
   ```
   The KDE-Wayland XWayland relaunch preserves user argv, so the flag survives the
   self-relaunch.
2. **Environment variable** — `FCM_DEBUG=1` (or `FCM_VERBOSE=1`) in the environment.
3. **Tray → "Debug logging (verbose)"** — a checkbox that persists to settings
   (`settings.debugLogging`) so it survives a restart. No relaunch needed.

The active level is recorded in the log (`logLevel=…` at startup, `[log] level=…`
on change).

## Log rotation

`main.log` rotates to `main.log.1` once it passes ~2 MB — both at startup and
mid-session (throttled size check in `diag()`; see `overlay-core.js`
`shouldRotateLog`). This replaced the old startup-only 1 MB wipe, so a long session
can no longer grow the file without bound, and the prior session is preserved.

## What gets logged (info-level tags)

| Tag | When | Catches |
| --- | ---- | ------- |
| `[startup]` | Once, at launch | Desktop/session (`XDG_*`, Wayland/X11 display), AppImage env vars, libfuse2 + AppImageLauncher presence, `--ozone-platform` argv, execPath, versions |
| `[tray]` | Tray creation | Whether the system-tray icon was created or **failed** (no StatusNotifierItem host) and the icon source |
| `[hotkeys]` | On context change | Global-shortcut (un)registration, per-key register failures, and the **recoverability** path (summon key kept when no tray) |
| `[game-gate]` / `[game-scan]` | Game on/off (transition) | FO76-under-Proton detection; the full candidate-process dump is **verbose-only** except on a transition |
| `[ozone]` | KDE-Wayland launch | The XWayland relaunch decision/exec, or the unsafe-skip (transient AppImage mount) |
| `[singleton]` | Second launch | The single-instance lock handing off / exiting |
| `[linux]` (KWin) | First launch | KWin keep-above rule install / skip / failure |
| `[relay]` | Connection events | Relay WebSocket connect/disconnect/error |
| `[foreground]` | KDE-Wayland; win32 poller lifecycle | KDE-Wayland: active-window tool resolution + the xdotool crash circuit-breaker. **Windows (issue #136):** foreground-poller lifecycle — `poller started` / `first line` / `exit … restarting in Ns` / `silent > Ns — releasing global hotkeys (fail-safe)` / `recovered`. A poller that exits immediately with no output logs a `blocked` hint (Constrained Language Mode / AppLocker). If `main.log` shows binds firing but **no** `[foreground]`/`[hotkeys]` transitions, the poller died silently — the self-heal + watchdog now prevent that. |

## Recoverability without a tray

On desktops with **no StatusNotifierItem host** (many wlroots/Wayland compositors,
GNOME without an AppIndicator extension, headless), `new Tray()` fails and there is
no tray icon. To stop the overlay becoming unrecoverable after it hides (e.g. when
the game closes), `refreshShortcuts()` keeps the **summon hotkeys** (focus/toggle —
Insert/Delete by default) registered even while another app is foreground when no
tray is available. With a tray present, all keys are released to other apps (the
tray is the fallback). See `[hotkeys]` log lines and `docs/overlay/window-management.md`.

## Linux dev launch

`npm run dev:linux` (vs. the Windows-centric `dev:local`) runs the renderer + Electron
against the local backend **with `--ozone-platform=x11`**, so on KDE-Wayland the app
does not self-relaunch to force XWayland — a single clean process, so the tray
registers normally in dev. Add `--fcm-debug` (or `FCM_DEBUG=1`) for verbose dev logs.
