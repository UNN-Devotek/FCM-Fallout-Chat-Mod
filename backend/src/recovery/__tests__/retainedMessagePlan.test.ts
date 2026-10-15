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
