// Unit tests for window-bounds drift suppression (issue #427).
//
// On a fractionally-scaled display the DIP -> physical -> DIP round-trip does not
// return the commanded value (asking for 560x720 reads back 562x722).
// persistBounds() wrote that back, it became the next setBounds input, and the
// window grew ~1px per axis per cycle forever. Measured on a 1.247x display:
// 536x480 -> 552x498 over one session (~27 setBounds events).
//
// resolvePersistedSize() closes that loop: a size within tolerance of the last
// persisted value is treated as rounding noise and the old value is kept.
//
// Runner: vitest (environment 'node').

import { describe, it, expect } from 'vitest';
import core from '../overlay-core.js';

const { resolvePersistedSize, BOUNDS_DRIFT_TOLERANCE_PX } = core;

describe('resolvePersistedSize — drift suppression', () => {
  it('keeps the previous size when the observation drifted by 1px', () => {
    const out = resolvePersistedSize({ width: 541, height: 485 }, { width: 540, height: 484 });
    expect(out).toEqual({ width: 540, height: 484 });
  });

  it('keeps the previous size at exactly the tolerance', () => {
    const prev = { width: 540, height: 484 };
    const out = resolvePersistedSize(
      { width: 540 + BOUNDS_DRIFT_TOLERANCE_PX, height: 484 + BOUNDS_DRIFT_TOLERANCE_PX },
      prev,
    );
    expect(out).toEqual(prev);
  });

  it('suppresses drift in the negative direction too', () => {
    const out = resolvePersistedSize({ width: 538, height: 482 }, { width: 540, height: 484 });
    expect(out).toEqual({ width: 540, height: 484 });
  });

  // The regression this exists to prevent: feeding the result back in must not
  // creep. Before the fix this grew by ~1px per iteration without bound.
  it('does NOT accumulate across many round-trips (the #427 regression)', () => {
    let persisted = { width: 536, height: 480 };
    for (let i = 0; i < 200; i++) {
      // Simulate the WM handing back a value 1px larger than what we asked for.
      const observed = { width: persisted.width + 1, height: persisted.height + 1 };
      persisted = resolvePersistedSize(observed, persisted);
    }
    expect(persisted).toEqual({ width: 536, height: 480 });
  });
});

describe('resolvePersistedSize — real resizes still win', () => {
  it('accepts a deliberate resize beyond the tolerance', () => {
    const out = resolvePersistedSize({ width: 800, height: 600 }, { width: 540, height: 484 });
    expect(out).toEqual({ width: 800, height: 600 });
  });

  it('accepts a shrink beyond the tolerance', () => {
    const out = resolvePersistedSize({ width: 400, height: 320 }, { width: 540, height: 484 });
    expect(out).toEqual({ width: 400, height: 320 });
  });

  // Tolerance is per-axis-pair: one axis moving a lot is a real resize even if the
  // other barely moved (e.g. dragging the right edge only).
  it('accepts a width-only resize with an unchanged height', () => {
    const out = resolvePersistedSize({ width: 900, height: 485 }, { width: 540, height: 484 });
    expect(out).toEqual({ width: 900, height: 485 });
  });

  it('accepts a height-only resize with an unchanged width', () => {
    const out = resolvePersistedSize({ width: 541, height: 900 }, { width: 540, height: 484 });
    expect(out).toEqual({ width: 541, height: 900 });
  });

  it('is a no-op when the size is identical', () => {
    const out = resolvePersistedSize({ width: 540, height: 484 }, { width: 540, height: 484 });
    expect(out).toEqual({ width: 540, height: 484 });
  });
});

describe('resolvePersistedSize — guards', () => {
  it('returns the observation when there is no previous value (first ever save)', () => {
    expect(resolvePersistedSize({ width: 520, height: 500 }, null))
      .toEqual({ width: 520, height: 500 });
  });

  it('returns the observation when the previous value is degenerate', () => {
    expect(resolvePersistedSize({ width: 520, height: 500 }, { width: 0, height: 0 }))
      .toEqual({ width: 520, height: 500 });
  });

  it('rounds fractional observations to whole pixels', () => {
    expect(resolvePersistedSize({ width: 520.4, height: 500.6 }, null))
      .toEqual({ width: 520, height: 501 });
  });

  it('honours an explicit tolerance', () => {
    // 5px apart: drift under a tolerance of 6, a real resize under the default 2.
    const prev = { width: 540, height: 484 };
    expect(resolvePersistedSize({ width: 545, height: 489 }, prev, 6)).toEqual(prev);
    expect(resolvePersistedSize({ width: 545, height: 489 }, prev)).toEqual({ width: 545, height: 489 });
  });
});
