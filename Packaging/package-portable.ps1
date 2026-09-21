<# Builds an unpublished portable folder and ZIP from a tested EXE and optional PROD bridge. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [ValidatePattern('^\d+\.\d+\.\d+$')] [string]$Version,
    [Parameter(Mandatory = $true)] [string]$PortableExe,
    [Parameter(Mandatory = $true)] [string]$BridgeZip,
    [string]$BridgeInstructions = "",
    [Parameter(Mandatory = $true)] [string]$OutputDir
)
$ErrorActionPreference = 'Stop'
$exe = Get-Item -LiteralPath $PortableExe
if ($exe.Name -ne "Fallout Chat Mod Portable $Version.exe" -or $exe.Length -lt 1MB) {
    throw 'Expected the requested-version portable EXE (at least 1 MB)'
}
$folder = Join-Path $OutputDir "Fallout Chat Mod Portable $Version"
$zip = "$folder.zip"
if ((Test-Path -LiteralPath $folder) -or (Test-Path -LiteralPath $zip)) {
    throw 'Output already exists; use a fresh output directory to preserve existing packages'
}
$stage = Join-Path ([IO.Path]::GetTempPath()) ("fcm-portable-package-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $bridge = Join-Path $stage 'Optional FCM Bridge'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path -LiteralPath $BridgeZip).Path, $bridge)
    $allowed = @('BUILD.json', 'EXPORT.json', 'INSTALL.txt', 'FCMServerBridge.hudmodloader.ini', 'Fallout76Custom.ini.example', 'Data/FCMServerBridge.ba2')
    foreach ($file in Get-ChildItem -LiteralPath $bridge -Recurse -File) {
        $relative = $file.FullName.Substring($bridge.Length + 1).Replace('\', '/')
        if ($relative -cnotin $allowed) { throw "Unexpected bridge package entry: $relative" }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $bridge 'BUILD.json') -Raw | ConvertFrom-Json
    $export = Get-Content -LiteralPath (Join-Path $bridge 'EXPORT.json') -Raw | ConvertFrom-Json
    if ($manifest.target -ne 'prod' -or $export.environment -ne 'prod') { throw 'Only a PROD-stamped bridge may be included' }
    $ba2 = Join-Path $bridge 'Data/FCMServerBridge.ba2'
    if ((Get-FileHash -LiteralPath $ba2 -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.ba2Sha256) {
        throw 'Bridge BA2 does not match its build manifest'
    }
    $bridgeInstallPath = Join-Path $bridge 'INSTALL.txt'
    if ($BridgeInstructions) {
        Copy-Item -LiteralPath $BridgeInstructions -Destination $bridgeInstallPath -Force
    } else {
        $repoRoot = Split-Path $PSScriptRoot -Parent
        $gameMods = Join-Path $repoRoot 'game-mods'
        $fcmBridge = Join-Path $gameMods 'FCMBridge'
        $bridgeMod = Join-Path $fcmBridge 'hudmodloader-bridge'
        $template = Join-Path $bridgeMod 'INSTALL.template.txt'
        $text = (Get-Content -LiteralPath $template -Raw).Replace('{version}', '0.2.8').Replace('{target}', 'PROD').Replace('{host}', 'falloutchatmod.com')
        [IO.File]::WriteAllText($bridgeInstallPath, $text, [Text.UTF8Encoding]::new($false))
    }
    Copy-Item -LiteralPath $exe.FullName -Destination $stage
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows/README-PORTABLE.txt') -Destination (Join-Path $stage 'README.txt')
    Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($stage.Length + 1)
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
    } | Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Encoding ASCII
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Move-Item -LiteralPath $stage -Destination $folder
    Compress-Archive -LiteralPath $folder -DestinationPath $zip
    Write-Host "Unpublished package: $zip"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
