/**
 * hudFeedService.ts
 *
 * Shared core logic for the HUD feed — extracted from routes/hudFeed.ts so
 * both the REST polling endpoint and the live push path (hudPush.ts) can reuse
 * the same formatting functions and SQL without duplication.
 */

import prisma from '../config/prisma';

export const FEED_LIMIT = 30;

export const isPlaceholder = (n: string | null | undefined): boolean =>
  !n || n === 'Wanderer' || n.startsWith('pending-') || /^overlay\d+$/i.test(n) || n.startsWith('discord:');

/**
 * ZFE's readRemoteData envelope escapes/unescapes quotes exactly one level
 * deep, so any `"` or `\` in a JSON string VALUE gets corrupted on the
 * Scaleform side (double-escape → bare quote → broken parsing). The full
 * pattern (quote-free payload + escape-aware SWF extraction) is documented
 * in docs/overlay/zfe/fcmbridge-data-pattern.md.
 *
 * zfeSafe strips every character that could break the envelope, the record
 * format, or the SWF's htmlText rendering: `"` → ', `\` → /, `|` → ¦
 * (record sep), `~` → ∼ (field sep), `<` → ‹, `>` → ›, `&` → +,
 * newlines → space.
 */
export const zfeSafe = (s: string): string =>
  s.replace(/"/g, '‘').replace(/\\/g, '/').replace(/\|/g, '¦').replace(/~/g, '∼')
    .replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '+').replace(/[\r\n]+/g, ' ');

export const MAX_LINE = 70;        // chars per rendered line before truncation
const DEFAULT_COL = '#C8A840'; // General fallback (matches ChatOverlay BUILTIN_RELAYS)

/** Channel display renames, mirroring ChatOverlay.tsx (Trading → Trade). */
export const tagLabel = (ch: string): string => (ch === 'Trading' ? 'Trade' : ch);

/**
 * Pure: render DB rows into `color~channel~user~content` records.
 * Colors are validated to #RRGGBB so a malformed DB value can't smuggle
 * format-breaking characters into the payload.
 */
export const buildFeedLines = (rows: any[]): string[] =>
  rows.map((row: any) => {
    const username = !isPlaceholder(row.username)
      ? row.username
      : (row.discord_display_name || row.discord_username || 'Wanderer');
    let content = zfeSafe(String(row.content));
    if (content.length > MAX_LINE) content = content.slice(0, MAX_LINE - 3) + '...';
    const rawCol = String(row.channel_color ?? '');
    const col = /^#[0-9a-fA-F]{6}$/.test(rawCol) ? rawCol : DEFAULT_COL;
    return [
      col,
      zfeSafe(tagLabel(String(row.channel_name))),
      zfeSafe(String(username)),
      content,
    ].join('~');
  });

/**
 * Fetch the most recent `limit` hud-feed rows from Postgres.
 * Returns rows in DESC order (newest first) — caller reverses if needed.
 * This is the same SQL as the original GET /api/game/hud-feed route, verbatim.
 */
export async function fetchFeedRows(limit: number = FEED_LIMIT): Promise<any[]> {
  return prisma.$queryRaw<any[]>`
    SELECT m.content,
           u.username, u.discord_display_name, u.discord_username,
           c.name  AS channel_name,
           c.color AS channel_color,
           m.created_at
    FROM   messages m
    JOIN   users    u ON u.id = m.user_id
    JOIN   channels c ON c.id = m.channel_id
    WHERE  c.parent_id IS NOT NULL
      AND  NOT c.is_archived
      AND  NOT m.is_deleted
    ORDER BY m.created_at DESC
    LIMIT  ${limit}`;
}

/**
 * Fetch the most recent `limit` hud-feed rows for a SINGLE leaf channel.
 * Returns rows in DESC order (newest first) — caller reverses for oldest-first display.
 * Filters by channelId in addition to the standard leaf/active/non-deleted predicates.
 */
export async function fetchFeedRowsForChannel(channelId: string, limit: number = FEED_LIMIT): Promise<any[]> {
  return prisma.$queryRaw<any[]>`
    SELECT m.content,
           u.username, u.discord_display_name, u.discord_username,
           c.name  AS channel_name,
           c.color AS channel_color,
           m.created_at
    FROM   messages m
    JOIN   users    u ON u.id = m.user_id
    JOIN   channels c ON c.id = m.channel_id
    WHERE  c.id       = ${channelId}::uuid
      AND  c.parent_id IS NOT NULL
      AND  NOT c.is_archived
      AND  NOT m.is_deleted
    ORDER BY m.created_at DESC
    LIMIT  ${limit}`;
}
