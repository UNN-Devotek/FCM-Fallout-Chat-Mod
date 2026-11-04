const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const tar = require('tar-stream');
let mockDirectory, runtime, spawn, storage;
const servers = [], clients = [], children = [], uploads = [];
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/storage', () => ({ s3: { send: jest.fn() }, BUCKET: 'fixture' }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('../src/lib/imageStorage', () => ({}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Fixture condition did not complete');
}
function childFixture() {
  const child = new EventEmitter(); child.pid = 12345;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.resume(); child.kill = jest.fn(() => true); children.push(child); return child;
}
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-migration-callback-'));
  runtime = require('../src/runtime').runtime; storage = require('../src/config/storage'); spawn = require('child_process').spawn;
  process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
});
const originalDatabaseUrl = process.env.DATABASE_URL;
afterEach(async () => {
  for (const child of children.splice(0)) child.emit('close', 0, null);
  for (const gate of uploads.splice(0)) gate.resolve({});
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await tick(); runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
});
async function start(handlerName, contentType, body, { raw = false, end = true } = {}) {
  const { accountHttpIngress, instrumentHttpHandlers } = require('../src/runtime/ingress');
  const app = express(); app.use(accountHttpIngress(runtime));
  const closed = deferred(); app.use((_req, res, next) => { res.once('close', closed.resolve); next(); });
  if (raw) app.use(express.raw({ type: 'application/sql' }));
  app.post('/', require('../src/controllers/migrationController')[handlerName]);
  app.use((err, _req, res, _next) => { if (!res.destroyed) res.status(500).json({ error: err.message }); });
  instrumentHttpHandlers(app, runtime);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  const response = deferred();
  const client = http.request({ host: '127.0.0.1', port: server.address().port, path: '/', method: 'POST',
    headers: { 'Content-Type': contentType } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => response.resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    res.on('error', () => {});
  });
  clients.push(client); client.on('error', () => {});
  if (end) client.end(body); else client.write(body);
  return { client, response: response.promise, closed: closed.promise };
}
async function archive(entries) {
  const pack = tar.pack(); const chunks = []; pack.on('data', chunk => chunks.push(chunk));
  const ended = new Promise(resolve => pack.once('end', resolve));
  for (const [name, data] of entries) pack.entry({ name, size: data.length }, data);
  pack.finalize(); await ended; return Buffer.concat(chunks);
}
test('an accepted psql restore survives client disconnect and freeze until the child is verified closed', async () => {
  const child = childFixture(); spawn.mockReturnValueOnce(child);
  const { client, closed } = await start('restoreDatabase', 'application/sql', Buffer.from('SELECT 1;'), { raw: true });
  await until(() => child.stdin.writableFinished); client.destroy(); await closed;
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick();
  expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  expect(child.kill).not.toHaveBeenCalled();
  child.emit('close', 0, null);
  expect((await drain).phase).toBe('drained');
});
test('a held storage PUT remains accepted work after client disconnect and freeze', async () => {
  const gate = deferred(); uploads.push(gate); storage.s3.send.mockReturnValueOnce(gate.promise);
  const body = await archive([['wiki-images/fixture.png', Buffer.from('image')]]);
  const { client, closed } = await start('restoreStorage', 'application/x-tar', body);
  await until(() => storage.s3.send.mock.calls.length === 1); client.destroy(); await closed;
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick();
  expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.resolve({}); expect((await drain).phase).toBe('drained');
});

test('database restore preserves its response format and handles a repeated close only once', async () => {
  const child = childFixture(); spawn.mockReturnValueOnce(child);
  const { response } = await start('restoreDatabase', 'application/sql', Buffer.from('SELECT 1;'), { raw: true });
  await until(() => child.stdin.writableFinished);
  child.stdout.write('SELECT 1\n'); child.emit('exit', 0, null); child.emit('close', 0, null); child.emit('close', 0, null);
  expect(await response).toEqual({ status: 200, body: JSON.stringify({ ok: true, output: 'SELECT 1\n' }) });
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});

test.each([[1, null], [null, 'SIGTERM'], [null, null]])('psql close (%s,%s) records a durable unconfirmed restore instead of draining', async (code, signal) => {
  const child = childFixture(); spawn.mockReturnValueOnce(child);
  const { response } = await start('restoreDatabase', 'application/sql', Buffer.from('SELECT 1;'), { raw: true });
  await until(() => child.stdin.writableFinished); child.stderr.write('fixture SQL failure'); child.emit('close', code, signal);
  expect((await response).status).toBe(500);
  await expectFailure('migration:database-restore', 'child-close-failed');
});

test('psql exit and spawn error do not release an unknown child before close, or double-send the error response', async () => {
  const child = childFixture(); spawn.mockReturnValueOnce(child);
  const { response } = await start('restoreDatabase', 'application/sql', Buffer.from('SELECT 1;'), { raw: true });
  await until(() => child.stdin.writableFinished);
  child.emit('error', Object.assign(new Error('binary missing'), { code: 'ENOENT' })); child.emit('exit', -2, null);
  expect((await response).status).toBe(503);
  const unknown = await runtime.drain({ timeoutMs: 30 });
  expect(unknown.phase).toBe('failed'); expect(unknown.active.length).toBeGreaterThan(0);
  child.emit('close', -2, null); await until(() => runtime.snapshot().active.length === 0);
  await expectFailure('migration:database-restore', 'child-error');
});

test('a synchronous psql spawn exception is a durable restore failure with the normal error path', async () => {
  spawn.mockImplementationOnce(() => { throw new Error('fixture spawn failure'); });
  expect((await (await start('restoreDatabase', 'application/sql', Buffer.from('SELECT 1;'), { raw: true })).response).status).toBe(500);
  await expectFailure('migration:database-restore', 'spawn-threw');
});

test('psql stdin failure retains the child until close and fails even if its close code is zero', async () => {
  const child = childFixture(); spawn.mockReturnValueOnce(child);
  const { client } = await start('restoreDatabase', 'application/sql', Buffer.from('SELECT 1;'), { raw: true });
  await until(() => child.stdin.writableFinished); client.destroy();
  child.stdin.emit('error', new Error('fixture broken pipe'));
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick(); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  child.emit('close', 0, null); expect((await drain).phase).toBe('failed');
  await expectFailure('migration:database-restore', 'stdin-write-unconfirmed');
});

test('an incomplete fallback SQL request terminates input but keeps the accepted child tracked until close', async () => {
  const child = childFixture(); spawn.mockReturnValueOnce(child); let bytes = 0; child.stdin.on('data', chunk => { bytes += chunk.length; });
  const { client } = await start('restoreDatabase', 'text/fixture-stream', Buffer.from('partial SQL'), { end: false });
  await until(() => bytes > 0); client.destroy(); await until(() => child.kill.mock.calls.length > 0);
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick(); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  child.emit('close', 0, null); expect((await drain).phase).toBe('failed');
  await expectFailure('migration:database-restore', 'request-input-incomplete');
});

test('storage restore preserves its counters and object allowlist without turning rejected keys into failures', async () => {
  storage.s3.send.mockResolvedValue({});
  const body = await archive([['wiki-images/ok.png', Buffer.from('image')], ['../unsafe.png', Buffer.from('bad')],
    ['camp-images/ok.webp', Buffer.from('camp')], ['wiki-images/nested/no.png', Buffer.from('bad')]]);
  const result = await (await start('restoreStorage', 'application/x-tar', body)).response;
  expect(result).toEqual({ status: 200, body: JSON.stringify({ data: { restored: 2, rejected: 2, failed: 0 } }) });
  expect(storage.s3.send.mock.calls.map(([command]) => command.input.Key)).toEqual(['wiki-images/ok.png', 'camp-images/ok.webp']);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});

test('an unconfirmed object PUT retains its key and failure even when the endpoint returns its failure counter', async () => {
  storage.s3.send.mockRejectedValueOnce(new Error('fixture object PUT response lost'));
  const body = await archive([['wiki-images/fixture.png', Buffer.from('image')]]);
  const result = await (await start('restoreStorage', 'application/x-tar', body)).response;
  expect(result).toEqual({ status: 200, body: JSON.stringify({ data: { restored: 0, rejected: 0, failed: 1 } }) });
  await expectFailure('migration:storage-restore:put', 'object-put-result-unknown', 'wiki-images/fixture.png');
});

test('a truncated allowed tar entry is refused before PUT and retains a durable incomplete-entry failure', async () => {
  const body = await archive([['wiki-images/truncated.png', Buffer.from('image')]]);
  const result = await (await start('restoreStorage', 'application/x-tar', body.subarray(0, 514))).response;
  expect(result.status).toBe(400); expect(storage.s3.send).not.toHaveBeenCalled();
  await expectFailure('migration:storage-restore', 'archive-or-entry-incomplete', 'wiki-images/truncated.png');
});

test('incomplete request input cannot drop an already accepted PUT or become a successful drain after PUT finishes', async () => {
  const gate = deferred(); uploads.push(gate); storage.s3.send.mockReturnValueOnce(gate.promise);
  const body = await archive([['camp-images/fixture.png', Buffer.from('image')]]);
  const { client } = await start('restoreStorage', 'application/x-tar', body.subarray(0, 1024), { end: false });
  await until(() => storage.s3.send.mock.calls.length === 1); client.destroy();
  await until(() => runtime.snapshot().failures.length > 0);
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick(); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.resolve({}); expect((await drain).phase).toBe('failed');
  await expectFailure('migration:storage-restore', 'request-input-incomplete', 'camp-images/fixture.png');
});

test('a freeze between archive entries lets every already admitted PUT complete exactly once', async () => {
  const first = deferred(), second = deferred(); uploads.push(first, second);
  storage.s3.send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const body = await archive([['wiki-images/first.png', Buffer.from('first')], ['camp-images/second.png', Buffer.from('second')]]);
  const { client, closed } = await start('restoreStorage', 'application/x-tar', body);
  await until(() => storage.s3.send.mock.calls.length === 1); client.destroy(); await closed;
  const drain = runtime.drain({ timeoutMs: 1000 }); first.resolve({});
  await until(() => storage.s3.send.mock.calls.length === 2); await tick();
  expect(runtime.snapshot().active.length).toBeGreaterThan(0); second.resolve({});
  expect((await drain).phase).toBe('drained');
  expect(storage.s3.send.mock.calls.map(([command]) => command.input.Key)).toEqual(['wiki-images/first.png', 'camp-images/second.png']);
});

test('a malformed archive after a confirmed PUT keeps the successful object and blocks a clean drain', async () => {
  storage.s3.send.mockResolvedValueOnce({});
  const body = await archive([['wiki-images/confirmed.png', Buffer.from('image')]]);
  const malformed = Buffer.concat([body.subarray(0, 1024), Buffer.alloc(512, 1)]);
  const result = await (await start('restoreStorage', 'application/x-tar', malformed)).response;
  expect(result.status).toBe(400); expect(storage.s3.send).toHaveBeenCalledTimes(1);
  await expectFailure('migration:storage-restore', 'archive-or-entry-incomplete');
});

test('a tar entry stream error is caught and cannot report successful archive completion', async () => {
  const tarModule = require('tar-stream'); const extract = tarModule.extract();
  jest.spyOn(tarModule, 'extract').mockReturnValueOnce(extract);
  extract.once('entry', (_header, stream) => { setImmediate(() => stream.destroy(new Error('fixture entry error'))); });
  // Keep the entry incomplete so its error precedes any object write.
  const body = await archive([['wiki-images/fixture.png', Buffer.from('image')]]);
  const { response } = await start('restoreStorage', 'application/x-tar', body.subarray(0, 514), { end: false });
  expect((await response).status).toBe(400); expect(storage.s3.send).not.toHaveBeenCalled();
  await expectFailure('migration:storage-restore', 'archive-or-entry-incomplete', 'wiki-images/fixture.png');
});

test('a parser close without finish is retained as unknown completion, even without a parser error event', async () => {
  const tarModule = require('tar-stream'); const extract = tarModule.extract();
  jest.spyOn(tarModule, 'extract').mockReturnValueOnce(extract);
  extract.once('entry', () => { setImmediate(() => extract.destroy()); });
  const body = await archive([['wiki-images/fixture.png', Buffer.from('image')]]);
  expect((await (await start('restoreStorage', 'application/x-tar', body.subarray(0, 514), { end: false })).response).status).toBe(400);
  expect(storage.s3.send).not.toHaveBeenCalled(); await expectFailure('migration:storage-restore', 'archive-or-entry-incomplete');
});

async function expectFailure(label, stage, objectKey) {
  const result = await runtime.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ label,
    evidence: expect.objectContaining({ operationId: expect.any(String), stage, ...(objectKey ? { objectKey } : {}) }) }));
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  expect(restarted.isFrozen()).toBe(true); expect(restarted.snapshot().failures).toEqual(result.failures); restarted.disposeForTests();
}

test('a disconnected pg_dump export terminates its read child but waits for verified close before drain', async () => {
  const child = childFixture(); spawn.mockReturnValueOnce(child);
  const { client, closed } = await start('dumpDatabase', 'application/json', Buffer.from('{}'));
  await until(() => spawn.mock.calls.length === 1); child.stdout.write('fixture dump'); client.destroy(); await closed;
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick();
  expect(runtime.snapshot().active.length).toBeGreaterThan(0); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  child.emit('close', null, 'SIGTERM'); expect((await drain).phase).toBe('drained');
});

test('a disconnected storage dump cancels the object body instead of retaining an orphaned read forever', async () => {
  const body = new PassThrough(); body.on('error', () => {});
  storage.s3.send.mockResolvedValueOnce({ Contents: [{ Key: 'wiki-images/fixture.png', Size: 10 }] })
    .mockResolvedValueOnce({ Body: body, ContentLength: 10 });
  const { client, closed } = await start('dumpStorage', 'application/json', Buffer.from('{}'));
  await until(() => storage.s3.send.mock.calls.length === 2); body.write('short'); client.destroy(); await closed;
  try {
    expect(body.destroyed).toBe(true); expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  } finally { body.destroy(); }
});

test('a normal pg_dump response cannot release the child before close, while read cancellation creates no sticky write failure', async () => {
  const child = childFixture(); spawn.mockReturnValueOnce(child);
  const { response } = await start('dumpDatabase', 'application/json', Buffer.from('{}'));
  await until(() => spawn.mock.calls.length === 1); child.stdout.end('fixture complete dump');
  expect(await response).toEqual({ status: 200, body: 'fixture complete dump' });
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick(); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  expect(child.kill).not.toHaveBeenCalled(); child.emit('close', 0, null);
  expect((await drain).phase).toBe('drained'); expect(runtime.snapshot().failures).toEqual([]);
});

test('a storage dump object closing prematurely is handled without an orphaned read or unhandled stream error', async () => {
  const body = new PassThrough(); body.on('error', () => {});
  storage.s3.send.mockResolvedValueOnce({ Contents: [{ Key: 'wiki-images/fixture.png', Size: 10 }] })
    .mockResolvedValueOnce({ Body: body, ContentLength: 10 });
  const { closed } = await start('dumpStorage', 'application/json', Buffer.from('{}'));
  await until(() => storage.s3.send.mock.calls.length === 2); body.destroy(); await closed;
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  expect(runtime.snapshot().failures).toEqual([]);
});

test('storage dump aborts its pending read command on output disconnect and still awaits command settlement', async () => {
  const gate = deferred(); uploads.push(gate); let signal;
  storage.s3.send.mockImplementationOnce((_command, options) => { signal = options.abortSignal; return gate.promise; });
  const { client, closed } = await start('dumpStorage', 'application/json', Buffer.from('{}'));
  await until(() => signal !== undefined); client.destroy(); await closed;
  expect(signal.aborted).toBe(true);
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick(); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.reject(new Error('fixture read command aborted'));
  expect((await drain).phase).toBe('drained'); expect(runtime.snapshot().failures).toEqual([]);
});

test('storage dump retains a canceled object read until its delayed body destruction closes', async () => {
  const gate = deferred(); uploads.push(gate); const body = new PassThrough(); body.on('error', () => {});
  body._destroy = (error, callback) => { gate.promise.then(() => callback(error)); };
  storage.s3.send.mockResolvedValueOnce({ Contents: [{ Key: 'wiki-images/fixture.png', Size: 10 }] })
    .mockResolvedValueOnce({ Body: body, ContentLength: 10 });
  const { client, closed } = await start('dumpStorage', 'application/json', Buffer.from('{}'));
  await until(() => storage.s3.send.mock.calls.length === 2); body.write('short'); client.destroy(); await closed;
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick(); await tick();
  expect(body.closed).toBe(false); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.resolve(); expect((await drain).phase).toBe('drained'); expect(body.closed).toBe(true);
});
