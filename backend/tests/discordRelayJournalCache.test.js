const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { DiscordRelayJournal, discordRelayDigest, discordRelayOperationId } = require('../src/runtime/discordRelayJournal');

const createdAt = '2026-10-13T01:02:03.456Z';
const payload = { channelId: 'a2000000-0000-4000-8000-000000000002', username: 'Fixture', content: 'synthetic cache fixture',
  channelName: 'General', mentions: null, metadata: null, authorCosmetics: null, discordPrefix: '**[General]** **Fixture**: ' };
const payloadDigest = discordRelayDigest(payload), configDigest = discordRelayDigest(['synthetic-config']);
const canonical = n => `c2900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intent = n => ({ operationId: discordRelayOperationId(canonical(n)), canonicalId: canonical(n), createdAt,
  channelId: payload.channelId, discordChannelId: '100000000000000001', configDigest, payloadDigest });
let directory;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-relay-cache-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

function history(count = 1000) {
  const records = [];
  for (let n = 1; n <= count; n++) {
    const value = intent(n), operationId = value.operationId, discordMessageId = String(100000000000000000n + BigInt(n));
    records.push({ stage: 'intent', intent: value }, { stage: 'attempt', operationId },
      { stage: 'returned', operationId, discordMessageId }, { stage: 'complete', operationId, discordMessageId });
  }
  const filename = path.join(directory, 'discord-relays.jsonl');
  fs.writeFileSync(filename, records.map(record => JSON.stringify({ format: 'fcm-discord-relay-v1', ...record })).join('\n') + '\n', { mode: 0o600 });
  return filename;
}
function retained(journal) {
  const value = intent(100001);
  journal.retain(value.canonicalId, value.createdAt, payload);
  return value;
}

test('accumulated completed history is parsed once, with constant semantic work for a new durable lifecycle', () => {
  history();
  const journal = new DiscordRelayJournal(directory);
  const parse = JSON.parse;
  let journalParses = 0;
  jest.spyOn(JSON, 'parse').mockImplementation((text, ...rest) => {
    if (typeof text === 'string' && text.includes('"format":"fcm-discord-relay-v1"')) journalParses++;
    return parse(text, ...rest);
  });
  const hashes = jest.spyOn(crypto, 'createHash');
  const value = retained(journal);
  expect(journal.expect(value)).toBe(true);
  journal.attempt(value.operationId); journal.returned(value.operationId, '100000000000100001');
  journal.complete(value.operationId, '100000000000100001');
  expect(journal.inspect()).toMatchObject({ pending: 0, detail: { expected: 1001, complete: 1001 } });
  expect(journalParses).toBeLessThanOrEqual(4);
  expect(hashes.mock.calls.length).toBeLessThanOrEqual(32);
  expect(fs.readFileSync(journal.filename, 'utf8').trim().split('\n')).toHaveLength(4004);
});

test.each(['early-prefix-edit-restored-mtime', 'same-bytes-replacement', 'truncation', 'unknown-stage', 'torn-tail', 'unsafe-file-mode', 'unsafe-directory-mode'])(
  'cached history refuses %s before any later append', mutation => {
    const filename = history(), original = fs.readFileSync(filename), fixedTime = new Date('2026-10-13T01:02:03.000Z');
    fs.utimesSync(filename, fixedTime, fixedTime);
    const stat = fs.statSync(filename);
    const journal = new DiscordRelayJournal(directory);
    if (mutation === 'early-prefix-edit-restored-mtime') {
      fs.writeFileSync(filename, original.toString().replace(createdAt, '2026-10-12T01:02:03.456Z'));
      expect(fs.statSync(filename).size).toBe(original.length);
    } else if (mutation === 'same-bytes-replacement') {
      const replacement = path.join(directory, 'replacement');
      fs.writeFileSync(replacement, original, { mode: 0o600 }); fs.renameSync(replacement, filename);
      expect(fs.statSync(filename).ino).not.toBe(stat.ino);
    } else if (mutation === 'truncation') fs.truncateSync(filename, original.length - 1);
    else if (mutation === 'unsafe-file-mode') fs.chmodSync(filename, 0o644);
    else if (mutation === 'unsafe-directory-mode') fs.chmodSync(directory, 0o755);
    else fs.appendFileSync(filename, mutation === 'torn-tail' ? '{"format":' : JSON.stringify({ format: 'fcm-discord-relay-v1', stage: 'unknown' }) + '\n');
    fs.utimesSync(filename, stat.atime, stat.mtime);
    expect(fs.statSync(filename).mtimeMs).toBe(stat.mtimeMs);
    const changed = fs.readFileSync(filename);
    expect(() => retained(journal)).toThrow(/private recovery/);
    expect(() => journal.inspect()).toThrow(/private recovery/);
    expect(fs.readFileSync(filename).equals(changed)).toBe(true);
  },
);

test('caller mutation cannot change the authoritative cached intent after durable admission', () => {
  const journal = new DiscordRelayJournal(directory), caller = retained(journal), original = { ...caller };
  journal.expect(caller);
  caller.configDigest = 'b'.repeat(64); caller.payloadDigest = 'c'.repeat(64);
  caller.discordChannelId = '100000000000000009'; caller.createdAt = '2026-10-14T01:02:03.456Z';
  journal.attempt(original.operationId); journal.returned(original.operationId, '100000000000100001');
  journal.complete(original.operationId, '100000000000100001');
  expect(journal.expect(original)).toBe(false);
  expect(() => journal.expect(caller)).toThrow(/conflicts/);
  expect(journal.inspect().pending).toBe(0);
  expect(JSON.parse(fs.readFileSync(journal.filename, 'utf8').split('\n')[0]).intent).toEqual(original);
});

test.each(['partial-write', 'journal-fsync', 'directory-fsync', 'cleanup-fsync'])(
  'failed %s never advances the cached journal into clean success', failure => {
    const journal = new DiscordRelayJournal(directory), value = retained(journal);
    journal.expect(value); journal.attempt(value.operationId); journal.returned(value.operationId, '100000000000100001');
    if (failure === 'partial-write') {
      const write = fs.writeFileSync;
      jest.spyOn(fs, 'writeFileSync').mockImplementation((descriptor, body, ...rest) => {
        if (typeof descriptor === 'number') { write(descriptor, String(body).slice(0, 20)); throw new Error('synthetic-partial-write'); }
        return write(descriptor, body, ...rest);
      });
    } else {
      const sync = fs.fsyncSync, payloadInode = fs.statSync(journal.payloadDirectory).ino;
      jest.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
        const stat = fs.fstatSync(descriptor);
        if (failure === 'journal-fsync' && stat.isFile()
          || failure === 'directory-fsync' && stat.isDirectory()
          || failure === 'cleanup-fsync' && stat.isDirectory() && stat.ino === payloadInode) throw new Error('synthetic-fsync-refusal');
        return sync(descriptor);
      });
    }
    expect(() => journal.complete(value.operationId, '100000000000100001')).toThrow(/private recovery/);
    jest.restoreAllMocks();
    expect(journal.inspect().pending).toBeGreaterThan(0);
    expect(() => journal.expect(value)).toThrow(/private recovery/);
    expect(fs.readFileSync(journal.filename, 'utf8')).toContain('"stage":"returned"');
  },
);
