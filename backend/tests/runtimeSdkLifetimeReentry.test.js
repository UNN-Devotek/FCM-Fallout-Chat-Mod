const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RuntimeCoordinator } = require('../src/runtime/coordinator');

test('an independent SDK callback cannot restore its caller into isolated SDK lifetimes on Node 22', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-sdk-reentry-'));
  const runtime = new RuntimeCoordinator(directory);
  let finishCallback, callbackFinished = false;
  const callbackGate = new Promise(resolve => { finishCallback = resolve; });
  try {
    await runtime.run('application-login', async () => {
      await runtime.initializeSdkLifetime(async () => {
        const delivery = runtime.lease('application-sdk-callback', true);
        try { delivery.run(() => { void (async () => { await callbackGate; callbackFinished = true; })(); }); }
        finally { delivery.release(); }
        // The installed SDK queue/throttler leaves an unused internal head.
        // Reentry must keep this resource outside application ownership, while
        // the independently scoped feature callback above stays outstanding.
        new Promise(() => {});
      });
    });
    expect(runtime.snapshot().active.some(work => work.label === 'application-login')).toBe(false);
    expect(runtime.snapshot().active.some(work => work.label === 'application-sdk-callback')).toBe(true);
    const held = await runtime.drain({ timeoutMs: 35, close: true });
    expect(held.phase).toBe('failed'); expect(callbackFinished).toBe(false);
    finishCallback();
    const closed = await runtime.drain({ timeoutMs: 300, close: true });
    expect(callbackFinished).toBe(true); expect(closed.phase).toBe('closed');
    expect(closed.active).toEqual([]); expect(closed.failures).toEqual([]);
  } finally { finishCallback(); runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); }
});
