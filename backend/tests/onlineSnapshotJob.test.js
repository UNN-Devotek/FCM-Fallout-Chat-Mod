'use strict';

// Mock the logger so we can assert the overlap-skip warning fired.
jest.mock('../dist/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock the heavy module-level imports so requiring the job never touches the
// real DB pool or WebSocket layer. The job under test is invoked with injected
// deps, so these defaults are never used — but the imports must resolve.
jest.mock('../dist/config/database', () => ({
  __esModule: true,
  query: jest.fn(),
}));
jest.mock('../dist/websocket/handlers', () => ({
  __esModule: true,
  getClientCount: jest.fn(() => 0),
}));

const logger = require('../dist/config/logger').default;
const { startOnlineSnapshotJob } = require('../dist/jobs/onlineSnapshotJob');

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Captures every (expression -> task) registered with the injected scheduler so
 * tests can invoke a specific cron task on demand instead of waiting for time.
 */
function makeScheduleCapture() {
  const tasks = new Map();
  const schedule = jest.fn((expr, task) => {
    tasks.set(expr, task);
    return { stop: jest.fn() };
  });
  return { schedule, taskFor: (expr) => tasks.get(expr) };
}

/**
 * A query mock whose FIRST call blocks on a controlled pending promise (holding
 * the tick open) and whose later calls resolve immediately. `release()` settles
 * the held call.
 */
function makeGatedQuery() {
  let releaseFirst;
  let firstSeen = false;
  const dbQuery = jest.fn(() => {
    if (!firstSeen) {
      firstSeen = true;
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ rowCount: 1 });
      });
    }
    return Promise.resolve({ rowCount: 0 });
  });
  return { dbQuery, release: () => releaseFirst && releaseFirst() };
}

// The scheduled callback runs its DB work THROUGH makeJobTracker, which adds a
// couple of extra microtask hops (await fn → reset counter → resolve) before the
// guard's `.finally` clears the `running` flag. A fixed number of
// `await Promise.resolve()` turns is brittle against that depth, so drain a
// generous number of turns to let a released tick fully settle.
async function flushMicrotasks(turns = 20) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('startOnlineSnapshotJob', () => {
  beforeEach(() => {
    logger.warn.mockClear();
    logger.info.mockClear();
  });

  it('schedules a 5-minute sampler and a daily purge', () => {
    const { schedule, taskFor } = makeScheduleCapture();
    startOnlineSnapshotJob({ schedule, getClientCount: () => 0, dbQuery: jest.fn() });

    expect(schedule).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function));
    expect(schedule).toHaveBeenCalledWith('7 4 * * *', expect.any(Function));
    expect(taskFor('*/5 * * * *')).toBeInstanceOf(Function);
    expect(taskFor('7 4 * * *')).toBeInstanceOf(Function);
  });

  describe('snapshot sampler overlap guard', () => {
    it('skips a tick while the previous insert is still running, then resumes', async () => {
      const { schedule, taskFor } = makeScheduleCapture();
      const { dbQuery, release } = makeGatedQuery();
      startOnlineSnapshotJob({ schedule, getClientCount: () => 3, dbQuery });

      const tick = taskFor('*/5 * * * *');

      // Tick #1 — starts the insert, then blocks on the gated query.
      tick();
      await Promise.resolve();
      expect(dbQuery).toHaveBeenCalledTimes(1);

      // Tick #2 fires while #1 is still pending → must be skipped by the guard.
      tick();
      await Promise.resolve();
      expect(dbQuery).toHaveBeenCalledTimes(1); // no second insert started
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('previous insert still running'),
      );

      // Release #1 → tracker settles → guard's `.finally` clears the flag → a
      // later tick can run.
      release();
      await flushMicrotasks();

      tick();
      await Promise.resolve();
      expect(dbQuery).toHaveBeenCalledTimes(2);
    });

    it('runs each tick when none overlap', async () => {
      const { schedule, taskFor } = makeScheduleCapture();
      const dbQuery = jest.fn().mockResolvedValue({ rowCount: 1 });
      startOnlineSnapshotJob({ schedule, getClientCount: () => 1, dbQuery });

      const tick = taskFor('*/5 * * * *');
      await tick();
      await tick();

      expect(dbQuery).toHaveBeenCalledTimes(2);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('previous insert still running'),
      );
    });
  });

  describe('retention purge overlap guard', () => {
    it('skips a purge while the previous purge is still running, then resumes', async () => {
      const { schedule, taskFor } = makeScheduleCapture();
      const { dbQuery, release } = makeGatedQuery();
      startOnlineSnapshotJob({ schedule, getClientCount: () => 0, dbQuery });

      const purge = taskFor('7 4 * * *');

      purge();
      await Promise.resolve();
      expect(dbQuery).toHaveBeenCalledTimes(1);

      purge();
      await Promise.resolve();
      expect(dbQuery).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('previous purge still running'),
      );

      release();
      await flushMicrotasks();

      purge();
      await Promise.resolve();
      expect(dbQuery).toHaveBeenCalledTimes(2);
    });
  });
});
