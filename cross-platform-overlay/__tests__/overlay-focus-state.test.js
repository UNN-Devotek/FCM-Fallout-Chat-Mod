// Unit tests for the game-focus hysteresis reducer (nextGameFocusState) and
// isOverlayClass. Mirrors nextPresenceState's describe/it structure in
// overlay-core-visibility.test.js: consecutive samples, independent enter/leave
// thresholds, and an unambiguous game-not-running short-circuit.

import core from '../overlay-core.js';

const { nextGameFocusState, isOverlayClass } = core;

describe('isOverlayClass', () => {
  it('matches the KWin keep-above wmclass (case-insensitive)', () => {
    expect(isOverlayClass('fallout-chat-mod')).toBe(true);
    expect(isOverlayClass('FALLOUT-CHAT-MOD')).toBe(true);
    expect(isOverlayClass('Fallout-Chat-Mod')).toBe(true);
  });

  it('does NOT match the XWayland product-name class or the game', () => {
    expect(isOverlayClass('fallout chat mod')).toBe(false);
    expect(isOverlayClass('Fallout76')).toBe(false);
    expect(isOverlayClass('firefox')).toBe(false);
  });

  it('is null/undefined/empty-safe like isGameClass', () => {
    expect(isOverlayClass('')).toBe(false);
    expect(isOverlayClass(null)).toBe(false);
    expect(isOverlayClass(undefined)).toBe(false);
  });
});

describe('nextGameFocusState', () => {
  it('!gameRunning commits unfocused immediately, regardless of other inputs', () => {
    const expected = { candidate: null, stableCount: 0, commit: true, gameFocused: false };
    expect(nextGameFocusState({
      gameRunning: false, overlayFocused: true, activeClass: 'Fallout76',
      candidate: true, stableCount: 4,
    })).toEqual(expected);
    expect(nextGameFocusState({
      gameRunning: false, overlayFocused: false, activeClass: 'firefox',
    })).toEqual(expected);
    expect(nextGameFocusState({ gameRunning: 0, overlayFocused: true })).toEqual(expected);
  });

  it('overlayFocused:true while gameRunning:true commits gameFocused:true on the first default call', () => {
    const r = nextGameFocusState({ gameRunning: true, overlayFocused: true });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
  });

  it('isOverlayClass(activeClass) alone (overlayFocused false/undefined) commits focused', () => {
    expect(nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'fallout-chat-mod',
    })).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
    expect(nextGameFocusState({
      gameRunning: true, activeClass: 'FALLOUT-CHAT-MOD',
    })).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
  });

  it('isGameClass(activeClass) commits focused', () => {
    expect(nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'Fallout76',
    })).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
    expect(nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'fallout76.exe',
    })).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
    expect(nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'steam_app_1151340',
    })).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
  });

  it('unknown/empty activeClass while gameRunning:true counts as focused (fullscreen FO76)', () => {
    expect(nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: '(null)',
    })).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
    expect(nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: '',
    })).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
  });

  it('a recognized OTHER class needs leaveScans consecutive samples before committing unfocused', () => {
    // 1st firefox sample: pending, not yet committed (leaveScans defaults to 2).
    let r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: null, stableCount: 0,
    });
    expect(r.commit).toBe(false);
    expect(r.candidate).toBe(false);
    expect(r.stableCount).toBe(1);
    // 2nd consecutive other-class sample → commit unfocused.
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: r.candidate, stableCount: r.stableCount,
    });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: false });
  });

  it('enterScans / leaveScans are independently configurable (asymmetric timing)', () => {
    const E = 3, L = 1; // slow to enter, instant leave
    // Enter: 2 hits is still short of E=3.
    let r = nextGameFocusState({
      gameRunning: true, overlayFocused: true, candidate: null, stableCount: 0,
      enterScans: E, leaveScans: L,
    });
    expect(r).toEqual({ candidate: true, stableCount: 1, commit: false, gameFocused: false });
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: true, candidate: r.candidate, stableCount: r.stableCount,
      enterScans: E, leaveScans: L,
    });
    expect(r.commit).toBe(false); expect(r.stableCount).toBe(2);
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: true, candidate: r.candidate, stableCount: r.stableCount,
      enterScans: E, leaveScans: L,
    });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });

    // Leave: L=1 so a single other-class sample commits unfocused.
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: null, stableCount: 0, enterScans: E, leaveScans: L,
    });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: false });

    // And the inverse: enterScans=1 (instant), leaveScans=4 (held).
    const E2 = 1, L2 = 4;
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: true, candidate: null, stableCount: 0,
      enterScans: E2, leaveScans: L2,
    });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: null, stableCount: 0, enterScans: E2, leaveScans: L2,
    });
    expect(r.commit).toBe(false); expect(r.stableCount).toBe(1);
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: r.candidate, stableCount: r.stableCount, enterScans: E2, leaveScans: L2,
    });
    expect(r.commit).toBe(false); expect(r.stableCount).toBe(2);
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: r.candidate, stableCount: r.stableCount, enterScans: E2, leaveScans: L2,
    });
    expect(r.commit).toBe(false); expect(r.stableCount).toBe(3);
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: r.candidate, stableCount: r.stableCount, enterScans: E2, leaveScans: L2,
    });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: false });
  });

  it('a flip-flop resets the counter (must be CONSECUTIVE)', () => {
    // other-class, then game (enterScans=1 commits focused, resets pending), then other-class again → counter restarts at 1.
    let r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: null, stableCount: 0,
    });
    expect(r.stableCount).toBe(1); expect(r.commit).toBe(false);
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'Fallout76',
      candidate: r.candidate, stableCount: r.stableCount,
    });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameFocused: true });
    r = nextGameFocusState({
      gameRunning: true, overlayFocused: false, activeClass: 'firefox',
      candidate: r.candidate, stableCount: r.stableCount,
    });
    expect(r.stableCount).toBe(1); // restarts, not 2
    expect(r.commit).toBe(false);
  });

  it('missing args treat the game as not running (unfocused commit), a sane default', () => {
    const expected = { candidate: null, stableCount: 0, commit: true, gameFocused: false };
    expect(nextGameFocusState()).toEqual(expected);
    expect(nextGameFocusState({})).toEqual(expected);
  });
});
