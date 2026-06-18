import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Import the REAL implementation under test (not a reimplementation). This
// exercises production code: if makeJobTracker's escalation logic regresses
// (e.g. someone removes the consecutive-failure throw/escalation), these tests
// fail. We spy on the REAL logger instance's methods so we observe exactly the
// warn/error/info calls makeJobTracker makes.
import { makeJobTracker, FAILURE_THRESHOLD } from '../jobTracker';
import logger from '../../config/logger';

// Spy buckets, populated by mock.method on the real logger.
const calls: { level: 'warn' | 'error' | 'info'; meta: any; msg: string }[] = [];

beforeEach(() => {
  calls.length = 0;
  mock.method(logger, 'warn', (meta: any, msg: string) => { calls.push({ level: 'warn', meta, msg }); });
  mock.method(logger, 'error', (meta: any, msg: string) => { calls.push({ level: 'error', meta, msg }); });
  mock.method(logger, 'info', (meta: any, msg: string) => { calls.push({ level: 'info', meta, msg }); });
});

afterEach(() => {
  mock.restoreAll();
});

const byLevel = (level: 'warn' | 'error' | 'info') => calls.filter(c => c.level === level);

describe('makeJobTracker (real implementation)', () => {
  test('exports the documented default failure threshold', () => {
    assert.equal(FAILURE_THRESHOLD, 5);
  });

  test('successful run logs nothing and keeps the counter at 0', async () => {
    const tracker = makeJobTracker('[test]', 3);
    await tracker(async () => {});
    assert.equal(calls.length, 0, 'a clean run should not log');
  });

  test('failures below the threshold log warn, never error', async () => {
    const tracker = makeJobTracker('[test]', 5);
    for (let i = 0; i < 4; i++) {
      await tracker(async () => { throw new Error('boom'); });
    }
    assert.equal(byLevel('warn').length, 4);
    assert.equal(byLevel('error').length, 0, 'must not escalate before the threshold');
  });

  test('escalates to logger.error exactly at the threshold', async () => {
    const threshold = 5;
    const tracker = makeJobTracker('[test]', threshold);
    for (let i = 0; i < threshold; i++) {
      await tracker(async () => { throw new Error('boom'); });
    }
    const errors = byLevel('error');
    assert.equal(errors.length, 1, 'the threshold-th consecutive failure escalates to error');
    // The error carries the consecutive-failure count and the underlying error.
    assert.equal(errors[0].meta.consecutiveFailures, threshold);
    assert.ok(errors[0].meta.err instanceof Error);
    // The first (threshold-1) failures were warns.
    assert.equal(byLevel('warn').length, threshold - 1);
  });

  test('keeps escalating to error on every failure past the threshold', async () => {
    const threshold = 3;
    const tracker = makeJobTracker('[test]', threshold);
    for (let i = 0; i < 6; i++) {
      await tracker(async () => { throw new Error('boom'); });
    }
    // ticks 3,4,5,6 are error-level (4 total); ticks 1,2 are warn-level.
    assert.equal(byLevel('error').length, 4);
    assert.equal(byLevel('warn').length, 2);
  });

  test('a successful run RESETS the counter to 0 (next failure is warn, not error)', async () => {
    const threshold = 3;
    const tracker = makeJobTracker('[test]', threshold);
    // Two failures (warns), then a success resets the counter.
    await tracker(async () => { throw new Error('boom'); });
    await tracker(async () => { throw new Error('boom'); });
    await tracker(async () => {}); // success → reset + recovery info log
    assert.equal(byLevel('error').length, 0);

    calls.length = 0;
    // After reset, the next failure must be a warn (counter restarted at 1),
    // proving the counter genuinely reset to 0 rather than continuing to climb.
    await tracker(async () => { throw new Error('boom'); });
    assert.equal(byLevel('error').length, 0, 'counter did not reset — a single post-success failure escalated');
    assert.equal(byLevel('warn').length, 1);
    assert.equal(byLevel('warn')[0].meta.consecutiveFailures, 1);
  });

  test('logs a recovery info message after recovering from failures', async () => {
    const tracker = makeJobTracker('[test]', 3);
    await tracker(async () => { throw new Error('boom'); });
    await tracker(async () => {});
    const infos = byLevel('info');
    assert.equal(infos.length, 1);
    assert.match(infos[0].msg, /recovered/);
  });

  test('no recovery log when the first run already succeeds', async () => {
    const tracker = makeJobTracker('[test]', 3);
    await tracker(async () => {});
    assert.equal(byLevel('info').length, 0);
  });

  test('uses FAILURE_THRESHOLD by default when no threshold is passed', async () => {
    const tracker = makeJobTracker('[default-threshold]');
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await tracker(async () => { throw new Error('boom'); });
    }
    assert.equal(byLevel('error').length, 0, 'no escalation just below the default threshold');
    await tracker(async () => { throw new Error('boom'); });
    assert.equal(byLevel('error').length, 1, 'escalates at the default threshold');
    assert.equal(byLevel('error')[0].meta.consecutiveFailures, FAILURE_THRESHOLD);
  });
});
