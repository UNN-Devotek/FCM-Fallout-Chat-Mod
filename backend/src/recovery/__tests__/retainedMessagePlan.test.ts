import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalDigest } from '../../runtime/messageLedger';
import { classifyRetainedMessage, type RetainedMessageEvidence, type RetainedMessageJob } from '../retainedMessagePlan';

const message = { id: '10000000-0000-4000-8000-000000000001', userId: '20000000-0000-4000-8000-000000000002',
  channelId: '30000000-0000-4000-8000-000000000003', content: 'retained synthetic message', source: 'web', createdAt: '2026-10-13T00:00:00.123Z' };
const payloadJson = JSON.stringify(message);
const job: RetainedMessageJob = { jobId: 'original-bull-24', payloadJson, payloadDigest: createHash('sha256').update(payloadJson).digest('hex'),
  optionsJson: '{"attempts":3,"removeOnFail":50}', state: 'failed', redisHash: { failedReason: 'original constraint failure', attemptsMade: '3' }, evidenceRef: 'protected:retained-job-24' };
const clear = (): RetainedMessageEvidence => ({ author: { kind: 'existing', userId: message.userId, evidenceRef: 'proof:author' },
  channel: { kind: 'compatible', channelId: message.channelId, evidenceRef: 'proof:channel' },
  governance: { kind: 'clear', independentOfAuditAbsence: true, evidenceRef: 'proof:governance' },
  canonical: { kind: 'complete', rows: [] }, external: { kind: 'none-confirmed', evidenceRef: 'proof:external' } });

test('an existing-author candidate preserves every original job field and grants no execution', () => {
  const before = JSON.stringify(job); const result = classifyRetainedMessage(job, clear());
  assert.equal(result.kind, 'candidate'); assert.equal(result.executionAuthorized, false);
  assert.strictEqual(result.original, job); assert.equal(JSON.stringify(job), before);
  assert.ok(result.kind === 'candidate'); assert.equal(result.canonicalId, message.id); assert.equal(result.createdAt, message.createdAt);
});
test('missing authors stay blocked; no absence-of-audit inference supplies governance proof', () => {
  const evidence = clear(); evidence.author = { kind: 'missing' };
  assert.deepEqual(classifyRetainedMessage(job, evidence), { original: job, executionAuthorized: false, kind: 'blocked', reason: 'missing-author' });
  evidence.governance = { kind: 'unknown' };
  assert.equal(classifyRetainedMessage(job, evidence).kind, 'blocked');
});
test('independently supported merge mapping prepares only a candidate and retains the original author', () => {
  const evidence = clear(); const userId = '40000000-0000-4000-8000-000000000004';
  evidence.author = { kind: 'merge', originalUserId: message.userId, userId, independentlyConfirmed: true, evidenceRef: 'proof:independent-merge' };
  const result = classifyRetainedMessage(job, evidence); assert.ok(result.kind === 'candidate');
  assert.equal(result.userId, userId); assert.equal(JSON.parse(result.original.payloadJson).userId, message.userId);
  evidence.author.originalUserId = userId;
  assert.equal(classifyRetainedMessage(job, evidence).kind, 'blocked');
});
for (const kind of ['moderation', 'retention', 'deletion'] as const) test(`${kind} tombstones prohibit replay even with a missing author`, () => {
  const evidence = clear(); evidence.governance = { kind, evidenceRef: `proof:${kind}` }; evidence.author = { kind: 'missing' };
  const result = classifyRetainedMessage(job, evidence);
  assert.deepEqual(result, { original: job, executionAuthorized: false, kind: 'blocked', reason: kind, evidenceRef: `proof:${kind}` });
});
test('the exact canonical row is already preserved; another original timestamp or payload blocks', () => {
  const evidence = clear(); const row = { id: message.id, createdAt: message.createdAt, digest: canonicalDigest(message) };
  evidence.canonical = { kind: 'complete', rows: [row] }; assert.equal(classifyRetainedMessage(job, evidence).kind, 'already-preserved');
  row.createdAt = '2026-10-13T00:00:00.124Z';
  assert.deepEqual(classifyRetainedMessage(job, evidence), { original: job, executionAuthorized: false, kind: 'blocked', reason: 'canonical-time-mismatch' });
  row.createdAt = message.createdAt; row.digest = 'conflict'; assert.equal(classifyRetainedMessage(job, evidence).kind, 'blocked');
});
test('unknown external linkage, partial canonical reads, invalid payloads and modified evidence block', () => {
  const evidence = clear(); evidence.external = { kind: 'unknown' }; assert.equal(classifyRetainedMessage(job, evidence).kind, 'blocked');
  evidence.external = { kind: 'none-confirmed', evidenceRef: 'proof:external' }; evidence.canonical = { kind: 'unknown' };
  assert.equal(classifyRetainedMessage(job, evidence).kind, 'blocked');
  assert.equal(classifyRetainedMessage({ ...job, payloadJson: '{}' }, clear()).kind, 'blocked');
  const noTime = JSON.stringify({ ...message, createdAt: undefined });
  assert.equal(classifyRetainedMessage({ ...job, payloadJson: noTime, payloadDigest: createHash('sha256').update(noTime).digest('hex') }, clear()).kind, 'blocked');
});

const identityMessage = { ...message, id: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
  userId: 'bcdefabc-defa-4bcd-8efa-bcdefabcdefa', channelId: 'cdefabcd-efab-4cde-8fab-cdefabcdefab',
  parentChannelId: 'defabcde-fabc-4def-8abc-defabcdefabc' };
type Spelling = 'lowercase' | 'uppercase' | 'mixed';
function spell(value: string, spelling: Spelling): string {
  return spelling === 'uppercase' ? value.toUpperCase() : spelling === 'mixed'
    ? value.replace(/[a-f]/g, (letter, index: number) => index % 2 ? letter.toUpperCase() : letter) : value;
}
function identityFixture(spelling: Spelling) {
  const payload = { ...identityMessage, id: spell(identityMessage.id, spelling), userId: spell(identityMessage.userId, spelling),
    channelId: spell(identityMessage.channelId, spelling), parentChannelId: spell(identityMessage.parentChannelId, spelling) };
  const payloadJson = JSON.stringify(payload);
  const original = Object.freeze({ ...job, payloadJson, payloadDigest: createHash('sha256').update(payloadJson).digest('hex'),
    redisHash: Object.freeze({ ...job.redisHash }) });
  const evidence: RetainedMessageEvidence = { ...clear(),
    author: { kind: 'existing', userId: payload.userId, evidenceRef: 'proof:author' },
    channel: { kind: 'compatible', channelId: payload.channelId, evidenceRef: 'proof:channel' } };
  return { payload, original, evidence };
}
function classifyProtected(original: RetainedMessageJob, evidence: RetainedMessageEvidence) {
  const originalBefore = JSON.stringify(original), evidenceBefore = JSON.stringify(evidence);
  const result = classifyRetainedMessage(original, evidence);
  assert.strictEqual(result.original, original); assert.equal(result.executionAuthorized, false);
  assert.equal(JSON.stringify(original), originalBefore); assert.equal(JSON.stringify(evidence), evidenceBefore);
  return result;
}
for (const payloadCase of ['uppercase', 'mixed'] as const) {
  for (const rowCase of ['lowercase', 'uppercase'] as const) test(`${payloadCase} protected UUIDs match an exact ${rowCase} canonical identity without rewriting evidence`, () => {
    const { payload, original, evidence } = identityFixture(payloadCase);
    evidence.author = { kind: 'existing', userId: identityMessage.userId, evidenceRef: 'proof:author' };
    evidence.channel = { kind: 'compatible', channelId: identityMessage.channelId.toUpperCase(), evidenceRef: 'proof:channel' };
    evidence.external = { kind: 'known', canonicalId: spell(identityMessage.id, 'mixed'), sourceMessageId: '123456789012345678', evidenceRef: 'proof:external' };
    evidence.canonical = { kind: 'complete', rows: [{ id: spell(identityMessage.id, rowCase), createdAt: message.createdAt, digest: canonicalDigest(identityMessage) }] };
    const result = classifyProtected(original, evidence); assert.ok(result.kind === 'already-preserved');
    assert.equal(result.canonicalId, payload.id); assert.equal(result.createdAt, payload.createdAt);
  });
  for (const conflict of ['time', 'payload', 'parent'] as const) test(`${payloadCase} protected UUID cannot hide a canonical ${conflict} conflict`, () => {
    const { original, evidence } = identityFixture(payloadCase);
    evidence.canonical = { kind: 'complete', rows: [{ id: identityMessage.id,
      createdAt: conflict === 'time' ? '2026-10-13T00:00:00.124Z' : message.createdAt,
      digest: canonicalDigest({ ...identityMessage, ...(conflict === 'payload' ? { content: 'different retained content' }
        : conflict === 'parent' ? { parentChannelId: identityMessage.channelId } : {}) }) }] };
    const result = classifyProtected(original, evidence); assert.ok(result.kind === 'blocked');
    assert.equal(result.reason, conflict === 'time' ? 'canonical-time-mismatch' : 'canonical-payload-mismatch');
  });
  test(`${payloadCase} merge and external aliases produce one review candidate with a semantic digest only`, () => {
    const { payload, original, evidence } = identityFixture(payloadCase);
    const mergedUserId = 'efabcdef-abcd-4efa-8bcd-efabcdefabcd';
    evidence.author = { kind: 'merge', originalUserId: identityMessage.userId, userId: mergedUserId.toUpperCase(),
      independentlyConfirmed: true, evidenceRef: 'proof:independent-merge' };
    evidence.channel = { kind: 'compatible', channelId: identityMessage.channelId, evidenceRef: 'proof:channel' };
    evidence.external = { kind: 'known', canonicalId: identityMessage.id, sourceMessageId: '123456789012345678', evidenceRef: 'proof:external' };
    const result = classifyProtected(original, evidence); assert.ok(result.kind === 'candidate');
    assert.equal(result.canonicalId, payload.id); assert.equal(result.userId, mergedUserId.toUpperCase());
    assert.equal(result.digest, canonicalDigest({ ...identityMessage, userId: mergedUserId }));
    evidence.canonical = { kind: 'complete', rows: [{ id: identityMessage.id, createdAt: message.createdAt, digest: result.digest }] };
    assert.equal(classifyProtected(original, evidence).kind, 'already-preserved');
    evidence.author.originalUserId = identityMessage.channelId;
    const unproved = classifyProtected(original, evidence); assert.ok(unproved.kind === 'blocked'); assert.equal(unproved.reason, 'unproved-author');
  });
}
test('case aliases in duplicate canonical rows cannot invent another canonical identity', () => {
  const { original, evidence } = identityFixture('lowercase');
  const row = { id: identityMessage.id, createdAt: message.createdAt, digest: canonicalDigest(identityMessage) };
  evidence.canonical = { kind: 'complete', rows: [row, { ...row, id: row.id.toUpperCase() }] };
  const result = classifyProtected(original, evidence); assert.ok(result.kind === 'blocked'); assert.equal(result.reason, 'canonical-payload-mismatch');
});
const unprovedCases: Array<[string, (evidence: RetainedMessageEvidence) => void]> = [
  ['author', evidence => { evidence.author = { kind: 'unknown' }; }],
  ['missing-author', evidence => { evidence.author = { kind: 'missing' }; }],
  ['channel', evidence => { evidence.channel = { kind: 'unknown' }; }],
  ['canonical', evidence => { evidence.canonical = { kind: 'unknown' }; }],
  ['external', evidence => { evidence.external = { kind: 'unknown' }; }],
  ['governance', evidence => { evidence.governance = { kind: 'unknown' }; }],
  ['different-author', evidence => { evidence.author = { kind: 'existing', userId: identityMessage.channelId, evidenceRef: 'proof:author' }; }],
  ['different-channel', evidence => { evidence.channel = { kind: 'compatible', channelId: identityMessage.userId, evidenceRef: 'proof:channel' }; }],
  ['different-external', evidence => { evidence.external = { kind: 'known', canonicalId: identityMessage.userId, sourceMessageId: '123456789012345678', evidenceRef: 'proof:external' }; }],
];
for (const [label, unprove] of unprovedCases) test(`UUID spelling does not clear ${label} evidence`, () => {
  const { original, evidence } = identityFixture('uppercase'); unprove(evidence);
  assert.equal(classifyProtected(original, evidence).kind, 'blocked');
});
