const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { installRuntimeSignals } = require('../src/runtime/control');
const { EventEmitter } = require('node:events');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let directory, runtime, gates;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-close-join-')); runtime = new RuntimeCoordinator(directory); gates = []; });
afterEach(async () => { for (const gate of gates) gate.resolve(); await pause(1); runtime.disposeForTests(); fs.chmodSync(directory, 0o700); fs.rmSync(directory, { recursive: true, force: true }); });
const held = () => { const value = deferred(); gates.push(value); return value; };

test('a stronger close join during the final zero inspection closes ingress and dependencies once', async () => {
  const entered = held(), inspection = held(), closed = [];
  runtime.registerParticipant('fixture', { inspect: async () => { entered.resolve(); await inspection.promise; return { pending: 0 }; }, close: async () => { closed.push('dependency'); } });
  const first = runtime.drain({ timeoutMs: 1000 }); await entered.promise;
  const closeIngress = async () => { closed.push('ingress'); };
  const second = runtime.drain({ timeoutMs: 5000, close: true, closeIngress });
  expect(second).toBe(first); inspection.resolve();
  expect((await second).phase).toBe('closed'); expect(closed).toEqual(['ingress', 'dependency']);
  expect(runtime.snapshot().ingressClosed).toBe(true);
});
test('close intent joining a nonclosing ingress drain survives the ingress callback await', async () => {
  const entered = held(), ingress = held(), closed = [];
  runtime.registerParticipant('fixture', { inspect: async () => ({ pending: 0 }), close: async () => { closed.push('dependency'); } });
  const closeIngress = async () => { entered.resolve(); await ingress.promise; closed.push('ingress'); };
  const first = runtime.drain({ timeoutMs: 1000, closeIngress }); await entered.promise;
  const second = runtime.drain({ timeoutMs: 5000, close: true, closeIngress });
  ingress.resolve(); expect((await second).phase).toBe('closed'); await first;
  expect(closed).toEqual(['ingress', 'dependency']);
});
test('a new ingress-close join while a consumer closes is awaited before the remaining dependencies close', async () => {
  const entered = held(), consumer = held(), ingress = held(), closed = [];
  runtime.registerParticipant('consumer', { inspect: async () => ({ pending: 0 }), close: async () => { entered.resolve(); await consumer.promise; closed.push('consumer'); } });
  runtime.registerParticipant('pool', { inspect: async () => ({ pending: 0 }), close: async () => { closed.push('pool'); } });
  const first = runtime.drain({ timeoutMs: 1000, close: true }); await entered.promise;
  const second = runtime.drain({ timeoutMs: 5000, close: true, closeIngress: async () => { await ingress.promise; closed.push('ingress'); } });
  consumer.resolve(); await pause(10); expect(closed).toEqual(['consumer']);
  ingress.resolve(); expect((await second).phase).toBe('closed'); await first;
  expect(closed).toEqual(['consumer', 'ingress', 'pool']);
});
test('joining shutdown cannot reset the original total deadline or close dependencies with unfinished ingress', async () => {
  const entered = held(), ingress = held(), dependency = jest.fn(async () => {});
  runtime.registerParticipant('fixture', { inspect: async () => ({ pending: 0 }), close: dependency });
  const closeIngress = async () => { entered.resolve(); await ingress.promise; };
  const first = runtime.drain({ timeoutMs: 80, closeIngress }); await entered.promise;
  const at = Date.now();
  const second = runtime.drain({ timeoutMs: 5000, close: true, closeIngress });
  expect((await second).phase).toBe('failed'); expect(Date.now() - at).toBeLessThan(400); await first;
  expect(dependency).not.toHaveBeenCalled(); expect(runtime.snapshot().active).toContainEqual(expect.objectContaining({ label: 'close:ingress' }));
  expect(fs.existsSync(runtime.markerPath)).toBe(true); expect(fs.existsSync(runtime.snapshot().restartFence.path)).toBe(true);
  ingress.resolve(); await pause(10);
  expect((await runtime.drain({ timeoutMs: 1000, close: true, closeIngress })).phase).toBe('closed');
  expect(dependency).toHaveBeenCalledTimes(1);
});
test('an operator joining signal closure preserves both fences during consumer close', async () => {
  const entered = held(), close = held(), events = new EventEmitter(), exited = held();
  runtime.registerParticipant('fixture', { inspect: async () => ({ pending: 0 }), close: async () => { entered.resolve(); await close.promise; } });
  installRuntimeSignals(runtime, async () => {}, exited.resolve, events);
  events.emit('SIGTERM'); await entered.promise;
  expect(runtime.snapshot().phase).toBe('closing');
  const operator = runtime.drain({ timeoutMs: 1000, close: true }); close.resolve();
  expect((await operator).phase).toBe('closed'); await exited.promise;
  expect(fs.existsSync(runtime.markerPath)).toBe(true); expect(fs.existsSync(runtime.snapshot().restartFence.path)).toBe(true);
});
test.each(['required-failure', 'checkpoint-failure', 'journal-failure'])('%s cannot turn a close request into a clean completion or remove either fence', async mode => {
  runtime.freeze('fixture');
  if (mode === 'required-failure') runtime.recordFailure('fixture-required', new Error('private fixture effect'));
  if (mode === 'journal-failure') { fs.chmodSync(directory, 0o500); runtime.recordFailure('fixture-required', new Error('private fixture effect')); fs.chmodSync(directory, 0o700); }
  if (mode === 'checkpoint-failure') fs.chmodSync(directory, 0o500);
  const dependency = jest.fn(async () => {}); runtime.registerParticipant('fixture', { inspect: async () => ({ pending: 0 }), close: dependency });
  const result = await runtime.drain({ timeoutMs: 200, close: true, closeIngress: async () => {} });
  fs.chmodSync(directory, 0o700);
  expect(result.phase).toBe('failed'); expect(result.failures.length).toBeGreaterThan(0); expect(dependency).not.toHaveBeenCalled();
  expect(fs.existsSync(runtime.markerPath)).toBe(true); expect(fs.existsSync(result.restartFence.path)).toBe(true);
});
