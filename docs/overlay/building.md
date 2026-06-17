# Building the Overlay

This page covers how to produce distributable packages of the Electron overlay. For the full release pipeline — packaging ZIPs, uploading to the VPS, publishing to Nexus Mods — see `../deployment/`. Note: the overlay no longer auto-updates; there is no feed to trigger. Update awareness is a passive OS notification delivered over the chat WebSocket.

---

## Prerequisites

- **Node.js 18+** and npm
- **Electron** (downloaded automatically as a dev-dependency on `npm install`)
- **App client key**: resolved automatically from the `APP_CLIENT_KEY` env var, then `../backend/.env`, then `../.env`. A `cp .env.example .env` in the repo root is sufficient for local dev.

**npm auth note**: the npm registry auth token in this repo is currently broken (E401). Run `npm install` from a shell with a valid npm session, or use `npm install --prefer-offline` if `node_modules/` already exists. Do not run `npm install` while a dev session is active.

---

## Development (against local backend)

```bash
cd cross-platform-overlay
npm install

# Hot-reload: Vite renderer + Electron against localhost:7076
npm run dev:local

# Built renderer, no HMR, still against localhost:7076
npm run start:local
```

`dev:local` sets `RELAY_HTTP`/`RELAY_WS` to `localhost:7076`. **Never run a dev build against the production relay.** `npm start` and `dist:*` build the shipped binary that targets production — these are release steps, not dev workflows.

---

## Producing a distributable

### Step 1 — Build the renderer (Vite)

```bash
npm run build:renderer
```

Vite compiles `src/main.tsx` (and all `@dashboard`-aliased dashboard code) into `dist-renderer/`. The `base: './'` setting in `vite.config.ts` ensures asset URLs are relative so `file://` loading works in the packaged app.

### Step 2 — Package with electron-builder

| Command | Platform | Output |
|---|---|---|
| `npm run dist` | Current OS | auto-detected |
| `npm run dist:win` | Windows | NSIS installer + portable `.exe` |
| `npm run dist:mac` | macOS | `.dmg` + `.zip` (x64 + arm64) |
| `npm run dist:linux` | Linux | `.AppImage` + `.deb` (x64) |

Output lands in `dist-electron/`.

electron-builder picks up: `main.js`, `preload.js`, `dist-renderer/**`, `assets/**`.

---

## Platform constraints

| Build target | Where to build |
|---|---|
| **Windows** `.exe` | Native Windows (or Linux/macOS via Wine — quality varies). **Native Windows strongly preferred.** Use an elevated shell (`gsudo`) for NSIS builds. |
| **macOS** `.dmg` / `.zip` | Must be built on macOS. No reliable cross-compile path exists. |
| **Linux** `.AppImage` / `.deb` | Native Linux or macOS. **Must build from a native Linux filesystem** — building from WSL2 (`/mnt/d/...`) causes slow `inotify` and npm issues. For WSL, copy the source to a native Linux path first. |

For CI use a GitHub Actions matrix: `windows-latest`, `macos-latest`, `ubuntu-latest`.

---

## Icon requirements

| Platform | File | Format | Status |
|---|---|---|---|
| Windows | `assets/fcm.ico` | ICO (multi-res) | Already exists |
| macOS | `assets/fcm.icns` | ICNS | Must be generated |
| Linux | `assets/fcm-linux.png` | PNG 512×512 | Must be generated |

Without the platform-native icon, electron-builder falls back to Electron's default icon. The app still builds; only the icon is affected.

**Generate Linux PNG:**
```bash
magick ../ChatOverlay/Assets/fcm.ico[0] -resize 512x512 assets/fcm-linux.png
# Or from WSL2:
convert ../ChatOverlay/Assets/fcm.ico[0] -resize 512x512 cross-platform-overlay/assets/fcm-linux.png
```

**Generate macOS ICNS (requires macOS):**
```bash
magick ../ChatOverlay/Assets/fcm.ico[0] -resize 512x512 /tmp/fcm_512.png
mkdir /tmp/fcm.iconset
for SIZE in 16 32 64 128 256 512; do
  magick /tmp/fcm_512.png -resize ${SIZE}x${SIZE} /tmp/fcm.iconset/icon_${SIZE}x${SIZE}.png
  magick /tmp/fcm_512.png -resize $((SIZE*2))x$((SIZE*2)) /tmp/fcm.iconset/icon_${SIZE}x${SIZE}@2x.png
done
iconutil -c icns /tmp/fcm.iconset -o assets/fcm.icns
```

---

## Code signing

Without a code-signing certificate, Windows shows an "Unknown publisher" SmartScreen warning and some antivirus tools flag the binary. The current overlay is unsigned; see `docs/AZURE-CODE-SIGNING-SETUP.md` and `docs/CODE-SIGNING.md` for the signing plan.

**Windows (Authenticode):** add `certificateFile` / `certificatePassword` to `package.json` `build.win`, or configure Azure Trusted Signing (~$9.99/mo).

**macOS (Notarization):** `assets/entitlements.mac.plist`, `hardenedRuntime: true`, and `gatekeeperAssess: false` are already wired in `package.json`. Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` env vars and add a notarize script to `build.afterSign`.

**Linux:** AppImage and `.deb` do not require signing for distribution.

---

## What the packaged app contains

```
electron-builder output:
  main.js, preload.js                — main-process scripts
  dist-renderer/                     — Vite-compiled renderer (ChatOverlay + all deps baked in)
  assets/                            — Icons, KWin rule
  node_modules/                      — Runtime deps (ws, etc.)
```

Note: `app-update.yml`, `latest.yml`, `latest-linux.yml`, and `.blockmap` files are **not** generated — `build.publish` was removed for Nexus Mods ToS compliance. The overlay does not auto-update.

In production `main.js` loads `dist-renderer/index.html` (no `RENDERER_URL` env). The fallback is:

```js
mainWindow.loadFile(path.join(__dirname, 'dist-renderer', 'index.html'));
```

Version is read from the `.csproj` `<Version>` tag if present (the monorepo tree), otherwise falls back to `package.json`.version (`main.js:256`).

---

## After building — next steps

1. Build produces raw `.exe` (Windows) and `.AppImage` (Linux) in `dist-electron/`
2. Continue with the release pipeline in `../deployment/`: wrap into ZIPs, upload to VPS, verify sizes, register the release, publish to Nexus Mods

---

## Cross-links

- Release pipeline: `../deployment/`
- Update notification (passive OS toast, no feed): `auto-update.md`
- Overview: `README.md`
