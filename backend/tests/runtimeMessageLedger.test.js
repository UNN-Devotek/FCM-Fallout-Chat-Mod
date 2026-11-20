const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageLedger } = require('../src/runtime/messageLedger');

let dir, ledger;
const message = { id: 'canonical-id', content: 'accepted message', userId: 'user-id', channelId: 'channel-id',
  createdAt: '2026-10-13T12:00:00.000Z', source: 'game', relaySeq: 42, metadata: { z: 1, a: true } };
const row = extra => ({ id: message.id, content: message.content, user_id: message.userId, channel_id: message.channelId,
  parent_channel_id: null, created_at: new Date(message.createdAt), source: message.source, relay_seq: '42',
  metadata: { a: true, z: 1 }, ...extra });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-ledger-')); ledger = new MessageLedger(dir); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test.each([{ rows: [] }, { rows: [row({ content: 'different' })] },
  { rows: [row({}), row({ created_at: new Date('2026-10-13T12:01:00Z') })] }])(
  'an empty queue cannot prove missing, conflicting or duplicate canonical data: %j', async ({ rows }) => {
    ledger.record(message);
    const proof = await ledger.verify(async () => rows);
    expect(proof.failures).toHaveLength(1);
    expect(proof.verified).toBe(0);
  });

test('proof survives restart and later authorized edits or deletes of an already persisted message', async () => {
  ledger.record(message);
  expect(await ledger.verify(async () => [row({})])).toEqual({ verified: 1, failures: [] });
  const restarted = new MessageLedger(dir);
  const load = jest.fn(async () => []);
  expect(await restarted.verify(load)).toEqual({ verified: 1, failures: [] });
  expect(load).not.toHaveBeenCalled();
  const journal = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');
  expect(journal).not.toContain(message.content);
});

test('one worker does not verify another accepted job that has not reached its worker yet', async () => {
  ledger.record(message);
  ledger.record({ ...message, id: 'waiting-id' });
  expect(await ledger.verify(async ids => ids.includes(message.id) ? [row({})] : [], [message.id]))
    .toEqual({ verified: 1, failures: [] });
  expect((await ledger.verify(async () => [])).failures).toEqual([expect.objectContaining({ id: 'waiting-id' })]);
});

test('a missing stable timestamp or reused canonical key with different content cannot be acknowledged', () => {
  expect(() => ledger.record({ ...message, createdAt: undefined })).toThrow('stable persistence timestamp');
  ledger.record(message);
  expect(() => ledger.record({ ...message, content: 'changed before persistence' })).toThrow('conflicting content');
});
