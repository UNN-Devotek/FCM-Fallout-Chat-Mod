const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const express = require('express');
const request = require('supertest');
let mockDirectory, runtime, storage, prisma;
const servers = [], clients = [], bodies = [], gates = [];
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/storage', () => ({ getEmbedAssetObject: jest.fn() }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { embedAsset: { findFirst: jest.fn() } } }));
jest.mock('../src/services/embedAssetService', () => ({ EmbedAssetError: class extends Error {}, importEmbedAsset: jest.fn() }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const assetId = '10000000-0000-4000-8000-000000000001';
const filename = `${'a'.repeat(64)}.png`;
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-controller-stream-'));
  runtime = require('../src/runtime').runtime; storage = require('../src/config/storage'); prisma = require('../src/config/prisma').default;
  prisma.embedAsset.findFirst.mockResolvedValue({ mimeType: 'image/png', objectKey: `embed-assets/${filename}` });
});
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve();
  for (const body of bodies.splice(0)) body.destroy();
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await tick(); runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true });
});
function appFor() {
  const app = express(); const { accountHttpIngress, instrumentHttpHandlers } = require('../src/runtime/ingress');
  app.use(accountHttpIngress(runtime)); app.get('/:id/:filename', require('../src/controllers/embedAssetController').serveEmbedAsset);
  instrumentHttpHandlers(app, runtime); return app;
}
test('a disconnected embed-asset read remains accounted until its asynchronous body destruction actually closes', async () => {
  const gate = deferred(), readStarted = deferred(), teardown = deferred(); gates.push(gate);
  const body = new PassThrough(); bodies.push(body);
  body._destroy = (error, callback) => { teardown.resolve(); gate.promise.then(() => callback(error)); };
  storage.getEmbedAssetObject.mockImplementationOnce(async () => { readStarted.resolve(); return { body }; });
  const app = appFor(); const closed = deferred();
  // Observe the actual response close rather than treating client.destroy as server completion.
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  server.on('request', (_req, res) => res.once('close', closed.resolve));
  await new Promise(resolve => server.once('listening', resolve));
  const client = http.get({ host: '127.0.0.1', port: server.address().port, path: `/${assetId}/${filename}` });
  clients.push(client); client.on('error', () => {});
  await readStarted.promise; body.write('short'); client.destroy(); await closed.promise;
  expect(body.destroyed).toBe(true); await teardown.promise;
  const drain = runtime.drain({ timeoutMs: 1000 }); await tick();
  expect(body.closed).toBe(false); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.resolve(); expect((await drain).phase).toBe('drained');
  expect(body.closed).toBe(true); expect(runtime.snapshot().failures).toEqual([]);
});
test('a normal embed-asset stream preserves bytes, content headers and public filename validation', async () => {
  const body = new PassThrough(); bodies.push(body); storage.getEmbedAssetObject.mockResolvedValueOnce({ body, contentLength: 5 });
  const pending = request(appFor()).get(`/${assetId}/${filename}`).buffer(true).then(result => result);
  await tick(); body.end('image'); const result = await pending;
  expect(result.status).toBe(200); expect(result.body).toEqual(Buffer.from('image'));
  expect(result.headers['content-type']).toBe('image/png'); expect(result.headers['content-length']).toBe('5');
  expect(result.headers['x-content-type-options']).toBe('nosniff');
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});
test('an embed-asset body read error closes output without an unhandled exception or required write failure', async () => {
  const body = new PassThrough(); bodies.push(body); const started = deferred();
  storage.getEmbedAssetObject.mockImplementationOnce(async () => { started.resolve(); return { body }; });
  const pending = request(appFor()).get(`/${assetId}/${filename}`).then(() => null, err => err);
  await started.promise; body.destroy(new Error('fixture object body read failure'));
  expect(await pending).toEqual(expect.objectContaining({ message: expect.any(String) }));
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained'); expect(runtime.snapshot().failures).toEqual([]);
});
