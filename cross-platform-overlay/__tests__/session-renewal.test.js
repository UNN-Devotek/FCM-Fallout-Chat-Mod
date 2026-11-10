// An overlay left running outlives its 24h session token. The relay then closes
// every reconnect with 4001 and the same dead token used to be retried forever.
// main.js cannot be required outside Electron, so — like qa-login.test.js — the
// relevant sections run verbatim in a vm context with the edges stubbed.
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { createRequire } from 'module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const overlayCore = createRequire(import.meta.url)('../overlay-core.js');
const main = readFileSync(join(resolve(import.meta.dirname, '..'), 'main.js'), 'utf8');
const section = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));

const EXPIRED = 'Invalid or expired token';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T21:12:21Z')); });
afterEach(() => vi.useRealTimers());

describe('isSessionRejectedClose', () => {
  it('recognises the relay refusing the session token', () => {
    expect(overlayCore.isSessionRejectedClose(4001, EXPIRED)).toBe(true);
    expect(overlayCore.isSessionRejectedClose(4001, 'User not found')).toBe(true);
  });

  it('ignores closes a new token cannot fix', () => {
    for (const reason of ['Auth service unavailable', 'Database error', 'Missing X-Auth-Token',
      'Invalid or expired ticket', 'Session changed', '', undefined]) {
      expect(overlayCore.isSessionRejectedClose(4001, reason), String(reason)).toBe(false);
    }
    for (const code of [1000, 1006, 4002, 4003]) {
      expect(overlayCore.isSessionRejectedClose(code, EXPIRED), String(code)).toBe(false);
    }
  });
});

describe('relay socket closed 4001', () => {
  function overlay({ buildChannel = 'production', portable = false } = {}) {
    const sockets = [];
    const closes = [];
    class FakeSocket extends EventEmitter {
      constructor(_url, options) { super(); this.token = options.headers['X-Auth-Token']; sockets.push(this); }
      close() {}
      drop(code, reason) { this.emit('close', code, Buffer.from(reason)); }
    }
    const context = vm.createContext({
      Date, sessionToken: 'token-1', isQuitting: false, BUILD_CHANNEL: buildChannel, IS_PORTABLE: portable,
      RELAY_WS: 'wss://relay.test/ws', RELAY_HTTP: 'https://relay.test', APP_VERSION: '1.4.3', APP_UA: 'test',
      relaySockets: new Map(), relaySendBuffers: new Map(), WebSocket: FakeSocket, overlayCore,
      localBridge: { opened() {}, closed() {}, outgoing: (_id, _sock, data) => data, incoming: () => true },
      sendToRenderer: (channel, payload) => { if (channel === 'proxy:ws:close') closes.push(payload); },
      diag() {}, showUpdateNotification() {}, startRelay: vi.fn(),
    });
    vm.runInContext(section('function openRelaySocket(id) {', '/**\n * Process all pending proxy:ws:open'), context);
    vm.runInContext(section('// ─── Session renewal', '// ─── Window show / focus helpers'), context);
    const open = (id) => { context.__id = id; vm.runInContext('openRelaySocket(__id)', context); return sockets.at(-1); };
    return { context, open, closes, startRelay: context.startRelay };
  }

  it('re-registers when the relay rejects the session token, and still forwards the close', () => {
    const o = overlay();
    o.open('ws1').drop(4001, EXPIRED);
    expect(o.closes).toEqual([{ id: 'ws1', code: 4001, reason: EXPIRED }]);
    expect(o.startRelay).toHaveBeenCalledTimes(1);
  });

  it.each([[4001, 'Auth service unavailable'], [4001, 'Database error'], [1006, ''], [4002, 'Banned']])(
    'does not re-register for close %i "%s"', (code, reason) => {
      const o = overlay();
      o.open('ws1').drop(code, reason);
      expect(o.startRelay).not.toHaveBeenCalled();
    });

  it('re-registers at most once a minute while the relay keeps refusing', () => {
    const o = overlay();
    for (const id of ['ws1', 'ws2', 'ws3']) o.open(id).drop(4001, EXPIRED);
    expect(o.startRelay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(59_999);
    o.open('ws4').drop(4001, EXPIRED);
    expect(o.startRelay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    o.open('ws5').drop(4001, EXPIRED);
    expect(o.startRelay).toHaveBeenCalledTimes(2);
  });

  it('ignores a socket that was opened with a token since replaced', () => {
    const o = overlay();
    const socket = o.open('ws1');
    o.context.sessionToken = 'token-2';
    socket.drop(4001, EXPIRED);
    expect(o.startRelay).not.toHaveBeenCalled();
  });

  it('leaves official QA sessions alone but renews portable QA', () => {
    const official = overlay({ buildChannel: 'qa' });
    official.open('ws1').drop(4001, EXPIRED);
    expect(official.startRelay).not.toHaveBeenCalled();
    const portable = overlay({ buildChannel: 'qa', portable: true });
    portable.open('ws1').drop(4001, EXPIRED);
    expect(portable.startRelay).toHaveBeenCalledTimes(1);
  });
});

describe('startRelay as a renewal', () => {
  function relay({ sessionToken = null } = {}) {
    const statuses = [];
    let settle;
    const context = vm.createContext({
      setTimeout, sessionToken, authGeneration: 0, providerLoginRequested: false, userRole: null,
      BUILD_CHANNEL: 'production', IS_PORTABLE: false,
      resolveAppClientKey: () => 'client-key', loadState: () => ({ installToken: 'install' }), saveState() {},
      registerForToken: () => new Promise((res, rej) => { settle = { resolve: res, reject: rej }; }),
      flushPendingWsOpens() {}, rebuildTray() {}, isPrivileged: () => false, reevaluateVisibility() {},
      diag() {}, startQaLogin() {},
      sendToRenderer: (channel, payload) => { if (channel === 'relay:status') statuses.push(payload.state); },
    });
    context.setSessionToken = (token) => { context.sessionToken = token; };
    vm.runInContext(section('// ─── Bootstrap: resolve key', '// ─── Session renewal'), context);
    const done = vm.runInContext('startRelay()', context);
    return { context, statuses, done, registration: () => settle };
  }
  const registered = token => ({ token, userId: 'user-1', displayName: 'Mapex' });
  const authRequired = () => Object.assign(new Error('auth_required'), { authRequired: true });

  it('replaces the rejected token and reports authenticated', async () => {
    const r = relay({ sessionToken: 'expired-token' });
    r.registration().resolve(registered('fresh-token'));
    await r.done;
    expect(r.context.sessionToken).toBe('fresh-token');
    expect(r.statuses).toEqual(['authenticated']);
  });

  it('still signs in from nothing at launch', async () => {
    const r = relay();
    r.registration().resolve(registered('first-token'));
    await r.done;
    expect(r.context.sessionToken).toBe('first-token');
    expect(r.statuses).toEqual(['authenticated']);
  });

  it('stands down when another sign-in installed a token meanwhile', async () => {
    const r = relay({ sessionToken: 'expired-token' });
    r.context.sessionToken = 'provider-token';
    r.registration().resolve(registered('late-token'));
    await r.done;
    expect(r.context.sessionToken).toBe('provider-token');
    expect(r.statuses).toEqual([]);
  });

  it('drops the dead token when the install is no longer authorized, so sign-in can re-register', async () => {
    const r = relay({ sessionToken: 'expired-token' });
    r.registration().reject(authRequired());
    await r.done;
    expect(r.context.sessionToken).toBeNull();
    expect(r.statuses).toEqual(['discord_required']);
  });

  it('does not sign out a newer sign-in, or show the login wall, on a late failure', async () => {
    const r = relay({ sessionToken: 'expired-token' });
    r.context.sessionToken = 'provider-token';
    r.registration().reject(authRequired());
    await r.done;
    expect(r.context.sessionToken).toBe('provider-token');
    expect(r.statuses).toEqual([]);
  });
});
