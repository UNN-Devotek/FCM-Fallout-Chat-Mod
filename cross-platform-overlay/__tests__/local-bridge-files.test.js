import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import bridge from '../local-bridge-files.js';

const { parseSnapshot, bridgeEnvironment, ExportCursor, readBoundedFile, watchExports } = bridge;
const snapshot = (patch = {}) => ({ schemaVersion: 1, environment: 'dev', provider: 'zfe', build: '0.2',
  sessionId: 'session-a', worldGeneration: 'world-a', sequence: 1, observationSequence: 1,
  observationAgeMs: 0, state: 'active', ownName: 'Player', names: ['Peer'], ...patch });
const parse = value => parseSnapshot(JSON.stringify(value), 'dev', 'zfe');
const dirs = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

describe('strict provider export boundary', () => {
  it('accepts the exact contract and derives environment only from effective relay', () => {
    expect(parse(snapshot())).toEqual(snapshot());
    expect(bridgeEnvironment('http://localhost:7177')).toBe('dev');
    expect(bridgeEnvironment('https://dev.falloutchatmod.com')).toBe('dev');
    expect(bridgeEnvironment('https://falloutchatmod.com')).toBe('prod');
    expect(bridgeEnvironment('http://falloutchatmod.com')).toBeNull();
    expect(bridgeEnvironment('https://other.example')).toBeNull();
  });
  it.each([
    { schemaVersion: 2 }, { environment: 'prod' }, { provider: 'xscal' }, { credentials: 'forbidden' },
    { sequence: 0 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { observationSequence: -1 },
    { observationAgeMs: -1 }, { observationAgeMs: 60001 }, { sessionId: '../file' }, { worldGeneration: '' },
    { build: '' }, { ownName: 'x'.repeat(65) }, { names: Array(25).fill('x') }, { names: [1] }, { state: 'ready' },
  ])('rejects invalid fields %j', patch => expect(parse(snapshot(patch))).toBeNull());
  it('rejects malformed, oversized, missing-field and non-object input', () => {
    expect(parseSnapshot('{', 'dev', 'zfe')).toBeNull();
    expect(parseSnapshot(' '.repeat(8193), 'dev', 'zfe')).toBeNull();
    expect(parseSnapshot('null', 'dev', 'zfe')).toBeNull();
    const missing = snapshot(); delete missing.names; expect(parse(missing)).toBeNull();
  });
  it('reads a bounded regular UTF-8 file, rejects traversal, invalid UTF-8 and oversized content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fcm-export-')); dirs.push(root);
    await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(snapshot()));
    expect(await readBoundedFile(root, 'state.json')).toBe(JSON.stringify(snapshot()));
    expect(await readBoundedFile(root, '../state.json')).toBeNull();
    await fs.writeFile(path.join(root, 'state.json'), Buffer.from([0xc3, 0x28]));
    expect(await readBoundedFile(root, 'state.json')).toBeNull();
    await fs.writeFile(path.join(root, 'state.json'), 'x'.repeat(8193));
    expect(await readBoundedFile(root, 'state.json')).toBeNull();
  });
  it('rejects symlink files and provider directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fcm-export-')); dirs.push(root);
    await fs.mkdir(path.join(root, 'real'));
    await fs.writeFile(path.join(root, 'real', 'state.json'), '{}');
    await fs.symlink(path.join(root, 'real', 'state.json'), path.join(root, 'link.json'));
    await fs.symlink(path.join(root, 'real'), path.join(root, 'linked'));
    expect(await readBoundedFile(root, 'link.json')).toBeNull();
    expect(await readBoundedFile(root, 'linked/state.json')).toBeNull();
    expect(await readBoundedFile(root, 'real')).toBeNull();
  });
  it('rejects a file changed during reading and always closes its descriptor', async () => {
    const stat = { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false,
      size: 2, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1 };
    const handle = { stat: vi.fn().mockResolvedValueOnce(stat).mockResolvedValue({ ...stat, mtimeMs: 2 }),
      read: vi.fn().mockImplementationOnce(async b => { b.write('{}'); return { bytesRead: 2 }; }).mockResolvedValue({ bytesRead: 0 }), close: vi.fn().mockResolvedValue() };
    const io = { lstat: vi.fn().mockResolvedValue(stat), realpath: vi.fn(async p => p), open: vi.fn().mockResolvedValue(handle) };
    expect(await readBoundedFile('/trusted', 'file.json', 8192, io)).toBeNull();
    expect(handle.read.mock.calls[0][0].length).toBe(8193);
    expect(handle.close).toHaveBeenCalledOnce();
  });
});

describe('monotonic evidence and writer liveness', () => {
  it('requires advancement after attach and retains an established writer until observation expiry', () => {
    const cursor = new ExportCursor();
    expect(cursor.accept(snapshot(), 0)).toBeNull();
    expect(cursor.accept(snapshot(), 5000)).toBeNull();
    expect(cursor.accept(snapshot({ sequence: 2, observationAgeMs: 5000 }), 5000)).not.toBeNull();
    expect(cursor.current(29999)).not.toBeNull();
    expect(cursor.current(30000)).toBeNull();
  });
  it('revokes an explicit inactive export immediately despite an unexpired observation', () => {
    const cursor = new ExportCursor();
    cursor.accept(snapshot(), 0);
    expect(cursor.accept(snapshot({ sequence: 2 }), 1000)).not.toBeNull();
    expect(cursor.accept(snapshot({ sequence: 3, state: 'inactive', ownName: '', names: [] }), 2000)).toBeNull();
    expect(cursor.current(2000)).toBeNull();
  });
  it('heartbeats reporting age zero never extend the original observation deadline or revive it', () => {
    const c = new ExportCursor(); c.accept(snapshot(), 0);
    for (let n = 1; n <= 5; n++) expect(c.accept(snapshot({ sequence: n + 1 }), n * 5000)).not.toBeNull();
    expect(c.accept(snapshot({ sequence: 7 }), 30000)).toBeNull();
    expect(c.accept(snapshot({ sequence: 8 }), 31000)).toBeNull();
    expect(c.accept(snapshot({ sequence: 9, observationSequence: 2 }), 32000)).not.toBeNull();
  });
  it('holds the last validated observation across a transient malformed or partial read', () => {
    const c = new ExportCursor(); c.accept(snapshot(), 0); c.accept(snapshot({ sequence: 2 }), 1000);
    expect(c.accept(null, 1500)).not.toBeNull();
    expect(c.accept(snapshot({ sequence: 2 }), 2000)).not.toBeNull();
    expect(c.accept(snapshot({ sequence: 3 }), 2500)).not.toBeNull();
    expect(c.current(29999)).not.toBeNull();
    expect(c.current(30000)).toBeNull();
  });
  it('rejects backward sequences, observation mutation and holding without established evidence', () => {
    const c = new ExportCursor(); c.accept(snapshot(), 0);
    expect(c.accept(snapshot({ sequence: 2, names: ['Different'] }), 1000)).toBeNull();
    expect(c.accept(snapshot({ sequence: 3, observationSequence: 2 }), 2000)).not.toBeNull();
    expect(c.accept(snapshot({ sequence: 4, observationSequence: 1 }), 3000)).toBeNull();
    const holding = new ExportCursor(); holding.accept(snapshot({ state: 'holding' }), 0);
    expect(holding.accept(snapshot({ sequence: 2, state: 'holding' }), 1000)).toBeNull();
  });
  it('accepts a fresh world, quarantines old worlds, and baselines new writer sessions', () => {
    const c = new ExportCursor(); c.accept(snapshot(), 0); c.accept(snapshot({ sequence: 2 }), 1000);
    expect(c.accept(snapshot({ sequence: 3, observationSequence: 2, worldGeneration: 'world-b' }), 2000)).not.toBeNull();
    expect(c.accept(snapshot({ sequence: 4, observationSequence: 3 }), 3000)).toBeNull();
    expect(c.accept(snapshot({ sessionId: 'session-b' }), 4000)).toBeNull();
    expect(c.accept(snapshot({ sessionId: 'session-b', sequence: 2 }), 5000)).not.toBeNull();
    expect(c.accept(snapshot({ sequence: 9, observationSequence: 9 }), 6000)).toBeNull();
  });
  it('accounts for time spent awaiting a read before accepting newer evidence', () => {
    const c = new ExportCursor(); c.accept(snapshot(), 0);
    expect(c.accept(snapshot({ sequence: 2, observationSequence: 2 }), 32000, 1000)).toBeNull();
  });
});

describe('bounded asynchronous watcher lifecycle', () => {
  it('does not leave the room for a transient export replacement gap', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let value = snapshot();
    const onSnapshot = vi.fn(), onInactive = vi.fn();
    const watcher = watchExports({ environment: 'dev',
      discover: async () => [{ root: '/game', relative: 'x.json', provider: 'zfe' }],
      read: async () => value ? JSON.stringify(value) : null, onSnapshot, onInactive });
    await vi.advanceTimersByTimeAsync(1000);
    value = snapshot({ sequence: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).toHaveBeenCalledOnce();
    value = null;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onInactive).not.toHaveBeenCalled();
    value = snapshot({ sequence: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onInactive).not.toHaveBeenCalled();
    watcher.stop();
  });
  it('keeps an established room through a 20-second raid HUD reconstruction and resumes in place', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let value = snapshot();
    const onSnapshot = vi.fn(), onInactive = vi.fn();
    const watcher = watchExports({ environment: 'dev',
      discover: async () => [{ root: '/game', relative: 'x.json', provider: 'zfe' }],
      read: async () => value ? JSON.stringify(value) : null, onSnapshot, onInactive });
    await vi.advanceTimersByTimeAsync(1000);
    value = snapshot({ sequence: 2, observationAgeMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).toHaveBeenCalledOnce();
    value = null;
    await vi.advanceTimersByTimeAsync(20000);
    expect(onInactive).not.toHaveBeenCalled();
    value = snapshot({ sequence: 3, observationAgeMs: 22000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onInactive).not.toHaveBeenCalled();
    watcher.stop();
  });
  it('pins non-empty provider paths for the game session instead of relaunching discovery', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const rows = [{ root: '/game', relative: 'x.json', provider: 'xscal' }];
    const discover = vi.fn().mockResolvedValue(rows);
    const read = vi.fn().mockResolvedValue(null);
    const watcher = watchExports({ environment: 'dev', discover, read,
      onSnapshot: vi.fn(), onInactive: vi.fn() });
    await vi.advanceTimersByTimeAsync(30000);
    expect(discover).toHaveBeenCalledOnce();
    expect(read.mock.calls.length).toBeGreaterThan(20);
    watcher.stop();
  });
  it('handles missing files, prefers an advancing provider, fails closed on two writers, and stops', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const rows = [{ root: '/game', relative: 'z.json', provider: 'zfe' }, { root: '/game', relative: 'x.json', provider: 'xscal' }];
    let z = null, x = snapshot({ provider: 'xscal' });
    const onSnapshot = vi.fn(), onInactive = vi.fn();
    const watcher = watchExports({ environment: 'dev', discover: async () => rows,
      read: async (_root, rel) => JSON.stringify(rel === 'z.json' ? z : x), onSnapshot, onInactive });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).not.toHaveBeenCalled();
    z = snapshot(); await vi.advanceTimersByTimeAsync(1000);
    z = snapshot({ sequence: 2 }); await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).toHaveBeenCalledTimes(1); // The old xScal file never advanced.
    x = snapshot({ provider: 'xscal', sequence: 2 }); await vi.advanceTimersByTimeAsync(1000);
    expect(onInactive).toHaveBeenCalledOnce();
    watcher.stop(); z = snapshot({ sequence: 3 }); await vi.advanceTimersByTimeAsync(30000);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
  it('retries discovery for game-before-overlay startup and ignores pending reads after stop', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const discover = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ root: '/game', relative: 'z.json', provider: 'zfe' }]);
    let finish;
    const onSnapshot = vi.fn(), read = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const watcher = watchExports({ environment: 'dev', discover, read, onSnapshot, onInactive: vi.fn() });
    await vi.advanceTimersByTimeAsync(10000);
    expect(discover).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledOnce();
    watcher.stop(); finish(JSON.stringify(snapshot())); await vi.advanceTimersByTimeAsync(20000);
    expect(onSnapshot).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
  });
  it('expires liveness independently of a stalled read and never overlaps reads', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let count = 0, finish;
    const onSnapshot = vi.fn(), onInactive = vi.fn();
    const read = vi.fn(async () => {
      count++;
      if (count <= 2) return JSON.stringify(snapshot({ sequence: count }));
      return new Promise(resolve => { finish = resolve; });
    });
    const watcher = watchExports({ environment: 'dev',
      discover: async () => [{ root: '/game', relative: 'z.json', provider: 'zfe' }], read, onSnapshot, onInactive });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSnapshot).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(26000);
    expect(onInactive).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onInactive).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledTimes(3);
    watcher.stop(); finish(JSON.stringify(snapshot({ sequence: 3 })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot).toHaveBeenCalledOnce();
  });
});
