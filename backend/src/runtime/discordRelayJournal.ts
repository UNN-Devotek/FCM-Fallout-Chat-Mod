import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { DrainInspection } from './coordinator';

const FORMAT = 'fcm-discord-relay-v1';
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 2048;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PAYLOAD_FILES = 4096;
const PREFIX_BLOCK_BYTES = 256 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9_:=.-]{1,160}$/;
const SNOWFLAKE = /^\d{1,22}$/;

export type DiscordRelayIntent = {
  operationId: string;
  canonicalId: string;
  createdAt: string;
  channelId: string;
  discordChannelId: string;
  configDigest: string;
  payloadDigest: string;
};
type RelayState = { intent: Readonly<DiscordRelayIntent>; stage: 'intent' | 'attempt' }
  | { intent: Readonly<DiscordRelayIntent>; stage: 'returned' | 'complete'; discordMessageId: string };
type JournalRecord = { format: typeof FORMAT; stage: 'intent'; intent: DiscordRelayIntent }
  | { format: typeof FORMAT; stage: 'attempt'; operationId: string }
  | { format: typeof FORMAT; stage: 'returned' | 'complete'; operationId: string; discordMessageId: string };
export type DiscordRelayPayload = {
  channelId: string;
  username: string;
  content: string;
  channelName: string | null;
  mentions: Array<{ name: string; discordId: string }> | null;
  metadata: Record<string, unknown> | null;
  authorCosmetics: { badges?: readonly string[] | null } | null;
  discordPrefix: string;
};
type PayloadReference = { canonicalId: string; createdAt: string; payloadDigest: string; channelId: string; bytes: number };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}
export function discordRelayDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function discordRelayOperationId(canonicalId: string): string {
  // The timestamp is a bound value, never a way to make a second key for one ID.
  return discordRelayDigest(['ordinary-discord-relay', canonicalId.toLowerCase()]);
}
function object(value: unknown): value is { [key: string]: unknown } {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: { [key: string]: unknown }, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === expected.sort().join(',');
}
function validIntent(value: unknown): value is DiscordRelayIntent {
  if (!object(value) || !keys(value, ['operationId', 'canonicalId', 'createdAt', 'channelId', 'discordChannelId', 'configDigest', 'payloadDigest'])) return false;
  if (typeof value.canonicalId !== 'string' || !UUID.test(value.canonicalId)
    || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.channelId !== 'string' || !ID.test(value.channelId)
    || typeof value.discordChannelId !== 'string' || !SNOWFLAKE.test(value.discordChannelId)
    || typeof value.configDigest !== 'string' || !HASH.test(value.configDigest)
    || typeof value.payloadDigest !== 'string' || !HASH.test(value.payloadDigest)) return false;
  return value.operationId === discordRelayOperationId(value.canonicalId);
}
function refused(): Error { return new Error('Discord relay journal is incomplete or unavailable; private recovery required'); }
function privateEntry(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
    || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (process.getuid && stat.uid !== process.getuid())) throw refused();
}
function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function readBounded(descriptor: number, limit: number): Buffer {
  const stat = fstatSync(descriptor);
  if (!stat.size || stat.size > limit) throw refused();
  const bytes = Buffer.alloc(stat.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (!count) break;
    offset += count;
  }
  if (offset !== stat.size || fstatSync(descriptor).size !== stat.size) throw refused();
  return bytes.subarray(0, offset);
}

/** Ordinary-message create evidence only. No payload, retry, repair, disposition
 * or removal API. Each complete append is fsynced before its dependent action.
 * A torn append, unknown stage or changed binding refuses the entire journal.
 */
export class DiscordRelayJournal {
  readonly filename: string;
  readonly payloadDirectory: string;
  private readonly observedStates = new Map<string, RelayState>();
  private readonly observedPayloads = new Set<string>();
  private readonly prefix: Buffer[] = [];
  private prefixBytes = 0;
  private journalStat: Stats | undefined;
  private failed: 'integrity' | 'persistence' | undefined;
  constructor(private readonly directory: string) {
    this.filename = path.join(directory, 'discord-relays.jsonl');
    this.payloadDirectory = path.join(directory, 'discord-relay-payloads');
    this.inspect();
  }

  /** The only protected input fields are original relay arguments and the exact
   * link prefix, never SDK options, OAuth or interaction bearer credentials.
   * Persist before even a mapping lookup can fail on live-only REST work.
   */
  retain(canonicalId: string, createdAt: string, payload: DiscordRelayPayload): { operationId: string; payloadDigest: string } {
    const operationId = discordRelayOperationId(canonicalId), payloadDigest = discordRelayDigest(payload);
    if (!validIntent({ operationId, canonicalId, createdAt, channelId: payload.channelId, discordChannelId: '0',
      payloadDigest, configDigest: '0'.repeat(64) })) throw refused();
    const prior = this.read().states.get(operationId);
    if (prior) {
      if (prior.intent.canonicalId !== canonicalId || prior.intent.createdAt !== createdAt || prior.intent.payloadDigest !== payloadDigest) {
        throw new Error('Discord relay operation identity conflicts with retained evidence');
      }
      if (prior.stage === 'complete') return { operationId, payloadDigest };
      throw refused();
    }
    let descriptor: number | undefined;
    try {
      const body = JSON.stringify({ format: 'fcm-discord-relay-payload-v1', canonicalId, createdAt, payloadDigest, payload });
      if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) throw refused();
      const references = this.payloadReferences();
      if (references.size >= MAX_PAYLOAD_FILES || [...references.values()].reduce((sum, value) => sum + value.bytes, 0)
        + Buffer.byteLength(body) > MAX_BYTES) throw refused();
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); privateEntry(lstatSync(this.directory), true);
      mkdirSync(this.payloadDirectory, { mode: 0o700, recursive: true }); privateEntry(lstatSync(this.payloadDirectory), true);
      descriptor = openSync(path.join(this.payloadDirectory, `${operationId}.json`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, body); fsyncSync(descriptor);
      syncDirectory(this.payloadDirectory); syncDirectory(this.directory);
      this.observedPayloads.add(operationId);
      return { operationId, payloadDigest };
    } catch { throw refused(); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  private payloadReferences(): Map<string, PayloadReference> {
    const references = new Map<string, PayloadReference>();
    try {
      try { privateEntry(lstatSync(this.payloadDirectory), true); }
      catch (error) { if (object(error) && error.code === 'ENOENT' && this.observedPayloads.size === 0) return references; throw error; }
      const filenames = readdirSync(this.payloadDirectory);
      if (filenames.length > MAX_PAYLOAD_FILES) throw refused();
      let totalBytes = 0;
      for (const name of filenames) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw refused();
        let descriptor: number | undefined;
        try {
          descriptor = openSync(path.join(this.payloadDirectory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = fstatSync(descriptor); privateEntry(stat, false);
          totalBytes += stat.size;
          if (!stat.size || stat.size > MAX_PAYLOAD_BYTES || totalBytes > MAX_BYTES) throw refused();
          const bytes = readBounded(descriptor, MAX_PAYLOAD_BYTES);
          if (bytes.length !== stat.size || !bytes.equals(Buffer.from(bytes.toString('utf8')))) throw refused();
          const value: unknown = JSON.parse(bytes.toString('utf8'));
          if (JSON.stringify(value) !== bytes.toString('utf8') || !object(value) || !keys(value, ['format', 'canonicalId', 'createdAt', 'payloadDigest', 'payload'])
            || value.format !== 'fcm-discord-relay-payload-v1' || !object(value.payload)
            || !keys(value.payload, ['channelId', 'username', 'content', 'channelName', 'mentions', 'metadata', 'authorCosmetics', 'discordPrefix'])
            || typeof value.payload.discordPrefix !== 'string' || typeof value.payload.username !== 'string'
            || typeof value.payload.content !== 'string' || value.payloadDigest !== discordRelayDigest(value.payload)
            || !validIntent({ operationId: name.slice(0, -5), canonicalId: value.canonicalId, createdAt: value.createdAt,
              channelId: value.payload.channelId, discordChannelId: '0', configDigest: '0'.repeat(64), payloadDigest: value.payloadDigest })) throw refused();
          // Validation above proves these original stable fields. Do not carry
          // raw protected contents into participant or operator inspection.
          references.set(name.slice(0, -5), { canonicalId: value.canonicalId as string, createdAt: value.createdAt as string,
            payloadDigest: value.payloadDigest as string, channelId: value.payload.channelId as string, bytes: stat.size });
        } finally { if (descriptor !== undefined) closeSync(descriptor); }
      }
      if ([...this.observedPayloads].some(operationId => !references.has(operationId))) throw refused();
      for (const operationId of references.keys()) this.observedPayloads.add(operationId);
      return references;
    } catch { throw refused(); }
  }

  private requirePayload(intent: DiscordRelayIntent, references = this.payloadReferences()): void {
    const reference = references.get(intent.operationId);
    if (!reference || reference.canonicalId !== intent.canonicalId || reference.createdAt !== intent.createdAt
      || reference.channelId !== intent.channelId || reference.payloadDigest !== intent.payloadDigest) throw refused();
  }

  private remember(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const index = Math.floor(this.prefixBytes / PREFIX_BLOCK_BYTES), start = this.prefixBytes % PREFIX_BLOCK_BYTES;
      if (!this.prefix[index]) this.prefix[index] = Buffer.allocUnsafe(PREFIX_BLOCK_BYTES);
      const count = Math.min(bytes.length - offset, PREFIX_BLOCK_BYTES - start);
      bytes.copy(this.prefix[index], start, offset, offset + count);
      offset += count; this.prefixBytes += count;
    }
  }

  /** Compare every validated byte; size and filesystem timestamps cannot prove
   * that an old record is unchanged. Only this instance's durable appends grow
   * the cache. A new process always performs the complete semantic parse.
   */
  private verifyPrefix(descriptor: number, stat: Stats): void {
    if (!this.journalStat || stat.dev !== this.journalStat.dev || stat.ino !== this.journalStat.ino
      || stat.size !== this.prefixBytes) throw refused();
    const scratch = Buffer.allocUnsafe(PREFIX_BLOCK_BYTES);
    for (let position = 0; position < this.prefixBytes; position += PREFIX_BLOCK_BYTES) {
      const length = Math.min(PREFIX_BLOCK_BYTES, this.prefixBytes - position);
      let offset = 0;
      while (offset < length) {
        const count = readSync(descriptor, scratch, offset, length - offset, position + offset);
        if (!count) throw refused();
        offset += count;
      }
      if (!scratch.subarray(0, length).equals(this.prefix[position / PREFIX_BLOCK_BYTES].subarray(0, length))) throw refused();
    }
    if (fstatSync(descriptor).size !== this.prefixBytes) throw refused();
  }

  private read() {
    let descriptor: number | undefined;
    try {
      if (this.failed) throw refused();
      try { privateEntry(lstatSync(this.directory), true); }
      catch (error) {
        if (object(error) && error.code === 'ENOENT' && this.observedStates.size === 0) return { states: new Map<string, RelayState>(), bytes: 0 };
        throw error;
      }
      try { descriptor = openSync(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (object(error) && error.code === 'ENOENT' && this.observedStates.size === 0) return { states: new Map<string, RelayState>(), bytes: 0 };
        throw error;
      }
      const stat = fstatSync(descriptor); privateEntry(stat, false);
      if (stat.size === 0 || stat.size > MAX_BYTES) throw refused();
      if (this.journalStat) {
        this.verifyPrefix(descriptor, stat);
        return { states: this.observedStates, bytes: this.prefixBytes, stat };
      }
      const bytes = readBounded(descriptor, MAX_BYTES);
      if (bytes.length !== stat.size || !bytes.equals(Buffer.from(bytes.toString('utf8')))
        || bytes[bytes.length - 1] !== 10) throw refused();
      const states = new Map<string, RelayState>();
      for (const line of bytes.toString('utf8').slice(0, -1).split('\n')) {
        if (!line || Buffer.byteLength(line) > MAX_RECORD_BYTES) throw refused();
        const record: unknown = JSON.parse(line);
        if (JSON.stringify(record) !== line || !object(record) || record.format !== FORMAT) throw refused();
        if (record.stage === 'intent') {
          if (!keys(record, ['format', 'stage', 'intent']) || !validIntent(record.intent)
            || states.has(record.intent.operationId)) throw refused();
          states.set(record.intent.operationId, { intent: Object.freeze({ ...record.intent }), stage: 'intent' });
          continue;
        }
        if (typeof record.operationId !== 'string') throw refused();
        const prior = states.get(record.operationId);
        if (!prior) throw refused();
        if (record.stage === 'attempt' && prior.stage === 'intent' && keys(record, ['format', 'stage', 'operationId'])) {
          states.set(record.operationId, { intent: prior.intent, stage: 'attempt' });
        } else if ((record.stage === 'returned' && prior.stage === 'attempt'
          || record.stage === 'complete' && prior.stage === 'returned' && record.discordMessageId === prior.discordMessageId)
          && keys(record, ['format', 'stage', 'operationId', 'discordMessageId'])
          && typeof record.discordMessageId === 'string' && SNOWFLAKE.test(record.discordMessageId)) {
          states.set(record.operationId, { intent: prior.intent, stage: record.stage, discordMessageId: record.discordMessageId });
        } else throw refused();
      }
      this.remember(bytes);
      for (const [operationId, current] of states) this.observedStates.set(operationId, current);
      this.journalStat = stat;
      return { states, bytes: bytes.length, stat };
    } catch { this.failed ||= 'integrity'; throw refused(); }
    finally {
      try { if (descriptor !== undefined) closeSync(descriptor); }
      catch { this.failed ||= 'integrity'; throw refused(); }
    }
  }

  private append(record: JournalRecord, previous: ReturnType<DiscordRelayJournal['read']>): void {
    let descriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    try {
      // Own the flat string fields before recording or caching them. A caller
      // must not be able to mutate the authoritative intent after admission.
      const owned = record.stage === 'intent' ? { ...record, intent: Object.freeze({ ...record.intent }) } : record;
      const line = Buffer.from(`${JSON.stringify(owned)}\n`);
      if (line.length > MAX_RECORD_BYTES || previous.bytes + line.length > MAX_BYTES) throw refused();
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      privateEntry(lstatSync(this.directory), true);
      descriptor = openSync(this.filename, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (previous.stat ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL), 0o600);
      const stat = fstatSync(descriptor); privateEntry(stat, false);
      if (stat.size !== previous.bytes || previous.stat && (stat.dev !== previous.stat.dev || stat.ino !== previous.stat.ino)) throw refused();
      writeFileSync(descriptor, line);
      fsyncSync(descriptor);
      directoryDescriptor = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fsyncSync(directoryDescriptor);
      const durable = fstatSync(descriptor); privateEntry(durable, false);
      if (durable.size !== previous.bytes + line.length) throw refused();
      closeSync(descriptor); descriptor = undefined;
      closeSync(directoryDescriptor); directoryDescriptor = undefined;
      this.remember(line);
      const next: RelayState = owned.stage === 'intent' ? { intent: owned.intent, stage: 'intent' }
        : owned.stage === 'attempt' ? { intent: previous.states.get(owned.operationId)!.intent, stage: 'attempt' }
          : { intent: previous.states.get(owned.operationId)!.intent, stage: owned.stage, discordMessageId: owned.discordMessageId };
      this.observedStates.set(next.intent.operationId, next);
      this.journalStat = durable;
    } catch { this.failed = 'persistence'; throw refused(); }
    finally {
      try {
        if (descriptor !== undefined) closeSync(descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      } catch { this.failed = 'persistence'; throw refused(); }
    }
  }

  expect(intent: DiscordRelayIntent): boolean {
    if (!validIntent(intent)) throw refused();
    const previous = this.read(), prior = previous.states.get(intent.operationId);
    if (prior) {
      if (discordRelayDigest(prior.intent) !== discordRelayDigest(intent)) throw new Error('Discord relay operation identity conflicts with retained evidence');
      if (prior.stage === 'complete') return false;
      throw refused();
    }
    this.requirePayload(intent);
    this.append({ format: FORMAT, stage: 'intent', intent }, previous);
    return true;
  }

  attempt(operationId: string): void {
    const previous = this.read();
    const prior = previous.states.get(operationId);
    if (prior?.stage !== 'intent') throw refused();
    this.requirePayload(prior.intent);
    this.append({ format: FORMAT, stage: 'attempt', operationId }, previous);
  }

  returned(operationId: string, discordMessageId: string): void {
    const previous = this.read();
    const prior = previous.states.get(operationId);
    if (prior?.stage !== 'attempt' || !SNOWFLAKE.test(discordMessageId)) throw refused();
    this.requirePayload(prior.intent);
    this.append({ format: FORMAT, stage: 'returned', operationId, discordMessageId }, previous);
  }

  complete(operationId: string, discordMessageId: string): void {
    const previous = this.read(), prior = previous.states.get(operationId);
    if (prior?.stage !== 'returned' || prior.discordMessageId !== discordMessageId) throw refused();
    this.requirePayload(prior.intent);
    this.append({ format: FORMAT, stage: 'complete', operationId, discordMessageId }, previous);
    try {
      unlinkSync(path.join(this.payloadDirectory, `${operationId}.json`));
      syncDirectory(this.payloadDirectory);
      this.observedPayloads.delete(operationId);
    } catch { this.failed = 'persistence'; throw refused(); }
  }

  inspect(): DrainInspection {
    if (this.failed === 'persistence') return { pending: 1, detail: { unavailable: 1 } };
    const states = [...this.read().states.values()];
    const unresolved = states.filter(state => state.stage !== 'complete');
    const references = this.payloadReferences();
    for (const state of unresolved) this.requirePayload(state.intent, references);
    const unaccountedPayloads = [...references.keys()].filter(operationId => !unresolved.some(state => state.intent.operationId === operationId));
    return { pending: unresolved.length + unaccountedPayloads.length,
      detail: { expected: states.length, complete: states.length - unresolved.length,
        protectedInputs: references.size, unaccountedInputs: unaccountedPayloads.length } };
  }
}
