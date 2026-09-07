import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSteamLinkTarget, SteamLinkAccount } from '../steamAccountLinkService';

const STEAM_ID = '76561198012345678';

function account(overrides: Partial<SteamLinkAccount>): SteamLinkAccount {
  return {
    id: 'account-id',
    steamId: null,
    discordId: null,
    linkedIdentityCount: 0,
    ...overrides,
  };
}

test('attaches Steam to the existing Discord account when no Steam row exists', () => {
  assert.deepEqual(resolveSteamLinkTarget({
    steamId: STEAM_ID,
    installAccount: account({ id: 'discord-account', discordId: 'discord-1' }),
    existingAccount: null,
  }), {
    kind: 'use-install',
    targetId: 'discord-account',
    mergeSourceId: null,
  });
});

test('reclaims an old Steam-only row into the active Discord account', () => {
  assert.deepEqual(resolveSteamLinkTarget({
    steamId: STEAM_ID,
    installAccount: account({ id: 'discord-account', discordId: 'discord-1' }),
    existingAccount: account({ id: 'old-steam-account', steamId: STEAM_ID }),
  }), {
    kind: 'merge-existing-into-install',
    targetId: 'discord-account',
    mergeSourceId: 'old-steam-account',
  });
});

test('reclaims an existing Steam account for a fresh install', () => {
  assert.deepEqual(resolveSteamLinkTarget({
    steamId: STEAM_ID,
    installAccount: account({ id: 'fresh-install' }),
    existingAccount: account({ id: 'steam-account', steamId: STEAM_ID }),
  }), {
    kind: 'merge-install-into-existing',
    targetId: 'steam-account',
    mergeSourceId: 'fresh-install',
  });
});

test('does not merge two accounts that both already have another provider', () => {
  assert.deepEqual(resolveSteamLinkTarget({
    steamId: STEAM_ID,
    installAccount: account({ id: 'discord-account', discordId: 'discord-1' }),
    existingAccount: account({ id: 'other-account', steamId: STEAM_ID, linkedIdentityCount: 1 }),
  }), {
    kind: 'conflict',
    reason: 'account-already-linked',
  });
});

test('rejects relinking an install to a different Steam identity', () => {
  assert.deepEqual(resolveSteamLinkTarget({
    steamId: STEAM_ID,
    installAccount: account({ id: 'discord-account', discordId: 'discord-1', steamId: '76561198000000000' }),
    existingAccount: null,
  }), {
    kind: 'conflict',
    reason: 'install-already-linked',
  });
});
