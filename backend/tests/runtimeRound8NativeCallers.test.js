const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let mockRuntime, directory;
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info() {}, warn() {}, error() {} } }));
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { validateSteamAssertion } = require('../src/services/steamAuthService');
const { createGitHubRelease } = require('../src/services/githubReleaseService');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const savedToken = process.env.GITHUB_RELEASE_TOKEN;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-callers-')); mockRuntime = new RuntimeCoordinator(directory); process.env.GITHUB_RELEASE_TOKEN = 'fixture-only-mirror-token'; });
afterEach(() => { mockRuntime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); if (savedToken === undefined) delete process.env.GITHUB_RELEASE_TOKEN; else process.env.GITHUB_RELEASE_TOKEN = savedToken; });
test.each(['steam', 'mirror'])('actual %s custom fetchImpl retains detached callback descendants through freeze', async target => {
  const gate = deferred(); let completed = false, calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    if (target === 'mirror' && !options.method) return new Response('{}', { status: 404 });
    void gate.promise.then(() => mockRuntime.required('custom-fetch:callback', async () => { completed = true; }));
    return new Response(target === 'steam' ? 'is_valid:true\n' : '{}');
  };
  const value = await mockRuntime.run('accepted-custom-fetch', () => target === 'steam' ? validateSteamAssertion({ 'openid.claimed_id': 'fixture' }, fetchImpl) : createGitHubRelease('0.0.1-fixture', 'synthetic notes', { fetchImpl }));
  if (target === 'steam') expect(value).toBe(true);
  expect(calls).toBe(target === 'steam' ? 1 : 2); expect(completed).toBe(false);
  const held = await mockRuntime.drain({ timeoutMs: 40 }); expect(held.phase).toBe('failed'); expect(held.active.length).toBeGreaterThan(0);
  gate.resolve(); expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('drained'); expect(completed).toBe(true);
});
test.each(['steam', 'mirror'])('actual %s awaits a realistic Response body before returning', async target => {
  const started = deferred(); let endBody, completed = false;
  const fetchImpl = async (_url, options) => {
    if (target === 'mirror' && !options.method) return new Response('{}', { status: 404 });
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(target === 'steam' ? 'is_valid:tr' : '{"id":'));
      endBody = () => { endBody = null; controller.enqueue(new TextEncoder().encode(target === 'steam' ? 'ue\n' : '1}')); controller.close(); }; started.resolve();
    } }));
    return response;
  };
  const operation = mockRuntime.run('accepted-response-read', () => target === 'steam' ? validateSteamAssertion({}, fetchImpl) : createGitHubRelease('0.0.1-fixture', 'synthetic notes', { fetchImpl })).then(value => { completed = true; return value; });
  try {
    await started.promise; const held = await mockRuntime.drain({ timeoutMs: 40 });
    expect(completed).toBe(false); expect(held.phase).toBe('failed'); expect(held.active.length).toBeGreaterThan(0);
    endBody(); if (target === 'steam') expect(await operation).toBe(true); else await operation;
    expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('drained'); expect(mockRuntime.snapshot().active).toEqual([]);
  } finally { endBody?.(); await operation; }
});

test.each(['lookup-404', 'lookup-rejected', 'post-rejected', 'patch-rejected'])('actual mirror consumes held %s body before another API call or return', async stage => {
  const started = deferred(); let endBody, completed = false, calls = 0, heldCall;
  const fetchImpl = async (_url, options) => {
    calls++;
    const lookup = !options.method;
    if (!heldCall && (stage.startsWith('lookup-') && lookup || stage === 'post-rejected' && options.method === 'POST' || stage === 'patch-rejected' && options.method === 'PATCH')) {
      heldCall = calls;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        endBody = () => { endBody = null; controller.enqueue(new TextEncoder().encode('17}')); controller.close(); }; started.resolve();
      } }), { status: stage === 'lookup-404' ? 404 : 503 });
    }
    if (lookup) return new Response('{"id":17}', { status: stage === 'post-rejected' && !heldCall ? 404 : 200 });
    return new Response('{"id":17}');
  };
  const operation = mockRuntime.run('accepted-mirror-response-read', () => createGitHubRelease('0.0.1-fixture', 'synthetic notes', { fetchImpl })).then(() => { completed = true; });
  try {
    await started.promise; const held = await mockRuntime.drain({ timeoutMs: 40 });
    expect(completed).toBe(false); expect(calls).toBe(heldCall); expect(held.phase).toBe('failed'); expect(held.active.length).toBeGreaterThan(0);
    endBody(); await operation;
    expect(calls).toBeGreaterThan(heldCall); expect(completed).toBe(true);
    expect((await mockRuntime.drain({ timeoutMs: 500 })).phase).toBe('drained'); expect(mockRuntime.snapshot().active).toEqual([]);
  } finally { endBody?.(); await operation; }
});
