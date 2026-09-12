import { bridgeBindingId, resolveOverlayBridge, type BridgeBinding, type BridgeResolution } from '../services/relay/overlayServerBridge';
import { getServerHistory, type ServerRoomEvent, type ServerEventEnvelope } from '../services/relay/serverChat';
import { sendServerMessage, ServerMessageError } from '../services/relay/serverMessageService';

type Frame = { type: string; payload: Record<string, unknown> };
interface Dependencies {
  resolve: typeof resolveOverlayBridge;
  history: typeof getServerHistory;
  sendMessage: typeof sendServerMessage;
}
const defaults: Dependencies = { resolve: resolveOverlayBridge, history: getServerHistory, sendMessage: sendServerMessage };

/** Per authenticated socket. Serial work forms a snapshot/live barrier; every
 * delivery revalidates the lease. No global or admin-observer fanout is used. */
export class BridgeConnection {
  private binding: BridgeBinding | null = null;
  private status = '';
  private watched = false;
  private disposed = false;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private seen = new Set<string>();
  constructor(private accountId: string, private emit: (frame: Frame) => void,
    private blocked: () => ReadonlySet<string>, private deps: Dependencies = defaults) {}

  dispose(): void { this.disposed = true; this.binding = null; this.seen.clear(); }
  private output(frame: Frame): void { if (!this.disposed) this.emit(frame); }
  private enqueue(work: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending >= 128) {
      this.output({ type: 'bridge:state', payload: { status: 'unavailable' } });
      this.dispose();
      return Promise.resolve();
    }
    this.pending++;
    this.tail = this.tail.then(async () => { if (!this.disposed) await work(); }).catch(() => {
      this.update({ status: 'inactive' }, 'unavailable');
    }).finally(() => { this.pending--; });
    return this.tail;
  }
  private update(result: BridgeResolution, statusOverride?: string): void {
    const next = result.status === 'ready' ? result.binding : null;
    const id = next ? bridgeBindingId(next) : '';
    const old = this.binding ? bridgeBindingId(this.binding) : '';
    const status = statusOverride ?? result.status;
    if (id !== old) { this.seen.clear(); }
    this.binding = next;
    if (id !== old || this.status !== status) {
      this.status = status;
      this.output({ type: 'bridge:state', payload: { status,
        ...(next ? { channelId: `server:${next.room}`, bindingId: id } : {}) } });
    }
  }
  private async refresh(): Promise<BridgeBinding | null> {
    const result = await this.deps.resolve(this.accountId);
    if (this.disposed) return null;
    this.update(result);
    return this.binding;
  }
  private async matches(binding: BridgeBinding): Promise<boolean> {
    const current = await this.refresh();
    return !!current && bridgeBindingId(current) === bridgeBindingId(binding);
  }
  private rows(events: ServerRoomEvent[], binding: BridgeBinding): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    for (const e of events) {
      if (e.kind !== 'chat.message' || !Number.isSafeInteger(e.id) || e.id <= 0
        || e.messageId !== `server:${binding.room}:${e.id}` || !e.linkedUserId
        || typeof e.body !== 'string' || typeof e.createdAt !== 'string') continue;
      if (this.seen.has(e.messageId)) continue;
      this.seen.add(e.messageId);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
      if (this.blocked().has(e.linkedUserId)) continue;
      rows.push({ id: e.messageId, userId: e.linkedUserId, channelId: `server:${binding.room}`,
        content: e.body, username: e.senderDisplayName, timestamp: e.createdAt, source: 'server',
        tag: e.tag, nameColor: e.nameColor, starColor: e.starColor, badges: e.supporterStar ? ['supporter'] : [] });
    }
    return rows;
  }
  watch(): Promise<void> {
    this.watched = true;
    return this.enqueue(async () => {
      const binding = await this.refresh();
      if (!binding) return;
      // Watch also recovers missed pub/sub frames (up to the room's retained 50).
      const history = await this.deps.history(binding.room, 0, 50);
      if (!(await this.matches(binding))) return;
      const messages = this.rows(history, binding);
      this.output({ type: 'bridge:history', payload: { bindingId: bridgeBindingId(binding),
        channelId: `server:${binding.room}`, messages } });
    });
  }
  receive(envelope: ServerEventEnvelope): Promise<void> {
    if (!this.watched || this.disposed) return Promise.resolve();
    if (envelope.kind === 'rebind') {
      return this.binding?.relayUserId === envelope.userId ? this.watch() : Promise.resolve();
    }
    if (envelope.kind !== 'msg' || this.binding?.room !== envelope.worldId) return Promise.resolve();
    return this.enqueue(async () => {
      const binding = this.binding;
      if (!binding || binding.room !== envelope.worldId || !(await this.matches(binding))) return;
      const messages = this.rows([envelope.event], binding);
      if (messages.length) this.output({ type: 'bridge:message', payload: { bindingId: bridgeBindingId(binding),
        channelId: `server:${binding.room}`, messages } });
    });
  }
  send(channelId: string, bindingId: unknown, content: string): Promise<void> {
    return this.enqueue(async () => {
      const binding = this.watched ? await this.refresh() : null;
      if (!binding || bindingId !== bridgeBindingId(binding) || channelId !== `server:${binding.room}`) {
        this.output({ type: 'error', payload: { message: 'Server session changed; wait for the bridge to reconnect.' } });
        return;
      }
      try {
        await this.deps.sendMessage({ accountId: this.accountId, relayUserId: binding.relayUserId,
          displayName: binding.displayName }, binding.room, content, () => this.matches(binding));
        // Delivery comes only from Redis pub/sub/history, never a second local echo.
      } catch (err) {
        this.output({ type: 'error', payload: { message: err instanceof ServerMessageError ? err.message : 'Server message delivery could not be confirmed. Check history before resending.' } });
      }
    });
  }
}
