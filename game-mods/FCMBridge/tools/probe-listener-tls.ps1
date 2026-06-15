# probe-listener-tls.ps1 -- TLS TCP listener for SocketProbe M0 diagnostic
# Round 3: ZFE's Text Chat transport is Schannel TLS even for host:port
# endpoints, so this wraps each accepted connection in an SslStream.
# Binds 127.0.0.1:4001. Uses a self-signed cert CN=fcm-hud-dev from
# Cert:\CurrentUser\My (created on first run).
# On TLS handshake success: sends HELLO + 3 test record lines, then PING
# every 10s; logs all inbound bytes (text + hex) to console AND
# probe-listener.log (lines tagged [TLS]).
# Ctrl+C to stop.
# STRICTLY ASCII -- no Unicode dashes, smart quotes, or BOM.

param(
    [int]$Port = 4001,
    [string]$BindAddr = "127.0.0.1",
    [string]$CertSubject = "CN=fcm-hud-dev"
)

$ErrorActionPreference = "Stop"

$LogFile = Join-Path $PSScriptRoot "probe-listener.log"
$Listener = $null

function Write-Log {
    param([string]$Msg)
    $ts = Get-Date -Format "HH:mm:ss.fff"
    $line = "[$ts] [TLS] $Msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding ASCII
}

function Bytes-To-Hex {
    param([byte[]]$Bytes)
    if ($Bytes -eq $null -or $Bytes.Length -eq 0) { return "" }
    $hex = ($Bytes | ForEach-Object { "{0:X2}" -f $_ }) -join " "
    return $hex
}

function Send-Line {
    param([System.Net.Security.SslStream]$Ssl, [string]$Text)
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text + "`n")
        $Ssl.Write($bytes, 0, $bytes.Length)
        $Ssl.Flush()
        Write-Log "SEND: $Text"
    } catch {
        Write-Log "SEND ERROR: $_"
        throw
    }
}

function Get-Or-Create-Cert {
    param([string]$Subject)
    $existing = Get-ChildItem -Path Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq $Subject } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if ($existing -ne $null) {
        Write-Log "Using existing cert: subject=$($existing.Subject) thumbprint=$($existing.Thumbprint) expires=$($existing.NotAfter)"
        return $existing
    }
    Write-Log "No cert with subject $Subject found -- creating self-signed cert..."
    $cert = New-SelfSignedCertificate -Subject $Subject `
        -DnsName "fcm-hud-dev", "127.0.0.1", "localhost" `
        -CertStoreLocation Cert:\CurrentUser\My `
        -KeyAlgorithm RSA -KeyLength 2048 `
        -NotAfter (Get-Date).AddYears(2)
    Write-Log "Created cert: thumbprint=$($cert.Thumbprint) expires=$($cert.NotAfter)"
    return $cert
}

Write-Log "probe-listener-tls starting on ${BindAddr}:${Port}"
Write-Log "Log file: $LogFile"
Write-Log "Press Ctrl+C to stop"

try {
    $Cert = Get-Or-Create-Cert -Subject $CertSubject

    $IPAddr = [System.Net.IPAddress]::Parse($BindAddr)
    $Listener = New-Object System.Net.Sockets.TcpListener($IPAddr, $Port)
    $Listener.Start()
    Write-Log "Listener started OK (TLS server cert thumbprint=$($Cert.Thumbprint))"

    while ($true) {
        Write-Log "Waiting for connection..."
        # AcceptTcpClient is blocking -- Ctrl+C will interrupt it
        $Client = $Listener.AcceptTcpClient()
        $RemoteEP = $Client.Client.RemoteEndPoint
        Write-Log "Connection accepted from $RemoteEP -- starting TLS handshake"

        $Ssl = $null
        try {
            $NetStream = $Client.GetStream()
            $Ssl = New-Object System.Net.Security.SslStream($NetStream, $false)

            # Server-side auth: no client cert required, TLS 1.2, no revocation check
            try {
                $Ssl.AuthenticateAsServer(
                    $Cert,
                    $false,
                    [System.Security.Authentication.SslProtocols]::Tls12,
                    $false)
                Write-Log ("TLS handshake OK: protocol=" + $Ssl.SslProtocol `
                    + " cipher=" + $Ssl.CipherAlgorithm + "/" + $Ssl.CipherStrength `
                    + " hash=" + $Ssl.HashAlgorithm `
                    + " keyex=" + $Ssl.KeyExchangeAlgorithm)
            } catch {
                Write-Log "TLS HANDSHAKE FAILED: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
                $inner = $_.Exception.InnerException
                while ($inner -ne $null) {
                    Write-Log "  INNER: $($inner.GetType().FullName): $($inner.Message)"
                    $inner = $inner.InnerException
                }
                try { $Client.Close() } catch {}
                Write-Log "Connection closed after TLS failure. Waiting for next..."
                continue
            }

            # --- Send greeting over TLS ---
            Send-Line $Ssl "HELLO~1~3"
            Send-Line $Ssl "#F5CB5B~General~ProbeBot~tls probe line 1"
            Send-Line $Ssl "#F5CB5B~General~ProbeBot~tls probe line 2"
            Send-Line $Ssl "#F5CB5B~General~ProbeBot~tls probe line 3"

            # --- Ping loop + inbound read loop ---
            $PingCount = 0
            $LastPing = [System.Diagnostics.Stopwatch]::StartNew()
            $ReadBuf = New-Object byte[] 4096

            while ($Client.Connected) {
                # PING every 10s
                if ($LastPing.Elapsed.TotalSeconds -ge 10) {
                    $PingCount++
                    Send-Line $Ssl "PING~$PingCount"
                    $LastPing.Restart()
                }

                # SslStream has no DataAvailable -- poll the raw socket, but
                # only Read via the SslStream (never the NetworkStream)
                if ($Client.Available -gt 0 -or $NetStream.DataAvailable) {
                    $BytesRead = $Ssl.Read($ReadBuf, 0, $ReadBuf.Length)
                    if ($BytesRead -gt 0) {
                        $DataBytes = $ReadBuf[0..($BytesRead - 1)]
                        $Text = [System.Text.Encoding]::UTF8.GetString($DataBytes)
                        $Hex = Bytes-To-Hex $DataBytes
                        $SafeText = $Text -replace "[\x00-\x1F]", "."
                        Write-Log "RECV $BytesRead bytes | text: $SafeText | hex: $Hex"
                    } else {
                        Write-Log "Client closed connection (0 bytes read)"
                        break
                    }
                } else {
                    Start-Sleep -Milliseconds 100
                }

                # Disconnect detection
                if ($Client.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $Client.Available -eq 0) {
                    Write-Log "Client disconnected (poll)"
                    break
                }
            }
        } catch [System.IO.IOException] {
            Write-Log "Client IO error (disconnected): $_"
        } catch {
            Write-Log "Client error: $_"
        } finally {
            if ($Ssl -ne $null) { try { $Ssl.Dispose() } catch {} }
            try { $Client.Close() } catch {}
            Write-Log "Connection closed. Waiting for next..."
        }
    }
} catch {
    Write-Log "FATAL: $_"
} finally {
    if ($Listener -ne $null) {
        try { $Listener.Stop() } catch {}
        Write-Log "Listener stopped"
    }
}
