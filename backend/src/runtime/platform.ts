import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const preparedWindowsDirectories = new Map<string, string>();

export function runtimeControlDirectory(configured?: string, mode = process.env.NODE_ENV): string {
  return configured || (mode === 'production' && process.platform !== 'win32'
    ? '/app/runtime-control' : path.resolve('.fcm-runtime'));
}

export function runtimeControlEndpoint(directory: string): string {
  if (process.platform !== 'win32') return path.join(directory, 'control.sock');
  const identity = createHash('sha256').update(realpathSync(directory).toLowerCase()).digest('hex');
  return `\\\\.\\pipe\\fcm-runtime-${identity}`;
}

export function runtimeControlToken(directory: string, create = false): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const filename = path.join(directory, 'control-token');
  if (create) {
    try { writeFileSync(filename, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  }
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) throw new Error('Invalid private runtime credential');
  const token = readFileSync(filename, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid private runtime credential');
  return token;
}

/** Windows ignores Unix permission bits. Establish the private, inheritable ACL
 * before reading retained inputs, and reject pre-existing public/reparse entries.
 * New journals inherit this ACL; no per-message shell or ACL rewrite is needed.
 */
export function prepareWindowsControlDirectory(directory: string): void {
  if (process.platform !== 'win32') return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid private runtime directory');
  const canonical = realpathSync(directory);
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  if (preparedWindowsDirectories.get(canonical) === identity) return;
  const script = `
$ErrorActionPreference = 'Stop'
$directory = $env:FCM_PRIVATE_CONTROL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
$acl = Get-Acl -LiteralPath $directory
if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Foreign runtime directory owner' }
$private = New-Object System.Security.AccessControl.DirectorySecurity
$private.SetAccessRuleProtection($true, $false)
$private.SetOwner($sid)
foreach ($value in $allowed) {
  $identity = New-Object System.Security.Principal.SecurityIdentifier($value)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $private.AddAccessRule($rule)
}
Set-Acl -LiteralPath $directory -AclObject $private
$pending = New-Object 'System.Collections.Generic.Queue[string]'
$pending.Enqueue($directory)
while ($pending.Count) {
  foreach ($entry in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime reparse entry' }
    $entryAcl = Get-Acl -LiteralPath $entry.FullName
    foreach ($rule in $entryAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'Public runtime entry' }
    }
    if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
  }
}
`;
  try {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, FCM_PRIVATE_CONTROL_PATH: canonical }, stdio: 'ignore', timeout: 15_000, windowsHide: true });
  } catch { throw new Error('Windows runtime directory ACL validation failed'); }
  preparedWindowsDirectories.set(canonical, identity);
}
