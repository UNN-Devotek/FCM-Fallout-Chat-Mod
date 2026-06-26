// Unit tests for the diagnostic-logging helpers in overlay-core:
//   resolveLogLevel({env,argv,settings}) — env/argv/settings → 'verbose' | 'info'
//   shouldRotateLog(size, cap)           — log-rotation threshold
// These back the leveled, rotating logger in main.js (diag/vdiag). Verbose is
// opt-in (FCM_DEBUG / --fcm-debug / Settings → Debug logging) so a normal user's
// main.log stays lean.

import core from '../overlay-core.js';

const { resolveLogLevel, shouldRotateLog } = core;

describe('resolveLogLevel', () => {
  it('defaults to info with no inputs', () => {
    expect(resolveLogLevel()).toBe('info');
    expect(resolveLogLevel({})).toBe('info');
    expect(resolveLogLevel({ env: {}, argv: [], settings: null })).toBe('info');
  });

  // ── env ──────────────────────────────────────────────────────────────────────

  it.each(['1', 'true', 'yes', 'on', 'verbose', 'debug', 'TRUE', ' On '])(
    'FCM_DEBUG=%s → verbose', (val) => {
      expect(resolveLogLevel({ env: { FCM_DEBUG: val } })).toBe('verbose');
    });

  it.each(['0', 'false', 'no', 'off', '', undefined])(
    'FCM_DEBUG=%s → info', (val) => {
      expect(resolveLogLevel({ env: { FCM_DEBUG: val } })).toBe('info');
    });

  it('FCM_VERBOSE is an accepted env alias', () => {
    expect(resolveLogLevel({ env: { FCM_VERBOSE: '1' } })).toBe('verbose');
    expect(resolveLogLevel({ env: { FCM_VERBOSE: '0' } })).toBe('info');
  });

  // ── argv (launch flags) ───────────────────────────────────────────────────────

  it('--fcm-debug launch flag → verbose', () => {
    expect(resolveLogLevel({ argv: ['/app', '--fcm-debug'] })).toBe('verbose');
  });

  it('--debug and --verbose are accepted aliases', () => {
    expect(resolveLogLevel({ argv: ['/app', '--debug'] })).toBe('verbose');
    expect(resolveLogLevel({ argv: ['/app', '--verbose'] })).toBe('verbose');
  });

  it('unrelated argv (e.g. the XWayland relaunch flag) does not enable verbose', () => {
    expect(resolveLogLevel({ argv: ['/app', '--ozone-platform=x11', '--no-sandbox'] })).toBe('info');
  });

  // ── settings (persisted tray toggle) ──────────────────────────────────────────

  it('settings.debugLogging===true → verbose; false/absent → info', () => {
    expect(resolveLogLevel({ settings: { debugLogging: true } })).toBe('verbose');
    expect(resolveLogLevel({ settings: { debugLogging: false } })).toBe('info');
    expect(resolveLogLevel({ settings: {} })).toBe('info');
  });

  // ── combinations / robustness ─────────────────────────────────────────────────

  it('any source enabling verbose wins (OR semantics)', () => {
    expect(resolveLogLevel({ env: { FCM_DEBUG: '0' }, settings: { debugLogging: true } })).toBe('verbose');
    expect(resolveLogLevel({ argv: ['/app', '--fcm-debug'], settings: { debugLogging: false } })).toBe('verbose');
  });

  it('tolerates malformed inputs without throwing', () => {
    expect(resolveLogLevel({ argv: 'not-an-array' })).toBe('info');
    expect(resolveLogLevel({ env: null, argv: null, settings: 'nope' })).toBe('info');
  });
});

describe('shouldRotateLog', () => {
  const CAP = 2 * 1024 * 1024;

  it('returns true when size exceeds the cap', () => {
    expect(shouldRotateLog(CAP + 1, CAP)).toBe(true);
    expect(shouldRotateLog(7_900_000, CAP)).toBe(true);
  });

  it('returns false at or below the cap', () => {
    expect(shouldRotateLog(CAP, CAP)).toBe(false); // exactly at cap → not yet
    expect(shouldRotateLog(CAP - 1, CAP)).toBe(false);
    expect(shouldRotateLog(0, CAP)).toBe(false);
  });

  it('returns false for non-numeric or non-positive inputs', () => {
    expect(shouldRotateLog(undefined, CAP)).toBe(false);
    expect(shouldRotateLog(CAP + 1, 0)).toBe(false);
    expect(shouldRotateLog(CAP + 1, -1)).toBe(false);
    expect(shouldRotateLog('big', CAP)).toBe(false);
    expect(shouldRotateLog(CAP + 1, null)).toBe(false);
  });
});
