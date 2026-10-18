const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
let mockDirectory, runtime, wiki, camp, prisma;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/services/wikiIngestionService', () => ({ checkIngestAllowed: jest.fn(async () => null), runWikiIngestion: jest.fn(),
  runIncrementalSync: jest.fn(), WIKI_INGEST_LOCK_HELD_MESSAGE: 'Ingestion already running (Redis lock held)' }));
jest.mock('../src/services/campService', () => ({ runCampSync: jest.fn() }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { wikiImage: { findMany: jest.fn() } } }));
jest.mock('../src/config/storage', () => ({ s3: { send: jest.fn() }, BUCKET: 'fixture' }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/lib/imageStorage', () => ({ isAllowedImageHost: jest.fn(() => true), fetchRemoteImage: jest.fn(), putToMinio: jest.fn() }));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-background-effects-'));
  runtime = require('../src/runtime').runtime; wiki = require('../src/services/wikiIngestionService');
  camp = require('../src/services/campService'); prisma = require('../src/config/prisma').default;
});
afterEach(() => { runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });
function appFor(handler) {
  const app = express(); const { accountHttpIngress, instrumentHttpHandlers } = require('../src/runtime/ingress');
  app.use(accountHttpIngress(runtime)); app.use(express.json()); app.post('/', handler);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message })); instrumentHttpHandlers(app, runtime); return app;
}
async function durableFailure(label) {
  const result = await runtime.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ label, evidence: expect.objectContaining({ operationId: expect.any(String) }) }));
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  expect(restarted.isFrozen()).toBe(true); expect(restarted.snapshot().failures).toEqual(result.failures); restarted.disposeForTests();
}

test('wiki ingestion failure after HTTP202 remains accepted work and fails the durable drain', async () => {
  const gate = deferred(); wiki.runWikiIngestion.mockReturnValueOnce(gate.promise);
  const app = appFor(require('../src/controllers/wikiAdminController').triggerWikiIngest);
  expect((await request(app).post('/').send({ mode: 'full' })).status).toBe(202);
  const drain = runtime.drain({ timeoutMs: 1000 }); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.reject(new Error('catalog DB mutation failed')); expect((await drain).phase).toBe('failed');
  await durableFailure('wiki:admin-ingest');
});

test('the expected competing wiki lock skip is recorded as a skip without a required-effect failure', async () => {
  wiki.runWikiIngestion.mockRejectedValueOnce(new Error(wiki.WIKI_INGEST_LOCK_HELD_MESSAGE));
  const app = appFor(require('../src/controllers/wikiAdminController').triggerWikiIngest);
  expect((await request(app).post('/').send({ mode: 'full' })).status).toBe(202);
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained'); expect(runtime.snapshot().failures).toEqual([]);
});

test('CAMP admin sync cannot hide a failed accepted mutation in the HTTP error path', async () => {
  camp.runCampSync.mockRejectedValueOnce(new Error('CAMP DB write unavailable'));
  const app = appFor(require('../src/controllers/campAdminController').triggerCampIngest);
  expect((await request(app).post('/').send({})).status).toBe(500); await durableFailure('camp:admin-ingest');
});

test('migration image backfill query failure after HTTP202 is retained for recovery', async () => {
  const gate = deferred(); prisma.wikiImage.findMany.mockReturnValueOnce(gate.promise);
  const app = appFor(require('../src/controllers/migrationController').backfillImages);
  expect((await request(app).post('/').send({})).status).toBe(202);
  gate.reject(new Error('backfill source query unavailable')); await durableFailure('migration:backfill-images:wiki');
});
