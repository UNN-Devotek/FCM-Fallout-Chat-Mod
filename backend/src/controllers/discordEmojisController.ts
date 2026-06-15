import { Request, Response, NextFunction } from 'express';
import env from '../config/environment';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface EmojiEntry {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

interface EmojiCache {
  data: EmojiEntry[];
  expiresAt: number;
}

let emojiCache: EmojiCache | null = null;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Immediately invalidate the emoji cache. Called from discordService.ts on
 * emojiCreate / emojiDelete / emojiUpdate events.
 */
function invalidateEmojiCache(): void {
  emojiCache = null;
  logger.debug('Discord emoji cache invalidated');
}

// ---------------------------------------------------------------------------
// Helper — build emoji list from the discord.js guild cache
// ---------------------------------------------------------------------------

function buildEmojiList(): EmojiEntry[] | null {
  // Lazy-require to avoid circular deps at module load time.
  // discordService exports `getDiscordClient` — use that.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const discordService = require('../services/discordService') as {
    getDiscordClient: () => import('discord.js').Client | null;
  };

  const client = discordService.getDiscordClient();
  if (!client || !client.isReady()) return null;

  const guild = client.guilds.cache.get(env.DISCORD_SERVER_ID);
  if (!guild) return null;

  const emojis: EmojiEntry[] = [];

  for (const emoji of guild.emojis.cache.values()) {
    if (!emoji.id || !emoji.name) continue;
    const animated = emoji.animated ?? false;
    // Animated emojis: serve .webp?animated=true, NOT .gif. Emojis uploaded as
    // animated WebP/APNG return HTTP 415 for their .gif rendition (Discord won't
    // transcode), which rendered as broken images in the pickers. WebP animates
    // in <img> and SKCodec decodes it; static stays .png.
    const url = animated
      ? `https://cdn.discordapp.com/emojis/${emoji.id}.webp?animated=true`
      : `https://cdn.discordapp.com/emojis/${emoji.id}.png`;
    emojis.push({
      id: emoji.id,
      name: emoji.name,
      animated,
      url,
    });
  }

  // Animated first, then alphabetical by name
  emojis.sort((a, b) => {
    if (a.animated !== b.animated) return a.animated ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return emojis;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * GET /api/discord-emojis
 * Returns the guild's custom emojis from the bot's in-memory cache.
 * No auth required — rate-limited by the global apiLimiter.
 */
async function getDiscordEmojis(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const now = Date.now();

    // Serve from cache if still fresh
    if (emojiCache && now < emojiCache.expiresAt) {
      res.json({ data: emojiCache.data });
      return;
    }

    const fresh = buildEmojiList();

    if (fresh === null) {
      // Discord client is not ready — return stale snapshot or empty
      const staleData = emojiCache?.data ?? [];
      res.json({ data: staleData, stale: true });
      return;
    }

    // Populate cache
    emojiCache = { data: fresh, expiresAt: now + CACHE_TTL_MS };
    res.json({ data: fresh });
  } catch (err) {
    next(err);
  }
}

export { getDiscordEmojis, invalidateEmojiCache };
module.exports = { getDiscordEmojis, invalidateEmojiCache };
