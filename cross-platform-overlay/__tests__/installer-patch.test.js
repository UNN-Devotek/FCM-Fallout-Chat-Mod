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

describe('install.sh hardening — regression guards for e2e-found bugs', () => {
  const sh = readRepo('Packaging/linux/install.sh');

  // Bug 1: `grep -o '"version":"…"' | head -n1 | sed …` SIGPIPEs grep on the now-large
  // /api/releases payload and, under `set -e -o pipefail`, intermittently aborts the
  // installer at version lookup (flaky 141). It must read all matches then pick the first
  // in pure bash (no early pipe close).
  it('parses the version without a SIGPIPE-prone `grep | head`', () => {
    expect(sh).not.toContain(`grep -o '"version":"[^"]*"' | head`);
    expect(sh).toContain('VERSION_MATCHES=');
  });

  // Bug 2: `[ -r /dev/tty ]` passes even with no controlling terminal, then the open
  // fails with ENXIO and aborts under `set -e`. Must probe by actually opening /dev/tty.
  it('detects a usable controlling terminal by opening /dev/tty (not a bare -r test)', () => {
    expect(sh).toContain('if { : >/dev/tty; } 2>/dev/null; then');
    // the buggy condition must not be used (the explanatory comment may still name it)
    expect(sh).not.toContain('if [ -r /dev/tty ]');
  });
});

describe('install.sh — system-aware Linux install policy', () => {
  const sh = readRepo('Packaging/linux/install.sh');

  it('exposes explicit format selection and a network-free plan mode', () => {
    expect(sh).toContain('--format=auto|--format=appimage|--format=deb');
    expect(sh).toContain('--print-plan');
    expect(sh).toContain('exit 0');
  });

  it('falls back to extract-and-run when FUSE2 is unavailable', () => {
    expect(sh).toContain('FUSE2_AVAILABLE=0');
    expect(sh).toContain('APPIMAGE_EXEC_ARGS="--appimage-extract-and-run"');
    expect(sh).toContain('DESKTOP_EXEC=');
  });

  it('limits native package installation to Debian systems with apt-get', () => {
    expect(sh).toContain('DISTRO_FAMILY="debian"');
    expect(sh).toContain('has_command apt-get || die "--format deb requires apt-get');
    expect(sh).toContain('sudo apt-get install "$DEB_TMP"');
    expect(sh).not.toContain('sudo apt-get install -y');
  });

  it('detects compositor and Proton helper capabilities without installing them', () => {
    expect(sh).toContain('HYPRCTL_AVAILABLE=0');
    expect(sh).toContain('KWIN_TOOLS_AVAILABLE=0');
    expect(sh).toContain('PROTONTRICKS_AVAILABLE=0');
    expect(sh).toContain('has_command protontricks');
    expect(sh).not.toContain('apt-get install -y protontricks');
    expect(sh).not.toContain('sudo dnf install -y kdotool');
  });
});
