<#
.SYNOPSIS
    Launch smoke-test for a built overlay -- starts the packaged app, watches its
    log for a healthy startup, and FAILS (exit 1) on a crash-on-launch. Always
    kills the test instance afterward.

.DESCRIPTION
    Catches the class of bug that shipped in 1.3.82 ("Cannot find module
    ./overlay-core" -> instant crash). electron-builder can produce an installer
    that builds fine but dies the moment it launches; this test launches the real
    unpacked binary and inspects this run's log lines.

    Flow:
      1. Launch "<DistDir>/win-unpacked/Fallout Chat Mod.exe" (Start-Process -PassThru).
         Record the launch time, wait ~15s for startup to settle.
      2. Read "$env:APPDATA/Fallout Chat Mod/logs/main.log", keeping only lines whose
         timestamp is at/after the launch time (this run only).
      3. PASS requires, in this run's lines:
           - NO 'Cannot find module'
           - NO '[uncaught]'
           - a healthy startup marker: 'overlay starting'
             AND one of ('[relay] registered' | 'createWindow' | 'visible=true')
         FAIL otherwise.
      4. ALWAYS kill the test instance by PID tree (taskkill /PID <id> /T /F).
         NEVER touch a process named Fallout76 (that's the game).

    IMPORTANT -- ASCII-ONLY SCRIPT RULE:
      Keep this file ASCII-only (Windows PowerShell 5.1 mis-tokenizes Unicode dashes
      under -File). Use plain ASCII hyphens (-) only.

.PARAMETER Version  e.g. 1.3.83 (informational; the unpacked path is version-agnostic)
.PARAMETER DistDir  build-output dir (default: ..\cross-platform-overlay\dist-electron)
.PARAMETER WaitSec  seconds to let the app start before reading the log (default 15)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$DistDir = "",
    [int]$WaitSec = 15
)
$ErrorActionPreference = "Stop"

if (-not $DistDir) { $DistDir = Join-Path $PSScriptRoot "..\cross-platform-overlay\dist-electron" }
# productName is "Fallout Chat Mod" (WITH spaces). OS-aware: Windows launches the unpacked
# .exe; Linux launches the built .AppImage. $IsLinux/$IsWindows are automatic variables in
# PowerShell 7 (Core); they are $null on Windows PowerShell 5.1, so the else-branch is the
# 5.1/Windows path. The log also lives in a different place per OS.
if ($IsLinux) {
    $cfgHome = $env:XDG_CONFIG_HOME
    if (-not $cfgHome) { $cfgHome = Join-Path $HOME ".config" }
    $logDir = Join-Path $cfgHome "Fallout Chat Mod/logs"
    $item = Get-ChildItem -Path $DistDir -Filter "*.AppImage" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($item) { $exe = $item.FullName } else { $exe = "" }
} else {
    $logDir = Join-Path $env:APPDATA "Fallout Chat Mod\logs"
    $exe    = Join-Path $DistDir "win-unpacked\Fallout Chat Mod.exe"
}
$logPath = Join-Path $logDir "main.log"

Write-Host "==== SMOKE TEST for v$Version ===="
Write-Host "[smoke] App: $exe"
Write-Host "[smoke] Log: $logPath"

if (-not $exe -or -not (Test-Path $exe)) {
    Write-Error "[smoke] Launchable binary not found: $exe"
    Write-Host "SMOKE TEST: FAIL"
    exit 1
}

# Record cutoff just BEFORE launch so we only inspect this run's lines.
$launchTime = Get-Date
$proc = $null
$exitCode = 1
try {
    if ($IsLinux) {
        # Pass --ozone-platform=x11 so the KDE-Wayland XWayland self-relaunch is skipped
        # (single tracked process); APPIMAGELAUNCHER_DISABLE avoids the integrate prompt.
        & chmod +x $exe 2>$null
        $env:APPIMAGELAUNCHER_DISABLE = "1"
        $proc = Start-Process -FilePath $exe -ArgumentList "--no-sandbox","--ozone-platform=x11" -PassThru
    } else {
        $proc = Start-Process -FilePath $exe -PassThru
    }
    Write-Host "[smoke] Launched PID $($proc.Id) at $($launchTime.ToString('s')). Waiting ${WaitSec}s..."
    Start-Sleep -Seconds $WaitSec

    if (-not (Test-Path $logPath)) {
        Write-Error "[smoke] Log file not found after launch: $logPath"
        Write-Host "SMOKE TEST: FAIL"
        $exitCode = 1
        return
    }

    # electron-log default line format starts with an ISO-ish timestamp:
    #   [2026-06-06 05:42:01.123] [info]  overlay starting ...
    # Parse a leading bracketed timestamp; keep lines at/after launchTime. Lines
    # without a parseable timestamp are kept only if no run boundary is found, but
    # we prefer the timestamp filter to isolate this run.
    $allLines = Get-Content -Path $logPath -ErrorAction SilentlyContinue
    $runLines = @()
    foreach ($line in $allLines) {
        $ts = $null
        if ($line -match '^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})') {
            $tsText = $matches[1] -replace 'T', ' '
            try { $ts = [datetime]::Parse($tsText) } catch { $ts = $null }
        }
        if ($ts -ne $null) {
            # Allow ~2s of clock slack before launch.
            if ($ts -ge $launchTime.AddSeconds(-2)) { $runLines += $line }
        }
    }
    # Fallback: if timestamp parsing matched nothing (unexpected log format),
    # use the tail of the log so we still inspect something rather than nothing.
    if ($runLines.Count -eq 0 -and $allLines.Count -gt 0) {
        Write-Warning "[smoke] No timestamped lines matched this run; falling back to last 100 log lines."
        $runLines = $allLines | Select-Object -Last 100
    }

    Write-Host "[smoke] Inspecting $($runLines.Count) line(s) from this run."
    $joined = ($runLines -join "`n")

    $hasCannotFind = $joined -match 'Cannot find module'
    $hasUncaught   = $joined -match '\[uncaught\]'
    $hasStarting   = $joined -match 'overlay starting'
    $hasHealthy    = ($joined -match '\[relay\] registered') -or ($joined -match 'createWindow') -or ($joined -match 'visible=true')

    if ($hasCannotFind) { Write-Host "[smoke] FOUND fatal: 'Cannot find module'" }
    if ($hasUncaught)   { Write-Host "[smoke] FOUND fatal: '[uncaught]'" }
    Write-Host "[smoke] startup marker 'overlay starting': $hasStarting"
    Write-Host "[smoke] healthy marker (relay/createWindow/visible): $hasHealthy"

    if ((-not $hasCannotFind) -and (-not $hasUncaught) -and $hasStarting -and $hasHealthy) {
        $exitCode = 0
    } else {
        $exitCode = 1
    }
}
catch {
    Write-Host "[smoke] Exception during smoke test: $($_.Exception.Message)"
    $exitCode = 1
}
finally {
    # ALWAYS kill the test instance. NEVER touch Fallout76 (that is the game): on Linux we
    # match the overlay binary name "fallout-chat-mod" (hyphenated, lowercase) which never
    # matches the game ("Fallout76") nor this pwsh process (path has "Fallout Chat Mod").
    if ($IsLinux) {
        # Match the process NAME (comm), NOT the full cmdline: pkill -f would also match the
        # runner if its path contains "fallout-chat", whereas comm matching only hits the
        # overlay's own process ("fallout-chat-mo", truncated) and never pwsh/bash/Fallout76.
        Write-Host "[smoke] Killing test overlay (kill $($proc.Id) + pkill fallout-chat)..."
        if ($proc -and $proc.Id) { try { & kill $proc.Id 2>$null } catch { } }
        try { & pkill fallout-chat 2>$null } catch { }
    } elseif ($proc -and $proc.Id) {
        Write-Host "[smoke] Killing test instance PID tree $($proc.Id)..."
        try { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null } catch { }
    }
}

if ($exitCode -eq 0) {
    Write-Host "SMOKE TEST: PASS"
} else {
    Write-Host "SMOKE TEST: FAIL"
}
exit $exitCode
