const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
let mockRuntime;
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { discardRuntimeResponse } = require('../src/runtime/nativeFetch');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const labels = ['avatar-refused', 'image-refused', 'image-mime-refused', 'avatar-success', 'image-success', 'avatar-body-held', 'image-body-held',
  'wiki-refused', 'camp-image-refused', 'verify-missing', 'verify-refused', 'fandom-limited', 'fandom-refused', 'steam-profile-refused',
  'bethesda-refused', 'nukacrypt-refused', 'minerva-refused', 'dev-oauth-refused', 'prod-verify-refused', 'dev-side-missing', 'dev-side-refused',
  'qa-identity-refused', 'qa-guild-missing', 'qa-guild-refused', 'dev-identity-refused', 'tenor-refused', 'role-missing', 'role-refused',
  'ticket-refused', 'camp-ingest-refused', 'camp-update-refused', 'camp-sync-refused', 'oauth-member-refused', 'oauth-public-unused', 'link-member-refused', 'nexus-userinfo-refused'];
let proof;
beforeAll(() => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-disposal-proof-'));
  const output = path.join(outputDirectory, 'result.json');
  try {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'setup/runtime-native-responses.cjs'), '--all'], {
      env: { ...process.env, RUNTIME_FIXTURE_OUTPUT: output }, encoding: 'utf8', timeout: 45000,
    });
    if (child.status !== 0 || !fs.existsSync(output)) throw new Error(`Native response fixture failed: ${child.status}\n${child.stdout}\n${child.stderr}`);
    // Read the explicit result artifact; preserve ordinary stdout, including
    // configuration diagnostics, without last-line JSON or quiet-mode masking.
    proof = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(proof.results.map(result => result.label)).toEqual(labels);
  } finally { fs.rmSync(outputDirectory, { recursive: true, force: true }); }
}, 50000);

test.each(labels)('actual %s response branch has a terminal body and preserves its outcome', label => {
  const result = proof.results.find(value => value.label === label);
  expect(result.nativeFetch).toBe(true); expect(result.requests.length).toBeGreaterThan(0);
  expect(result.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.errorName).not.toBe('ReferenceError'); expect(result.errorName).not.toBe('SyntaxError');
  expect(result.final.phase).toBe('closed'); expect(result.final.active).toEqual([]); expect(result.final.failures).toEqual([]);
  expect(result.beforeDrain.active).toEqual([]);
  expect(result.responseClosuresBeforeIngressClose).toBe(result.requests.length);
  expect(result.physicalSocketCloses).toBeGreaterThanOrEqual(result.requests.length);
  if (label === 'wiki-refused' || label === 'camp-image-refused') expect(result.requests).toHaveLength(3);
  if (label === 'camp-sync-refused') expect(result.requests).toHaveLength(2);
  if (label.endsWith('-body-held')) {
    expect(result.held.phase).toBe('failed'); expect(result.held.active.length).toBeGreaterThan(0);
    expect(result.completedAtCheckpoint).toBe(false);
  }
  if (label === 'avatar-success' || label === 'avatar-body-held') { expect(result.result).toBe('/avatars/fixture-user'); expect(result.uploadedBytes).toBe(100); }
  if (label === 'image-success' || label === 'image-body-held') expect(result.result).toEqual({ bytes: 100, contentType: 'image/png' });
  if (['avatar-refused', 'image-refused', 'image-mime-refused', 'steam-profile-refused', 'bethesda-refused', 'nukacrypt-refused', 'fandom-refused', 'wiki-refused', 'camp-image-refused', 'verify-missing'].includes(label)) expect(result.result).toBeNull();
  if (['minerva-refused', 'dev-side-missing', 'qa-guild-missing'].includes(label)) expect(result.result).toEqual([]);
  if (label === 'role-missing') expect(result.result).toBe(false);
  if (label === 'role-refused') expect(result.result).toBe(true);
  if (label === 'fandom-limited') { expect(result.rejected).toBe(true); expect(result.errorName).toBe('RateLimitError'); }
  if (['verify-refused', 'dev-oauth-refused', 'prod-verify-refused', 'dev-side-refused', 'qa-identity-refused', 'qa-guild-refused', 'dev-identity-refused', 'camp-ingest-refused', 'camp-sync-refused'].includes(label)) expect(result.rejected).toBe(true);
  if (label === 'tenor-refused') expect(result.httpStatus).toBe(502);
  if (label === 'camp-update-refused') { expect(result.result.updatesAvailable).toBe(0); expect(result.cacheWrites).toBe(1); }
  if (label === 'oauth-member-refused') expect(result.redirect).toBe('http://fixture-ui/login?error=not_in_discord');
  if (label === 'oauth-public-unused') { expect(result.redirect).toBe('http://fixture-ui/report'); expect(result.writes).toBe(1); }
  if (label === 'link-member-refused') expect(result.httpStatus).toBe(403);
  if (label === 'nexus-userinfo-refused') expect(result.redirect).toBe('/link?error=nexus_userinfo');
});

describe('the real Web response cancellation remains in the admitted owner', () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-cancel-owner-')); mockRuntime = new RuntimeCoordinator(directory); });
  afterEach(() => { mockRuntime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); });
  test('awaits an actual pending stream cancellation across freeze', async () => {
    const gate = deferred(), started = deferred(); let completed = false;
    const operation = mockRuntime.run('accepted-cancel', async () => {
      const response = new Response(new ReadableStream({ cancel() { started.resolve(); return gate.promise; } }));
      await discardRuntimeResponse(response); completed = true;
    });
    try {
      await started.promise; const held = await mockRuntime.drain({ timeoutMs: 40 });
      expect(completed).toBe(false); expect(held.phase).toBe('failed'); expect(held.active.length).toBeGreaterThan(0);
      gate.resolve(); await operation;
      expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('drained'); expect(completed).toBe(true);
    } finally { gate.resolve(); await operation; }
  });
  test('retains application callback descendants after cancellation itself completes', async () => {
    const gate = deferred(); let callbackDone = false;
    await mockRuntime.run('accepted-cancel-callback', () => discardRuntimeResponse(new Response(new ReadableStream({ cancel() {
      void gate.promise.then(() => { callbackDone = true; });
    } }))));
    try {
      const held = await mockRuntime.drain({ timeoutMs: 40 });
      expect(callbackDone).toBe(false); expect(held.phase).toBe('failed'); expect(held.active.length).toBeGreaterThan(0);
      gate.resolve(); expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('drained'); expect(callbackDone).toBe(true);
    } finally { gate.resolve(); }
  });
  test('a required cancellation failure stays recorded after the body closes', async () => {
    await expect(mockRuntime.required('response:required-cancel', () => discardRuntimeResponse(new Response(new ReadableStream({ cancel() { throw new Error('fixture-cancel-failed'); } }))),
      { stage: 'required-read-cancellation-unconfirmed' })).rejects.toThrow('fixture-cancel-failed');
    const final = await mockRuntime.drain({ timeoutMs: 500 });
    expect(final.phase).toBe('failed'); expect(final.active).toEqual([]);
    expect(final.failures).toContainEqual(expect.objectContaining({ label: 'response:required-cancel', evidence: { stage: 'required-read-cancellation-unconfirmed' } }));
  });
  test('a bodyless HEAD/204 response has no fabricated cancellation work', async () => {
    await mockRuntime.run('accepted-bodyless', () => discardRuntimeResponse(new Response(null, { status: 204 })));
    const final = await mockRuntime.drain({ timeoutMs: 500 }); expect(final.phase).toBe('drained'); expect(final.active).toEqual([]);
  });
});
