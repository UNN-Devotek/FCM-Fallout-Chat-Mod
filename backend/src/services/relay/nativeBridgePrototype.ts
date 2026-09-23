import env from '../../config/environment';
import { parseLocalBridgeObservation, type LocalBridgeObservation } from './localExportBridge';

export const NATIVE_BRIDGE_CONTROL = 'FCMCTL/1/NATIVE-PROTOTYPE:';
export function nativeBridgePrototypeEnabled(): boolean {
  return process.env.FCM_NATIVE_BRIDGE_PROTOTYPE === '1' && env.NODE_ENV !== 'production';
}
type Entry = {
  accountId: string; nativeId: string; snapshot: LocalBridgeObservation;
  receivedAt: number; deadline: number; advances: number; owner: object | null;
};

/** Deliberately local-development only: bounded, single-process rendezvous.
 * The native token authenticates ingress; an authenticated desktop claims one
 * exact session from its one-write capsule. Nothing selects an account-wide room.
 * Sequence watermarks remain until restart, so old packets cannot replay into life.
 */
export class NativeBridgePrototype {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}
  ingest(accountId: string, nativeId: string, value: unknown): boolean {
    if (!value || typeof value !== 'object' || !('sentAt' in value) || !('snapshot' in value)) return false;
    const sentAt = value.sentAt;
    const snapshot = parseLocalBridgeObservation(value.snapshot);
    const now = this.now();
    if (!accountId || !nativeId || !snapshot || snapshot.environment !== 'dev' || snapshot.provider !== 'xscal'
      || !/^np-[a-z0-9-]{24,60}$/.test(snapshot.sessionId)
      || typeof sentAt !== 'number' || !Number.isSafeInteger(sentAt) || sentAt > now + 2000 || now - sentAt >= 30000) return false;
    // Include transport queuing time. Clock skew can only tighten the deadline;
    // forward skew over two seconds fails closed and must be fixed for this test.
    const age = snapshot.observationAgeMs + Math.max(0, now - sentAt) + 2000;
    if (snapshot.state !== 'inactive' && age >= 30000) return false;
    const old = this.entries.get(snapshot.sessionId);
    if (old && (old.accountId !== accountId || old.nativeId !== nativeId
      || snapshot.sequence <= old.snapshot.sequence || snapshot.observationSequence < old.snapshot.observationSequence)) return false;
    if (!old && this.entries.size >= 64) return false;
    const same = old?.snapshot.observationSequence === snapshot.observationSequence;
    if (old && old.deadline <= now && same) return false;
    if (same && snapshot.state !== 'inactive' && (snapshot.worldGeneration !== old.snapshot.worldGeneration
      || snapshot.ownName !== old.snapshot.ownName || JSON.stringify(snapshot.names) !== JSON.stringify(old.snapshot.names))) return false;
    if (snapshot.state === 'holding' && (!old || !same || old.snapshot.state === 'inactive')) return false;
    const adjusted = { ...snapshot, observationAgeMs: Math.min(60000, age) };
    const deadline = snapshot.state === 'inactive' ? now + 30000
      : same ? Math.min(old.deadline, now + 30000 - age) : now + 30000 - age;
    this.entries.set(snapshot.sessionId, { accountId, nativeId, snapshot: adjusted, receivedAt: now,
      deadline, advances: (old && old.deadline > now ? old.advances : 0) + (same ? 0 : 1), owner: old?.owner ?? null });
    return true;
  }
  claim(accountId: string, sessionId: string, owner: object): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.accountId !== accountId || entry.deadline <= this.now() || entry.advances < 2
      || (entry.owner !== null && entry.owner !== owner)) return false;
    entry.owner = owner;
    return true;
  }
  read(accountId: string, sessionId: string, owner: object): Entry | null {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.owner !== owner || entry.accountId !== accountId || entry.deadline <= this.now()) return null;
    return entry;
  }
  release(owner: object): void {
    for (const entry of this.entries.values()) if (entry.owner === owner) entry.owner = null;
  }
}
export const nativeBridgePrototype = new NativeBridgePrototype();
