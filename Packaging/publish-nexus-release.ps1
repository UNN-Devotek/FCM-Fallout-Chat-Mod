<#
.SYNOPSIS
    Publishes a built release (Linux AppImage + .deb + optional in-game HUD package)
    to Nexus Mods, attaching each artifact to its stable mod file.

.DESCRIPTION
    Thin wrapper over publish-nexus.ps1 that knows the per-platform mod-file ids.
    Existing descriptions are read from Nexus before each upload. Finds the version's artifacts in the Electron build output
    (cross-platform-overlay/dist-electron), publishes the Linux desktop package
    and the optional HUD package to Nexus, then uploads the Windows .exe to
    VirusTotal and pushes the permalink to the backend so
    falloutchatmod.com/virustotal always points at the latest scan.

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
      7. Nexus: THIS SCRIPT publishes Linux and HUD ZIPs as MAIN files, archiving
         their previous versions. HUD is the primary download. Pass
         -PublishWindowsForReview to upload standard and configured portable
         Windows ZIPs as MAIN files without archiving existing Windows versions.

    IMPORTANT -- ASCII-ONLY SCRIPT RULE:
      Keep this file ASCII-only. Windows PowerShell 5.1 run via the `-File` flag
      mis-tokenizes non-ASCII characters (e.g. em-dashes U+2014) inside double-quoted
      strings and throws a misleading "Unexpected token '}'" parse error that points
      at an unrelated closing brace. This was a real bug (comment added to prevent
      regression). Use plain ASCII hyphens (-), not em-dashes or any Unicode dash.

    Env vars (set as Windows USER env vars):
      NEXUS_API_KEY               personal API key (apikey header)
      NEXUS_MOD_FILE_ID_WINDOWS stable mod-file id for the Windows file
      NEXUS_MOD_FILE_ID_WINDOWS_PORTABLE stable mod-file id for portable Windows
      NEXUS_MOD_FILE_ID_LINUX stable mod-file id for the Linux AppImage file
      NEXUS_MOD_FILE_ID_LINUX_DEB stable mod-file id for the Linux .deb file
      NEXUS_MOD_FILE_ID_HUD stable mod-file id for the optional HUD file
      VT_API_KEY                  VirusTotal personal API key
      PROD_ADMIN_RELEASE_TOKEN    falloutchatmod.com admin release token

.PARAMETER Version   e.g. 1.3.73
.PARAMETER DistDir   build-output dir (default: ..\cross-platform-overlay\dist-electron)
.PARAMETER HudModDir   HUD package source dir (default: ..\game-mods\FCMBridge\hudmodloader-chat)
.PARAMETER DryRun    print planned calls (and test the zip step) without uploading
.PARAMETER PublishWindowsForReview
    Upload the Windows ZIP as a second MAIN file alongside the existing Windows
    file without archiving it. If the portable file id is configured, upload its
    ZIP the same way. Approved Windows versions remain in MAIN for manual handling.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Version,
    [Parameter(Mandatory = $true)] [string]$BridgeZip,
    [string]$DistDir = "",
    [string]$HudModDir = "",
    [switch]$DryRun,
    [switch]$PublishWindowsForReview
)
$ErrorActionPreference = "Stop"
$repoRoot  = Split-Path $PSScriptRoot -Parent
$overlayDir = Join-Path $repoRoot "cross-platform-overlay"
if (-not $DistDir) { $DistDir = Join-Path $overlayDir "dist-electron" }
$gameModsDir = Join-Path $repoRoot "game-mods"
$fcmBridgeDir = Join-Path $gameModsDir "FCMBridge"
if (-not $HudModDir) { $HudModDir = Join-Path $fcmBridgeDir "hudmodloader-chat" }
$nexus     = Join-Path $PSScriptRoot "publish-nexus.ps1"
$assetsDir = Join-Path $overlayDir "assets"
$hudPackage = Join-Path $HudModDir "package.py"
$nexusPackage = Join-Path $PSScriptRoot "package-nexus-downloads.ps1"

$winGroup   = $env:NEXUS_MOD_FILE_ID_WINDOWS
$portableGroup = $env:NEXUS_MOD_FILE_ID_WINDOWS_PORTABLE
$linuxGroup = $env:NEXUS_MOD_FILE_ID_LINUX
$linuxDebGroup = $env:NEXUS_MOD_FILE_ID_LINUX_DEB
$hudGroup   = $env:NEXUS_MOD_FILE_ID_HUD
$publishWindows = [bool]$PublishWindowsForReview
# Fall back to the persistent USER-scope value (process env may not carry it).
if (-not $winGroup)   { $winGroup   = [Environment]::GetEnvironmentVariable('NEXUS_MOD_FILE_ID_WINDOWS','User') }
if (-not $portableGroup) { $portableGroup = [Environment]::GetEnvironmentVariable('NEXUS_MOD_FILE_ID_WINDOWS_PORTABLE','User') }
if (-not $linuxGroup) { $linuxGroup = [Environment]::GetEnvironmentVariable('NEXUS_MOD_FILE_ID_LINUX','User') }
if (-not $linuxDebGroup) { $linuxDebGroup = [Environment]::GetEnvironmentVariable('NEXUS_MOD_FILE_ID_LINUX_DEB','User') }
if (-not $hudGroup)   { $hudGroup   = [Environment]::GetEnvironmentVariable('NEXUS_MOD_FILE_ID_HUD','User') }
if (-not $linuxGroup -or -not $linuxDebGroup -or -not $hudGroup -or ($publishWindows -and -not $winGroup)) {
    $requiredGroups = "NEXUS_MOD_FILE_ID_LINUX, NEXUS_MOD_FILE_ID_LINUX_DEB, and NEXUS_MOD_FILE_ID_HUD"
    if ($publishWindows) { $requiredGroups += ", plus NEXUS_MOD_FILE_ID_WINDOWS for the Windows upload" }
    Write-Error "Set $requiredGroups env vars first."
    exit 1
}

if (-not (Test-Path $hudPackage)) {
    Write-Error "HUD package helper not found: $hudPackage"
    exit 1
}
if (-not (Test-Path $nexusPackage)) {
    Write-Error "Nexus package helper not found: $nexusPackage"
    exit 1
}
$pythonCommand = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $pythonCommand) { $pythonCommand = Get-Command python -ErrorAction SilentlyContinue }
if (-not $pythonCommand) {
    Write-Error "Python 3 is required to resolve the HUD widget version."
    exit 1
}
$hudVersion = (& $pythonCommand.Source $hudPackage --print-version).Trim()
if ($LASTEXITCODE -ne 0 -or -not $hudVersion -or $hudVersion -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Could not read a valid FCMChatWidget version from $hudPackage"
    exit 1
}

# productName is "Fallout Chat Mod" (WITH spaces) -- electron-builder output names.
$winExe   = Join-Path $DistDir "Fallout Chat Mod Setup $Version.exe"
$linuxApp = Join-Path $DistDir "Fallout Chat Mod-$Version.AppImage"
$linuxDeb = Join-Path $DistDir "Fallout Chat Mod-$Version.deb"
$hudZip   = Join-Path $DistDir "FCM HUD Mod-$hudVersion (PROD).zip"
$hudNexusZip = Join-Path $DistDir "FCM HUD Mod-$hudVersion (PROD)-Nexus.zip"

# Nexus HUD packages are a distinct, fail-closed artifact. Website packages may
# contain the optional Windows setup helpers; Nexus HUD ZIPs contain no scripts
# or executables and instead point users to the website download.
& $pythonCommand.Source $hudPackage --target prod --distribution nexus --output $hudNexusZip
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $hudNexusZip)) {
    Write-Error "Could not build the executable-free Nexus HUD package."
    exit 1
}

# Build self-contained overlay archives before any upload. Each includes the
# exact validated optional bridge under Optional FCM Bridge/ and never installs it.
& $nexusPackage -Version $Version -BridgeZip $BridgeZip -DistDir $DistDir
if ($LASTEXITCODE -ne 0) {
    Write-Error "Could not build the Nexus overlay packages."
    exit 1
}
$winNexusZip = Join-Path $DistDir "Fallout Chat Mod Setup $Version (Windows)-Nexus.zip"
$portableNexusZip = Join-Path $DistDir "Fallout Chat Mod Portable $Version (Windows)-Nexus.zip"
$linuxAppNexusZip = Join-Path $DistDir "Fallout Chat Mod $Version (Linux AppImage)-Nexus.zip"
$linuxDebNexusZip = Join-Path $DistDir "Fallout Chat Mod $Version (Linux .deb)-Nexus.zip"
foreach ($package in @($winNexusZip, $portableNexusZip, $linuxAppNexusZip, $linuxDebNexusZip)) {
    if (-not (Test-Path $package)) { Write-Error "Nexus package missing: $package"; exit 1 }
}

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

# Per-platform display names for the uploaded .zip files (matches the manual naming).
$winZip   = "Fallout Chat Mod Setup $Version (Windows).zip"
$linuxAppZip = "Fallout Chat Mod $Version (Linux AppImage).zip"
$linuxDebZip = "Fallout Chat Mod $Version (Linux .deb).zip"

# Per-platform extra files to bundle into the Nexus zip alongside the installer.
# Result: Nexus zip = installer + same instruction files as the website zip.
$winInclude   = @(
    (Join-Path (Join-Path $assetsDir "install") "INSTALL-WINDOWS-NEXUS.txt")
)
$linuxAppInclude = @(
    (Join-Path (Join-Path $assetsDir "install") "INSTALL-LINUX-APPIMAGE-NEXUS.txt"),
    (Join-Path $assetsDir "fallout-chatmod-keepabove.kwinrule")
)
$linuxDebInclude = @(
    (Join-Path (Join-Path $assetsDir "install") "INSTALL-LINUX-DEB-NEXUS.txt")
)

$platforms = @(
    @{ Name = "Linux AppImage"; File = $linuxAppNexusZip; Zip = ""; Group = $linuxGroup; Include = @(); NexusVersion = $Version; Category = "main"; ArchiveExisting = $true; Primary = $false },
    @{ Name = "Linux .deb"; File = $linuxDebNexusZip; Zip = ""; Group = $linuxDebGroup; Include = @(); NexusVersion = $Version; Category = "main"; ArchiveExisting = $true; Primary = $false },
    # The HUD has its own Main Files entry; installation remains opt-in.
    # Its file version follows the widget version, not the desktop overlay version.
    @{ Name = "HUD"; File = $hudNexusZip; Zip = ""; Group = $hudGroup; Include = @(); NexusVersion = $hudVersion; Category = "main"; ArchiveExisting = $true; Primary = $true }
)
if ($publishWindows) {
    # Support-review uploads keep all approved Windows versions in Main. Only the
    # operator changes their Nexus categories; automation never archives them.
    $platforms = @(
        @{ Name = "Windows (support review)"; File = $winNexusZip; Zip = ""; Group = $winGroup; Include = @(); NexusVersion = $Version; Category = "main"; ArchiveExisting = $false; Primary = $false }
    ) + $platforms
    if ($portableGroup) {
        $platforms = @(
            @{ Name = "Windows portable (support review)"; File = $portableNexusZip; Zip = ""; Group = $portableGroup; Include = @(); NexusVersion = $Version; Category = "main"; ArchiveExisting = $false; Primary = $false }
        ) + $platforms
    } else {
        Write-Warning "NEXUS_MOD_FILE_ID_WINDOWS_PORTABLE is unset; portable Nexus upload skipped."
    }
}

if (-not $DryRun) {
    # Validate every managed group before the first Nexus upload, so an Old
    # files entry or missing description cannot leave a partial Nexus release.
    foreach ($p in $platforms) {
        & $nexus -FilePath $p.File -Version $p.NexusVersion -ModFileId $p.Group -FileCategory $p.Category -ArchiveExisting $p.ArchiveExisting -PrimaryDownload $p.Primary -ValidateMetadataOnly
        if ($LASTEXITCODE -ne 0) { Write-Error "[$($p.Name)] Nexus metadata preflight failed (exit $LASTEXITCODE)"; exit 1 }
    }
}

foreach ($p in $platforms) {
    if (-not (Test-Path $p.File)) { Write-Error "[$($p.Name)] artifact not found: $($p.File)"; exit 1 }
    Write-Host "==== Publishing $($p.Name) -> Nexus group $($p.Group) ===="
    $args = @{
        FilePath      = $p.File
        Version       = $p.NexusVersion
        ModFileId     = $p.Group
        ZipAs         = $p.Zip
        IncludeFiles  = $p.Include
        FileCategory  = $p.Category
        ArchiveExisting = $p.ArchiveExisting
        PrimaryDownload = $p.Primary
    }
    if ($DryRun) { $args.DryRun = $true }
    & $nexus @args
    if ($LASTEXITCODE -ne 0) { Write-Error "[$($p.Name)] publish failed (exit $LASTEXITCODE)"; exit 1 }
}
$windowsSummary = if ($publishWindows) { " + Windows support-review uploads (existing files preserved)" } else { "" }
Write-Host "==== Nexus publish complete for Linux AppImage + .deb v$Version + HUD v$hudVersion$windowsSummary ===="

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
