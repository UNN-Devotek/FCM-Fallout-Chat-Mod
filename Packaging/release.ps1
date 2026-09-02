<#
.SYNOPSIS
    FAIL-CLOSED release orchestrator for the Fallout Chat Mod overlay.
    Runs every gate in the mandatory sequence and aborts (exit 1) on ANY failure.
    Nothing is published until smoke-test AND VirusTotal both pass.

.DESCRIPTION
    Mandatory fail-closed sequence (hard rule -- see docs/deployment/releasing-the-overlay.md):

      1. [unless -SkipBuild] Build Windows:
           cd cross-platform-overlay
           npm run build:renderer
           npx electron-builder --win
         Then verify Linux .AppImage already exists (must be built separately on
         native Linux fs -- see docs/deployment/releasing-the-overlay.md).
         ABORT if the Linux artifact is missing -- both platforms must ship.
      2. GATE: smoke-test.ps1 -Version $Version  (exit non-zero -> ABORT, publish nothing)
      3. GATE: vt-gate.ps1 -Version $Version     (exit non-zero -> ABORT, publish nothing)
      4. package-downloads.ps1 -Version $Version  (build human-download ZIPs + HUD ZIP)
      5. Upload raw .exe + .AppImage + .deb + ZIPs to VPS; verify served sizes against
         LOCAL build artifact sizes (Get-Item .Length); no feed manifest uploads.
      6. publish-nexus-release.ps1 -Version $Version -ReleaseNotes $ReleaseNotes
         -PublishWindowsForReview (unless -SkipWindowsNexus)
      7. POST https://falloutchatmod.com/admin/releases  (register release, triggers
         app:update-available notification to connected clients on next WS connect).

    Under -DryRun, gates (smoke + VT) are run for real but NOTHING is uploaded,
    registered, or posted to Nexus. Prints what WOULD run for steps 4-7.

    IMPORTANT -- ASCII-ONLY SCRIPT RULE:
      Keep this file ASCII-only. Windows PowerShell 5.1 run via -File mis-tokenizes
      non-ASCII characters (e.g. em-dashes U+2014) and throws a misleading
      "Unexpected token" parse error. Use plain ASCII hyphens (-) only.

    Required env vars:
      PROD_ADMIN_RELEASE_TOKEN  -- admin bearer token (steps 6 + 7 + vt-gate)
      VT_API_KEY                -- VirusTotal personal API key (step 3 + 6)

    Required env vars for a live run (step 6 -- Nexus; unless -SkipWindowsNexus for the Windows group):
      NEXUS_API_KEY
      NEXUS_FILE_GROUP_ID_WINDOWS -- required unless -SkipWindowsNexus
      NEXUS_FILE_GROUP_ID_LINUX
      NEXUS_FILE_GROUP_ID_LINUX_DEB
      NEXUS_FILE_GROUP_ID_HUD

.PARAMETER Version
    Required. Version string, e.g. 1.3.84.

.PARAMETER ReleaseNotes
    Optional. Release notes text prepended to the Nexus file description and sent
    in the POST /admin/releases body.

.PARAMETER SkipBuild
    Skip the electron-builder step (step 1). Use when dist-electron artifacts are
    already built (e.g. after a partial run). Linux artifact check still runs.

.PARAMETER DryRun
    Run gates (smoke + VT) for real but stop before any upload, register, or Nexus
    call. Prints what WOULD run for each skipped step.

.PARAMETER SkipWindowsNexus
    Skip the Windows Nexus support-review upload. By default the release
    orchestrator uploads the new Windows ZIP alongside the existing Windows
    file with -PublishWindowsForReview; the old file is never archived.

.PARAMETER SshTarget
    SSH/SCP target for VPS uploads (user@host). Falls back to FCM_SSH_TARGET env var.
    Required: must be set as a parameter or env var.

.PARAMETER SshKey
    Path to the SSH private key for SCP/SSH. Falls back to FCM_SSH_KEY env var.
    Required: must be set as a parameter or env var.

.PARAMETER ContainerName
    Docker container name in which downloads live on the VPS.
    Defaults to the FCM_BACKEND_CONTAINER env var if set, otherwise must be supplied explicitly.
    Example: chat-mod-fallout-chat-mod-<deployment-id>-backend-1
    Set FCM_BACKEND_CONTAINER in your shell profile so you never have to pass it on the command line.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$ReleaseNotes  = "",
    [switch]$SkipBuild,
    [switch]$DryRun,
    [switch]$SkipWindowsNexus,
    [string]$SshTarget     = "",
    [string]$SshKey        = "",
    # Set the FCM_BACKEND_CONTAINER env var (User scope) to avoid passing this every time.
    [string]$ContainerName = $env:FCM_BACKEND_CONTAINER
)
$ErrorActionPreference = "Stop"

# ---- Load .env / .env.local from repo root -----------------------------------
# Reads KEY=VALUE lines (skipping comments and blanks) and sets them as process
# env vars if not already set. .env.local takes precedence over .env.
function Import-DotEnv($path) {
    if (-not (Test-Path $path)) { return }
    foreach ($line in (Get-Content $path)) {
        if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
        if ($line -match '^\s*([^=]+?)\s*=\s*(.*?)\s*$') {
            $k = $matches[1]; $v = $matches[2]
            if (-not [System.Environment]::GetEnvironmentVariable($k)) {
                [System.Environment]::SetEnvironmentVariable($k, $v)
            }
        }
    }
}
$repoRootForEnv = Split-Path $PSScriptRoot -Parent
Import-DotEnv (Join-Path $repoRootForEnv ".env")
Import-DotEnv (Join-Path $repoRootForEnv ".env.local")

# ---- Helpers ------------------------------------------------------------------

function Step-Banner($n, $label) {
    Write-Host ""
    Write-Host "================================================================"
    Write-Host "  STEP $n -- $label"
    Write-Host "================================================================"
}

function Pass($label) {
    Write-Host "[PASS] $label"
}

function Fail($label, $detail) {
    Write-Host ""
    Write-Host "[FAIL] $label"
    if ($detail) { Write-Host "       $detail" }
    Write-Host ""
    Write-Host "RELEASE ABORTED at step: $label"
    Write-Host "(publish nothing -- fail-closed)"
    exit 1
}

function Get-ConfiguredEnv($name) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'User') }
    return $value
}

# Run a script file in a child powershell process; return its exit code.
# OS-aware: pwsh (PowerShell 7) on Linux/macOS, powershell.exe on Windows.
function Invoke-SubScript($scriptPath, [string[]]$extraArgs) {
    $allArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) + $extraArgs
    $psExe = "powershell.exe"
    if ($IsLinux -or $IsMacOS) { $psExe = "pwsh" }
    & $psExe @allArgs | Out-Default
    return $LASTEXITCODE
}

# Retrieve Content-Length of a URL using scp / ssh on the VPS.
# We use ssh to run curl -sI on the remote host and capture content-length.
function Get-ServedSize($url, $sshKey, $sshTarget) {
    $clLine = ssh -i $sshKey -o StrictHostKeyChecking=no $sshTarget `
        "curl -sI '$url' | grep -i '^content-length:'" 2>$null
    if ($clLine -match '[\s:](\d+)') { return [long]$matches[1] }
    return $null
}

# ---- Pre-flight ---------------------------------------------------------------

Write-Host ""
Write-Host "================================================================"
Write-Host "  FALLOUT CHAT MOD -- RELEASE ORCHESTRATOR"
Write-Host "  Version  : $Version"
if ($DryRun)    { Write-Host "  Mode     : DRY RUN (gates run; no uploads / register / Nexus)" }
if ($SkipBuild) { Write-Host "  Build    : SKIPPED (using existing dist-electron artifacts)" }
if ($SkipWindowsNexus) { Write-Host "  Nexus    : WINDOWS SUPPORT-REVIEW UPLOAD SKIPPED" }
else { Write-Host "  Nexus    : WINDOWS SUPPORT-REVIEW UPLOAD ENABLED (old file preserved)" }
Write-Host "================================================================"

# Resolve paths from $PSScriptRoot (not in param defaults -- PSScriptRoot is
# not available in param blocks).
$repoRoot   = Split-Path $PSScriptRoot -Parent
$overlayDir = Join-Path $repoRoot "cross-platform-overlay"
$distDir    = Join-Path $overlayDir "dist-electron"
$gameModsDir = Join-Path $repoRoot "game-mods"
$fcmBridgeDir = Join-Path $gameModsDir "FCMBridge"
$hudModDir  = Join-Path $fcmBridgeDir "hudmodloader-chat"

$smokeScript = Join-Path $PSScriptRoot "smoke-test.ps1"
$vtScript    = Join-Path $PSScriptRoot "vt-gate.ps1"
$pkgScript   = Join-Path $PSScriptRoot "package-downloads.ps1"
$nexusScript = Join-Path $PSScriptRoot "publish-nexus-release.ps1"
$hudPackageScript = Join-Path $hudModDir "package.py"

foreach ($s in @($smokeScript, $vtScript, $pkgScript, $nexusScript)) {
    if (-not (Test-Path $s)) { Fail "missing script" "Required script not found: $s" }
}
if (-not (Test-Path $hudPackageScript)) { Fail "missing script" "Required HUD package script not found: $hudPackageScript" }

# The HUD package version is read from the same Haxe source used by package.py.
# This keeps the release URL and the ZIP contents tied to one version source.
$pythonCommand = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $pythonCommand) { $pythonCommand = Get-Command python -ErrorAction SilentlyContinue }
if (-not $pythonCommand) { Fail "pre-flight" "Python 3 is required to package the ZFE FCM HUD Mod" }
$hudModVersion = (& $pythonCommand.Source $hudPackageScript --print-version).Trim()
if ($LASTEXITCODE -ne 0 -or -not $hudModVersion -or $hudModVersion -notmatch '^\d+\.\d+\.\d+$') {
    Fail "pre-flight" "Could not read a valid FCMChatWidget version from $hudPackageScript"
}

# Verify PROD_ADMIN_RELEASE_TOKEN is present before doing any work.
$relToken = $env:PROD_ADMIN_RELEASE_TOKEN
if (-not $relToken) { $relToken = [Environment]::GetEnvironmentVariable('PROD_ADMIN_RELEASE_TOKEN','User') }
if (-not $relToken) {
    Fail "pre-flight" "PROD_ADMIN_RELEASE_TOKEN is not set. Set it as a USER env var or process env var before running this script."
}

# Validate all Nexus credentials before any website artifact upload or release
# registration. The child script repeats these checks, but doing them here keeps
# a missing Nexus setting from leaving a partially advertised release behind.
if (-not $DryRun) {
    $nexusRequired = @('NEXUS_API_KEY', 'NEXUS_FILE_GROUP_ID_LINUX', 'NEXUS_FILE_GROUP_ID_LINUX_DEB', 'NEXUS_FILE_GROUP_ID_HUD')
    if (-not $SkipWindowsNexus) { $nexusRequired += 'NEXUS_FILE_GROUP_ID_WINDOWS' }
    $nexusMissing = @($nexusRequired | Where-Object { -not (Get-ConfiguredEnv $_) })
    if ($nexusMissing.Count -gt 0) {
        Fail "pre-flight (Nexus credentials)" "Missing: $($nexusMissing -join ', '). Set them as process or USER environment variables, or use -SkipWindowsNexus to omit only the Windows review upload."
    }
}

# Resolve SshTarget from -SshTarget param or FCM_SSH_TARGET env var.
if (-not $SshTarget) { $SshTarget = $env:FCM_SSH_TARGET }
if (-not $SshTarget) { $SshTarget = [Environment]::GetEnvironmentVariable('FCM_SSH_TARGET','User') }
if (-not $SshTarget) {
    Fail "pre-flight" "SSH target not set. Pass -SshTarget user@host or set FCM_SSH_TARGET as a USER env var."
}

# Resolve SshKey from -SshKey param or FCM_SSH_KEY env var.
if (-not $SshKey) { $SshKey = $env:FCM_SSH_KEY }
if (-not $SshKey) { $SshKey = [Environment]::GetEnvironmentVariable('FCM_SSH_KEY','User') }
if (-not $SshKey) {
    Fail "pre-flight" "SSH key path not set. Pass -SshKey path or set FCM_SSH_KEY as a USER env var."
}

# Artifact filenames (productName is 'Fallout Chat Mod' WITH spaces).
$winExe       = Join-Path $distDir "Fallout Chat Mod Setup $Version.exe"
$linuxApp     = Join-Path $distDir "Fallout Chat Mod-$Version.AppImage"
$linuxDeb     = Join-Path $distDir "Fallout Chat Mod-$Version.deb"
$winZipName   = "Fallout Chat Mod Setup $Version (Windows).zip"
$linuxZipName = "Fallout Chat Mod-$Version.AppImage (Linux).zip"
$hudTarget    = "prod"
$hudZipName   = "ZFE FCM HUD Mod-$hudModVersion ($($hudTarget.ToUpperInvariant())).zip"
$winZip       = Join-Path $distDir $winZipName
$linuxZip     = Join-Path $distDir $linuxZipName
$hudZip       = Join-Path $distDir $hudZipName

# Remote download dir (inside the container)
$remoteDownloads = "/app/downloads/electron"

# Percent-encoded URL components for size verification
$winExeName      = "Fallout%20Chat%20Mod%20Setup%20$($Version)%20(Windows).zip"
$linuxAppName    = "Fallout%20Chat%20Mod-$($Version).AppImage%20(Linux).zip"
$winExeRawName   = "Fallout%20Chat%20Mod%20Setup%20$Version.exe"
$linuxRawName    = "Fallout%20Chat%20Mod-$Version.AppImage"
$linuxDebRawName = "Fallout%20Chat%20Mod-$Version.deb"
$hudZipUrlName   = $hudZipName -replace ' ', '%20'
$baseUrl         = "https://falloutchatmod.com/downloads/electron"
$hudModUrl       = "$baseUrl/$hudZipUrlName"

# ---- STEP 1: Build -----------------------------------------------------------

Step-Banner 1 "Build Windows artifacts"

if ($SkipBuild) {
    Write-Host "[step 1] -SkipBuild specified -- skipping electron-builder."
    Write-Host "[step 1] Checking that Windows artifact exists in dist-electron..."
    if (-not (Test-Path $winExe)) {
        Fail "step 1 (pre-built artifact check)" "Windows installer not found: $winExe`n  Build it first or remove -SkipBuild."
    }
    Pass "step 1 (skipped build; Windows artifact present)"
} else {
    Write-Host "[step 1] Building renderer..."
    Push-Location $overlayDir
    try {
        npm run build:renderer
        if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "step 1 (build:renderer)" "npm run build:renderer exited $LASTEXITCODE" }

        Write-Host "[step 1] Running electron-builder --win..."
        npx electron-builder --win
        if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "step 1 (electron-builder --win)" "electron-builder exited $LASTEXITCODE" }
    } catch {
        Pop-Location
        Fail "step 1 (build)" $_.Exception.Message
    }
    Pop-Location

    if (-not (Test-Path $winExe)) {
        Fail "step 1 (output check)" "electron-builder succeeded but Windows installer not found: $winExe"
    }
    Pass "step 1 (Windows build)"
}

# Always check Linux artifact -- both platforms must ship every release.
Write-Host "[step 1] Verifying Linux AppImage (must be built separately on native Linux fs)..."
if (-not (Test-Path $linuxApp)) {
    Fail "step 1 (Linux artifact check)" @"
Linux AppImage not found in dist-electron: $linuxApp
The Linux AppImage MUST be built on a native Linux filesystem (not /mnt/d in WSL).
See docs/deployment/releasing-the-overlay.md for the exact staging/build procedure.
Copy Fallout Chat Mod-$Version.AppImage into:
  $distDir
then re-run this script with -SkipBuild.
Both platforms MUST ship every release.
"@
}
Pass "step 1 (Linux artifact present)"

# Linux .deb is an explicit electron-builder artifact and also ships in the Linux download ZIP.
Write-Host "[step 1] Verifying Linux .deb (electron-builder deb target)..."
if (-not (Test-Path $linuxDeb)) {
    Fail "step 1 (Linux .deb check)" @"
Linux .deb not found in dist-electron: $linuxDeb
electron-builder's Linux build produces both the AppImage and the .deb. Build the
Linux artifacts on a native Linux filesystem and copy the .deb into:
  $distDir
then re-run with -SkipBuild. The .deb is bundled into the Linux download ZIP.
"@
}
Pass "step 1 (Linux .deb present)"

# ---- STEP 2: Smoke test gate -------------------------------------------------

Step-Banner 2 "GATE -- Smoke test"
Write-Host "[step 2] Running smoke-test.ps1 -Version $Version ..."
Write-Host "         (launches the packaged app and asserts clean startup)"

$smokeExit = Invoke-SubScript $smokeScript @("-Version", $Version, "-DistDir", $distDir)
if ($smokeExit -ne 0) {
    Fail "step 2 (smoke-test GATE)" "smoke-test.ps1 exited $smokeExit. Build did not pass launch smoke test. Publish NOTHING."
}
Pass "step 2 (GATE -- smoke test)"

# ---- STEP 3: VirusTotal gate -------------------------------------------------

Step-Banner 3 "GATE -- VirusTotal"
Write-Host "[step 3] Running vt-gate.ps1 -Version $Version ..."
Write-Host "         (uploads installer, BLOCKS on completed scan, fails if flagged)"

$vtExit = Invoke-SubScript $vtScript @("-Version", $Version, "-DistDir", $distDir)
if ($vtExit -ne 0) {
    Fail "step 3 (VirusTotal GATE)" "vt-gate.ps1 exited $vtExit. Build is flagged or upload failed. Publish NOTHING."
}
Pass "step 3 (GATE -- VirusTotal)"

# ---- DRY RUN stops here (before any mutating steps) -------------------------

if ($DryRun) {
    Write-Host ""
    Write-Host "================================================================"
    Write-Host "  DRY RUN -- gates passed. Steps 4-7 skipped. Would run:"
    Write-Host ""
    Write-Host "  STEP 4: package-downloads.ps1 -Version $Version"
    Write-Host "          -> builds '$winZipName'"
    Write-Host "          -> builds '$linuxZipName'"
    Write-Host "          -> builds '$hudZipName' (target: $hudTarget)"
    Write-Host ""
    Write-Host "  STEP 5: SCP raw .exe + .AppImage + .deb + ZIPs + HUD ZIP to $SshTarget"
    Write-Host "          docker cp into ${ContainerName}:${remoteDownloads}"
    Write-Host "          Verify served sizes against local build artifact sizes"
    Write-Host ""
    if ($SkipWindowsNexus) {
        Write-Host "  STEP 6: publish-nexus-release.ps1 -Version $Version (Windows review upload skipped)"
    } else {
        Write-Host "  STEP 6: publish-nexus-release.ps1 -Version $Version -PublishWindowsForReview"
        Write-Host "          new Windows ZIP uploaded alongside the existing file; old file preserved"
    }
    Write-Host ""
    Write-Host "  STEP 7: POST https://falloutchatmod.com/admin/releases"
    Write-Host "          {version:'$Version', downloadUrl:'...Windows ZIP...', hudModVersion:'$hudModVersion', hudModUrl:'$hudModUrl', releaseNotes:'...'}"
    Write-Host ""
    Write-Host "  DRY RUN COMPLETE -- no artifacts uploaded or registered."
    Write-Host "================================================================"
    exit 0
}

# ---- STEP 4: Build download ZIPs --------------------------------------------

Step-Banner 4 "Build download ZIPs"
Write-Host "[step 4] Running package-downloads.ps1 -Version $Version ..."

$pkgExit = Invoke-SubScript $pkgScript @("-Version", $Version, "-DistDir", $distDir, "-HudModDir", $hudModDir, "-HudTarget", $hudTarget)
if ($pkgExit -ne 0) {
    Fail "step 4 (package-downloads)" "package-downloads.ps1 exited $pkgExit"
}
if (-not (Test-Path $winZip))   { Fail "step 4 (output check)" "Windows ZIP not produced: $winZip" }
if (-not (Test-Path $linuxZip)) { Fail "step 4 (output check)" "Linux ZIP not produced: $linuxZip" }
if (-not (Test-Path $hudZip))   { Fail "step 4 (output check)" "HUD ZIP not produced: $hudZip" }
Pass "step 4 (download ZIPs built)"

# ---- STEP 5: Upload to VPS + verify served sizes ----------------------------

Step-Banner 5 "Upload to VPS + verify served sizes"

# Helper: scp a local file to /tmp on the VPS, then docker cp into the container.
function Upload-Artifact($localPath, $remoteName) {
    $fileName = if ($remoteName) { $remoteName } else { [System.IO.Path]::GetFileName($localPath) }
    $tmpRemote = "/tmp/$fileName"
    Write-Host "[step 5] SCP: $([System.IO.Path]::GetFileName($localPath)) -> $SshTarget`:$tmpRemote"
    scp -i $SshKey -o StrictHostKeyChecking=no "$localPath" "$SshTarget`:$tmpRemote"
    if ($LASTEXITCODE -ne 0) { Fail "step 5 (scp)" "scp failed for $localPath (exit $LASTEXITCODE)" }
    Write-Host "[step 5] docker cp: $tmpRemote -> $ContainerName`:$remoteDownloads/$fileName"
    ssh -i $SshKey -o StrictHostKeyChecking=no $SshTarget `
        "docker cp '$tmpRemote' '$ContainerName`:$remoteDownloads/$fileName' && rm -f '$tmpRemote'"
    if ($LASTEXITCODE -ne 0) { Fail "step 5 (docker cp)" "docker cp failed for $fileName (exit $LASTEXITCODE)" }
}

# Upload raw artifacts + ZIPs.
Upload-Artifact $winExe
Upload-Artifact $linuxApp
Upload-Artifact $linuxDeb
Upload-Artifact $winZip
Upload-Artifact $linuxZip
Upload-Artifact $hudZip

# --- Verify served sizes against LOCAL build artifact sizes ---
# electron-builder no longer generates latest*.yml, so we derive the expected
# size from the actual files on disk (the source of truth).
Write-Host "[step 5] Verifying served sizes against local build artifact sizes..."

$winLocalSize   = (Get-Item $winExe).Length
$linuxLocalSize = (Get-Item $linuxApp).Length

Write-Host "[step 5] Local Windows .exe size:   $winLocalSize bytes"
Write-Host "[step 5] Local Linux AppImage size: $linuxLocalSize bytes"

# Check Windows .exe size via HEAD request through ssh
$winServedSize = Get-ServedSize "$baseUrl/$winExeRawName" $SshKey $SshTarget
if ($null -eq $winServedSize) {
    Fail "step 5 (size verify -- windows)" "Could not retrieve Content-Length for Windows .exe from VPS. Check upload and container path."
}
Write-Host "[step 5] Windows .exe served size: $winServedSize bytes"
if ($winServedSize -ne $winLocalSize) {
    Fail "step 5 (size mismatch -- windows)" "Windows .exe: served=$winServedSize bytes vs local=$winLocalSize bytes. Upload may be corrupt or incomplete."
}
Pass "step 5 (Windows .exe size verified: $winServedSize bytes)"

$linuxServedSize = Get-ServedSize "$baseUrl/$linuxRawName" $SshKey $SshTarget
if ($null -eq $linuxServedSize) {
    Fail "step 5 (size verify -- linux)" "Could not retrieve Content-Length for Linux AppImage from VPS. Check upload and container path."
}
Write-Host "[step 5] Linux AppImage served size: $linuxServedSize bytes"
if ($linuxServedSize -ne $linuxLocalSize) {
    Fail "step 5 (size mismatch -- linux)" "Linux AppImage: served=$linuxServedSize bytes vs local=$linuxLocalSize bytes. Upload may be corrupt or incomplete."
}

$debLocalSize  = (Get-Item $linuxDeb).Length
Write-Host "[step 5] Local Linux .deb size: $debLocalSize bytes"
$debServedSize = Get-ServedSize "$baseUrl/$linuxDebRawName" $SshKey $SshTarget
if ($null -eq $debServedSize) {
    Fail "step 5 (size verify -- deb)" "Could not retrieve Content-Length for Linux .deb from VPS. Check upload and container path."
}
Write-Host "[step 5] Linux .deb served size: $debServedSize bytes"
if ($debServedSize -ne $debLocalSize) {
    Fail "step 5 (size mismatch -- deb)" "Linux .deb: served=$debServedSize bytes vs local=$debLocalSize bytes. Upload may be corrupt or incomplete."
}

$hudLocalSize = (Get-Item $hudZip).Length
Write-Host "[step 5] Local HUD ZIP size: $hudLocalSize bytes"
$hudServedSize = Get-ServedSize $hudModUrl $SshKey $SshTarget
if ($null -eq $hudServedSize) {
    Fail "step 5 (size verify -- hud mod)" "Could not retrieve Content-Length for HUD ZIP from VPS. Check upload and container path."
}
Write-Host "[step 5] HUD ZIP served size: $hudServedSize bytes"
if ($hudServedSize -ne $hudLocalSize) {
    Fail "step 5 (size mismatch -- hud mod)" "HUD ZIP: served=$hudServedSize bytes vs local=$hudLocalSize bytes. Upload may be corrupt or incomplete."
}
Pass "step 5 (artifacts uploaded + sizes verified)"

# ---- STEP 6: Nexus publish ---------------------------------------------------

Step-Banner 6 "Nexus publish"
if ($SkipWindowsNexus) {
    Write-Host "[step 6] Running publish-nexus-release.ps1 -Version $Version (Windows review upload skipped) ..."
} else {
    Write-Host "[step 6] Running publish-nexus-release.ps1 -Version $Version -PublishWindowsForReview ..."
    Write-Host "         New Windows file is uploaded alongside the existing file; the old file is preserved."
}

# Pass release notes via env var, NOT a command-line arg: a multi-line/quoted
# notes string handed to a child `powershell.exe -File` gets re-parsed and a ':'
# in the notes is read as a PSDrive, corrupting $DistDir. The env var is immune.
$nexusArgs = @("-Version", $Version)
if (-not $SkipWindowsNexus) { $nexusArgs += "-PublishWindowsForReview" }
$env:FCM_RELEASE_NOTES = $ReleaseNotes

$nexusExit = Invoke-SubScript $nexusScript $nexusArgs
if ($nexusExit -ne 0) {
    Fail "step 6 (Nexus publish)" "publish-nexus-release.ps1 exited $nexusExit"
}
Pass "step 6 (Nexus publish complete)"

# ---- STEP 7: Register release ------------------------------------------------

Step-Banner 7 "Register release (POST /admin/releases)"

# URL-encode the download URL (spaces -> %20).
$winZipUrlName = "Fallout%20Chat%20Mod%20Setup%20$Version%20(Windows).zip"
$downloadUrl   = "$baseUrl/$winZipUrlName"

$notesEscaped = $ReleaseNotes -replace '\\', '\\\\' -replace '"', '\"' -replace "`r`n", '\n' -replace "`n", '\n' -replace "`r", '\n'
$body = "{`"version`":`"$Version`",`"downloadUrl`":`"$downloadUrl`",`"hudModVersion`":`"$hudModVersion`",`"hudModUrl`":`"$hudModUrl`",`"releaseNotes`":`"$notesEscaped`"}"

Write-Host "[step 7] POST https://falloutchatmod.com/admin/releases"
Write-Host "         version=$Version  downloadUrl=$downloadUrl  hudModVersion=$hudModVersion  hudModUrl=$hudModUrl"

try {
    $resp = Invoke-RestMethod -Uri "https://falloutchatmod.com/admin/releases" -Method Post `
        -Headers @{ "Authorization" = "Bearer $relToken"; "Content-Type" = "application/json" } `
        -Body $body
    Write-Host "[step 7] Response: $($resp | ConvertTo-Json -Compress -Depth 3)"
} catch {
    Fail "step 7 (POST /admin/releases)" "HTTP request failed: $($_.Exception.Message)"
}
Pass "step 7 (release registered)"

# ---- Final summary -----------------------------------------------------------

Write-Host ""
Write-Host "================================================================"
Write-Host "  RELEASE COMPLETE -- v$Version"
Write-Host ""
Write-Host "  [PASS] step 1 -- build"
Write-Host "  [PASS] step 2 -- smoke-test GATE"
Write-Host "  [PASS] step 3 -- VirusTotal GATE"
Write-Host "  [PASS] step 4 -- download ZIPs"
Write-Host "  [PASS] step 5 -- VPS upload + size verification"
Write-Host "  [PASS] step 6 -- Nexus published (Windows review file preserved: $(-not $SkipWindowsNexus))"
Write-Host "  [PASS] step 7 -- release registered"
Write-Host ""
Write-Host "  Release registered. Clients will see an update notification"
Write-Host "  on next WS connect (app:update-available -> Nexus link)."
Write-Host "================================================================"
exit 0
