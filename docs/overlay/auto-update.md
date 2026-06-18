# Update Notification

The Electron overlay **does not auto-update**. `electron-updater`, the `latest*.yml` /
`app-update.yml` feed, and the `build.publish` config were removed for Nexus Mods ToS
compliance (the Nexus File Submission Guidelines prohibit executables that connect to the
internet to download or send information for update purposes).

Instead, the overlay shows a **passive OS notification** at boot/WS-connect when a newer
version is available. It downloads and installs nothing; clicking the notification opens the
Nexus Mods page for a manual download.

---

## How it works

### Version delivery (server → client)

The latest published version travels over the **existing chat WebSocket** — no dedicated
update network call is made. On every WS connection handshake (alongside `presence:state`)
the server sends:

```json
{
  "type": "app:update-available",
  "payload": { "latestVersion": "1.3.90" }
}
```

The server maintains an in-memory `latestVersion` cache, initialized at boot from the DB
(`prisma.release.findFirst({ orderBy: { publishedAt: 'desc' } })`) and refreshed by
`POST /admin/releases`. See `docs/realtime/websocket-protocol.md` for the full message spec.

### Version compare + notification (client)

The main process handler (`main.js`, repurposed from the old `release:published` intercept):

1. Receives `app:update-available` with `latestVersion`.
2. Compares against `APP_VERSION` using a `cmpVersions` helper (numeric-aware semver
   comparison in `overlay-core.js`).
3. If `latestVersion > APP_VERSION`, calls `showUpdateNotification(version)`.
4. A **once-per-app-session guard** (`updateNotifiedThisSession` flag) suppresses duplicate
   toasts on reconnects within the same launch — the user sees at most one toast per boot.

### OS notification

`showUpdateNotification` reuses the existing `showSystemNotification` pattern (Electron
`Notification`, the app icon). On click: `shell.openExternal(NEXUS_MOD_URL)` —
`https://www.nexusmods.com/fallout76/mods/4082`.

Platform support:
- **Windows** — native toast (AUMID `com.falloutchatmod.overlay`, already set at
  `main.js:3272`).
- **Linux** — libnotify (already listed in `.deb` dependencies).
- **macOS** — native macOS notification (no extra setup).

Notification copy: **title** `Update!  v{version}` · **body** `A new version of Fallout Chat Mod
is available. Click to get it on Nexus Mods.`

---

## What was removed

| Removed item | Why |
|---|---|
| `cross-platform-overlay/updater.js` (the `Updater`/`electron-updater` engine) | Nexus ToS: no auto-download/install |
| `build.publish` block in `package.json` | Feed manifests (`latest*.yml`, `app-update.yml`) are no longer generated |
| IPC channels `updater:check`, `updater:get-last-result`, `updater:install`, `updater:result`, `updater:status` | Removed with the updater engine |
| Renderer `src/updater-ui.ts` (in-overlay banner machine) | OS notification replaces the in-overlay banner |
| `release:published` WS broadcast | Replaced by `app:update-available` (connect-time only; no live mid-session broadcast) |
| `/api/version` overlay fetch | The overlay no longer polls this endpoint; version label is sourced from the build (`APP_VERSION`) |

---

## Updating / patching from an old version

Because the overlay no longer self-updates, **re-running the installer is the update path.** The
notification only tells the user a newer version exists and opens the Nexus page; the user downloads
and installs it themselves. Every install path is a **full, idempotent fast-forward** — a user who is
many releases behind (e.g. 5 versions old) lands on the latest in one run, with no intermediate steps.

### Why a single re-install always patches forward

- **Installers always fetch the latest.** The CLI one-liners (`install.ps1` / `install.sh`) and the
  website/Nexus ZIPs resolve the newest version from `GET /api/releases` (or the bundled artifact) —
  there is no per-version upgrade chain to walk.
- **No minimum-version / forced-upgrade gate exists.** `backend/src/services/latestReleaseVersion.ts`
  and `versionController.ts` only report the latest version; they never reject an old client, so any
  version can patch directly to current.
- **In-place overwrite, version-agnostic paths.**
  - **Windows (NSIS):** `assets/install/installer.nsh` `customInit` taskkills the running
    `Fallout Chat Mod.exe` so NSIS overwrites the install in place; electron-builder NSIS
    (`oneClick:false`, `perMachine:false`) upgrades the existing per-user install.
  - **Linux:** `install.sh` writes the AppImage to a **stable, version-agnostic path**
    (`$XDG_DATA_HOME/FalloutChatMod/Fallout Chat Mod.AppImage`), overwrites it, and rewrites the
    `.desktop` `Exec` every run — so there is never a stale launcher pointing at an old binary. The
    `.deb` upgrades in place via `dpkg`/`apt`.
- **Startup migrations are idempotent across any version jump** — they run on first launch of the new
  build regardless of how far back the user was:
  - userData productName-rename `"Fallout ChatMod"` → `"Fallout Chat Mod"` (`main.js:972-1050`).
  - keybind reset, gated on `keybindsResetVersion < KEYBIND_RESET_VERSION` (`main.js:3440-3453`) —
    any-to-any safe.
- **Settings survive.** `userData` lives outside the app package, so keybinds, the Discord link, and
  overlay state persist across every reinstall.

### Prompt-when-current (CLI installers)

When the CLI installer detects the machine is **already on the latest version**, it does not silently
reinstall — it prompts **reinstall (uninstall + reinstall) or cancel**:

- **Windows** (`install.ps1`): reads the installed exe's `VersionInfo.ProductVersion`, compares with
  `[version]`, and on a match asks via `Read-Host` (`[r/C]`, default Cancel).
- **Linux** (`install.sh`): reads a version marker the installer writes at install time
  (`$XDG_DATA_HOME/FalloutChatMod/.fcm-version`), compares with `sort -V`, and on a match prompts from
  **`/dev/tty`** (the script body itself arrives on stdin over `curl | bash`, so the keyboard is
  `/dev/tty`). Non-interactive/piped → defaults to **Cancel** and prints how to force a reinstall.

If version detection fails, the installer falls back to installing — it never blocks a patch. The
double-click NSIS installer already prompts on re-install via electron-builder `oneClick:false`; the
prompt-when-current logic is for the **CLI** path only.

### `.deb` shipped in the Linux ZIP

The Linux download ZIP bundles both the AppImage and a `.deb` (`Fallout Chat Mod-<version>.deb`) so apt
users can manage the install through `dpkg`. `Packaging/package-downloads.ps1` stages the `.deb` into
the Linux ZIP and `Packaging/release.ps1` verifies + uploads the raw `.deb` alongside the AppImage. See
`../deployment/packaging.md`.

---

## Nexus ToS compliance rationale

Nexus's guideline prohibits files that "connect to the internet to download or send
information" for updates. After this change:

- The binary **auto-updates nothing** and fetches **no update feed**.
- The latest version number arrives on the chat WebSocket — the connection already justified
  as crucial to the mod's function.
- Clicking the notification routes the user **to Nexus** to download manually.
- No dedicated update connection is added.

This position was disclosed proactively to Nexus Mods support. If they request removal of
the notification entirely, it is a small isolated revert (this notification system only);
the rest of the compliance work stands regardless.

---

## State persistence across updates (unchanged)

Because users update manually (download + reinstall), the `userData` directory is outside
the app package and survives reinstalls automatically. `migrateLegacyUserData()` still
handles the one-time migration from `"Fallout ChatMod"` → `"Fallout Chat Mod"` userData
path (v1.3.62 rename).

---

## `productName` spacing caveat (unchanged)

`productName` in `package.json` is `"Fallout Chat Mod"` (with spaces). Electron derives the
`userData` directory from this name. All download link filenames must use the exact spaced
name — a mismatch produces a 404.

---

## Cross-links

- WS message spec: `../realtime/websocket-protocol.md` (`app:update-available`)
- Full release pipeline: `../deployment/`
- Overview: `README.md`
