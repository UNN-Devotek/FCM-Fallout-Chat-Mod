/**
 * Reaction roles. A bot-posted message ("panel") has one or more emoji→role
 * mappings. Reacting with a mapped emoji grants the role; removing the reaction
 * removes it (toggle mode, same as Carl-bot / MEE6 defaults).
 *
 * Requires the GuildMessageReactions intent + Message/Channel/Reaction partials
 * (added in discordService.ts) so reactions on messages posted before the last
 * restart still fire events. The bot needs Manage Roles, and its highest role
 * must sit ABOVE every role it hands out (Discord hierarchy rule).
 *
 * Attached to the shared discord.js client via register() — no second login.
 */
import { Client, type MessageReaction, type User, type PartialMessageReaction, type PartialUser, type Message } from 'discord.js';
import prisma from '../config/prisma';
import logger from '../config/logger';

export interface ReactionRoleInput {
  /** Unicode char (🎮) or custom emoji in <:name:id> / name:id form.
   *  When customEmojiId is provided this field holds just the emoji name
   *  (used to build the reactValue); it may also be empty — customEmojiId
   *  takes precedence. */
  emoji: string;
  roleId: string;
  /** Discord snowflake for a custom server emoji. When present, matchKey is
   *  set to this id and reactValue is built as `name:id`. */
  customEmojiId?: string;
  /** Whether the custom emoji is animated (gif). Used to build the display
   *  emoji string stored in the mapping for UI rendering. */
  animated?: boolean;
}
interface ReactionRoleMapping {
  emoji: string;
  matchKey: string; // custom emoji id, or the unicode char — matched against reaction events
  reactValue: string; // value passed to message.react()
  roleId: string;
  roleName?: string;
}
interface PanelRecord {
  channelId: string;
  guildId: string;
  mappings: ReactionRoleMapping[];
}

const CUSTOM_RE = /^<a?:(\w+):(\d+)>$|^(\w+):(\d+)$/;

/** Normalize a raw emoji string into a match key + a value usable by message.react(). */
export function parseEmoji(input: string): { matchKey: string; reactValue: string } {
  const raw = (input || '').trim();
  const m = raw.match(CUSTOM_RE);
  if (m) {
    const name = m[1] ?? m[3];
    const id = m[2] ?? m[4];
    return { matchKey: id, reactValue: `${name}:${id}` };
  }
  return { matchKey: raw, reactValue: raw };
}

/** Build stored mappings (with role names resolved) from raw {emoji, roleId} input. */
export function buildMappings(client: Client, guildId: string, input: ReactionRoleInput[]): ReactionRoleMapping[] {
  const guild = client.guilds.cache.get(guildId);
  return input
    .filter((m) => (m.emoji && m.roleId) || (m.customEmojiId && m.roleId))
    .map((m) => {
      // When customEmojiId is explicitly provided, use it directly to avoid
      // any ambiguity from the emoji string (which may be a bare name without
      // the <:name:id> wrapper when sent from the dashboard custom-emoji flow).
      if (m.customEmojiId) {
        const emojiName = m.emoji.trim() || 'emoji';
        const reactValue = `${emojiName}:${m.customEmojiId}`;
        const displayEmoji = m.animated
          ? `<a:${emojiName}:${m.customEmojiId}>`
          : `<:${emojiName}:${m.customEmojiId}>`;
        return {
          emoji: displayEmoji,
          matchKey: m.customEmojiId,
          reactValue,
          roleId: m.roleId,
          roleName: guild?.roles.cache.get(m.roleId)?.name,
        };
      }
      const { matchKey, reactValue } = parseEmoji(m.emoji);
      return {
        emoji: m.emoji.trim(),
        matchKey,
        reactValue,
        roleId: m.roleId,
        roleName: guild?.roles.cache.get(m.roleId)?.name,
      };
    });
}

// In-memory cache of panels, keyed by messageId. Hydrated lazily + on startup.
const panels = new Map<string, PanelRecord>();
let clientRef: Client | null = null;

/**
 * Register a new panel: persist it, cache it, and add the configured reactions to
 * the already-posted message so users have something to click.
 */
export async function createPanel(message: Message, mappings: ReactionRoleMapping[]): Promise<void> {
  if (!message.guildId) throw new Error('Reaction-role panels must be in a guild channel');
  const record: PanelRecord = { channelId: message.channelId, guildId: message.guildId, mappings };

  await prisma.reactionRolePanel.upsert({
    where: { messageId: message.id },
    update: { channelId: record.channelId, guildId: record.guildId, mappings: mappings as any },
    create: { messageId: message.id, channelId: record.channelId, guildId: record.guildId, mappings: mappings as any },
  });
  panels.set(message.id, record);

  for (const m of mappings) {
    await message.react(m.reactValue).catch((err) =>
      logger.warn({ err, emoji: m.emoji, messageId: message.id }, 'reaction-role: failed to add reaction'),
    );
  }
  logger.info({ messageId: message.id, count: mappings.length }, 'reaction-role: panel created');
}

export async function listPanels(): Promise<Array<{ messageId: string; channelId: string; guildId: string; mappings: ReactionRoleMapping[]; createdAt: Date }>> {
  const rows = await prisma.reactionRolePanel.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({
    messageId: r.messageId,
    channelId: r.channelId,
    guildId: r.guildId,
    mappings: (r.mappings as unknown as ReactionRoleMapping[]) ?? [],
    createdAt: r.createdAt,
  }));
}

/** Delete a panel mapping. Best-effort: also clears the bot's reactions on the message. */
export async function deletePanel(messageId: string): Promise<boolean> {
  const existing = await prisma.reactionRolePanel.findUnique({ where: { messageId } });
  if (!existing) return false;
  await prisma.reactionRolePanel.delete({ where: { messageId } });
  const cached = panels.get(messageId);
  panels.delete(messageId);
  // Try to remove the reactions so the message no longer invites clicks.
  try {
    const channelId = cached?.channelId ?? existing.channelId;
    const channel = await clientRef?.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const msg = await (channel as any).messages.fetch(messageId).catch(() => null);
      await msg?.reactions?.removeAll().catch(() => {});
    }
  } catch { /* non-fatal */ }
  return true;
}

async function getPanel(messageId: string): Promise<PanelRecord | null> {
  if (panels.has(messageId)) return panels.get(messageId)!;
  const row = await prisma.reactionRolePanel.findUnique({ where: { messageId } });
  if (!row) return null;
  const record: PanelRecord = {
    channelId: row.channelId,
    guildId: row.guildId,
    mappings: (row.mappings as unknown as ReactionRoleMapping[]) ?? [],
  };
  panels.set(messageId, record);
  return record;
}

function emojiKey(reaction: MessageReaction | PartialMessageReaction): string {
  return reaction.emoji.id ?? reaction.emoji.name ?? '';
}

async function resolveFull(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<{ r: MessageReaction; u: User } | null> {
  try {
    const r = reaction.partial ? await reaction.fetch() : (reaction as MessageReaction);
    const u = user.partial ? await user.fetch() : (user as User);
    return { r, u };
  } catch (err) {
    logger.warn({ err }, 'reaction-role: failed to resolve partial');
    return null;
  }
}

async function onAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (user.bot) return;
  const panel = await getPanel(reaction.message.id);
  if (!panel) return;
  const resolved = await resolveFull(reaction, user);
  if (!resolved) return;
  const mapping = panel.mappings.find((m) => m.matchKey === emojiKey(resolved.r));
  if (!mapping) return;
  try {
    const guild = await clientRef!.guilds.fetch(panel.guildId);
    const member = await guild.members.fetch(resolved.u.id);
    await member.roles.add(mapping.roleId, 'Reaction role');
    logger.info({ userId: resolved.u.id, roleId: mapping.roleId }, 'reaction-role: granted role');
  } catch (err) {
    logger.warn({ err, roleId: mapping.roleId }, 'reaction-role: failed to grant role (check Manage Roles + hierarchy)');
  }
}

async function onRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (user.bot) return;
  const panel = await getPanel(reaction.message.id);
  if (!panel) return;
  const resolved = await resolveFull(reaction, user);
  if (!resolved) return;
  const mapping = panel.mappings.find((m) => m.matchKey === emojiKey(resolved.r));
  if (!mapping) return;
  try {
    const guild = await clientRef!.guilds.fetch(panel.guildId);
    const member = await guild.members.fetch(resolved.u.id);
    await member.roles.remove(mapping.roleId, 'Reaction role removed');
    logger.info({ userId: resolved.u.id, roleId: mapping.roleId }, 'reaction-role: removed role');
  } catch (err) {
    logger.warn({ err, roleId: mapping.roleId }, 'reaction-role: failed to remove role');
  }
}

export function register(client: Client): void {
  clientRef = client;
  client.on('messageReactionAdd', (r, u) => void onAdd(r, u));
  client.on('messageReactionRemove', (r, u) => void onRemove(r, u));
  client.once('ready', async () => {
    // Warm the cache so reactions on pre-restart messages resolve without a DB hit.
    try {
      const rows = await prisma.reactionRolePanel.findMany();
      for (const row of rows) {
        panels.set(row.messageId, {
          channelId: row.channelId,
          guildId: row.guildId,
          mappings: (row.mappings as unknown as ReactionRoleMapping[]) ?? [],
        });
      }
      logger.info({ panels: panels.size }, 'reaction-role: cache hydrated');
    } catch (err) {
      logger.warn({ err }, 'reaction-role: failed to hydrate cache');
    }
  });
  logger.info('reaction-role: service registered');
}

export default { register, createPanel, listPanels, deletePanel, buildMappings, parseEmoji };
module.exports = { register, createPanel, listPanels, deletePanel, buildMappings, parseEmoji };
