# Optional HUD-mod setup only. Never run by the desktop overlay.
param([string]$GameDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'

function Enable-FcmXscalChat([string]$Path, [string]$Endpoint) {
    if ($Endpoint -notmatch '^wss://[a-z0-9.-]+/relay$') {
        throw 'Invalid package relay endpoint.'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'xscal.ini was not found. Install xScal first and extract this package beside Fallout76.exe.'
    }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $offset = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        $encoding = New-Object Text.UTF8Encoding($true, $true); $offset = 3
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
        $encoding = [Text.Encoding]::Unicode; $offset = 2
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
        $encoding = [Text.Encoding]::BigEndianUnicode; $offset = 2
    }
    $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
    $newline = "`n"
    if ($text.Contains("`r`n")) { $newline = "`r`n" }
    $headers = [regex]::Matches($text, '(?im)^[ \t]*\[Chat\][ \t]*(?:[;#][^\r\n]*)?\r?$')
    if ($headers.Count -gt 1) { throw 'Multiple [Chat] sections found. Merge them manually before running setup.' }
    if ($headers.Count -eq 0) {
        if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += $newline }
        $text += '[Chat]' + $newline
        $headers = [regex]::Matches($text, '(?im)^\[Chat\]\r?$')
    }
    $start = $headers[0].Index + $headers[0].Length
    $next = [regex]::Match($text.Substring($start), '(?m)^[ \t]*\[')
    $end = $text.Length
    if ($next.Success) { $end = $start + $next.Index }
    $body = $text.Substring($start, $end - $start)
    foreach ($entry in @(@('enabled', 'true'), @('relayEndpoint', $Endpoint))) {
        $pattern = '(?im)^([ \t]*' + $entry[0] + '[ \t]*=[ \t]*)[^\r\n]*'
        $value = $entry[1]
        if ([regex]::IsMatch($body, $pattern)) {
            $body = [regex]::Replace($body, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match)
                $comment = [regex]::Match($match.Value, '[;#].*$')
                $suffix = ''
                if ($comment.Success) { $suffix = ' ' + $comment.Value }
                return $match.Groups[1].Value + $value + $suffix
            })
        } else {
            if (-not $body.EndsWith("`n")) { $body += $newline }
            $body += $entry[0] + '=' + $value + $newline
        }
    }
    $updated = $text.Substring(0, $start) + $body + $text.Substring($end)
    $original = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
    if ($updated -eq $original) { Write-Host 'xScal chat is already enabled for this package.'; return }
    $backup = $Path + '.fcm-backup-' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllBytes($backup, $bytes)
    [IO.File]::WriteAllText($Path, $updated, $encoding)
    Write-Host "Enabled xScal chat. Backup: $backup"
}

if ($MyInvocation.InvocationName -ne '.') {
    if (Get-Process -Name Fallout76 -ErrorAction SilentlyContinue) {
        throw 'Exit Fallout 76 before changing its script-extender configuration.'
    }
    Enable-FcmXscalChat (Join-Path $GameDirectory 'xscal.ini') '@@FCM_RELAY_ENDPOINT@@'
    Write-Host 'Setup complete. Start Fallout 76 to load the updated configuration.'
}
