/**
 * Decide which FCM account owns a verified Steam identity during linking.
 *
 * A user may have an older Steam-only row from a previous install and later
 * authenticate a different row with Discord.  Linking Steam from that
 * authenticated account is an explicit provider attach, so the Steam-only
 * row can be merged into the authenticated account.  We do not silently merge
 * two rows that both already carry another provider identity.
 */

export interface SteamLinkAccount {
  id: string;
  steamId: string | null;
  discordId: string | null;
  linkedIdentityCount: number;
}

export type SteamLinkResolution =
  | { kind: 'create'; targetId: null; mergeSourceId: null }
  | { kind: 'use-install'; targetId: string; mergeSourceId: null }
  | { kind: 'use-existing'; targetId: string; mergeSourceId: null }
  | { kind: 'merge-existing-into-install'; targetId: string; mergeSourceId: string }
  | { kind: 'merge-install-into-existing'; targetId: string; mergeSourceId: string }
  | { kind: 'conflict'; reason: 'install-already-linked' | 'account-already-linked' };

function hasNonSteamProvider(account: SteamLinkAccount): boolean {
  return Boolean(account.discordId) || account.linkedIdentityCount > 0;
}

/**
 * Resolve the account action after Steam has been verified server-side.
 * `existingAccount` is the row currently holding the verified Steam ID, if any.
 */
export function resolveSteamLinkTarget(input: {
  steamId: string;
  installAccount: SteamLinkAccount | null;
  existingAccount: SteamLinkAccount | null;
}): SteamLinkResolution {
  const { steamId, installAccount, existingAccount } = input;

  if (installAccount?.steamId && installAccount.steamId !== steamId) {
    return { kind: 'conflict', reason: 'install-already-linked' };
  }

  if (!installAccount && !existingAccount) {
    return { kind: 'create', targetId: null, mergeSourceId: null };
  }
  if (!installAccount && existingAccount) {
    return { kind: 'use-existing', targetId: existingAccount.id, mergeSourceId: null };
  }
  if (installAccount && !existingAccount) {
    return { kind: 'use-install', targetId: installAccount.id, mergeSourceId: null };
  }

  // From here both rows exist and are different rows because an existing
  // Steam lookup excludes the current install token.
  if (installAccount!.id === existingAccount!.id) {
    return { kind: 'use-install', targetId: installAccount!.id, mergeSourceId: null };
  }

  const installHasOtherProvider = hasNonSteamProvider(installAccount!);
  const existingHasOtherProvider = hasNonSteamProvider(existingAccount!);

  // This is the requested reclaim path: the user is already authenticated on
  // the active account (normally Discord), and the old Steam row has no other
  // provider identity. Keep the active account canonical so its Discord roles,
  // display identity, and install token remain authoritative.
  if (installHasOtherProvider && !existingHasOtherProvider) {
    return {
      kind: 'merge-existing-into-install',
      targetId: installAccount!.id,
      mergeSourceId: existingAccount!.id,
    };
  }

  // A fresh install has no provider of its own. Preserve the account that
  // already owns Steam and move the placeholder's history into it.
  if (!installHasOtherProvider) {
    return {
      kind: 'merge-install-into-existing',
      targetId: existingAccount!.id,
      mergeSourceId: installAccount!.id,
    };
  }

  // Both rows already have provider identities. Requiring an explicit support
  // merge prevents Steam possession from silently joining unrelated accounts.
  return { kind: 'conflict', reason: 'account-already-linked' };
}
