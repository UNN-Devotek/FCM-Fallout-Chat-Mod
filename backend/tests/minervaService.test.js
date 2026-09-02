'use strict';
/**
 * Unit tests for minervaService — deterministic Minerva sale schedule.
 *
 * All assertions use dates from the published 2023–2026 schedule so failures
 * prove a real regression, not just an off-by-one.
 * Sales start/end at 17:00 UTC (FO76 server reset).
 * Duration: regular = 2 days (e.g. Jun 1 17:00 → Jun 3 17:00), super = 4 days.
 */

const { getMinervaStatus } = require('../src/services/minervaService');

// Helper: build a Date at the given UTC calendar date + hour
const utc = (y, m, d, h = 0) => new Date(Date.UTC(y, m - 1, d, h));

// ── Spot-check known sale windows ────────────────────────────────────────────

describe('getMinervaStatus — known active windows', () => {
  // List 1, Foundation, April 3–5 2023 (start Apr 3, end Apr 5 at 17:00 = 2 days)
  it('List 1 — Foundation (2023-04-03 to 2023-04-05) — active mid-window', () => {
    const now = utc(2023, 4, 4, 12); // noon on Apr 4 UTC
    const { active, next } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(1);
    expect(active.location).toBe('Foundation');
    expect(active.isSuperSale).toBe(false);
    expect(active.startUtc).toEqual(utc(2023, 4, 3, 17));
    expect(active.endUtc).toEqual(utc(2023, 4, 5, 17));
    expect(next.listNumber).toBe(2);
    expect(next.location).toBe('The Crater');
  });

  // List 4 Super Sale — Whitespring, Apr 27–May 1 2023 (start Apr 27, end May 1 = 4 days)
  it('List 4 — Whitespring Super Sale (2023-04-27 to 2023-05-01)', () => {
    const now = utc(2023, 4, 29, 10);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(4);
    expect(active.location).toBe('The Whitespring Resort');
    expect(active.isSuperSale).toBe(true);
    expect(active.startUtc).toEqual(utc(2023, 4, 27, 17));
    expect(active.endUtc).toEqual(utc(2023, 5, 1, 17));
  });

  // List 12 Super Sale — Whitespring, July 6–10 2023
  it('List 12 — Whitespring Super Sale (2023-07-06 to 2023-07-10)', () => {
    const now = utc(2023, 7, 8, 0);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(12);
    expect(active.isSuperSale).toBe(true);
  });

  // List 24 — Whitespring Super Sale, March 23–27 2023
  it('List 24 — Whitespring Super Sale (2023-03-23 to 2023-03-27)', () => {
    const now = utc(2023, 3, 25, 20);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(24);
    expect(active.isSuperSale).toBe(true);
    expect(active.startUtc).toEqual(utc(2023, 3, 23, 17));
    expect(active.endUtc).toEqual(utc(2023, 3, 27, 17));
  });

  // 2024 cross-check: List 12 Super Sale — Whitespring, Feb 1–5 2024
  it('List 12 — Whitespring Super Sale (2024-02-01 to 2024-02-05)', () => {
    const now = utc(2024, 2, 3, 12);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(12);
    expect(active.isSuperSale).toBe(true);
    expect(active.location).toBe('The Whitespring Resort');
    expect(active.startUtc).toEqual(utc(2024, 2, 1, 17));
    expect(active.endUtc).toEqual(utc(2024, 2, 5, 17));
  });

  // 2024 cross-check: List 16 Super Sale — Whitespring, Oct 3–7 2024
  it('List 16 — Whitespring Super Sale (2024-10-03 to 2024-10-07)', () => {
    const now = utc(2024, 10, 5, 10);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(16);
    expect(active.isSuperSale).toBe(true);
  });

  // 2025 cross-check: List 8 Super Sale — Whitespring, Feb 20–24 2025
  it('List 8 — Whitespring Super Sale (2025-02-20 to 2025-02-24)', () => {
    const now = utc(2025, 2, 22, 9);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(8);
    expect(active.isSuperSale).toBe(true);
    expect(active.startUtc).toEqual(utc(2025, 2, 20, 17));
    expect(active.endUtc).toEqual(utc(2025, 2, 24, 17));
  });

  // 2026 cross-check: List 16 Super Sale — Whitespring, Jun 25–29 2026
  it('List 16 — Whitespring Super Sale (2026-06-25 to 2026-06-29)', () => {
    const now = utc(2026, 6, 27, 10);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(16);
    expect(active.isSuperSale).toBe(true);
    expect(active.location).toBe('The Whitespring Resort');
    expect(active.startUtc).toEqual(utc(2026, 6, 25, 17));
    expect(active.endUtc).toEqual(utc(2026, 6, 29, 17));
  });

  // 2026 regular: List 17 Foundation, Jul 6–8 2026
  it('List 17 — Foundation (2026-07-06 to 2026-07-08)', () => {
    const now = utc(2026, 7, 7, 10);
    const { active } = getMinervaStatus(now);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(17);
    expect(active.location).toBe('Foundation');
    expect(active.isSuperSale).toBe(false);
    expect(active.startUtc).toEqual(utc(2026, 7, 6, 17));
    expect(active.endUtc).toEqual(utc(2026, 7, 8, 17));
  });
});

// ── Between-sale gaps (no active sale) ───────────────────────────────────────

describe('getMinervaStatus — between sales', () => {
  // Between List 1 end (Apr 5 17:00) and List 2 start (Apr 10 17:00)
  it('returns null active between List 1 and List 2', () => {
    const now = utc(2023, 4, 8, 10);
    const { active, next } = getMinervaStatus(now);
    expect(active).toBeNull();
    expect(next.listNumber).toBe(2);
    expect(next.location).toBe('The Crater');
  });

  // Between List 3 end and the Super Sale (List 4) start
  it('returns null active between List 3 and the Super Sale List 4', () => {
    // List 3: Apr 17–19 2023; List 4 Super: Apr 27–May 1
    const now = utc(2023, 4, 22, 10);
    const { active, next } = getMinervaStatus(now);
    expect(active).toBeNull();
    expect(next.listNumber).toBe(4);
    expect(next.isSuperSale).toBe(true);
  });

  // After List 16 super sale ends (Jun 29 17:00 2026), before List 17 starts (Jul 6 17:00)
  it('returns null active after List 16 ends and before List 17 starts (2026)', () => {
    const now = utc(2026, 7, 2, 10);
    const { active, next } = getMinervaStatus(now);
    expect(active).toBeNull();
    expect(next.listNumber).toBe(17);
    expect(next.location).toBe('Foundation');
    expect(next.startUtc).toEqual(utc(2026, 7, 6, 17));
  });
});

// ── Boundary precision (sale starts/ends at exactly 17:00 UTC) ───────────────

describe('getMinervaStatus — 17:00 UTC boundary', () => {
  it('sale is NOT active one second before start', () => {
    const justBefore = new Date(Date.UTC(2023, 3, 3, 17, 0, 0) - 1000);
    const { active } = getMinervaStatus(justBefore);
    expect(active).toBeNull();
  });

  it('sale IS active at exactly the start time', () => {
    const atStart = utc(2023, 4, 3, 17);
    const { active } = getMinervaStatus(atStart);
    expect(active).not.toBeNull();
    expect(active.listNumber).toBe(1);
  });

  it('sale is NOT active at exactly the end time', () => {
    const atEnd = utc(2023, 4, 5, 17); // List 1 ends Apr 5 17:00 (2-day duration)
    const { active } = getMinervaStatus(atEnd);
    expect(active).toBeNull();
  });
});

// ── Location rotation ─────────────────────────────────────────────────────────

describe('getMinervaStatus — location rotation', () => {
  it('four consecutive sales follow Foundation→Crater→Fort Atlas→Whitespring', () => {
    const starts = [
      { date: utc(2023, 4, 3, 17),  loc: 'Foundation',            super: false },
      { date: utc(2023, 4, 10, 17), loc: 'The Crater',             super: false },
      { date: utc(2023, 4, 17, 17), loc: 'Fort Atlas',             super: false },
      { date: utc(2023, 4, 27, 17), loc: 'The Whitespring Resort', super: true  },
    ];
    for (const { date, loc, super: isSuperSale } of starts) {
      const { active } = getMinervaStatus(date);
      expect(active).not.toBeNull();
      expect(active.location).toBe(loc);
      expect(active.isSuperSale).toBe(isSuperSale);
    }
  });
});

// ── List number cycling (1–24) ────────────────────────────────────────────────

describe('getMinervaStatus — list number cycling', () => {
  it('after List 24, the next sale is List 1 again', () => {
    // List 24 Super Sale ends March 27 17:00 UTC 2023; check March 29 (clearly after)
    const afterList24 = utc(2023, 3, 29, 10);
    const { active, next } = getMinervaStatus(afterList24);
    expect(active).toBeNull();
    expect(next.listNumber).toBe(1);
    expect(next.location).toBe('Foundation');
  });
});
