$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enable-xScal-Chat.ps1')
$folder = Join-Path ([IO.Path]::GetTempPath()) ('fcm-xscal-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $folder | Out-Null
try {
    $path = Join-Path $folder 'xscal.ini'
    $encoding = New-Object Text.UTF8Encoding($false)
    foreach ($newline in @("`n", "`r`n")) {
        $original = @('[General]', 'enabled=false', 'xScalPriority=7', '[Chat]', 'Enabled = false ; default', 'enabled=false', 'relayEndpoint=wss://example.invalid/relay', '[Other]', 'enabled=false') -join $newline
        [IO.File]::WriteAllText($path, $original, $encoding)
        Enable-FcmXscalChat $path 'wss://dev.falloutchatmod.com/relay'
        $actual = [IO.File]::ReadAllText($path)
        if (-not $actual.Contains('Enabled = true ; default') -or -not $actual.Contains('relayEndpoint=wss://dev.falloutchatmod.com/relay')) { throw 'Chat settings were not enabled/stamped.' }
        if (-not $actual.StartsWith('[General]' + $newline + 'enabled=false' + $newline + 'xScalPriority=7') -or -not $actual.EndsWith('[Other]' + $newline + 'enabled=false')) { throw 'Unrelated configuration changed.' }
        $backup = @(Get-ChildItem ($path + '.fcm-backup-*') | Where-Object { [IO.File]::ReadAllText($_.FullName) -eq $original })
        if ($backup.Count -lt 1) { throw 'Original backup missing.' }
        Enable-FcmXscalChat $path 'wss://dev.falloutchatmod.com/relay'
        if ([IO.File]::ReadAllText($path) -ne $actual) { throw 'Setup is not idempotent.' }
    }
    foreach ($original in @('[General]', "[Chat]`n;enabled=false`n", "[Chat]`nenabled=false")) {
        [IO.File]::WriteAllText($path, $original, [Text.Encoding]::Unicode)
        Enable-FcmXscalChat $path 'wss://falloutchatmod.com/relay'
        if (-not [IO.File]::ReadAllText($path).Contains('enabled=true')) { throw 'Missing section/key was not populated.' }
        if ([IO.File]::ReadAllBytes($path)[0] -ne 255) { throw 'Encoding changed.' }
    }
    [IO.File]::WriteAllText($path, "[Chat]`nenabled=false`n[Chat]`nenabled=false", $encoding)
    $failed = $false
    try { Enable-FcmXscalChat $path 'wss://falloutchatmod.com/relay' } catch { $failed = $true }
    if (-not $failed -or [IO.File]::ReadAllText($path).Contains('enabled=true')) { throw 'Ambiguous sections must fail without changes.' }
    Write-Host 'xScal setup tests passed'
} finally { Remove-Item -LiteralPath $folder -Recurse -Force }
