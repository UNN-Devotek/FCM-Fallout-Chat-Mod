# probe-listener.ps1 -- TCP line-echo listener for SocketProbe M0 diagnostic
# Binds 127.0.0.1:4001, accepts connections in a loop.
# On each connection: sends HELLO + 3 test record lines, then PING every 10s.
# Logs all inbound bytes (text + hex) with timestamp to console AND probe-listener.log.
# Ctrl+C to stop.
# STRICTLY ASCII -- no Unicode dashes, smart quotes, or BOM.

param(
    [int]$Port = 4001,
    [string]$BindAddr = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$LogFile = Join-Path $PSScriptRoot "probe-listener.log"
$PingCount = 0
$Listener = $null

function Write-Log {
    param([string]$Msg)
    $ts = Get-Date -Format "HH:mm:ss.fff"
    $line = "[$ts] $Msg"
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
    param([System.IO.StreamWriter]$Writer, [string]$Text)
    try {
        $Writer.Write($Text + "`n")
        $Writer.Flush()
        Write-Log "SEND: $Text"
    } catch {
        Write-Log "SEND ERROR: $_"
    }
}

Write-Log "probe-listener starting on ${BindAddr}:${Port}"
Write-Log "Log file: $LogFile"
Write-Log "Press Ctrl+C to stop"

try {
    $IPAddr = [System.Net.IPAddress]::Parse($BindAddr)
    $Listener = New-Object System.Net.Sockets.TcpListener($IPAddr, $Port)
    $Listener.Start()
    Write-Log "Listener started OK"

    while ($true) {
        Write-Log "Waiting for connection..."
        # AcceptTcpClient is blocking -- Ctrl+C will interrupt it
        $Client = $Listener.AcceptTcpClient()
        $RemoteEP = $Client.Client.RemoteEndPoint
        Write-Log "Connection accepted from $RemoteEP"

        try {
            $Stream = $Client.GetStream()
            $Writer = New-Object System.IO.StreamWriter($Stream, [System.Text.Encoding]::UTF8)
            $Writer.AutoFlush = $false

            # --- Send greeting ---
            Send-Line $Writer "HELLO~1~3"
            Send-Line $Writer "#F5CB5B~General~ProbeBot~probe test line 1"
            Send-Line $Writer "#F5CB5B~General~ProbeBot~probe test line 2"
            Send-Line $Writer "#F5CB5B~General~ProbeBot~probe test line 3"

            # --- Background ping loop + inbound read loop ---
            $PingCount = 0
            $LastPing = [System.Diagnostics.Stopwatch]::StartNew()
            $ReadBuf = New-Object byte[] 4096

            while ($Client.Connected) {
                # Check for PING interval (10s)
                if ($LastPing.Elapsed.TotalSeconds -ge 10) {
                    $PingCount++
                    Send-Line $Writer "PING~$PingCount"
                    $LastPing.Restart()
                }

                # Non-blocking read -- check DataAvailable first
                if ($Stream.DataAvailable) {
                    $BytesRead = $Stream.Read($ReadBuf, 0, $ReadBuf.Length)
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

                # Check if client still connected
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
