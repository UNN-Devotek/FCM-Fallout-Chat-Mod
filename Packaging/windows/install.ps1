<#
  Fallout Chat Mod - Windows CLI installer

    irm https://falloutchatmod.com/install.ps1 | iex

  Downloads the latest installer from the release feed and runs it (per-user,
  no admin prompt). After this one-time install the app AUTO-UPDATES itself, so
  you never need to re-run this. Re-running just refreshes to the current build.

  About SmartScreen / antivirus: the installer is not code-signed yet, so
  Windows may show "unknown publisher" and some AV tools may flag it. This is a
  false positive driven by the missing signing certificate, NOT by the app's
  behavior - it does not modify game files, read game memory, or scan your
  network. If SmartScreen blocks it, choose "More info" -> "Run anyway".
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$base = 'https://falloutchatmod.com/downloads/electron'
$feed = "$base/latest.yml"

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Green }

Say 'Looking up the latest version...'
$yml = (Invoke-WebRequest -UseBasicParsing -Uri $feed).Content
# latest.yml has a `path: Fallout Chat Mod Setup <ver>.exe` line.
$pathLine = ($yml -split "`n" | Where-Object { $_ -match '^\s*path:\s*' } | Select-Object -First 1)
$verLine  = ($yml -split "`n" | Where-Object { $_ -match '^\s*version:\s*' } | Select-Object -First 1)
if (-not $pathLine) { throw 'Could not parse the installer name from the release feed.' }
$exeName = ($pathLine -replace '^\s*path:\s*', '').Trim().Trim('"')
$version = if ($verLine) { ($verLine -replace '^\s*version:\s*', '').Trim() } else { 'unknown' }
Say "Latest version: $version"

# URL-encode the filename (it contains spaces). EscapeDataString encodes spaces
# as %20 (UrlPathEncode leaves them literal, which 404s). The name has no slashes.
$dlUrl = "$base/" + [Uri]::EscapeDataString($exeName)

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
Start-Process -FilePath $dest -ArgumentList '/S','/CURRENTUSER' -Wait
Remove-Item $dest -Force -ErrorAction SilentlyContinue

Say 'Installed. Launch "Fallout Chat Mod" from the Start Menu, then sign in with Discord.'
Say 'The app keeps itself up to date automatically.'
Say 'Run Fallout 76 in Borderless Windowed (not exclusive fullscreen) so the overlay can draw over it.'
