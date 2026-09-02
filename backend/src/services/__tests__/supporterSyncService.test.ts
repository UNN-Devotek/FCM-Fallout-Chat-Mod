import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HUD_ROLE_REFRESH_INTERVAL_MS,
  refreshSupporterFromHudSend,
  resetHudRoleRefreshState,
} from '../supporterSyncService';

test('refreshes HUD senders from Discord roles and enforces a one-minute cooldown', async () => {
  resetHudRoleRefreshState();

  let now = 10_000;
  let fetchCount = 0;
  const syncCalls: Array<{ discordId: string; roles: readonly string[] }> = [];
  const bustCalls: string[] = [];
  const presentationCalls: string[] = [];

  const deps = {
    now: () => now,
    isConfigured: () => true,
    getUser: async () => ({ discordId: 'discord-supporter-1' }),
    acquireSlot: async () => true,
    fetchRoles: async () => {
      fetchCount++;
      return ['supporter-role'];
    },
    syncRoles: async (discordId: string, roles: readonly string[] | null | undefined) => {
      syncCalls.push({ discordId, roles: roles ?? [] });
      return { tier: 'supporter' as const, changed: true };
    },
    bustCosmetics: async (userId: string) => { bustCalls.push(userId); },
    refreshPresentation: async (discordId: string) => {
      presentationCalls.push(discordId);
      return true;
    },
  };

  await refreshSupporterFromHudSend({ userId: 'fcm-user-1' }, deps);
  await refreshSupporterFromHudSend({ userId: 'fcm-user-1' }, deps);

  assert.equal(fetchCount, 1);
  assert.deepEqual(syncCalls, [{ discordId: 'discord-supporter-1', roles: ['supporter-role'] }]);
  assert.deepEqual(bustCalls, ['fcm-user-1']);
  assert.deepEqual(presentationCalls, ['discord-supporter-1']);

  now += HUD_ROLE_REFRESH_INTERVAL_MS;
  await refreshSupporterFromHudSend({ userId: 'fcm-user-1' }, deps);
  assert.equal(fetchCount, 2);
});

test('coalesces concurrent HUD sends for the same Discord account', async () => {
  resetHudRoleRefreshState();

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let fetchCount = 0;

  const deps = {
    now: () => 20_000,
    isConfigured: () => true,
    getUser: async () => ({ discordId: 'discord-supporter-2' }),
    acquireSlot: async () => true,
    fetchRoles: async () => {
      fetchCount++;
      await fetchGate;
      return ['supporter-role'];
    },
    syncRoles: async () => ({ tier: 'supporter' as const, changed: false }),
    bustCosmetics: async () => {},
    refreshPresentation: async () => true,
  };

  const first = refreshSupporterFromHudSend({ userId: 'fcm-user-2' }, deps);
  const second = refreshSupporterFromHudSend({ userId: 'fcm-user-2' }, deps);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFetch();
  await Promise.all([first, second]);

  assert.equal(fetchCount, 1);
});

test('does not call Discord when another backend owns the Redis refresh slot', async () => {
  resetHudRoleRefreshState();

  let fetchCount = 0;
  let syncCount = 0;
  await refreshSupporterFromHudSend({ userId: 'fcm-user-redis-locked' }, {
    isConfigured: () => true,
    getUser: async () => ({ discordId: 'discord-supporter-redis-locked' }),
    acquireSlot: async () => false,
    fetchRoles: async () => {
      fetchCount++;
      return ['supporter-role'];
    },
    syncRoles: async () => {
      syncCount++;
      return { tier: 'supporter' as const, changed: true };
    },
    bustCosmetics: async () => {},
    refreshPresentation: async () => true,
  });

  assert.equal(fetchCount, 0);
  assert.equal(syncCount, 0);
});

test('uses a trusted Discord ID supplied by the relay without another user lookup', async () => {
  resetHudRoleRefreshState();

  let userLookupCount = 0;
  let fetchedDiscordId = '';
  await refreshSupporterFromHudSend({
    userId: 'fcm-user-known-discord',
    discordId: 'discord-known-1',
  }, {
    isConfigured: () => true,
    getUser: async () => {
      userLookupCount++;
      return { discordId: 'wrong-value' };
    },
    acquireSlot: async (discordId) => {
      fetchedDiscordId = discordId;
      return true;
    },
    fetchRoles: async () => [],
    syncRoles: async () => ({ tier: 'none' as const, changed: false }),
  });

  assert.equal(userLookupCount, 0);
  assert.equal(fetchedDiscordId, 'discord-known-1');
});

test('keeps the last entitlement on transient Discord failures', async () => {
  resetHudRoleRefreshState();

  let syncCount = 0;
  let presentationCount = 0;
  await assert.doesNotReject(() => refreshSupporterFromHudSend({ userId: 'fcm-user-3' }, {
    isConfigured: () => true,
    getUser: async () => ({ discordId: 'discord-supporter-3' }),
    acquireSlot: async () => true,
    fetchRoles: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); },
    syncRoles: async () => {
      syncCount++;
      return { tier: 'none' as const, changed: true };
    },
    bustCosmetics: async () => {},
    refreshPresentation: async () => {
      presentationCount++;
      return true;
    },
  }));

  assert.equal(syncCount, 0);
  assert.equal(presentationCount, 0);
});
