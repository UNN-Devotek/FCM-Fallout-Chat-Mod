import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DiscordRelayJournal, discordRelayDigest, discordRelayOperationId, type DiscordRelayIntent } from '../discordRelayJournal';
import { RuntimeCoordinator } from '../coordinator';

const canonicalId = 'a2000000-0000-4000-8000-000000000001';
function intent(journal: DiscordRelayJournal): DiscordRelayIntent {
  const payload = { channelId: 'a2000000-0000-4000-8000-000000000002', username: 'OriginalAuthor',
    content: 'private-message-canary https://private.invalid/token-canary', channelName: 'General', mentions: null,
    metadata: null, authorCosmetics: null, discordPrefix: '**[General]** **OriginalAuthor**: ' };
  const retained = journal.retain(canonicalId, '2026-10-13T01:02:03.456Z', payload);
  return { canonicalId, operationId: discordRelayOperationId(canonicalId), createdAt: '2026-10-13T01:02:03.456Z',
    channelId: 'a2000000-0000-4000-8000-000000000002', discordChannelId: '100000000000000001',
    configDigest: discordRelayDigest(['configured-guild', 'mapped-target']),
    payloadDigest: retained.payloadDigest };
}
function fixture(run: (journal: DiscordRelayJournal, directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'fcm-relay-journal-'));
  try { return run(new DiscordRelayJournal(directory), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('intent, attempt, returned ID and verified completion retain exact identity/time and private permissions', () => fixture((journal, directory) => {
  const expected = intent(journal);
  assert.equal(journal.expect(expected), true);
  assert.equal(new DiscordRelayJournal(directory).inspect().pending, 1);
  journal.attempt(expected.operationId);
  journal.returned(expected.operationId, '100000000000000002');
  assert.equal(new DiscordRelayJournal(directory).inspect().pending, 1);
  journal.complete(expected.operationId, '100000000000000002');
  assert.equal(new DiscordRelayJournal(directory).expect(expected), false);
  assert.equal(journal.inspect().pending, 0);
  assert.deepEqual(readdirSync(journal.payloadDirectory), []);
  const records = readFileSync(journal.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.stage), ['intent', 'attempt', 'returned', 'complete']);
  assert.deepEqual(records[0].intent, expected);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(journal.filename).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(records), /private-message-canary|private\.invalid|token-canary/);
}));

for (const field of ['createdAt', 'channelId', 'discordChannelId', 'configDigest', 'payloadDigest'] as const) {
  test(`one canonical operation refuses a changed ${field} without changing the original bytes`, () => fixture(journal => {
    const expected = intent(journal); journal.expect(expected);
    const original = readFileSync(journal.filename);
    const change = field === 'createdAt' ? '2026-10-14T01:02:03.456Z'
      : field.endsWith('Digest') ? 'b'.repeat(64) : field === 'discordChannelId' ? '100000000000000009' : 'changed-target';
    assert.throws(() => journal.expect({ ...expected, [field]: change }), /conflicts/);
    assert.deepEqual(readFileSync(journal.filename), original);
  }));
}

for (const stage of ['intent', 'attempt', 'returned'] as const) {
  test(`restart never authorizes another create from ${stage}, even without the old failure/fence files`, () => fixture((journal, directory) => {
    const expected = intent(journal); journal.expect(expected);
    if (stage !== 'intent') journal.attempt(expected.operationId);
    if (stage === 'returned') journal.returned(expected.operationId, '100000000000000002');
    const original = readFileSync(journal.filename);
    assert.throws(() => new DiscordRelayJournal(directory).expect(expected), /private recovery/);
    const copied = mkdtempSync(path.join(tmpdir(), 'fcm-relay-restart-'));
    let runtime: RuntimeCoordinator | undefined;
    try {
      copyFileSync(journal.filename, path.join(copied, 'discord-relays.jsonl'));
      mkdirSync(path.join(copied, 'discord-relay-payloads'), { mode: 0o700 });
      copyFileSync(path.join(journal.payloadDirectory, `${expected.operationId}.json`), path.join(copied, 'discord-relay-payloads', `${expected.operationId}.json`));
      runtime = new RuntimeCoordinator(copied);
      assert.equal(runtime.isFrozen(), true);
      assert.throws(() => runtime!.assertAdmission(), /Maintenance/);
      assert.deepEqual(readFileSync(journal.filename), original);
    } finally { runtime?.disposeForTests(); rmSync(copied, { recursive: true, force: true }); }
  }));
}

for (const corruption of ['partial', 'empty', 'unknown-stage', 'unknown-field', 'duplicate-intent', 'bad-transition', 'extra-line', 'oversized-record', 'oversized-file']) {
  test(`complete bounded parsing refuses ${corruption} and never rewrites the retained evidence`, () => fixture((journal, directory) => {
    const expected = intent(journal); journal.expect(expected);
    let bytes = readFileSync(journal.filename, 'utf8');
    if (corruption === 'partial') bytes = bytes.slice(0, -1);
    if (corruption === 'empty') bytes = '';
    if (corruption === 'unknown-stage') bytes += JSON.stringify({ format: 'fcm-discord-relay-v1', stage: 'pending', operationId: expected.operationId }) + '\n';
    if (corruption === 'unknown-field') bytes = bytes.replace('"stage":"intent"', '"stage":"intent","token":"private-secret-canary"');
    if (corruption === 'duplicate-intent') bytes += bytes;
    if (corruption === 'bad-transition') bytes += JSON.stringify({ format: 'fcm-discord-relay-v1', stage: 'complete', operationId: expected.operationId, discordMessageId: '100000000000000002' }) + '\n';
    if (corruption === 'extra-line') bytes += '\n';
    if (corruption === 'oversized-record') bytes = 'x'.repeat(2049) + '\n';
    writeFileSync(journal.filename, bytes);
    if (corruption === 'oversized-file') truncateSync(journal.filename, 64 * 1024 * 1024 + 1);
    const original = statSync(journal.filename);
    assert.throws(() => new DiscordRelayJournal(directory), error => error instanceof Error
      && /private recovery/.test(error.message) && !error.message.includes('private-secret-canary'));
    assert.throws(() => journal.inspect(), /private recovery/);
    assert.equal(statSync(journal.filename).size, original.size);
    if (corruption !== 'oversized-file') assert.equal(readFileSync(journal.filename, 'utf8'), bytes);
  }));
}

test('unsafe file permissions, a symlink and missing canonical identity are refused before append', () => fixture((journal, directory) => {
  const expected = intent(journal); assert.throws(() => journal.expect({ ...expected, canonicalId: 'invented-id' }));
  journal.expect(expected);
  chmodSync(journal.filename, 0o644);
  assert.throws(() => new DiscordRelayJournal(directory), /private recovery/);
  chmodSync(journal.filename, 0o600);
  const target = path.join(directory, 'retained-original');
  copyFileSync(journal.filename, target); rmSync(journal.filename); symlinkSync(target, journal.filename);
  assert.throws(() => new DiscordRelayJournal(directory), /private recovery/);
}));

test('a protected original input without an intent remains accounted and fences a fresh process', () => fixture((journal, directory) => {
  const expected = intent(journal);
  assert.equal(journal.inspect().pending, 1);
  const payloadFile = path.join(journal.payloadDirectory, `${expected.operationId}.json`);
  const payload = JSON.parse(readFileSync(payloadFile, 'utf8'));
  assert.equal(payload.canonicalId, canonicalId); assert.equal(payload.createdAt, expected.createdAt);
  assert.match(payload.payload.content, /private-message-canary/);
  assert.equal(payload.payload.discordPrefix, '**[General]** **OriginalAuthor**: ');
  assert.equal(statSync(payloadFile).mode & 0o777, 0o600);
  assert.equal(statSync(journal.payloadDirectory).mode & 0o777, 0o700);
  assert.doesNotMatch(JSON.stringify(journal.inspect()), /private-message-canary|OriginalAuthor|private\.invalid/);
  const runtime = new RuntimeCoordinator(directory);
  try { assert.equal(runtime.isFrozen(), true); } finally { runtime.disposeForTests(); }
}));

for (const corruption of ['missing', 'corrupt', 'unsafe-permissions', 'unknown-input', 'duplicate-key']) {
  test(`a ${corruption} protected input cannot authorize an attempt or be erased by restart`, () => fixture((journal, directory) => {
    const expected = intent(journal); journal.expect(expected);
    const payloadFile = path.join(journal.payloadDirectory, `${expected.operationId}.json`);
    if (corruption === 'missing') rmSync(payloadFile);
    if (corruption === 'corrupt') writeFileSync(payloadFile, '{"partial":');
    if (corruption === 'unsafe-permissions') chmodSync(payloadFile, 0o644);
    if (corruption === 'unknown-input') writeFileSync(path.join(journal.payloadDirectory, 'unknown.json'), '{}', { mode: 0o600 });
    if (corruption === 'duplicate-key') writeFileSync(payloadFile, readFileSync(payloadFile, 'utf8').replace('"canonicalId":', '"canonicalId":"ignored-duplicate","canonicalId":'));
    const journalBytes = readFileSync(journal.filename);
    assert.throws(() => journal.attempt(expected.operationId), /private recovery/);
    assert.throws(() => new RuntimeCoordinator(directory), /private recovery/);
    assert.deepEqual(readFileSync(journal.filename), journalBytes);
  }));
}

test('clearing both retained stores cannot manufacture a clean inspection in the owning process', () => fixture(journal => {
  const expected = intent(journal); journal.expect(expected); journal.attempt(expected.operationId);
  assert.equal(journal.inspect().pending, 1);
  rmSync(journal.filename); rmSync(journal.payloadDirectory, { recursive: true });
  assert.throws(() => journal.inspect(), /private recovery/);
}));
