import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type CanonicalMessage = { id: string; content: string; userId: string; channelId: string;
  parentChannelId?: string | null; source?: string; createdAt?: string | Date; metadata?: unknown; relaySeq?: number };
export type MessageReceipt = { id: string; createdAt: string; digest: string; persisted: boolean };
export type PersistedCanonicalRow = { id: string; created_at: Date | string; content: string; user_id: string;
  channel_id: string; parent_channel_id: string | null; source: string; metadata: unknown; relay_seq: bigint | string | null };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stable(entry)]));
  return value;
}

export function canonicalDigest(message: CanonicalMessage): string {
  return createHash('sha256').update(JSON.stringify([message.id, message.content, message.userId, message.channelId,
    message.parentChannelId ?? null, message.source || 'game', stable(message.metadata ?? null), message.relaySeq?.toString() ?? null]))
    .digest('hex');
}

/** Stores IDs/timestamps/digests, never chat bodies or tokens. Keep with the
 * source checkpoint until accepted IDs have been independently verified.
 */
export class MessageLedger {
  private readonly receipts = new Map<string, MessageReceipt>();
  private readonly pendingById = new Map<string, Map<string, MessageReceipt>>();
  private verifiedCount = 0;
  private readonly filename: string;
  constructor(private readonly directory: string) {
    this.filename = path.join(directory, 'messages.jsonl');
    if (existsSync(this.filename)) {
      for (const line of readFileSync(this.filename, 'utf8').split('\n').filter(Boolean)) {
        const receipt: MessageReceipt = JSON.parse(line);
        if (typeof receipt.id !== 'string' || typeof receipt.createdAt !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)) {
          throw new Error('Invalid accepted-message ledger; operator recovery required');
        }
        const key = `${receipt.id}:${receipt.createdAt}`;
        const prior = this.receipts.get(key);
        if (receipt.persisted && !prior?.persisted) this.verifiedCount++;
        this.receipts.set(key, receipt);
        this.indexPending(key, receipt);
      }
    }
  }
  private indexPending(key: string, receipt: MessageReceipt): void {
    if (receipt.persisted) {
      const pending = this.pendingById.get(receipt.id);
      pending?.delete(key);
      if (pending?.size === 0) this.pendingById.delete(receipt.id);
      return;
    }
    const pending = this.pendingById.get(receipt.id) ?? new Map<string, MessageReceipt>();
    pending.set(key, receipt); this.pendingById.set(receipt.id, pending);
  }
  record(message: CanonicalMessage): void {
    if (!message.createdAt) throw new Error('Accepted message has no stable persistence timestamp');
    const receipt = { id: message.id, createdAt: new Date(message.createdAt).toISOString(), digest: canonicalDigest(message), persisted: false };
    const key = `${receipt.id}:${receipt.createdAt}`;
    const prior = this.receipts.get(key);
    if (prior?.digest === receipt.digest) return;
    if (prior) throw new Error('Canonical message ID was accepted with conflicting content');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    appendFileSync(this.filename, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flush: true });
    this.receipts.set(key, receipt);
    this.indexPending(key, receipt);
  }
  async verify(load: (ids: string[]) => Promise<PersistedCanonicalRow[]>, onlyIds?: string[]): Promise<{ verified: number; failures: unknown[] }> {
    const expected = (onlyIds ?? [...this.pendingById.keys()])
      .flatMap(id => [...(this.pendingById.get(id)?.values() ?? [])]);
    const failures: unknown[] = [];
    for (let index = 0; index < expected.length; index += 500) {
      const batch = expected.slice(index, index + 500);
      const rows = await load([...new Set(batch.map(value => value.id))]);
      for (const receipt of batch) {
        const matches = rows.filter(row => row.id === receipt.id);
        const row = matches[0];
        if (matches.length !== 1 || !row || new Date(row.created_at).toISOString() !== receipt.createdAt
          || canonicalDigest({ id: row.id, content: row.content, userId: row.user_id, channelId: row.channel_id,
            parentChannelId: row.parent_channel_id, source: row.source, metadata: row.metadata,
            ...(row.relay_seq === null ? {} : { relaySeq: Number(row.relay_seq) }) }) !== receipt.digest) {
          failures.push({ id: receipt.id, createdAt: receipt.createdAt, count: matches.length, reason: 'canonical-persistence-mismatch' });
        } else {
          // Verify the initial committed row before an ordinary edit/delete may
          // change it. That later authorized mutation must not invalidate proof
          // that this accepted canonical ID was initially persisted once.
          const proof = { ...receipt, persisted: true };
          appendFileSync(this.filename, `${JSON.stringify(proof)}\n`, { mode: 0o600, flush: true });
          this.receipts.set(`${receipt.id}:${receipt.createdAt}`, proof);
          this.indexPending(`${receipt.id}:${receipt.createdAt}`, proof);
          this.verifiedCount++;
        }
      }
    }
    return { verified: this.verifiedCount, failures };
  }
}
