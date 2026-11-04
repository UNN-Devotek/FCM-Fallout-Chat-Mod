const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let mockDirectory, runtime, prisma, storage, images;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { wikiImage: { findMany: jest.fn() }, $queryRaw: jest.fn() } }));
jest.mock('../src/config/storage', () => ({ s3: { send: jest.fn() }, BUCKET: 'fixture' }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/lib/imageStorage', () => ({ isAllowedImageHost: jest.fn(), fetchRemoteImage: jest.fn(), putToMinio: jest.fn() }));
beforeEach(() => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-backfill-completion-'));
  runtime = require('../src/runtime').runtime; prisma = require('../src/config/prisma').default;
  storage = require('../src/config/storage'); images = require('../src/lib/imageStorage');
  images.isAllowedImageHost.mockReturnValue(true); images.fetchRemoteImage.mockResolvedValue({ buf: Buffer.from('image'), contentType: 'image/png' });
  images.putToMinio.mockResolvedValue(true); prisma.$queryRaw.mockResolvedValue([]);
});
afterEach(() => { runtime.disposeForTests(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });
test.each(['existing', 'rejected', 'missing-key', 'fetch-failed', 'put-failed'])('backfill processes rows after its first six %s rows', async mode => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `fixture-${i}`, url: `https://fixture/wiki-images/${i}.png`, sourceUrl: `https://allowed/${i}.png` }));
  if (mode === 'missing-key') rows.slice(0, 6).forEach(row => { row.url = 'https://fixture/no-key'; });
  prisma.wikiImage.findMany.mockResolvedValue(rows);
  storage.s3.send.mockImplementation(async command => {
    if (mode === 'existing' && Number(command.input.Key.split('/')[1].split('.')[0]) < 6) return {};
    throw new Error('fixture object not found');
  });
  if (mode === 'rejected') images.isAllowedImageHost.mockImplementation(url => Number(url.split('/').pop().split('.')[0]) >= 6);
  if (mode === 'fetch-failed') images.fetchRemoteImage.mockImplementation(async url => Number(url.split('/').pop().split('.')[0]) < 6 ? null : { buf: Buffer.from('image'), contentType: 'image/png' });
  if (mode === 'put-failed') images.putToMinio.mockImplementation(async key => Number(key.split('/').pop().split('.')[0]) >= 6);
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await runtime.run('fixture:backfill', () => require('../src/controllers/migrationController').backfillImages({ body: {}, ip: '127.0.0.1' }, response, () => {}));
  const result = await runtime.drain({ timeoutMs: 1000 });
  expect(response.status).toHaveBeenCalledWith(202);
  expect(images.putToMinio.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining(['wiki-images/6.png', 'wiki-images/7.png', 'wiki-images/8.png']));
  expect(result.phase).toBe(['existing', 'rejected'].includes(mode) ? 'drained' : 'failed');
  if (result.phase === 'failed') expect(result.failures).toHaveLength(6);
});
