import { isPlaceholderUsername, resolveUserDisplayName, type DisplayNameFields } from '../../utils/userDisplayName';

/** Columns read by the relay history SQL for name resolution (snake_case, raw query rows). */
export interface RelayHistoryNameRow {
  source: string;
  username: string | null;
  chat_name?: string | null;
  steam_display_name?: string | null;
  fo76_character_name?: string | null;
  fo76_account_name?: string | null;
  discord_display_name?: string | null;
  discord_username?: string | null;
}

/** Sources whose live label is the in-game character name supplied by the HUD sender. */
const IN_GAME_SOURCES = new Set(['relay', 'hud', 'game']);

function clean(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

/**
 * The sender label for a replayed relay history row. It must match the name the live event
 * carried: HUD sends are labelled with the in-game name (recorded as fo76_account_name when
 * the relay token links), every other source uses the shared chat display-name resolver.
 * A synthetic placeholder (`pending-*`, `discord:*`, `Overlay123`) is never shown.
 */
export function relayHistoryDisplayName(row: RelayHistoryNameRow): string {
  if (row.source === 'bot') return '[Vault-Tec]';
  const fields: DisplayNameFields = {
    username: row.username,
    chatName: row.chat_name,
    steamDisplayName: row.steam_display_name,
    fo76CharacterName: row.fo76_character_name,
    fo76AccountName: row.fo76_account_name,
    discordDisplayName: row.discord_display_name,
    discordUsername: row.discord_username,
  };
  const inGame = IN_GAME_SOURCES.has(row.source)
    ? clean(row.fo76_account_name) ?? clean(row.fo76_character_name) : null;
  const name = inGame ?? resolveUserDisplayName(fields);
  return isPlaceholderUsername(name) ? 'Wanderer' : name;
}
