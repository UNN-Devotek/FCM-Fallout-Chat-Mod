<#
.SYNOPSIS
    Publishes a built release file to Nexus Mods as a NEW file version, optionally
    archiving the previously-current file, using the Nexus v3 Upload API.

.DESCRIPTION
    Implements the full 6-step v3 Upload flow (mirrors Nexus-Mods/upload-action):
      1. POST /uploads/multipart          - open a multipart upload session
      2. PUT  <presigned part urls>       - upload each chunk to S3 (no apikey)
      3. POST <complete presigned url>    - finish the S3 multipart (XML)
      4. POST /uploads/{id}/finalise      - hand the upload back to Nexus
      5. GET  /uploads/{id}  (poll)       - wait until state == "available"
      6. POST /mod-file-update-groups/{group_id}/versions
                                          - attach as the new file and optionally
                                            archive the previous one

    There is no standalone "delete/archive" endpoint on Nexus - retiring the old
    file happens ONLY as a side effect of posting the new one, when
    archive_existing_file is true. The default is false so a review upload can be
    approved by Nexus support before the existing live file is retired.

.NOTES
    TROUBLESHOOTING - "hangs on 1/6 opening multipart upload session" / HTTP 000:
      Windows curl.exe is built against Schannel (run `curl --version` to confirm),
      which does a HARD TLS certificate-revocation check. If the OCSP/CRL responder
      for the Nexus/Cloudflare cert chain is unreachable from this host, the TLS
      handshake never completes -> the call hangs (no timeout) or returns HTTP 000.
      It is NOT rate-limiting (a 429 returns a real status + x-rl-* headers) and NOT
      a Nexus outage. Tell-tale: the SAME request succeeds from WSL (OpenSSL curl).
      FIX (already applied below): every curl.exe call passes --ssl-revoke-best-effort
      (+ --connect-timeout/--max-time). Quick check from PowerShell:
        curl.exe -s -o NUL -w "http=%{http_code} ssl=%{time_appconnect}s`n" `
          --ssl-revoke-best-effort -H "apikey: $env:NEXUS_API_KEY" `
          https://api.nexusmods.com/v1/users/validate.json
      http=200 with --ssl-revoke-best-effort but http=000 without it confirms the cause.

    Role in the release pipeline:
      Called by publish-nexus-release.ps1 (once for each enabled release file). Not
      intended to be invoked directly during a normal release; use the wrapper script
      which supplies the correct per-platform file-group IDs and descriptions.

    Auth: a personal API key from https://www.nexusmods.com/settings/api-keys,
    sent as the custom header `apikey: <key>` on v3 JSON calls. The presigned S3
    PUT/POST calls carry NO apikey (auth is baked into the URL).

    UNVERIFIED at build time (api-docs.nexusmods.com 403s automated fetchers; the
    v3 Upload API is Open Beta / "evaluation only"):
      - whether uploading requires a Premium account
      - whether `application-name`/`application-version` headers are required
    If a call 401/403s unexpectedly, verify both in a browser. Endpoints may
    change while the API is in beta - pin against Nexus-Mods/upload-action.

.PARAMETER FilePath
    Full path to the file to upload (e.g. a desktop installer or HUD ZIP).

.PARAMETER Version
    Version string for the Nexus file version field (e.g. 1.3.57).

.PARAMETER ApiKey
    Nexus personal API key. Defaults to $env:NEXUS_API_KEY.

.PARAMETER FileGroupId
    The mod's file-group / update-group id (Files tab -> Manage Files -> "API Info").
    Defaults to $env:NEXUS_FILE_GROUP_ID.

.PARAMETER FileCategory
    Nexus file category for the new file. Assignable values: main / optional /
    miscellaneous. Default: main.

.PARAMETER ArchiveExisting
    Archive the currently-live file when posting this one. Default: $false.
    Pass -ArchiveExisting:$true for a normal replacement after the new upload is
    approved and ready to become the current file.

.PARAMETER DryRun
    Validate inputs and print the planned calls without uploading anything.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$FilePath,
    [Parameter(Mandatory = $true)] [string]$Version,
    [string]$ApiKey            = $env:NEXUS_API_KEY,
    [string]$FileGroupId       = $env:NEXUS_FILE_GROUP_ID,
    [ValidateSet("main", "optional", "miscellaneous")]
    [string]$FileCategory      = "main",
    # When set, the installer is wrapped in a .zip with THIS name before upload
    # (Nexus expects a zip + a platform-suffixed display name, e.g.
    # "Fallout Chat Mod Setup 1.3.67 (Windows).zip").
    [string]$ZipAs             = "",
    # Shown as the file's description on Nexus (the Windows file carries the
    # SmartScreen/AV false-positive disclaimer).
    [string]$Description       = "",
    # Additional files to include alongside the installer in the -ZipAs archive
    # (e.g. INSTALL-*.txt, .kwinrule). Only used when -ZipAs is also provided.
    [string[]]$IncludeFiles    = @(),
    [bool]  $ArchiveExisting   = $false,
    [string]$BaseUrl           = "https://api.nexusmods.com/v3",
    [int]   $MaxPollAttempts   = 60,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
# Nexus presigned S3 + the v3 API are TLS1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fail($msg) { Write-Error "[nexus] $msg"; exit 1 }

# --- Validate inputs ---------------------------------------------------------
# Process env may not carry persistent USER-scope vars (e.g. when launched via
# WSL interop) - fall back to reading them straight from the User environment.
if (-not $ApiKey)      { $ApiKey      = [Environment]::GetEnvironmentVariable('NEXUS_API_KEY','User') }
if (-not $FileGroupId) { $FileGroupId = [Environment]::GetEnvironmentVariable('NEXUS_FILE_GROUP_ID','User') }
if (-not $ApiKey)      { Fail "No API key. Pass -ApiKey or set NEXUS_API_KEY (https://www.nexusmods.com/settings/api-keys)." }
if (-not $FileGroupId) { Fail "No file-group id. Pass -FileGroupId or set NEXUS_FILE_GROUP_ID (Files tab -> Manage Files -> API Info)." }
if (-not (Test-Path $FilePath)) { Fail "File not found: $FilePath" }

# Nexus wants the installer wrapped in a .zip (with a platform-suffixed display
# name). When -ZipAs is given, compress the installer into a temp zip and upload
# that instead of the raw .exe/.AppImage.
if ($ZipAs) {
    if ($ZipAs -notmatch '\.zip$') { Fail "-ZipAs must end in .zip (got '$ZipAs')" }
    # Prefer a temp dir on the same drive as the source file to avoid cross-drive
    # copies and to use available space (C: may be full on dev machines).
    # Same-drive staging is a Windows optimization (C: may be full). On Linux,
    # GetPathRoot() returns "/" which Test-Path passes but isn't writable - so the
    # zip lands at "/<name>" (denied). Only use drive-root staging on Windows.
    $srcDrive  = [System.IO.Path]::GetPathRoot($FilePath)
    $tempBase  = if ($IsWindows -and $srcDrive -and (Test-Path $srcDrive)) { $srcDrive } else { [System.IO.Path]::GetTempPath() }
    $zipPath   = Join-Path $tempBase $ZipAs
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    # Build the list of files to include: the installer + any -IncludeFiles entries.
    $filesToZip = @($FilePath)
    foreach ($extra in $IncludeFiles) {
        if (Test-Path $extra) {
            $filesToZip += $extra
        } else {
            Write-Warning "[nexus] -IncludeFiles: path not found, skipping: $extra"
        }
    }
    Write-Host "[nexus] zipping $(Split-Path $FilePath -Leaf) -> $ZipAs  (extra files: $($filesToZip.Count - 1))"
    # Compress-Archive on Linux emits a zip whose entries (Unix attrs / central-dir
    # layout) can make Nexus's ClamAV fail the scan -> the file gets blocked even
    # though the contents are clean. Use the standard `zip` tool there (-j flat, -X
    # drop Unix extra fields) for a conventional Windows-like archive; Compress-Archive
    # is fine on Windows.
    if ($IsWindows) {
        Compress-Archive -Path $filesToZip -DestinationPath $zipPath -Force
    } else {
        & zip -j -q -X $zipPath $filesToZip
        if ($LASTEXITCODE -ne 0) { Fail "zip failed (exit $LASTEXITCODE) building $zipPath" }
    }
    $FilePath = $zipPath
}

$file      = Get-Item $FilePath
$fileName  = $file.Name
$sizeBytes = $file.Length
$apiHeaders = @{ "apikey" = $ApiKey; "Content-Type" = "application/json" }

Write-Host "[nexus] Publishing $fileName ($([math]::Round($sizeBytes/1MB,1)) MB) as version $Version"
Write-Host "[nexus]   group=$FileGroupId category=$FileCategory archiveExisting=$ArchiveExisting"

if ($DryRun) {
    Write-Host "[nexus] DRY RUN - would POST $BaseUrl/uploads/multipart then attach to /mod-file-update-groups/$FileGroupId/versions"
    exit 0
}

# Surface RFC 9457 problem+json bodies from failed v3 calls.
function Invoke-Nexus {
    param([string]$Method, [string]$Uri, $Body)
    # Use curl.exe (ships with Windows 10+) - Invoke-RestMethod may mangle
    # Content-Type (charset suffix) or swallow error response bodies on 4xx.
    # Write JSON body to a temp file to avoid PowerShell argument quoting issues.
    $bodyFile = $null
    # === Windows curl.exe + Nexus/Cloudflare TLS: the HTTP 000 hang explained ===
    # SYMPTOM: on Windows this would hang forever on "1/6 opening multipart upload
    #   session", or fail with HTTP_STATUS:000 (curl couldn't complete the request).
    # ROOT CAUSE: Windows ships curl built against *Schannel* (the OS TLS stack) --
    #   `curl --version` shows "Schannel". Schannel does a HARD certificate-revocation
    #   check (OCSP/CRL) during the TLS handshake. When the revocation responder for
    #   the Nexus / Cloudflare cert chain is slow or unreachable from this host, the
    #   handshake never completes: TCP connects (time_connect ~0.02s) but
    #   time_appconnect (TLS) stays 0 and the request dies. The SAME request from WSL
    #   (curl built against OpenSSL) succeeds, which is the tell-tale sign it's a
    #   Schannel-revocation problem and NOT rate-limiting or a Nexus outage.
    # FIX: --ssl-revoke-best-effort -- Schannel still verifies the cert chain and
    #   still checks revocation, but it TOLERATES an unreachable revocation responder
    #   instead of hard-failing the handshake. (Prefer this over --ssl-no-revoke,
    #   which disables revocation checking entirely.)
    # ALSO: --connect-timeout/--max-time so a stalled connection fails fast and the
    #   retry loop below kicks in, instead of blocking the whole publish forever.
    # DIAGNOSE: `curl.exe -w 'http=%{http_code} ssl=%{time_appconnect}s' https://api.nexusmods.com/v1/users/validate.json -H "apikey: KEY"`
    #   http=000 + ssl=0 => this exact issue; add --ssl-revoke-best-effort.
    # curl binary + the Schannel-only flag are Windows-specific. On Linux/macOS use
    # `curl` (the real binary, not the PowerShell alias) and omit
    # --ssl-revoke-best-effort (a Windows Schannel option OpenSSL curl rejects).
    $curlExe = if ($IsWindows) { 'curl.exe' } else { 'curl' }
    $sslArgs = if ($IsWindows) { @('--ssl-revoke-best-effort') } else { @() }
    $curlArgs = @("-s") + $sslArgs + @("--connect-timeout", "15", "--max-time", "120",
                  "-w", "`nHTTP_STATUS:%{http_code}", "-X", $Method.ToUpper(),
                  $Uri, "-H", "apikey: $ApiKey", "-H", "Content-Type: application/json")
    if ($null -ne $Body) {
        $jsonBody = $Body | ConvertTo-Json -Depth 6 -Compress
        $bodyFile = [System.IO.Path]::GetTempFileName()
        # Use UTF8 WITHOUT BOM - [System.Text.Encoding]::UTF8 includes a BOM which
        # makes the JSON invalid (server sees 0xEF 0xBB 0xBF before the '{').
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($bodyFile, $jsonBody, $utf8NoBom)
        $curlArgs += @("--data-binary", "@$bodyFile")
    }
    # Retry transient failures: curl timeout/connection error (HTTP_STATUS:0) or a
    # 5xx from the API. Up to 4 attempts with linear backoff. 4xx is NOT retried
    # (it's a real client error and would just repeat).
    $httpStatus = 0; $respBody = ""
    try {
        for ($att = 1; $att -le 4; $att++) {
            $rawOut = & $curlExe @curlArgs 2>&1
            $lines  = $rawOut -join "`n"
            $statusMatch = [regex]::Match($lines, 'HTTP_STATUS:(\d+)')
            $httpStatus  = if ($statusMatch.Success) { [int]$statusMatch.Groups[1].Value } else { 0 }
            $respBody    = ($lines -replace '\nHTTP_STATUS:\d+$','').Trim()
            if ($httpStatus -ge 200 -and $httpStatus -lt 300) { break }
            $transient = ($httpStatus -eq 0 -or $httpStatus -ge 500)
            if (-not $transient -or $att -eq 4) { break }
            $wait = 5 * $att
            Write-Host "[nexus]   transient failure (HTTP $httpStatus) on $Method $Uri - retry $att/3 in ${wait}s"
            Start-Sleep -Seconds $wait
        }
    } finally {
        if ($bodyFile -and (Test-Path $bodyFile)) { Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue }
    }

    if ($httpStatus -lt 200 -or $httpStatus -ge 300) {
        Fail "$Method $Uri failed: HTTP $httpStatus - $respBody"
    }
    if ($respBody) {
        return $respBody | ConvertFrom-Json
    }
}

# --- Step 1: open multipart upload session -----------------------------------
Write-Host "[nexus] 1/6 opening multipart upload session ..."
$session = Invoke-Nexus -Method Post -Uri "$BaseUrl/uploads/multipart" -Body @{
    filename   = $fileName
    size_bytes = "$sizeBytes"
}
$session = if ($session.data) { $session.data } else { $session }
$uploadId      = $session.id
$partSize      = [int64]$session.part_size_bytes
$partUrls      = $session.part_presigned_urls
$completeUrl   = $session.complete_presigned_url
if (-not $uploadId -or -not $partUrls) { Fail "Unexpected /uploads/multipart response (no id / part urls): $($session | ConvertTo-Json -Depth 6)" }
Write-Host "[nexus]   upload id=$uploadId  parts=$($partUrls.Count)  partSize=$([math]::Round($partSize/1MB,1)) MB"

# --- Step 2: PUT each chunk to S3 (no apikey), capture ETags -----------------
Write-Host "[nexus] 2/6 uploading $($partUrls.Count) part(s) to S3 ..."
$completedParts = @()
$stream = [System.IO.File]::OpenRead($FilePath)
try {
    $idx = 0
    foreach ($p in $partUrls) {
        $idx++
        # part url entry may be a bare string or an object { part_number, url }
        $partNumber = if ($p.PSObject.Properties.Match('part_number').Count) { [int]$p.part_number } else { $idx }
        $url        = if ($p.PSObject.Properties.Match('url').Count)         { $p.url }                else { [string]$p }

        $buffer = New-Object byte[] $partSize
        $read   = $stream.Read($buffer, 0, $partSize)
        # For the last (shorter) part, slice to exact size using Array.Copy into a
        # properly-typed byte[] - PowerShell range $buffer[0..n] gives Object[], not
        # byte[], and Invoke-WebRequest serialises it wrong (wrong ETag / wrong size).
        if ($read -lt $partSize) {
            $trimmed = New-Object byte[] $read
            [System.Array]::Copy($buffer, $trimmed, $read)
            $buffer = $trimmed
        }

        # NOTE: this PUT uses .NET (Invoke-WebRequest), not Schannel curl, so it is
        # NOT subject to the hard-revocation handshake failure documented in
        # Invoke-Nexus -- .NET defaults to CheckCertificateRevocationList=$false, so
        # no --ssl-revoke-best-effort equivalent is needed here.
        # -TimeoutSec guards against a hung S3 PUT (parts are <=50 MB; 300s is ample
        # even on slow upstreams). Without it a stalled connection blocks forever.
        $resp = Invoke-WebRequest -Method Put -Uri $url -Body $buffer `
            -ContentType "application/octet-stream" -UseBasicParsing -TimeoutSec 300
        $etag = $resp.Headers["ETag"]
        if ($etag -is [array]) { $etag = $etag[0] }
        if (-not $etag) { Fail "S3 PUT for part $partNumber returned no ETag" }
        # S3 returns ETags with surrounding double-quotes (e.g. `"abc123"`).
        # The CompleteMultipartUpload XML must contain the bare hex value - strip them.
        $etag = $etag.Trim().Trim('"')
        $completedParts += [pscustomobject]@{ PartNumber = $partNumber; ETag = $etag }
        Write-Host "[nexus]   part $partNumber/$($partUrls.Count) uploaded ($read bytes) etag=$etag"
    }
} finally {
    $stream.Dispose()
}

# --- Step 3: complete the S3 multipart (XML to the presigned complete url) ----
Write-Host "[nexus] 3/6 completing S3 multipart ..."
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append("<CompleteMultipartUpload>")
foreach ($cp in ($completedParts | Sort-Object PartNumber)) {
    [void]$sb.Append("<Part><PartNumber>$($cp.PartNumber)</PartNumber><ETag>$($cp.ETag)</ETag></Part>")
}
[void]$sb.Append("</CompleteMultipartUpload>")
$xmlBody = $sb.ToString()
Write-Host "[nexus]   XML: $xmlBody"
# Write XML to a temp file; use curl.exe (ships with Windows 10+) so we get
# the full response body on 4xx (Invoke-WebRequest swallows it).
$xmlTmp = [System.IO.Path]::GetTempFileName() + ".xml"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($xmlTmp, $xmlBody, $utf8NoBom)
try {
    # --ssl-revoke-best-effort: same Schannel revocation fix as Invoke-Nexus above
    # (this presigned URL is on Cloudflare R2 -- *.r2.cloudflarestorage.com -- whose
    # cert chain triggers the same hard-revocation handshake failure on Windows).
    $curlExe = if ($IsWindows) { 'curl.exe' } else { 'curl' }
    $sslArgs = if ($IsWindows) { @('--ssl-revoke-best-effort') } else { @() }
    $cArgs = @("-s") + $sslArgs + @("--connect-timeout", "15", "--max-time", "120",
              "-w", "`nHTTP_STATUS:%{http_code}", "-X", "POST", $completeUrl,
              "-H", "Content-Type: application/xml", "--data-binary", "@$xmlTmp")
    $curlOut = & $curlExe @cArgs 2>&1
    $statusLine = ($curlOut | Select-String "HTTP_STATUS:").ToString()
    $httpStatus = [int]($statusLine -replace '.*HTTP_STATUS:','')
    $respBody   = ($curlOut | Where-Object { $_ -notmatch "HTTP_STATUS:" }) -join "`n"
    if ($httpStatus -lt 200 -or $httpStatus -ge 300) {
        Fail "S3 complete-multipart failed: HTTP $httpStatus - $respBody"
    }
    Write-Host "[nexus]   S3 complete OK (HTTP $httpStatus)"
} finally {
    Remove-Item $xmlTmp -Force -ErrorAction SilentlyContinue
}

# --- Step 4: finalise (hand the upload back to Nexus) ------------------------
Write-Host "[nexus] 4/6 finalising upload ..."
Invoke-Nexus -Method Post -Uri "$BaseUrl/uploads/$uploadId/finalise" | Out-Null

# --- Step 5: poll until Nexus has processed + virus-scanned the file ----------
Write-Host "[nexus] 5/6 waiting for Nexus to process the file (virus scan) ..."
$state = ""
for ($attempt = 1; $attempt -le $MaxPollAttempts; $attempt++) {
    $info  = Invoke-Nexus -Method Get -Uri "$BaseUrl/uploads/$uploadId"
    $info  = if ($info.data) { $info.data } else { $info }
    $state = $info.state
    Write-Host "[nexus]   attempt $attempt/$MaxPollAttempts state=$state"
    if ($state -eq "available") { break }
    if ($state -eq "error" -or $state -eq "failed") { Fail "Nexus reported upload state '$state'" }
    Start-Sleep -Seconds ([math]::Min(30, 2 * $attempt))
}
if ($state -ne "available") { Fail "Upload did not reach 'available' within $MaxPollAttempts attempts (last state: $state)" }

# --- Step 6: attach the new file + optionally archive the previous one --------
$archiveLabel = if ($ArchiveExisting) { "archiving previous file" } else { "preserving previous file" }
Write-Host "[nexus] 6/6 attaching new version + $archiveLabel ..."
# Nexus auto-appends ".zip" to names for zip uploads - strip it to avoid ".zip.zip".
$displayName = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
$result = Invoke-Nexus -Method Post -Uri "$BaseUrl/mod-file-update-groups/$FileGroupId/versions" -Body @{
    upload_id                    = $uploadId
    name                         = $displayName
    version                      = $Version
    description                  = $Description
    file_category                = $FileCategory
    archive_existing_file        = $ArchiveExisting
    allow_mod_manager_download   = $true
    primary_mod_manager_download = $false
    show_requirements_pop_up     = $false
}
$result = if ($result.data) { $result.data } else { $result }
$categoryLabel = $FileCategory.ToUpperInvariant()
Write-Host "[nexus] DONE - new file uid=$($result.id) attached as $categoryLabel; previous file archived=$ArchiveExisting"
exit 0
