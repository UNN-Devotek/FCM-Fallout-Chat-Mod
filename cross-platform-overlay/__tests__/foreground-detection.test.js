// Unit tests for Linux/Windows active-window detection helpers in overlay-core.
// Covers: isGameClass() XWayland class matching, shouldRegisterShortcuts() across
// all platform/detection-state combinations, preferredForegroundTools() order.

import core from '../overlay-core.js';

const { isGameProcess, isGameClass, isUnknownForegroundClass, shouldRegisterShortcuts, preferredForegroundTools, XWAYLAND_GAME_CLASSES } = core;

// ── isGameClass ───────────────────────────────────────────────────────────────

describe('isGameClass', () => {
  // Standard exe-name path (delegates to isGameProcess)
  it('matches fallout76.exe — XWayland WM_CLASS from Proton', () => {
    expect(isGameClass('fallout76.exe')).toBe(true);
  });

  it('matches Fallout76 (no extension)', () => {
    expect(isGameClass('Fallout76')).toBe(true);
  });

  it('matches project76_gamepass.exe (Xbox Game Pass under XWayland)', () => {
    expect(isGameClass('project76_gamepass.exe')).toBe(true);
  });

  // XWayland steam_app_* form
  it('matches steam_app_1151340 (FO76 Steam AppID class)', () => {
    expect(isGameClass('steam_app_1151340')).toBe(true);
  });

  it('matches STEAM_APP_1151340 (uppercase)', () => {
    expect(isGameClass('STEAM_APP_1151340')).toBe(true);
  });

  // Overlay's own class — must NOT match. Under XWayland the overlay reports
  // WM_CLASS "Fallout Chat Mod" (→ lowercased "fallout chat mod"); the native
  // Wayland app_id form "fallout-chat-mod" must also never match.
  it('does NOT match the overlay class "fallout chat mod" (XWayland WM_CLASS)', () => {
    expect(isGameClass('fallout chat mod')).toBe(false);
  });
  it('does NOT match the overlay app_id fallout-chat-mod', () => {
    expect(isGameClass('fallout-chat-mod')).toBe(false);
  });

  // Other apps that should not be matched
  it('does NOT match konsole', () => {
    expect(isGameClass('konsole')).toBe(false);
  });

  it('does NOT match discord', () => {
    expect(isGameClass('discord')).toBe(false);
  });

  it('does NOT match firefox', () => {
    expect(isGameClass('firefox')).toBe(false);
  });

  it('does NOT match empty string', () => {
    expect(isGameClass('')).toBe(false);
  });

  it('does NOT match null', () => {
    expect(isGameClass(null)).toBe(false);
  });

  it('does NOT match undefined', () => {
    expect(isGameClass(undefined)).toBe(false);
  });

  // Ensure XWAYLAND_GAME_CLASSES entries all match
  it.each(XWAYLAND_GAME_CLASSES)('XWAYLAND_GAME_CLASSES entry "%s" is detected by isGameClass', (cls) => {
    expect(isGameClass(cls)).toBe(true);
    expect(isGameClass(cls.toUpperCase())).toBe(true);
  });
});

// ── shouldRegisterShortcuts ───────────────────────────────────────────────────

describe('shouldRegisterShortcuts', () => {
  // ── win32 ─────────────────────────────────────────────────────────────────

  describe('win32', () => {
    const base = { platform: 'win32', hasForegroundDetect: false };

    it('returns true when game is foreground (by exe name)', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'fallout76', overlayFocused: false })).toBe(true);
    });

    it('returns true when game is foreground (with .exe suffix)', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'fallout76.exe', overlayFocused: false })).toBe(true);
    });

    it('returns false when another app is foreground and overlay is not focused', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'discord', overlayFocused: false })).toBe(false);
    });

    it('returns true when overlay is focused even if another app was last foreground', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: 'konsole', overlayFocused: true })).toBe(true);
    });

    it('returns false when game is not running and no app / overlay focused', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: '', overlayFocused: false })).toBe(false);
    });

    it('returns true when game is foreground even if game is not in process list', () => {
      // win32: foreground trumps gameRunning for key registration
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: 'fallout76', overlayFocused: false })).toBe(true);
    });
  });

  // ── linux KDE-Wayland WITH kdotool (hasForegroundDetect=true) ────────────

  describe('linux KDE-Wayland + kdotool present', () => {
    const base = { platform: 'linux', hasForegroundDetect: true };

    it('returns true when game is the active window (XWayland class)', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'fallout76.exe', overlayFocused: false })).toBe(true);
    });

    it('returns true when FO76 is active by steam_app class', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'steam_app_1151340', overlayFocused: false })).toBe(true);
    });

    it('returns false when another app (Konsole) is active and overlay not focused', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'konsole', overlayFocused: false })).toBe(false);
    });

    it('returns false when Discord is active and overlay not focused', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'discord', overlayFocused: false })).toBe(false);
    });

    it('returns true when overlay is focused (user is typing)', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: 'konsole', overlayFocused: true })).toBe(true);
    });

    it('returns false when overlay-class is active (fallout-chat-mod) and overlayFocused=false', () => {
      // The overlay's own WM_CLASS must not self-trigger game detection.
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: 'fallout-chat-mod', overlayFocused: false })).toBe(false);
    });

    it('returns false when nothing is foreground and game is not running', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: '', overlayFocused: false })).toBe(false);
    });

    // Fullscreen game: xdotool reads no WM_CLASS → "(null)"/empty. With the game
    // running, that unreadable foreground must count as the game (keep hotkeys live).
    it('returns true for a fullscreen game (foreground "(null)") while the game is running', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: '(null)', overlayFocused: false })).toBe(true);
    });
    it('returns true for an empty foreground while the game is running (fullscreen)', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: '', overlayFocused: false })).toBe(true);
    });
    it('returns false for "(null)" foreground when the game is NOT running', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: '(null)', overlayFocused: false })).toBe(false);
    });

    // Optional gameFocused override: when it's a boolean, use it instead of
    // re-deriving from foregroundProc. Omitted → legacy derivation unchanged.
    it('gameFocused:true overrides a foregroundProc that is NOT the game', () => {
      expect(shouldRegisterShortcuts({
        ...base, gameRunning: true, foregroundProc: 'firefox', overlayFocused: false, gameFocused: true,
      })).toBe(true);
    });

    it('gameFocused:false overrides a foregroundProc that IS the game', () => {
      expect(shouldRegisterShortcuts({
        ...base, gameRunning: true, foregroundProc: 'fallout76.exe', overlayFocused: false, gameFocused: false,
      })).toBe(false);
    });

    it('omitting gameFocused keeps the legacy foregroundProc derivation', () => {
      expect(shouldRegisterShortcuts({
        ...base, gameRunning: true, foregroundProc: 'firefox', overlayFocused: false,
      })).toBe(false);
      expect(shouldRegisterShortcuts({
        ...base, gameRunning: true, foregroundProc: 'fallout76.exe', overlayFocused: false,
      })).toBe(true);
      expect(shouldRegisterShortcuts({
        ...base, gameRunning: true, foregroundProc: '(null)', overlayFocused: false,
      })).toBe(true);
    });
  });

  // ── isUnknownForegroundClass ────────────────────────────────────────────────
  describe('isUnknownForegroundClass', () => {
    it('treats empty / whitespace / "(null)" as unknown', () => {
      expect(isUnknownForegroundClass('')).toBe(true);
      expect(isUnknownForegroundClass('   ')).toBe(true);
      expect(isUnknownForegroundClass('(null)')).toBe(true);
      expect(isUnknownForegroundClass('(NULL)')).toBe(true);
      expect(isUnknownForegroundClass(null)).toBe(true);
      expect(isUnknownForegroundClass(undefined)).toBe(true);
    });
    it('treats a real class as known', () => {
      expect(isUnknownForegroundClass('konsole')).toBe(false);
      expect(isUnknownForegroundClass('steam_app_1151340')).toBe(false);
      expect(isUnknownForegroundClass('fallout-chat-mod')).toBe(false);
    });
  });

  // ── linux WITHOUT kdotool (hasForegroundDetect=false) — fallback behavior ──

  describe('linux KDE-Wayland without kdotool (fallback)', () => {
    const base = { platform: 'linux', hasForegroundDetect: false };

    it('returns true when game is running, regardless of foreground window', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'konsole', overlayFocused: false })).toBe(true);
    });

    it('returns true when game is running and another app shows in foreground', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'discord', overlayFocused: false })).toBe(true);
    });

    it('returns false when game is not running and overlay is not focused', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: '', overlayFocused: false })).toBe(false);
    });

    it('returns true when overlay is focused even without kdotool', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: '', overlayFocused: true })).toBe(true);
    });
  });

  // ── linux plain (non-KDE-Wayland) — same fallback as no-kdotool ───────────

  describe('linux non-KDE-Wayland (plain X11 / other WM)', () => {
    const base = { platform: 'linux', hasForegroundDetect: false };

    it('returns true while game is running', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: true, foregroundProc: 'konsole', overlayFocused: false })).toBe(true);
    });

    it('returns false while game is not running and overlay not focused', () => {
      expect(shouldRegisterShortcuts({ ...base, gameRunning: false, foregroundProc: '', overlayFocused: false })).toBe(false);
    });
  });
});

// ── preferredForegroundTools ──────────────────────────────────────────────────

describe('preferredForegroundTools', () => {
  it('KDE-Wayland prefers kdotool then xdotool', () => {
    expect(preferredForegroundTools({ kdeWayland: true, x11: false })).toEqual(['kdotool', 'xdotool']);
  });

  it('X11 prefers xdotool then kdotool', () => {
    expect(preferredForegroundTools({ kdeWayland: false, x11: true })).toEqual(['xdotool', 'kdotool']);
  });

  it('returns empty when neither session type applies', () => {
    expect(preferredForegroundTools({ kdeWayland: false, x11: false })).toEqual([]);
  });

  it('kdeWayland wins when both flags are true', () => {
    expect(preferredForegroundTools({ kdeWayland: true, x11: true })).toEqual(['kdotool', 'xdotool']);
  });
});
