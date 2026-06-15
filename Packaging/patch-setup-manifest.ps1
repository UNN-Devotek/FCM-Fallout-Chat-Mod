param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RC {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeLibrary(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr FindResource(IntPtr h, IntPtr n, IntPtr t);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr LoadResource(IntPtr h, IntPtr r);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr LockResource(IntPtr r);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SizeofResource(IntPtr h, IntPtr r);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr BeginUpdateResource(string f, bool deleteExisting);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool UpdateResource(IntPtr u, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool EndUpdateResource(IntPtr u, bool discard);
}
"@

$LOAD_LIBRARY_AS_DATAFILE = 2
$RT_MANIFEST = [IntPtr]24

# 1. Read current manifest
$h = [RC]::LoadLibraryEx($Path, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($h -eq [IntPtr]::Zero) { throw "LoadLibraryEx failed" }
try {
    $r = [RC]::FindResource($h, [IntPtr]1, $RT_MANIFEST)
    $rd = [RC]::LoadResource($h, $r)
    $ptr = [RC]::LockResource($rd)
    $sz = [RC]::SizeofResource($h, $r)
    $buf = New-Object byte[] $sz
    [Runtime.InteropServices.Marshal]::Copy($ptr, $buf, 0, $sz)
    $xml = [Text.Encoding]::UTF8.GetString($buf)
} finally { [RC]::FreeLibrary($h) | Out-Null }

Write-Host "=== before:"
($xml -split "`n" | Select-String 'requestedExecutionLevel') | ForEach-Object { Write-Host "  $($_.Line.Trim())" }

# 2. Replace asInvoker with requireAdministrator (exact case + whitespace preserved via regex)
$patched = [regex]::Replace($xml, 'level="asInvoker"', 'level="requireAdministrator"')
if ($patched -eq $xml) { Write-Host 'NOTHING TO PATCH'; exit 0 }

# Preserve same byte length (requireAdministrator is longer — we need to trim whitespace in uiAccess attr to compensate)
# Simpler: rebuild with fresh manifest, but keep it the same size as original by padding with whitespace before <trustInfo>
$origBytes = [Text.Encoding]::UTF8.GetBytes($xml)
$newBytes  = [Text.Encoding]::UTF8.GetBytes($patched)
$diff = $newBytes.Length - $origBytes.Length
if ($diff -gt 0) {
    # Trim spaces inside uiAccess attr pad: Inno's manifest has `level="asInvoker"            uiAccess="false"` with padding
    # After replace: `level="requireAdministrator"            uiAccess="false"` — we remove exactly $diff spaces
    $padRegex = '(level="requireAdministrator")( {' + $diff + '})'
    $patched = [regex]::Replace($patched, $padRegex, '$1')
    $newBytes = [Text.Encoding]::UTF8.GetBytes($patched)
}

Write-Host "=== after:"
($patched -split "`n" | Select-String 'requestedExecutionLevel') | ForEach-Object { Write-Host "  $($_.Line.Trim())" }

# 3. Write back
$u = [RC]::BeginUpdateResource($Path, $false)
if ($u -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$ok = [RC]::UpdateResource($u, $RT_MANIFEST, [IntPtr]1, 1033, $newBytes, [uint32]$newBytes.Length)
if (-not $ok) { [RC]::EndUpdateResource($u, $true) | Out-Null; throw "UpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$ok = [RC]::EndUpdateResource($u, $false)
if (-not $ok) { throw "EndUpdateResource failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
Write-Host "=== manifest patched OK"
