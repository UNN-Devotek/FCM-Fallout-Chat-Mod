<#
.SYNOPSIS
    Publishes a built release (Windows .exe + Linux .AppImage) to Nexus Mods,
    one call per platform, wrapping each installer in a platform-named .zip and
    attaching it as the new MAIN file (archiving the previous one).

.DESCRIPTION
    Thin wrapper over publish-nexus.ps1 that knows the per-platform file-group ids
    and descriptions. Finds the version's artifacts in the Electron build output
    (cross-platform-overlay/dist-electron), publishes both platforms to Nexus, then
    uploads the Windows .exe to VirusTotal and pushes the permalink to the backend
    so falloutchatmod.com/virustotal always points at the latest scan.

    Release pipeline context (where this script fits):
      1. Build: electron-builder produces the raw .exe (Windows) and .AppImage (Linux)
         in cross-platform-overlay/dist-electron/.
      2. ZIPs: package-downloads.ps1 wraps each raw artifact into a website/Nexus ZIP
         alongside INSTALL-*.txt (and .kwinrule for Linux).
      3. VirusTotal: THIS SCRIPT uploads the raw Windows .exe to VT and pushes the
         SHA-256 permalink to /admin/virustotal-url (falloutchatmod.com/virustotal).
      4. Upload: the raw artifacts and ZIPs are scp'd to
         /app/downloads/electron/ on the VPS (see DEPLOY.md for the exact commands).
      5. Size verify: confirm the bytes served by the VPS match the local build artifact size.
      6. Register: POST /admin/releases {version, downloadUrl (Windows ZIP), releaseNotes}.
      7. Nexus: THIS SCRIPT publishes Windows + Linux ZIPs to Nexus Mods as new MAIN
         files (archiving the previous ones) via publish-nexus.ps1.

    IMPORTANT -- ASCII-ONLY SCRIPT RULE:
      Keep this file ASCII-only. Windows PowerShell 5.1 run via the `-File` flag
      mis-tokenizes non-ASCII characters (e.g. em-dashes U+2014) inside double-quoted
      strings and throws a misleading "Unexpected token '}'" parse error that points
      at an unrelated closing brace. This was a real bug (comment added to prevent
      regression). Use plain ASCII hyphens (-), not em-dashes or any Unicode dash.

    Env vars (set as Windows USER env vars):
      NEXUS_API_KEY               personal API key (apikey header)
      NEXUS_FILE_GROUP_ID_WINDOWS file-group id for the Windows file
      NEXUS_FILE_GROUP_ID_LINUX   file-group id for the Linux file
      VT_API_KEY                  VirusTotal personal API key
      PROD_ADMIN_RELEASE_TOKEN    falloutchatmod.com admin release token

.PARAMETER Version   e.g. 1.3.73
.PARAMETER DistDir   build-output dir (default: ..\cross-platform-overlay\dist-electron)
.PARAMETER DryRun    print planned calls (and test the zip step) without uploading
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$DistDir = "",
    # Release notes for this version -- prepended to each Nexus file description as
    # a "What's new in vX.Y.Z" block so the changelog is visible on the file page.
    [string]$ReleaseNotes = "",
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
# Release notes may arrive via the FCM_RELEASE_NOTES env var instead of the
# -ReleaseNotes parameter. The orchestrator (release.ps1) uses the env var because
# passing a multi-line, quoted notes string as a child-process -File argument gets
# re-parsed on the command line and corrupts later args (a ':' in the notes was
# read as a PSDrive). An env var carries arbitrary content with no such parsing.
if (-not $ReleaseNotes -and $env:FCM_RELEASE_NOTES) { $ReleaseNotes = $env:FCM_RELEASE_NOTES }
# "What's new" block (blank if no notes supplied).
$notesBlock = if ($ReleaseNotes.Trim()) { "What's new in v${Version}:`n$($ReleaseNotes.Trim())`n`n" } else { "" }
if (-not $DistDir) { $DistDir = Join-Path $PSScriptRoot "..\cross-platform-overlay\dist-electron" }
$nexus     = Join-Path $PSScriptRoot "publish-nexus.ps1"
$assetsDir = Join-Path $PSScriptRoot "..\cross-platform-overlay\assets"

$winGroup   = $env:NEXUS_FILE_GROUP_ID_WINDOWS
$linuxGroup = $env:NEXUS_FILE_GROUP_ID_LINUX
# Fall back to the persistent USER-scope value (process env may not carry it).
if (-not $winGroup)   { $winGroup   = [Environment]::GetEnvironmentVariable('NEXUS_FILE_GROUP_ID_WINDOWS','User') }
if (-not $linuxGroup) { $linuxGroup = [Environment]::GetEnvironmentVariable('NEXUS_FILE_GROUP_ID_LINUX','User') }
if (-not $winGroup -or -not $linuxGroup) {
    Write-Error "Set NEXUS_FILE_GROUP_ID_WINDOWS and NEXUS_FILE_GROUP_ID_LINUX env vars first."
    exit 1
}

# productName is "Fallout Chat Mod" (WITH spaces) -- electron-builder output names.
$winExe   = Join-Path $DistDir "Fallout Chat Mod Setup $Version.exe"
$linuxApp = Join-Path $DistDir "Fallout Chat Mod-$Version.AppImage"

# -- FAIL-CLOSED VirusTotal gate -------------------------------------------------
# Run the VT gate FIRST and ABORT (do not upload anything to Nexus) if it returns
# non-zero. vt-gate.ps1 BLOCKS on the completed scan and fails if the build is
# flagged. A flagged/broken build must never reach Nexus.
#
# NOTE: the operator must ALSO run smoke-test.ps1 (launch smoke-test) and this same
# vt-gate.ps1 BEFORE the website/feed upload + POST /admin/releases. This in-script
# call only guards the Nexus publish step. See docs/deployment/releasing-the-overlay.md.
if (-not $DryRun) {
    $vtGate = Join-Path $PSScriptRoot "vt-gate.ps1"
    Write-Host "==== Running VirusTotal gate before Nexus publish ===="
    # Cross-platform: Windows PowerShell on Windows, PowerShell 7 (pwsh) on Linux/macOS
    # (a release can be cut from Linux). powershell.exe does not exist off Windows.
    $psExe = if ($IsWindows) { 'powershell.exe' } else { 'pwsh' }
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $vtGate -Version $Version -DistDir $DistDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "VT gate FAILED (exit $LASTEXITCODE) - aborting Nexus publish. Release blocked."
        exit 1
    }
    Write-Host "==== VT gate passed - proceeding to Nexus publish ===="
} else {
    Write-Host "[release] DRY RUN - skipping VT gate."
}

# Per-platform display name for the uploaded .zip (matches the manual naming).
$winZip   = "Fallout Chat Mod Setup $Version (Windows).zip"
$linuxZip = "Fallout Chat Mod-$Version.AppImage (Linux).zip"

# Windows file carries the SmartScreen/AV false-positive disclaimer + CLI option.
$winDesc = $notesBlock + @"
Full install instructions for every platform: https://falloutchatmod.com (SYSTEM -> INSTALL)

PREFER THE CLI? One-line install (PowerShell):
    irm https://falloutchatmod.com/install.ps1 | iex

Or download this zip, extract, and run "Fallout Chat Mod Setup <version>.exe". See INSTALL-WINDOWS.txt inside the zip.

About antivirus / SmartScreen: because the installer isn't code-signed yet, you may see a SmartScreen "unknown publisher" warning, and some antivirus tools may flag it. This is a false positive driven by the lack of a signing certificate, not the app's behavior - Fallout Chat Mod does not modify game files, read game memory, or scan your network.
"@
$linuxDesc = $notesBlock + @"
Full install instructions for every platform: https://falloutchatmod.com (SYSTEM -> INSTALL)

PREFER THE CLI? One-line install (adds an app-menu launcher):
    curl -fsSL https://falloutchatmod.com/install.sh | bash

Or download this zip, extract, then: chmod +x the AppImage and run it. See INSTALL-LINUX.txt inside the zip. Requires an X11/XWayland session.

KDE Plasma (Wayland) users: run Fallout 76 in WINDOWED mode (not Borderless) and set your taskbar/panel to Auto-Hide - that's the reliable setup. For a borderless look, use the Steam launch option PROTON_NO_WM_DECORATION=1 %command% instead. Do NOT add a game-side "Fullscreen = No" KWin rule (it breaks the loading screen / in-game UI).
"@

# Per-platform extra files to bundle into the Nexus zip alongside the installer.
# Result: Nexus zip = installer + same instruction files as the website zip.
$winInclude   = @(
    (Join-Path $assetsDir "install\INSTALL-WINDOWS.txt")
)
$linuxInclude = @(
    (Join-Path $assetsDir "install\INSTALL-LINUX.txt"),
    (Join-Path $assetsDir "fallout-chatmod-keepabove.kwinrule")
)

foreach ($p in @(
    @{ Name = "Windows"; File = $winExe;   Zip = $winZip;   Group = $winGroup;   Desc = $winDesc;   Include = $winInclude   },
    @{ Name = "Linux";   File = $linuxApp; Zip = $linuxZip; Group = $linuxGroup; Desc = $linuxDesc; Include = $linuxInclude }
)) {
    if (-not (Test-Path $p.File)) { Write-Error "[$($p.Name)] artifact not found: $($p.File)"; exit 1 }
    Write-Host "==== Publishing $($p.Name) -> Nexus group $($p.Group) ===="
    $args = @{
        FilePath      = $p.File
        Version       = $Version
        FileGroupId   = $p.Group
        ZipAs         = $p.Zip
        Description   = $p.Desc
        IncludeFiles  = $p.Include
        FileCategory  = "main"
    }
    if ($DryRun) { $args.DryRun = $true }
    & $nexus @args
    if ($LASTEXITCODE -ne 0) { Write-Error "[$($p.Name)] publish failed (exit $LASTEXITCODE)"; exit 1 }
}
Write-Host "==== Nexus publish complete for v$Version (Windows + Linux) ===="

# -- VirusTotal upload + backend permalink update --------------------------------
# The Windows .exe is ~81 MB (>32 MB) so we must use the large-file upload URL.
# VT_API_KEY and PROD_ADMIN_RELEASE_TOKEN are read from Windows USER env vars.
$vtKey     = $env:VT_API_KEY
$relToken  = $env:PROD_ADMIN_RELEASE_TOKEN
if (-not $vtKey)    { $vtKey    = [Environment]::GetEnvironmentVariable('VT_API_KEY','User') }
if (-not $relToken) { $relToken = [Environment]::GetEnvironmentVariable('PROD_ADMIN_RELEASE_TOKEN','User') }

if (-not $vtKey) {
    Write-Warning "[virustotal] VT_API_KEY not set - skipping VirusTotal upload"
} else {
    Write-Host "==== Uploading Windows .exe to VirusTotal ===="
    # Compute SHA-256 so we can build the permalink without waiting for VT to analyse.
    $sha256 = (Get-FileHash -Algorithm SHA256 $winExe).Hash.ToLower()
    $vtPermalink = "https://www.virustotal.com/gui/file/$sha256/detection"

    if ($DryRun) {
        Write-Host "[virustotal] DRY RUN - would upload $winExe and set permalink: $vtPermalink"
    } else {
        # Step 1: get a large-file upload URL (required for files >32 MB)
        $uploadUrlResp = Invoke-RestMethod -Uri "https://www.virustotal.com/api/v3/files/upload_url" `
            -Headers @{ "x-apikey" = $vtKey } -Method Get
        $uploadUrl = $uploadUrlResp.data
        if (-not $uploadUrl) { Write-Warning "[virustotal] Could not get upload URL - skipping"; return }

        # Step 2: multipart upload the .exe (~80 MB; VT processes it asynchronously).
        # NOTE: Invoke-RestMethod -Form was added in PowerShell 7; this script must run
        # under Windows PowerShell 5.1, so we build the multipart body manually.
        # NOTE: keep these strings ASCII-only -- see the header comment re: PS 5.1 / -File.
        Write-Host "[virustotal] Uploading $('{0:N1}' -f ((Get-Item $winExe).Length / 1MB)) MB..."
        $boundary  = [System.Guid]::NewGuid().ToString("N")
        $fileName  = [System.IO.Path]::GetFileName($winExe)
        $fileBytes = [System.IO.File]::ReadAllBytes($winExe)
        $enc       = [System.Text.Encoding]::ASCII
        $preamble  = $enc.GetBytes("--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"$fileName`"`r`nContent-Type: application/octet-stream`r`n`r`n")
        $epilogue  = $enc.GetBytes("`r`n--$boundary--`r`n")
        $ms        = New-Object System.IO.MemoryStream
        $ms.Write($preamble,  0, $preamble.Length)
        $ms.Write($fileBytes, 0, $fileBytes.Length)
        $ms.Write($epilogue,  0, $epilogue.Length)
        $multipartBytes = $ms.ToArray()
        $ms.Dispose()
        try {
            Invoke-RestMethod -Uri $uploadUrl -Method Post `
                -Headers @{ "x-apikey" = $vtKey } `
                -ContentType "multipart/form-data; boundary=$boundary" `
                -Body $multipartBytes | Out-Null
        } catch {
            if ($_.ErrorDetails.Message -match "AlreadySubmittedError") {
                Write-Host "[virustotal] Already submitted (same SHA-256) - permalink still valid."
            } else {
                Write-Warning "[virustotal] Upload failed: $($_.Exception.Message) - continuing."
            }
        }

        Write-Host "[virustotal] Upload queued. Permalink: $vtPermalink"

        # Step 3: push the permalink to the backend so /virustotal redirects to it.
        # Uses a manually-built JSON string to avoid ConvertTo-Json adding a BOM.
        if (-not $relToken) {
            Write-Warning "[virustotal] PROD_ADMIN_RELEASE_TOKEN not set - could not update /virustotal redirect"
        } else {
            $body = '{"url":"' + $vtPermalink + '"}'
            Invoke-RestMethod -Uri "https://falloutchatmod.com/admin/virustotal-url" -Method Post `
                -Headers @{ "Authorization" = "Bearer $relToken"; "Content-Type" = "application/json" } `
                -Body $body | Out-Null
            Write-Host "[virustotal] /virustotal redirect updated -> $vtPermalink"
        }
    }
}
