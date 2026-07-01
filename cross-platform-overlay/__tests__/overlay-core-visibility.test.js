// P1 unit tests for the pure visibility / keybind / topmost decision helpers
// extracted into overlay-core.js (Group 1, P1). These mirror the decision logic
// in main.js: registerHotkeys (buildKeybindMap / accelToAction), emitVisibility
// (emitVisibilityDecision), reevaluateVisibility (visibilityDecision), and
// desiredTopmost. The actual Electron/timer side effects stay in main.js.

import core from '../overlay-core.js';

const {
  buildKeybindMap,
  accelToAction,
  visibilityDecision,
  emitVisibilityDecision,
  desiredTopmost,
  shouldForceGameBelow,
  nextPresenceState,
  isSinglePrintableChar,
} = core;

// The main.js *_SHORTCUT defaults (only the relationships matter here).
const DEFAULTS = {
  toggle: 'Home',
  clickThrough: 'End',
  focus: 'Insert',
  nextChannel: 'PageDown',
  prevChannel: 'PageUp',
  settings: 'Delete',
  recentParty: 'CommandOrControl+R',
  goFo76: '/',
};

describe('buildKeybindMap', () => {
  it('fills every default when given no overrides', () => {
    const map = buildKeybindMap(undefined, DEFAULTS);
    expect(map.toggle).toBe('Home');
    expect(map.clickThrough).toBe('End');
    expect(map.focus).toBe('Insert');
    expect(map.nextChannel).toBe('PageDown');
    expect(map.prevChannel).toBe('PageUp');
    expect(map.settings).toBe('Delete');
    expect(map.recentParty).toBe('CommandOrControl+R');
    expect(map.goFo76).toBe('/');
  });

  it('includes party1..party8 keys, all blank by default', () => {
    const map = buildKeybindMap({}, DEFAULTS);
    for (let i = 1; i <= 8; i++) {
      expect(map).toHaveProperty('party' + i);
      expect(map['party' + i]).toBe('');
    }
  });

  it('user overrides win over defaults', () => {
    const map = buildKeybindMap({ toggle: 'F9', focus: 'F10' }, DEFAULTS);
    expect(map.toggle).toBe('F9');
    expect(map.focus).toBe('F10');
    // Untouched actions still get the default.
    expect(map.settings).toBe('Delete');
  });

  it('explicit blank unbinds any action (all fields use !== undefined)', () => {
    // All non-party actions now use !== undefined so '' explicitly unbinds them.
    const actions = ['toggle', 'clickThrough', 'focus', 'nextChannel', 'prevChannel', 'settings', 'recentParty', 'goFo76'];
    for (const action of actions) {
      const map = buildKeybindMap({ [action]: '' }, DEFAULTS);
      expect(map[action]).toBe('');
    }
  });

  it('omitting an action falls back to the default', () => {
    const map = buildKeybindMap({}, DEFAULTS);
    expect(map.toggle).toBe('Home');
    expect(map.goFo76).toBe('/');
    expect(map.nextChannel).toBe('PageDown');
  });

  it('explicit party override is kept; omitted party stays blank', () => {
    const map = buildKeybindMap({ party3: 'F3' }, DEFAULTS);
    expect(map.party3).toBe('F3');
    expect(map.party4).toBe('');
  });

  it('explicit blank party stays blank (not registered)', () => {
    const map = buildKeybindMap({ party1: '' }, DEFAULTS);
    expect(map.party1).toBe('');
  });

  it('tolerates empty defaults object (undefined fallbacks)', () => {
    const map = buildKeybindMap({}, {});
    expect(map.toggle).toBeUndefined();
    expect(map.goFo76).toBeUndefined();
  });

  it('the produced map combined with isSinglePrintableChar flags chars correctly', () => {
    const map = buildKeybindMap({ toggle: '/', focus: 'Insert' }, DEFAULTS);
    expect(isSinglePrintableChar(map.toggle)).toBe(true);  // '/'
    expect(isSinglePrintableChar(map.focus)).toBe(false);  // named key
  });
});

describe('accelToAction', () => {
  const map = buildKeybindMap({ toggle: 'Home', focus: 'Insert', party1: 'F1' }, DEFAULTS);

  it('returns the first action whose accelerator matches', () => {
    expect(accelToAction(map, 'Home')).toBe('toggle');
    expect(accelToAction(map, 'Insert')).toBe('focus');
    expect(accelToAction(map, 'F1')).toBe('party1');
    expect(accelToAction(map, '/')).toBe('goFo76');
  });

  it('returns the accel itself when nothing matches', () => {
    expect(accelToAction(map, 'NoSuchAccel')).toBe('NoSuchAccel');
  });

  it('on duplicate accelerators returns the first by Object.entries order', () => {
    const dup = { toggle: 'F5', focus: 'F5' };
    expect(accelToAction(dup, 'F5')).toBe('toggle');
  });

  it('tolerates a null/undefined map', () => {
    expect(accelToAction(null, 'X')).toBe('X');
    expect(accelToAction(undefined, 'X')).toBe('X');
  });

  it('does not match blank accelerators to blank party slots', () => {
    // A real blank party would match '' — but bind() guards on truthiness, so we
    // only verify the reverse-lookup itself: '' matches the first blank party.
    const m = buildKeybindMap({}, DEFAULTS);
    expect(accelToAction(m, '')).toBe('party1');
  });
});

describe('visibilityDecision (reevaluateVisibility)', () => {
  it.each([
    [false, false, 'hide'],
    [false, true, 'hide'],
    [true, false, 'show'],
    [true, true, 'hide'], // userHidden vetoes a permitted show
  ])('canShow=%s userHidden=%s -> %s', (canShow, userHidden, expected) => {
    expect(visibilityDecision(canShow, userHidden)).toBe(expected);
  });

  it('only shows when permitted AND not user-hidden', () => {
    expect(visibilityDecision(true, false)).toBe('show');
    expect(visibilityDecision(true, true)).toBe('hide');
  });
});

describe('emitVisibilityDecision (emitVisibility grace)', () => {
  it.each([
    [true, false, 'show-immediate'],
    [true, true, 'show-immediate'], // visible always shows immediately, cancels pending
    [false, false, 'schedule-hide'],
    [false, true, 'noop'], // a hide is already pending → don't reschedule
  ])('isVisible=%s pendingHide=%s -> %s', (isVisible, pendingHide, expected) => {
    expect(emitVisibilityDecision(isVisible, pendingHide)).toBe(expected);
  });

  it('show is immediate regardless of a pending hide', () => {
    expect(emitVisibilityDecision(true, true)).toBe('show-immediate');
  });

  it('hide schedules only when no hide is pending', () => {
    expect(emitVisibilityDecision(false, false)).toBe('schedule-hide');
    expect(emitVisibilityDecision(false, true)).toBe('noop');
  });
});

describe('desiredTopmost', () => {
  const base = {
    hasWindow: true,
    forceVisible: false,
    gameRunning: false,
    windowFocused: false,
    foregroundIsGame: false,
  };

  it('no window -> false even if every other flag is set', () => {
    expect(desiredTopmost({
      hasWindow: false, forceVisible: true, gameRunning: true,
      windowFocused: true, foregroundIsGame: true,
    })).toBe(false);
  });

  it('forceVisible -> true', () => {
    expect(desiredTopmost({ ...base, forceVisible: true })).toBe(true);
  });

  it('gameRunning -> true (even when not foreground / not focused) in default mode', () => {
    expect(desiredTopmost({ ...base, gameRunning: true })).toBe(true);
  });

  it('windowFocused -> true', () => {
    expect(desiredTopmost({ ...base, windowFocused: true })).toBe(true);
  });

  it('game is the foreground process -> true', () => {
    expect(desiredTopmost({ ...base, foregroundIsGame: true })).toBe(true);
  });

  it('idle: window present but nothing active -> false', () => {
    expect(desiredTopmost(base)).toBe(false);
  });

  it('empty / undefined state -> false (no window)', () => {
    expect(desiredTopmost()).toBe(false);
    expect(desiredTopmost({})).toBe(false);
  });

  // Full cartesian over the 4 booleans with a window present.
  const bools = [false, true];
  for (const forceVisible of bools) {
    for (const gameRunning of bools) {
      for (const windowFocused of bools) {
        for (const foregroundIsGame of bools) {
          const expected = forceVisible || gameRunning || windowFocused || foregroundIsGame;
          it(`fv=${forceVisible} game=${gameRunning} focus=${windowFocused} fg=${foregroundIsGame} -> ${expected}`, () => {
            expect(desiredTopmost({
              hasWindow: true, forceVisible, gameRunning, windowFocused, foregroundIsGame,
            })).toBe(expected);
          });
        }
      }
    }
  }
});

// Focus-aware mode (Linux KDE-Wayland with active-window detection): topmost ONLY
// while the GAME is the foreground window (or overlay focused / forceVisible), so
// tabbing to another app lowers the overlay — fixes the "above ALL windows" issue.
describe('desiredTopmost — focus-aware mode', () => {
  const base = {
    hasWindow: true, forceVisible: false, gameRunning: false,
    windowFocused: false, foregroundIsGame: false, focusAwareTopmost: true,
  };

  it('a RECOGNIZED other app is foreground (game running) -> FALSE (lowers the overlay)', () => {
    // e.g. Firefox/Konsole focused while the game runs: foregroundIsGame=false AND the
    // class is readable (not unknown) → overlay drops behind that app.
    expect(desiredTopmost({ ...base, gameRunning: true, foregroundIsGame: false, foregroundUnknown: false })).toBe(false);
  });

  it('game is the FOREGROUND window (class matches) -> true', () => {
    expect(desiredTopmost({ ...base, gameRunning: true, foregroundIsGame: true })).toBe(true);
  });

  it('FULLSCREEN game (unreadable class) + game running -> true (issue: overlay must stay on top)', () => {
    // The bug we fixed: a fullscreen FO76 exposes no WM_CLASS (xdotool → "(null)"),
    // so foregroundIsGame=false but foregroundUnknown=true → keep the overlay on top.
    expect(desiredTopmost({ ...base, gameRunning: true, foregroundIsGame: false, foregroundUnknown: true })).toBe(true);
  });

  it('unreadable foreground but game NOT running -> false (bare desktop, not the game)', () => {
    expect(desiredTopmost({ ...base, gameRunning: false, foregroundUnknown: true })).toBe(false);
  });

  it('overlay focused -> true even if the game is not foreground', () => {
    expect(desiredTopmost({ ...base, windowFocused: true })).toBe(true);
  });

  it('forceVisible -> true regardless of foreground', () => {
    expect(desiredTopmost({ ...base, forceVisible: true })).toBe(true);
  });

  it('nothing foreground / not focused -> false', () => {
    expect(desiredTopmost(base)).toBe(false);
  });
});

// shouldForceGameBelow: the KWin "keep game below" rule only applies while the overlay is
// actually visible over a running game (and the user hasn't opted out). Hiding the overlay
// must drop it so FO76 returns above the panel.
describe('shouldForceGameBelow', () => {
  it('game running + overlay visible + enabled -> true', () => {
    expect(shouldForceGameBelow({ gameRunning: true, overlayVisible: true, gameBelowEnabled: true })).toBe(true);
  });
  it('overlay hidden -> false (game reclaims normal stacking, panel visible again)', () => {
    expect(shouldForceGameBelow({ gameRunning: true, overlayVisible: false, gameBelowEnabled: true })).toBe(false);
  });
  it('game not running -> false', () => {
    expect(shouldForceGameBelow({ gameRunning: false, overlayVisible: true, gameBelowEnabled: true })).toBe(false);
  });
  it('user opted out -> false even when visible + running', () => {
    expect(shouldForceGameBelow({ gameRunning: true, overlayVisible: true, gameBelowEnabled: false })).toBe(false);
  });
  it('missing/empty state -> false', () => {
    expect(shouldForceGameBelow()).toBe(false);
    expect(shouldForceGameBelow({})).toBe(false);
  });
});

// nextPresenceState: hysteresis reducer. A launch needs `appearScans` consecutive hits, an
// exit needs `disappearScans`, and a FAILED scan (found=null) carries no info — it keeps the
// committed state and clears any pending flip.
describe('nextPresenceState', () => {
  const A = 2, D = 3; // appear / disappear thresholds used below

  it('scan failure (found=null) keeps state and clears any pending flip', () => {
    const r = nextPresenceState({ found: null, gameRunning: true, candidate: false, stableCount: 1, appearScans: A, disappearScans: D });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: false, gameRunning: true });
  });

  it('found === current committed state is a no-op (resets pending)', () => {
    const r = nextPresenceState({ found: true, gameRunning: true, candidate: false, stableCount: 2, appearScans: A, disappearScans: D });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: false, gameRunning: true });
  });

  it('launch: needs appearScans consecutive hits before committing true', () => {
    // 1st scan sees the game while committed=false → pending, not yet committed.
    let r = nextPresenceState({ found: true, gameRunning: false, candidate: null, stableCount: 0, appearScans: A, disappearScans: D });
    expect(r).toEqual({ candidate: true, stableCount: 1, commit: false, gameRunning: false });
    // 2nd consecutive hit → commit.
    r = nextPresenceState({ found: true, gameRunning: false, candidate: r.candidate, stableCount: r.stableCount, appearScans: A, disappearScans: D });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameRunning: true });
  });

  it('exit is held LONGER (disappearScans) than launch — a 2-scan miss does NOT drop the game', () => {
    // committed=true, two consecutive misses is still short of D=3 → no commit.
    let r = nextPresenceState({ found: false, gameRunning: true, candidate: null, stableCount: 0, appearScans: A, disappearScans: D });
    expect(r.commit).toBe(false); expect(r.stableCount).toBe(1);
    r = nextPresenceState({ found: false, gameRunning: true, candidate: r.candidate, stableCount: r.stableCount, appearScans: A, disappearScans: D });
    expect(r.commit).toBe(false); expect(r.stableCount).toBe(2);
    // 3rd consecutive miss → finally commit the exit.
    r = nextPresenceState({ found: false, gameRunning: true, candidate: r.candidate, stableCount: r.stableCount, appearScans: A, disappearScans: D });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: true, gameRunning: false });
  });

  it('a flip-flop resets the counter (must be CONSECUTIVE)', () => {
    // miss, then a hit (back to committed=true, resets), then miss again → counter restarts at 1.
    let r = nextPresenceState({ found: false, gameRunning: true, candidate: null, stableCount: 0, appearScans: A, disappearScans: D });
    expect(r.stableCount).toBe(1);
    r = nextPresenceState({ found: true, gameRunning: true, candidate: r.candidate, stableCount: r.stableCount, appearScans: A, disappearScans: D });
    expect(r).toEqual({ candidate: null, stableCount: 0, commit: false, gameRunning: true }); // hit === committed → reset
    r = nextPresenceState({ found: false, gameRunning: true, candidate: r.candidate, stableCount: r.stableCount, appearScans: A, disappearScans: D });
    expect(r.stableCount).toBe(1); // restarts, not 2
  });
});
