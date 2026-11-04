const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let mockDirectory, runtime, prisma, storage, fileType;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory,
  MINIO_PUBLIC_URL: 'https://fixture.test', MINIO_ENDPOINT: 'https://fixture.test', DEV_USER_ROLE: 'user' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { session: { create: jest.fn() },
  user: { upsert: jest.fn(async () => ({})), findUnique: jest.fn(async () => ({ id: 'fixture-user' })) } } }));
jest.mock('../src/config/redis', () => ({ getRedisClient: jest.fn(async () => ({ set: jest.fn(async () => {}) })) }));
jest.mock('../src/config/storage', () => ({ s3: { send: jest.fn() }, BUCKET: 'fixture', ensureBucket: jest.fn(async () => {}) }));
jest.mock('../src/services/avatarService', () => ({ captureAvatar: jest.fn() }));
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-persistent-effects-'));
  runtime = require('../src/runtime').runtime; prisma = require('../src/config/prisma').default;
  storage = require('../src/config/storage'); fileType = require('file-type');
  fileType.fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png' });
});
afterEach(() => { runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });

test.each(['qa', 'dev-persona'])('%s keeps acknowledged background session persistence accounted and failure durable without retaining credentials', async source => {
  const gate = deferred(); prisma.session.create.mockReturnValueOnce(gate.promise);
  const mint = source === 'qa'
    ? () => require('../src/controllers/qaOAuthController').defaultQaCallbackDeps.mintSession('fixture-user')
    : () => require('../src/controllers/devPersonaLoginController').defaultDevPersonaCallbackDeps.issueSession('fixture-install', 'user');
  const grant = await runtime.run('accepted-auth', mint); const token = source === 'qa' ? grant : grant.token;
  const drain = runtime.drain({ timeoutMs: 1000 }); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
  gate.reject(new Error('session DB persistence unavailable')); const result = await drain;
  expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ label: 'session:persist',
    evidence: expect.objectContaining({ userId: 'fixture-user', source }) }));
  expect(JSON.stringify(result.failures)).not.toContain(token);
  const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const restarted = new RuntimeCoordinator(mockDirectory);
  expect(restarted.isFrozen()).toBe(true); expect(restarted.snapshot().failures).toEqual(result.failures); restarted.disposeForTests();
});

test('a failed report object upload keeps its generated object identifier for ambiguous-effect recovery', async () => {
  storage.s3.send.mockRejectedValueOnce(new Error('object put response lost'));
  const { uploadReportImages } = require('../src/services/reportImageService');
  await expect(uploadReportImages([Buffer.from('fixture-image')])).rejects.toThrow('response lost');
  const result = await runtime.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ label: 'report-image:put', evidence: {
    objectKey: expect.stringMatching(/^report-images\/.+\.png$/), stage: 'object-put-result-unknown' } }));
});

test('expected invalid upload content is refused before a required object write without marking the drain failed', async () => {
  fileType.fileTypeFromBuffer.mockResolvedValueOnce(null);
  const { uploadReportImages, ImageUploadError } = require('../src/services/reportImageService');
  await expect(uploadReportImages([Buffer.from('invalid-image')])).rejects.toBeInstanceOf(ImageUploadError);
  expect(storage.s3.send).not.toHaveBeenCalled(); expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});
