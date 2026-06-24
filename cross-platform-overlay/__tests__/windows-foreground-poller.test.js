// Unit tests for the Windows foreground-poller resilience helpers added to
// overlay-core for issue #136 (keybinds fire when FCM is not foreground).
//
// Background: on Windows the global hotkeys are released whenever neither FO76 nor
// the overlay is the foreground window. That release is driven by a single
// long-lived `powershell.exe` foreground poller. The old code nulled the handle on
// death with no restart, no watchdog, and no log — so if the poller died (or never
// started: PowerShell Constrained Language Mode blocks `Add-Type`, AppLocker/AV can
// block powershell.exe) the last-known foreground (the game, while keys were
// registered) froze and the hotkeys stayed registered globally and fired in every
// app. These pure helpers back the self-heal (restart-with-backoff), the fail-safe
// watchdog (release keys when the poller goes silent), and the diagnostic logging.

import core from '../overlay-core.js';

const { nextPollerBackoffMs, isForegroundStale, classifyPollerExit } = core;

describe('nextPollerBackoffMs', () => {
  it('ramps 1s → 2s → 5s for the first three restarts', () => {
    expect(nextPollerBackoffMs(0)).toBe(1000);
    expect(nextPollerBackoffMs(1)).toBe(2000);
    expect(nextPollerBackoffMs(2)).toBe(5000);
  });

  it('caps at 5s for any further restarts (never unbounded)', () => {
    expect(nextPollerBackoffMs(3)).toBe(5000);
    expect(nextPollerBackoffMs(10)).toBe(5000);
    expect(nextPollerBackoffMs(9999)).toBe(5000);
  });

  it('treats negative / NaN / non-integer counts as the first restart', () => {
    expect(nextPollerBackoffMs(-1)).toBe(1000);
    expect(nextPollerBackoffMs(NaN)).toBe(1000);
    expect(nextPollerBackoffMs(undefined)).toBe(1000);
    expect(nextPollerBackoffMs(1.9)).toBe(2000); // floored to 1
  });
});

describe('isForegroundStale', () => {
  const staleMs = 4000;

  it('is NOT stale while fresh foreground lines keep arriving', () => {
    expect(isForegroundStale({ lastLineAt: 10_000, now: 11_000, staleMs })).toBe(false);
    expect(isForegroundStale({ lastLineAt: 10_000, now: 14_000, staleMs })).toBe(false); // exactly at threshold
  });

  it('is stale once no line has arrived for longer than staleMs (fail closed)', () => {
    expect(isForegroundStale({ lastLineAt: 10_000, now: 14_001, staleMs })).toBe(true);
    expect(isForegroundStale({ lastLineAt: 10_000, now: 99_999, staleMs })).toBe(true);
  });

  it('treats a never-seen line (lastLineAt 0/null) as stale when enough time has passed', () => {
    expect(isForegroundStale({ lastLineAt: 0, now: 5000, staleMs })).toBe(true);
    expect(isForegroundStale({ lastLineAt: null, now: 5000, staleMs })).toBe(true);
  });

  it('refuses to trip on invalid inputs (no now / no staleMs / non-positive staleMs)', () => {
    expect(isForegroundStale({ lastLineAt: 0, staleMs })).toBe(false);
    expect(isForegroundStale({ lastLineAt: 0, now: 5000 })).toBe(false);
    expect(isForegroundStale({ lastLineAt: 0, now: 5000, staleMs: 0 })).toBe(false);
    expect(isForegroundStale({ lastLineAt: 0, now: 5000, staleMs: -1 })).toBe(false);
    expect(isForegroundStale()).toBe(false);
  });
});

describe('classifyPollerExit', () => {
  it('flags a fast exit that never emitted a line as blocked-or-clm (the CLM/AppLocker signature)', () => {
    expect(classifyPollerExit({ msSinceStart: 50, everEmitted: false })).toBe('blocked-or-clm');
    expect(classifyPollerExit({ msSinceStart: 1499, everEmitted: false })).toBe('blocked-or-clm');
  });

  it('treats an exit AFTER emitting output as a normal crash (poller had been working)', () => {
    expect(classifyPollerExit({ msSinceStart: 50, everEmitted: true })).toBe('crashed');
    expect(classifyPollerExit({ msSinceStart: 999_999, everEmitted: true })).toBe('crashed');
  });

  it('treats a slow exit with no output as a crash, not a blocked launch', () => {
    expect(classifyPollerExit({ msSinceStart: 1500, everEmitted: false })).toBe('crashed');
    expect(classifyPollerExit({ msSinceStart: 60_000, everEmitted: false })).toBe('crashed');
  });

  it('respects a custom quickExitMs threshold', () => {
    expect(classifyPollerExit({ msSinceStart: 200, everEmitted: false, quickExitMs: 100 })).toBe('crashed');
    expect(classifyPollerExit({ msSinceStart: 50, everEmitted: false, quickExitMs: 100 })).toBe('blocked-or-clm');
  });

  it('tolerates being called with no argument (defaults to crashed)', () => {
    expect(classifyPollerExit()).toBe('crashed');
  });
});
