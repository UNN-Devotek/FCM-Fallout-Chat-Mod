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
