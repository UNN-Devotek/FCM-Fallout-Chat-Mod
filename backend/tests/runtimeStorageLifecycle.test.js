const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
let mockDirectory, mockEndpoint;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory,
  MINIO_ENDPOINT: mockEndpoint, MINIO_ROOT_USER: 'fixture-access', MINIO_ROOT_PASSWORD: 'fixture-secret', MINIO_BUCKET: 'fixture' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

test('a completed real S3 upload avoids the 100-continue SDK lifetime and a pending upload still prevents drain', async () => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-s3-lifetime-'));
  const sockets = new Set(); let completeUpload; let receivedUpload; let holdResponse = false; let runtime; let s3;
  const server = http.createServer((req, res) => {
    expect(req.headers.expect).toBeUndefined();
    let size = 0; req.on('data', chunk => { size += chunk.length; }); req.on('end', () => {
      expect(size).toBeGreaterThanOrEqual(2_097_152);
      const reply = () => { if (!res.writableEnded && !res.destroyed) res.writeHead(200, { ETag: '"fixture-etag"', 'Content-Length': '0' }).end(); };
      if (holdResponse) { completeUpload = reply; receivedUpload(); } else reply();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); mockEndpoint = `http://127.0.0.1:${server.address().port}`;
    runtime = require('../src/runtime').runtime; const storage = require('../src/config/storage'); s3 = storage.s3;
    const image = Buffer.alloc(2_097_153, 1);
    await runtime.run('accepted-image-upload', () => storage.uploadPartyImage('fixture-image', 'png', image, 'image/png'));
    expect(runtime.snapshot().active).toEqual([]);
    holdResponse = true; const seen = new Promise(resolve => { receivedUpload = resolve; });
    const pending = runtime.run('accepted-held-upload', () => storage.uploadPartyImage('held-image', 'png', image, 'image/png')); await seen;
    const drain = runtime.drain({ timeoutMs: 1000 }); await new Promise(resolve => setTimeout(resolve, 30));
    expect(runtime.snapshot().active.length).toBeGreaterThan(0); completeUpload(); await pending;
    expect((await drain).phase).toBe('drained');
  } finally {
    completeUpload?.(); s3?.destroy(); runtime?.disposeForTests();
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(mockDirectory, { recursive: true, force: true });
  }
}, 5000);
