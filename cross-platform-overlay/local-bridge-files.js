'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_BYTES = 8192;
const OBSERVATION_MS = 30000;
// Once two advancing snapshots establish a live writer, a temporary HUDMenu
// reconstruction may stop file writes during raid transitions. Keep the last
// accepted evidence only until its existing observation deadline; never renew
// that deadline from elapsed time or a repeated heartbeat.
const ADVANCE_MS = OBSERVATION_MS;
const KEYS = ['schemaVersion', 'environment', 'provider', 'build', 'sessionId', 'worldGeneration',
  'sequence', 'observationSequence', 'observationAgeMs', 'state', 'ownName', 'names'].sort();

function bridgeEnvironment(relayHttp) {
  try {
    const url = new URL(relayHttp);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (['localhost', '127.0.0.1', '[::1]', 'dev.falloutchatmod.com'].includes(url.hostname)) return 'dev';
    if (url.protocol === 'https:' && ['falloutchatmod.com', 'www.falloutchatmod.com'].includes(url.hostname)) return 'prod';
  } catch { /* Unknown relay: no provider file can authorize it. */ }
  return null;
}

function parseSnapshot(text, environment, provider) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) return null;
    const s = JSON.parse(text);
    const short = value => typeof value === 'string' && value.length <= 64;
    const nonce = value => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
    if (!s || Array.isArray(s) || Object.keys(s).sort().join() !== KEYS.join()
      || s.schemaVersion !== 1 || s.environment !== environment || !['dev', 'prod'].includes(s.environment)
      || s.provider !== provider || !['zfe', 'xscal'].includes(s.provider)
      || !short(s.build) || !s.build || !nonce(s.sessionId) || !nonce(s.worldGeneration)
      || !Number.isSafeInteger(s.sequence) || s.sequence <= 0
      || !Number.isSafeInteger(s.observationSequence) || s.observationSequence <= 0
      || !Number.isFinite(s.observationAgeMs) || s.observationAgeMs < 0 || s.observationAgeMs > 60000
      || !['active', 'holding', 'inactive'].includes(s.state)
      || !short(s.ownName) || !Array.isArray(s.names) || s.names.length > 24 || !s.names.every(short)) return null;
    return s;
  } catch { return null; }
}

/** The trusted discovery root is canonical. No symlink beneath it is followed.
 * Open nonblocking so an attacker swapping a regular file for a pipe cannot
 * hang the main process. Compare the descriptor and path before/after reading. */
async function readBoundedFile(root, relative, maxBytes = MAX_BYTES, io = fs.promises) {
  let handle;
  try {
    if (!path.isAbsolute(root) || path.isAbsolute(relative)) return null;
    const parts = relative.split(/[\\/]/);
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..')) return null;
    let current = root;
    const rootStat = await io.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = await io.lstat(current);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return null;
    }
    if (await io.realpath(current) !== current) return null;
    handle = await io.open(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await handle.stat();
    const entry = await io.lstat(current);
    if (count > maxBytes || count !== before.size || count !== after.size
      || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || !entry.isFile() || entry.isSymbolicLink()
      || entry.dev !== after.dev || entry.ino !== after.ino || entry.size !== after.size
      || entry.mtimeMs !== after.mtimeMs || await io.realpath(current) !== current) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

const generation = s => `${s.provider}/${s.sessionId}/${s.worldGeneration}`;
const evidence = s => JSON.stringify([s.provider, s.ownName.trim().toLowerCase(),
  s.names.map(n => n.trim().toLowerCase()).sort()]);

/** Per file watermarks survive bad reads. A first read is only a baseline. */
class ExportCursor {
  constructor() { this.snapshot = null; this.retired = new Set(); this.lastAdvance = -Infinity; this.deadline = 0; this.live = false; this.failure = ''; }
  accept(s, now, readStartedAt = now) {
    // HUDModLoader replaces the export file rather than updating it in place.
    // Menu reconstruction can therefore expose one missing/partial read between
    // two valid writes. Keep only the last validated sample until its existing
    // writer/evidence deadlines; a read failure must never renew either clock.
    if (!s) return this.current(now);
    const old = this.snapshot;
    const changedSession = old && old.sessionId !== s.sessionId;
    const changedWorld = old && generation(old) !== generation(s);
    if (this.retired.has(generation(s)) || this.retired.has(`session/${s.sessionId}`) || this.retired.size >= 512) {
      this.live = false; this.failure = 'invalid_export'; return null;
    }
    if (old && !changedSession && (s.sequence < old.sequence || s.observationSequence < old.observationSequence)) {
      this.live = false; this.failure = 'invalid_export'; return null;
    }
    if (old && !changedSession && s.sequence === old.sequence) {
      if (JSON.stringify(s) !== JSON.stringify(old)) { this.live = false; this.failure = 'invalid_export'; }
      return this.current(now);
    }
    const sameObservation = old && !changedSession && old.observationSequence === s.observationSequence;
    if (sameObservation && s.state !== 'inactive' && (changedWorld || evidence(old) !== evidence(s))) {
      this.live = false; this.failure = 'invalid_export'; return null;
    }
    const wasLive = !!this.current(now);
    if (changedWorld) this.retired.add(generation(old));
    if (changedSession) this.retired.add(`session/${old.sessionId}`);
    this.deadline = sameObservation ? Math.min(this.deadline, readStartedAt + OBSERVATION_MS - s.observationAgeMs)
      : readStartedAt + OBSERVATION_MS - s.observationAgeMs;
    this.snapshot = s;
    this.lastAdvance = readStartedAt;
    this.failure = s.state === 'inactive' ? 'explicit_inactive' : '';
    // A session switch must establish its own advancing baseline. Holding may
    // preserve evidence only; it cannot attach or restore an invalidated file.
    this.live = !!old && !changedSession && s.state !== 'inactive' && !!s.ownName.trim()
      && (s.state !== 'holding' || (sameObservation && wasLive))
      && (!sameObservation || wasLive || old === this.baseline);
    this.baseline = !old || changedSession ? s : null;
    return this.current(now);
  }
  current(now) {
    return this.live && now - this.lastAdvance < ADVANCE_MS && now < this.deadline ? this.snapshot : null;
  }
  inactiveReason(now) { return this.failure || (now >= this.deadline || now - this.lastAdvance >= ADVANCE_MS
    ? 'observation_timeout' : 'invalid_export'); }
}

/** Polling avoids native watcher races when providers replace or create files.
 * At most one bounded read pass runs at once; discovery is retried for startup
 * ordering. No export content, names, tokens or identifiers are logged. */
function watchExports({ environment, discover, onSnapshot, onInactive, now = Date.now,
  read = readBoundedFile, intervalMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, onTiming }) {
  let stopped = false, timer, expiryTimer, busy = false, candidates = [], discoveredAt = -Infinity, selected = '', published = '';
  const cursors = new Map();
  function expire() {
    if (stopped) return;
    if (selected && !cursors.get(selected)?.current(now())) {
      const cursor = cursors.get(selected);
      selected = ''; published = ''; onInactive(cursor?.inactiveReason(now()) ?? 'observation_timeout');
    }
    expiryTimer = setTimer(expire, intervalMs);
  }
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    const passStarted = now();
    try {
      const time = now();
      // A non-empty result is fixed for this game/watcher lifetime. On Windows,
      // discovery queries process metadata through PowerShell/WMI; relaunching it
      // every ten seconds caused a recurring ~1s I/O/process spike in live xScal
      // profiling. Missing startup paths still retry until the provider roots exist.
      if (!candidates.length && time - discoveredAt >= 10000) {
        candidates = (await discover()).slice(0, 64); discoveredAt = time;
      }
      const rows = await Promise.all(candidates.map(async c => {
        const key = path.join(c.root, c.relative);
        let cursor = cursors.get(key);
        if (!cursor) { cursor = new ExportCursor(); cursors.set(key, cursor); }
        const started = now();
        const raw = await read(c.root, c.relative);
        const finished = now();
        const snapshot = cursor.accept(parseSnapshot(raw, environment, c.provider), finished, started);
        return { key, snapshot, started };
      }));
      if (stopped) return;
      const completed = now();
      const active = rows.filter(r => r.snapshot && cursors.get(r.key)?.current(completed));
      if (active.length !== 1) {
        if (selected) onInactive(active.length > 1 ? 'provider_conflict'
          : cursors.get(selected)?.inactiveReason(completed) ?? 'invalid_export');
        selected = ''; published = '';
      } else {
        const row = active[0];
        const marker = `${row.key}/${generation(row.snapshot)}/${row.snapshot.sequence}`;
        if (published !== marker) {
          selected = row.key; published = marker;
          onSnapshot({ ...row.snapshot,
            observationAgeMs: Math.min(60000, row.snapshot.observationAgeMs + Math.max(0, completed - row.started)) });
        }
      }
      // Discovery remains bounded over repeated game/library changes.
      const known = new Set(candidates.map(c => path.join(c.root, c.relative)));
      for (const key of cursors.keys()) if (!known.has(key)) cursors.delete(key);
    } catch { if (!stopped && selected) onInactive('invalid_export'); selected = ''; published = ''; }
    finally {
      busy = false;
      if (!stopped) {
        try { onTiming?.({ durationMs: Math.max(0, now() - passStarted), candidates: candidates.length }); } catch { /* Diagnostics never affect delivery. */ }
        timer = setTimer(tick, intervalMs);
      }
    }
  }
  expiryTimer = setTimer(expire, intervalMs);
  void tick();
  return { stop() { stopped = true; clearTimer(timer); clearTimer(expiryTimer); } };
}

module.exports = { MAX_BYTES, ADVANCE_MS, OBSERVATION_MS, bridgeEnvironment, parseSnapshot,
  readBoundedFile, ExportCursor, watchExports, generation };
