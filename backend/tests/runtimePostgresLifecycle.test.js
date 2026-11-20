const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
let mockDirectory, mockPort;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test', FCM_RUNTIME_CONTROL_DIR: mockDirectory,
  DB_HOST: '127.0.0.1', DB_PORT: mockPort, DB_USER: 'fixture', DB_PASSWORD: '', DB_NAME: 'fixture' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const packet = (type, body) => { const size = Buffer.alloc(4); size.writeInt32BE(body.length + 4); return Buffer.concat([Buffer.from(type), size, body]); };

// Exercise the real pg/pg-protocol parser, whose promise lives until socket.end,
// without a database service or dependency on an external environment.
test('a real PostgreSQL parser lifetime does not retain a completed probe, while pending SQL still blocks pool close', async () => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-pg-lifetime-'));
  const sockets = new Set(); let queryGate; let querySeen; let runtime; let pool;
  const ready = () => packet('Z', Buffer.from('I'));
  const reply = socket => socket.write(Buffer.concat([packet('C', Buffer.from('SELECT 1\0')), ready()]));
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0); let started = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0)); started = true;
        socket.write(Buffer.concat([packet('R', Buffer.alloc(4)), ready()]));
      }
      while (buffer.length >= 5) {
        const size = buffer.readInt32BE(1); if (buffer.length < size + 1) break;
        const type = String.fromCharCode(buffer[0]); buffer = buffer.subarray(size + 1);
        if (type === 'X') socket.end();
        else if (type === 'Q') {
          if (queryGate) { querySeen(); void queryGate.then(() => reply(socket)); }
          else reply(socket);
        }
      }
    });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); mockPort = server.address().port;
    runtime = require('../src/runtime').runtime; const db = require('../src/config/database'); pool = db.pool;
    runtime.registerParticipant('postgres-fixture', { inspect: async () => ({ pending: pool.waitingCount }), close: async () => { await pool.end(); } });
    expect(await runtime.run('accepted-db-probe', () => db.healthCheck())).toBe(true);
    expect(runtime.snapshot().active).toEqual([]);
    let allowQuery; queryGate = new Promise(resolve => { allowQuery = resolve; });
    const seen = new Promise(resolve => { querySeen = resolve; });
    const pending = runtime.run('accepted-sql', () => db.healthCheck()); await seen;
    const drain = runtime.drain({ timeoutMs: 1000, close: true });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
    expect(pool.ended).toBe(false); allowQuery(); await pending;
    expect((await drain).phase).toBe('closed'); expect(pool.ended).toBe(true);
  } finally {
    if (pool && !pool.ended) await pool.end(); runtime?.disposeForTests();
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(mockDirectory, { recursive: true, force: true });
  }
}, 5000);
