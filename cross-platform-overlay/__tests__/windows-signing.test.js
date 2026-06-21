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

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const OVERLAY_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(OVERLAY_ROOT, '..');

const workflow = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'build-windows.yml'),
  'utf8'
);
const pkg = JSON.parse(readFileSync(join(OVERLAY_ROOT, 'package.json'), 'utf8'));

describe('Windows release code signing (Azure Trusted Signing)', () => {
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

  it('does NOT put azureSignOptions in package.json (keeps the unsigned CI gate green)', () => {
    expect(pkg.build?.win?.azureSignOptions).toBeUndefined();
    // Belt-and-suspenders: the string must not appear anywhere in the build config.
    expect(JSON.stringify(pkg.build ?? {})).not.toContain('azureSignOptions');
  });
});
