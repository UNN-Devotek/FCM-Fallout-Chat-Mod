const { Readable, Writable } = require('node:stream');
const prismaMock = { embedAsset: { findFirst: jest.fn() } };
const storageMock = { getEmbedAssetObject: jest.fn() };
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../src/config/storage', () => storageMock);

const { serveEmbedAsset } = require('../src/controllers/embedAssetController');

function response() {
  const headers = {};
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  return Object.assign(res, {
    headers,
    chunks,
    statusCode: 200,
    setHeader: (key, value) => { headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
  });
}

describe('public embed asset serving', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the database object key and immutable nosniff headers', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const digest = 'a'.repeat(64);
    prismaMock.embedAsset.findFirst.mockResolvedValue({ objectKey: `embed-assets/${digest}.png`, mimeType: 'image/png' });
    const body = Readable.from([Buffer.from('fixture-data')]);
    storageMock.getEmbedAssetObject.mockResolvedValue({ body, contentLength: 12 });
    const res = response();
    await serveEmbedAsset({ params: { id, filename: `${digest}.png` } }, res);
    expect(storageMock.getEmbedAssetObject).toHaveBeenCalledWith(`embed-assets/${digest}.png`);
    expect(prismaMock.embedAsset.findFirst).toHaveBeenCalledWith({ where: { id, sha256: digest, status: 'ready' } });
    expect(res.headers).toMatchObject({
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  it('rejects path-shaped and mismatched identifiers before storage', async () => {
    const res = response();
    await serveEmbedAsset({ params: { id: '..', filename: '../../secret' } }, res);
    expect(res.statusCode).toBe(404);
    expect(prismaMock.embedAsset.findFirst).not.toHaveBeenCalled();
    expect(storageMock.getEmbedAssetObject).not.toHaveBeenCalled();
  });

  it('rejects a filename extension or digest that differs from persisted objectKey', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const digest = 'a'.repeat(64);
    prismaMock.embedAsset.findFirst.mockResolvedValue({ objectKey: `embed-assets/${digest}.png`, mimeType: 'image/png' });
    for (const filename of [`${digest}.gif`, `${'b'.repeat(64)}.png`]) {
      const res = response();
      await serveEmbedAsset({ params: { id, filename } }, res);
      expect(res.statusCode).toBe(404);
    }
    expect(storageMock.getEmbedAssetObject).not.toHaveBeenCalled();
  });

  it('serves persisted bytes without consulting the original source URL', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const digest = 'c'.repeat(64);
    const body = Readable.from([Buffer.from('stored fixture bytes')]);
    prismaMock.embedAsset.findFirst.mockResolvedValue({
      objectKey: `embed-assets/${digest}.webp`, mimeType: 'image/webp', originalHost: 'now-offline.example',
    });
    storageMock.getEmbedAssetObject.mockResolvedValue({ body });
    const res = response();
    await serveEmbedAsset({ params: { id, filename: `${digest}.webp` } }, res);
    expect(Buffer.concat(res.chunks)).toEqual(Buffer.from('stored fixture bytes'));
  });

  it('forces non-image uploads to download in a sandboxed response', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const digest = 'd'.repeat(64);
    const body = Readable.from([Buffer.from('fixture pdf')]);
    prismaMock.embedAsset.findFirst.mockResolvedValue({ objectKey: `embed-assets/${digest}.pdf`, mimeType: 'application/pdf' });
    storageMock.getEmbedAssetObject.mockResolvedValue({ body, contentLength: 20 });
    const res = response();
    await serveEmbedAsset({ params: { id, filename: `${digest}.pdf` } }, res);
    expect(res.headers).toMatchObject({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${digest}.pdf"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
  });
});
