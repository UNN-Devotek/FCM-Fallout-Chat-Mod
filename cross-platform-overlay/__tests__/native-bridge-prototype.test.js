import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NativeBridgePrototypeRelay, parseCapsule } = require('../native-bridge-prototype');
const sid = 'np-123456789-123456789-123456789-123456789';
const capsule = JSON.stringify({ schemaVersion: 'native-prototype-1', environment: 'dev', provider: 'xscal', sessionId: sid });
afterEach(() => vi.useRealTimers());
describe('development native bridge pairing', () => {
  it('only accepts the bounded capsule contract', () => {
    expect(parseCapsule(capsule).sessionId).toBe(sid);
    for (const v of ['{}', 'null', capsule.replace('dev', 'prod'), capsule.replace('xscal', 'zfe'),
      capsule.replace('"dev"', '"dev","token":"secret"')]) expect(parseCapsule(v)).toBeNull();
  });
  it('pairs from main-process discovery and hides evidence control frames from renderer', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(), sent = [], socket = { readyState: 1, send: data => sent.push(JSON.parse(data)) };
    const relay = new NativeBridgePrototypeRelay({ relayHttp: 'http://localhost:7177', emit,
      discover: async () => [{ root: '/game', relative: 'Data/modsdata/fcmserverbridge-dev.json', provider: 'xscal' }],
      read: async () => capsule });
    relay.setAuth('test'); relay.setGameRunning(true); relay.opened('id', socket, 'test');
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toContainEqual({ type: 'bridge:native-pair', payload: { sessionId: sid } });
    expect(relay.outgoing('id', socket, JSON.stringify({ type: 'bridge:native-pair', payload: { sessionId: 'forged' } }))).toBeNull();
    expect(relay.incoming('id', socket, { type: 'bridge:native-observation', payload: {
      sessionId: sid, worldGeneration: 'world-a', sequence: 2 } })).toBe(false);
    expect(relay.expected).toMatchObject({ sessionId: sid, worldGeneration: 'world-a', latestSequence: 2 });
    expect(relay.incoming('id', socket, { type: 'bridge:state', payload: { status: 'ready', sessionId: sid,
      worldGeneration: 'world-a', sequence: 2, bindingId: 'binding', channelId: 'server:r:room' } })).toBe(true);
    relay.setGameRunning(false);
    expect(relay.expected).toBeNull(); expect(relay.binding).toBeNull();
    const count = sent.length; await vi.advanceTimersByTimeAsync(15000); expect(sent).toHaveLength(count);
    relay.dispose();
  });
  it('never discovers native capsules on production', async () => {
    const discover = vi.fn();
    const relay = new NativeBridgePrototypeRelay({ relayHttp: 'https://falloutchatmod.com', discover, emit: vi.fn() });
    relay.setAuth('t'); relay.setGameRunning(true); relay.opened('id', { readyState: 1, send() {} }, 't');
    expect(discover).not.toHaveBeenCalled(); relay.dispose();
  });
  it('losing the capsule rejects delayed evidence and ready frames', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => capsule), socket = { readyState: 1, send: vi.fn() };
    const relay = new NativeBridgePrototypeRelay({ relayHttp: 'http://localhost:7177', emit: vi.fn(), read,
      discover: async () => [{ root: '/game', relative: 'capsule', provider: 'xscal' }] });
    relay.setAuth('t'); relay.setGameRunning(true); relay.opened('id', socket, 't');
    await vi.advanceTimersByTimeAsync(1); expect(relay.nativeSession).toBe(sid);
    read.mockResolvedValue(null); await vi.advanceTimersByTimeAsync(5000);
    expect(relay.nativeSession).toBeNull();
    relay.incoming('id', socket, { type: 'bridge:native-observation', payload: { sessionId: sid, worldGeneration: 'w', sequence: 3 } });
    expect(relay.expected).toBeNull();
    expect(relay.incoming('id', socket, { type: 'bridge:state', payload: { status: 'ready', sessionId: sid,
      worldGeneration: 'w', sequence: 3, bindingId: 'binding', channelId: 'server:r:room' } })).toBe(false);
    relay.dispose();
  });
});
