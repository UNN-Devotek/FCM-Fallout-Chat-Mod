<#
.SYNOPSIS
    VirusTotal gate -- uploads the built Windows installer to VirusTotal, waits for
    the scan to COMPLETE, and FAILS CLOSED (exit 1) if it exceeds the malicious /
    suspicious thresholds. On PASS it pushes the SHA-256 permalink to the backend.

.DESCRIPTION
    This is a release GATE, not a fire-and-forget upload. Unlike the tail end of
    publish-nexus-release.ps1 (which queues a scan and moves on), this script BLOCKS
    on the analysis result so a flagged build can be stopped before it is published.

    Flow:
      1. Upload "<DistDir>/Fallout Chat Mod Setup <Version>.exe" to VirusTotal.
         The .exe is >32 MB so we must request a large-file upload URL first. We build
         the multipart body manually because Invoke-RestMethod -Form is PowerShell 7+
         only and this must run under Windows PowerShell 5.1 (reused from
         publish-nexus-release.ps1).
      2. Poll the analysis endpoint until status == 'completed' (timeout ~12 min).
      3. Read stats (malicious / suspicious / harmless / undetected), list flagging
         engines, and GATE: malicious > MaxMalicious OR suspicious > MaxSuspicious
         -> FAIL (exit 1). Otherwise PASS (exit 0).
      4. On PASS: compute the SHA-256 permalink and POST it to /admin/virustotal-url.

    HEURISTIC FALSE POSITIVES:
      The Electron build is NOT code-signed yet, so a handful of AV engines may raise
      heuristic / "unknown publisher" flags that are false positives, not real
      detections. That is why -MaxSuspicious defaults to a small non-zero value (3)
      while -MaxMalicious defaults to 0. The real fix is code-signing the installer
      (see docs/deployment/code-signing.md); once signed, tighten both to 0.

    IMPORTANT -- ASCII-ONLY SCRIPT RULE:
      Keep this file ASCII-only. Windows PowerShell 5.1 run via the `-File` flag
      mis-tokenizes non-ASCII characters (e.g. em-dashes U+2014) and throws a
      misleading "Unexpected token" parse error. Use plain ASCII hyphens (-) only.

    Env vars (Windows USER env vars):
      VT_API_KEY                VirusTotal personal API key (required)
      PROD_ADMIN_RELEASE_TOKEN  falloutchatmod.com admin release token (optional)

.PARAMETER Version       e.g. 1.3.83
.PARAMETER MaxMalicious  max allowed 'malicious' verdicts before FAIL (default 0)
.PARAMETER MaxSuspicious max allowed 'suspicious' verdicts before FAIL (default 3)
.PARAMETER ExePath       optional explicit path to the .exe (overrides DistDir guess)
.PARAMETER DistDir       build-output dir (default: ..\cross-platform-overlay\dist-electron)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$Version,
    [int]$MaxMalicious  = 0,
    [int]$MaxSuspicious = 3,
    [string]$ExePath = "",
    [string]$DistDir = ""
)
$ErrorActionPreference = "Stop"

if (-not $DistDir) { $DistDir = Join-Path $PSScriptRoot "..\cross-platform-overlay\dist-electron" }
# productName is "Fallout Chat Mod" (WITH spaces) -- electron-builder output names.
if (-not $ExePath) { $ExePath = Join-Path $DistDir "Fallout Chat Mod Setup $Version.exe" }

if (-not (Test-Path $ExePath)) {
    Write-Error "[vt-gate] Installer not found: $ExePath"
    exit 1
}

# -- Resolve API key (process env, then persistent USER scope) -------------------
$vtKey    = $env:VT_API_KEY
$relToken = $env:PROD_ADMIN_RELEASE_TOKEN
if (-not $vtKey)    { $vtKey    = [Environment]::GetEnvironmentVariable('VT_API_KEY','User') }
if (-not $relToken) { $relToken = [Environment]::GetEnvironmentVariable('PROD_ADMIN_RELEASE_TOKEN','User') }
if (-not $vtKey) {
    Write-Error "[vt-gate] VT_API_KEY not set - cannot run the VirusTotal gate. Set the VT_API_KEY USER env var."
    exit 1
}

$sha256      = (Get-FileHash -Algorithm SHA256 $ExePath).Hash.ToLower()
$vtPermalink = "https://www.virustotal.com/gui/file/$sha256/detection"
Write-Host "==== VT GATE for v$Version ===="
Write-Host "[vt-gate] File:    $ExePath"
Write-Host "[vt-gate] SHA-256: $sha256"
Write-Host "[vt-gate] Thresholds: malicious <= $MaxMalicious, suspicious <= $MaxSuspicious"

# -- Step 1: upload (large-file URL, manual multipart for PS 5.1) -----------------
$uploadUrlResp = Invoke-RestMethod -Uri "https://www.virustotal.com/api/v3/files/upload_url" `
    -Headers @{ "x-apikey" = $vtKey } -Method Get
$uploadUrl = $uploadUrlResp.data
if (-not $uploadUrl) {
    Write-Error "[vt-gate] Could not obtain VirusTotal upload URL."
    exit 1
}

Write-Host "[vt-gate] Uploading $('{0:N1}' -f ((Get-Item $ExePath).Length / 1MB)) MB to VirusTotal..."
$boundary  = [System.Guid]::NewGuid().ToString("N")
$fileName  = [System.IO.Path]::GetFileName($ExePath)
$fileBytes = [System.IO.File]::ReadAllBytes($ExePath)
$enc       = [System.Text.Encoding]::ASCII
$preamble  = $enc.GetBytes("--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"$fileName`"`r`nContent-Type: application/octet-stream`r`n`r`n")
$epilogue  = $enc.GetBytes("`r`n--$boundary--`r`n")
$ms        = New-Object System.IO.MemoryStream
$ms.Write($preamble,  0, $preamble.Length)
$ms.Write($fileBytes, 0, $fileBytes.Length)
$ms.Write($epilogue,  0, $epilogue.Length)
$multipartBytes = $ms.ToArray()
$ms.Dispose()

$analysis   = $null
$analysisId = $null
try {
    $uploadResp = Invoke-RestMethod -Uri $uploadUrl -Method Post `
        -Headers @{ "x-apikey" = $vtKey } `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $multipartBytes
    $analysisId = $uploadResp.data.id
    if (-not $analysisId) {
        Write-Error "[vt-gate] Upload did not return an analysis id."
        exit 1
    }
    Write-Host "[vt-gate] Upload accepted. Analysis id: $analysisId"
} catch {
    $errBody = $_.ErrorDetails.Message
    if ($errBody -match "AlreadySubmittedError") {
        Write-Host "[vt-gate] File already submitted (same SHA-256). Fetching cached result..."
        try {
            $fileResp = Invoke-RestMethod -Uri "https://www.virustotal.com/api/v3/files/$sha256" `
                -Headers @{ "x-apikey" = $vtKey } -Method Get
            $analysis = $fileResp
        } catch {
            Write-Error "[vt-gate] Failed to fetch cached result: $($_.Exception.Message)"
            exit 1
        }
    } else {
        Write-Error "[vt-gate] Upload failed: $($_.Exception.Message)"
        exit 1
    }
}

# -- Step 2: poll analysis until completed (timeout ~12 min, ~15s interval) -------
# Skipped when AlreadySubmittedError path returned a completed file report directly.
if (-not $analysis) {
    $timeoutSec  = 720
    $intervalSec = 15
    $deadline    = (Get-Date).AddSeconds($timeoutSec)
    $status      = ""
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $intervalSec
        try {
            $analysis = Invoke-RestMethod -Uri "https://www.virustotal.com/api/v3/analyses/$analysisId" `
                -Headers @{ "x-apikey" = $vtKey } -Method Get
        } catch {
            Write-Host "[vt-gate] Poll error (retrying): $($_.Exception.Message)"
            continue
        }
        $status = $analysis.data.attributes.status
        $elapsed = [int]((Get-Date) - $deadline.AddSeconds(-$timeoutSec)).TotalSeconds
        Write-Host "[vt-gate] status=$status (elapsed ${elapsed}s / ${timeoutSec}s)"
        if ($status -eq "completed") { break }
    }

    if ($status -ne "completed") {
        Write-Error "[vt-gate] Analysis did not complete within ${timeoutSec}s (last status: '$status'). Treating as FAIL (release blocked)."
        Write-Host "VT GATE: FAIL (release blocked)"
        exit 1
    }
}

# -- Step 3: read stats + list flagging engines ----------------------------------
# Files endpoint returns stats under .data.attributes.last_analysis_stats;
# analyses endpoint returns them under .data.attributes.stats.
$attrs = $analysis.data.attributes
$stats = if ($attrs.stats) { $attrs.stats } else { $attrs.last_analysis_stats }
$malicious  = [int]$stats.malicious
$suspicious = [int]$stats.suspicious
$harmless   = [int]$stats.harmless
$undetected = [int]$stats.undetected
Write-Host "[vt-gate] Results: malicious=$malicious suspicious=$suspicious harmless=$harmless undetected=$undetected"

$results = if ($attrs.results) { $attrs.results } else { $attrs.last_analysis_results }
if ($results) {
    $flaggers = @()
    foreach ($prop in $results.PSObject.Properties) {
        $r = $prop.Value
        if ($r.category -eq "malicious" -or $r.category -eq "suspicious") {
            $flaggers += "    $($prop.Name) -> $($r.category) ($($r.result))"
        }
    }
    if ($flaggers.Count -gt 0) {
        Write-Host "[vt-gate] Flagging engines:"
        $flaggers | ForEach-Object { Write-Host $_ }
    } else {
        Write-Host "[vt-gate] No engines flagged the file."
    }
}
Write-Host "[vt-gate] Permalink: $vtPermalink"

# -- Step 4: GATE ----------------------------------------------------------------
if ($malicious -gt $MaxMalicious -or $suspicious -gt $MaxSuspicious) {
    Write-Error "[vt-gate] Threshold exceeded (malicious=$malicious > $MaxMalicious OR suspicious=$suspicious > $MaxSuspicious)."
    Write-Host "VT GATE: FAIL (release blocked)"
    exit 1
}

# PASS: push the permalink to the backend so /virustotal points at this scan.
if (-not $relToken) {
    Write-Warning "[vt-gate] PROD_ADMIN_RELEASE_TOKEN not set - skipping /admin/virustotal-url update."
} else {
    try {
        $body = '{"url":"' + $vtPermalink + '"}'
        Invoke-RestMethod -Uri "https://falloutchatmod.com/admin/virustotal-url" -Method Post `
            -Headers @{ "Authorization" = "Bearer $relToken"; "Content-Type" = "application/json" } `
            -Body $body | Out-Null
        Write-Host "[vt-gate] /virustotal redirect updated -> $vtPermalink"
    } catch {
        Write-Warning "[vt-gate] Failed to update /virustotal redirect: $($_.Exception.Message)"
    }
}

Write-Host "VT GATE: PASS"
exit 0
