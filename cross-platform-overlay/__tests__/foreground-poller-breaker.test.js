// Unit tests for the KDE-Wayland active-window poll circuit-breaker
// (decideForegroundPollerAction) added to overlay-core.
//
// Background: on some distros (confirmed Fedora 44, xdotool 3.x) the chained
// `xdotool getactivewindow getwindowclassname` aborts inside libxdo
// (xdo_get_window_classname → XFree → SIGABRT) whenever the active window's
// WM_CLASS can't be read. The overlay polls every ~300ms, so re-spawning into the
// crash produces a coredump storm (issue #272). The breaker trips after
// MAX_CONSEC_CRASHES back-to-back signal deaths and either switches to the
// alternate tool (kdotool↔xdotool, if installed) or disables detection entirely.

import core from '../overlay-core.js';

const { decideForegroundPollerAction } = core;

describe('decideForegroundPollerAction', () => {
  // ── clean exits never trip the breaker ──────────────────────────────────────

  it('returns "continue" on a clean exit (crashed=false), even at a high crash count', () => {
    // A non-zero xdotool exit with NO signal (no active X window) is NOT a crash;
    // the caller passes crashed=false for it.
    expect(decideForegroundPollerAction({ crashed: false, consecutiveCrashes: 99, maxCrashes: 3, hasAltTool: true })).toBe('continue');
  });

  it('returns "continue" on a clean exit with zero crashes', () => {
    expect(decideForegroundPollerAction({ crashed: false, consecutiveCrashes: 0, maxCrashes: 3, hasAltTool: false })).toBe('continue');
  });

  // ── below threshold: keep polling ───────────────────────────────────────────

  it('returns "continue" while crashes are below the threshold', () => {
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 1, maxCrashes: 3, hasAltTool: false })).toBe('continue');
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 2, maxCrashes: 3, hasAltTool: true })).toBe('continue');
  });

  // ── at/above threshold: trip ────────────────────────────────────────────────

  it('returns "switch-tool" at the threshold when an alternate tool is available', () => {
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 3, maxCrashes: 3, hasAltTool: true })).toBe('switch-tool');
  });

  it('returns "disable" at the threshold when no alternate tool is available', () => {
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 3, maxCrashes: 3, hasAltTool: false })).toBe('disable');
  });

  it('keeps tripping above the threshold (idempotent decision)', () => {
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 7, maxCrashes: 3, hasAltTool: true })).toBe('switch-tool');
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 7, maxCrashes: 3, hasAltTool: false })).toBe('disable');
  });

  // ── defaults ────────────────────────────────────────────────────────────────

  it('defaults maxCrashes to 3 and hasAltTool to false', () => {
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 2 })).toBe('continue');
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 3 })).toBe('disable');
  });

  it('tolerates being called with no argument', () => {
    expect(decideForegroundPollerAction()).toBe('continue');
  });

  // ── threshold boundary ──────────────────────────────────────────────────────

  it('respects a custom threshold', () => {
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 1, maxCrashes: 2, hasAltTool: false })).toBe('continue');
    expect(decideForegroundPollerAction({ crashed: true, consecutiveCrashes: 2, maxCrashes: 2, hasAltTool: false })).toBe('disable');
  });
});

// ── integration shape: drive the same loop main.js uses ───────────────────────
// These tests document how the breaker is wired into _startForegroundPoller():
// a `tried` set prevents ping-ponging, a clean exit resets the streak, and the
// terminal outcomes are exactly "switch then disable" or "disable".

describe('breaker loop (as wired in _startForegroundPoller)', () => {
  // Mirror of the main.js close-handler decision loop, kept tiny + pure so we can
  // assert the end-to-end behavior without an Electron runtime or real spawns.
  function simulate(events, { available, maxCrashes = 3 } = {}) {
    let fgTool = available[0];
    const tried = new Set([fgTool]);
    let consecutiveCrashes = 0;
    let disabled = false;
    const switches = [];
    for (const ev of events) {
      if (disabled) break;
      if (!ev.crash) { consecutiveCrashes = 0; continue; } // clean exit resets streak
      consecutiveCrashes += 1;
      const untried = available.filter((t) => !tried.has(t));
      const action = decideForegroundPollerAction({
        crashed: true, consecutiveCrashes, maxCrashes, hasAltTool: untried.length > 0,
      });
      if (action === 'switch-tool') {
        fgTool = untried[0];
        tried.add(fgTool);
        switches.push(fgTool);
        consecutiveCrashes = 0; // fresh poller for the new tool
      } else if (action === 'disable') {
        disabled = true;
      }
    }
    return { fgTool, switches, disabled, consecutiveCrashes };
  }

  it('xdotool always crashes, kdotool installed → switch to kdotool, then disable when it also crashes', () => {
    const crashes = Array.from({ length: 10 }, () => ({ crash: true }));
    const r = simulate(crashes, { available: ['xdotool', 'kdotool'] });
    expect(r.switches).toEqual(['kdotool']); // switched exactly once, never back
    expect(r.fgTool).toBe('kdotool');
    expect(r.disabled).toBe(true); // kdotool also crashed → disabled
  });

  it('xdotool always crashes, no kdotool → disable, never switch', () => {
    const crashes = Array.from({ length: 10 }, () => ({ crash: true }));
    const r = simulate(crashes, { available: ['xdotool'] });
    expect(r.switches).toEqual([]);
    expect(r.disabled).toBe(true);
    expect(r.fgTool).toBe('xdotool');
  });

  it('intermittent crashes that never hit 3-in-a-row never trip the breaker', () => {
    // crash, crash, clean, crash, clean, crash, crash — max streak is 2.
    const events = [
      { crash: true }, { crash: true }, { crash: false },
      { crash: true }, { crash: false }, { crash: true }, { crash: true },
    ];
    const r = simulate(events, { available: ['xdotool', 'kdotool'] });
    expect(r.disabled).toBe(false);
    expect(r.switches).toEqual([]);
    expect(r.fgTool).toBe('xdotool');
  });

  it('a clean exit resets the streak so it takes a fresh 3-in-a-row to trip', () => {
    const events = [
      { crash: true }, { crash: true }, { crash: false }, // streak reset here
      { crash: true }, { crash: true }, { crash: true },  // now 3-in-a-row
    ];
    const r = simulate(events, { available: ['xdotool'] });
    expect(r.disabled).toBe(true);
  });
});
