# Building the Cross-Platform Electron Overlay

This document covers prerequisites, build commands, icon requirements, code-signing
TODOs, and known environment constraints for producing distributable packages of the
Fallout Chat Mod Electron overlay on Windows, macOS, and Linux.

---

## Quick-start (dev)

```bash
cd cross-platform-overlay

# Install dependencies (requires a working npm registry — see "npm auth caveat" below)
npm install

# Develop against your LOCAL backend (localhost:7076) with renderer hot-reload.
# ONE command: starts the Vite dev server AND launches Electron pointed at it.
npm run dev:local
```

> `dev:local` sets `RELAY_HTTP`/`RELAY_WS` to `localhost:7076`. Never run a dev
> build against the production relay — develop only against your local stack.
> (`npm start` / `dist:*` build the shipped binary, which targets production.)

---

## npm auth caveat (this repo's dev environment)

The npm registry auth token in this repo is broken (E401). Running `npm install`
from WSL2 against the registry will fail. Workarounds:

1. Run `npm install` from a machine / shell that has a valid npm session.
2. Use `npm install --prefer-offline` if `node_modules/` is already present.
3. Side-load the Electron binary manually (the team placed it at
   `C:\Temp\electron-win\electron.exe` for local Windows testing).

Do NOT run `npm install` or modify `package-lock.json` while the Vite dev server
or Electron test session is running — it will disrupt the live session.

---

## Building a distributable

### Step 1 — Build the renderer (Vite)

```bash
npm run build:renderer
```

Vite outputs to `dist-renderer/`. The electron-builder config's `files` list
includes `dist-renderer/**/*` so the packager picks it up automatically.

### Step 2 — Package with electron-builder

| Command          | Platform     | Output format(s)              |
|------------------|--------------|-------------------------------|
| `npm run dist`   | current OS   | auto-detected                 |
| `npm run dist:win`   | Windows  | NSIS installer + portable .exe |
| `npm run dist:mac`   | macOS    | .dmg + .zip (x64 + arm64)    |
| `npm run dist:linux` | Linux    | AppImage + .deb (x64)         |

Output lands in `dist-electron/`.

**Important:** cross-compiling has limitations:
- **Windows** packages can be built on Windows, or on Linux/macOS via Wine (needs
  `wine` installed; quality varies for NSIS). Native Windows is strongly preferred.
- **macOS** packages MUST be built on macOS. There is no reliable cross-compile path
  for `.app` / `.dmg` from Linux or Windows.
- **Linux** packages (AppImage, .deb) can be built on Linux or from macOS.
  Building from Windows is not supported.

For CI, use a matrix with `windows-latest`, `macos-latest`, and `ubuntu-latest`
GitHub Actions runners.

---

## Icon requirements

electron-builder needs a platform-native icon for each target. The source
Windows icon is `assets/fcm.ico`.

| Platform | File                       | Format              | Required size |
|----------|----------------------------|---------------------|---------------|
| Windows  | `assets/fcm.ico`           | ICO (multi-res)     | Already exists |
| macOS    | `assets/fcm.icns`          | ICNS                | Must generate |
| Linux    | `assets/fcm-linux.png`     | PNG                 | 512×512 px, must generate |

### Generating macOS `fcm.icns` from the source ICO

The canonical high-res source is `ChatOverlay/Assets/fcm.ico`. Convert on macOS:

```bash
# 1. Extract a 512×512 PNG from the ICO (ImageMagick):
magick ../ChatOverlay/Assets/fcm.ico[0] -resize 512x512 /tmp/fcm_512.png

# 2. Build an iconset and compile to .icns (macOS only):
mkdir /tmp/fcm.iconset
for SIZE in 16 32 64 128 256 512; do
  magick /tmp/fcm_512.png -resize ${SIZE}x${SIZE} /tmp/fcm.iconset/icon_${SIZE}x${SIZE}.png
  magick /tmp/fcm_512.png -resize $((SIZE*2))x$((SIZE*2)) /tmp/fcm.iconset/icon_${SIZE}x${SIZE}@2x.png
done
iconutil -c icns /tmp/fcm.iconset -o assets/fcm.icns
```

Without a macOS machine, generate the `.icns` using the online tool at
https://cloudconvert.com/ico-to-icns or the `png2icns` Linux package.

### Generating Linux `fcm-linux.png`

```bash
# ImageMagick (any platform):
magick ../ChatOverlay/Assets/fcm.ico[0] -resize 512x512 assets/fcm-linux.png
```

Or from within WSL2:
```bash
convert ../ChatOverlay/Assets/fcm.ico[0] -resize 512x512 cross-platform-overlay/assets/fcm-linux.png
```

Until these files are generated, electron-builder will fall back to Electron's
default icon. The app will still build and run; only the icon is affected.

---

## Code signing and notarization

### Windows (Authenticode)

Without a code-signing certificate, SmartScreen will show "Unknown publisher"
warnings (same situation as the WinForms desktop client). See the root `CLAUDE.md`
"Antivirus / SmartScreen" section for the full context.

To sign with electron-builder, add to `package.json` `build.win`:

```json
"certificateFile": "path/to/cert.pfx",
"certificatePassword": "${env.WIN_CERT_PASSWORD}"
```

Or use Azure Trusted Signing (recommended, ~$9.99/mo):
- Set `"signtoolOptions"` per https://www.electron.build/configuration/win

### macOS (Notarization)

Apple requires apps to be notarized for distribution outside the App Store.
electron-builder supports this via `electron-notarize`. Steps:

1. Enroll in Apple Developer Program ($99/year).
2. Create an Apple ID app-specific password for notarization.
3. Add to `package.json` `build.afterSign` a notarize script, or use
   `notarytool` credentials via electron-builder's built-in support:

```json
"notarize": {
  "teamId": "YOUR_TEAM_ID"
}
```

Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` env vars.

The `assets/entitlements.mac.plist` is already wired to `build.mac.entitlements`
and `build.mac.entitlementsInherit` in `package.json`. It includes the JIT
entitlement required by Electron's V8.

`hardenedRuntime: true` and `gatekeeperAssess: false` are already set.

### Linux

Linux packages (AppImage, .deb) do not require signing for distribution.
AppImage is self-contained and portable. .deb is suitable for Debian/Ubuntu
repos but not officially required to be signed for end-user installation.

---

## How the renderer build + electron-builder fit together

```
npm run build:renderer
       │
       ▼
  Vite compiles src/main.tsx → dist-renderer/
  (React component, Tailwind CSS, all aliased @dashboard code baked in)
       │
       ▼
electron-builder
  picks up: main.js, preload.js, updater.js, dist-renderer/**, assets/**
  bundles them into a self-contained app package per target OS
       │
       ▼
  dist-electron/
    FalloutChatMod Setup 1.3.56.exe   (Windows NSIS)
    FalloutChatMod 1.3.56.exe         (Windows portable)
    FalloutChatMod-1.3.56.dmg         (macOS)
    FalloutChatMod-1.3.56-mac.zip     (macOS ZIP)
    FalloutChatMod-1.3.56.AppImage    (Linux)
    fallout-chatmod_1.3.56_amd64.deb  (Linux Debian)
```

In production, `main.js` loads `dist-renderer/index.html` (when `RENDERER_URL`
env var is unset). The fallback is already implemented:

```js
if (RENDERER_URL) {
  mainWindow.loadURL(RENDERER_URL);       // dev server
} else {
  mainWindow.loadFile(path.join(__dirname, 'dist-renderer', 'index.html'));
}
```

The `vite.config.ts` `base: './'` setting ensures all asset URLs are relative,
so `file://` loading works correctly in the packaged app.

The `.csproj` version read in `main.js` also falls back to `package.json` when
the source tree is absent (i.e., in a packaged build):

```js
try { return require('./package.json').version; } catch { return '0.0.0'; }
```

---

## What cannot be verified in this environment

- **Actual builds** — npm auth is broken (E401) so `npm install` fails; no
  macOS/Linux toolchains are available in WSL2 for cross-OS builds.
- **Icon conversion** — ImageMagick / `iconutil` are not available in this WSL2
  env; `fcm.icns` and `fcm-linux.png` must be generated on a proper machine.
- **electron-builder schema validation** — the config shape was verified by
  knowledge of electron-builder v25's documented schema, not by running it.
- **macOS notarization flow** — requires Apple Developer credentials and a macOS
  machine; cannot be tested here.

---

## Follow-up items (TODOs)

- [ ] Generate `assets/fcm.icns` and `assets/fcm-linux.png` from the source ICO
- [ ] Fix npm registry auth so `npm install` works normally
- [ ] Wire Windows Authenticode signing (Azure Trusted Signing recommended)
- [ ] Wire macOS notarization via `electron-notarize` or electron-builder builtin
- [ ] Set up GitHub Actions matrix CI (win/mac/linux) to produce release artifacts
- [ ] Wire the Electron app's own release channel (`UPDATE_CHANNEL` in `updater.js`)
      once Electron releases are published separately from the WinForms client
- [ ] Consider switching `GlobalHotkey` in ChatOverlay to `RegisterHotKey` API to
      reduce AV false positives (noted in root CLAUDE.md; not an Electron concern)
