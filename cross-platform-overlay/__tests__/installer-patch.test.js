// Guards for the installer-as-update-path (auto-update was removed; re-running
// the installer is now how users patch). Ensures:
//   1. the user-facing INSTALL-*.txt never re-introduce an "auto-update" claim,
//      and do describe the manual update/patch flow.
//   2. the installers' raw-filename convention stays in sync with `productName`
//      — a productName rename must not silently break the CLI installers /
//      release pipeline (they reconstruct download filenames from it).
//   3. the Linux .deb is bundled into the Linux ZIP + verified in release.ps1.
// vitest globals (describe/it/expect) enabled via vitest.config.ts (globals: true)
const fs = require('fs');
const path = require('path');

const overlayDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(overlayDir, '..');
const readOverlay = (p) => fs.readFileSync(path.join(overlayDir, p), 'utf8');
const readRepo = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

describe('INSTALL-*.txt — no stale auto-update claim, manual-update path documented', () => {
  for (const f of ['assets/install/INSTALL-WINDOWS.txt', 'assets/install/INSTALL-LINUX.txt']) {
    it(`${f} does not claim auto-update and explains manual patching`, () => {
      const txt = readOverlay(f).toLowerCase();
      expect(txt).not.toContain('auto-update');
      expect(txt).not.toContain('updates itself');
      expect(txt).not.toContain('do not need to reinstall');
      // The replacement: a manual "update available -> download from Nexus" flow.
      expect(txt).toContain('update');
      expect(txt).toContain('nexusmods.com/fallout76/mods/4082');
    });
  }
});

describe('installer filename convention stays in sync with productName', () => {
  const pkg = JSON.parse(readOverlay('package.json'));
  const productName = pkg.productName || (pkg.build && pkg.build.productName);

  it('productName is "Fallout Chat Mod" (installers + backend hardcode it)', () => {
    expect(productName).toBe('Fallout Chat Mod');
  });

  // Each installer/pipeline script reconstructs download filenames from the
  // productName; if someone renames it without updating these, this fails.
  for (const f of [
    'Packaging/windows/install.ps1',
    'Packaging/linux/install.sh',
    'Packaging/release.ps1',
    'Packaging/package-downloads.ps1',
  ]) {
    it(`${f} references productName "${productName}"`, () => {
      expect(readRepo(f)).toContain(productName);
    });
  }

  it('Linux .deb is bundled in the Linux ZIP and verified/uploaded in release.ps1', () => {
    expect(readRepo('Packaging/package-downloads.ps1')).toContain('$linuxDeb');
    const rel = readRepo('Packaging/release.ps1');
    expect(rel).toContain('$linuxDeb');
    expect(rel).toContain('Upload-Artifact $linuxDeb');
  });
});

describe('CLI installers — patch path is present', () => {
  it('both CLI installers query /api/releases and detect the installed version', () => {
    const ps = readRepo('Packaging/windows/install.ps1');
    const sh = readRepo('Packaging/linux/install.sh');
    for (const src of [ps, sh]) {
      expect(src).toContain('/api/releases');
    }
    // installed-version detection + prompt-when-current
    expect(ps).toContain('VersionInfo.ProductVersion');
    expect(ps).toContain('Read-Host');
    expect(sh).toContain('.fcm-version');
    expect(sh).toContain('/dev/tty');
  });
});
