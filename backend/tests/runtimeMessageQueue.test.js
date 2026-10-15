const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let mockDirectory, mockQueue, mockRows, mockRawAdd, mockPersist;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: {
  NODE_ENV: 'test', REDIS_HOST: 'fixture', REDIS_PORT: 6379, FCM_RUNTIME_CONTROL_DIR: mockDirectory,
} }));
jest.mock('bull', () => jest.fn(() => mockQueue));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { $queryRawUnsafe: jest.fn(async () => mockRows) } }));
jest.mock('../src/services/messageService', () => ({ persistMessage: (...args) => mockPersist(...args) }));
const data = () => ({ id: 'canonical-id', content: 'accepted', userId: 'user-id', channelId: 'channel-id', source: 'game', createdAt: '2026-10-13T12:00:00.000Z' });
let runtime, queue;
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-bull-')); mockRows = [];
  mockRawAdd = jest.fn(async payload => ({ id: 'job-1', data: payload, opts: { removeOnFail: 50 } }));
  mockQueue = { add: mockRawAdd, process: jest.fn(), on: jest.fn(), pause: jest.fn(async () => {}), close: jest.fn(async () => {}),
    getJobCounts: jest.fn(async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 })),
    getPausedCount: jest.fn(async () => 0), getJobs: jest.fn(async () => []), toKey: value => `message-persist:${value}`,
    client: { smembers: jest.fn(async () => []) } };
  mockPersist = jest.fn(async payload => { mockRows.push({ id: payload.id, content: payload.content, user_id: payload.userId,
    channel_id: payload.channelId, parent_channel_id: null, source: payload.source, metadata: null, relay_seq: null, created_at: new Date(payload.createdAt) }); });
});
afterEach(() => { runtime?.disposeForTests(); runtime = undefined; fs.rmSync(mockDirectory, { recursive: true, force: true }); });
function load() { queue = require('../src/queues/messagePersist'); runtime = require('../src/runtime').runtime; }

test('a frozen destination never starts a worker or acknowledges a new queue producer', async () => {
  fs.writeFileSync(path.join(mockDirectory, 'maintenance.json'), '{}'); load();
  expect(mockQueue.process).not.toHaveBeenCalled();
  expect(require('bull').mock.calls[0][1].skipVersionCheck).toBe(true);
  await expect(queue.add(data())).rejects.toThrow('Maintenance'); expect(mockRawAdd).not.toHaveBeenCalled();
});

test('source worker persists accepted work exactly once after freeze while new acceptance is refused', async () => {
  load(); const job = await queue.add(data()); runtime.freeze('cutover');
  await expect(queue.add({ ...data(), id: 'new-id' })).rejects.toThrow('Maintenance');
  await mockQueue.process.mock.calls[0][0](job);
  expect(mockPersist).toHaveBeenCalledTimes(1);
  expect(job.opts.removeOnFail).toBe(false);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  const checkpoint = JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8'));
  expect(checkpoint.participants['message-persist'].detail.verifiedCanonicalIds).toBe(1);
});

test('caller options cannot remove failed evidence and an omitted timestamp becomes stable at acceptance', async () => {
  load(); const payload = data(); delete payload.createdAt;
  const job = await queue.add(payload, { removeOnFail: true });
  expect(mockRawAdd.mock.calls[0][1].removeOnFail).toBe(false);
  expect(Number.isNaN(Date.parse(job.data.createdAt))).toBe(false);
  expect(require('bull').mock.calls[0][1].defaultJobOptions.removeOnFail).toBe(false);
});

test('historical failed jobs stay inspectable and block closure even when all runnable counts are zero', async () => {
  load(); const failed = { id: 'historical-failed', data: data(), failedReason: 'database unavailable' };
  mockQueue.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 1, completed: 0 });
  mockQueue.getJobs.mockResolvedValue([failed]);
  expect((await runtime.drain({ timeoutMs: 1000, close: true })).phase).toBe('failed');
  expect(mockQueue.close).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8')).participants['message-persist'].failures)
    .toContainEqual(expect.objectContaining({ jobId: 'historical-failed' }));
});

test.each(['waiting', 'active', 'delayed', 'paused', 'stalled'])('%s accepted work prevents an empty-queue shortcut', async state => {
  load();
  if (state === 'paused') mockQueue.getPausedCount.mockResolvedValue(1);
  else if (state === 'stalled') mockQueue.client.smembers.mockResolvedValue(['stalled-job']);
  else mockQueue.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, [state]: 1 });
  const result = await runtime.drain({ timeoutMs: 40, close: true });
  expect(result.phase).toBe('failed'); expect(mockQueue.close).not.toHaveBeenCalled();
});

test('an acknowledged canonical ID with no committed row fails despite zero jobs in every queue state', async () => {
  load(); await queue.add(data());
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  expect(JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8')).participants['message-persist'].failures)
    .toContainEqual(expect.objectContaining({ id: 'canonical-id', count: 0 }));
});

test('real Bull close finishes its SDK pause lifetime while awaiting disconnect and asynchronous application close effects', async () => {
  const { EventEmitter } = require('node:events'); const RealBull = jest.requireActual('bull');
  Object.setPrototypeOf(mockQueue, EventEmitter.prototype); EventEmitter.call(mockQueue);
  mockQueue.on = EventEmitter.prototype.on; mockQueue.isReady = async () => mockQueue;
  mockQueue.pause = RealBull.prototype.pause; mockQueue.close = RealBull.prototype.close;
  mockQueue._clearTimers = async () => {}; mockQueue.bclientInitialized = false;
  let disconnect, cleanup; const disconnected = new Promise(resolve => { disconnect = resolve; });
  const cleaned = new Promise(resolve => { cleanup = resolve; }); let wrote = false;
  mockQueue.disconnect = async () => { await disconnected; };
  load(); mockQueue.on('close', () => { void cleaned.then(() => { wrote = true; }); });
  const databaseClose = jest.fn(); runtime.registerParticipant('database-fixture', {
    inspect: async () => ({ pending: 0 }), close: databaseClose,
  });
  const drain = runtime.drain({ timeoutMs: 1000, close: true });
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mockQueue.closed).not.toBe(true);
  expect(databaseClose).not.toHaveBeenCalled(); disconnect();
  await new Promise(resolve => setTimeout(resolve, 30)); expect(mockQueue.closed).toBe(true);
  expect(wrote).toBe(false); expect(databaseClose).not.toHaveBeenCalled(); cleanup();
  expect((await drain).phase).toBe('closed'); expect(wrote).toBe(true); expect(databaseClose).toHaveBeenCalledTimes(1);
  // The SDK resume gate legitimately remains unresolved; no application work does.
  expect(mockQueue.paused).toBeInstanceOf(Promise); expect(runtime.snapshot().active).toEqual([]);
});

test('a local pause failure is retained instead of silently ignored by Bull close', async () => {
  load(); mockQueue.pause.mockRejectedValueOnce(new Error('queue pause unconfirmed'));
  const dependencyClose = jest.fn(); runtime.registerParticipant('dependency', { inspect: async () => ({ pending: 0 }), close: dependencyClose });
  const result = await runtime.drain({ timeoutMs: 1000, close: true }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ label: 'close:message-persist', message: 'Required effect failed' }));
  expect(mockQueue.close).not.toHaveBeenCalled(); expect(dependencyClose).not.toHaveBeenCalled();
});

test('historical Bull failure reasons retain private recovery state while operator checkpoints expose safe IDs', async () => {
  load(); const reason = 'synthetic-private-body SQL INSERT URL https://fixture.invalid/?token=synthetic-private-token';
  const failed = { id: 'historical-private-failed', data: data(), failedReason: reason };
  mockQueue.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 1, completed: 0 }); mockQueue.getJobs.mockResolvedValue([failed]);
  const result = await runtime.drain({ timeoutMs: 1000, close: true }); expect(result.phase).toBe('failed'); expect(failed.failedReason).toBe(reason);
  const checkpoint = fs.readFileSync(runtime.checkpointPath, 'utf8'); expect(checkpoint).not.toContain('synthetic-private'); expect(checkpoint).not.toContain('SQL INSERT');
  expect(JSON.parse(checkpoint).participants['message-persist'].failures).toContainEqual(expect.objectContaining({ jobId: failed.id, canonicalId: failed.data.id, message: 'Required participant effect failed' })); expect(mockQueue.close).not.toHaveBeenCalled();
});
