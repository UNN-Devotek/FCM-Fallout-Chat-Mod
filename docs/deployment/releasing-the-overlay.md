# Releasing the Electron Overlay

This document covers the full release pipeline for the Electron overlay (`cross-platform-overlay/`). Related: `../overlay/auto-update.md` (update notification system — passive OS toast, no auto-download).

---

## Critical Rules — Read These First

> Violating any of these causes real breakage in production.

### 1. `productName` is "Fallout Chat Mod" — WITH spaces

`electron-builder` names its output after `productName` in `cross-platform-overlay/package.json`. The value is `"Fallout Chat Mod"` (three words, two spaces). Every filename produced by the build and every download link must use this exact spaced name.

A mismatch (e.g. `FalloutChatMod`) means users download a file that does not exist on the server → 404.

### 2. Publish BOTH platforms every release

Every release must ship both the Windows `.exe` and the Linux `.AppImage`.

Note: `latest.yml` / `latest-linux.yml` / `app-update.yml` are **no longer generated** — `build.publish` was removed for Nexus Mods ToS compliance. The overlay does not auto-update; there is no feed to maintain.

### 3. Verify served file size matches local build artifact before publishing

After uploading artifacts to the VPS, check that the bytes served by the backend match the local build artifact size. Use `(Get-Item $artifact).Length` (PowerShell) or `stat --printf '%s' $artifact` (Linux) for the reference value; compare against `curl -sI <url> | grep -i content-length`.

### 4. PowerShell scripts in `Packaging/` must remain ASCII-only

Windows PowerShell 5.1 run via the `-File` flag mis-tokenizes non-ASCII characters (e.g. em-dashes `—`, U+2014) inside double-quoted strings and throws a misleading `Unexpected token '}'` error pointing at an unrelated closing brace. Use plain ASCII hyphens (`-`), never Unicode dashes.

### 5. NEVER publish an untested build — smoke-test + VirusTotal gates are MANDATORY and FAIL-CLOSED

A build MUST pass BOTH gates before **anything** is published (`POST /admin/releases`, Nexus). If either gate fails, the build does **not** get uploaded, registered, or posted **anywhere**.

1. **Smoke test** — `Packaging/smoke-test.ps1 -Version X.Y.Z` launches the packaged app and asserts a clean startup (no `Cannot find module`, no `[uncaught]`, relay registers). This catches crash-on-launch bugs. *(v1.3.82: `overlay-core.js` was missing from `build.files`, so the main process threw `Cannot find module './overlay-core'` before `app.whenReady()`. Since auto-update is gone, every user affected by such a bug would need a manual reinstall — gate #5 is non-negotiable.)* The Vitest `__tests__/build-files.test.js` also guards this class of bug at CI time.
2. **VirusTotal gate** — `Packaging/vt-gate.ps1 -Version X.Y.Z` uploads the installer, **waits for the scan to complete**, and exits non-zero (blocking the release) if detections exceed the threshold. `publish-nexus-release.ps1` runs this gate first and aborts before Nexus on failure; the operator must also run it before the upload + register.

### 6. Confirm the build launches cleanly before a wide release

Before/just after publishing, confirm the packaged build launches cleanly via the smoke test. A crash before `app.whenReady()` bricks users who cannot reinstall themselves — they would need a manual reinstall (`irm https://falloutchatmod.com/install.ps1 | iex`), which is why gate #5 is non-negotiable.

---

## Release Pipeline (in order)

**FAIL-CLOSED ORDER:** build -> **smoke-test (gate)** -> **VirusTotal (gate, must pass)** -> build ZIPs -> upload artifacts -> verify served sizes -> `POST /admin/releases` -> Nexus. If a gate fails, STOP — publish nothing.

**Preferred: use the orchestrator** -- `Packaging/release.ps1` enforces the full sequence automatically and cannot skip gates:

```powershell
.\Packaging\release.ps1 -Version X.Y.Z [-ReleaseNotes "..."] [-SkipBuild] [-DryRun]
# -SkipBuild: reuse existing dist-electron artifacts (Linux AppImage must already be present)
# -DryRun: runs smoke-test + VT gates for real; prints what would run for steps 4-7 without uploading
```

Manual step-by-step (if running gates individually):

```powershell
# After Step 1 (build), gate before any publishing:
.\Packaging\smoke-test.ps1 -Version X.Y.Z   # must print SMOKE TEST: PASS
.\Packaging\vt-gate.ps1    -Version X.Y.Z   # must print VT GATE: PASS (blocks on detections)
```

### Cross-platform: cut a release from Linux **or** Windows

The `Packaging/*.ps1` scripts run under **PowerShell 7 (`pwsh`)** on Linux as well as Windows PowerShell — so a release can be cut entirely from Linux (verified on 1.3.90). On Linux invoke with `pwsh`:

```bash
pwsh -NoProfile -File Packaging/release.ps1 -Version X.Y.Z -SkipBuild -ReleaseNotes "..."
```

OS-aware behavior (no flags needed — the scripts detect `$IsLinux`/`$IsWindows`):
- **`smoke-test.ps1`** launches the **`.AppImage`** on Linux (with `--ozone-platform=x11` to skip the KDE self-relaunch) and reads `~/.config/Fallout Chat Mod/logs/main.log`; on Windows it launches `win-unpacked\*.exe` and reads `%APPDATA%`. Cleanup kills by process **name** (`pkill fallout-chat` / `taskkill`), never the runner or `Fallout76`.
- **`release.ps1`** uses `ssh`/`scp` (not `ssh.exe`/`scp.exe`) and runs the child gate scripts via `pwsh` on Linux, `powershell.exe` on Windows.
- **`package-downloads.ps1`** stages ZIPs under `DistDir` (cross-platform; not a Windows temp path).

**Required env vars** (`release.ps1` auto-loads `.env` then `.env.local` from the repo root via `Import-DotEnv`, but **only sets vars not already exported** — so exported values win):

| Var | Used by | Notes |
|-----|---------|-------|
| `PROD_ADMIN_RELEASE_TOKEN` | VT gate, `POST /admin/releases`, Nexus | admin bearer token |
| `VT_API_KEY` | VirusTotal gate | personal API key |
| `FCM_SSH_TARGET` | upload (step 5) | `user@host` of the prod VPS |
| `FCM_SSH_KEY` | upload (step 5) | path to the SSH private key. On Linux the key must live at a real path with `chmod 600` (a key on `/mnt/*` DrvFs has perms `ssh` rejects — copy it to `~/.ssh/<key>`) |
| `FCM_BACKEND_CONTAINER` | upload (step 5) | Dokploy backend container, e.g. `chat-mod-fallout-chat-mod-<id>-backend-1` |
| `NEXUS_API_KEY`, `NEXUS_FILE_GROUP_ID_WINDOWS`, `NEXUS_FILE_GROUP_ID_LINUX` | step 7 (Nexus) | optional; step 7 fail-closed-aborts if unset (the **primary** release in steps 1-6 is already live by then) |

### Step 1 — Build raw artifacts

> **Standard path: build both platforms on the self-hosted runners.** The repo ships two
> `workflow_dispatch` build workflows, one per platform, both running on the `unn` self-hosted
> runners. This is the **preferred** way to produce release artifacts — it pins the toolchain
> (Node 24), bumps the version in `package.json` from the `version` input, builds the renderer,
> runs `electron-builder`, and uploads the raw installer(s) as a 90-day artifact. Build locally
> (the manual steps further down) only when a runner is unavailable.
>
> | Platform | Workflow | Runner | Outputs (artifact) |
> | -------- | -------- | ------ | ------------------ |
> | Windows  | `.github/workflows/build-windows.yml` | `[self-hosted, windows, unn]` | `*.exe` (NSIS + portable) |
> | Linux    | `.github/workflows/build-linux.yml`   | `[self-hosted, linux, unn]`   | `*.AppImage`, `*.deb` |
>
> **Note:** these release workflows (`build-*.yml`) always use the self-hosted runners by design
> and are NOT affected by the CI runner migration. Only the CI jobs in `ci.yml` defaulted to
> GitHub-hosted runners (`ubuntu-latest` / `windows-latest`). The `CI_RUNNER` /
> `CI_RUNNER_WINDOWS` repo variables have no effect on release workflows.
>
> Trigger both for the same version (CLI shown; or use the Actions tab → Run workflow):
>
> ```bash
> gh workflow run build-windows.yml -f version=X.Y.Z
> gh workflow run build-linux.yml   -f version=X.Y.Z
> ```
>
> **Owner-only.** Both workflows start with an `authorize` job that hard-fails unless
> `github.actor` is the repo owner (`UNN-Devotek`). `workflow_dispatch` is otherwise runnable by
> any collaborator with write access, so this gate keeps release builds owner-only — a non-owner
> dispatch fails at `authorize` before any build runs. Update the allowlisted login in both
> `build-windows.yml` and `build-linux.yml` if ownership changes.
>
> Each build is **artifacts only** — it does NOT run the smoke-test / VirusTotal gates or publish.
> Download the artifacts, then continue with the FAIL-CLOSED gate + publish steps below
> (`smoke-test.ps1` → `vt-gate.ps1` → upload → verify → `POST /admin/releases` → Nexus). The
> `publish` input is reserved for a future automated publish step and is currently a no-op.

The manual `electron-builder` invocations below remain valid as a fallback.

**Windows** (requires an elevated shell; use `gsudo` from WSL):
```powershell
cd cross-platform-overlay
npm run build:renderer        # compile the React renderer
npx electron-builder --win    # produces dist-electron/Fallout Chat Mod Setup X.Y.Z.exe
```

**Linux AppImage** — must be built on a **native Linux filesystem** with Linux-arch `node_modules`. Do **not** build from `/mnt/d` in WSL: the on-disk `node_modules` there are Windows-native (wrong arch) and `electron-builder` misbehaves on DrvFs. Proven procedure from a WSL/Windows checkout (`devIngest`-style staging in `$HOME`):

```bash
# 1. Stage BOTH projects on native ext4 ($HOME), preserving the sibling layout.
#    The overlay's vite `@dashboard` alias resolves to ../admin-dashboard/src and
#    dedupes react / react-dom / react-router-dom / @tanstack/react-query, so BOTH
#    node_modules trees must exist, installed for Linux.
mkdir -p ~/fcm-lxbuild
rsync -a --exclude node_modules --exclude dist --exclude dist-electron \
  "/mnt/d/.../cross-platform-overlay" ~/fcm-lxbuild/
rsync -a --exclude node_modules --exclude dist \
  "/mnt/d/.../admin-dashboard" ~/fcm-lxbuild/

# 2. Install both for Linux. Append `--registry https://registry.npmjs.org` if the
#    global ~/.npmrc points at a private registry (e.g. an expired CodeArtifact token).
cd ~/fcm-lxbuild/admin-dashboard         && npm install --registry https://registry.npmjs.org
cd ~/fcm-lxbuild/cross-platform-overlay  && npm install --registry https://registry.npmjs.org

# 3. Build. APPIMAGE_EXTRACT_AND_RUN=1 avoids the FUSE requirement under WSL.
npm run build:renderer
APPIMAGE_EXTRACT_AND_RUN=1 npx electron-builder --linux   # -> dist-electron/Fallout Chat Mod-X.Y.Z.AppImage

# 4. Copy the AppImage back to the repo's dist-electron for upload.
cp "dist-electron/Fallout Chat Mod-X.Y.Z.AppImage" "/mnt/d/.../cross-platform-overlay/dist-electron/"
```

The Windows `.exe` builds fine in place via Windows PowerShell (`npx electron-builder --win`, elevate with `gsudo` only if a symlink/permission step fails).

Output directory: `cross-platform-overlay/dist-electron/`

Expected files:
- `Fallout Chat Mod Setup X.Y.Z.exe` (Windows installer, ~80 MB)
- `Fallout Chat Mod-X.Y.Z.AppImage` (Linux AppImage)

Note: `latest.yml`, `latest-linux.yml`, and `app-update.yml` are not generated (`build.publish` removed).

### Step 2 — Build download ZIPs

`Packaging/package-downloads.ps1` wraps each raw artifact into a human-download ZIP alongside `INSTALL-*.txt` (and `.kwinrule` for Linux):

```powershell
.\Packaging\package-downloads.ps1 -Version X.Y.Z
```

Produces (in `cross-platform-overlay/dist-electron/`):
- `Fallout Chat Mod Setup X.Y.Z (Windows).zip`
- `Fallout Chat Mod-X.Y.Z.AppImage (Linux).zip`

These ZIPs go to the website and Nexus Mods. They are additional to the raw files — do not replace the raw files with them.

### Step 3 — VirusTotal + permalink (via publish-nexus-release.ps1)

`Packaging/publish-nexus-release.ps1` (step 7 below) handles this automatically. It can also be run standalone:
- Uploads the raw Windows `.exe` to VirusTotal using the large-file upload URL (files > 32 MB require this)
- Computes the SHA-256 permalink (`https://www.virustotal.com/gui/file/<sha256>/detection`)
- POSTs the permalink to `POST /admin/virustotal-url` so `falloutchatmod.com/virustotal` always redirects to the latest scan

Requires env vars: `VT_API_KEY`, `PROD_ADMIN_RELEASE_TOKEN`.

### Step 4 — Upload to VPS

Upload raw artifacts + ZIPs via `scp` into the backend container's downloads directory.

```bash
# Upload raw .exe and .AppImage (prod-server = your SSH alias for the production host)
scp "cross-platform-overlay/dist-electron/Fallout Chat Mod Setup X.Y.Z.exe" \
    prod-server:/tmp/
scp "cross-platform-overlay/dist-electron/Fallout Chat Mod-X.Y.Z.AppImage" \
    prod-server:/tmp/

# Copy into backend container
# <backend-container> = the Dokploy-generated backend container name for your deployment
# (set FCM_BACKEND_CONTAINER in your shell profile; release.ps1 reads it automatically)
ssh prod-server "docker cp /tmp/'Fallout Chat Mod Setup X.Y.Z.exe' \
    <backend-container>:/app/downloads/electron/ && \
    rm /tmp/'Fallout Chat Mod Setup X.Y.Z.exe'"

# Repeat for ZIPs
```

The backend container serves the feed from `/app/downloads/electron/` via the `releases_downloads` Docker volume.

### Step 5 — Verify served file sizes

Before registering the release, confirm that the bytes served by the VPS match the local build artifact size.

```bash
# Local artifact size (reference)
stat --printf '%s' "dist-electron/Fallout Chat Mod Setup X.Y.Z.exe"   # Linux/macOS
# (Get-Item "dist-electron\Fallout Chat Mod Setup X.Y.Z.exe").Length   # PowerShell

# Served size (must match)
curl -sI "https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod%20Setup%20X.Y.Z.exe" \
  | grep -i content-length
```

### Step 6 — Register the release

Confirm version and release notes with the user first, then call the admin endpoint. This updates the server's in-memory `latestVersion` cache — newly connecting overlay clients will receive `{ type: 'app:update-available', payload: { latestVersion } }` over the chat WebSocket and show a passive OS notification if the version is newer than their build.

```bash
curl -X POST https://falloutchatmod.com/admin/releases \
  -H "Authorization: Bearer $PROD_ADMIN_RELEASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"X.Y.Z","downloadUrl":"https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod%20Setup%20X.Y.Z%20(Windows).zip","releaseNotes":"..."}'
```

`downloadUrl` is the Windows ZIP URL (the website download button uses this).

### Step 7 — Nexus publish

```powershell
.\Packaging\publish-nexus-release.ps1 -Version X.Y.Z [-ReleaseNotes "..."]
```

This script:
1. Calls `Packaging/publish-nexus.ps1` once for each platform (Windows ZIP + Linux ZIP)
2. Each call implements the 6-step Nexus v3 Upload API: open multipart session → upload chunks to S3 → complete S3 multipart → finalise → poll for `available` state → attach as new MAIN file (archiving the previous one)
3. Uploads the Windows `.exe` to VirusTotal and pushes the permalink to `/admin/virustotal-url`

Required env vars (set as Windows USER env vars):
- `NEXUS_API_KEY`
- `NEXUS_FILE_GROUP_ID_WINDOWS`
- `NEXUS_FILE_GROUP_ID_LINUX`
- `VT_API_KEY`
- `PROD_ADMIN_RELEASE_TOKEN`

---

## Update Notification

There is no auto-update feed. The overlay no longer auto-updates (`electron-updater`, `build.publish`,
and `latest*.yml` are removed — Nexus Mods ToS compliance).

Instead, after `POST /admin/releases` updates the server's `latestVersion` cache, every overlay client
that (re)connects to the chat WebSocket receives:

```json
{ "type": "app:update-available", "payload": { "latestVersion": "X.Y.Z" } }
```

If `latestVersion` is newer than the client's build version, the overlay shows a passive OS notification
(Windows toast / Linux libnotify / macOS) that opens the Nexus Mods page on click. The client downloads
and installs nothing.

For the full notification architecture, see `../overlay/auto-update.md`.

---

## CLI Installers

End users can also install via one-liners that query `GET /api/releases`:

- **Windows:** `irm https://falloutchatmod.com/install.ps1 | iex` (`Packaging/windows/install.ps1`)
- **Linux:** `curl -fsSL https://falloutchatmod.com/install.sh | bash` (`Packaging/linux/install.sh`)

Both call `/api/releases` to discover the current version, reconstruct the raw artifact URL from the
version string, download the raw artifact, and run it. They are served by the backend from the same
`/app/downloads/` volume. The installer output does **not** claim auto-update capability.

---

## Killing the Overlay After Testing

The overlay is multi-process (main + GPU + renderer + utility), all named `Fallout Chat Mod.exe` (or `electron.exe` in dev):

```powershell
Get-Process -Name 'Fallout Chat Mod','electron' -EA SilentlyContinue | Stop-Process -Force
```

Never kill `Fallout76`.
