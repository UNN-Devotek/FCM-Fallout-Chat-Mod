'use strict';

const { bridgeEnvironment, watchExports, generation } = require('./local-bridge-files');

/** One desktop owner. Renderer IPC can request history or send chat, but it can
 * neither submit local evidence nor select the legacy account-wide bridge. */
class LocalBridgeRelay {
  constructor({ relayHttp, discover, emit, watch = watchExports, onTiming }) {
    this.environment = bridgeEnvironment(relayHttp);
    this.discover = discover; this.emit = emit; this.watch = watch;
    this.onTiming = onTiming;
    this.token = null; this.gameRunning = false; this.owner = null;
    this.watcher = null; this.expected = null; this.binding = null;
    this.epoch = 0;
  }
  send(owner, type, payload = {}) {
    if (owner?.socket.readyState !== 1) return;
    try { owner.socket.send(JSON.stringify({ type, payload })); } catch { /* Closing socket. */ }
  }
  clear(leave = true, reason = 'explicit_inactive') {
    this.epoch++;
    this.watcher?.stop(); this.watcher = null;
    this.expected = null; this.binding = null;
    if (this.owner) {
      if (leave) this.send(this.owner, 'bridge:leave', { reason });
      this.emit(this.owner.id, { type: 'bridge:state', payload: { status: 'inactive' } });
    }
  }
  setAuth(token) {
    if (this.token === token) return;
    this.clear(true, 'account_change'); this.owner = null; this.token = token;
  }
  setGameRunning(running) {
    if (this.gameRunning === running) return;
    this.gameRunning = running;
    if (!running) this.clear(true, 'game_exit');
    this.send(this.owner, 'client:status', { inGame: running });
    if (running) this.start();
  }
  opened(id, socket, token) {
    if (!token || token !== this.token) return false;
    this.clear(true, 'socket_replaced');
    this.owner = { id, socket, token };
    this.send(this.owner, 'client:status', { inGame: this.gameRunning });
    // This must precede buffered renderer watch frames and all observations.
    this.send(this.owner, 'bridge:watch', { mode: 'local-export' });
    this.start();
    return true;
  }
  start() {
    if (this.watcher || !this.environment || !this.token || !this.gameRunning || !this.owner) return;
    const owner = this.owner, epoch = this.epoch;
    const current = () => epoch === this.epoch && this.owner === owner && this.token === owner.token && this.gameRunning;
    this.watcher = this.watch({ environment: this.environment,
      onTiming: this.onTiming,
      discover: () => this.discover(this.environment),
      onSnapshot: snapshot => {
        if (!current()) return;
        const key = generation(snapshot);
        if (this.expected?.key !== key) {
          this.binding = null;
          this.emit(owner.id, { type: 'bridge:state', payload: { status: 'inactive' } });
          this.expected = { key, sessionId: snapshot.sessionId, worldGeneration: snapshot.worldGeneration,
            firstSequence: snapshot.sequence, latestSequence: snapshot.sequence };
        } else this.expected.latestSequence = snapshot.sequence;
        this.send(owner, 'bridge:observe', snapshot);
      },
      onInactive: (reason = 'observation_timeout') => {
        if (!current()) return;
        this.expected = null; this.binding = null;
        this.send(owner, 'bridge:leave', { reason });
        this.emit(owner.id, { type: 'bridge:state', payload: { status: 'inactive' } });
      },
    });
  }
  closed(id, socket) {
    if (this.owner?.id !== id || this.owner.socket !== socket) return;
    this.clear(); this.owner = null;
  }
  outgoing(id, socket, data) {
    let frame;
    try { frame = JSON.parse(data); } catch { return data; }
    if (frame?.type === 'bridge:observe' || frame?.type === 'bridge:leave') return null;
    const owned = this.owner?.id === id && this.owner.socket === socket && this.owner.token === this.token;
    if (frame?.type === 'bridge:watch') {
      return owned ? JSON.stringify({ type: 'bridge:watch', payload: { mode: 'local-export' } }) : null;
    }
    if (frame?.type === 'client:status') {
      return JSON.stringify({ ...frame, payload: { ...frame.payload, inGame: this.gameRunning } });
    }
    if ((frame?.type === 'chat:send' || frame?.type === 'send-message')
      && (String(frame.payload?.channelId || '').startsWith('server:') || frame.payload?.bridgeBindingId)) {
      if (!owned || !this.gameRunning || !this.expected || !this.binding
        || frame.payload.channelId !== this.binding.channelId || frame.payload.bridgeBindingId !== this.binding.bindingId) return null;
    }
    return data;
  }
  incoming(id, socket, frame) {
    if (typeof frame?.type !== 'string' || !frame.type.startsWith('bridge:')) return true;
    if (this.owner?.id !== id || this.owner.socket !== socket || this.owner.token !== this.token) return false;
    const p = frame.payload;
    if (frame.type === 'bridge:state') {
      if (p?.status !== 'ready') { this.binding = null; return true; }
      const e = this.expected;
      if (!this.gameRunning || !e || p.sessionId !== e.sessionId || p.worldGeneration !== e.worldGeneration
        || !Number.isSafeInteger(p.sequence) || p.sequence < e.firstSequence || p.sequence > e.latestSequence
        || typeof p.bindingId !== 'string' || typeof p.channelId !== 'string' || !p.channelId.startsWith('server:r:')) return false;
      this.binding = { bindingId: p.bindingId, channelId: p.channelId };
      return true;
    }
    return !!this.expected && !!this.binding && this.gameRunning
      && p?.bindingId === this.binding.bindingId && p.channelId === this.binding.channelId;
  }
  dispose() { this.clear(true, 'app_quit'); this.owner = null; this.token = null; }
}

module.exports = { LocalBridgeRelay };
