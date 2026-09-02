<#
  Fallout Chat Mod - Windows CLI installer

    irm https://falloutchatmod.com/install.ps1 | iex

  Downloads the latest installer from the release API and runs it (per-user,
  no admin prompt). Re-running UPGRADES an existing install and fast-forwards
  from ANY older version; if you are already on the latest it asks whether to
  reinstall or cancel.

  New versions are NOT installed automatically. Download new versions from
  Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or
  falloutchatmod.com.

  About SmartScreen / antivirus: the installer is not code-signed yet, so
  Windows may show "unknown publisher" and some AV tools may flag it. This is a
  false positive driven by the missing signing certificate, NOT by the app's
  behavior - it does not modify game files, read game memory, or scan your
  network. If SmartScreen blocks it, choose "More info" -> "Run anyway".
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$base    = 'https://falloutchatmod.com/downloads/electron'
$apiUrl  = 'https://falloutchatmod.com/api/releases'

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Green }

Say 'Looking up the latest version...'
$relJson = (Invoke-WebRequest -UseBasicParsing -Uri $apiUrl).Content | ConvertFrom-Json
if (-not $relJson.data -or $relJson.data.Count -eq 0) { throw 'No releases found from the release API.' }
$version = $relJson.data[0].version
if (-not $version) { throw 'Could not read version from the release API response.' }
Say "Latest version: $version"

# --- Already installed? Compare and (if already current) prompt --------------
# Read the installed exe's product version. not installed / installed < latest
# -> upgrade (fast-forwards from any older version); installed >= latest -> ask.
$installedExe = Join-Path $env:LOCALAPPDATA 'Programs\Fallout Chat Mod\Fallout Chat Mod.exe'
$legacyInstalledExe = Join-Path $env:LOCALAPPDATA 'Programs\Fallout ChatMod\Fallout ChatMod.exe'
$installed = $null
if (Test-Path $installedExe) {
  try { $installed = ([string](Get-Item $installedExe).VersionInfo.ProductVersion).Trim() } catch { $installed = $null }
}
if (Test-Path $legacyInstalledExe) {
  Say 'A legacy Fallout Chat Mod install was found. The installer will migrate it before installing the current build.'
}
if ($installed) {
  $isCurrent = $false
  try { $isCurrent = ([version]$installed) -ge ([version]$version) } catch { $isCurrent = ($installed -eq $version) }
  if ($isCurrent) {
    Say "You are already on the latest version (v$installed)."
    $ans = Read-Host 'Reinstall (uninstall + reinstall) or cancel? [r/C]'
    if ($ans -notmatch '^[rRyY]') { Say 'Cancelled - nothing changed.'; return }
    Say "Reinstalling v$version..."
  } else {
    Say "Installed v$installed -> updating to v$version."
  }
}

# Build the raw installer filename using the same convention as the release pipeline:
# productName "Fallout Chat Mod" WITH spaces. URL-encode with EscapeDataString
# (spaces -> %20).
$exeName = "Fallout Chat Mod Setup $version.exe"
$dlUrl   = "$base/" + [Uri]::EscapeDataString($exeName)

# Recover a broken/locked prior install: stop any running overlay so its files
# (app.asar, exe) are not locked and the NSIS installer can fully overwrite the
# old build in place. This is what patches a crashed/broken existing install.
# NEVER touch 'Fallout76' (the game) - only the overlay processes.
Say 'Closing any running Fallout Chat Mod overlay so it can be replaced...'
Get-Process -Name 'Fallout Chat Mod','electron' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$dest = Join-Path $env:TEMP $exeName
Say "Downloading $exeName ..."
Invoke-WebRequest -UseBasicParsing -Uri $dlUrl -OutFile $dest
$size = (Get-Item $dest).Length
if ($size -lt 1MB) { Remove-Item $dest -Force; throw "Downloaded file is only $size bytes - feed/CDN problem." }

Say 'Running the installer (per-user, no admin prompt)...'
# electron-builder NSIS (oneClick:false). /S = silent; /CURRENTUSER forces the
# per-user scope so it never prompts for machine-vs-user. Matches the repo's
# documented silent-install flow.
$proc = Start-Process -FilePath $dest -ArgumentList '/S','/CURRENTUSER' -PassThru -Wait
Remove-Item $dest -Force -ErrorAction SilentlyContinue
if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode) - install may have failed (cancelled or blocked)." }

Say 'Installed. Launch "Fallout Chat Mod" from the Start Menu, then sign in with Discord.'
Say 'Download new versions from Nexus Mods (https://www.nexusmods.com/fallout76/mods/4082) or falloutchatmod.com.'
Say 'Run Fallout 76 in Borderless Windowed (not exclusive fullscreen) so the overlay can draw over it.'
