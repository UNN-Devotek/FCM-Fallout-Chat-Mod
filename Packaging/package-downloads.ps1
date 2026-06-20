<#
.SYNOPSIS
    Builds the two human-download ZIP archives (website + Nexus) from the raw
    electron-builder artifacts.

.DESCRIPTION
    Produces:
      - "Fallout Chat Mod Setup V (Windows).zip"  (Windows installer + INSTALL-WINDOWS.txt)
      - "Fallout Chat Mod-V.AppImage (Linux).zip" (Linux AppImage + .deb + INSTALL-LINUX.txt + .kwinrule)

    These ZIPs are the artifacts linked from the website download buttons and uploaded
    to Nexus Mods. They are ADDITIONAL to (not replacing) the raw installer files.

    Role in the release pipeline:
      Run AFTER electron-builder produces the raw artifacts and BEFORE uploading to
      the VPS. Outputs land in the same dist-electron dir alongside the raw files.
      Upload order to /app/downloads/electron/: raw .exe + .AppImage, then the ZIPs.

.PARAMETER Version
    Version string, e.g. 1.3.68.

.PARAMETER DistDir
    Path to the electron-builder output directory. Defaults to
    <repo>\cross-platform-overlay\dist-electron (resolved from $PSScriptRoot).

.PARAMETER AssetsDir
    Path to the overlay assets directory. Defaults to
    <repo>\cross-platform-overlay\assets (resolved from $PSScriptRoot).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$DistDir   = "",
    [string]$AssetsDir = ""
)

$ErrorActionPreference = "Stop"

# Resolve paths from $PSScriptRoot at runtime (not in param defaults -- PSScriptRoot
# is not available in param blocks).
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $DistDir)   { $DistDir   = Join-Path $repoRoot "cross-platform-overlay\dist-electron" }
if (-not $AssetsDir) { $AssetsDir = Join-Path $repoRoot "cross-platform-overlay\assets" }

function Fail($msg) { Write-Error "[package-downloads] $msg"; exit 1 }

# --- Validate raw artifact existence -----------------------------------------
$winExe   = Join-Path $DistDir "Fallout Chat Mod Setup $Version.exe"
$linuxApp = Join-Path $DistDir "Fallout Chat Mod-$Version.AppImage"
# electron-builder names the .deb from the package name (e.g.
# fallout-chatmod-cross-platform-overlay_${Version}_amd64.deb), NOT productName,
# so glob for it rather than assuming the AppImage-style "Fallout Chat Mod-$Version.deb".
$linuxDeb = (Get-ChildItem -Path $DistDir -Filter "*$Version*.deb" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName

if (-not (Test-Path $winExe))   { Fail "Windows installer not found: $winExe" }
if (-not (Test-Path $linuxApp)) { Fail "Linux AppImage not found: $linuxApp" }
if (-not $linuxDeb -or -not (Test-Path $linuxDeb)) { Fail "Linux .deb not found in $DistDir (electron-builder deb target)" }

# --- Instruction files -------------------------------------------------------
$installWin   = Join-Path $AssetsDir "install\INSTALL-WINDOWS.txt"
$installLinux = Join-Path $AssetsDir "install\INSTALL-LINUX.txt"
$kwinRule     = Join-Path $AssetsDir "fallout-chatmod-keepabove.kwinrule"

if (-not (Test-Path $installWin))   { Fail "Missing: $installWin" }
if (-not (Test-Path $installLinux)) { Fail "Missing: $installLinux" }
if (-not (Test-Path $kwinRule))     { Fail "Missing: $kwinRule" }

# --- Output ZIP names --------------------------------------------------------
$winZipName   = "Fallout Chat Mod Setup $Version (Windows).zip"
$linuxZipName = "Fallout Chat Mod-$Version.AppImage (Linux).zip"
$winZipOut    = Join-Path $DistDir $winZipName
$linuxZipOut  = Join-Path $DistDir $linuxZipName

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

# --- Cleanup -----------------------------------------------------------------
Remove-Item $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[package-downloads] Done. Two download ZIPs ready in $DistDir"
Write-Host "  $winZipName  ($([math]::Round($winSize/1MB,1)) MB)"
Write-Host "  $linuxZipName  ($([math]::Round($linuxSize/1MB,1)) MB)"
Write-Host "NOTE: Upload the raw .exe/.AppImage alongside the ZIPs. The ZIPs are for human download (website/Nexus) -- not for the download URL in POST /admin/releases."
