'use strict';
/**
 * Tests for websocket/upgradeRouter.ts — /ws and /relay routing.
 *
 * Self-contained: real http.Server + ws, no DB/redis/app imports.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const {
  upgradePathname,
  attachChatUpgradeRouter,
  CHAT_WS_PATH,
  RELAY_WS_PATH,
} = require('../src/websocket/upgradeRouter');

describe('upgradePathname', () => {
  test.each([
    ['/ws', '/ws'],
    ['/ws/hud', '/ws/hud'],
    ['/ws?token=abc', '/ws'],
    ['/ws/hud?x=1', '/ws/hud'],
    ['/ws/bogus', '/ws/bogus'],
  ])('strips query and parses %p -> %p', (input, expected) => {
    expect(upgradePathname(input)).toBe(expected);
  });

  test('malformed / empty / undefined urls do not throw', () => {
    expect(upgradePathname(undefined)).toBe('/');
    expect(upgradePathname('')).toBe('/');
    expect(upgradePathname('::::')).toBe('/::::'); // parsed relative to base, never throws
  });

  test('path constants', () => {
    expect(CHAT_WS_PATH).toBe('/ws');
    expect(RELAY_WS_PATH).toBe('/relay');
  });
});

describe('attachChatUpgradeRouter — /ws routing and unknown-path rejection', () => {
  let server;
  let port;
  let chatWss;

  beforeAll((done) => {
    server = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end('upgrade required');
    });

    // Main chat server in noServer mode — verifyClient mirrors the real
    // origin/IP guard to prove it still runs via manual handleUpgrade().
    chatWss = new WebSocketServer({
      noServer: true,
      verifyClient: (info, cb) => {
        if (info.origin === 'http://evil.example') return cb(false, 403, 'Forbidden origin');
        cb(true);
      },
    });
    chatWss.on('connection', (ws) => ws.send('CHAT_OK'));
    attachChatUpgradeRouter(server, chatWss);

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    chatWss.close();
    server.close(done);
  });

  function connect(path, opts) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, opts);
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        resolve(result);
      };
      ws.on('message', (d) => finish({ ok: true, msg: d.toString() }));
      ws.on('unexpected-response', (_req, res) => finish({ ok: false, status: res.statusCode }));
      ws.on('error', (e) => finish({ ok: false, error: e.message }));
      setTimeout(() => finish({ ok: false, error: 'timeout' }), 3000);
    });
  }

  test('/ws upgrades to the chat server', async () => {
    await expect(connect(CHAT_WS_PATH)).resolves.toEqual({ ok: true, msg: 'CHAT_OK' });
  });

  test('/ws/hud is rejected after legacy listener removal', async () => {
    const r = await connect('/ws/hud');
    expect(r.ok).toBe(false);
  });

  test('unknown /ws/* path is rejected (socket destroyed)', async () => {
    const r = await connect('/ws/bogus');
    expect(r.ok).toBe(false);
  });

  test('verifyClient still runs in noServer mode (bad Origin on /ws is 403)', async () => {
    const r = await connect(CHAT_WS_PATH, { origin: 'http://evil.example' });
    expect(r.ok).toBe(false);
    if (r.status !== undefined) expect(r.status).toBe(403);
  });
});

test('unknown upgrades are rejected by the shared router', () => {
  const server = http.createServer();
  const chatWss = { handleUpgrade: jest.fn() };
  const socket = { destroy: jest.fn() };

  attachChatUpgradeRouter(server, chatWss);
  server.emit('upgrade', { url: '/ws/hud' }, socket, Buffer.alloc(0));

  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(chatWss.handleUpgrade).not.toHaveBeenCalled();
  server.close();
});
