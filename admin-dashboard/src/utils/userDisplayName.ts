/**
 * Moderator-facing player names for dashboard pages.
 *
 * `username` is a synthetic placeholder (`pending-*`, `discord:*`, ...) until a
 * real FO76 name is detected. Steam/HUD-linked players without Discord keep that
 * placeholder, so pages must fall back to the chat name, Steam name, Discord name
 * and stored FO76 names - the same order the chat feed uses. Mirrors
 * backend/src/utils/userDisplayName.ts.
 */
export interface DisplayNameFields {
  username?: string | null;
  chatName?: string | null;
  steamDisplayName?: string | null;
  fo76CharacterName?: string | null;
  fo76AccountName?: string | null;
  discordDisplayName?: string | null;
  discordUsername?: string | null;
}

export function isPlaceholderUsername(username: string | null | undefined): boolean {
  if (!username || !username.trim()) return true;
  return username === 'Wanderer'
    || username.startsWith('pending-')
    || username.startsWith('discord:')
    || username.startsWith('admin-discord-')
    || /^overlay\d+$/i.test(username);
}

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

/** Detected FO76 name, or null when the account has none yet. */
export function fo76NameOf(user: DisplayNameFields): string | null {
  if (!isPlaceholderUsername(user.username)) return clean(user.username);
  return clean(user.fo76CharacterName) ?? clean(user.fo76AccountName);
}

export function userDisplayName(user: DisplayNameFields | null | undefined, fallback = '—'): string {
  if (!user) return fallback;
  return clean(user.chatName)
    ?? (isPlaceholderUsername(user.username) ? null : clean(user.username))
    ?? clean(user.steamDisplayName)
    ?? clean(user.discordDisplayName)
    ?? clean(user.discordUsername)
    ?? clean(user.fo76CharacterName)
    ?? clean(user.fo76AccountName)
    ?? clean(user.username)
    ?? fallback;
}
