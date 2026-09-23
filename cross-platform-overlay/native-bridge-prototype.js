'use strict';
const { LocalBridgeRelay } = require('./local-bridge-relay');
const { readBoundedFile } = require('./local-bridge-files');

function parseCapsule(text) {
  try {
    const c = JSON.parse(text);
    return c?.schemaVersion === 'native-prototype-1' && c.environment === 'dev' && c.provider === 'xscal'
      && typeof c.sessionId === 'string' && /^np-[a-z0-9-]{24,60}$/.test(c.sessionId)
      && Object.keys(c).sort().join(',') === 'environment,provider,schemaVersion,sessionId' ? c : null;
  } catch { return null; }
}

/** Development-only main-process adapter. Renderer cannot choose a native session.
 * A static capsule locates a session; only backend-authenticated live observations
 * establish membership. No roster data crosses renderer IPC.
 */
class NativeBridgePrototypeRelay extends LocalBridgeRelay {
  constructor(options) { super(options); this.read = options.read || readBoundedFile; }
  start() {
    if (this.watcher || this.environment !== 'dev' || !this.token || !this.gameRunning || !this.owner) return;
    const owner = this.owner, epoch = this.epoch;
    let timer, stopped = false;
    const current = () => !stopped && epoch === this.epoch && this.owner === owner && this.gameRunning;
    const tick = async () => {
      try {
        const candidates = (await this.discover('dev')).filter(c => c.provider === 'xscal').slice(0, 16);
        const capsules = [];
        for (const c of candidates) {
          const capsule = parseCapsule(await this.read(c.root, c.relative, 1024));
          if (capsule) capsules.push(capsule);
        }
        if (!current()) return;
        if (capsules.length !== 1) {
          this.nativeSession = null;
          this.expected = null; this.binding = null;
          this.send(owner, 'bridge:leave', { reason: 'invalid_export' });
          this.emit(owner.id, { type: 'bridge:state', payload: { status: 'inactive' } });
        } else {
          const sessionId = capsules[0].sessionId;
          if (this.nativeSession !== sessionId) {
            this.nativeSession = sessionId; this.expected = null; this.binding = null;
            this.emit(owner.id, { type: 'bridge:state', payload: { status: 'inactive' } });
          }
          this.send(owner, 'bridge:native-pair', { sessionId });
        }
      } catch {
        if (current()) {
          this.nativeSession = null; this.expected = null; this.binding = null;
          this.send(owner, 'bridge:leave', { reason: 'invalid_export' });
          this.emit(owner.id, { type: 'bridge:state', payload: { status: 'inactive' } });
        }
      } finally { if (current()) timer = setTimeout(tick, 5000); }
    };
    this.watcher = { stop() { stopped = true; clearTimeout(timer); } };
    void tick();
  }
  clear(...args) { this.nativeSession = null; super.clear(...args); }
  outgoing(id, socket, data) {
    try { if (JSON.parse(data)?.type === 'bridge:native-pair') return null; } catch { /* Parent handles parse. */ }
    return super.outgoing(id, socket, data);
  }
  incoming(id, socket, frame) {
    if (frame?.type === 'bridge:native-observation') {
      const p = frame.payload;
      if (this.owner?.id === id && this.owner.socket === socket && this.owner.token === this.token
        && this.gameRunning && p?.sessionId === this.nativeSession && typeof p.worldGeneration === 'string'
        && /^[a-z0-9-]{1,64}$/.test(p.worldGeneration) && Number.isSafeInteger(p.sequence) && p.sequence > 0) {
        const key = `${p.sessionId}/${p.worldGeneration}`;
        if (this.expected?.key !== key) {
          this.binding = null;
          this.emit(id, { type: 'bridge:state', payload: { status: 'inactive' } });
          this.expected = { key, sessionId: p.sessionId, worldGeneration: p.worldGeneration,
            firstSequence: p.sequence, latestSequence: p.sequence };
        } else this.expected.latestSequence = Math.max(this.expected.latestSequence, p.sequence);
      }
      return false;
    }
    return super.incoming(id, socket, frame);
  }
}
module.exports = { NativeBridgePrototypeRelay, parseCapsule };
