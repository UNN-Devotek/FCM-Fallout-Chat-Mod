const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { claimProcessFence } = require('../src/runtime/bootstrap');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let dir, runtime, restarts;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-restart-')); runtime = new RuntimeCoordinator(dir); restarts = []; });
afterEach(() => { runtime.disposeForTests(); for (const instance of restarts) instance.disposeForTests(); fs.rmSync(dir, { recursive: true, force: true }); });
const restarted = () => { const instance = new RuntimeCoordinator(dir); restarts.push(instance); return instance; };
const options = () => ({ timeoutMs: 1000, close: true, maintenance: false, closeIngress: async () => {} });

test('ordinary verified shutdown clears only its own transient fence and allows the next startup', async () => {
  const closed = jest.fn(); runtime.registerParticipant('consumer', { inspect: async () => ({ pending: 0 }), close: closed });
  const result = await runtime.drain(options());
  expect(result.phase).toBe('closed'); expect(closed).toHaveBeenCalledTimes(1);
  expect(result.restartFence.cleared).toBe(true); expect(result.fences).toEqual([]);
  expect(fs.existsSync(runtime.markerPath)).toBe(false);
  expect(restarted().isFrozen()).toBe(false);
});

test.each(['before', 'during', 'joining', 'after'])('operator maintenance %s a signal drain survives every restart', async timing => {
  const gate = deferred();
  if (timing === 'before') runtime.freeze('operator request');
  const drain = runtime.drain({ ...options(), closeIngress: () => gate.promise });
  await pause(20);
  if (timing === 'during') runtime.freeze('operator during signal');
  if (timing === 'joining') void runtime.drain({ timeoutMs: 1000 });
  gate.resolve(); expect((await drain).phase).toBe('closed');
  if (timing === 'after') runtime.freeze('operator after drain');
  expect(fs.existsSync(runtime.markerPath)).toBe(true);
  expect(restarted().isFrozen()).toBe(true);
});

test('a concurrent external operator marker is never removed with the private restart marker', async () => {
  const gate = deferred(); const drain = runtime.drain({ ...options(), closeIngress: () => gate.promise });
  await pause(20); fs.writeFileSync(runtime.markerPath, 'operator marker with unknown format'); gate.resolve();
  expect((await drain).phase).toBe('closed');
  expect(fs.readFileSync(runtime.markerPath, 'utf8')).toBe('operator marker with unknown format');
  expect(restarted().isFrozen()).toBe(true);
});

test('a crash or forced kill leaves a durable fence that a new process cannot claim or clear', async () => {
  // No signal or operator freeze occurs before this simulated warm crash.
  expect(runtime.isFrozen()).toBe(false); const originalFence = runtime.snapshot().restartFence.path;
  const next = restarted(); expect(next.isFrozen()).toBe(true);
  expect((await next.drain(options())).phase).toBe('closed');
  expect(fs.existsSync(originalFence)).toBe(true);
  expect(restarted().isFrozen()).toBe(true);
});

test('only the matching bootstrap nonce and exec-preserved PID can activate an existing claim', () => {
  const bootstrapDir = path.join(dir, 'bootstrap');
  const fence = claimProcessFence(bootstrapDir, process.pid); const owner = JSON.parse(fence.content).owner;
  const active = new RuntimeCoordinator(bootstrapDir, owner); restarts.push(active);
  expect(active.isFrozen()).toBe(false);
  const unknown = new RuntimeCoordinator(bootstrapDir, 'different-owner'); restarts.push(unknown);
  expect(unknown.isFrozen()).toBe(true); expect(unknown.snapshot().restartFence).toBe(null);
  const wrongPidDir = path.join(dir, 'wrong-pid');
  const wrong = claimProcessFence(wrongPidDir, process.pid + 1);
  const blocked = new RuntimeCoordinator(wrongPidDir, JSON.parse(wrong.content).owner); restarts.push(blocked);
  expect(blocked.isFrozen()).toBe(true); expect(blocked.snapshot().restartFence).toBe(null);
});

test('a removed or malformed live process marker freezes ingress and retains recovery evidence', () => {
  const marker = runtime.snapshot().restartFence.path; fs.writeFileSync(marker, '{}');
  expect(runtime.isFrozen()).toBe(true); expect(runtime.snapshot().failures[0].label).toBe('restart-fence');
  expect(fs.existsSync(runtime.markerPath)).toBe(true);
  expect(restarted().isFrozen()).toBe(true);
});

test('timeout preserves the transient fence and prevents restart activation', async () => {
  const gate = deferred(); const accepted = runtime.run('accepted', () => gate.promise);
  const result = await runtime.drain({ ...options(), timeoutMs: 40 });
  expect(result.phase).toBe('failed'); expect(fs.existsSync(result.restartFence.path)).toBe(true);
  expect(restarted().isFrozen()).toBe(true); gate.resolve(); await accepted;
});

test('dependency-close failure and a modified restart marker both require operator recovery', async () => {
  const gate = deferred(); const drain = runtime.drain({ ...options(), closeIngress: () => gate.promise });
  await pause(20); const marker = runtime.snapshot().restartFence.path;
  fs.writeFileSync(marker, '{"owner":"another-process"}'); gate.resolve();
  expect((await drain).phase).toBe('failed'); expect(fs.existsSync(marker)).toBe(true);
  expect(restarted().isFrozen()).toBe(true);
});

test('a missing restart claim during close restores persistent maintenance instead of activating a new writer', async () => {
  const gate = deferred(); const drain = runtime.drain({ ...options(), closeIngress: () => gate.promise });
  await pause(20); fs.unlinkSync(runtime.snapshot().restartFence.path); gate.resolve();
  expect((await drain).phase).toBe('failed'); expect(fs.existsSync(runtime.markerPath)).toBe(true);
  expect(restarted().isFrozen()).toBe(true);
});

test('every consumer close includes detached async cleanup before transient-fence removal', async () => {
  const gate = deferred(); let wrote = false;
  runtime.registerParticipant('consumer', { inspect: async () => ({ pending: 0 }), close: async () => {
    void gate.promise.then(() => { wrote = true; });
  } });
  const drain = runtime.drain(options()); await pause(30);
  expect(runtime.snapshot().phase).toBe('closing'); expect(wrote).toBe(false);
  expect(runtime.snapshot().restartFence.cleared).toBe(false);
  gate.resolve(); expect((await drain).phase).toBe('closed'); expect(wrote).toBe(true);
  expect(restarted().isFrozen()).toBe(false);
});
