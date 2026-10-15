const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const esbuild = require('esbuild');
const express = require('express');
let mockDirectory, runtime, storage, prisma;
const servers = [], clients = [], bodies = [], gates = [];
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { banEvidence: { findFirst: jest.fn() } } }));
jest.mock('../src/services/moderationActionsService', () => ({ ProtectedTargetError: class extends Error {} }));
jest.mock('../src/services/banEvidenceStorage', () => ({ downloadEvidence: jest.fn() }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const paths = { avatar: '/avatars/100000000000000001', party: '/party-images/10000000-0000-0000-0000-000000000001.png',
  evidence: '/evidence/10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000002' };
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-read-stream-'));
  runtime = require('../src/runtime').runtime; storage = require('../src/services/banEvidenceStorage');
  prisma = require('../src/config/prisma').default; prisma.banEvidence.findFirst.mockResolvedValue({ objectKey: 'fixture', mime: 'image/png' });
});
afterEach(async () => {
  gates.splice(0).forEach(g => g.resolve()); bodies.splice(0).forEach(b => b.destroy()); clients.splice(0).forEach(c => c.destroy());
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  await tick(); runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true });
});
function serverHandler(surface, getter) {
  if (surface === 'evidence') {
    storage.downloadEvidence.mockImplementation(async () => { const obj = await getter(); return { stream: obj.body, mime: obj.contentType, sizeBytes: obj.contentLength }; });
    return { route: '/evidence/:id/:fileId', handler: require('../src/controllers/moderationActionsController').streamBanEvidenceHandler };
  }
  // Load the actual inline registered route source; avoid executing unrelated
  // server imports/producers or introducing a production test-only export.
  const source = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
  const route = surface === 'avatar' ? '/avatars/:discordId' : '/party-images/:imageId';
  const prefix = `app.get('${route}', apiLimiter, `; const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf('\n});', start) + 2;
  const code = esbuild.transformSync(`const actual = ${source.slice(start, end)}; actual;`, { loader: 'ts', target: 'node22' }).code;
  return { route, handler: vm.runInNewContext(code, { getAvatarObject: getter, getPartyImageObject: getter,
    pipeline, logger: { warn() {} }, discordCdnAvatarUrl: async () => null }) };
}
async function start(surface, getter) {
  const closed = deferred(), response = deferred(); const { route, handler } = serverHandler(surface, getter);
  const app = express(); const { accountHttpIngress, instrumentHttpHandlers } = require('../src/runtime/ingress');
  app.use(accountHttpIngress(runtime)); app.use((req, res, next) => { req.adminUser = { role: 'owner' }; res.once('close', closed.resolve); next(); });
  app.get(route, handler); app.use((err, _req, res, _next) => { if (!res.destroyed) res.status(err.status || 500).end(); });
  instrumentHttpHandlers(app, runtime); const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  const client = http.get({ host: '127.0.0.1', port: server.address().port, path: paths[surface] }, res => {
    const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => response.resolve({ bytes: Buffer.concat(parts), status: res.statusCode, headers: res.headers }));
    res.on('error', () => {});
  }); clients.push(client); client.on('error', () => {});
  return { client, closed: closed.promise, response: response.promise };
}
test.each(Object.keys(paths))('%s stream disconnect waits for delayed actual body destruction', async surface => {
  const gate = deferred(), started = deferred(); gates.push(gate); const body = new PassThrough(); bodies.push(body); body.on('error', () => {});
  body._destroy = (err, cb) => gate.promise.then(() => cb(err));
  const { client, closed } = await start(surface, async () => { started.resolve(); return { body, contentType: 'image/png' }; });
  await started.promise; body.write('short'); client.destroy(); await closed;
  expect(body.destroyed).toBe(true); const drain = runtime.drain({ timeoutMs: 1000 }); await tick();
  expect(body.closed).toBe(false); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.resolve(); expect((await drain).phase).toBe('drained'); expect(body.closed).toBe(true); expect(runtime.snapshot().failures).toEqual([]);
});
test.each(Object.keys(paths))('%s normal stream preserves exact bytes and content headers', async surface => {
  const body = new PassThrough(); bodies.push(body); const started = deferred();
  const { response } = await start(surface, async () => { started.resolve(); return { body, contentType: 'image/png', contentLength: 5 }; });
  await started.promise; body.end('image'); const result = await response;
  expect(result.bytes).toEqual(Buffer.from('image')); expect(result.status).toBe(200); expect(result.headers['content-type']).toBe('image/png');
  expect(result.headers['content-length']).toBe('5'); expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});
test.each(Object.keys(paths))('%s source error tears down output and does not become a required-write failure', async surface => {
  const body = new PassThrough(); bodies.push(body); const started = deferred();
  const { closed } = await start(surface, async () => { started.resolve(); return { body, contentType: 'image/png' }; });
  await started.promise; body.write('short'); body.destroy(new Error('fixture body read failure')); await closed;
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained'); expect(runtime.snapshot().failures).toEqual([]);
});
