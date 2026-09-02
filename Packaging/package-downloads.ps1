<#
.SYNOPSIS
    Builds the two human-download ZIP archives (website + Nexus) from the raw
    electron-builder artifacts.

.DESCRIPTION
    Produces:
      - "Fallout Chat Mod Setup V (Windows).zip"  (Windows installer + INSTALL-WINDOWS.txt)
      - "Fallout Chat Mod-V.AppImage (Linux).zip" (Linux AppImage + .deb + INSTALL-LINUX.txt + .kwinrule)
      - "ZFE FCM HUD Mod-V (TARGET).zip" (target-stamped FCMChatWidget BA2 + configs + INSTALL.txt)

    These ZIPs are the artifacts linked from the website download buttons and uploaded
    to Nexus Mods. They are ADDITIONAL to (not replacing) the raw installer files.

    Role in the release pipeline:
      Run AFTER electron-builder produces the raw artifacts and BEFORE uploading to
      the VPS. Outputs land in the same dist-electron dir alongside the raw files.
      Upload order to /app/downloads/electron/: raw .exe + .AppImage + .deb, then the ZIPs.

.PARAMETER Version
    Version string, e.g. 1.3.68.

.PARAMETER DistDir
    Path to the electron-builder output directory. Defaults to
    <repo>\cross-platform-overlay\dist-electron (resolved from $PSScriptRoot).

.PARAMETER AssetsDir
    Path to the overlay assets directory. Defaults to
    <repo>\cross-platform-overlay\assets (resolved from $PSScriptRoot).

.PARAMETER HudModDir
    Path to the FCMChatWidget package source. Defaults to
    <repo>\game-mods\FCMBridge\hudmodloader-chat.

.PARAMETER HudTarget
    FCM environment stamped into the HUD package: prod (default) or dev.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$DistDir   = "",
    [string]$AssetsDir = "",
    [string]$HudModDir = "",
    [ValidateSet("prod", "dev")] [string]$HudTarget = "prod"
)

$ErrorActionPreference = "Stop"

# Resolve paths from $PSScriptRoot at runtime (not in param defaults -- PSScriptRoot
# is not available in param blocks).
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $DistDir)   { $DistDir   = Join-Path $repoRoot "cross-platform-overlay\dist-electron" }
if (-not $AssetsDir) { $AssetsDir = Join-Path $repoRoot "cross-platform-overlay\assets" }
if (-not $HudModDir) { $HudModDir = Join-Path $repoRoot "game-mods\FCMBridge\hudmodloader-chat" }

function Fail($msg) { Write-Error "[package-downloads] $msg"; exit 1 }

# --- Validate raw artifact existence -----------------------------------------
$winExe   = Join-Path $DistDir "Fallout Chat Mod Setup $Version.exe"
$linuxApp = Join-Path $DistDir "Fallout Chat Mod-$Version.AppImage"
# electron-builder is pinned to the product-name artifact pattern in
# cross-platform-overlay/package.json, so the raw .deb name is deterministic
# and can be linked directly from the website and Discord.
$linuxDeb = Join-Path $DistDir "Fallout Chat Mod-$Version.deb"

if (-not (Test-Path $winExe))   { Fail "Windows installer not found: $winExe" }
if (-not (Test-Path $linuxApp)) { Fail "Linux AppImage not found: $linuxApp" }
if (-not (Test-Path $linuxDeb)) { Fail "Linux .deb not found: $linuxDeb (electron-builder deb target)" }

# --- Instruction files -------------------------------------------------------
$installWin   = Join-Path $AssetsDir "install\INSTALL-WINDOWS.txt"
$installLinux = Join-Path $AssetsDir "install\INSTALL-LINUX.txt"
$kwinRule     = Join-Path $AssetsDir "fallout-chatmod-keepabove.kwinrule"
$hudPackage   = Join-Path $HudModDir "package.py"

if (-not (Test-Path $installWin))   { Fail "Missing: $installWin" }
if (-not (Test-Path $installLinux)) { Fail "Missing: $installLinux" }
if (-not (Test-Path $kwinRule))     { Fail "Missing: $kwinRule" }
if (-not (Test-Path $hudPackage))   { Fail "Missing: $hudPackage" }

# Resolve Python once so package.py is run consistently by the repeatable
# release wrapper on Windows, Linux, and macOS.
$pythonCommand = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $pythonCommand) { $pythonCommand = Get-Command python -ErrorAction SilentlyContinue }
if (-not $pythonCommand) { Fail "Python 3 is required to package the ZFE FCM HUD Mod" }
$hudVersion = (& $pythonCommand.Source $hudPackage --print-version).Trim()
if ($LASTEXITCODE -ne 0 -or -not $hudVersion -or $hudVersion -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Could not read a valid FCMChatWidget version from $hudPackage"
}

# --- Output ZIP names --------------------------------------------------------
$winZipName   = "Fallout Chat Mod Setup $Version (Windows).zip"
$linuxZipName = "Fallout Chat Mod-$Version.AppImage (Linux).zip"
$hudZipName   = "ZFE FCM HUD Mod-$hudVersion ($($HudTarget.ToUpperInvariant())).zip"
$winZipOut    = Join-Path $DistDir $winZipName
$linuxZipOut  = Join-Path $DistDir $linuxZipName
$hudZipOut    = Join-Path $DistDir $hudZipName

# Stage UNDER $DistDir: always on the same filesystem/drive as the artifacts (the original
# cross-drive concern) and always writable. Cross-platform -- the old GetPathRoot($DistDir)
# returned "/" on Linux, so the staging root became "/fcm-pkg-staging" (access denied).
$stagingRoot = Join-Path $DistDir "_pkg-staging"

# --- Build Windows ZIP -------------------------------------------------------
Write-Host "[package-downloads] Building Windows ZIP: $winZipName"
if (Test-Path $winZipOut) { Remove-Item $winZipOut -Force }
$winStaging = Join-Path $stagingRoot "win"
if (Test-Path $winStaging) { Remove-Item $winStaging -Recurse -Force }
New-Item -ItemType Directory -Path $winStaging -Force | Out-Null
Copy-Item $winExe   -Destination $winStaging
Copy-Item $installWin -Destination $winStaging
# Compress CONTENTS of the staging folder (files at root, not nested in a folder)
Compress-Archive -Path (Join-Path $winStaging "*") -DestinationPath $winZipOut -Force
$winSize = (Get-Item $winZipOut).Length
Write-Host "[package-downloads]   -> $winZipOut ($([math]::Round($winSize/1MB,1)) MB)"

# --- Build Linux ZIP ---------------------------------------------------------
Write-Host "[package-downloads] Building Linux ZIP: $linuxZipName"
if (Test-Path $linuxZipOut) { Remove-Item $linuxZipOut -Force }
$linuxStaging = Join-Path $stagingRoot "linux"
if (Test-Path $linuxStaging) { Remove-Item $linuxStaging -Recurse -Force }
New-Item -ItemType Directory -Path $linuxStaging -Force | Out-Null
Copy-Item $linuxApp   -Destination $linuxStaging
Copy-Item $linuxDeb   -Destination $linuxStaging
Copy-Item $installLinux -Destination $linuxStaging
Copy-Item $kwinRule     -Destination $linuxStaging
# Compress CONTENTS of the staging folder (files at root, not nested in a folder)
Compress-Archive -Path (Join-Path $linuxStaging "*") -DestinationPath $linuxZipOut -Force
$linuxSize = (Get-Item $linuxZipOut).Length
Write-Host "[package-downloads]   -> $linuxZipOut ($([math]::Round($linuxSize/1MB,1)) MB)"

# --- Build ZFE FCM HUD Mod ZIP ----------------------------------------------
Write-Host "[package-downloads] Building HUD ZIP: $hudZipName"
if (Test-Path $hudZipOut) { Remove-Item $hudZipOut -Force }
& $pythonCommand.Source $hudPackage --target $HudTarget --output $hudZipOut
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $hudZipOut)) {
    Fail "HUD package failed for target $HudTarget"
}
$hudSize = (Get-Item $hudZipOut).Length
Write-Host "[package-downloads]   -> $hudZipOut ($([math]::Round($hudSize/1KB,1)) KB)"

# --- Cleanup -----------------------------------------------------------------
Remove-Item $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[package-downloads] Done. Three download ZIPs ready in $DistDir"
Write-Host "  $winZipName  ($([math]::Round($winSize/1MB,1)) MB)"
Write-Host "  $linuxZipName  ($([math]::Round($linuxSize/1MB,1)) MB)"
Write-Host "  $hudZipName  ($([math]::Round($hudSize/1KB,1)) KB)"
Write-Host "NOTE: Upload the raw .exe/.AppImage/.deb alongside the ZIPs. The HUD ZIP is for the website and Discord release message."
