<# Builds self-contained Nexus overlay ZIPs with the optional validated PROD bridge. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [ValidatePattern('^\d+\.\d+\.\d+$')] [string]$Version,
    [Parameter(Mandatory = $true)] [string]$BridgeZip,
    [string]$DistDir = ""
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$overlayDir = Join-Path $repoRoot 'cross-platform-overlay'
if (-not $DistDir) { $DistDir = Join-Path $overlayDir 'dist-electron' }
$installDir = Join-Path $overlayDir 'assets/install'
$bridgeTemplate = Join-Path $repoRoot 'game-mods/FCMBridge/hudmodloader-bridge/INSTALL.template.txt'
$expectedBridgeZipSha256 = '803759975d541745ad9a434cf0ba2c7cd193e22abde92b10e4c1e638c2ed2b26'
$expectedBridgeBa2Sha256 = '97047bd39c6572b410ce81a0ab27802e89dbef27d35960dc0f016dd6cf641113'

if (-not (Test-Path -LiteralPath $BridgeZip)) { throw "Bridge ZIP not found: $BridgeZip" }
if ((Get-FileHash -LiteralPath $BridgeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedBridgeZipSha256) {
    throw 'Bridge ZIP does not match the reviewed 0.2.8 candidate'
}

$artifacts = @{
    Windows = Join-Path $DistDir "Fallout Chat Mod Setup $Version.exe"
    Portable = Join-Path $DistDir "Fallout Chat Mod Portable $Version.exe"
    AppImage = Join-Path $DistDir "Fallout Chat Mod-$Version.AppImage"
    Deb = Join-Path $DistDir "Fallout Chat Mod-$Version.deb"
}
foreach ($artifact in $artifacts.Values) {
    if (-not (Test-Path -LiteralPath $artifact)) { throw "Release artifact not found: $artifact" }
}

$stageRoot = Join-Path $DistDir ("_nexus-package-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stageRoot | Out-Null

function Add-Bridge([string]$Stage) {
    $bridge = Join-Path $Stage 'Optional FCM Bridge'
    Expand-Archive -LiteralPath $BridgeZip -DestinationPath $bridge
    $ba2 = Join-Path $bridge 'Data/FCMServerBridge.ba2'
    if ((Get-FileHash -LiteralPath $ba2 -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedBridgeBa2Sha256) {
        throw 'Bridge BA2 does not match the reviewed 0.2.8 candidate'
    }
    $install = (Get-Content -LiteralPath $bridgeTemplate -Raw).Replace('{version}', '0.2.8').Replace('{target}', 'PROD').Replace('{host}', 'falloutchatmod.com')
    [IO.File]::WriteAllText((Join-Path $bridge 'INSTALL.txt'), $install, [Text.UTF8Encoding]::new($false))
}

function Write-Checksums([string]$Stage) {
    $lines = Get-ChildItem -LiteralPath $Stage -Recurse -File | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Stage.Length + 1).Replace('\', '/')
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
    }
    [IO.File]::WriteAllLines((Join-Path $Stage 'SHA256SUMS.txt'), $lines, [Text.Encoding]::ASCII)
}

function Build-Zip([string]$Name, [scriptblock]$Populate) {
    $stage = Join-Path $stageRoot $Name
    New-Item -ItemType Directory -Path $stage | Out-Null
    & $Populate $stage
    Add-Bridge $stage
    Write-Checksums $stage
    $output = Join-Path $DistDir "$Name-Nexus.zip"
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $output
    Write-Host "[nexus-package] $output"
}

try {
    Build-Zip "Fallout Chat Mod Setup $Version (Windows)" {
        param($stage)
        Copy-Item -LiteralPath $artifacts.Windows -Destination $stage
        Copy-Item -LiteralPath (Join-Path $installDir 'INSTALL-WINDOWS-NEXUS.txt') -Destination $stage
    }
    Build-Zip "Fallout Chat Mod Portable $Version (Windows)" {
        param($stage)
        Copy-Item -LiteralPath $artifacts.Portable -Destination $stage
        $readme = (Get-Content -LiteralPath (Join-Path $installDir 'README-PORTABLE-NEXUS.txt') -Raw).Replace('<version>', $Version)
        [IO.File]::WriteAllText((Join-Path $stage 'README.txt'), $readme, [Text.UTF8Encoding]::new($false))
        New-Item -ItemType Directory -Path (Join-Path $stage 'FCMData') | Out-Null
        [IO.File]::WriteAllText((Join-Path $stage 'FCMData/KEEP-FCMData-WITH-THE-EXE.txt'), 'Keep this folder beside the portable executable.', [Text.UTF8Encoding]::new($false))
    }
    Build-Zip "Fallout Chat Mod $Version (Linux AppImage)" {
        param($stage)
        Copy-Item -LiteralPath $artifacts.AppImage -Destination $stage
        Copy-Item -LiteralPath (Join-Path $installDir 'INSTALL-LINUX-APPIMAGE-NEXUS.txt') -Destination $stage
        Copy-Item -LiteralPath (Join-Path $overlayDir 'assets/fallout-chatmod-keepabove.kwinrule') -Destination $stage
    }
    Build-Zip "Fallout Chat Mod $Version (Linux .deb)" {
        param($stage)
        Copy-Item -LiteralPath $artifacts.Deb -Destination $stage
        Copy-Item -LiteralPath (Join-Path $installDir 'INSTALL-LINUX-DEB-NEXUS.txt') -Destination $stage
    }
} finally {
    if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
