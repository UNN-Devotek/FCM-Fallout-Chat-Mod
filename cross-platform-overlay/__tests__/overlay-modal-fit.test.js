// Unit tests for the temporary modal-fit window growth (issue #374).
//
// Context: the shell settings / onboarding panels are DOM inside the overlay's
// own BrowserWindow, so their `max-width: 96vw` / `max-height: 90vh` caps are
// relative to the OVERLAY, not the screen. A compact overlay squeezes the
// settings panel to the point of being unusable. main.js grows the window while
// a modal is open and restores the user's size on close; modalFitBounds() is the
// pure sizing decision behind that.
//
// Runner: vitest (environment 'node' — no DOM needed).

import { describe, it, expect } from 'vitest';
import core from '../overlay-core.js';

const {
  modalFitBounds,
  resolvePersistedSize,
  MODAL_FIT_WIDTH,
  MODAL_FIT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} = core;

// A generous 1080p work area — big enough that nothing clamps unless we say so.
const WA = { x: 0, y: 0, width: 1920, height: 1080 };

describe('modalFitBounds — growth decision', () => {
  it('grows a minimum-size overlay to the modal fit size (the #374 case)', () => {
    // 320x280 is MIN_WIDTH x MIN_HEIGHT — the smallest the user can make it,
    // which caps #shell-settings at ~307x252 and triggered the bug report.
    const cur = { x: 100, y: 100, width: MIN_WIDTH, height: MIN_HEIGHT };
    const grown = modalFitBounds(cur, WA);
    expect(grown).not.toBeNull();
    expect(grown.width).toBe(MODAL_FIT_WIDTH);
    expect(grown.height).toBe(MODAL_FIT_HEIGHT);
  });

  it('leaves the position alone when it grows', () => {
    const cur = { x: 240, y: 160, width: MIN_WIDTH, height: MIN_HEIGHT };
    const grown = modalFitBounds(cur, WA);
    expect(grown.x).toBe(240);
    expect(grown.y).toBe(160);
  });

  it('returns null when the window is already big enough (no needless resize)', () => {
    const cur = { x: 0, y: 0, width: MODAL_FIT_WIDTH, height: MODAL_FIT_HEIGHT };
    expect(modalFitBounds(cur, WA)).toBeNull();
  });

  it('returns null for a window larger than the fit size', () => {
    const cur = { x: 0, y: 0, width: 1200, height: 900 };
    expect(modalFitBounds(cur, WA)).toBeNull();
  });

  it('NEVER shrinks — a wide-but-short window keeps its width', () => {
    const cur = { x: 0, y: 0, width: 1400, height: 300 };
    const grown = modalFitBounds(cur, WA);
    expect(grown).not.toBeNull();
    expect(grown.width).toBe(1400);            // untouched, not pulled down to 560
    expect(grown.height).toBe(MODAL_FIT_HEIGHT);
  });

  it('NEVER shrinks — a narrow-but-tall window keeps its height', () => {
    const cur = { x: 0, y: 0, width: 340, height: 1000 };
    const grown = modalFitBounds(cur, WA);
    expect(grown).not.toBeNull();
    expect(grown.width).toBe(MODAL_FIT_WIDTH);
    expect(grown.height).toBe(1000);           // untouched
  });
});

describe('modalFitBounds — clamping to the display', () => {
  it('never exceeds a work area smaller than the fit size', () => {
    const small = { x: 0, y: 0, width: 480, height: 500 };
    const cur = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT };
    const grown = modalFitBounds(cur, small);
    expect(grown).not.toBeNull();
    expect(grown.width).toBeLessThanOrEqual(small.width);
    expect(grown.height).toBeLessThanOrEqual(small.height);
  });

  it('keeps the grown window fully inside the work area when near an edge', () => {
    const cur = { x: 1850, y: 1020, width: MIN_WIDTH, height: MIN_HEIGHT };
    const grown = modalFitBounds(cur, WA);
    expect(grown.x).toBeGreaterThanOrEqual(WA.x);
    expect(grown.y).toBeGreaterThanOrEqual(WA.y);
    expect(grown.x + grown.width).toBeLessThanOrEqual(WA.x + WA.width);
    expect(grown.y + grown.height).toBeLessThanOrEqual(WA.y + WA.height);
  });

  it('respects a non-zero work-area origin (secondary monitor / taskbar)', () => {
    const wa = { x: -1920, y: 40, width: 1920, height: 1000 };
    const cur = { x: -1900, y: 60, width: MIN_WIDTH, height: MIN_HEIGHT };
    const grown = modalFitBounds(cur, wa);
    expect(grown.x).toBeGreaterThanOrEqual(wa.x);
    expect(grown.y).toBeGreaterThanOrEqual(wa.y);
    expect(grown.x + grown.width).toBeLessThanOrEqual(wa.x + wa.width);
    expect(grown.y + grown.height).toBeLessThanOrEqual(wa.y + wa.height);
  });

  it('returns null when clamping cannot actually change the size', () => {
    // Work area exactly the current size — growth is impossible, so there is
    // nothing to restore and the caller must not record a snapshot.
    const wa = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT };
    const cur = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT };
    expect(modalFitBounds(cur, wa)).toBeNull();
  });
});

describe('modalFitBounds — custom need + guards', () => {
  it('honours an explicit need larger than the default', () => {
    const cur = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT };
    const grown = modalFitBounds(cur, WA, { width: 900, height: 800 });
    expect(grown.width).toBe(900);
    expect(grown.height).toBe(800);
  });

  it('returns null when an explicit need is already satisfied', () => {
    const cur = { x: 0, y: 0, width: 600, height: 600 };
    expect(modalFitBounds(cur, WA, { width: 500, height: 500 })).toBeNull();
  });

  it('returns null on missing inputs rather than throwing', () => {
    expect(modalFitBounds(null, WA)).toBeNull();
    expect(modalFitBounds({ x: 0, y: 0, width: 320, height: 280 }, null)).toBeNull();
  });
});

// The restore path in main.js keeps the LIVE x/y and only puts the size back,
// so a window dragged while the modal was open is not teleported. That policy is
// asserted here against the same clamp helper main.js uses for the restore.
describe('restore policy — size only, position preserved', () => {
  it('clamped restore of the pre-modal size keeps the moved-to position', () => {
    const preModal = { width: MIN_WIDTH, height: MIN_HEIGHT };
    const movedTo = { x: 700, y: 420 };
    const restored = core.clampToWorkArea(
      { x: movedTo.x, y: movedTo.y, width: preModal.width, height: preModal.height },
      WA,
    );
    expect(restored.width).toBe(preModal.width);
    expect(restored.height).toBe(preModal.height);
    expect(restored.x).toBe(movedTo.x);
    expect(restored.y).toBe(movedTo.y);
  });
});

// Regression test for the HOME-key-spam growth bug: toggleSettings() (renderer)
// fires on every HOME press, driving one growWindowForModal()/restoreWindowAfterModal()
// cycle per press. On fractionally-scaled Linux sessions setBounds() doesn't return
// what was commanded (issue #427's DIP round-trip), so growWindowForModal() reading a
// fresh, un-corrected getBounds() as its baseline every cycle let the size creep by
// ~1-2px per HOME press, forever. The fix runs the live baseline through the same
// resolvePersistedSize() tolerance-snap #427 already uses for the disk-persist path,
// keyed off a baseline that survives across cycles (mirroring main.js's
// modalFitLastGoodSize). This composes modalFitBounds + resolvePersistedSize the same
// way growWindowForModal() does, so it regresses if that wiring breaks.
describe('modal-fit drift suppression across repeated open/close cycles (HOME-spam)', () => {
  it('does not creep across many grow/restore toggles when the WM echoes +1px/axis', () => {
    let lastGood = null;
    let observed = { width: 538, height: 482 }; // #427's own repro pre-modal size
    for (let i = 0; i < 200; i++) {
      // growWindowForModal(): resolve the live (possibly drifted) read against the
      // remembered baseline before deciding how much to grow.
      const base = resolvePersistedSize(observed, lastGood);
      lastGood = base;
      const grown = modalFitBounds({ x: 0, y: 0, ...base }, WA);
      expect(grown).not.toBeNull();
      // restoreWindowAfterModal(): commands `base` back, but the compositor echoes
      // it +1px/axis inflated (the #427 mechanism) — that's what the NEXT cycle's
      // growWindowForModal() will observe.
      observed = { width: base.width + 1, height: base.height + 1 };
    }
    expect(lastGood).toEqual({ width: 538, height: 482 });
  });

  it('still accepts a genuine resize beyond the tolerance mid-cycle', () => {
    const lastGood = { width: 538, height: 482 };
    const base = resolvePersistedSize({ width: 900, height: 700 }, lastGood);
    expect(base).toEqual({ width: 900, height: 700 });
  });
});
