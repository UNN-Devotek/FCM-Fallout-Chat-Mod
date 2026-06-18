/**
 * Pure helpers for the Discord "Report a Player" flow. No discord.js / prisma /
 * network imports — unit-tested in tests/playerReportHelpers.test.js.
 */

export const REPORT_CONTENT_MAX = 2000; // mirrors playerReportsController CONTENT_MAX
export const REPORT_INVOLVED_MAX = 500;
export const REPORT_IMAGE_MAX = 3; // mirrors reportImageService MAX_FILES

/**
 * Sanitize the "involved players" field: plain text only, strip HTML/quote chars,
 * cap length, null when empty. Mirrors playerReportsController's web-form rule.
 */
export function sanitizeInvolvedPlayers(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[<>"'&;\\]/g, '').slice(0, REPORT_INVOLVED_MAX).trim();
  return cleaned || null;
}

/** Cap report content to the server max (trimmed). */
export function clampReportContent(raw: string): string {
  return (raw || '').trim().slice(0, REPORT_CONTENT_MAX);
}

/**
 * Merge newly-uploaded image URLs into the existing set, capped at REPORT_IMAGE_MAX.
 * Returns the merged list plus how many of `incoming` were accepted vs dropped.
 */
export function capImageUrls(
  existing: string[],
  incoming: string[],
  max = REPORT_IMAGE_MAX,
): { merged: string[]; accepted: number; dropped: number } {
  const room = Math.max(0, max - existing.length);
  const accepted = incoming.slice(0, room);
  return {
    merged: [...existing, ...accepted],
    accepted: accepted.length,
    dropped: incoming.length - accepted.length,
  };
}

/** How many more images a report can still accept. */
export function remainingImageSlots(existingCount: number, max = REPORT_IMAGE_MAX): number {
  return Math.max(0, max - existingCount);
}

export const REPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // mirrors reportImageService MAX_FILE_SIZE
/** Hosts the bot is allowed to download attachments from (SSRF defense-in-depth). */
export const ALLOWED_DISCORD_CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

/**
 * True only for https URLs on Discord's CDN. Used before the bot fetches a thread
 * attachment so a crafted/forwarded URL can't point us at an internal address.
 */
export function isAllowedDiscordAttachmentUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_DISCORD_CDN_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Discord thread name for a player report:
 * "Player Report · #<number> · <involved> · <reporter>" (no emoji), ≤ Discord's
 * 100-char limit. The "Player Report · #<number>" head is always preserved; the
 * involved/reporter tail is trimmed to fit.
 */
export function buildPlayerReportThreadName(
  reporterName: string,
  involvedName: string | null | undefined,
  reportNumber: number,
): string {
  const head = `Player Report · #${reportNumber}`; // always preserved
  const reporter = (reporterName || 'player').replace(/\s+/g, ' ').trim() || 'player';
  const involved = (involvedName || '').replace(/\s+/g, ' ').trim();
  const tailParts = [involved, reporter].filter(Boolean); // involved, then reporter
  let tail = tailParts.length ? ` · ${tailParts.join(' · ')}` : '';
  const room = THREAD_NAME_MAX - head.length;
  if (tail.length > room) tail = tail.slice(0, room - 1) + '…';
  return `${head}${tail}`;
}

const THREAD_NAME_MAX = 100;

module.exports = {
  REPORT_CONTENT_MAX,
  REPORT_INVOLVED_MAX,
  REPORT_IMAGE_MAX,
  REPORT_IMAGE_MAX_BYTES,
  ALLOWED_DISCORD_CDN_HOSTS,
  isAllowedDiscordAttachmentUrl,
  sanitizeInvolvedPlayers,
  clampReportContent,
  capImageUrls,
  remainingImageSlots,
  buildPlayerReportThreadName,
};
