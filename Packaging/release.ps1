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
      4. package-downloads.ps1 -Version $Version  (build human-download ZIPs)
      5. Upload raw .exe + .AppImage + ZIPs to VPS; verify served sizes against
         LOCAL build artifact sizes (Get-Item .Length); no feed manifest uploads.
      6. POST https://falloutchatmod.com/admin/releases  (register release, triggers
         app:update-available notification to connected clients on next WS connect).
      7. publish-nexus-release.ps1 -Version $Version -ReleaseNotes $ReleaseNotes

    Under -DryRun, gates (smoke + VT) are run for real but NOTHING is uploaded,
    registered, or posted to Nexus. Prints what WOULD run for steps 4-7.

    IMPORTANT -- ASCII-ONLY SCRIPT RULE:
      Keep this file ASCII-only. Windows PowerShell 5.1 run via -File mis-tokenizes
      non-ASCII characters (e.g. em-dashes U+2014) and throws a misleading
      "Unexpected token" parse error. Use plain ASCII hyphens (-) only.

    Required env vars:
      PROD_ADMIN_RELEASE_TOKEN  -- admin bearer token (steps 6 + 7 + vt-gate)
      VT_API_KEY                -- VirusTotal personal API key (step 3 + 7)

    Optional env vars (step 7 -- Nexus):
      NEXUS_API_KEY
      NEXUS_FILE_GROUP_ID_WINDOWS
      NEXUS_FILE_GROUP_ID_LINUX

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
Write-Host "================================================================"

# Resolve paths from $PSScriptRoot (not in param defaults -- PSScriptRoot is
# not available in param blocks).
$repoRoot   = Split-Path $PSScriptRoot -Parent
$overlayDir = Join-Path $repoRoot "cross-platform-overlay"
$distDir    = Join-Path $overlayDir "dist-electron"

$smokeScript = Join-Path $PSScriptRoot "smoke-test.ps1"
$vtScript    = Join-Path $PSScriptRoot "vt-gate.ps1"
$pkgScript   = Join-Path $PSScriptRoot "package-downloads.ps1"
$nexusScript = Join-Path $PSScriptRoot "publish-nexus-release.ps1"

foreach ($s in @($smokeScript, $vtScript, $pkgScript, $nexusScript)) {
    if (-not (Test-Path $s)) { Fail "missing script" "Required script not found: $s" }
}

# Verify PROD_ADMIN_RELEASE_TOKEN is present before doing any work.
$relToken = $env:PROD_ADMIN_RELEASE_TOKEN
if (-not $relToken) { $relToken = [Environment]::GetEnvironmentVariable('PROD_ADMIN_RELEASE_TOKEN','User') }
if (-not $relToken) {
    Fail "pre-flight" "PROD_ADMIN_RELEASE_TOKEN is not set. Set it as a USER env var or process env var before running this script."
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
$winZipName   = "Fallout Chat Mod Setup $Version (Windows).zip"
$linuxZipName = "Fallout Chat Mod-$Version.AppImage (Linux).zip"
$winZip       = Join-Path $distDir $winZipName
$linuxZip     = Join-Path $distDir $linuxZipName

# Remote download dir (inside the container)
$remoteDownloads = "/app/downloads/electron"

# Percent-encoded URL components for size verification
$winExeName      = "Fallout%20Chat%20Mod%20Setup%20$($Version)%20(Windows).zip"
$linuxAppName    = "Fallout%20Chat%20Mod-$($Version).AppImage%20(Linux).zip"
$winExeRawName   = "Fallout%20Chat%20Mod%20Setup%20$Version.exe"
$linuxRawName    = "Fallout%20Chat%20Mod-$Version.AppImage"
$baseUrl         = "https://falloutchatmod.com/downloads/electron"

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
    Write-Host ""
    Write-Host "  STEP 5: SCP raw .exe + .AppImage + ZIPs to $SshTarget"
    Write-Host "          docker cp into ${ContainerName}:${remoteDownloads}"
    Write-Host "          Verify served sizes against local build artifact sizes"
    Write-Host ""
    Write-Host "  STEP 6: POST https://falloutchatmod.com/admin/releases"
    Write-Host "          {version:'$Version', downloadUrl:'...Windows ZIP...', releaseNotes:'...'}"
    Write-Host ""
    Write-Host "  STEP 7: publish-nexus-release.ps1 -Version $Version -ReleaseNotes '...'"
    Write-Host ""
    Write-Host "  DRY RUN COMPLETE -- no artifacts uploaded or registered."
    Write-Host "================================================================"
    exit 0
}

# ---- STEP 4: Build download ZIPs --------------------------------------------

Step-Banner 4 "Build download ZIPs"
Write-Host "[step 4] Running package-downloads.ps1 -Version $Version ..."

$pkgExit = Invoke-SubScript $pkgScript @("-Version", $Version, "-DistDir", $distDir)
if ($pkgExit -ne 0) {
    Fail "step 4 (package-downloads)" "package-downloads.ps1 exited $pkgExit"
}
if (-not (Test-Path $winZip))   { Fail "step 4 (output check)" "Windows ZIP not produced: $winZip" }
if (-not (Test-Path $linuxZip)) { Fail "step 4 (output check)" "Linux ZIP not produced: $linuxZip" }
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
Upload-Artifact $winZip
Upload-Artifact $linuxZip

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
Pass "step 5 (artifacts uploaded + sizes verified)"

# ---- STEP 6: Register release ------------------------------------------------

Step-Banner 6 "Register release (POST /admin/releases)"

# URL-encode the download URL (spaces -> %20).
$winZipUrlName = "Fallout%20Chat%20Mod%20Setup%20$Version%20(Windows).zip"
$downloadUrl   = "$baseUrl/$winZipUrlName"

$notesEscaped = $ReleaseNotes -replace '\\', '\\\\' -replace '"', '\"' -replace "`r`n", '\n' -replace "`n", '\n' -replace "`r", '\n'
$body = "{`"version`":`"$Version`",`"downloadUrl`":`"$downloadUrl`",`"releaseNotes`":`"$notesEscaped`"}"

Write-Host "[step 6] POST https://falloutchatmod.com/admin/releases"
Write-Host "         version=$Version  downloadUrl=$downloadUrl"

try {
    $resp = Invoke-RestMethod -Uri "https://falloutchatmod.com/admin/releases" -Method Post `
        -Headers @{ "Authorization" = "Bearer $relToken"; "Content-Type" = "application/json" } `
        -Body $body
    Write-Host "[step 6] Response: $($resp | ConvertTo-Json -Compress -Depth 3)"
} catch {
    Fail "step 6 (POST /admin/releases)" "HTTP request failed: $($_.Exception.Message)"
}
Pass "step 6 (release registered)"

# ---- STEP 7: Nexus publish ---------------------------------------------------

Step-Banner 7 "Nexus publish"
Write-Host "[step 7] Running publish-nexus-release.ps1 -Version $Version ..."

# Pass release notes via env var, NOT a command-line arg: a multi-line/quoted
# notes string handed to a child `powershell.exe -File` gets re-parsed and a ':'
# in the notes is read as a PSDrive, corrupting $DistDir. The env var is immune.
$nexusArgs = @("-Version", $Version)
$env:FCM_RELEASE_NOTES = $ReleaseNotes

$nexusExit = Invoke-SubScript $nexusScript $nexusArgs
if ($nexusExit -ne 0) {
    Fail "step 7 (Nexus publish)" "publish-nexus-release.ps1 exited $nexusExit"
}
Pass "step 7 (Nexus publish complete)"

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
Write-Host "  [PASS] step 6 -- release registered"
Write-Host "  [PASS] step 7 -- Nexus published"
Write-Host ""
Write-Host "  Release registered. Clients will see an update notification"
Write-Host "  on next WS connect (app:update-available -> Nexus link)."
Write-Host "================================================================"
exit 0
