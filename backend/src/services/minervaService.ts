/**
 * Minerva's Big Sale — deterministic schedule calculator.
 *
 * The cycle is 24 inventory lists repeating indefinitely. Lists are grouped
 * in blocks of 4, with every 4th being a Super Sale at The Whitespring. Durations
 * are measured as 24h windows between 17:00 UTC resets: the Super Sale runs 4 days
 * (Thu→Mon reset), the other three rotate Foundation → Crater → Fort Atlas and run
 * 2 days each (Mon→Wed reset) — matching SLOT_DURATIONS below and the tests. The
 * block total is 35 calendar days (the three regular slots sit on a 7-day cadence,
 * then a longer gap before the Super Sale and the next block).
 *
 * Slot offsets within a 35-day block (days from block start, 17:00 UTC):
 *   Slot 0: day  0 — Foundation         (2-day sale, Mon–Wed reset)
 *   Slot 1: day  7 — The Crater         (2-day sale, Mon–Wed reset)
 *   Slot 2: day 14 — Fort Atlas         (2-day sale, Mon–Wed reset)
 *   Slot 3: day 24 — Whitespring Resort (4-day Super Sale, Thu–Mon reset)
 *
 * Anchor: 2023-04-03T17:00:00Z — start of List 1, block 0, slot 0.
 * All sales start and end at 17:00 UTC (FO76 daily server reset).
 *
 * Verified against the full 2023–2026 published schedule.
 */

export interface MinervaWindow {
  listNumber: number;      // 1–24
  location: string;
  isSuperSale: boolean;
  startUtc: Date;
  endUtc: Date;
}
export interface MinervaStatus {
  active: MinervaWindow | null;
  next: MinervaWindow;
}

const DAY_MS = 86_400_000;
const BLOCK_DAYS = 35;

// Anchor: 2023-04-03T17:00:00Z — start of List 1, slot 0
const ANCHOR_MS = Date.UTC(2023, 3, 3, 17, 0, 0);

const LOCATIONS = ['Foundation', 'The Crater', 'Fort Atlas', 'The Whitespring Resort'];
const SLOT_DAY_OFFSETS = [0, 7, 14, 24];
const SLOT_DURATIONS   = [2, 2, 2,  4];

function listNumberForSlot(blockIndex: number, slotIndex: number): number {
  const raw = (blockIndex * 4 + slotIndex) % 24;
  return ((raw % 24) + 24) % 24 + 1; // positive modulo, then 1-indexed
}

function windowForAbsoluteSlot(absoluteSlot: number): MinervaWindow {
  const blockIndex = Math.floor(absoluteSlot / 4);
  const slotIndex  = ((absoluteSlot % 4) + 4) % 4;
  const blockStartMs = ANCHOR_MS + blockIndex * BLOCK_DAYS * DAY_MS;
  const startMs = blockStartMs + SLOT_DAY_OFFSETS[slotIndex] * DAY_MS;
  const endMs   = startMs      + SLOT_DURATIONS[slotIndex]   * DAY_MS;
  return {
    listNumber: listNumberForSlot(blockIndex, slotIndex),
    location:   LOCATIONS[slotIndex],
    isSuperSale: slotIndex === 3,
    startUtc: new Date(startMs),
    endUtc:   new Date(endMs),
  };
}

/**
 * Returns the current or next Minerva sale window relative to `now`.
 * Exported for unit testing.
 */
export function getMinervaStatus(now: Date = new Date()): MinervaStatus {
  const elapsedDays = (now.getTime() - ANCHOR_MS) / DAY_MS;

  // Positive-modulo block arithmetic — handles dates before the anchor correctly
  const blockIndex = Math.floor(elapsedDays / BLOCK_DAYS);
  const dayInBlock = ((elapsedDays % BLOCK_DAYS) + BLOCK_DAYS) % BLOCK_DAYS;

  for (let slotIndex = 0; slotIndex < 4; slotIndex++) {
    const slotStartDay = SLOT_DAY_OFFSETS[slotIndex];
    const slotEndDay   = slotStartDay + SLOT_DURATIONS[slotIndex];
    const absoluteSlot = blockIndex * 4 + slotIndex;

    if (dayInBlock >= slotStartDay && dayInBlock < slotEndDay) {
      return {
        active: windowForAbsoluteSlot(absoluteSlot),
        next:   windowForAbsoluteSlot(absoluteSlot + 1),
      };
    }

    if (dayInBlock < slotStartDay) {
      return {
        active: null,
        next:   windowForAbsoluteSlot(absoluteSlot),
      };
    }
  }

  // Past slot 3 in this block — next is slot 0 of the next block
  return {
    active: null,
    next:   windowForAbsoluteSlot((blockIndex + 1) * 4),
  };
}
