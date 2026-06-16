import { Client, GatewayIntentBits, Partials, TextChannel, EmbedBuilder, ActivityType, type Message } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import env from '../config/environment';
import prisma from '../config/prisma';
import messageQueue from '../queues/messagePersist';
import logger from '../config/logger';
import voiceService from './voiceService';
import reactionRoleService from './reactionRoleService';
import { getEntry, bestMatch } from './wikiCatalogService';

let discordClient: Client | null = null;
let broadcastFn: ((payload: any, excludeWs?: any) => void) | null = null; // Injected from WS handler to avoid circular deps
let discordStatus = 'disconnected';

// ZWS watermark -- inserted into all outbound relay messages (game->Discord)
// so inbound handler can detect and reject echo loops (defense-in-depth)
const ZWS = '\u200B';

// Outbound rate-limit queue -- drains at 4 msg/sec (250ms interval)
const outboundQueue: Array<() => Promise<void>> = [];
let drainTimer: ReturnType<typeof setInterval> | null = null;

function startDrain(): void {
  if (drainTimer) return;
  drainTimer = setInterval(async () => {
    const item = outboundQueue.shift();
    if (!item) {
      clearInterval(drainTimer!);
      drainTimer = null;
      return;
    }
    try {
      await item();
    } catch (err) {
      logger.error({ err }, 'Failed to send queued Discord message');
    }
  }, 250);
}

/**
 * Strip Discord mention patterns from content to prevent mention abuse via relay.
 * Replaces @everyone, @here, <@userId>, <@!userId>, <@&roleId>, <#channelId>.
 * NFC-normalizes first so homoglyphs and combining diacritics (e.g. @éveryone)
 * don't bypass the literal @everyone / @here check.
 */
function stripMentions(text: string): string {
  return text.normalize('NFC')
    .replace(/@(everyone|here)/g, '$1')
    .replace(/<@!?\d+>/g, '[user]')
    .replace(/<@&\d+>/g, '[role]')
    .replace(/<#\d+>/g, '[channel]');
}

/**
 * Resolve Discord user-mention tokens (<@id> / <@!id>) to readable names on the
 * INBOUND relay path (Discord → overlay). Each mentioned user id is resolved with
 * this priority:
 *   1. Our DB `users.username` if it is a real FO76 name (not 'Wanderer', not
 *      a `pending-*` placeholder, not an `Overlay<digits>` auto-handle).
 *   2. Discord member's server display name / global_name / username from the
 *      message's resolved `mentions` collection.
 *
 * All DB lookups are batched into a single `findMany` query. Role, channel,
 * @everyone, and @here tokens are NOT touched here — they are handled by
 * stripMentions() later (outbound path) or neutralised upstream.
 *
 * Returns the content string with every `<@id>` / `<@!id>` replaced by `@Name`.
 */
async function resolveInboundUserMentions(
  content: string,
  msg: import('discord.js').Message,
): Promise<string> {
  // Collect every unique user-mention id present in the content string.
  const idSet = new Set<string>();
  for (const m of content.matchAll(/<@!?(\d+)>/g)) {
    idSet.add(m[1]);
  }
  if (idSet.size === 0) return content;

  const ids = [...idSet];

  // Batch-resolve DB rows for all mentioned ids in one query.
  let dbRows: Array<{ discordId: string | null; username: string }> = [];
  try {
    dbRows = await prisma.user.findMany({
      where: { discordId: { in: ids } },
      select: { discordId: true, username: true },
    });
  } catch {
    // DB error — fall through to Discord-only names.
  }

  // Build a map: discordId → real FO76 username (if valid).
  const fo76Map = new Map<string, string>();
  for (const row of dbRows) {
    if (!row.discordId) continue;
    const u = row.username;
    const isReal =
      u &&
      u !== 'Wanderer' &&
      !u.startsWith('pending-') &&
      !/^Overlay\d+$/.test(u);
    if (isReal) fo76Map.set(row.discordId, u);
  }

  // Replace each <@id> / <@!id> token with the best available display name.
  return content.replace(/<@!?(\d+)>/g, (_match, id: string) => {
    // Priority 1: real FO76 name from our DB.
    const fo76Name = fo76Map.get(id);
    if (fo76Name) return `@${fo76Name}`;

    // Priority 2: Discord member server display name / global name / username.
    const mentionedUser = msg.mentions.users.get(id);
    const memberName =
      msg.mentions.members?.get(id)?.displayName ??
      (mentionedUser as { globalName?: string } | undefined)?.globalName ??
      mentionedUser?.username;
    if (memberName) return `@${memberName}`;

    // Fallback: leave a neutral token (shouldn't normally reach here).
    return `@[user]`;
  });
}

/**
 * Check whether a message contains our ZWS watermark (echo from own relay).
 * Uses includes() so it catches the watermark wherever it sits (legacy builds
 * inserted it at index 1; we now append it so it can't split a leading mention).
 */
function hasZwsWatermark(text: string): boolean {
  return text.includes(ZWS);
}

/**
 * Wrap raw URLs in `[truncatedDisplay](url)` so Discord bot messages render them
 * as proper clickable hyperlinks with a compact label (e.g. "youtube.com/…")
 * instead of dumping the full URL. Discord renders markdown link syntax in bot
 * messages and also suppresses the bulky link-preview embed when the URL lives
 * inside a markdown link — matching the overlay's truncated-link UX.
 */
function markdownifyLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"')]+/gi, (raw) => {
    const trimmed = raw.replace(/[.,;:!?\]}'"]+$/, '');
    const trailing = raw.slice(trimmed.length);
    try {
      const u = new URL(trimmed);
      const host = u.hostname.replace(/^www\./i, '');
      const hasPath = (u.pathname && u.pathname !== '/') || u.search || u.hash;
      let disp = hasPath ? `${host}/…` : host;
      if (disp.length > 32) disp = disp.slice(0, 31) + '…';
      // Escape ']' in display text so it can't break out of the markdown label.
      disp = disp.replace(/]/g, '\\]');
      return `[${disp}](${trimmed})${trailing}`;
    } catch {
      return raw;
    }
  });
}

/**
 * Convert in-app @name tokens into real Discord mentions (<@discordId>) for any
 * linked user whose FO76 username / Discord username / Discord display name
 * matches (case-insensitive). Unmatched @tokens are left as plain text.
 * Single-token names only (\w.-) — multi-word display names match their first token.
 */
async function resolveAppMentions(text: string): Promise<string> {
  if (!text.includes('@')) return text;
  // Multi-word display names (e.g. "Devotek The Great") can't be captured by a
  // single \w-only regex, so do a greedy longest-match against ALL linked users'
  // names. Scales linearly with linked user count; cache if this gets hot.
  const users = await prisma.user.findMany({
    where: { discordId: { not: null } },
    select: { discordId: true, username: true, discordUsername: true, discordDisplayName: true },
  });
  if (users.length === 0) return text;

  type Cand = { name: string; id: string };
  const candidates: Cand[] = [];
  for (const u of users) {
    if (!u.discordId) continue;
    for (const n of [u.username, u.discordUsername, u.discordDisplayName]) {
      if (!n) continue;
      const trimmed = n.trim();
      if (trimmed.length < 2 || trimmed === 'Wanderer' || trimmed.startsWith('pending-')) continue;
      candidates.push({ name: trimmed, id: u.discordId });
    }
  }
  // Longest first → multi-word names win over single-token names that are also a prefix.
  candidates.sort((a, b) => b.name.length - a.name.length);
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let result = text;
  for (const c of candidates) {
    // @<name> with a non-word/end boundary AFTER, case-insensitive. The lookbehind
    // (?<![\w]) avoids matching inside an existing word (e.g. email-like "x@foo").
    const re = new RegExp(`(?<![A-Za-z0-9])@${escapeRe(c.name)}(?![A-Za-z0-9])`, 'gi');
    result = result.replace(re, `<@${c.id}>`);
  }
  return result;
}

// Relay mapping cache -- refreshed every 60s to pick up admin dashboard changes
let mappingsCache: Map<string, string> | null = null;
let mappingsLastLoaded = 0;
let mappingsPromise: Promise<Map<string, string>> | null = null; // in-flight guard prevents stampede

// Default channel ID cache -- rarely changes; refreshed every 5 minutes
let defaultChannelIdCache: string | null | undefined = undefined;
let defaultChannelLastLoaded = 0;
let defaultChannelPromise: Promise<string | null> | null = null; // in-flight guard

function setBroadcast(fn: (payload: any, excludeWs?: any) => void): void { broadcastFn = fn; }
function getStatus(): string { return discordStatus; }

/**
 * Live "Watching N dwellers tune the Vault-Tec airwaves" presence. Pulled from the
 * WebSocket handlers' client map via a lazy require (avoids the circular import —
 * handlers.ts already imports relayToDiscord from this module).
 */
function getOnlineUserCount(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ws = require('../websocket/handlers') as { getClientCount?: () => number };
    return typeof ws.getClientCount === 'function' ? ws.getClientCount() : 0;
  } catch {
    return 0;
  }
}

function updatePresence(): void {
  if (!discordClient?.user) return;
  const n = getOnlineUserCount();
  const noun = n === 1 ? 'dweller' : 'dwellers';
  try {
    discordClient.user.setPresence({
      status: 'online',
      // Custom status renders the literal name string without a verb prefix —
      // ActivityType.Watching was being shown without its "Watching " verb on
      // some Discord clients, so we bake the verb into the text ourselves.
      activities: [{ name: `Watching ${n} ${noun}`, type: ActivityType.Custom, state: `Watching ${n} ${noun}` }],
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to update Discord presence');
  }
}

async function loadRelayMappings(): Promise<Map<string, string>> {
  const now = Date.now();
  if (mappingsCache && now - mappingsLastLoaded < 60_000) return mappingsCache;

  if (!mappingsPromise) {
    mappingsPromise = Promise.all([
      prisma.channel.findMany({
        where: { discordRelay: true, discordChannelId: { not: null } },
        select: { id: true, discordChannelId: true },
      }),
      prisma.discordRelayMapping.findMany({
        select: { inGameChannelId: true, discordChannelId: true },
      }),
    ])
      .then(([channels, explicitMappings]) => {
        const map = new Map<string, string>();
        // Channel.discordChannelId entries load first (lower priority)
        for (const ch of channels) {
          if (ch.discordChannelId) map.set(ch.discordChannelId, ch.id);
        }
        // Explicit DiscordRelayMapping entries overwrite if there's a conflict
        for (const row of explicitMappings) {
          map.set(row.discordChannelId, row.inGameChannelId);
        }
        mappingsCache = map;
        mappingsLastLoaded = Date.now();
        return map;
      })
      .finally(() => { mappingsPromise = null; });
  }
  return mappingsPromise;
}

async function getDefaultChannelId(): Promise<string | null> {
  const now = Date.now();
  if (defaultChannelIdCache !== undefined && now - defaultChannelLastLoaded < 5 * 60_000) {
    return defaultChannelIdCache;
  }

  if (!defaultChannelPromise) {
    defaultChannelPromise = prisma.channel.findFirst({
      where: { name: 'General' },
      select: { id: true },
    })
      .then((result) => {
        defaultChannelIdCache = result?.id || null;
        defaultChannelLastLoaded = Date.now();
        return defaultChannelIdCache;
      })
      .finally(() => { defaultChannelPromise = null; });
  }
  return defaultChannelPromise;
}

async function start(onStatusChange?: (status: string) => void): Promise<void> {
  if (!env.DISCORD_TOKEN) {
    logger.warn('DISCORD_TOKEN not set -- Discord bridge disabled');
    return;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates, // temp "join-to-create" voice channels
      GatewayIntentBits.GuildMessageReactions, // reaction roles
    ],
    // Partials let reaction events fire for messages posted before the last
    // restart (uncached) — required for reaction roles to survive a redeploy.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  // Attach feature listeners to this same client — no second login. Their
  // ready/voiceStateUpdate/interactionCreate/messageReaction* handlers register here.
  voiceService.register(discordClient);
  reactionRoleService.register(discordClient);

  // Invalidate the emoji cache whenever the guild's emoji set changes.
  // Lazy-require to avoid circular deps (discordEmojisController imports us too).
  const invalidate = (): void => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { invalidateEmojiCache } = require('../controllers/discordEmojisController') as {
        invalidateEmojiCache: () => void;
      };
      invalidateEmojiCache();
    } catch {
      // Controller not loaded yet — nothing to invalidate
    }
    // Push a refresh signal to every connected client so their emoji picker
    // re-fetches almost immediately when an emoji is added/removed/renamed —
    // instead of waiting out the client-side cache. broadcastFn is injected
    // from the WS handler.
    try {
      broadcastFn?.({ type: 'emojis:updated', payload: { at: new Date().toISOString() } });
    } catch { /* non-fatal */ }
  };
  discordClient.on('emojiCreate', invalidate);
  discordClient.on('emojiDelete', invalidate);
  discordClient.on('emojiUpdate', invalidate);

  discordClient.once('ready', () => {
    discordStatus = 'connected';
    logger.info({ tag: discordClient!.user!.tag }, 'Discord bot ready');
    if (onStatusChange) onStatusChange('connected');
    // Show live WS-connected count in the bot's "Watching ..." status.
    // Refreshes every 60s — well under Discord's presence rate limit (5/20s per
    // session) and responsive enough that the count tracks connects/disconnects
    // without users staring at a stale number for minutes. getClientCount() now
    // filters to OPEN sockets, so each refresh reflects the true live count.
    updatePresence();
    setInterval(updatePresence, 60_000).unref?.();
  });

  discordClient.on('messageCreate', async (msg) => {
    // Ignore bots and webhooks to prevent infinite relay loops
    if (msg.author.bot || msg.webhookId) return;

    // Defense-in-depth: reject messages carrying our ZWS watermark (own relay echo)
    if (msg.content && hasZwsWatermark(msg.content)) return;

    const mappings = await loadRelayMappings().catch(() => new Map<string, string>());
    let channelId = mappings.get(msg.channelId);

    // Fall back to default relay channel from env
    if (!channelId && msg.channelId === env.DISCORD_CHANNEL_ID) {
      channelId = await getDefaultChannelId() || undefined;
    }

    if (!channelId) return;

    // Hard length cap for the bridged channel. Messages of MORE than
    // MAX_RELAY_CHARS characters are deleted and NOT relayed to the in-game
    // overlay — long posts flood the small transparent overlay window and bypass
    // the overlay's own send limit. The author is notified privately by DM.
    // (Discord has NO way to show a channel message visible only to the author
    // for a TYPED message — ephemeral replies exist only for interactions — so a
    // DM is the private notification.) NOTE: deleting requires the bot to have
    // the **Manage Messages** permission in this channel.
    const MAX_RELAY_CHARS = 255;
    if (msg.content && msg.content.length > MAX_RELAY_CHARS) {
      try {
        await msg.delete();
      } catch (err) {
        logger.warn({ err, channelId: msg.channelId }, 'Over-length relay message: delete failed (bot missing Manage Messages?)');
      }
      try {
        await msg.author.send(
          `Your message in the in-game chat channel was too long and was not posted. ` +
          `Please keep it to ${MAX_RELAY_CHARS} characters or fewer (yours was ${msg.content.length}).`,
        );
      } catch (err) {
        logger.warn({ err, userId: msg.author.id }, 'Over-length relay message: DM to author failed (DMs likely closed)');
      }
      return; // never relay an over-length message
    }

    // Per-channel media policy: public/main channels disallow images AND GIFs
    // (parties are NOT Discord-bridged, so this relay code only ever targets main
    // channels). Default to "not allowed" when the channel row can't be read
    // (conservative — matches the toggle's default OFF state).
    let gifsAllowed = false;
    let chRow: { allowGifs: boolean; name: string } | null = null;
    try {
      chRow = await prisma.channel.findUnique({ where: { id: channelId }, select: { allowGifs: true, name: true } });
      gifsAllowed = chRow?.allowGifs ?? false;
    } catch { gifsAllowed = false; }
    // Images are NEVER allowed in the relay for main/public channels.
    const imagesAllowed = false;

    const isGifUrl = (url: string, contentType?: string | null): boolean => {
      if (contentType && contentType.toLowerCase().includes('gif')) return true;
      try {
        const u = new URL(url);
        if (/\.gif(\?|$)/i.test(u.pathname)) return true;
        const host = u.host.toLowerCase();
        return /(^|\.)tenor\.com$/.test(host) || /(^|\.)giphy\.com$/.test(host);
      } catch {
        return /\.gif(\?|$)/i.test(url) || /tenor\.com|giphy\.com/i.test(url);
      }
    };

    const isImageUrl = (url: string, contentType?: string | null): boolean => {
      if (contentType && contentType.toLowerCase().startsWith('image/')) return true;
      try {
        const u = new URL(url);
        return /\.(png|jpe?g|webp|bmp|tiff?|svg|avif|ico)(\?|$)/i.test(u.pathname);
      } catch {
        return /\.(png|jpe?g|webp|bmp|tiff?|svg|avif|ico)(\?|$)/i.test(url);
      }
    };

    // Returns true when a URL should be dropped from the relay (image or GIF
    // in a channel that disallows them).
    const isBlockedMediaUrl = (url: string, contentType?: string | null): boolean => {
      if (!imagesAllowed && (isImageUrl(url, contentType) || isGifUrl(url, contentType))) return true;
      if (!gifsAllowed && isGifUrl(url, contentType)) return true;
      return false;
    };

    // -------------------------------------------------------------------------
    // Feed-channel trim: when the incoming Discord message was posted in the
    // bridged feed channel AND it carries image/GIF attachments or media embeds,
    // delete it from Discord (mirrors the over-length delete pattern). If the
    // message had text alongside the media, keep the text; if it was media-only,
    // DM the author that images/GIFs are party-only.
    // ONLY act in the bridged feed channel (msg.channelId == env.DISCORD_CHANNEL_ID
    // or channels that map to a relay target). Wrapped in try/catch so a missing
    // Manage Messages perm never crashes the handler.
    // -------------------------------------------------------------------------
    const hasBlockedAttachment = [...msg.attachments.values()].some(
      att => att.url && isBlockedMediaUrl(att.url, att.contentType),
    );
    const hasBlockedEmbed = msg.embeds.some(emb => {
      const candidate = emb.image?.url || emb.thumbnail?.url || emb.video?.url || emb.url;
      return candidate ? isBlockedMediaUrl(candidate) : false;
    });
    if (hasBlockedAttachment || hasBlockedEmbed) {
      const textContent = msg.content?.trim() ?? '';
      try {
        await msg.delete();
        logger.info(
          { channelId: msg.channelId, userId: msg.author.id, hasText: !!textContent },
          'Feed-channel trim: deleted message with image/GIF media',
        );
      } catch (err) {
        logger.warn({ err, channelId: msg.channelId }, 'Feed-channel trim: delete failed (bot missing Manage Messages?)');
      }
      if (!textContent) {
        // Media-only — DM the author
        try {
          await msg.author.send(
            'Your message in the in-game chat channel contained an image or GIF and was not posted. ' +
            'Images and GIFs are only available in party chats, not the main channels.',
          );
        } catch (dmErr) {
          logger.warn({ dmErr, userId: msg.author.id }, 'Feed-channel trim: DM to author failed (DMs likely closed)');
        }
        return; // nothing left to relay
      }
      // Text was present — continue relaying the text-only portion (fall through;
      // attachment/embed loops below will skip blocked media naturally).
    }

    // Preserve URLs in the relayed/stored content so the overlay can render
    // them as truncated clickable hyperlinks. Append attachment URLs (images /
    // files) and embed URLs (link previews) that the user shared, so each
    // attached file/link still reaches the chat as a real URL.
    let content = msg.content;
    for (const att of msg.attachments.values()) {
      if (!att.url) continue;
      if (isBlockedMediaUrl(att.url, att.contentType)) continue; // drop image/GIF attachment
      content += (content ? ' ' : '') + att.url;
    }

    // Discord resolves embeds (Tenor / Giphy / YouTube link previews) ASYNCHRONOUSLY
    // — they typically arrive 0.5-2 s AFTER the messageCreate event. If we relay
    // immediately we get the bare page URL (tenor.com/view/...) instead of the
    // resolved media URL (media1.tenor.com/...gif). When a URL is present but no
    // embeds, briefly wait and re-fetch the message so the embed has time to land.
    let embeds: ReadonlyArray<{ url?: string | null; image?: { url?: string | null } | null; video?: { url?: string | null } | null; thumbnail?: { url?: string | null } | null }> = msg.embeds;
    if (embeds.length === 0 && /https?:\/\//i.test(msg.content)) {
      try {
        await new Promise(r => setTimeout(r, 1800));
        const refreshed = await msg.channel.messages.fetch(msg.id);
        if (refreshed.embeds.length > 0) embeds = refreshed.embeds;
      } catch (err) {
        logger.debug({ err }, 'Embed re-fetch failed (non-fatal)');
      }
    }

    for (const emb of embeds) {
      // Pick a URL the overlay can ACTUALLY render. Tenor embeds usually have:
      //   image: null
      //   video: media\d*.tenor.com/{TOKEN}/file.mp4    (SkiaSharp can't decode)
      //   thumbnail: media\d*.tenor.com/{TOKEN}/file.png (often a static PNG,
      //                                                   but Tenor sometimes
      //                                                   serves it as a GIF)
      // The animated GIF lives at a sibling URL with a different format token.
      // Swap the MP4 token's last 4 chars to 'AAAd' and extension to '.gif' to
      // get the animated GIF that SKCodec CAN decode.
      const tenorMp4ToGif = (mp4: string): string | null => {
        const m = mp4.match(/^(https?:\/\/media\d*\.tenor\.com\/)([A-Za-z0-9_-]{12})[A-Za-z0-9_-]{4}\/([^?]+)\.mp4(\?.*)?$/);
        return m ? `${m[1]}${m[2]}AAAd/${m[3]}.gif${m[4] ?? ''}` : null;
      };
      const videoUrl = emb.video?.url ?? undefined;
      const tenorGif = videoUrl ? tenorMp4ToGif(videoUrl) : null;
      const eUrl = emb.image?.url || tenorGif || emb.thumbnail?.url || videoUrl || emb.url;
      if (!eUrl || content.includes(eUrl)) continue;
      // Drop image/GIF embed URLs in main/public channels.
      if (isBlockedMediaUrl(eUrl)) continue;
      content += (content ? ' ' : '') + eUrl;
    }

    // Strip any image/GIF URLs the user typed directly into the message text
    // (e.g. a pasted tenor.com or imgur link) when the destination channel
    // disallows them.
    if (/https?:\/\//i.test(content)) {
      content = content
        .split(/\s+/)
        .filter(tok => !(/^https?:\/\//i.test(tok) && isBlockedMediaUrl(tok)))
        .join(' ');
    }
    if (!content.trim()) return;

    // Resolve Discord user-mention tokens (<@id>) to readable names BEFORE
    // automod / broadcast, so the overlay sees "@FO76Name" or "@DiscordName"
    // instead of the raw snowflake token.
    content = await resolveInboundUserMentions(content, msg);

    if (content.length > 500) content = content.slice(0, 497) + '...';

    const messageId = uuidv4();
    const createdAt = new Date().toISOString();

    // Resolve the display name properly.
    //  • Discord DISPLAY name (server nickname / global name), NOT the @handle.
    //  • If this Discord ID is linked to a website account WITH a real FO76 name,
    //    relay UNDER that account so the user's FO76 name + normal styling show
    //    (and history resolves correctly too). The overlay adds the purple
    //    [Discord] tag from source:'discord'.
    // msg.member (and its server nickname) is often absent from the gateway
    // payload — and we don't run the GuildMembers intent — so the relay was
    // falling through to the @handle (username). Fetch the member over REST
    // (works without the intent) to get the server nickname / display name.
    let relayMember = msg.member;
    if (!relayMember && msg.guild) {
      relayMember = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    }
    const discordDisplay =
      relayMember?.displayName
      ?? (msg.author as { globalName?: string }).globalName
      ?? msg.author.username;

    let relayUserId: string | undefined;
    let relayUsername: string;
    try {
      const linked = await prisma.user.findFirst({
        where: { discordId: msg.author.id },
        select: { id: true, username: true },
      });
      const hasFo76Name =
        !!linked?.username && linked.username !== 'Wanderer' && !linked.username.startsWith('pending-');

      if (linked && hasFo76Name) {
        relayUserId = linked.id;
        relayUsername = linked.username; // FO76 name
      } else {
        // Synthetic Discord-relay user. username = `pending-discord-<id>` so
        // resolveDisplayName() skips it and falls through to discordDisplayName.
        // We now set discordId so a later real install linking this Discord account
        // will merge into this row (via mergeUserInto) rather than orphaning it.
        // Guard: if a canonical row already owns this discordId (e.g. the user just
        // linked from the desktop before their Discord message was processed), prefer
        // that canonical row — don't create a duplicate.
        const canonicalByDiscordId = await prisma.user.findFirst({
          where: { discordId: msg.author.id },
          select: { id: true },
        });
        let synth: { id: string };
        if (canonicalByDiscordId) {
          // A canonical row already claims this discordId — update its display name
          // and use it directly as the relay user so there's no duplicate.
          await prisma.user.update({
            where: { id: canonicalByDiscordId.id },
            data: { discordDisplayName: discordDisplay, discordUsername: msg.author.username },
          });
          synth = { id: canonicalByDiscordId.id };
        } else {
          synth = await prisma.user.upsert({
            where: { installToken: `discord:${msg.author.id}` },
            update: { discordDisplayName: discordDisplay, discordUsername: msg.author.username },
            create: {
              username: `pending-discord-${msg.author.id}`,
              installToken: `discord:${msg.author.id}`,
              discordId: msg.author.id,   // ← set so future install merges into this row
              discordDisplayName: discordDisplay,
              discordUsername: msg.author.username,
            },
            select: { id: true },
          });
        }
        relayUserId = synth.id;
        relayUsername = discordDisplay;
      }
    } catch {
      return;
    }

    if (!relayUserId) return;

    // Run our automod engine on the incoming Discord message before relaying it
    // to the in-game overlay or persisting it. Discord's own AutoMod does NOT
    // scan messages posted by our bot (bot/webhook messages bypass it), and it
    // also doesn't enforce our custom word-filter rules. Any content that would
    // be blocked if typed in-game must also be blocked when bridged from Discord.
    // Uses a lazy require to avoid circular module-load ordering issues.
    try {
      const { engineEvaluate } = require('./autoModEngine') as typeof import('./autoModEngine');
      const discordRelayUser = {
        id: relayUserId,
        username: relayUsername,
        discordUsername: msg.author.username,
        discordId: msg.author.id,
      };
      const engineResult = await engineEvaluate(content, channelId, discordRelayUser);
      if (engineResult.block) {
        logger.info(
          { userId: relayUserId, discordUserId: msg.author.id, channelId },
          '[discord-relay] message blocked by automod engine — not relayed to overlay',
        );
        // Optionally notify the Discord author via DM that their message was blocked.
        try {
          await msg.author.send(
            'Your message in the in-game chat channel was blocked by the content filter and was not posted.',
          );
        } catch {
          // DMs may be closed — non-fatal.
        }
        return;
      }
    } catch (err) {
      // Non-fatal: if the engine errors, log and allow through (fail-open) rather
      // than silently dropping all Discord messages on an engine crash.
      logger.warn({ err }, '[discord-relay] automod engine error — relaying message without filter (fail-open)');
    }

    // ── Inbound wiki URL detection ─────────────────────────────────────────────
    // When a Discord message contains a fallout.fandom.com/wiki/<page> (or
    // fallout.wiki/w/<page>) URL, resolve it against our wiki catalog.  On a hit,
    // attach metadata = { type:'wiki_share', ... } and rewrite the content to
    // "[WIKI] <name>" so the overlay renders the wiki card. Never breaks relay.
    let inboundMetadata: Record<string, unknown> | null = null;
    let broadcastContent = content;
    try {
      const wikiResolved = await resolveWikiUrlFromContent(content);
      if (wikiResolved) {
        const { entry, rawUrl } = wikiResolved;
        inboundMetadata = {
          type: 'wiki_share',
          wikiEntryId: entry.id,
          name: entry.name,
          kind: entry.kind,
          wikiTitle: entry.wikiTitle,
        };
        // Replace the raw URL in content with the "[WIKI] name" token so the
        // overlay card renderer takes over and the bare link isn't shown twice.
        broadcastContent = content.replace(rawUrl, '').replace(/\s{2,}/g, ' ').trim();
        broadcastContent = broadcastContent
          ? `[WIKI] ${entry.name} — ${broadcastContent}`
          : `[WIKI] ${entry.name}`;
      }
    } catch (err) {
      // Non-fatal — relay message normally without wiki metadata
      logger.debug({ err }, '[discord-relay] wiki URL resolution error (non-fatal)');
    }

    if (broadcastFn) {
      broadcastFn({
        type: 'chat:message',
        payload: {
          id: messageId,
          content: broadcastContent,
          username: relayUsername,
          userId: relayUserId,
          channelId,
          source: 'discord',
          timestamp: createdAt,
          metadata: inboundMetadata,
        },
      });
    }

    await messageQueue.add({
      id: messageId,
      content: broadcastContent,
      userId: relayUserId,
      channelId,
      source: 'discord',
      createdAt,
      metadata: inboundMetadata,
    }).catch((err: Error) => logger.error({ err }, 'Failed to queue Discord message'));

  });

  discordClient.on('error', (err: Error) => {
    logger.error({ err }, 'Discord client error');
    discordStatus = 'error';
    if (onStatusChange) onStatusChange('error');
  });

  discordClient.on('shardDisconnect', (closeEvent, shardId) => {
    logger.warn({ code: closeEvent.code, shardId }, 'Discord shard disconnected');
    discordStatus = 'disconnected';
    if (onStatusChange) onStatusChange('disconnected');
  });

  // Bound Discord login by a timeout. If Discord's gateway is unreachable,
  // .login() awaits indefinitely — blocking server.ts startup so server.listen()
  // never fires and the HTTP server never binds the port. Discord's availability
  // must not gate the entire chat platform's availability.
  const LOGIN_TIMEOUT_MS = 15_000;
  try {
    await Promise.race([
      discordClient.login(env.DISCORD_TOKEN),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Discord login timed out after 15s')), LOGIN_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.warn({ err }, 'Discord login failed — continuing startup without Discord (bridge will reconnect via shard events)');
    discordStatus = 'error';
    if (onStatusChange) onStatusChange('error');
    // Do NOT rethrow — let server.ts continue past this await so the HTTP
    // server can bind. discord.js will continue retrying connections in the
    // background via its own reconnect logic.
  }
}

/**
 * Relay an in-game message to Discord.
 * Called from WS chat:send handler when a channel has discord_relay enabled.
 * channelName is prepended as a tag: [ChannelName] **Username**: message
 */
/** Apply the client-supplied {name, discordId} list directly: replace each
 *  `@name` token with `<@discordId>`. Exact name match, case-insensitive,
 *  word-boundary. Beats fuzzy matching because the client knows which names
 *  came from the autocomplete (so they're guaranteed to correspond to a
 *  linked Discord user). Anything left unmatched falls through to
 *  resolveAppMentions for legacy/free-typed @-text. */
function applyExplicitMentions(text: string, mentions?: Array<{ name: string; discordId: string }>): string {
  if (!mentions || mentions.length === 0 || !text.includes('@')) return text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Longest-name first so multi-word names beat prefixes.
  const sorted = [...mentions].filter(m => m.name && m.discordId).sort((a, b) => b.name.length - a.name.length);
  let result = text;
  for (const m of sorted) {
    const re = new RegExp(`(?<![A-Za-z0-9])@${esc(m.name)}(?![A-Za-z0-9])`, 'gi');
    result = result.replace(re, `<@${m.discordId}>`);
  }
  return result;
}

// ── Wiki URL helpers ──────────────────────────────────────────────────────────

const WIKI_FANDOM_BASE = 'https://fallout.fandom.com/wiki/';
const WIKI_FANDOM_ALT_BASE = 'https://fallout.wiki/w/';

/** Build the canonical fandom URL for a wikiTitle (spaces → underscores). */
function wikiUrl(wikiTitle: string): string {
  return WIKI_FANDOM_BASE + encodeURIComponent(wikiTitle.replace(/ /g, '_'));
}

/**
 * Parse a fallout.fandom.com/wiki/<page> or fallout.wiki/w/<page> URL and
 * return the decoded page title (underscores → spaces). Returns null when the
 * URL does not match either pattern.
 */
function parseWikiUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let pagePath: string | null = null;
    if (host === 'fallout.fandom.com' && u.pathname.startsWith('/wiki/')) {
      pagePath = u.pathname.slice('/wiki/'.length);
    } else if (host === 'fallout.wiki' && u.pathname.startsWith('/w/')) {
      pagePath = u.pathname.slice('/w/'.length);
    }
    if (!pagePath) return null;
    return decodeURIComponent(pagePath).replace(/_/g, ' ');
  } catch {
    return null;
  }
}

/**
 * Given a Discord message's text content, find the first fallout wiki URL and
 * resolve it to a wiki catalog entry. Returns the entry + the raw URL matched,
 * or null if no wiki URL is present or resolution fails.
 */
async function resolveWikiUrlFromContent(text: string): Promise<{
  entry: { id: string; name: string; kind: string | null; wikiTitle: string };
  rawUrl: string;
} | null> {
  // Quick rejection before regex work
  if (!/fallout\.(fandom\.com\/wiki|wiki\/w)\//i.test(text)) return null;
  const urlMatch = text.match(/https?:\/\/(fallout\.fandom\.com\/wiki|fallout\.wiki\/w)\/[^\s<>"')]+/i);
  if (!urlMatch) return null;
  const rawUrl = urlMatch[0].replace(/[.,;:!?\]}'"]+$/, ''); // strip trailing punctuation
  const pageTitle = parseWikiUrl(rawUrl);
  if (!pageTitle) return null;

  // Try direct getEntry first; fall back to bestMatch on not-found
  try {
    const entry = await getEntry(pageTitle);
    return { entry: { id: entry.id, name: entry.name, kind: entry.kind, wikiTitle: entry.wikiTitle }, rawUrl };
  } catch (err: any) {
    // getEntry throws a 404-style error when not found — try fuzzy match
    if (err?.status === 404 || err?.message?.includes('404') || err?.statusCode === 404) {
      try {
        const match = await bestMatch(pageTitle);
        if (match) {
          return { entry: { id: match.id, name: match.name, kind: match.kind, wikiTitle: match.wikiTitle }, rawUrl };
        }
      } catch {
        // bestMatch failure — non-fatal
      }
    }
    return null;
  }
}

// ── Outbound relay ────────────────────────────────────────────────────────────

async function relayToDiscord(channelId: string, username: string, content: string, channelName?: string, mentions?: Array<{ name: string; discordId: string }>, metadata?: Record<string, unknown> | null): Promise<void> {
  if (!discordClient || discordStatus !== 'connected') return;

  // Drop synthetic relay health-check probes so test traffic never appears in the
  // public Discord channel. A roundtrip monitor posts a uniquely-tagged
  // `[TEST-ROUNDTRIP-<epoch>]` body (often under a `TestBot<epoch>` name); these
  // are not real community messages and must not be mirrored to Discord.
  if (/^\s*\[TEST-ROUNDTRIP/i.test(content) || /^TestBot\d+$/i.test(username.trim())) {
    return;
  }

  try {
    // ── Wiki share: post the article URL so Discord auto-embeds a card ────────
    // When the overlay sends a wiki_share, the plain-text content is "[WIKI] Name"
    // with no URL — Discord can't embed that. Replace it with the article URL
    // (optionally labelled) so Discord's unfurler generates the preview card.
    let relayContent = content;
    if (metadata?.type === 'wiki_share') {
      try {
        const wikiTitle = metadata.wikiTitle as string | undefined;
        const name = metadata.name as string | undefined;
        if (wikiTitle) {
          const articleUrl = wikiUrl(wikiTitle);
          relayContent = name ? `${name}: ${articleUrl}` : articleUrl;
        }
      } catch {
        // Fall through to normal content relay if anything goes wrong
      }
    }

    // Sanitise: strip raw Discord mention syntax (abuse guard), then convert
    // legitimate in-app @name tokens into real Discord mentions for linked users.
    // Watermark is APPENDED (not inserted at index 1) so it never splits a leading
    // <@id> mention.
    // Explicit client-supplied {name, discordId} pairs win first; whatever's
    // left falls through to resolveAppMentions for free-typed @text.
    const stripped = stripMentions(relayContent);
    const withExplicit = applyExplicitMentions(stripped, mentions);
    const safeContent = markdownifyLinks(await resolveAppMentions(withExplicit));
    const watermarked = safeContent.length > 0 ? safeContent + ZWS : safeContent;
    const tag = channelName ? `**[${channelName}]** ` : '';
    const formatted = `${tag}**${stripMentions(username)}**: ${watermarked}`;

    const mappings = await loadRelayMappings();
    let sent = false;

    // Find discord_channel_id for this in-game channel via explicit mapping
    for (const [discordChannelId, inGameChannelId] of mappings) {
      if (inGameChannelId === channelId) {
        const discordChannel = await discordClient.channels.fetch(discordChannelId);
        if (!discordChannel?.isTextBased()) {
          logger.warn({ discordChannelId }, 'Discord relay channel is not a text channel -- skipping');
        } else {
          outboundQueue.push(async () => { await (discordChannel as TextChannel).send(formatted); });
          startDrain();
          sent = true;
        }
        break;
      }
    }

    // Fall back to the default env channel for any channel without an explicit
    // mapping. Every community channel mirrors to the default Discord channel
    // (tagged with its [name]) unless an admin has configured a per-channel mapping.
    if (!sent && env.DISCORD_CHANNEL_ID) {
      const discordChannel = await discordClient.channels.fetch(env.DISCORD_CHANNEL_ID);
      if (discordChannel?.isTextBased()) {
        outboundQueue.push(async () => { await (discordChannel as TextChannel).send(formatted); });
        startDrain();
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to relay message to Discord');
  }
}

// ── Electron download URL helpers ────────────────────────────────────────────
// Filenames MUST match the electron-builder output (productName "Fallout Chat
// Mod", WITH spaces) and the latest*.yml feed entries. A mismatch serves a 404
// error page → "file corrupted" on install. Exported so the publish pipeline
// can VERIFY both platform downloads exist before announcing (releasesController).
// Human-download ZIP URLs for Discord release announcements (website + Nexus).
// The electron-updater feed reads the raw .exe / .AppImage from latest*.yml —
// these ZIP helpers are for human-facing links only.
export const ELECTRON_BASE = 'https://falloutchatmod.com/downloads/electron';
export function electronWindowsUrl(version: string): string {
  return `${ELECTRON_BASE}/${encodeURIComponent(`Fallout Chat Mod Setup ${version} (Windows).zip`)}`;
}
export function electronLinuxUrl(version: string): string {
  return `${ELECTRON_BASE}/${encodeURIComponent(`Fallout Chat Mod-${version}.AppImage (Linux).zip`)}`;
}

// Discord "Updates" channel — release announcements are posted here.
const UPDATES_CHANNEL_ID = process.env.DISCORD_UPDATES_CHANNEL_ID || '1479531502567166066';

/**
 * Post a release-announcement embed to the Updates channel. THROWS on failure
 * after retries — the release publisher relies on this being mandatory, so
 * silent skips are unacceptable. Retries with backoff to absorb transient
 * Discord-bridge unavailability (the bot may still be connecting when the
 * publish lands).
 */
async function postReleaseAnnouncement(version: string, releaseNotes: string, downloadUrl: string): Promise<void> {
  const attemptDelays = [0, 500, 1500, 3000, 5000]; // 5 tries, ~10s total
  let lastErr: unknown = null;

  for (let i = 0; i < attemptDelays.length; i++) {
    if (attemptDelays[i] > 0) await new Promise((r) => setTimeout(r, attemptDelays[i]));

    if (!discordClient || discordStatus !== 'connected') {
      lastErr = new Error(`Discord bot not connected (status=${discordStatus})`);
      continue;
    }
    try {
      const channel = await discordClient.channels.fetch(UPDATES_CHANNEL_ID);
      if (!channel?.isTextBased()) {
        throw new Error(`Updates channel ${UPDATES_CHANNEL_ID} is not a text channel`);
      }
      const downloadPage = process.env.DOWNLOAD_PAGE_URL || 'https://falloutchatmod.com';
      const embed = new EmbedBuilder()
        .setTitle(`Fallout Chat Mod v${version} is out`)
        .setURL(downloadPage)
        .setColor(0xF1C40F) // gold/yellow — matches the Securitron role color
        .setDescription((releaseNotes || 'A new version is available.').slice(0, 4000))
        .addFields({ name: 'Download', value: `🪟 [Windows](${electronWindowsUrl(version)})  ·  🐧 [Linux (Proton)](${electronLinuxUrl(version)})  ·  [Download page](${downloadPage})` })
        .setTimestamp(new Date());
      await (channel as TextChannel).send({ embeds: [embed] });
      logger.info({ version, channelId: UPDATES_CHANNEL_ID, attempt: i + 1 }, 'Posted release announcement to Discord');
      return; // success
    } catch (err) {
      lastErr = err;
      logger.warn({ err, version, attempt: i + 1 }, 'Release announcement attempt failed; will retry');
    }
  }

  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`postReleaseAnnouncement failed after ${attemptDelays.length} attempts: ${errMsg}`);
}

// ---------------------------------------------------------------------------
// Embed builder support (dashboard "Discord Embeds" feature)
// ---------------------------------------------------------------------------

/** Shape of an embed as configured in the dashboard / stored in discord_embeds.data. */
export interface EmbedData {
  title?: string;
  description?: string;
  url?: string;
  color?: string | number; // hex string ("#18FF62") or int
  authorName?: string;
  authorIconUrl?: string;
  authorUrl?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  footerText?: string;
  footerIconUrl?: string;
  timestamp?: boolean;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  /** Optional plain-text content sent alongside the embed. */
  content?: string;
}

function parseColor(color?: string | number): number | undefined {
  if (color === undefined || color === null || color === '') return undefined;
  if (typeof color === 'number') return color;
  const hex = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return parseInt(hex, 16);
}

/** Build a discord.js EmbedBuilder from stored EmbedData, applying Discord's limits. */
function buildEmbed(data: EmbedData): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (data.title) embed.setTitle(data.title.slice(0, 256));
  if (data.description) embed.setDescription(data.description.slice(0, 4096));
  if (data.url) embed.setURL(data.url);
  const color = parseColor(data.color);
  if (color !== undefined) embed.setColor(color);
  if (data.authorName) {
    embed.setAuthor({
      name: data.authorName.slice(0, 256),
      iconURL: data.authorIconUrl || undefined,
      url: data.authorUrl || undefined,
    });
  }
  if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl);
  if (data.imageUrl) embed.setImage(data.imageUrl);
  if (data.footerText || data.footerIconUrl) {
    embed.setFooter({ text: (data.footerText || '​').slice(0, 2048), iconURL: data.footerIconUrl || undefined });
  }
  if (data.timestamp) embed.setTimestamp(new Date());
  if (Array.isArray(data.fields) && data.fields.length > 0) {
    embed.addFields(
      data.fields
        .filter((f) => f && f.name && f.value)
        .slice(0, 25)
        .map((f) => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024), inline: !!f.inline })),
    );
  }
  return embed;
}

/**
 * Post a dashboard-configured embed to a Discord channel. Throws on failure so the
 * caller (REST controller) can surface the error to the admin.
 */
async function postEmbed(channelId: string, data: EmbedData): Promise<Message> {
  if (!discordClient || discordStatus !== 'connected') {
    throw new Error('Discord bot is not connected');
  }
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel?.isTextBased()) {
    throw new Error('Target channel is not a text channel');
  }
  const message = await (channel as TextChannel).send({
    content: data.content ? data.content.slice(0, 2000) : undefined,
    embeds: [buildEmbed(data)],
  });
  logger.info({ channelId, messageId: message.id }, 'Posted dashboard embed to Discord');
  return message;
}

/**
 * List the roles the bot can actually assign in the configured guild — excludes
 * @everyone, managed/integration roles, and any role at or above the bot's own
 * highest role (Discord won't let it grant those). Used by the reaction-role picker.
 */
async function listAssignableRoles(): Promise<Array<{ id: string; name: string; color: number }>> {
  if (!discordClient || discordStatus !== 'connected') return [];
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) return [];
  try {
    const guild = await discordClient.guilds.fetch(guildId);
    const me = await guild.members.fetchMe();
    const botTop = me.roles.highest.position;
    const roles = await guild.roles.fetch();
    return [...roles.values()]
      .filter((r) => r.id !== guild.id && !r.managed && r.position < botTop)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.color }));
  } catch (err) {
    logger.warn({ err }, 'Failed to list assignable Discord roles');
    return [];
  }
}

/** List the bot's text channels in the configured guild, for the dashboard picker. */
async function listTextChannels(): Promise<Array<{ id: string; name: string }>> {
  if (!discordClient || discordStatus !== 'connected') return [];
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) return [];
  try {
    const guild = await discordClient.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    return [...channels.values()]
      .filter((c): c is TextChannel => !!c && c.isTextBased() && 'name' in c)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    logger.warn({ err }, 'Failed to list Discord text channels');
    return [];
  }
}

/**
 * Returns the raw discord.js Client instance (or null if not yet initialised).
 * Used by discordEmojisController to access guild.emojis.cache without creating
 * a circular import at module-load time.
 */
function getDiscordClient(): import('discord.js').Client | null {
  return discordClient;
}

// Cached mod-log channel ID — refreshed every 60s from moderation_settings.
let modLogChannelIdCache: string | null = null;
let modLogChannelCacheAt = 0;
const MOD_LOG_CHANNEL_DEFAULT = '1509345764654977035'; // #vault-security

async function getModLogChannelId(): Promise<string> {
  if (modLogChannelIdCache && Date.now() - modLogChannelCacheAt < 60_000) return modLogChannelIdCache;
  try {
    const row = await prisma.moderationSetting.findUnique({ where: { key: 'mod_log_channel_id' } });
    modLogChannelIdCache = row?.value || MOD_LOG_CHANNEL_DEFAULT;
  } catch {
    modLogChannelIdCache = MOD_LOG_CHANNEL_DEFAULT;
  }
  modLogChannelCacheAt = Date.now();
  return modLogChannelIdCache;
}

/** Invalidate the mod-log channel ID cache (call after updateSettings saves mod_log_channel_id). */
function invalidateModLogCache(): void {
  modLogChannelIdCache = null;
  modLogChannelCacheAt = 0;
}

/**
 * Post a mod-log alert embed to the configured mod-log Discord channel.
 * Fire-and-forget: errors are warn-logged and NEVER thrown to the caller —
 * alerting must not break a ban, mute, report, or automod action.
 */
async function postModAlert(embed: EmbedData): Promise<void> {
  try {
    const channelId = await getModLogChannelId();
    await postEmbed(channelId, embed);
  } catch (err) {
    logger.warn({ err }, 'postModAlert: failed to post mod-log embed (non-fatal)');
  }
}

/**
 * Set a guild member's server nickname to their FO76 character name.
 *
 * Called from the register controller after a successful username upsert when the
 * user has a linked discordId. Failures are ALWAYS non-fatal: log + return false.
 *
 * Known Discord limits this will encounter (caught + logged, never thrown):
 *   - Bot needs the "Manage Nicknames" permission in the guild.
 *   - Discord forbids changing the nickname of the server OWNER (DiscordAPIError 50013).
 *   - Discord forbids changing members whose top role is >= the bot's top role
 *     (DiscordAPIError 50013 "Missing Permissions" — role hierarchy).
 *   - If nickname is null/empty, the member's nickname is CLEARED (reverts to
 *     their Discord username). We pass the FO76 name, so this is intentional.
 */
async function setMemberNickname(discordId: string, nickname: string): Promise<boolean> {
  if (!discordClient || discordStatus !== 'connected') {
    logger.debug({ discordId }, '[nickname-sync] bot not connected, skipping nickname set');
    return false;
  }
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) {
    logger.debug({ discordId }, '[nickname-sync] DISCORD_SERVER_ID not set, skipping');
    return false;
  }
  try {
    const guild = await discordClient.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordId);
    // Truncate to Discord's 32-char nickname limit.
    const truncated = nickname.slice(0, 32);
    await member.setNickname(truncated, 'FO76 character name sync');
    logger.info({ discordId, nickname: truncated }, '[nickname-sync] set guild member nickname');
    return true;
  } catch (err: any) {
    // 50013 = Missing Permissions (server owner or role hierarchy block).
    const code = err?.code ?? err?.rawError?.code;
    const isHierarchyBlock = code === 50013;
    if (isHierarchyBlock) {
      // Expected for any member who outranks the bot (or is the server owner) —
      // Discord forbids the rename regardless of permissions. Not actionable, so
      // keep it at debug instead of spamming prod logs for every higher-role user.
      logger.debug({ discordId, code }, '[nickname-sync] skipped — member outranks the bot or is the owner (expected)');
    } else {
      logger.warn({ err, discordId, code }, '[nickname-sync] failed to set guild member nickname (non-fatal — check Manage Nicknames permission and role hierarchy)');
    }
    return false;
  }
}

function invalidateRelayMappingsCache(): void {
  mappingsCache = null;
  mappingsLastLoaded = 0;
}

export { start, setBroadcast, getStatus, getDiscordClient, relayToDiscord, invalidateRelayMappingsCache, loadRelayMappings, postReleaseAnnouncement, postEmbed, postModAlert, invalidateModLogCache, getModLogChannelId, listTextChannels, listAssignableRoles, setMemberNickname };
export type { };
module.exports = { start, setBroadcast, getStatus, getDiscordClient, relayToDiscord, invalidateRelayMappingsCache, loadRelayMappings, postReleaseAnnouncement, postEmbed, postModAlert, invalidateModLogCache, getModLogChannelId, listTextChannels, listAssignableRoles, setMemberNickname };
