import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { RuntimeCoordinator } from '../coordinator';
import { createRuntimeDiscordClient } from '../discordClient';

const requireSdk = createRequire(__filename);
const route = '/channels/100000000000000001/messages' as const;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function scenario(mode: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fcm-discord-transport-'));
  const runtime = new RuntimeCoordinator(directory);
  const received = gate(), held = gate(), callback = gate(), callbackEntered = gate();
  const sockets = new Set<Socket>();
  let attempts = 0, handlerComplete = false, callbackComplete = false;
  const server = createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      void (async () => {
        attempts++; received.release();
        if (mode === 'lost-response') { res.destroy(); handlerComplete = true; return; }
        if (mode === 'server-error' && attempts === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"message":"private-provider-error-canary"}');
          handlerComplete = true; return;
        }
        if (mode.startsWith('429-') && attempts === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0.025' });
          res.end('{"retry_after":0.025,"message":"private-rate-limit-canary"}'); handlerComplete = true; return;
        }
        if (mode === '429-error' && attempts > 1) { res.writeHead(503); res.end(); handlerComplete = true; return; }
        if (mode === 'held-http' || mode === 'queued-budget' || mode === 'caller-abort') await held.promise;
        const headers = mode === 'bucket-wait'
          ? { 'X-RateLimit-Limit': '1', 'X-RateLimit-Remaining': attempts === 1 ? '1' : '0', 'X-RateLimit-Reset-After': '0.05', 'X-RateLimit-Bucket': 'fixture' }
          : {};
        res.writeHead(201, { 'Content-Type': 'application/json', ...headers });
        if (mode === 'held-body') { res.flushHeaders(); res.write('{"id":'); await held.promise; }
        res.end(mode === 'held-body' ? '"100000000000000002"}' : '{"id":"100000000000000002"}');
        handlerComplete = true;
      })();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const client = createRuntimeDiscordClient(runtime, { intents: [], rest: {
    api: `http://127.0.0.1:${address.port}/api`, timeout: ['held-http', 'held-body', 'queued-budget'].includes(mode) ? 75 : 1000,
    offset: 0,
  } });
  client.rest.setToken('private-bearer-canary');
  runtime.registerParticipant('fixture-discord-client', { inspect: async () => ({ pending: 0 }), close: () => client.destroy() });
  try {
    if (mode === 'held-callback' || mode === '429-callback') {
      client.rest.once('response', () => {
        callbackEntered.release();
        void (async () => { await callback.promise; callbackComplete = true; })();
      });
    }
    const send = (signal?: AbortSignal) => client.rest.post(route, { body: { content: 'private-message-canary' }, signal })
      .then(() => 'confirmed', () => 'rejected');
    const first = send();
    await received.promise;
    let second: Promise<string> | undefined;
    if (mode === 'queued-budget') second = send(AbortSignal.timeout(20));
    if (mode === 'caller-abort') {
      const cancellation = new AbortController(); second = send(cancellation.signal);
      cancellation.abort(); held.release();
    }
    const firstResult = await first;
    if (mode === 'bucket-wait') {
      // The SDK learns the actual bucket hash from the first response. Warm
      // that real bucket, then prove a limited request rejects without dispatch.
      assert.equal(await send(), 'confirmed'); second = send();
    }
    if (second) assert.equal(await second, 'rejected');
    let heldSnapshot;
    if (mode === 'held-callback' || mode === '429-callback') {
      await callbackEntered.promise;
      heldSnapshot = await runtime.drain({ timeoutMs: 35, close: true });
      assert.equal(heldSnapshot.phase, 'failed'); assert(heldSnapshot.active.length > 0);
      assert.equal(callbackComplete, false);
      assert(!heldSnapshot.closedParticipants.includes('fixture-discord-client'));
      callback.release();
    }
    held.release(); callback.release();
    // Cover the actual server callback and expired bucket window. A second
    // transport attempt after the caller has settled is an explicit failure.
    await pause(100);
    const result = await runtime.drain({ timeoutMs: 300, close: true });
    assert.equal(attempts, mode === 'bucket-wait' ? 2 : 1);
    assert.equal(handlerComplete, true);
    assert.equal(client.rest.options.retries, 0);
    assert.equal(typeof client.rest.options.rejectOnRateLimit, 'function');
    const clean = mode === 'created' || mode === 'held-callback';
    assert.equal(firstResult, ['created', 'held-callback', 'bucket-wait', 'caller-abort'].includes(mode) ? 'confirmed' : 'rejected');
    assert.equal(result.phase, clean ? 'closed' : 'failed');
    assert.deepEqual(result.active, []);
    assert.doesNotMatch(JSON.stringify(result), /private-bearer-canary|private-message-canary|private-provider-error-canary|private-rate-limit-canary/);
    if (mode.endsWith('callback')) assert.equal(callbackComplete, true);
    return { attempts, firstResult, phase: result.phase };
  } finally {
    held.release(); callback.release();
    await client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    runtime.disposeForTests(); rmSync(directory, { recursive: true, force: true });
  }
}

test('the local fixture uses the actual installed @discordjs/rest 2.6.3 transport', () => {
  assert.equal(requireSdk('@discordjs/rest').version, '2.6.3');
});
for (const mode of ['created', 'lost-response', 'server-error', '429-success', '429-error', 'held-http', 'held-body',
  'queued-budget', 'caller-abort', 'bucket-wait', 'held-callback', '429-callback']) {
  test(`actual SDK ${mode} does not retry creates and owns real completion`, { timeout: 5000 }, async () => {
    await scenario(mode);
  });
}
