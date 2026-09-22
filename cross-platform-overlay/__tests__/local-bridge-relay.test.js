import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import relay from '../local-bridge-relay.js';

const snapshot = (patch = {}) => ({ provider: 'zfe', sessionId: 'session-a', worldGeneration: 'world-a', sequence: 3, ...patch });
const ready = (patch = {}) => ({ type: 'bridge:state', payload: { status: 'ready',
  sessionId: 'session-a', worldGeneration: 'world-a', sequence: 3, bindingId: 'binding-a', channelId: 'server:r:room', ...patch } });
const history = (patch = {}) => ({ type: 'bridge:history', payload: { bindingId: 'binding-a', channelId: 'server:r:room', messages: [], ...patch } });
function setup() {
  const watchers = [], stops = [], frames = [], emitted = [];
  const socket = { readyState: 1, send: vi.fn(raw => frames.push(JSON.parse(raw))) };
  const controller = new relay.LocalBridgeRelay({ relayHttp: 'http://localhost:7177', discover: vi.fn(),
    emit: (id, frame) => emitted.push({ id, ...frame }), watch: options => {
      watchers.push(options); const stop = vi.fn(); stops.push(stop); return { stop };
    } });
  return { controller, socket, frames, emitted, watchers, stops };
}
function attached() {
  const context = setup(); context.controller.setAuth('token'); context.controller.setGameRunning(true);
  context.controller.opened('one', context.socket, 'token'); return context;
}

describe('main-process local export authority', () => {
  it('waits for auth + game + socket and orders presence/watch before evidence', () => {
    const { controller: c, socket, watchers, frames } = setup();
    expect(c.opened('one', socket, null)).toBe(false); c.setAuth('token'); c.opened('one', socket, 'token');
    expect(watchers).toHaveLength(0);
    c.setGameRunning(true); expect(watchers).toHaveLength(1);
    watchers[0].onSnapshot(snapshot());
    expect(frames.map(f => f.type)).toEqual(['client:status', 'bridge:watch', 'client:status', 'bridge:observe']);
    expect(frames[1].payload).toEqual({ mode: 'local-export' });
    expect(frames[2].payload.inGame).toBe(true);
  });
  it('rejects renderer evidence and forces watch mode/presence while preserving ordinary frames', () => {
    const { controller: c, socket } = attached();
    for (const type of ['bridge:observe', 'bridge:leave']) expect(c.outgoing('one', socket, JSON.stringify({ type }))).toBeNull();
    expect(JSON.parse(c.outgoing('one', socket, '{"type":"bridge:watch"}')).payload).toEqual({ mode: 'local-export' });
    expect(JSON.parse(c.outgoing('one', socket, '{"type":"client:status","payload":{"inGame":false,"fullscreen":true}}')).payload).toEqual({ inGame: true, fullscreen: true });
    expect(c.outgoing('one', socket, '{"type":"ping"}')).toBe('{"type":"ping"}');
  });
  it('accepts a lagged ACK for the current generation and requires its binding for chat/history', () => {
    const { controller: c, socket, watchers, frames } = attached();
    expect(c.incoming('one', socket, ready())).toBe(false);
    watchers[0].onSnapshot(snapshot()); watchers[0].onSnapshot(snapshot({ sequence: 4 }));
    expect(c.incoming('one', socket, ready())).toBe(true);
    expect(c.incoming('one', socket, history())).toBe(true);
    expect(c.incoming('one', socket, history({ bindingId: 'old' }))).toBe(false);
    const send = JSON.stringify({ type: 'chat:send', payload: { channelId: 'server:r:room', bridgeBindingId: 'binding-a', content: 'hello' } });
    expect(c.outgoing('one', socket, send)).toBe(send);
    watchers[0].onInactive();
    expect(frames.at(-1)).toEqual({ type: 'bridge:leave', payload: { reason: 'observation_timeout' } });
    expect(c.outgoing('one', socket, send)).toBeNull();
    expect(c.incoming('one', socket, history())).toBe(false);
  });
  it('sends hard leave reasons for game exit and explicit inactive exports', () => {
    const { controller: c, socket, watchers, frames } = attached();
    watchers[0].onSnapshot(snapshot());
    watchers[0].onInactive('explicit_inactive');
    expect(frames.at(-1)).toEqual({ type: 'bridge:leave', payload: { reason: 'explicit_inactive' } });
    c.setGameRunning(false);
    expect(frames.at(-2)).toEqual({ type: 'bridge:leave', payload: { reason: 'game_exit' } });
  });
  it('immediately rejects old ACK/history/messages on world change, including a same-room rebind', () => {
    const { controller: c, socket, watchers, emitted } = attached();
    watchers[0].onSnapshot(snapshot()); expect(c.incoming('one', socket, ready())).toBe(true);
    watchers[0].onSnapshot(snapshot({ worldGeneration: 'world-b', sequence: 5 }));
    expect(emitted.at(-1).payload.status).toBe('inactive');
    expect(c.incoming('one', socket, ready())).toBe(false);
    expect(c.incoming('one', socket, history())).toBe(false);
    expect(c.incoming('one', socket, { ...history(), type: 'bridge:message' })).toBe(false);
    expect(c.incoming('one', socket, ready({ worldGeneration: 'world-b', sequence: 5, bindingId: 'binding-b' }))).toBe(true);
    expect(c.incoming('one', socket, history())).toBe(false);
  });
  it.each(['chat:send', 'send-message'])('gates the backend send alias %s identically across world changes', type => {
    const { controller: c, socket, watchers } = attached();
    watchers[0].onSnapshot(snapshot()); c.incoming('one', socket, ready());
    const frame = JSON.stringify({ type, payload: { channelId: 'server:r:room', bridgeBindingId: 'binding-a', content: 'hello' } });
    expect(c.outgoing('one', socket, frame)).toBe(frame);
    watchers[0].onSnapshot(snapshot({ worldGeneration: 'world-b', sequence: 5 }));
    expect(c.outgoing('one', socket, frame)).toBeNull();
  });
  it.each(['exit', 'auth', 'socket', 'quit'])('disposes watcher and rejects pending work on %s', event => {
    const { controller: c, socket, watchers, frames, stops } = attached();
    watchers[0].onSnapshot(snapshot()); c.incoming('one', socket, ready());
    if (event === 'exit') c.setGameRunning(false);
    if (event === 'auth') c.setAuth('new-token');
    if (event === 'socket') c.closed('one', socket);
    if (event === 'quit') c.dispose();
    expect(stops[0]).toHaveBeenCalledOnce();
    const count = frames.length; watchers[0].onSnapshot(snapshot({ sequence: 5 }));
    expect(frames).toHaveLength(count);
    expect(c.incoming('one', socket, ready())).toBe(false);
    expect(c.incoming('one', socket, history())).toBe(false);
    if (event !== 'socket') expect(frames.some(f => f.type === 'bridge:leave')).toBe(true);
  });
  it('owns exactly one socket and ignores the displaced socket closing afterward', () => {
    const { controller: c, socket, watchers, stops } = attached();
    const second = { readyState: 1, send: vi.fn() };
    c.opened('two', second, 'token'); c.closed('one', socket);
    expect(stops[0]).toHaveBeenCalledOnce(); expect(stops[1]).not.toHaveBeenCalled();
    watchers[0].onSnapshot(snapshot()); watchers[1].onSnapshot(snapshot());
    expect(c.incoming('one', socket, ready())).toBe(false);
    expect(c.incoming('two', second, ready())).toBe(true);
    expect(c.outgoing('one', socket, '{"type":"bridge:watch"}')).toBeNull();
  });
  it('main.js wires every auth change, IPC boundary, game transition and quit', () => {
    const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    expect(main.match(/sessionToken = /g)).toHaveLength(2); // declaration + central setter only
    expect(main).toContain('localBridge.setGameRunning(gameRunning)');
    expect(main).toContain('localBridge.setAuth(token)');
    expect(main).toContain('localBridge.opened(id, sock, socketToken)');
    expect(main).toContain('localBridge.outgoing(id, sock, frame)');
    expect(main).toContain('localBridge.outgoing(id, sock, data)');
    expect(main).toContain('localBridge.incoming(id, sock, msg)');
    expect(main).toContain('localBridge.dispose()');
    expect(main).toContain('if (relaySockets.get(id) !== sock) return;');
  });
});
