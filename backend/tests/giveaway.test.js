'use strict';

/**
 * Tests for giveawayService.ts.
 *
 * Verified:
 *   (a) createGiveaway persists a row, schedules a timer, and broadcasts the announcement.
 *   (b) A second createGiveaway while one is active is rejected (CAP_REACHED).
 *   (c) joinGiveaway adds an entry and broadcasts giveaway:update.
 *   (d) Joining your own giveaway is rejected (OWN_GIVEAWAY).
 *   (e) Joining an ended giveaway is rejected (NOT_ACTIVE).
 *   (f) leaveGiveaway removes the entry and broadcasts giveaway:update.
 *   (g) cancelGiveaway sets status = 'cancelled', clears the timer, broadcasts.
 *   (h) cancelGiveaway by a non-creator non-mod is rejected (FORBIDDEN).
 *   (i) drawWinner picks a random entry, sets status = 'completed', broadcasts winner.
 *   (j) drawWinner with no entries sets status = 'completed', broadcasts no-winner msg.
 *   (k) reconcileActive re-schedules timers for in-flight giveaways.
 *   (l) reconcileActive draws immediately for already-expired giveaways.
 *   (m) joinGiveaway is idempotent — duplicate join does NOT re-broadcast.
 *   (n) leaveGiveaway with no entry does NOT broadcast.
 *   (o) drawWinner no-ops when DB update fails with P2025 (race with cancel).
 *   (p) drawWinner logs error and does NOT broadcast when DB fails unexpectedly.
 *   (q) joinGiveaway is rate-limited per user per giveaway.
 *   (r) createGiveaway includes createdByUserId in broadcast metadata.
 *   (s) cancelGiveaway with concurrent draw (P2025) throws NOT_ACTIVE.
 */

// ── Fake clock / timers ───────────────────────────────────────────────────────

jest.useFakeTimers();

// ── Mock logger ───────────────────────────────────────────────────────────────

jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Mock autoModService ───────────────────────────────────────────────────────

jest.mock('../src/services/autoModService', () => ({
  __esModule: true,
  findProhibitedPhrase: jest.fn().mockResolvedValue(null),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGiveaway(overrides = {}) {
  return {
    id: 'giveaway-uuid-1',
    shortId: 'ABC123',
    createdByUserId: 'user-1',
    creatorName: 'Devotek',
    channelId: 'channel-1',
    itemName: 'Flux x10',
    durationMin: 5,
    endsAt: new Date(Date.now() + 5 * 60 * 1000),
    status: 'active',
    winnerId: null,
    winnerName: null,
    createdAt: new Date(),
    _count: { entries: 0 },
    entries: [],
    ...overrides,
  };
}

function makeEntry(userId = 'user-2', username = 'Wastelander') {
  return { id: 'entry-uuid-1', giveawayId: 'giveaway-uuid-1', userId, username, joinedAt: new Date() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('giveawayService', () => {
  let giveawayService;
  let prisma;
  let broadcast;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();

    prisma = {
      channel: {
        findUnique: jest.fn().mockResolvedValue({ id: 'channel-1' }),
      },
      giveaway: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
      },
      giveawayEntry: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    broadcast = jest.fn();

    giveawayService = require('../src/services/giveawayService');
    await giveawayService.init({ prisma, broadcast });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── (a) createGiveaway ──────────────────────────────────────────────────────

  test('creates a giveaway and broadcasts announcement card', async () => {
    prisma.giveaway.count.mockResolvedValue(0);
    const created = makeGiveaway();
    prisma.giveaway.create.mockResolvedValue(created);

    await giveawayService.createGiveaway('user-1', 'Devotek', 'channel-1', 'Flux x10', 5);

    expect(prisma.giveaway.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ itemName: 'Flux x10', durationMin: 5, createdByUserId: 'user-1' }),
    }));

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat:message',
      payload: expect.objectContaining({
        source: 'bot',
        metadata: expect.objectContaining({ type: 'giveaway', itemName: 'Flux x10' }),
      }),
    }));
  });

  // ── (b) cap: second active giveaway rejected ────────────────────────────────

  test('rejects createGiveaway when user already has an active one', async () => {
    prisma.giveaway.count.mockResolvedValue(1);

    await expect(
      giveawayService.createGiveaway('user-1', 'Devotek', 'channel-1', 'Plans', 5),
    ).rejects.toMatchObject({ code: 'CAP_REACHED' });

    expect(prisma.giveaway.create).not.toHaveBeenCalled();
  });

  // ── (c) joinGiveaway adds entry and broadcasts update ───────────────────────

  test('joinGiveaway adds entry and broadcasts giveaway:update', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway());
    prisma.giveawayEntry.findUnique.mockResolvedValue(null); // not yet entered
    prisma.giveawayEntry.upsert.mockResolvedValue(makeEntry());
    prisma.giveawayEntry.count.mockResolvedValue(1);

    const result = await giveawayService.joinGiveaway('ABC123', 'user-2', 'Wastelander');

    expect(result).toEqual({ entryCount: 1 });
    expect(prisma.giveawayEntry.upsert).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'giveaway:update',
      payload: expect.objectContaining({ shortId: 'ABC123', entryCount: 1, status: 'active' }),
    }));
  });

  // ── (d) own giveaway join rejected ─────────────────────────────────────────

  test('joinGiveaway rejects the creator joining their own giveaway', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ createdByUserId: 'user-1' }));

    await expect(
      giveawayService.joinGiveaway('ABC123', 'user-1', 'Devotek'),
    ).rejects.toMatchObject({ code: 'OWN_GIVEAWAY' });
  });

  // ── (e) join ended giveaway rejected ───────────────────────────────────────

  test('joinGiveaway rejects joining a completed giveaway', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ status: 'completed' }));

    await expect(
      giveawayService.joinGiveaway('ABC123', 'user-2', 'Wastelander'),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
  });

  // ── (f) leaveGiveaway removes entry ────────────────────────────────────────

  test('leaveGiveaway removes entry and broadcasts giveaway:update', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway());
    prisma.giveawayEntry.deleteMany.mockResolvedValue({ count: 1 });
    prisma.giveawayEntry.count.mockResolvedValue(0);

    const result = await giveawayService.leaveGiveaway('ABC123', 'user-2');

    expect(result).toEqual({ entryCount: 0 });
    expect(prisma.giveawayEntry.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user-2' }) }),
    );
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'giveaway:update',
      payload: expect.objectContaining({ entryCount: 0 }),
    }));
  });

  // ── (g) cancelGiveaway ──────────────────────────────────────────────────────

  test('cancelGiveaway by creator cancels and broadcasts', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ createdByUserId: 'user-1' }));
    prisma.giveaway.update.mockResolvedValue({});
    prisma.giveawayEntry.count.mockResolvedValue(3);

    await giveawayService.cancelGiveaway('ABC123', 'user-1', false);

    expect(prisma.giveaway.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'cancelled' },
    }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat:message',
      payload: expect.objectContaining({ source: 'bot' }),
    }));
  });

  // ── (h) cancel by non-creator non-mod rejected ─────────────────────────────

  test('cancelGiveaway by non-creator non-mod is rejected', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ createdByUserId: 'user-1' }));

    await expect(
      giveawayService.cancelGiveaway('ABC123', 'user-99', false),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('cancelGiveaway by mod succeeds even if not creator', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ createdByUserId: 'user-1' }));
    prisma.giveaway.update.mockResolvedValue({});
    prisma.giveawayEntry.count.mockResolvedValue(0);

    await expect(
      giveawayService.cancelGiveaway('ABC123', 'mod-user', true),
    ).resolves.toBeUndefined();
  });

  // ── (i) drawWinner with entries ─────────────────────────────────────────────

  test('drawWinner picks a winner, sets status=completed, broadcasts winner', async () => {
    const entry = makeEntry('user-2', 'Wastelander');
    prisma.giveaway.count.mockResolvedValue(0);
    const created = makeGiveaway();
    prisma.giveaway.create.mockResolvedValue(created);
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ entries: [entry] }));
    prisma.giveaway.update.mockResolvedValue({ status: 'completed' });

    await giveawayService.createGiveaway('user-1', 'Devotek', 'channel-1', 'Flux x10', 5);
    broadcast.mockClear();

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.giveaway.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed', winnerId: 'user-2', winnerName: 'Wastelander' }),
    }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        metadata: expect.objectContaining({ type: 'giveaway_winner', winnerName: 'Wastelander' }),
      }),
    }));
  });

  // ── (j) drawWinner with no entries ─────────────────────────────────────────

  test('drawWinner with no entries broadcasts no-winner message', async () => {
    prisma.giveaway.count.mockResolvedValue(0);
    const created = makeGiveaway({ entries: [] });
    prisma.giveaway.create.mockResolvedValue(created);
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ entries: [] }));
    prisma.giveaway.update.mockResolvedValue({ status: 'completed' });

    await giveawayService.createGiveaway('user-1', 'Devotek', 'channel-1', 'Flux x10', 5);
    broadcast.mockClear();

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.giveaway.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'completed' },
    }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        metadata: expect.objectContaining({ winnerName: null }),
      }),
    }));
  });

  // ── (k) reconcileActive reschedules timers ──────────────────────────────────

  test('reconcileActive re-schedules timers for in-flight giveaways', async () => {
    const futureGiveaway = makeGiveaway({ endsAt: new Date(Date.now() + 2 * 60 * 1000) });
    prisma.giveaway.findMany.mockResolvedValue([futureGiveaway]);
    prisma.giveaway.findUnique.mockResolvedValue({ ...futureGiveaway, entries: [] });
    prisma.giveaway.update.mockResolvedValue({ status: 'completed' });

    await giveawayService.reconcileActive();

    broadcast.mockClear();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.giveaway.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'completed' },
    }));
  });

  // ── (l) reconcileActive draws immediately for expired giveaways ─────────────

  test('reconcileActive draws immediately for already-expired giveaways', async () => {
    const pastGiveaway = makeGiveaway({ endsAt: new Date(Date.now() - 1000), entries: [makeEntry()] });
    prisma.giveaway.findMany.mockResolvedValue([pastGiveaway]);
    prisma.giveaway.findUnique.mockResolvedValue({ ...pastGiveaway, entries: [makeEntry()] });
    prisma.giveaway.update.mockResolvedValue({ status: 'completed' });

    await giveawayService.reconcileActive();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prisma.giveaway.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'completed' }),
    }));
  });

  // ── (m) joinGiveaway is idempotent — duplicate join does NOT re-broadcast ───

  test('joinGiveaway does NOT broadcast when entry already exists', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway());
    // Simulate user already entered
    prisma.giveawayEntry.findUnique.mockResolvedValue(makeEntry('user-2'));
    prisma.giveawayEntry.upsert.mockResolvedValue(makeEntry('user-2'));
    prisma.giveawayEntry.count.mockResolvedValue(1);

    await giveawayService.joinGiveaway('ABC123', 'user-2', 'Wastelander');

    // upsert still called (idempotent), but no broadcast
    expect(prisma.giveawayEntry.upsert).toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'giveaway:update' }));
  });

  // ── (n) leaveGiveaway with no entry does NOT broadcast ──────────────────────

  test('leaveGiveaway does NOT broadcast when user had no entry', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway());
    prisma.giveawayEntry.deleteMany.mockResolvedValue({ count: 0 }); // nothing deleted
    prisma.giveawayEntry.count.mockResolvedValue(2);

    await giveawayService.leaveGiveaway('ABC123', 'user-99');

    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'giveaway:update' }));
  });

  // ── (o) drawWinner no-ops on P2025 (cancelled before draw) ──────────────────

  test('drawWinner no-ops gracefully when giveaway already cancelled (P2025)', async () => {
    prisma.giveaway.count.mockResolvedValue(0);
    const created = makeGiveaway();
    prisma.giveaway.create.mockResolvedValue(created);
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ entries: [makeEntry()] }));

    // Simulate P2025 — record not found (status already changed)
    const p2025 = Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    prisma.giveaway.update.mockRejectedValue(p2025);

    await giveawayService.createGiveaway('user-1', 'Devotek', 'channel-1', 'Flux x10', 5);
    broadcast.mockClear();

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // No winner broadcast — P2025 is handled silently
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        metadata: expect.objectContaining({ type: 'giveaway_winner' }),
      }),
    }));
  });

  // ── (p) drawWinner logs error and does NOT broadcast on unexpected DB failure ─

  test('drawWinner does NOT broadcast on unexpected DB failure', async () => {
    const logger = require('../src/config/logger').default;
    prisma.giveaway.count.mockResolvedValue(0);
    const created = makeGiveaway();
    prisma.giveaway.create.mockResolvedValue(created);
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ entries: [makeEntry()] }));
    prisma.giveaway.update.mockRejectedValue(new Error('DB connection lost'));

    await giveawayService.createGiveaway('user-1', 'Devotek', 'channel-1', 'Flux x10', 5);
    broadcast.mockClear();

    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // No winner broadcast
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ metadata: expect.anything() }),
    }));
    // Error was logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringContaining('drawWinner'),
    );
  });

  // ── (q) joinGiveaway is rate-limited per user per giveaway ──────────────────

  test('joinGiveaway rate-limits the same user joining twice quickly', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway());
    prisma.giveawayEntry.findUnique.mockResolvedValue(null);
    prisma.giveawayEntry.upsert.mockResolvedValue(makeEntry());
    prisma.giveawayEntry.count.mockResolvedValue(1);

    // First join succeeds
    await giveawayService.joinGiveaway('ABC123', 'user-2', 'Wastelander');

    // Second join immediately after is rate-limited
    await expect(
      giveawayService.joinGiveaway('ABC123', 'user-2', 'Wastelander'),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  // ── (r) createGiveaway includes createdByUserId in broadcast metadata ────────

  test('createGiveaway includes createdByUserId in broadcast metadata', async () => {
    prisma.giveaway.count.mockResolvedValue(0);
    const created = makeGiveaway({ createdByUserId: 'user-1' });
    prisma.giveaway.create.mockResolvedValue(created);

    await giveawayService.createGiveaway('user-1', 'Devotek', 'channel-1', 'Flux x10', 5);

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        metadata: expect.objectContaining({ createdByUserId: 'user-1' }),
      }),
    }));
  });

  // ── (s) cancelGiveaway with concurrent draw (P2025) throws NOT_ACTIVE ────────

  test('cancelGiveaway throws NOT_ACTIVE when draw fires concurrently (P2025)', async () => {
    prisma.giveaway.findUnique.mockResolvedValue(makeGiveaway({ createdByUserId: 'user-1' }));
    const p2025 = Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    prisma.giveaway.update.mockRejectedValue(p2025);

    await expect(
      giveawayService.cancelGiveaway('ABC123', 'user-1', false),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE' });
  });
});

// ── parseGiveawayStart ────────────────────────────────────────────────────────

describe('parseGiveawayStart', () => {
  let parseGiveawayStart;

  beforeEach(() => {
    jest.resetModules();
    // commandService has module-level side-effects (setInterval, DB cache) but
    // parseGiveawayStart is a pure function — require is sufficient.
    jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
    jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { chatCommand: { findMany: jest.fn().mockResolvedValue([]) } } }));
    jest.mock('../src/services/serverStatusService', () => ({ __esModule: true, getServerStatus: jest.fn() }));
    jest.mock('../src/services/nukeCodesService',   () => ({ __esModule: true, getNukeCodes: jest.fn() }));
    jest.mock('../src/services/campService',        () => ({ __esModule: true, getCampItem: jest.fn() }));
    jest.mock('../src/services/autoModService',     () => ({ __esModule: true, findProhibitedPhrase: jest.fn().mockResolvedValue(null) }));
    jest.mock('../src/services/giveawayService',    () => ({ __esModule: true, createGiveaway: jest.fn(), joinGiveaway: jest.fn(), leaveGiveaway: jest.fn(), cancelGiveaway: jest.fn(), listActive: jest.fn().mockResolvedValue([]), listRecent: jest.fn().mockResolvedValue([]), GiveawayError: class GiveawayError extends Error { constructor(msg, code) { super(msg); this.code = code; } } }));
    ({ parseGiveawayStart } = require('../src/services/commandService'));
  });

  const cases = [
    // [input,                         expectedItem,           expectedDuration]
    ['Shoes x10',                       'Shoes x10',            5  ],
    ['Shoes x10 15',                    'Shoes x10',            15 ],
    ['Ultracite Flux 10',               'Ultracite Flux',       10 ],
    ['Shoes x 10',                      'Shoes x 10',           5  ], // 'x' before 10 — protected
    ['Plans x5 20',                     'Plans x5',             20 ],
    ['Flux 5',                          'Flux',                 5  ],
    ['SingleWord',                      'SingleWord',           5  ], // single token, no duration
    ['Item 999',                        'Item',                 999 ], // clamped by service, not parser
    ['Item 0',                          'Item',                 0  ], // clamped by service
    ['Multi Word Item No Duration',     'Multi Word Item No Duration', 5],
    ['Multi Word Item 30',              'Multi Word Item',      30 ],
    ['X 10',                            'X 10',                 5  ], // single-char 'X' before 10
  ];

  test.each(cases)('parseGiveawayStart(%j) → item=%j dur=%d', (input, expectedItem, expectedDuration) => {
    const { itemName, durationMin } = parseGiveawayStart(input);
    expect(itemName).toBe(expectedItem);
    expect(durationMin).toBe(expectedDuration);
  });
});
