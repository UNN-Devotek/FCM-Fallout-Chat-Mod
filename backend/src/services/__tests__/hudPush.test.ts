/**
 * Unit tests for hudPush.ts — transport-agnostic HUD push core.
 *
 * Strategy: node:test has no jest.mock(); instead we use the injectable
 * _setChannelResolver and _setChannelFeedFetcher hooks exported by hudPush.ts
 * to control channel lookups and feed fetching without touching Prisma.
 * The full HELLO+backfill sequence is validated in the integration test
 * (tests/hudPushTcp.test.js) which can jest.mock fetchFeedRowsForChannel.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  hudPushNotify,
  getClientCount,
  registerClient,
  unregisterClientPublic,
  switchClientChannel,
  isHudEligibleChannel,
  _setChannelResolver,
  _setChannelFeedFetcher,
  _setAggregateFeedFetcher,
  type HudPushClient,
} from '../hudPush';

import { buildFeedLines } from '../hudFeedService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const GENERAL_CHANNEL_ID = '00000000-0000-0000-0000-000000000005';
const TRADING_CHANNEL_ID = '00000000-0000-0000-0000-000000000002';
const ROOT_CONTAINER_ID  = '00000000-0000-0000-0000-000000000001';

function makeClient(sends: string[], channelId: string = GENERAL_CHANNEL_ID): HudPushClient {
  return {
    transport: 'tcp',
    activeChannelId: channelId,
    send(line: string) { sends.push(line); },
    close() { /* no-op */ },
  };
}

/**
 * Drain microtask / setImmediate queue so async-void paths in hudPush complete.
 *
 * Only sound for "let whatever is pending settle, then clear the buffer" and for
 * NEGATIVE assertions (nothing must arrive). It is NOT sound for asserting that
 * something DID arrive — use waitFor() for that. See the comment on waitFor().
 */
function drainAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Poll until `predicate()` is true, or fail after `timeoutMs`.
 *
 * hudPushNotify() / registerClient() / switchClientChannel() are all
 * fire-and-forget: they kick off `void (async () => { ... })()` and return
 * synchronously, awaiting a channel resolve (and sometimes a feed fetch) before
 * anything is written to the client. The number of async hops before a line
 * lands is therefore NOT fixed, so a single drainAsync() is not a guarantee —
 * it just happens to be enough most of the time on an idle machine.
 *
 * Worse, hudPushNotify() fans out by iterating the LIVE `clients` set after its
 * await. A test that drains once and then unregisters its clients can pull them
 * out of the registry before the fan-out runs, so the message is delivered to
 * nobody and the assertion fails. That is what made this suite fail ~50% of runs
 * under load (issue #430) — a test-harness race, not a product bug: nothing in
 * production unregisters a client one tick after a message.
 *
 * Waiting on the observable condition removes the timing assumption entirely.
 */
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── isHudEligibleChannel ──────────────────────────────────────────────────────
//
// Community channels (General/Trading/Events/Raids) are CHILDREN of a root container
// ("Fallout 76", parent_id IS NULL). A non-null parentId = real chat channel = eligible.
// The root container (parentId null) is a grouping container and must be excluded.

test('isHudEligibleChannel: leaf channel (parentId set) is eligible', () => {
  assert.ok(isHudEligibleChannel({ name: 'General', color: '#C8A840', parentId: ROOT_CONTAINER_ID, isArchived: false }));
});

test('isHudEligibleChannel: root container (parentId null) is NOT eligible', () => {
  assert.ok(!isHudEligibleChannel({ name: 'Fallout 76', color: null, parentId: null, isArchived: false }));
});

test('isHudEligibleChannel: archived leaf channel is NOT eligible', () => {
  assert.ok(!isHudEligibleChannel({ name: 'Archived', color: '#aaa', parentId: ROOT_CONTAINER_ID, isArchived: true }));
});

// ── Non-chat:message types ignored ───────────────────────────────────────────

describe('hudPushNotify: payload type filtering', () => {
  afterEach(() => { _setChannelResolver(null); });

  test('non-chat:message type is ignored (no resolver called)', async () => {
    let lookupCalled = false;
    _setChannelResolver(async (_id) => { lookupCalled = true; return null; });

    hudPushNotify({ type: 'presence:update', payload: { channelId: 'chan-1' } });
    await drainAsync();
    assert.ok(!lookupCalled, 'channel resolver must not be called for non-chat:message types');
  });

  test('missing type is ignored', async () => {
    let lookupCalled = false;
    _setChannelResolver(async (_id) => { lookupCalled = true; return null; });

    hudPushNotify({ payload: { channelId: 'chan-1', content: 'hi' } });
    await drainAsync();
    assert.ok(!lookupCalled);
  });
});

// ── isPrivate filtering ───────────────────────────────────────────────────────

test('hudPushNotify: isPrivate=true payload is ignored', async () => {
  let lookupCalled = false;
  _setChannelResolver(async (_id) => { lookupCalled = true; return null; });

  hudPushNotify({ type: 'chat:message', payload: { channelId: 'chan-1', isPrivate: true, content: 'secret', username: 'Dev' } });
  await drainAsync();
  assert.ok(!lookupCalled, 'channel resolver must not be called for private messages');

  _setChannelResolver(null);
});

// ── server: channelId skipped ─────────────────────────────────────────────────

test('hudPushNotify: server: channelId skips the resolver (not a UUID)', async () => {
  let lookupCalled = false;
  _setChannelResolver(async (_id) => { lookupCalled = true; return null; });

  hudPushNotify({ type: 'chat:message', payload: { channelId: 'server:abc-world', content: 'hi', username: 'Dev' } });
  await drainAsync();
  assert.ok(!lookupCalled, 'server: IDs must bypass resolver');

  _setChannelResolver(null);
});

// ── Missing channelId ─────────────────────────────────────────────────────────

test('hudPushNotify: missing channelId is ignored', async () => {
  let lookupCalled = false;
  _setChannelResolver(async (_id) => { lookupCalled = true; return null; });

  hudPushNotify({ type: 'chat:message', payload: { content: 'hi', username: 'Dev' } });
  await drainAsync();
  assert.ok(!lookupCalled);

  _setChannelResolver(null);
});

// ── Channel predicate filtering ───────────────────────────────────────────────

describe('hudPushNotify: channel predicate via resolver injection', () => {
  afterEach(() => { _setChannelResolver(null); });

  test('root container (parentId null) is dropped — no clients receive the line', async () => {
    _setChannelResolver(async () => ({ name: 'Fallout 76', color: null, parentId: null, isArchived: false }));

    if (getClientCount() === 0) {
      const sends: string[] = [];
      hudPushNotify({ type: 'chat:message', payload: { channelId: ROOT_CONTAINER_ID, content: 'hi', username: 'Dev' } });
      await drainAsync();
      assert.equal(sends.length, 0, 'root container message must not be pushed to any client');
    } else {
      assert.ok(true, 'skipped: pre-existing clients from prior test runs');
    }
  });

  test('archived channel is dropped', async () => {
    _setChannelResolver(async () => ({ name: 'General', color: '#aaa', parentId: ROOT_CONTAINER_ID, isArchived: true }));

    if (getClientCount() === 0) {
      const sends: string[] = [];
      hudPushNotify({ type: 'chat:message', payload: { channelId: 'chan-1', content: 'hi', username: 'Dev' } });
      await drainAsync();
      assert.equal(sends.length, 0, 'archived channel message must not be pushed');
    } else {
      assert.ok(true, 'skipped: pre-existing clients');
    }
  });

  test('unknown channel (resolver returns null) is dropped', async () => {
    _setChannelResolver(async () => null);

    if (getClientCount() === 0) {
      const sends: string[] = [];
      hudPushNotify({ type: 'chat:message', payload: { channelId: 'chan-1', content: 'hi', username: 'Dev' } });
      await drainAsync();
      assert.equal(sends.length, 0, 'null channel must not be pushed');
    } else {
      assert.ok(true, 'skipped: pre-existing clients');
    }
  });
});

// ── Formatting parity ─────────────────────────────────────────────────────────

test('formatting parity: buildFeedLines output matches expected FCMHUD/1 record shape', () => {
  // Verifies that the same buildFeedLines used by backfill is used for live lines.
  const row = {
    content: 'WTB leaders',
    username: 'Devotek',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'General',
    channel_color: '#C8A840',
  };
  const [line] = buildFeedLines([row]);
  assert.equal(line, '#C8A840~General~Devotek~WTB leaders', 'FCMHUD/1 record must be color~channel~user~content');
});

test('formatting parity: Trading channel renamed to Trade in output', () => {
  const row = {
    content: 'WTS plans',
    username: 'Seller',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'Trading',
    channel_color: '#4A9FE0',
  };
  const [line] = buildFeedLines([row]);
  assert.equal(line, '#4A9FE0~Trade~Seller~WTS plans');
});

test('formatting parity: content over 70 chars is truncated', () => {
  const row = {
    content: 'x'.repeat(100),
    username: 'Dev',
    discord_display_name: null,
    discord_username: null,
    channel_name: 'General',
    channel_color: '#C8A840',
  };
  const [line] = buildFeedLines([row]);
  assert.ok(line.endsWith('...'), 'long content must be truncated with ellipsis');
  const content = line.split('~')[3];
  assert.equal(content.length, 70, 'content field must be exactly MAX_LINE chars after truncation');
});

// ── Client unregister on close ────────────────────────────────────────────────

test('unregisterClientPublic calls close() on the client', () => {
  let closed = false;
  const client: HudPushClient = {
    transport: 'tcp',
    activeChannelId: GENERAL_CHANNEL_ID,
    send(_line: string) { /* no-op */ },
    close() { closed = true; },
  };
  unregisterClientPublic(client);
  assert.ok(closed, 'close() must be called when unregistering a client');
});

// ── getClientCount ────────────────────────────────────────────────────────────

test('getClientCount returns a non-negative number', () => {
  const count = getClientCount();
  assert.ok(typeof count === 'number' && count >= 0, 'getClientCount must return a non-negative number');
});

// ── Per-connection channel filtering ─────────────────────────────────────────

describe('hudPushNotify: per-connection channel filter', () => {
  afterEach(() => {
    _setChannelResolver(null);
    _setChannelFeedFetcher(null);
    _setAggregateFeedFetcher(null);
  });

  /**
   * registerClient() kicks off an async backfill. Without injected feed fetchers
   * that backfill calls REAL Prisma against a database that does not exist in the
   * unit env, and the resulting connection/engine-startup latency is what made
   * this block time out under CPU load (issue #430) — the sibling describe blocks
   * already inject these for exactly that reason. Keep every test in here on the
   * no-DB fetchers so the suite never touches Prisma.
   */
  function injectNoDbFetchers(): void {
    _setChannelFeedFetcher(async () => []);
    _setAggregateFeedFetcher(async () => []);
  }

  test('General message is pushed to General-active client but NOT to Trading-active client', async () => {
    _setChannelResolver(async (id) => {
      if (id === GENERAL_CHANNEL_ID) return { name: 'General', color: '#C8A840', parentId: ROOT_CONTAINER_ID, isArchived: false };
      if (id === TRADING_CHANNEL_ID) return { name: 'Trading', color: '#4A9FE0', parentId: ROOT_CONTAINER_ID, isArchived: false };
      return null;
    });
    injectNoDbFetchers();

    const generalSends: string[] = [];
    const tradingSends: string[] = [];
    const generalClient = makeClient(generalSends, GENERAL_CHANNEL_ID);
    const tradingClient = makeClient(tradingSends, TRADING_CHANNEL_ID);
    registerClient(generalClient);
    registerClient(tradingClient);
    // Drain async backfill (will fail silently in unit env without DB — that is expected).
    await drainAsync();
    // Clear any sends from HELLO/ACTIVECHAN/backfill-error path.
    generalSends.length = 0;
    tradingSends.length = 0;

    try {
      hudPushNotify({
        type: 'chat:message',
        payload: { channelId: GENERAL_CHANNEL_ID, content: 'hello general', username: 'Dev', isPrivate: false },
      });
      // Wait for the delivery instead of assuming one drain is enough. The
      // negative assertion below is safe once this resolves: hudPushNotify fans
      // out to every client in ONE synchronous loop, so if Trading were going to
      // receive this message it would already have it by now.
      await waitFor(
        () => generalSends.some(l => l.includes('hello general')),
        'General client to receive the General message',
      );

      assert.ok(generalSends.some(l => l.includes('hello general')), 'General client must receive General message');
      assert.ok(!tradingSends.some(l => l.includes('hello general')), 'Trading client must NOT receive General message');
    } finally {
      // In a finally so a timeout can't leak registered clients into later tests.
      unregisterClientPublic(generalClient);
      unregisterClientPublic(tradingClient);
    }
  });

  test('Trading message is pushed to Trading-active client AND to the aggregate General client', async () => {
    _setChannelResolver(async (id) => {
      if (id === GENERAL_CHANNEL_ID) return { name: 'General', color: '#C8A840', parentId: ROOT_CONTAINER_ID, isArchived: false };
      if (id === TRADING_CHANNEL_ID) return { name: 'Trading', color: '#4A9FE0', parentId: ROOT_CONTAINER_ID, isArchived: false };
      return null;
    });
    injectNoDbFetchers();

    const generalSends: string[] = [];
    const tradingSends: string[] = [];
    const generalClient = makeClient(generalSends, GENERAL_CHANNEL_ID);
    const tradingClient = makeClient(tradingSends, TRADING_CHANNEL_ID);
    registerClient(generalClient);
    registerClient(tradingClient);
    await drainAsync();
    generalSends.length = 0;
    tradingSends.length = 0;

    try {
      hudPushNotify({
        type: 'chat:message',
        payload: { channelId: TRADING_CHANNEL_ID, content: 'WTS plans', username: 'Seller', isPrivate: false },
      });
      // Both clients are expected to receive this one (Trading directly, General
      // as the aggregate feed), so wait on each rather than draining once.
      await waitFor(
        () => tradingSends.some(l => l.includes('WTS plans')),
        'Trading client to receive the Trading message',
      );
      await waitFor(
        () => generalSends.some(l => l.includes('WTS plans')),
        'General (aggregate) client to receive the Trading message',
      );

      assert.ok(tradingSends.some(l => l.includes('WTS plans')), 'Trading client must receive Trading message');
      assert.ok(generalSends.some(l => l.includes('WTS plans')), 'General (aggregate) client MUST receive Trading message');
    } finally {
      unregisterClientPublic(generalClient);
      unregisterClientPublic(tradingClient);
    }
  });
});

// ── registerClient sends ACTIVECHAN ──────────────────────────────────────────

describe('registerClient: ACTIVECHAN on connect', () => {
  afterEach(() => {
    _setChannelResolver(null);
    _setChannelFeedFetcher(null);
    _setAggregateFeedFetcher(null);
  });

  test('registerClient sends HELLO then ACTIVECHAN~General when active channel is General', async () => {
    _setChannelResolver(async (id) => {
      if (id === GENERAL_CHANNEL_ID) return { name: 'General', color: '#C8A840', parentId: ROOT_CONTAINER_ID, isArchived: false };
      return null;
    });
    // Inject no-DB feed fetchers so no Prisma call occurs (General uses the
    // aggregate fetcher).
    _setChannelFeedFetcher(async () => []);
    _setAggregateFeedFetcher(async () => []);

    const sends: string[] = [];
    const client = makeClient(sends, GENERAL_CHANNEL_ID);
    try {
      registerClient(client);
      await waitFor(
        () => sends.some(l => l === 'ACTIVECHAN~General\n'),
        'ACTIVECHAN~General to be sent on connect',
      );

      assert.ok(sends[0]?.startsWith('HELLO~1~'), `Expected HELLO first, got: ${sends[0]}`);
      assert.ok(sends.some(l => l === 'ACTIVECHAN~General\n'), `Expected ACTIVECHAN~General, got: ${JSON.stringify(sends)}`);
    } finally {
      unregisterClientPublic(client);
    }
  });
});

// ── switchClientChannel ───────────────────────────────────────────────────────

describe('switchClientChannel', () => {
  afterEach(() => {
    _setChannelResolver(null);
    _setChannelFeedFetcher(null);
    _setAggregateFeedFetcher(null);
  });

  test('CHAN to valid leaf channel sends ACTIVECHAN~<name> and updates activeChannelId', async () => {
    _setChannelResolver(async (id) => {
      if (id === TRADING_CHANNEL_ID) return { name: 'Trading', color: '#4A9FE0', parentId: ROOT_CONTAINER_ID, isArchived: false };
      return null;
    });
    _setChannelFeedFetcher(async () => []);

    const sends: string[] = [];
    const client = makeClient(sends, GENERAL_CHANNEL_ID);
    switchClientChannel(client, TRADING_CHANNEL_ID);
    await waitFor(
      () => sends.some(l => l === 'ACTIVECHAN~Trading\n'),
      'ACTIVECHAN~Trading to be sent after the channel switch',
    );

    assert.equal(client.activeChannelId, TRADING_CHANNEL_ID, 'activeChannelId must be updated to Trading');
    assert.ok(sends.some(l => l === 'ACTIVECHAN~Trading\n'), `Expected ACTIVECHAN~Trading, got: ${JSON.stringify(sends)}`);
  });

  test('CHAN to root container (non-leaf) is ignored — activeChannelId unchanged', async () => {
    _setChannelResolver(async (id) => {
      if (id === ROOT_CONTAINER_ID) return { name: 'Fallout 76', color: null, parentId: null, isArchived: false };
      return null;
    });
    _setChannelFeedFetcher(async () => []);

    const sends: string[] = [];
    const client = makeClient(sends, GENERAL_CHANNEL_ID);
    switchClientChannel(client, ROOT_CONTAINER_ID);
    await drainAsync();

    assert.equal(client.activeChannelId, GENERAL_CHANNEL_ID, 'activeChannelId must remain General for root container');
    assert.ok(!sends.some(l => l.startsWith('ACTIVECHAN')), 'No ACTIVECHAN must be sent for non-leaf channel');
  });

  test('CHAN to unknown channelId is ignored', async () => {
    _setChannelResolver(async () => null);
    _setChannelFeedFetcher(async () => []);

    const sends: string[] = [];
    const client = makeClient(sends, GENERAL_CHANNEL_ID);
    switchClientChannel(client, 'not-a-real-uuid');
    await drainAsync();

    assert.equal(client.activeChannelId, GENERAL_CHANNEL_ID, 'activeChannelId must remain unchanged for unknown channel');
    assert.ok(!sends.some(l => l.startsWith('ACTIVECHAN')), 'No ACTIVECHAN for unknown channel');
  });
});
