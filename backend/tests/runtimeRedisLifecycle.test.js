const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
let mockDirectory, mockRedisUrl;
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { NODE_ENV: 'test',
  FCM_RUNTIME_CONTROL_DIR: mockDirectory, REDIS_URL: mockRedisUrl } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

// Real node-redis6 client against a bounded RESP2 fixture. Its successful socket
// initiator leaves losing Promise.race branches unresolved inside the SDK.
test('a real Redis connection lifetime does not retain a completed probe, but its awaited command still drains before close', async () => {
  jest.resetModules(); mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-redis-lifetime-'));
  const sockets = new Set(); let pingGate; let pingSeen; let runtime; let client;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.length) {
        const first = buffer.indexOf('\r\n'); if (first < 0) break;
        const count = Number(buffer.slice(1, first)); let offset = first + 2; const args = []; let complete = true;
        for (let i = 0; i < count; i++) {
          const end = buffer.indexOf('\r\n', offset); if (end < 0) { complete = false; break; }
          const size = Number(buffer.slice(offset + 1, end)); offset = end + 2;
          if (buffer.length < offset + size + 2) { complete = false; break; }
          args.push(buffer.slice(offset, offset + size)); offset += size + 2;
        }
        if (!complete) break; buffer = buffer.slice(offset);
        if (args[0] === 'PING') {
          if (pingGate) { pingSeen(); void pingGate.then(() => socket.write('+PONG\r\n')); }
          else socket.write('+PONG\r\n');
        } else socket.write('+OK\r\n');
      }
    });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    mockRedisUrl = `redis://127.0.0.1:${server.address().port}`;
    runtime = require('../src/runtime').runtime; const redis = require('../src/config/redis'); client = redis.client;
    runtime.registerParticipant('redis-fixture', { inspect: async () => ({ pending: 0 }), close: async () => { await client.quit(); } });
    expect(await runtime.run('accepted-probe', () => redis.healthCheck())).toBe(true);
    expect(runtime.snapshot().active).toEqual([]);
    let allowPing; pingGate = new Promise(resolve => { allowPing = resolve; });
    const seen = new Promise(resolve => { pingSeen = resolve; });
    const pending = runtime.run('accepted-redis-command', () => redis.healthCheck()); await seen;
    const drain = runtime.drain({ timeoutMs: 1000, close: true });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(runtime.snapshot().active.length).toBeGreaterThan(0);
    expect(client.isOpen).toBe(true); allowPing(); await pending;
    expect((await drain).phase).toBe('closed'); expect(client.isOpen).toBe(false);
  } finally {
    if (client?.isOpen) client.destroy(); runtime?.disposeForTests();
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(mockDirectory, { recursive: true, force: true });
  }
}, 5000);
