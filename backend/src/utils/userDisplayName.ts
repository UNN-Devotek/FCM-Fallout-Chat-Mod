/**
 * Moderator-facing identity labels.
 *
 * `users.username` is only a real name once the player has a detected FO76 name.
 * Accounts that joined through Steam/HUD linking without Discord keep a
 * synthetic placeholder (`pending-<token>`, `discord:<id>`, `Overlay<digits>`),
 * while their real identity lives in chat_name / steam_display_name /
 * fo76_*_name. Moderation embeds, Discord autocomplete and the dashboard must
 * resolve the same visible name the chat feed shows, or moderators cannot
 * recognise (or search for) the player they are acting on.
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

/** Prisma `select` fragment holding every field the resolver reads. */
export const DISPLAY_NAME_SELECT = {
  username: true,
  chatName: true,
  steamDisplayName: true,
  fo76CharacterName: true,
  fo76AccountName: true,
  discordDisplayName: true,
  discordUsername: true,
} as const;

/** True for synthetic usernames that must never be shown as a player's name. */
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

/** FO76 name for the profile/lookup "FO76 name" field, or null when none was detected. */
export function resolveFo76Name(user: DisplayNameFields): string | null {
  if (!isPlaceholderUsername(user.username)) return clean(user.username);
  return clean(user.fo76CharacterName) ?? clean(user.fo76AccountName);
}

/**
 * The name moderators saw in chat. Order matches the live chat resolver
 * (chat name, real FO76 username, Steam name, Discord name) with the stored
 * FO76 export names as a final fallback before the raw placeholder.
 */
export function resolveUserDisplayName(user: DisplayNameFields | null | undefined): string {
  if (!user) return 'unknown';
  return clean(user.chatName)
    ?? (isPlaceholderUsername(user.username) ? null : clean(user.username))
    ?? clean(user.steamDisplayName)
    ?? clean(user.discordDisplayName)
    ?? clean(user.discordUsername)
    ?? clean(user.fo76CharacterName)
    ?? clean(user.fo76AccountName)
    ?? clean(user.username)
    ?? 'unknown';
}
