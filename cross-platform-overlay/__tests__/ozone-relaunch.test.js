// Unit tests for planOzoneRelaunch() — decides whether the overlay must relaunch
// itself with --ozone-platform=x11 to force XWayland on KDE+Wayland. Electron 38+
// reads the ozone platform from the real argv before main.js runs, so appendSwitch
// is too late; an argv relaunch is the only reliable force. See window-management.md.

import core from '../overlay-core.js';

const { planOzoneRelaunch } = core;
const FLAG = '--ozone-platform=x11';

describe('planOzoneRelaunch', () => {
  it('returns null on non-KDE-Wayland (X11/GNOME already work natively)', () => {
    expect(planOzoneRelaunch({ kdeWayland: false, argv: ['/app', '--no-sandbox'] })).toBeNull();
  });

  it('returns null when the flag is already on argv (this IS the relaunched process)', () => {
    expect(planOzoneRelaunch({ kdeWayland: true, argv: ['/app', '--no-sandbox', FLAG] })).toBeNull();
  });

  it('plans a relaunch with the flag appended to the app args (argv.slice(1))', () => {
    const plan = planOzoneRelaunch({ kdeWayland: true, argv: ['/app', '--no-sandbox', '%U'] });
    expect(plan).not.toBeNull();
    // argv[0] (exec path) is dropped — app.relaunch reuses execPath; args are the rest
    expect(plan.args).toEqual(['--no-sandbox', '%U', FLAG]);
    expect(plan.execPath).toBeUndefined(); // no AppImage → relaunch uses default execPath
  });

  it('targets $APPIMAGE as execPath when set (transient /tmp/.mount_* path is gone after exit)', () => {
    const plan = planOzoneRelaunch({
      kdeWayland: true,
      argv: ['/tmp/.mount_x/fallout-chat-mod', '--no-sandbox'],
      appImagePath: '/home/u/Applications/Fallout Chat Mod-1.3.91.AppImage',
    });
    expect(plan.args).toEqual(['--no-sandbox', FLAG]);
    expect(plan.execPath).toBe('/home/u/Applications/Fallout Chat Mod-1.3.91.AppImage');
  });

  it('does not append the flag twice across a (hypothetical) double call', () => {
    const first = planOzoneRelaunch({ kdeWayland: true, argv: ['/app'] });
    // simulate the relaunched process: argv now contains the planned args
    const childArgv = ['/app', ...first.args];
    expect(planOzoneRelaunch({ kdeWayland: true, argv: childArgv })).toBeNull();
  });

  // ── env hint (belt-and-suspenders XWayland force) ────────────────────────────

  it('always carries ELECTRON_OZONE_PLATFORM_HINT=x11 in the plan env', () => {
    const plan = planOzoneRelaunch({ kdeWayland: true, argv: ['/app'] });
    expect(plan.env).toEqual({ ELECTRON_OZONE_PLATFORM_HINT: 'x11' });
  });

  // ── re-exec safety (issue #272: "launches once, then shortcut does nothing") ──

  it('marks the relaunch SAFE for a normal (non-AppImage) install', () => {
    const plan = planOzoneRelaunch({ kdeWayland: true, argv: ['/usr/lib/fcm/fallout-chat-mod'], execPath: '/usr/lib/fcm/fallout-chat-mod' });
    expect(plan.safe).toBe(true);
  });

  it('marks the relaunch SAFE when $APPIMAGE is set even if execPath is a transient mount', () => {
    const plan = planOzoneRelaunch({
      kdeWayland: true,
      argv: ['/tmp/.mount_abc/fallout-chat-mod'],
      execPath: '/tmp/.mount_abc/fallout-chat-mod',
      appImagePath: '/home/u/Applications/Fallout Chat Mod.AppImage',
    });
    expect(plan.safe).toBe(true);
    expect(plan.execPath).toBe('/home/u/Applications/Fallout Chat Mod.AppImage');
  });

  it('marks the relaunch UNSAFE when execPath is a transient /tmp/.mount_* path and $APPIMAGE is unset', () => {
    // The doomed case: re-execing the mount, then app.exit(0) unmounts it → child dies.
    const plan = planOzoneRelaunch({
      kdeWayland: true,
      argv: ['/tmp/.mount_abc/fallout-chat-mod'],
      execPath: '/tmp/.mount_abc/fallout-chat-mod',
      appImagePath: null,
    });
    expect(plan.safe).toBe(false);
    expect(plan.execPath).toBeUndefined(); // caller falls back to process.execPath, but must NOT exit
  });
});
