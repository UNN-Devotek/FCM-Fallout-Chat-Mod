'use strict';
/**
 * Per-IP relay slot eviction in websocket/upgradeRouter.ts.
 *
 * A real http.Server + ws; the relay handler is replaced by one that keeps the socket
 * open and answers "ok" to each frame, so only the upgrade guard is under test.
 */

jest.mock('../src/services/relay/relayHandler', () => ({
  handleRelayConnection: (ws) => ws.on('message', () => ws.send('ok')),
}));

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { attachChatUpgradeRouter, _resetRelayWss, closeRelayWss } = require('../src/websocket/upgradeRouter');

const IDLE_MS = 300;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('relay per-IP cap with silent-slot eviction', () => {
  let server;
  let chatWss;
  let port;
  const open = [];

  beforeEach((done) => {
    process.env.RELAY_EVICT_IDLE_MS = String(IDLE_MS);
    _resetRelayWss();
    server = http.createServer();
    chatWss = new WebSocketServer({ noServer: true });
    attachChatUpgradeRouter(server, chatWss);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });

  afterEach(async () => {
    delete process.env.RELAY_EVICT_IDLE_MS;
    for (const ws of open.splice(0)) ws.terminate();
    await closeRelayWss();
    chatWss.close();
    await new Promise((r) => server.close(r));
  });

  function connect() {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
      open.push(ws);
      ws.once('open', () => resolve({ ok: true, ws }));
      ws.once('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.once('error', (e) => resolve({ ok: false, error: e.message }));
    });
  }

  async function fillCap() {
    const conns = [];
    for (let i = 0; i < 5; i++) {
      const c = await connect();
      expect(c.ok).toBe(true);
      conns.push(c.ws);
    }
    return conns;
  }

  test('a sixth connection is refused while every slot is active', async () => {
    const conns = await fillCap();
    const sixth = await connect();
    expect(sixth).toEqual({ ok: false, status: 429 });
    expect(conns.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
  });

  test('a sixth connection takes the slot of the longest-silent socket only', async () => {
    const conns = await fillCap();
    await delay(IDLE_MS + 100);
    // Four of the five clients are alive and talking; only conns[0] has gone silent.
    for (const ws of conns.slice(1)) ws.send('frame');
    await delay(50);

    const closed = new Promise((r) => conns[0].once('close', r));
    const sixth = await connect();
    expect(sixth.ok).toBe(true);
    await closed;
    expect(conns.slice(1).every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);

    // The cap still holds: the IP is full again and everyone is active.
    const seventh = await connect();
    expect(seventh).toEqual({ ok: false, status: 429 });
  });

  test('an evicted socket closing later does not free a second slot', async () => {
    const conns = await fillCap();
    await delay(IDLE_MS + 100);
    for (const ws of conns.slice(1)) ws.send('frame');
    const closed = new Promise((r) => conns[0].once('close', r));
    expect((await connect()).ok).toBe(true);
    await closed;
    await delay(50);
    expect(await connect()).toEqual({ ok: false, status: 429 });
  });

  test('RELAY_EVICT_IDLE_MS=0 restores plain refusal', async () => {
    process.env.RELAY_EVICT_IDLE_MS = '0';
    await fillCap();
    await delay(IDLE_MS + 100);
    expect(await connect()).toEqual({ ok: false, status: 429 });
  });
});
