# Packaging Scripts

All scripts live in `Packaging/`. They are called in sequence during the release pipeline; see [releasing-the-overlay.md](releasing-the-overlay.md) for the full order.

---

## Packaging/package-downloads.ps1

**Purpose:** Build the two desktop human-download ZIP archives and the target-specific optional
in-game HUD-mod ZIP from the raw `electron-builder` artifacts and current HUD widget source.

**Usage:**
```powershell
.\Packaging\package-downloads.ps1 -Version X.Y.Z
```

**What it does:**
1. Locates `Fallout Chat Mod Setup X.Y.Z.exe`, `Fallout Chat Mod-X.Y.Z.AppImage`, and `Fallout Chat Mod-X.Y.Z.deb` in `cross-platform-overlay/dist-electron/` (the `.deb` artifact name is pinned by `build.deb.artifactName`; a missing `.deb` fails the build)
2. Reads instruction files from `cross-platform-overlay/assets/install/`: `INSTALL-WINDOWS.txt`, `INSTALL-LINUX.txt`, and `fallout-chatmod-keepabove.kwinrule`
3. Stages each artifact + its instruction file(s) in a temp directory on the same drive as the dist dir (avoids cross-drive copies on dev machines where C: may be full)
4. Compresses the staging contents (files at root, not nested in a subfolder) into:
   - `Fallout Chat Mod Setup X.Y.Z (Windows).zip` — installer + `INSTALL-WINDOWS.txt`
   - `Fallout Chat Mod-X.Y.Z.AppImage (Linux).zip` — AppImage + **`.deb`** + `INSTALL-LINUX.txt` + `.kwinrule`
   - `ZFE FCM HUD Mod-<widget-version> (PROD).zip` — `FCMChatWidget.ba2`, both runtime INIs,
     an append-only `FCMChatWidget.hudmodloader.ini` snippet, `FCMChatWidget.version.txt`,
     `Fallout76Custom.ini.example`, and target-specific `INSTALL.txt`
5. All three ZIPs land in `cross-platform-overlay/dist-electron/` alongside the raw files

The `.deb` ships inside the Linux ZIP so apt users can `sudo apt install ./'Fallout Chat Mod-X.Y.Z.deb'` (or `dpkg -i`) — an in-place, apt-managed alternative to the AppImage. `Packaging/release.ps1` also verifies + uploads the raw `.deb` alongside the AppImage, and the website exposes both raw Linux files side by side.

**Note:** The ZIPs are for website/Nexus human downloads only. There are no `latest*.yml` feed files — `build.publish` was removed for Nexus Mods ToS compliance.

The HUD ZIP is a separate, explicit opt-in install for the in-game HUD track; it never replaces
the user's existing `Data/hudmodloader.ini`. `package.py` reads the widget version from
`FCMChatWidget.hx` and refuses to package a stale BA2. Use `-HudTarget dev` when producing a
hosted-dev package; use the default `prod` target for production. Never copy a stamped package
between environments.

**Parameters:**
- `-Version` (required) — e.g. `1.3.73`
- `-DistDir` (optional) — defaults to `<repo>/cross-platform-overlay/dist-electron`
- `-AssetsDir` (optional) — defaults to `<repo>/cross-platform-overlay/assets`
- `-HudModDir` (optional) — defaults to `<repo>/game-mods/FCMBridge/hudmodloader-chat`
- `-HudTarget` (optional) — `prod` (default) or `dev`; stamps the HUD relay/link configuration and instructions

---

## Packaging/publish-nexus-release.ps1

**Purpose:** Orchestrate the full Nexus publish + VirusTotal upload for a built release. This is the main entry point for the Nexus step of the release pipeline.

**Usage:**
```powershell
.\Packaging\publish-nexus-release.ps1 -Version X.Y.Z [-ReleaseNotes "What's new..."] [-HudModDir path] [-DryRun]
```

**What it does:**
1. Calls `publish-nexus.ps1` for the Linux AppImage ZIP and Linux `.deb` ZIP as `main`, and the production HUD ZIP as `optional`; each normal replacement archives the previous file only after the new upload reaches Nexus `available`
2. Uses the desktop version for both Linux Nexus files and the current `FCMChatWidget.hx` version for the HUD Nexus file
3. After the Nexus publishes succeed, uploads the raw Windows `.exe` to VirusTotal using the large-file upload URL (required for files > 32 MB)
4. Computes the SHA-256 permalink and POSTs it to `POST https://falloutchatmod.com/admin/virustotal-url` so the `/virustotal` redirect always points at the latest scan

Windows is an explicit, support-gated path because Nexus may quarantine `.exe` uploads. To upload
a new Windows ZIP alongside the existing live Windows file for review, run:

```powershell
.\Packaging\publish-nexus-release.ps1 -Version X.Y.Z -PublishWindowsForReview
```

The review path sends `archive_existing_file: false`, so both Windows files remain available. After
Nexus support approves the new file, remove the old Windows file manually in the Nexus Files tab.
The ordinary release path does not upload Windows to Nexus, and therefore does not require
`NEXUS_FILE_GROUP_ID_WINDOWS`.

**Required env vars** (Windows: set as USER env vars so they persist across PowerShell sessions. Linux/`pwsh`: put them in the repo-root `.env`/`.env.local` — `release.ps1` auto-loads them via `Import-DotEnv` — or `export` them before running):
- `NEXUS_API_KEY` — personal API key from nexusmods.com/settings/api-keys
- `NEXUS_FILE_GROUP_ID_WINDOWS` — file-group id for the Windows file (required only with `-PublishWindowsForReview`; Files tab → Manage Files → API Info)
- `NEXUS_FILE_GROUP_ID_LINUX` — file-group id for the Linux file
- `NEXUS_FILE_GROUP_ID_LINUX_DEB` — separate file-group id for the Linux `.deb` file
- `NEXUS_FILE_GROUP_ID_HUD` — separate file-group id for the optional HUD ZIP on the same Nexus mod page
- `VT_API_KEY` — VirusTotal personal API key
- `PROD_ADMIN_RELEASE_TOKEN` — backend admin release token (from `backend/.env`)

The HUD file is uploaded as a separate optional Nexus file group, so it does not replace the
desktop download. Set `NEXUS_FILE_GROUP_ID_HUD` to the group created for the HUD package in the
Nexus Files tab. The wrapper expects `ZFE FCM HUD Mod-<widget-version> (PROD).zip` to already
exist in `dist-electron/` (the normal `release.ps1` sequence creates it in step 4), then archives
the previous HUD file when the new one reaches Nexus `available` state. The low-level uploader
defaults to preserving the previous file; the wrapper opts into archiving for the normal Linux,
`.deb`, and HUD replacement paths.

**ASCII-only rule:** This script must remain ASCII-only. PowerShell 5.1 via `-File` mis-tokenizes non-ASCII characters (em-dashes, smart quotes, etc.) inside double-quoted strings and throws a misleading `Unexpected token '}'` parse error. Use plain hyphens (`-`), never Unicode dashes.

---

## Packaging/publish-nexus.ps1

**Purpose:** Low-level Nexus v3 Upload API wrapper. Called by `publish-nexus-release.ps1`; not normally invoked directly during a release.

**What it does (6-step Nexus v3 flow):**
1. `POST /uploads/multipart` — open a multipart upload session, receive presigned S3 part URLs
2. `PUT <presigned part urls>` — upload each chunk to S3 (no API key on these calls — auth is baked into the URLs)
3. `POST <complete presigned url>` — complete the S3 multipart upload (XML body with ETags)
4. `POST /uploads/{id}/finalise` — hand the upload back to Nexus
5. `GET /uploads/{id}` (poll) — wait until state is `available` (Nexus virus-scans the file)
6. `POST /mod-file-update-groups/{group_id}/versions` — attach as a new file, with
   `archive_existing_file` explicitly set by the caller

There is no standalone archive/delete endpoint on Nexus; the previous file is archived as a side
effect of posting a replacement only when `archive_existing_file: true`. The low-level wrapper
defaults this field to `false` so support-review uploads cannot retire the existing live file by
accident. Pass `-ArchiveExisting:$true` only for an approved replacement.

**Windows curl.exe / Schannel TLS note:** All Nexus API calls use `curl.exe` (not `Invoke-RestMethod`) with `--ssl-revoke-best-effort` to avoid a hard-revocation handshake failure. Windows curl is built against Schannel, which does a hard OCSP/CRL check. When the Nexus/Cloudflare revocation responder is slow or unreachable, the TLS handshake never completes (HTTP 000, `time_appconnect = 0`). The `--ssl-revoke-best-effort` flag tolerates an unreachable responder without disabling revocation entirely. Calls also carry `--connect-timeout 15 --max-time 120` and retry up to 4 times on transient failures (HTTP 0 or 5xx).

**Parameters:** `-FilePath`, `-Version`, `-FileGroupId`, `-ZipAs` (wrap in a zip before upload), `-Description`, `-IncludeFiles` (extra files to bundle in the zip), `-ArchiveExisting`, `-DryRun`.

---

## Packaging/patch-setup-manifest.ps1

**Purpose:** Post-build patch for the embedded Windows manifest in a compiled `.exe`. Rewrites `level="asInvoker"` to `level="requireAdministrator"` in the PE's `RT_MANIFEST` resource using the Win32 `UpdateResource` API.

**Usage:**
```powershell
.\Packaging\patch-setup-manifest.ps1 -Path "path\to\executable.exe"
```

**Why it exists:** The Inno Setup compiler (used for Windows installer builds) and some .NET publish profiles emit `asInvoker` manifests. For the setup/uninstall executables that must show a UAC elevation prompt, the manifest needs `requireAdministrator`. This script patches the resource in place without recompiling.

The patch preserves the original byte length by trimming excess whitespace inside the `uiAccess` attribute — necessary because Windows PE loaders can be sensitive to manifest size changes.

---

## Packaging/windows/

| File | Purpose |
|------|---------|
| `install.ps1` | CLI one-liner installer: `irm https://falloutchatmod.com/install.ps1 \| iex`. Queries `GET /api/releases` to discover the current version, downloads the raw `.exe`, and runs it silently (per-user, no UAC). Doubles as the **update/patch path**: reads the installed exe's `VersionInfo.ProductVersion`, fast-forwards from any older version, and when already on the latest **prompts reinstall-or-cancel** (`Read-Host`); checks the NSIS exit code and only reports success on `0`. Displayed in the Windows file description on Nexus. |

---

## Packaging/linux/

| File | Purpose |
|------|---------|
| `install.sh` | CLI one-liner installer: `curl -fsSL https://falloutchatmod.com/install.sh \| bash`. Detects distro family, session/compositor, FUSE2, package manager, and Linux helpers before choosing a path: per-user `.AppImage` by default, `--appimage-extract-and-run` when FUSE2 is unavailable, or an explicitly confirmed Debian-family `.deb` (`--format deb`). It never installs helpers or invokes `sudo` silently. The AppImage path is downloaded to a stable version-agnostic path (`$XDG_DATA_HOME/FalloutChatMod/Fallout Chat Mod.AppImage`), makes it executable, rewrites the `.desktop` launcher, and writes a `.fcm-version` marker. `--print-plan` reports detection without downloading. Doubles as the **update/patch path**: overwrites in place (fast-forwards from any older version) and when the `.fcm-version` marker shows the latest is already installed **prompts reinstall-or-cancel** from `/dev/tty` (piped/non-interactive → defaults to Cancel). |
| `uninstall.sh` | Removes the per-user AppImage, `.fcm-version` marker, and desktop launcher entry. A `.deb` install is owned by apt/dpkg and should be removed with the package manager. |

---

## cross-platform-overlay/assets/ (referenced by packaging scripts)

| Path | Used by |
|------|---------|
| `assets/install/INSTALL-WINDOWS.txt` | Bundled into Windows ZIP by `package-downloads.ps1` and `publish-nexus-release.ps1` |
| `assets/install/INSTALL-LINUX.txt` | Bundled into Linux ZIP |
| `assets/fallout-chatmod-keepabove.kwinrule` | Bundled into Linux ZIP; required by KDE Plasma (Wayland) users for always-on-top behavior |
