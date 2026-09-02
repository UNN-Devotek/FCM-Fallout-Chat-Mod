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

describe('cross-version installer migration', () => {
  const ps = readRepo('Packaging/windows/install.ps1');
  const nsis = readOverlay('assets/install/installer.nsh');
  const sh = readRepo('Packaging/linux/install.sh');

  it('Windows stops and uninstalls the pre-rename per-user install', () => {
    expect(ps).toContain('Programs\\Fallout ChatMod\\Fallout ChatMod.exe');
    expect(nsis).toContain('Fallout ChatMod.exe');
    expect(nsis).toContain('Programs\\Fallout ChatMod\\Uninstall Fallout ChatMod.exe');
    expect(nsis).toContain('/S');
  });

  it('Linux removes only FCM-owned KWin rules before either package path', () => {
    expect(sh).toContain('KWIN_READ_BIN="kreadconfig6"');
    expect(sh).toContain('KWIN_READ_BIN="kreadconfig5"');
    expect(sh).toContain('Fallout\\ Chat\\ Mod*)');
    expect(sh).toContain('drop_groups=');
    expect(sh).toContain('preserved user-owned rules');
    expect(sh).toContain('chmod --reference="$rules_file" "$tmp_file"');
    expect(sh).toContain('chown --reference="$rules_file" "$tmp_file"');
    expect(sh).toContain('stop_processes_matching()');
    expect(sh).not.toContain('pkill -f');
    expect(sh).toContain('remove_fcm_kwin_rules');
    expect(sh).toContain('stop_running_overlay()');
    expect(sh).toContain('chmod +x "$TMP"\nstop_running_overlay\n# Migrate compositor state only after the replacement artifact is valid. This\n# is intentionally independent of current compositor detection: a KDE session\n# may retain stale FCM rules from an older production install.\nremove_fcm_kwin_rules\nmv -f "$TMP" "$APP_PATH"');
    const debStart = sh.indexOf('if [ "$DEB_SELECTED" -eq 1 ]');
    const debDownload = sh.indexOf('curl -fSL --progress-bar "$DEB_URL"', debStart);
    const debMigration = sh.indexOf('remove_fcm_kwin_rules', debStart);
    const debInstall = sh.indexOf('sudo apt-get install "$DEB_TMP"', debStart);
    expect(debMigration).toBeGreaterThan(debDownload);
    expect(debMigration).toBeLessThan(debInstall);
  });

  it('Linux .deb switching removes only the known old per-user AppImage launcher paths after success', () => {
    expect(sh).toContain('sudo apt-get install "$DEB_TMP"');
    expect(sh).toContain('rm -f "$APP_PATH" "$VERSION_MARKER" "$DESKTOP_FILE"');
  });

  it('Linux uninstaller can clean FCM rules with either KWin tool generation', () => {
    const uninstall = readRepo('Packaging/linux/uninstall.sh');
    expect(uninstall).toContain('KWIN_READ_BIN="kreadconfig6"');
    expect(uninstall).toContain('KWIN_READ_BIN="kreadconfig5"');
    expect(uninstall).toContain('"$KWIN_READ_BIN"');
    expect(uninstall).toContain('"$KWIN_WRITE_BIN"');
    expect(uninstall).toContain('Fallout Chat Mod"*)');
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

describe('Linux smart desktop detection is documented in every install surface', () => {
  const linuxZipInstructions = readOverlay('assets/install/INSTALL-LINUX.txt');
  const linuxCli = readRepo('Packaging/linux/install.sh');
  const runtimeHelper = readOverlay('main.js');

  for (const [label, text] of [
    ['website', readRepo('admin-dashboard/src/features/auth/LandingPage.tsx')],
    ['Linux ZIP', linuxZipInstructions],
    ['CLI installer', linuxCli],
    ['runtime helper', runtimeHelper],
  ]) {
    it(`${label} names the supported session/compositor paths`, () => {
      const lower = text.toLowerCase();
      expect(lower).toContain('hyprland');
      expect(lower).toContain('hyprctl');
      expect(lower).toContain('plain x11');
      expect(lower).toContain('game-running fallback');
    });
  }

  it('website HUD instructions are directly below the top HUD download', () => {
    const page = readRepo('admin-dashboard/src/features/auth/LandingPage.tsx');
    const hud = page.indexOf('Optional in-game HUD mod — keep the download visible at the top');
    const instructions = page.indexOf('STEP 1 — PREPARE', hud);
    const windows = page.indexOf('{/* ── Windows ─────────────────────────────────────────────────── */}');
    expect(hud).toBeGreaterThanOrEqual(0);
    expect(instructions).toBeGreaterThan(hud);
    expect(instructions).toBeLessThan(windows);
  });
});
