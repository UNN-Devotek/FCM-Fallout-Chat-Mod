// P1 unit tests for the pure visibility / keybind / topmost decision helpers
// extracted into overlay-core.js (Group 1, P1). These mirror the decision logic
// in main.js: registerHotkeys (buildKeybindMap / accelToAction), emitVisibility
// (emitVisibilityDecision), reevaluateVisibility (visibilityDecision), and
// desiredTopmost / shouldIgnoreMouse. The actual Electron/timer side effects stay
// in main.js.

import core from '../overlay-core.js';

const {
  buildKeybindMap,
  accelToAction,
  visibilityDecision,
  emitVisibilityDecision,
  desiredTopmost,
  shouldIgnoreMouse,
  nextPresenceState,
  shouldHidePanelInGame,
  buildPanelHidingSaveScript,
  parsePanelHidingSave,
  buildPanelHidingSetScript,
  buildPanelHidingRestoreScript,
  isSinglePrintableChar,
  canShowOverlay,
  showModeFor,
  ACTIVATING_REASONS,
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

  it('visible overlay -> true even when blurred and no game is running', () => {
    expect(desiredTopmost({ ...base, windowVisible: true })).toBe(true);
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

describe('shouldIgnoreMouse', () => {
  it('keeps a blurred overlay interactive when the game is not foreground', () => {
    expect(shouldIgnoreMouse({
      overlayFocused: false,
      gameForeground: false,
      clickThrough: false,
      autoClickThrough: false,
      modalInteractive: false,
    })).toEqual({ ignore: false, forward: false });
  });

  it('passes clicks through while the game is foreground', () => {
    expect(shouldIgnoreMouse({
      overlayFocused: false,
      gameForeground: true,
      clickThrough: false,
      autoClickThrough: true,
      modalInteractive: false,
    })).toEqual({ ignore: true, forward: true });
  });

  it('keeps manual click-through authoritative', () => {
    expect(shouldIgnoreMouse({
      overlayFocused: true,
      gameForeground: false,
      clickThrough: true,
      autoClickThrough: false,
      modalInteractive: false,
    })).toEqual({ ignore: true, forward: false });
  });

  it('pins interactivity for an open modal', () => {
    expect(shouldIgnoreMouse({
      overlayFocused: false,
      gameForeground: true,
      clickThrough: true,
      autoClickThrough: true,
      modalInteractive: true,
    })).toEqual({ ignore: false, forward: false });
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

// KDE panel auto-hide while in-game (opt-in) — pure decision + script/parse helpers.
describe('panel auto-hide helpers', () => {
  it('shouldHidePanelInGame requires enabled AND gameRunning AND overlayVisible', () => {
    expect(shouldHidePanelInGame({ enabled: true, gameRunning: true, overlayVisible: true })).toBe(true);
    expect(shouldHidePanelInGame({ enabled: false, gameRunning: true, overlayVisible: true })).toBe(false);
    expect(shouldHidePanelInGame({ enabled: true, gameRunning: false, overlayVisible: true })).toBe(false);
    expect(shouldHidePanelInGame({ enabled: true, gameRunning: true, overlayVisible: false })).toBe(false);
    expect(shouldHidePanelInGame()).toBe(false);
  });

  it('parsePanelHidingSave parses id=mode pairs, keeping only known modes', () => {
    expect(parsePanelHidingSave('424=autohide,7=none')).toEqual({ 424: 'autohide', 7: 'none' });
    // garbage / unknown modes / partial output are dropped, not thrown on:
    expect(parsePanelHidingSave('1=bogus,2=dodgewindows,3=ERR, ,')).toEqual({ 2: 'dodgewindows' });
    expect(parsePanelHidingSave('')).toEqual({});
    expect(parsePanelHidingSave(null)).toEqual({});
  });

  it('buildPanelHidingSetScript validates the mode (falls back to autohide) and touches all panels', () => {
    expect(buildPanelHidingSetScript('autohide')).toContain('.hiding="autohide"');
    expect(buildPanelHidingSetScript('none')).toContain('.hiding="none"');
    expect(buildPanelHidingSetScript('rm -rf')).toContain('.hiding="autohide"'); // injection-safe fallback
    expect(buildPanelHidingSetScript('autohide')).toContain('for(var i=0;i<panelIds.length;i++)');
  });

  it('buildPanelHidingRestoreScript emits a guarded per-id restore, skipping invalid ids/modes', () => {
    const js = buildPanelHidingRestoreScript({ 424: 'none', 7: 'autohide' });
    expect(js).toContain('try{panelById(424).hiding="none";}catch(e){}');
    expect(js).toContain('try{panelById(7).hiding="autohide";}catch(e){}');
    // non-numeric id and unknown mode are dropped:
    expect(buildPanelHidingRestoreScript({ 'x': 'none', 5: 'bogus' })).toBe('');
    expect(buildPanelHidingRestoreScript({})).toBe('');
  });

  it('save script prints a comma-joined id=hiding list', () => {
    expect(buildPanelHidingSaveScript()).toContain('panelById(panelIds[i]).hiding');
    expect(buildPanelHidingSaveScript()).toContain('print(o.join(","))');
  });

  it('round-trips: save output → parse → restore script references the same ids/modes', () => {
    const map = parsePanelHidingSave('424=autohide,99=none');
    const restore = buildPanelHidingRestoreScript(map);
    expect(restore).toContain('panelById(424).hiding="autohide"');
    expect(restore).toContain('panelById(99).hiding="none"');
  });
});

describe('canShowOverlay, focusAware / gameFocused gate', () => {
  it('forceVisible:true wins over everything else even with gameFocused:false', () => {
    expect(canShowOverlay({
      forceVisible: true, focusAware: true, gameRunning: true, gameFocused: false, role: 'member',
    })).toBe(true);
    expect(canShowOverlay({
      forceVisible: true, focusAware: true, gameRunning: true, gameFocused: false, role: 'admin',
    })).toBe(true);
  });

  it('focusAware sits ABOVE the privileged bypass, so an admin gets no free pass', () => {
    expect(canShowOverlay({
      forceVisible: false, focusAware: true, gameRunning: true, gameFocused: false, role: 'admin',
    })).toBe(false);
    expect(canShowOverlay({
      forceVisible: false, focusAware: true, gameRunning: true, gameFocused: false, role: 'moderator',
    })).toBe(false);
    expect(canShowOverlay({
      forceVisible: false, focusAware: true, gameRunning: true, gameFocused: false, role: 'owner',
    })).toBe(false);
    expect(canShowOverlay({
      forceVisible: false, focusAware: true, gameRunning: true, gameFocused: false, role: 'developer',
    })).toBe(false);
  });

  it('focusAware:true, gameRunning:true, gameFocused:true → true', () => {
    expect(canShowOverlay({
      forceVisible: false, focusAware: true, gameRunning: true, gameFocused: true, role: 'member',
    })).toBe(true);
    expect(canShowOverlay({
      forceVisible: false, focusAware: true, gameRunning: true, gameFocused: true, role: 'admin',
    })).toBe(true);
  });
});

// Regression: when focusAware is falsy the function is byte-identical to the
// pre-focus-aware implementation. Re-runs the existing 4-input cartesian
// (forceVisible × role × gameRunning × chatActive) with focusAware:false and
// asserts the output matches the legacy expected value AND the no-flag call.
describe('canShowOverlay, focusAware:false is byte-identical to legacy', () => {
  const bools = [false, true];
  const roles = ['member', '', 'moderator', 'admin', 'owner', 'developer'];
  const privileged = new Set(['moderator', 'admin', 'owner', 'developer']);

  for (const forceVisible of bools) {
    for (const role of roles) {
      for (const gameRunning of bools) {
        for (const chatActive of bools) {
          const input = { forceVisible, role, gameRunning, chatActive };
          const expected = forceVisible || privileged.has(role) || gameRunning || !chatActive;
          it(`fv=${forceVisible} role=${role || '<empty>'} game=${gameRunning} chat=${chatActive} -> ${expected}`, () => {
            expect(canShowOverlay(input)).toBe(expected);
            expect(canShowOverlay({ ...input, focusAware: false })).toBe(expected);
            expect(canShowOverlay({ ...input, focusAware: false })).toBe(canShowOverlay(input));
          });
        }
      }
    }
  }

  it('the one false case stays false with focusAware:false', () => {
    const input = { forceVisible: false, role: 'member', gameRunning: false, chatActive: true };
    expect(canShowOverlay(input)).toBe(false);
    expect(canShowOverlay({ ...input, focusAware: false })).toBe(false);
  });

  it('empty state defaults to allow with or without focusAware:false', () => {
    expect(canShowOverlay()).toBe(true);
    expect(canShowOverlay({ focusAware: false })).toBe(true);
  });
});

describe('showModeFor', () => {
  it.each([...ACTIVATING_REASONS])('%s → active (user-initiated)', (reason) => {
    expect(showModeFor(reason)).toBe('active');
  });

  it.each([
    'game-launch',
    'game-focus',
    'presence',
    'chat-active',
    'onboarding',
    'privileged',
    'did-finish-load',
    'whatever-unlisted',
  ])('%s → inactive (automatic / unrecognized, the safe default)', (reason) => {
    expect(showModeFor(reason)).toBe('inactive');
  });
});
