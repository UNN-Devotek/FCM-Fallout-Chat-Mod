// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isLoopbackHost,
  shouldShowDevPersonaLogins,
  relayBaseFor,
  applyRelayBase,
  buildShellHook,
  isRelayPath,
  pathFromUrl,
  urlOf,
  makePatchedFetch,
  installFetchShim,
  createWebSocketShim,
  installWebSocketShim,
  type BridgeHttp,
  type BridgeWs,
  type OverlayShellHook,
} from '../bridge-core';

// ── relayBase derivation ──────────────────────────────────────────────────────
describe('relayBase derivation', () => {
  it('isLoopbackHost matches localhost / 127.0.0.1 / ::1 with optional ports', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('localhost:7076')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:7077')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]:7076')).toBe(true);
    expect(isLoopbackHost('falloutchatmod.com')).toBe(false);
  });

  it('relayBaseFor: loopback→http, else https', () => {
    expect(relayBaseFor('localhost:7076')).toBe('http://localhost:7076');
    expect(relayBaseFor('falloutchatmod.com')).toBe('https://falloutchatmod.com');
  });

  it('applyRelayBase sets relayBase on the hook', () => {
    const hook: OverlayShellHook = { title: 'X' };
    applyRelayBase(hook, 'falloutchatmod.com');
    expect(hook.relayBase).toBe('https://falloutchatmod.com');
  });

  it('applyRelayBase is a no-op for empty host or missing hook', () => {
    const hook: OverlayShellHook = { title: 'X' };
    applyRelayBase(hook, '');
    expect(hook.relayBase).toBeUndefined();
    expect(() => applyRelayBase(undefined, 'host')).not.toThrow();
  });

  it('shows dev persona logins only for unpackaged overlays on known DEV relays', () => {
    expect(shouldShowDevPersonaLogins(true, 'http://localhost:7177')).toBe(true);
    expect(shouldShowDevPersonaLogins(true, '127.0.0.1:7076')).toBe(true);
    expect(shouldShowDevPersonaLogins(true, 'https://dev.falloutchatmod.com')).toBe(true);
    expect(shouldShowDevPersonaLogins(true, 'https://falloutchatmod.com')).toBe(false);
    expect(shouldShowDevPersonaLogins(false, 'http://localhost:7177')).toBe(false);
    expect(shouldShowDevPersonaLogins(true, 'https://localhost.falloutchatmod.com')).toBe(false);
    expect(shouldShowDevPersonaLogins(true, 'not a relay')).toBe(false);
  });
});

// ── shell hook ────────────────────────────────────────────────────────────────
describe('buildShellHook', () => {
  it('refresh/settings dispatch CustomEvents; minimize/close call the bridge', () => {
    const bridge = { minimizeWindow: vi.fn(), closeWindow: vi.fn(), refreshDiscordStatus: vi.fn(), refreshSteamStatus: vi.fn() };
    const dispatched: string[] = [];
    const target = { dispatchEvent: (e: Event) => { dispatched.push(e.type); return true; } };

    const hook = buildShellHook(bridge, target);
    expect(hook.title).toBe('FALLOUT 76');

    hook.onRefresh!();
    hook.onSettings!();
    expect(dispatched).toEqual(['fcm-shell-refresh', 'fcm-shell-settings']);
    expect(bridge.refreshDiscordStatus).toHaveBeenCalledOnce();
    expect(bridge.refreshSteamStatus).toHaveBeenCalledOnce();

    hook.onMinimize!();
    hook.onClose!();
    expect(bridge.minimizeWindow).toHaveBeenCalledOnce();
    expect(bridge.closeWindow).toHaveBeenCalledOnce();
  });
});

// ── fetch helpers (pure) ──────────────────────────────────────────────────────
describe('fetch routing helpers', () => {
  it('isRelayPath only matches /api, /auth, and prod relay paths', () => {
    expect(isRelayPath('/api/channels')).toBe(true);
    expect(isRelayPath('/auth/ws-ticket')).toBe(true);
    expect(isRelayPath('https://falloutchatmod.com/api/x')).toBe(true);
    expect(isRelayPath('https://falloutchatmod.com/auth/x')).toBe(true);
    expect(isRelayPath('/assets/app.js')).toBe(false);
    expect(isRelayPath('data:image/png;base64,abc')).toBe(false);
    // A non-relay host whose path is /api is NOT intercepted (must be a relative
    // /api path or the prod relay host).
    expect(isRelayPath('https://example.com/api/x')).toBe(false);
  });

  it('pathFromUrl strips host, keeps path+search', () => {
    expect(pathFromUrl('https://falloutchatmod.com/api/channels?x=1')).toBe('/api/channels?x=1');
    expect(pathFromUrl('/auth/ws-ticket')).toBe('/auth/ws-ticket');
  });

  it('urlOf extracts from string, URL, and Request', () => {
    expect(urlOf('/api/x')).toBe('/api/x');
    expect(urlOf(new URL('https://falloutchatmod.com/api/x'))).toBe('https://falloutchatmod.com/api/x');
    expect(urlOf(new Request('https://falloutchatmod.com/api/x'))).toBe('https://falloutchatmod.com/api/x');
  });
});

// ── fetch shim contract ────────────────────────────────────────────────────────
describe('makePatchedFetch contract', () => {
  let bridge: BridgeHttp & { http: ReturnType<typeof vi.fn> };
  let nativeFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridge = { http: vi.fn().mockResolvedValue({ status: 200, body: '{"data":{}}' }) };
    nativeFetch = vi.fn().mockResolvedValue(new Response('native'));
  });

  it('passes non-relay requests through to nativeFetch untouched', async () => {
    const patched = makePatchedFetch(bridge, nativeFetch as unknown as typeof fetch);
    await patched('/assets/app.js');
    expect(nativeFetch).toHaveBeenCalledWith('/assets/app.js', undefined);
    expect(bridge.http).not.toHaveBeenCalled();
  });

  it('routes relay GET through bridge.http with normalized path + default method', async () => {
    const patched = makePatchedFetch(bridge, nativeFetch as unknown as typeof fetch);
    const res = await patched('https://falloutchatmod.com/api/channels?x=1');
    expect(bridge.http).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/channels?x=1',
      body: null,
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: {} });
  });

  it('forwards string body, method, and headers', async () => {
    const patched = makePatchedFetch(bridge, nativeFetch as unknown as typeof fetch);
    await patched('/api/messages', {
      method: 'post',
      body: '{"text":"hi"}',
      headers: { 'X-Test': '1' },
    });
    expect(bridge.http).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/messages',
      body: '{"text":"hi"}',
      headers: { 'x-test': '1' },
    });
  });

  it('reads body from a Request when init.body is absent', async () => {
    const patched = makePatchedFetch(bridge, nativeFetch as unknown as typeof fetch);
    const req = new Request('https://falloutchatmod.com/api/messages', { method: 'POST', body: '{"a":1}' });
    await patched(req);
    const call = bridge.http.mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.body).toBe('{"a":1}');
  });

  it('wraps non-2xx as a Response with Error statusText', async () => {
    bridge.http.mockResolvedValue({ status: 404, body: 'nope' });
    const patched = makePatchedFetch(bridge, nativeFetch as unknown as typeof fetch);
    const res = await patched('/api/missing');
    expect(res.status).toBe(404);
    expect(res.statusText).toBe('Error');
  });
});

describe('installFetchShim install/teardown (global hygiene)', () => {
  let original: typeof fetch;
  beforeEach(() => { original = window.fetch; });
  afterEach(() => { window.fetch = original; });

  it('installs the shim and restores the original on teardown', async () => {
    const sentinel = vi.fn().mockResolvedValue(new Response('orig'));
    window.fetch = sentinel as unknown as typeof fetch;

    const bridge: BridgeHttp = { http: vi.fn().mockResolvedValue({ status: 200, body: '{}' }) };
    const teardown = installFetchShim(window as any, bridge);

    expect(window.fetch).not.toBe(sentinel);
    await window.fetch('/api/x');
    expect(bridge.http).toHaveBeenCalledOnce();
    // Non-relay falls through to the captured original.
    await window.fetch('/asset.js');
    expect(sentinel).toHaveBeenCalled();

    teardown();
    expect(window.fetch).toBe(sentinel);
  });
});

// ── WebSocket shim ──────────────────────────────────────────────────────────────
function makeWsBridge() {
  const handlers: {
    open?: (m: { id: string }) => void;
    message?: (m: { id: string; data: string }) => void;
    close?: (m: { id: string; code: number; reason: string }) => void;
    error?: (m: { id: string; message: string }) => void;
  } = {};
  const bridge: BridgeWs = {
    wsOpen: vi.fn(),
    wsSend: vi.fn(),
    wsClose: vi.fn(),
    onWsOpen: (cb) => { handlers.open = cb; },
    onWsMessage: (cb) => { handlers.message = cb; },
    onWsClose: (cb) => { handlers.close = cb; },
    onWsError: (cb) => { handlers.error = cb; },
  };
  return { bridge, handlers };
}

describe('createWebSocketShim (ProxiedWebSocket lifecycle)', () => {
  it('allocates ids, registers in liveSockets, and proxies wsOpen', () => {
    const { bridge, handlers } = makeWsBridge();
    const { ProxiedWebSocket, liveSockets } = createWebSocketShim(bridge);

    const ws = new ProxiedWebSocket('wss://host/ws?ticket=abc');
    expect(ws.url).toBe('wss://host/ws?ticket=abc');
    expect(ws.readyState).toBe(0);
    expect(bridge.wsOpen).toHaveBeenCalledWith(ws.id);
    expect(liveSockets.get(ws.id)).toBe(ws);
    expect(handlers.open).toBeTypeOf('function');
  });

  it('static + instance constants match the WebSocket contract', () => {
    const { bridge } = makeWsBridge();
    const { ProxiedWebSocket } = createWebSocketShim(bridge);
    expect(ProxiedWebSocket.OPEN).toBe(1);
    const ws = new ProxiedWebSocket('x');
    expect(ws.OPEN).toBe(1);
    expect(ws.CLOSED).toBe(3);
  });

  it('_fireOpen sets readyState OPEN and calls onopen', () => {
    const { bridge, handlers } = makeWsBridge();
    const { ProxiedWebSocket } = createWebSocketShim(bridge);
    const ws = new ProxiedWebSocket('x');
    const onopen = vi.fn();
    ws.onopen = onopen;
    handlers.open!({ id: ws.id });
    expect(ws.readyState).toBe(1);
    expect(onopen).toHaveBeenCalledWith({ type: 'open' });
  });

  it('_fireMessage delivers data to onmessage', () => {
    const { bridge, handlers } = makeWsBridge();
    const { ProxiedWebSocket } = createWebSocketShim(bridge);
    const ws = new ProxiedWebSocket('x');
    const onmessage = vi.fn();
    ws.onmessage = onmessage;
    handlers.message!({ id: ws.id, data: '{"type":"chat:message"}' });
    expect(onmessage).toHaveBeenCalledWith({ data: '{"type":"chat:message"}' });
  });

  it('send proxies through bridge.wsSend', () => {
    const { bridge } = makeWsBridge();
    const { ProxiedWebSocket } = createWebSocketShim(bridge);
    const ws = new ProxiedWebSocket('x');
    ws.send('payload');
    expect(bridge.wsSend).toHaveBeenCalledWith(ws.id, 'payload');
  });

  it('close sets CLOSING and proxies wsClose', () => {
    const { bridge } = makeWsBridge();
    const { ProxiedWebSocket } = createWebSocketShim(bridge);
    const ws = new ProxiedWebSocket('x');
    ws.close();
    expect(ws.readyState).toBe(2);
    expect(bridge.wsClose).toHaveBeenCalledWith(ws.id);
  });

  it('_fireClose sets CLOSED, removes from map, and calls onclose', () => {
    const { bridge, handlers } = makeWsBridge();
    const { ProxiedWebSocket, liveSockets } = createWebSocketShim(bridge);
    const ws = new ProxiedWebSocket('x');
    const onclose = vi.fn();
    ws.onclose = onclose;
    handlers.close!({ id: ws.id, code: 1000, reason: 'bye' });
    expect(ws.readyState).toBe(3);
    expect(liveSockets.has(ws.id)).toBe(false);
    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason: 'bye' });
  });

  it('_fireError calls onerror with the message', () => {
    const { bridge, handlers } = makeWsBridge();
    const { ProxiedWebSocket } = createWebSocketShim(bridge);
    const ws = new ProxiedWebSocket('x');
    const onerror = vi.fn();
    ws.onerror = onerror;
    handlers.error!({ id: ws.id, message: 'boom' });
    expect(onerror).toHaveBeenCalledWith({ message: 'boom' });
  });

  it('dispatch to an unknown id is a safe no-op', () => {
    const { bridge, handlers } = makeWsBridge();
    createWebSocketShim(bridge);
    expect(() => handlers.message!({ id: 'ws999', data: 'x' })).not.toThrow();
  });

  it('allocates distinct ids per socket', () => {
    const { bridge } = makeWsBridge();
    const { ProxiedWebSocket } = createWebSocketShim(bridge);
    const a = new ProxiedWebSocket('x');
    const b = new ProxiedWebSocket('y');
    expect(a.id).not.toBe(b.id);
  });
});

describe('installWebSocketShim install/teardown (global hygiene)', () => {
  let originalWS: typeof WebSocket;
  beforeEach(() => { originalWS = window.WebSocket; });
  afterEach(() => {
    window.WebSocket = originalWS;
    delete (window as any).__NativeWebSocket;
  });

  it('swaps global WebSocket, exposes native, and restores on teardown', () => {
    const { bridge } = makeWsBridge();
    const native = window.WebSocket;
    const { ProxiedWebSocket, teardown } = installWebSocketShim(window as any, bridge);

    expect(window.WebSocket).toBe(ProxiedWebSocket as unknown as typeof WebSocket);
    expect((window as any).__NativeWebSocket).toBe(native);

    teardown();
    expect(window.WebSocket).toBe(native);
    expect((window as any).__NativeWebSocket).toBeUndefined();
  });
});
