const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const http = require('node:http');
const request = require('supertest');
const { RuntimeCoordinator, MaintenanceError } = require('../src/runtime/coordinator');
const { accountHttpIngress, instrumentHttpHandlers, accountSocket, accountDiscordEmitter } = require('../src/runtime/ingress');
const { installRuntimeSignals } = require('../src/runtime/control');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let dir, runtime;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-drain-')); runtime = new RuntimeCoordinator(dir); });
afterEach(() => { runtime.disposeForTests(); fs.rmSync(dir, { recursive: true, force: true }); });

test('freeze is durable, denies new producers, and lets already admitted async descendants finish', async () => {
  const gate = deferred();
  let completed = false;
  const accepted = runtime.run('accepted-chat', async () => {
    await gate.promise;
    await runtime.required('accepted-write', async () => { completed = true; });
  });
  runtime.freeze('fixture cutover');
  expect(() => runtime.assertAdmission()).toThrow(MaintenanceError);
  const restarted = new RuntimeCoordinator(dir);
  expect(restarted.isFrozen()).toBe(true);
  restarted.disposeForTests();
  const draining = runtime.drain({ timeoutMs: 1000 });
  await pause(30);
  expect(completed).toBe(false);
  gate.resolve();
  await accepted;
  expect((await draining).phase).toBe('drained');
  const checkpoint = JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8'));
  expect(checkpoint.active).toEqual([]);
  expect(checkpoint.frozen).toBe(true);
});

test('a detached void promise remains accepted work after its callback returns', async () => {
  const gate = deferred();
  let wrote = false;
  await runtime.run('discord-gateway-callback', () => {
    void gate.promise.then(async () => {
      await pause(10);
      wrote = true;
    });
  });
  const draining = runtime.drain({ timeoutMs: 1000 });
  await pause(30);
  expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.resolve();
  expect((await draining).phase).toBe('drained');
  expect(wrote).toBe(true);
});

test.each(['initial', 'ingress-close', 'consumer-close'])('%s cannot report a stale zero queue when accepted work enqueues during inspection', async stage => {
  const enqueue = deferred(); const sampled = deferred(); const returnSample = deferred();
  const queued = []; const persisted = []; let started = false; let inspected = false; let completed = false;
  const produce = () => {
    started = true;
    return runtime.run('accepted-enqueue', async () => { await enqueue.promise; queued.push('canonical-id'); }, stage !== 'initial');
  };
  let accepted;
  if (stage === 'initial') accepted = produce();
  if (stage === 'consumer-close') runtime.registerParticipant('gateway', {
    inspect: async () => ({ pending: 0 }), close: async () => { accepted = produce(); },
  });
  runtime.registerParticipant('durable-queue', {
    inspect: async () => {
      const pending = queued.length;
      if (started && !inspected) { inspected = true; sampled.resolve(); await returnSample.promise; }
      return { pending };
    },
    close: async () => { expect(queued).toEqual([]); },
  });
  const drain = runtime.drain({ timeoutMs: 1000, close: stage === 'consumer-close',
    ...(stage === 'ingress-close' ? { closeIngress: async () => { accepted = produce(); } } : {}) });
  void drain.then(() => { completed = true; });
  try {
    await Promise.race([sampled.promise, pause(150).then(() => { throw new Error('Accepted cleanup was never reinspected'); })]);
    enqueue.resolve(); await accepted;
    expect(queued).toEqual(['canonical-id']); expect(runtime.snapshot().active).toEqual([]);
    returnSample.resolve(); await pause(35);
    expect(completed).toBe(false);
    expect(JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8')).participants['durable-queue'].pending).toBe(1);
    await runtime.run('accepted-queue-consumer', async () => { persisted.push(queued.shift()); }, true);
    expect((await drain).phase).toBe(stage === 'consumer-close' ? 'closed' : 'drained');
    expect(persisted).toEqual(['canonical-id']);
  } finally { enqueue.resolve(); returnSample.resolve(); queued.splice(0); await drain; }
});

test.each(['response', 'client-close'])('%s does not complete the asynchronous HTTP handler', async kind => {
  const gate = deferred();
  const started = deferred();
  let wrote = false;
  const app = express();
  app.use(accountHttpIngress(runtime));
  app.post('/write', async (req, res) => {
    started.resolve();
    if (kind === 'response') res.status(202).end();
    await gate.promise;
    wrote = true;
    if (!res.destroyed) res.end();
  });
  instrumentHttpHandlers(app, runtime);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/write', method: 'POST' });
    req.on('error', () => {});
    req.end();
    await started.promise;
    if (kind === 'client-close') req.destroy();
    const draining = runtime.drain({ timeoutMs: 1000 });
    await pause(30);
    expect(wrote).toBe(false);
    expect(runtime.snapshot().active.length).toBeGreaterThan(0);
    gate.resolve();
    expect((await draining).phase).toBe('drained');
    expect(wrote).toBe(true);
  } finally { gate.resolve(); await new Promise(resolve => server.close(resolve)); }
});

test.each(['completed', 'asynchronous-work-held'])('upload disconnect %s synchronizes server close and actual middleware/terminal completion', async mode => {
  const gate = deferred();
  const started = deferred();
  const serverClosed = deferred();
  const terminalStarted = deferred();
  const terminalGate = deferred();
  let terminalCompleted = false;
  let serverResponse, serverSocket;
  const app = express();
  app.use(accountHttpIngress(runtime));
  app.post('/upload', (req, res, next) => {
    serverResponse = res; serverSocket = req.socket;
    res.once('close', serverClosed.resolve);
    started.resolve(); void gate.promise.then(() => next());
  }, async (_req, res) => {
    terminalStarted.resolve();
    if (mode === 'asynchronous-work-held') await terminalGate.promise;
    terminalCompleted = true; res.end();
  });
  instrumentHttpHandlers(app, runtime);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/upload', method: 'POST' });
    req.on('error', () => {}); req.end();
    await started.promise; req.destroy();
    await serverClosed.promise;
    expect(serverResponse.destroyed).toBe(true); expect(serverSocket.destroyed).toBe(true);
    // The local destroy call alone is insufficient. At this checkpoint the
    // actual server response/socket closed, and accepted next() is still held.
    const middlewareDrain = runtime.drain({ timeoutMs: 80 }); await pause(20);
    expect(runtime.snapshot().active.length).toBeGreaterThan(0);
    expect(terminalCompleted).toBe(false); expect((await middlewareDrain).phase).toBe('failed');
    gate.resolve(); await terminalStarted.promise;
    if (mode === 'asynchronous-work-held') {
      const terminalDrain = runtime.drain({ timeoutMs: 80 }); await pause(20);
      expect(terminalCompleted).toBe(false); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
      expect((await terminalDrain).phase).toBe('failed'); terminalGate.resolve();
    }
    // A completed returned callback owns no remaining work. The held callback
    // above fails only while its real asynchronous operation is still pending.
    expect((await runtime.drain({ timeoutMs: 500 })).phase).toBe('drained');
    expect(terminalCompleted).toBe(true); expect(runtime.snapshot().active).toEqual([]);
  } finally { gate.resolve(); terminalGate.resolve(); await new Promise(resolve => server.close(resolve)); }
});

test('every HTTP path including GET mutations, admin, uploads and MCP receives an explicit refusal', async () => {
  let writes = 0;
  const app = express();
  app.use(accountHttpIngress(runtime));
  app.use((_req, res) => { writes++; res.status(200).end(); });
  runtime.freeze('test');
  for (const url of ['/auth/callback', '/api/admin/status', '/admin/upload-release', '/mcp', '/api/mcp']) {
    const response = await request(app).get(url);
    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.body.code).toBe('maintenance');
  }
  expect(writes).toBe(0);
});

test('a synchronous middleware may spawn accepted work after next() already finishes the response', async () => {
  const gate = deferred(); let wrote = false;
  const app = express(); app.use(accountHttpIngress(runtime));
  app.use((_req, _res, next) => { next(); void gate.promise.then(() => { wrote = true; }); });
  app.get('/', (_req, res) => res.status(202).end()); instrumentHttpHandlers(app, runtime);
  await request(app).get('/');
  const draining = runtime.drain({ timeoutMs: 1000 }); await pause(30);
  expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  expect(wrote).toBe(false); gate.resolve();
  expect((await draining).phase).toBe('drained'); expect(wrote).toBe(true);
});

test.each(['ws', 'relay'])('%s refuses an existing session and accounts asynchronous close cleanup', async transport => {
  const socket = new EventEmitter(); socket.readyState = 1; socket.send = jest.fn();
  accountSocket(socket, runtime, transport);
  const gate = deferred(); let wrote = false;
  socket.on('message', async () => { wrote = true; });
  socket.on('close', () => { void gate.promise.then(() => { wrote = true; }); });
  runtime.freeze('test');
  socket.emit('message', Buffer.from('{}'));
  expect(wrote).toBe(false);
  expect(JSON.stringify(socket.send.mock.calls)).toContain('maintenance');
  const draining = runtime.drain({ timeoutMs: 1000, closeIngress: async () => { socket.emit('close'); } });
  await pause(30); expect(wrote).toBe(false);
  gate.resolve();
  expect((await draining).phase).toBe('drained');
  expect(wrote).toBe(true);
});

test('Discord feature callbacks freeze together and retain detached accepted work', async () => {
  const client = new EventEmitter(); accountDiscordEmitter(client, runtime);
  const gate = deferred(); let writes = 0;
  for (const event of ['messageCreate', 'messageUpdate', 'messageReactionAdd', 'guildMemberUpdate', 'voiceStateUpdate', 'interactionCreate']) {
    client.on(event, () => { writes++; void gate.promise.then(() => { writes++; }); });
  }
  client.emit('messageCreate');
  runtime.freeze('test');
  for (const event of ['messageCreate', 'messageUpdate', 'messageReactionAdd', 'guildMemberUpdate', 'voiceStateUpdate']) client.emit(event);
  const interaction = { reply: jest.fn().mockResolvedValue(undefined) };
  client.emit('interactionCreate', interaction);
  expect(writes).toBe(1);
  expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('retry') }));
  const draining = runtime.drain({ timeoutMs: 1000 });
  gate.resolve();
  expect((await draining).phase).toBe('drained'); expect(writes).toBe(2);
});

test('queue in-flight operations, failed jobs and ambiguous Discord failures prevent a clean drain', async () => {
  const close = jest.fn();
  runtime.registerParticipant('queue', { inspect: async () => ({ pending: 0, failures: [{ jobId: 7 }] }), close });
  const result = await runtime.drain({ timeoutMs: 1000, close: true });
  expect(result.phase).toBe('failed'); expect(close).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(runtime.checkpointPath, 'utf8')).participants.queue.failures).toEqual([expect.objectContaining({ jobId: 7, message: 'Required participant effect failed' })]);
});

test('a swallowed required-effect failure is durable and does not become success on restart', async () => {
  await runtime.required('discord:send-succeeded-link-unconfirmed', async () => { throw new Error('link database unavailable'); },
    { canonicalId: 'canonical', discordMessageId: 'discord' }).catch(() => {});
  const close = jest.fn(); runtime.registerParticipant('dependencies', { inspect: async () => ({ pending: 0 }), close });
  expect((await runtime.drain({ timeoutMs: 1000, close: true })).phase).toBe('failed');
  expect(close).not.toHaveBeenCalled();
  const restarted = new RuntimeCoordinator(dir);
  expect(restarted.isFrozen()).toBe(true);
  expect(restarted.snapshot().failures[0].evidence.discordMessageId).toBe('discord');
  restarted.disposeForTests();
});

test('timeout preserves outstanding work and dependencies, and a later verified retry can complete', async () => {
  const gate = deferred(); const close = jest.fn();
  const accepted = runtime.run('accepted', () => gate.promise);
  runtime.registerParticipant('dependencies', { inspect: async () => ({ pending: 0 }), close });
  const failed = await runtime.drain({ timeoutMs: 40, close: true });
  expect(failed.phase).toBe('failed'); expect(failed.active.length).toBeGreaterThan(0); expect(close).not.toHaveBeenCalled();
  gate.resolve(); await accepted;
  expect((await runtime.drain({ timeoutMs: 1000, close: true })).phase).toBe('closed');
  expect(close).toHaveBeenCalledTimes(1);
});

test('SIGTERM freezes synchronously and exits only after accepted work, socket cleanup, then dependency close', async () => {
  const signals = new EventEmitter(); const acceptedGate = deferred(); const closeGate = deferred(); const order = [];
  const accepted = runtime.run('accepted', async () => { await acceptedGate.promise; order.push('accepted'); });
  runtime.registerParticipant('dependencies', { inspect: async () => ({ pending: 0 }), close: async () => { order.push('dependencies'); } });
  const exit = jest.fn(() => order.push('exit'));
  installRuntimeSignals(runtime, async () => { await runtime.run('socket:cleanup', () => closeGate.promise, true); order.push('sockets'); }, exit, signals);
  signals.emit('SIGTERM');
  expect(runtime.isFrozen()).toBe(true); expect(exit).not.toHaveBeenCalled();
  acceptedGate.resolve(); await accepted; await pause(30);
  expect(order).toEqual(['accepted']);
  closeGate.resolve(); await pause(60);
  expect(order).toEqual(['accepted', 'sockets', 'dependencies', 'exit']);
});
