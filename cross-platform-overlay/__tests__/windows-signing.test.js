// Guard test: the Windows release installer must be code-signed via Azure Trusted
// Signing, and the signing config must live in the RELEASE workflow (build-windows.yml)
// — never in package.json.
//
// Why both halves matter:
//   1. Releases are fail-closed; a silent regression to an UNSIGNED installer would
//      re-trip the Nexus quarantine and the Windows SmartScreen warning. So we assert
//      the azureSignOptions injection is present in build-windows.yml.
//   2. The PR CI gate (ci.yml → overlay-build-windows-nsis) builds on windows-latest
//      with NO Azure credentials. If azureSignOptions ever lands in package.json,
//      electron-builder would try to sign on every PR and fail. So we assert
//      package.json's build config has NO azureSignOptions.
//
// Setup that backs this test (provisioned once, see
// docs/deployment/releasing-the-overlay.md → "Windows code signing"):
//   - Trusted Signing account `fcm-trusted-signing` (region eastus)
//   - Certificate profile `fcm-public-trust` (PublicTrust)
//   - Service principal `fcm-signing-ci` → repo secrets AZURE_TENANT_ID / AZURE_CLIENT_ID
//     / AZURE_CLIENT_SECRET; publisher name → repo variable AZURE_PUBLISHER_NAME
//
// Runner: vitest (environment 'node').

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const OVERLAY_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(OVERLAY_ROOT, '..');

const workflow = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'build-windows.yml'),
  'utf8'
);
const pkg = JSON.parse(readFileSync(join(OVERLAY_ROOT, 'package.json'), 'utf8'));

// Execute the actual workflow gate, substituting only signing and native launch.
// The deliberately stale profiles model a reused self-hosted runner.
function runNativeGate(installerExit, check, workflowSource = workflow) {
  const temp = mkdtempSync(join(tmpdir(), 'fcm-native-gate-'));
  try {
    const dist = join(temp, 'cross-platform-overlay', 'dist-electron');
    const runnerTemp = join(temp, 'runner');
    const sharedProfile = join(temp, 'shared-profile');
    const files = [
      [join(dist, 'Fallout Chat Mod Setup 1.4.3.exe'), 'installer fixture'],
      [join(dist, 'Fallout Chat Mod Portable 1.4.3.exe'), 'portable fixture'],
      [join(dist, 'FCMData', 'logs', 'main.log'), 'stale portable success'],
      [join(sharedProfile, 'Fallout Chat Mod', 'logs', 'main.log'), 'stale installed success'],
      [join(runnerTemp, 'fcm-installer-smoke', 'win-unpacked', 'resources', 'app.asar'), 'asar fixture'],
    ];
    for (const [file, bytes] of files) {
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, bytes);
    }
    const receipt = join(dist, 'windows-release-gates.json');
    writeFileSync(receipt, 'stale receipt');
    const eventsFile = join(temp, 'events.jsonl');
    const body = workflowSource.replace(/\r\n/g, '\n').match(/- name: Verify Windows signatures and native launch gates[\s\S]*?run: \|\n([\s\S]*?)(?=\n      - name: Verify Windows artifact contract)/)?.[1];
    expect(body, 'native gate must be selected from the release workflow').toBeTruthy();
    const script = join(temp, 'gate.ps1');
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
function Get-AuthenticodeSignature { param($LiteralPath) [pscustomobject]@{ Status='Valid' } }
function powershell.exe {
  param([switch]$NoProfile, $ExecutionPolicy, $File, $Version, $DistDir, $Artifact='Default', $UserDataDir)
  # Electron's Windows default is the shell roaming folder, independent of APPDATA.
  $profile = if ($UserDataDir) { $UserDataDir } else { Join-Path $env:FCM_TEST_ROAMING 'Fallout Chat Mod' }
  $log = if ($Artifact -eq 'Portable') { Join-Path $DistDir 'FCMData/logs/main.log' } else { Join-Path $profile 'logs/main.log' }
  [pscustomobject]@{ artifact=$Artifact; freshLog=(-not (Test-Path $log)); distDir=$DistDir; profile=$profile } |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $env:FCM_TEST_EVENTS -Encoding UTF8
  $global:LASTEXITCODE = if ($Artifact -eq 'Portable') { 0 } else { [int]$env:FCM_TEST_INSTALLER_EXIT }
}
${body.replace(/^ {10}/gm, '')}
`);
    const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        cwd: temp, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, APPDATA: sharedProfile, FCM_TEST_ROAMING: sharedProfile, RUNNER_TEMP: runnerTemp,
          RELEASE_VERSION: '1.4.3', RELEASE_TARGET: 'both', FCM_TEST_EVENTS: eventsFile,
          FCM_TEST_INSTALLER_EXIT: String(installerExit) },
      });
    expect(result.error).toBeUndefined();
    const events = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, ''))) : [];
    check({ result, receipt, events, dist, sharedProfile });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

describe('Windows release code signing (Azure Trusted Signing)', () => {
  it('passes an explicit profile to the app and reads that same profile, including paths with spaces', () => {
    const temp = mkdtempSync(join(tmpdir(), 'fcm-smoke-profile-'));
    try {
      const dist = join(temp, 'build');
      const profile = join(temp, 'isolated profile');
      mkdirSync(join(dist, 'win-unpacked'), { recursive: true });
      for (const file of [join(dist, 'Fallout Chat Mod-1.4.3.AppImage'), join(dist, 'win-unpacked', 'Fallout Chat Mod.exe')]) writeFileSync(file, 'fixture');
      const script = join(temp, 'launch.ps1');
      writeFileSync(script, `
$ErrorActionPreference = 'Stop'
function Start-Process {
  param($FilePath, $ArgumentList, [switch]$PassThru)
  if (($ArgumentList -join ' ') -notmatch '--user-data-dir="([^"]+)"') { throw 'Missing quoted user-data-dir argument' }
  $profile = $matches[1]
  if ($profile -ne $env:FCM_TEST_PROFILE) { throw 'Wrong Electron profile' }
  $logs = Join-Path $profile 'logs'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  @("[$stamp] [info] overlay starting", "[$stamp] [info] createWindow") |
    Set-Content -LiteralPath (Join-Path $logs 'main.log') -Encoding UTF8
  [pscustomobject]@{ Id=0 }
}
function kill { }
function pkill { }
function taskkill { }
& $env:FCM_TEST_SMOKE -Version 1.4.3 -DistDir $env:FCM_TEST_DIST -WaitSec 0 -UserDataDir $env:FCM_TEST_PROFILE
`);
      const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
          encoding: 'utf8', timeout: 30000,
          env: { ...process.env, FCM_TEST_PROFILE: profile, FCM_TEST_DIST: dist,
            FCM_TEST_SMOKE: join(REPO_ROOT, 'Packaging', 'smoke-test.ps1') },
        });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('SMOKE TEST: PASS');
      expect(readFileSync(join(profile, 'logs', 'main.log'), 'utf8')).toContain('overlay starting');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 30000);

  it('rejects an installer smoke failure even when portable would succeed, with no success receipt', () => {
    runNativeGate(1, ({ result, receipt, events }) => {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Installed-edition native launch gate failed');
      expect(events.map(event => event.artifact)).toEqual(['Default']);
      expect(existsSync(receipt)).toBe(false);
    }, workflow.replace(/\r?\n/g, '\r\n'));
  }, 30000);

  it('uses fresh installed and portable logs and writes receipts only after both pass', () => {
    runNativeGate(0, ({ result, receipt, events, dist, sharedProfile }) => {
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(events.map(event => event.artifact)).toEqual(['Default', 'Portable']);
      expect(events.every(event => event.freshLog)).toBe(true);
      expect(events[0].profile).not.toBe(sharedProfile);
      expect(events[1].distDir).not.toBe(dist);
      const receipts = JSON.parse(readFileSync(receipt, 'utf8').replace(/^\uFEFF/, ''));
      expect(receipts.map(item => [item.artifact, item.signature, item.nativeSmoke])).toEqual([
        ['Fallout Chat Mod Setup 1.4.3.exe', 'Valid', 'PASS'],
        ['Fallout Chat Mod Portable 1.4.3.exe', 'Valid', 'PASS'],
      ]);
    });
  }, 30000);

  it('offers native GitHub-hosted Windows while retaining the self-hosted default', () => {
    expect(workflow).toContain('options: [self-hosted, github-hosted]');
    expect(workflow).toContain('default: self-hosted');
    expect(workflow).toContain("inputs.runner == 'github-hosted' && 'windows-latest'");
    expect(workflow).toContain("fromJSON('[\"self-hosted\",\"windows\",\"unn\"]')");
  });

  it('gates uploaded Windows artifacts on signatures and both native launch checks', () => {
    expect(workflow).toContain("$signature.Status -ne 'Valid'");
    expect(workflow).toContain("$installerSmoke 'win-unpacked'");
    expect(workflow).toContain('-DistDir $smokeDist');
    expect(workflow).toContain('-DistDir $portableSmoke -Artifact Portable');
    expect(workflow).toContain('windows-release-gates.json');
    expect(workflow.indexOf('Verify Windows signatures and native launch gates'))
      .toBeLessThan(workflow.indexOf('Upload installer artifacts'));
  });

  it('injects azureSignOptions in the release workflow build step', () => {
    expect(workflow).toContain(
      '-c.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net'
    );
    expect(workflow).toContain(
      '-c.win.azureSignOptions.certificateProfileName=fcm-public-trust'
    );
    expect(workflow).toContain(
      '-c.win.azureSignOptions.codeSigningAccountName=fcm-trusted-signing'
    );
  });

  it('feeds the publisher name from the AZURE_PUBLISHER_NAME repo variable', () => {
    expect(workflow).toMatch(
      /-c\.win\.azureSignOptions\.publisherName=\$\{\{\s*vars\.AZURE_PUBLISHER_NAME\s*\}\}/
    );
  });

  it('passes the three EnvironmentCredential secrets to the signing build', () => {
    for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) {
      expect(workflow).toMatch(
        new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`)
      );
    }
  });

  it('provisions the .NET SDK (TrustedSigning module fetches the dlib via `dotnet tool install`)', () => {
    // Without dotnet on the runner, signing fails in NugetInstall.psm1 with
    // "Start-Process: cannot find the file specified". Guard the setup-dotnet step.
    expect(workflow).toMatch(/uses:\s*actions\/setup-dotnet@[0-9a-f]{40}/);
  });

  it('exposes the service-account signing module to child PowerShell processes', () => {
    expect(workflow).toContain("Join-Path $env:USERPROFILE 'Documents\\WindowsPowerShell\\Modules'");
    expect(workflow).toContain('$env:PSModulePath = "$moduleRoot;$env:PSModulePath"');
    expect(workflow).toContain("'Get-Command Invoke-TrustedSigning -ErrorAction Stop | Out-Null'");
  });

  it('does NOT put azureSignOptions in package.json (keeps the unsigned CI gate green)', () => {
    expect(pkg.build?.win?.azureSignOptions).toBeUndefined();
    // Belt-and-suspenders: the string must not appear anywhere in the build config.
    expect(JSON.stringify(pkg.build ?? {})).not.toContain('azureSignOptions');
  });
});
