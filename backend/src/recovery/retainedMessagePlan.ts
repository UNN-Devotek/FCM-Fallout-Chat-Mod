import { createHash } from 'node:crypto';
import { canonicalDigest, type CanonicalMessage } from '../runtime/messageLedger';

/** Private, read-only input. Keep original Redis evidence even after disposition. */
export type RetainedMessageJob = Readonly<{
  jobId: string;
  payloadJson: string;
  payloadDigest: string;
  optionsJson: string;
  state: string;
  redisHash: Readonly<Record<string, string>>;
  evidenceRef: string;
}>;
type Proof = { evidenceRef: string };
export type RetainedMessageEvidence = {
  author: ({ kind: 'existing'; userId: string } & Proof)
    | ({ kind: 'merge'; originalUserId: string; userId: string; independentlyConfirmed: true } & Proof)
    | { kind: 'missing' } | { kind: 'unknown' };
  channel: ({ kind: 'compatible'; channelId: string } & Proof) | { kind: 'unknown' };
  governance: ({ kind: 'clear'; independentOfAuditAbsence: true } & Proof)
    | ({ kind: 'moderation' | 'retention' | 'deletion' } & Proof) | { kind: 'unknown' };
  canonical: { kind: 'complete'; rows: ReadonlyArray<{ id: string; createdAt: string; digest: string }> }
    | { kind: 'unknown' };
  external: ({ kind: 'none-confirmed' } & Proof)
    | ({ kind: 'known'; canonicalId: string; sourceMessageId: string } & Proof) | { kind: 'unknown' };
};
type BlockReason = 'invalid-retained-payload' | 'payload-digest-mismatch' | 'missing-author'
  | 'unproved-author' | 'incompatible-channel' | 'governance-unknown' | 'canonical-unknown'
  | 'canonical-time-mismatch' | 'canonical-payload-mismatch' | 'external-link-unknown';
export type RetainedMessagePlan = Readonly<{
  original: RetainedMessageJob;
  /** Classification cannot grant recovery, persistence, queue retry or publication. */
  executionAuthorized: false;
}> & (
  { kind: 'blocked'; reason: BlockReason }
  | { kind: 'blocked'; reason: 'moderation' | 'retention' | 'deletion'; evidenceRef: string }
  | { kind: 'already-preserved'; canonicalId: string; createdAt: string }
  | { kind: 'candidate'; canonicalId: string; createdAt: string; userId: string; digest: string; evidenceRefs: string[] }
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = new Set(['game', 'discord', 'hud', 'relay', 'mcp', 'ws', 'bot', 'web']);
function isPayload(value: unknown): value is CanonicalMessage & { createdAt: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['id', 'userId', 'channelId'].every(key => typeof v[key] === 'string' && UUID.test(v[key]))
    && typeof v.content === 'string' && typeof v.createdAt === 'string'
    && Number.isFinite(Date.parse(v.createdAt)) && new Date(v.createdAt).toISOString() === v.createdAt
    && (v.parentChannelId === undefined || v.parentChannelId === null
      || typeof v.parentChannelId === 'string' && UUID.test(v.parentChannelId))
    && (v.source === undefined || typeof v.source === 'string' && SOURCES.has(v.source))
    && (v.relaySeq === undefined || typeof v.relaySeq === 'number' && Number.isSafeInteger(v.relaySeq) && v.relaySeq >= 0);
}

/** A candidate is a review input for Task2B, never permission to replay. No I/O. */
export function classifyRetainedMessage(original: RetainedMessageJob, evidence: RetainedMessageEvidence): RetainedMessagePlan {
  const base = { original, executionAuthorized: false } as const;
  const blocked = (reason: BlockReason): RetainedMessagePlan => ({ ...base, kind: 'blocked', reason });
  if (createHash('sha256').update(original.payloadJson).digest('hex') !== original.payloadDigest) {
    return blocked('payload-digest-mismatch');
  }
  let message: unknown;
  try { message = JSON.parse(original.payloadJson); } catch { return blocked('invalid-retained-payload'); }
  if (!isPayload(message) || !original.jobId || !original.evidenceRef) return blocked('invalid-retained-payload');

  const governance = evidence.governance;
  if (governance.kind === 'unknown' || !governance.evidenceRef) return blocked('governance-unknown');
  if (governance.kind !== 'clear') {
    return { ...base, kind: 'blocked', reason: governance.kind, evidenceRef: governance.evidenceRef };
  }
  if (governance.independentOfAuditAbsence !== true) return blocked('governance-unknown');
  const author = evidence.author;
  if (author.kind === 'missing') return blocked('missing-author');
  if (author.kind === 'unknown' || !author.evidenceRef || !UUID.test(author.userId)
    || (author.kind === 'existing' ? author.userId !== message.userId
      : author.independentlyConfirmed !== true || author.originalUserId !== message.userId)) return blocked('unproved-author');
  if (evidence.channel.kind !== 'compatible' || evidence.channel.channelId !== message.channelId
    || !evidence.channel.evidenceRef) return blocked('incompatible-channel');
  if (evidence.canonical.kind !== 'complete') return blocked('canonical-unknown');
  const matches = evidence.canonical.rows.filter(row => row.id === message.id);
  if (matches.some(row => row.createdAt !== message.createdAt)) return blocked('canonical-time-mismatch');
  const digest = canonicalDigest({ ...message, userId: author.userId });
  if (matches.length > 1 || matches.some(row => row.digest !== digest)) return blocked('canonical-payload-mismatch');
  const external = evidence.external;
  if (external.kind === 'unknown' || !external.evidenceRef
    || external.kind === 'known' && (external.canonicalId !== message.id || !/^\d{17,20}$/.test(external.sourceMessageId))) {
    return blocked('external-link-unknown');
  }
  if (matches.length === 1) return { ...base, kind: 'already-preserved', canonicalId: message.id, createdAt: message.createdAt };
  return { ...base, kind: 'candidate', canonicalId: message.id, createdAt: message.createdAt,
    userId: author.userId, digest,
    evidenceRefs: [original.evidenceRef, governance.evidenceRef, author.evidenceRef, evidence.channel.evidenceRef, external.evidenceRef] };
}
