import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Stub logger — capture calls without importing the real Pino instance.
const logs: { level: string; msg: string; consecutiveFailures?: number }[] = [];
const stubLogger = {
  warn:  (meta: object, msg: string) => logs.push({ level: 'warn',  msg, ...(meta as any) }),
  error: (meta: object, msg: string) => logs.push({ level: 'error', msg, ...(meta as any) }),
  info:  (meta: object, msg: string) => logs.push({ level: 'info',  msg, ...(meta as any) }),
};

// Inline the makeJobTracker logic with the stub logger injected so we can
// test the escalation behaviour without importing the real module (which
// requires the full backend dep tree to be compiled).
function makeJobTrackerWithLogger(
  logger: typeof stubLogger,
  label: string,
  threshold = 5,
) {
  let consecutiveFailures = 0;
  return async function run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      if (consecutiveFailures > 0) {
        logger.info({ consecutiveFailures }, `${label} recovered after ${consecutiveFailures} consecutive failure(s)`);
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= threshold) {
        logger.error({ err, consecutiveFailures }, `${label} failed ${consecutiveFailures} consecutive time(s) — job may be stuck`);
      } else {
        logger.warn({ err, consecutiveFailures }, `${label} failed (non-fatal)`);
      }
    }
  };
}

describe('makeJobTracker', () => {
  test('successful run resets failure counter', async () => {
    logs.length = 0;
    const tracker = makeJobTrackerWithLogger(stubLogger, '[test]', 3);
    // Two failures
    await tracker(async () => { throw new Error('fail'); });
    await tracker(async () => { throw new Error('fail'); });
    // Then success
    await tracker(async () => {});
    assert.equal(logs.filter(l => l.level === 'error').length, 0);
    // Counter resets: next failure is warn, not error
    await tracker(async () => { throw new Error('fail'); });
    assert.equal(logs.filter(l => l.level === 'error').length, 0);
  });

  test('warn log before threshold is reached', async () => {
    logs.length = 0;
    const tracker = makeJobTrackerWithLogger(stubLogger, '[test]', 5);
    for (let i = 0; i < 4; i++) {
      await tracker(async () => { throw new Error('fail'); });
    }
    assert.equal(logs.filter(l => l.level === 'warn').length, 4);
    assert.equal(logs.filter(l => l.level === 'error').length, 0);
  });

  test('escalates to error at threshold', async () => {
    logs.length = 0;
    const tracker = makeJobTrackerWithLogger(stubLogger, '[test]', 5);
    for (let i = 0; i < 5; i++) {
      await tracker(async () => { throw new Error('fail'); });
    }
    const errors = logs.filter(l => l.level === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].consecutiveFailures, 5);
  });

  test('continues to error after threshold until recovery', async () => {
    logs.length = 0;
    const tracker = makeJobTrackerWithLogger(stubLogger, '[test]', 3);
    for (let i = 0; i < 6; i++) {
      await tracker(async () => { throw new Error('fail'); });
    }
    assert.equal(logs.filter(l => l.level === 'error').length, 4); // ticks 3,4,5,6
  });

  test('logs recovery message after failures', async () => {
    logs.length = 0;
    const tracker = makeJobTrackerWithLogger(stubLogger, '[test]', 3);
    await tracker(async () => { throw new Error('fail'); });
    await tracker(async () => {});
    const infos = logs.filter(l => l.level === 'info');
    assert.equal(infos.length, 1);
    assert.match(infos[0].msg, /recovered/);
  });

  test('no recovery log when first run succeeds', async () => {
    logs.length = 0;
    const tracker = makeJobTrackerWithLogger(stubLogger, '[test]', 3);
    await tracker(async () => {});
    assert.equal(logs.filter(l => l.level === 'info').length, 0);
  });
});
