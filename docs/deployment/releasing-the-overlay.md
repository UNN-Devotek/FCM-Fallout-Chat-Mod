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

## Release notes — standard format

The `releaseNotes` we pass at publish time (Discord `#updates` announcement, Nexus,
and the GitHub release all use the same text) follow ONE house format:

- **A flat list of `type(scope): description` lines** — conventional-commit prefixes
  (`feat` / `fix` / `chore` / `perf`) with a short scope (`overlay`, `giveaway`,
  `security`, …). **No section headers.**
- **One change per line.** Order: new features (`feat`) first, then notable
  behavior changes, then fixes.
- **No emojis.**
- **Plain-English descriptions — NOT a commit log.** Translate each change to its
  *user impact*; drop deep implementation detail (no "Electron 31→39",
  "ozone-platform", "gamescope", internal module names). Collapse many small commits
  into one readable line (e.g. a batch of CodeQL fixes → one `fix(security):` line).
- **Always confirm the version + the exact notes with the user before publishing.**

Example (the v1.3.91 release):

```
feat(giveaway): host community item raffles right from chat — start one with /giveaway start, others join with a single click, and a winner is drawn automatically when the timer ends (check active raffles with /giveaway list)
feat(overlay): the overlay no longer auto-updates (per Nexus Mods' guidelines) — updates are now manual: you'll be notified when a new version is available, then download and re-run the installer to update
fix(security): patched several vulnerabilities found by automated code scanning, including safer handling of links and redirects and stronger validation of incoming data
fix(overlay): a range of reliability and quality fixes across chat connections, parties, and the moderation tools
```

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
| `NEXUS_FILE_GROUP_ID_HUD` | step 7 (Nexus) | required for the optional HUD file upload; step 7 fail-closed-aborts if unset |

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

#### Windows code signing (Azure Trusted Signing)

The Windows installer is **code-signed via Azure Trusted Signing** by `build-windows.yml`. This
removes the SmartScreen "unknown publisher" warning and is what lifts the Nexus installer
quarantine (see Step 7). Signing happens automatically in the workflow's build step — no manual
action per release.

**How it's wired (and why it's in the workflow, not `package.json`):**

- The signing config is injected at build time via `electron-builder -c.win.azureSignOptions.*`
  CLI overrides. It is deliberately **NOT** in `package.json`, because the PR CI gate
  (`ci.yml → overlay-build-windows-nsis`) builds on `windows-latest` with **no Azure
  credentials** — if `azureSignOptions` lived in `package.json`, every PR build would try to sign
  and fail. The guard test `cross-platform-overlay/__tests__/windows-signing.test.js` enforces
  this split (and that signing can't silently regress to unsigned).
- electron-builder auto-installs the `TrustedSigning` PowerShell module and calls
  `Invoke-TrustedSigning`, authenticating with `EnvironmentCredential` from the
  `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` repo secrets. The publisher name
  comes from the `AZURE_PUBLISHER_NAME` repo variable (keeps the signer's legal name out of git
  history; it is still public on each binary's cert subject).

**Azure resources (provisioned 2026-06-21, `az` subscription `Azure subscription 1`):**

| Resource | Value |
| -------- | ----- |
| Resource group | `fcm-signing-rg` (East US) |
| Trusted Signing account | `fcm-trusted-signing` · endpoint `https://eus.codesigning.azure.net` · Basic SKU (~$10/mo) |
| Certificate profile | `fcm-public-trust` (PublicTrust) |
| Identity validation | Individual (CN = signer's legal name + city/state; street/ZIP excluded) |
| CI service principal | `fcm-signing-ci` → role `Artifact Signing Certificate Profile Signer`, scoped to the account only |

> **Runner prerequisite — .NET SDK (provided by the workflow):** the `TrustedSigning` module
> fetches the Azure CodeSigning dlib via `dotnet tool install`, so the runner needs `dotnet`.
> The self-hosted `[self-hosted, windows, unn]` runner has no .NET SDK, so `build-windows.yml`
> installs it with `actions/setup-dotnet` (`8.0.x`) before the build. Without it, signing dies in
> `NugetInstall.psm1` with `Start-Process: cannot find the file specified`. `signtool` itself does
> NOT need separate install — the module bundles it via `Microsoft.Windows.SDK.BuildTools`.
>
> **Rotate the SP secret** with `az ad sp credential reset --id <appId>` then update the
> `AZURE_CLIENT_SECRET` repo secret. The credential carries a ~1-year default expiry.

The manual `electron-builder` invocations below remain valid as a fallback. **Note:** a manual
local `npx electron-builder --win` produces an **unsigned** installer (no Azure env locally) — use
the `build-windows.yml` workflow when you need the signed, publishable artifact.

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
#    dedupes react / react-dom / react-router / @tanstack/react-query, so BOTH
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
- `Fallout Chat Mod-X.Y.Z.deb` (Linux Debian/Ubuntu package — apt-managed alternative to the AppImage)

Note: `latest.yml`, `latest-linux.yml`, and `app-update.yml` are not generated (`build.publish` removed).

### Step 2 — Build download ZIPs

`Packaging/package-downloads.ps1` wraps each raw artifact into a human-download ZIP alongside `INSTALL-*.txt` (and `.kwinrule` for Linux), and invokes the repeatable HUD package helper:

```powershell
.\Packaging\package-downloads.ps1 -Version X.Y.Z
```

Produces (in `cross-platform-overlay/dist-electron/`):
- `Fallout Chat Mod Setup X.Y.Z (Windows).zip`
- `Fallout Chat Mod-X.Y.Z.AppImage (Linux).zip` — now bundles **both** the AppImage and the `.deb`
  (plus `INSTALL-LINUX.txt` + `.kwinrule`), so apt users can `dpkg -i`/`apt install` the package.
- `ZFE FCM HUD Mod-<widget-version> (PROD).zip` — generated by
  `game-mods/FCMBridge/hudmodloader-chat/package.py` from the current `FCMChatWidget.hx`
  version. It contains the BA2, both runtime INIs, the append-only
  `FCMChatWidget.hudmodloader.ini` snippet, `FCMChatWidget.version.txt`, and `INSTALL.txt`.
  It never replaces the user's `Data/hudmodloader.ini`.

The overlay ZIPs go to the website and Nexus Mods. The HUD ZIP goes to the website, the
environment's Discord Updates announcement, and its separate optional Nexus file group. It is
an explicit opt-in mod and is additional to the raw files — do not replace the raw files with it.

For a hosted-dev package, use `-HudTarget dev`; the generated INIs and `INSTALL.txt` then point
only to `dev.falloutchatmod.com`. Never copy a stamped package between environments.

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

Upload the raw `.deb` (`Fallout Chat Mod-X.Y.Z.deb`) the same way so apt users can fetch it directly.
`Packaging/release.ps1` automates this whole step — it uploads the `.exe`, `.AppImage`, **`.deb`**,
both overlay ZIPs, and the `ZFE FCM HUD Mod` ZIP, then verifies served sizes (step 5) for each.

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
  -d '{"version":"X.Y.Z","downloadUrl":"https://falloutchatmod.com/downloads/electron/Fallout%20Chat%20Mod%20Setup%20X.Y.Z%20(Windows).zip","hudModVersion":"<widget-version>","hudModUrl":"https://falloutchatmod.com/downloads/electron/ZFE%20FCM%20HUD%20Mod-<widget-version>%20(PROD).zip","releaseNotes":"..."}'
```

`downloadUrl` is the Windows ZIP URL (the website download button uses this).
`hudModVersion` and `hudModUrl` are required together when publishing the HUD package. The
website Install page displays the exact `ZFE FCM HUD Mod ZIP` link from `/api/version`, and the
same metadata is included in the Discord Updates and GitHub release messages.

**Optional `announce: false` — quiet publish (no Discord ping).** By default every publish
force-posts a new `@everyone` announcement to `#updates`, and the publish *fails* if the post
can't get out. Add `"announce": false` to the body to skip the Discord post for that publish
(e.g. a code-signing-only release where pinging everyone is noise). Everything else still
happens — `verifyDownload` gates, the site download updates, the `latestVersion` cache + in-app
`app:update-available` fire, and the GitHub Release is created — only the Discord post is
skipped, so you edit the existing announcement by hand. Omit it (or send `true`) for normal releases.

**This step also creates a GitHub Release.** After the Discord post + DB record,
`publishRelease` calls `createGitHubRelease` (`backend/src/services/githubReleaseService.ts`)
to mirror the same notes to a GitHub Release — tag `v<version>`, body = the notes + the
env-aware download links + the Nexus-endorse line. It is **best-effort** (logs + continues
on any GitHub API failure; never blocks the publish) and **idempotent** (re-publishing a
version updates its release). A `-suffix` version (e.g. `1.3.91-dev`) publishes as a GitHub
**pre-release**. Config: a token — `GITHUB_RELEASE_TOKEN` if set (needs `contents: write`),
else the shared `GITHUB_PAT` (prod already has this); owner/repo default to this repo and only
need `GITHUB_OWNER` / `GITHUB_REPO` to override (e.g. a fork). Skipped cleanly when no token is set.

**Publishing to a non-prod stack (dev/QA).** `publishRelease` builds and verifies all
four overlay artifact URLs plus the optional HUD ZIP against an **environment-aware** downloads origin
(`backend/src/utils/releaseDownloadUrls.ts`). It defaults to `falloutchatmod.com`, so
prod is unchanged. A non-prod backend sets `RELEASE_DOWNLOAD_HOST=<that host>` (the dev
stack defaults it to `dev.falloutchatmod.com` in `deploy/dev/docker-compose.yml`), which
makes the SSRF allow-list, `verifyDownload`, and the linked artifact URLs all target that
host's own `/downloads/` origin. To publish on dev: upload the four artifacts to the dev
backend's downloads volume, then `POST https://dev.falloutchatmod.com/admin/releases` with
a `downloadUrl`, `hudModUrl`, and `hudModVersion` on `dev.falloutchatmod.com/downloads/…`
(auth with the dev `ADMIN_API_KEY` via `X-Admin-API-Key`). Build the package with
`-HudTarget dev`; the same fail-closed gates apply — smoke-test the dev build first.
Set `DOWNLOAD_PAGE_URL=https://dev.falloutchatmod.com` so the Dev Discord message links to
the dev install page. The dev announcement is posted to the dev bot's configured
`DISCORD_UPDATES_CHANNEL_ID`; production uses its own configured channel.

### Step 7 — Nexus publish

```powershell
.\Packaging\publish-nexus-release.ps1 -Version X.Y.Z [-ReleaseNotes "..."]
```

> **Windows Nexus upload is DISABLED — signing did NOT bypass it (since 2026-06-21).** The installer
> is code-signed (Step 1 → "Windows code signing"), which removed the website SmartScreen warning,
> but Nexus **still quarantines the `.exe`** by file-type policy: v1.3.91's signed `.exe` reported
> `state=available` on upload, then Nexus's downstream scan flagged it and it was pulled. So the
> `Windows` entry in the platform loop is **commented out** (Linux-only publish); the Linux zip is
> renamed `Fallout Chat Mod <ver>.zip` and bundles `READ ME FIRST (Windows users).txt` pointing
> Windows users to `falloutchatmod.com` (still uploaded to the website in steps 4-6). **Re-enable the
> `Windows` line only if Nexus lifts the `.exe` quarantine** (support ticket).

This script:
1. Calls `Packaging/publish-nexus.ps1` for each enabled file group: the desktop Linux ZIP is published as `main`, and the production `ZFE FCM HUD Mod` ZIP is published as `optional` (Windows stays off Nexus per the note above)
2. Each call implements the 6-step Nexus v3 Upload API: open multipart session → upload chunks to S3 → complete S3 multipart → finalise → poll for `available` state → attach the new file and archive its previous version
3. Uploads the Windows `.exe` to VirusTotal and pushes the permalink to `/admin/virustotal-url`

Required env vars (set as Windows USER env vars):
- `NEXUS_API_KEY`
- `NEXUS_FILE_GROUP_ID_WINDOWS`
- `NEXUS_FILE_GROUP_ID_LINUX`
- `NEXUS_FILE_GROUP_ID_HUD` — the separate optional HUD file group on the same Nexus mod page
- `VT_API_KEY`
- `PROD_ADMIN_RELEASE_TOKEN`

The HUD package is uploaded from `dist-electron/ZFE FCM HUD Mod-<widget-version> (PROD).zip`.
Its Nexus file version is the widget version read from `FCMChatWidget.hx`, not the desktop
overlay version. Create the HUD file group in the Nexus Files tab and set its ID in
`NEXUS_FILE_GROUP_ID_HUD`; the wrapper then replaces the previous HUD file on each release.

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

**Re-running an installer is the update/patch path** (auto-update was removed). It is a full,
idempotent fast-forward — a user many versions behind lands on latest in one run (installers always
fetch the newest version; there is no minimum-version gate; Windows NSIS overwrites in place via
`installer.nsh`'s taskkill, Linux overwrites a stable version-agnostic path; the startup migrations are
any-to-any idempotent; `userData` is outside the package so settings survive). Each CLI installer
detects the installed version and, **when the machine is already on the latest**, prompts
reinstall-or-cancel instead of silently reinstalling:

- **Windows** reads the installed exe's `VersionInfo.ProductVersion`, compares with `[version]`, and
  asks via `Read-Host`. It also checks the NSIS exit code and only reports success on `0`.
- **Linux** reads the `$XDG_DATA_HOME/FalloutChatMod/.fcm-version` marker (written at install time),
  compares with `sort -V`, and prompts from `/dev/tty` (piped/non-interactive → defaults to Cancel).

The four installer copies (`Packaging/windows/install.ps1`, `Packaging/linux/install.sh`, and the
served `backend/downloads/install.{ps1,sh}` re-seeded from `Packaging/` at boot) must stay in sync.
See `../overlay/auto-update.md` → "Updating / patching from an old version".

---

## Killing the Overlay After Testing

The overlay is multi-process (main + GPU + renderer + utility), all named `Fallout Chat Mod.exe` (or `electron.exe` in dev):

```powershell
Get-Process -Name 'Fallout Chat Mod','electron' -EA SilentlyContinue | Stop-Process -Force
```

Never kill `Fallout76`.
