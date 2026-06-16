# Packaging Scripts

All scripts live in `Packaging/`. They are called in sequence during the release pipeline; see [releasing-the-overlay.md](releasing-the-overlay.md) for the full order.

---

## Packaging/package-downloads.ps1

**Purpose:** Build the two human-download ZIP archives from the raw `electron-builder` artifacts.

**Usage:**
```powershell
.\Packaging\package-downloads.ps1 -Version X.Y.Z
```

**What it does:**
1. Locates `Fallout Chat Mod Setup X.Y.Z.exe` and `Fallout Chat Mod-X.Y.Z.AppImage` in `cross-platform-overlay/dist-electron/`
2. Reads instruction files from `cross-platform-overlay/assets/install/`: `INSTALL-WINDOWS.txt`, `INSTALL-LINUX.txt`, and `fallout-chatmod-keepabove.kwinrule`
3. Stages each artifact + its instruction file(s) in a temp directory on the same drive as the dist dir (avoids cross-drive copies on dev machines where C: may be full)
4. Compresses the staging contents (files at root, not nested in a subfolder) into:
   - `Fallout Chat Mod Setup X.Y.Z (Windows).zip`
   - `Fallout Chat Mod-X.Y.Z.AppImage (Linux).zip`
5. Both ZIPs land in `cross-platform-overlay/dist-electron/` alongside the raw files

**Note:** The ZIPs are for website/Nexus human downloads only. There are no `latest*.yml` feed files — `build.publish` was removed for Nexus Mods ToS compliance.

**Parameters:**
- `-Version` (required) — e.g. `1.3.73`
- `-DistDir` (optional) — defaults to `<repo>/cross-platform-overlay/dist-electron`
- `-AssetsDir` (optional) — defaults to `<repo>/cross-platform-overlay/assets`

---

## Packaging/publish-nexus-release.ps1

**Purpose:** Orchestrate the full Nexus publish + VirusTotal upload for a built release. This is the main entry point for the Nexus step of the release pipeline.

**Usage:**
```powershell
.\Packaging\publish-nexus-release.ps1 -Version X.Y.Z [-ReleaseNotes "What's new..."] [-DryRun]
```

**What it does:**
1. Calls `publish-nexus.ps1` once for the Windows ZIP and once for the Linux ZIP, passing per-platform file-group IDs and descriptions
2. The Windows description includes a SmartScreen / false-positive disclaimer
3. After both Nexus publishes succeed, uploads the raw Windows `.exe` to VirusTotal using the large-file upload URL (required for files > 32 MB)
4. Computes the SHA-256 permalink and POSTs it to `POST https://falloutchatmod.com/admin/virustotal-url` so the `/virustotal` redirect always points at the latest scan

**Required env vars** (Windows: set as USER env vars so they persist across PowerShell sessions. Linux/`pwsh`: put them in the repo-root `.env`/`.env.local` — `release.ps1` auto-loads them via `Import-DotEnv` — or `export` them before running):
- `NEXUS_API_KEY` — personal API key from nexusmods.com/settings/api-keys
- `NEXUS_FILE_GROUP_ID_WINDOWS` — file-group id for the Windows file (Files tab → Manage Files → API Info)
- `NEXUS_FILE_GROUP_ID_LINUX` — file-group id for the Linux file
- `VT_API_KEY` — VirusTotal personal API key
- `PROD_ADMIN_RELEASE_TOKEN` — backend admin release token (from `backend/.env`)

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
6. `POST /mod-file-update-groups/{group_id}/versions` — attach as new MAIN file with `archive_existing_file: true`

There is no standalone archive/delete endpoint on Nexus; the previous file is archived as a side effect of posting a replacement.

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
| `install.ps1` | CLI one-liner installer: `irm https://falloutchatmod.com/install.ps1 \| iex`. Queries `GET /api/releases` to discover the current version, downloads the raw `.exe`, and runs it silently (per-user, no UAC). Displayed in the Windows file description on Nexus. |

---

## Packaging/linux/

| File | Purpose |
|------|---------|
| `install.sh` | CLI one-liner installer: `curl -fsSL https://falloutchatmod.com/install.sh \| bash`. Queries `GET /api/releases` to discover the current version, downloads the `.AppImage`, makes it executable, and adds an app-menu launcher. |
| `uninstall.sh` | Removes the installed AppImage and desktop launcher entry. |

---

## cross-platform-overlay/assets/ (referenced by packaging scripts)

| Path | Used by |
|------|---------|
| `assets/install/INSTALL-WINDOWS.txt` | Bundled into Windows ZIP by `package-downloads.ps1` and `publish-nexus-release.ps1` |
| `assets/install/INSTALL-LINUX.txt` | Bundled into Linux ZIP |
| `assets/fallout-chatmod-keepabove.kwinrule` | Bundled into Linux ZIP; required by KDE Plasma (Wayland) users for always-on-top behavior |
