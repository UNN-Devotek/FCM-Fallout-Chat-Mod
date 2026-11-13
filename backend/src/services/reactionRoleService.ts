import { isPrismaAtomicRefusal, runRequiredBundle, runRequiredEffect, runRequiredMutation } from '../lib/requiredEffects';
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
import { Client, PermissionFlagsBits, type Guild, type MessageReaction, type User, type PartialMessageReaction, type PartialUser, type Message } from 'discord.js';
import env from '../config/environment';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { checkPostingStanding } from './chatPostingGate';

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

export class ReactionRolePanelError extends Error {
  readonly causeClass: string;
  constructor(cause?: unknown) {
    super('Reaction-role panel setup failed');
    this.name = 'ReactionRolePanelError';
    this.causeClass = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

/** A requested panel role that must never be self-assignable. */
export class ReactionRoleNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReactionRoleNotAllowedError';
  }
}

/** Permissions that make a role a staff/moderation role regardless of its name. */
export const DANGEROUS_REACTION_ROLE_PERMISSIONS: ReadonlyArray<readonly [string, bigint]> = [
  ['Administrator', PermissionFlagsBits.Administrator],
  ['Manage Server', PermissionFlagsBits.ManageGuild],
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['Ban Members', PermissionFlagsBits.BanMembers],
  ['Kick Members', PermissionFlagsBits.KickMembers],
  ['Timeout Members', PermissionFlagsBits.ModerateMembers],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
];

/**
 * Configured staff, access-gate and paid-entitlement roles. Each one gates a
 * capability (moderation, developer/QA access, supporter perks), so a
 * reaction panel must never hand it out.
 */
export function protectedReactionRoleIds(): Set<string> {
  return new Set([
    env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID,
    env.DEVELOPER_ROLE_ID, env.PROD_DEVELOPER_ROLE_ID, env.DEV_DEVELOPER_ROLE_ID, env.DEV_QA_ROLE_ID,
    env.SUPPORT_ROLE_ID, env.SUPPORTER_ROLE_ID, env.OVERSEER_CIRCLE_ROLE_ID,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0));
}

export interface ReactionRoleLike {
  id: string;
  name: string;
  position: number;
  managed?: boolean;
  permissions: { has(permission: bigint, checkAdmin?: boolean): boolean };
}

/** Pure policy: why `role` may not be offered on a reaction panel, or null when it may. */
export function reactionRoleRefusal(
  role: ReactionRoleLike | null | undefined,
  ctx: { guildId: string; protectedRoleIds: ReadonlySet<string>; actorHighestPosition?: number | null },
): string | null {
  if (!role) return 'One of the selected roles no longer exists.';
  const label = `The role "${role.name}"`;
  if (role.id === ctx.guildId || role.managed) return `${label} is managed by Discord or an integration and cannot be self-assigned.`;
  if (ctx.protectedRoleIds.has(role.id)) return `${label} is a configured staff, access or supporter role and cannot be offered on a reaction panel.`;
  const dangerous = DANGEROUS_REACTION_ROLE_PERMISSIONS.filter(([, bit]) => role.permissions.has(bit, true)).map(([name]) => name);
  if (dangerous.length > 0) return `${label} grants moderation permissions (${dangerous.join(', ')}) and cannot be offered on a reaction panel.`;
  if (ctx.actorHighestPosition != null && role.position >= ctx.actorHighestPosition) {
    return `${label} is at or above your highest Discord role and cannot be offered on a reaction panel.`;
  }
  return null;
}

/**
 * Check every requested role against the policy. `actorDiscordId` adds the
 * hierarchy rule for the moderator creating the panel; the guild owner has no
 * ceiling. Returns the first refusal, or null.
 */
export async function checkPanelRoles(guild: Guild, roleIds: string[], actorDiscordId?: string | null): Promise<string | null> {
  let actorHighestPosition: number | null = null;
  if (actorDiscordId && guild.ownerId !== actorDiscordId) {
    const member = await guild.members.fetch(actorDiscordId).catch(() => null);
    if (!member) return 'Your Discord account is not a member of this server, so reaction roles cannot be checked against your roles.';
    actorHighestPosition = member.roles.highest.position;
  }
  const protectedRoleIds = protectedReactionRoleIds();
  for (const roleId of new Set(roleIds)) {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    const refusal = reactionRoleRefusal(role, { guildId: guild.id, protectedRoleIds, actorHighestPosition });
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Pre-post validation for a new panel in `channelId`, run before the embed is
 * posted so a refused role never leaves an orphan message. Throws
 * ReactionRoleNotAllowedError with a user-facing reason.
 */
export async function assertPanelRolesAllowed(channelId: string, roleIds: string[], actorUserId?: string | null): Promise<void> {
  if (roleIds.length === 0) return;
  const channel = await clientRef?.channels.fetch(channelId).catch(() => null);
  const guild = channel && 'guild' in channel ? (channel.guild as Guild | undefined) : undefined;
  if (!guild) throw new ReactionRoleNotAllowedError('Reaction roles can only be added in a server channel the bot can see.');
  const actor = actorUserId
    ? await prisma.user.findUnique({ where: { id: actorUserId }, select: { discordId: true } }).catch(() => null)
    : null;
  const refusal = await checkPanelRoles(guild, roleIds, actor?.discordId ?? null);
  if (refusal) throw new ReactionRoleNotAllowedError(refusal);
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
  return runRequiredBundle('moderation', 'reactionRoleService:abd2039cd3f6', async () => {
  if (!message.guildId) throw new Error('Reaction-role panels must be in a guild channel');
  if (mappings.length === 0) throw new ReactionRolePanelError(new TypeError('No reaction mappings'));
  // Defense in depth for callers that skip the pre-post check: never persist a
  // panel that offers a staff, gated or moderation-permission role.
  if (!message.guild) throw new ReactionRolePanelError(new ReactionRoleNotAllowedError('Reaction-role panels must be in a guild channel'));
  const refusal = await checkPanelRoles(message.guild, mappings.map((m) => m.roleId));
  if (refusal) throw new ReactionRolePanelError(new ReactionRoleNotAllowedError(refusal));
  const record: PanelRecord = { channelId: message.channelId, guildId: message.guildId, mappings };

  await runRequiredMutation('moderation', '9da83c19ca6a688270e702a7', { stage: 'primary-write-unconfirmed', channelId: record.channelId }, () => prisma.reactionRolePanel.upsert({
    where: { messageId: message.id },
    update: { channelId: record.channelId, guildId: record.guildId, mappings: mappings as any },
    create: { messageId: message.id, channelId: record.channelId, guildId: record.guildId, mappings: mappings as any },
  }), isPrismaAtomicRefusal, undefined, undefined);
  panels.set(message.id, record);

  try {
    // Discord's reaction endpoint is authoritative for Unicode validity and for
    // custom emoji deletion/availability races after the context lookup.
    for (const m of mappings) await message.react(m.reactValue);
  } catch (error) {
    panels.delete(message.id);
    await runRequiredEffect('reaction-role:rollback', { messageId: message.id, stage: 'panel-rollback-delete-unconfirmed' }, () => prisma.reactionRolePanel.deleteMany({ where: { messageId: message.id } })).catch(() => undefined);
    await runRequiredEffect('reaction-role:rollback-reactions', { messageId: message.id, stage: 'panel-reaction-cleanup-unconfirmed' }, () => message.reactions.removeAll()).catch(() => undefined);
    logger.warn({ messageId: message.id, causeClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'reaction-role: strict panel creation rolled back');
    throw new ReactionRolePanelError(error);
  }
  logger.info({ messageId: message.id, count: mappings.length }, 'reaction-role: panel created');

  });
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
  return runRequiredBundle('moderation', 'reactionRoleService:18300c42fedf', async () => {
  const existing = await prisma.reactionRolePanel.findUnique({ where: { messageId } });
  if (!existing) return false;
  await runRequiredMutation('moderation', 'c4ec03336dfa0fe587942f57', { stage: 'primary-write-unconfirmed' }, () => prisma.reactionRolePanel.delete({ where: { messageId } }), isPrismaAtomicRefusal, undefined, undefined);
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

  });
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

// Reactions the bot itself removed after refusing a claim. Discord echoes that
// removal as messageReactionRemove; it must not strip a role the member
// already held (e.g. a supporter clicking a refused panel entry).
const BOT_REMOVAL_TTL_MS = 60_000;
const botRemovedReactions = new Map<string, number>();
function botRemovalKey(messageId: string, userId: string, matchKey: string): string {
  return `${messageId}:${userId}:${matchKey}`;
}
/** True (once) when this removal was the bot undoing a refused claim. */
export function consumeBotReactionRemoval(messageId: string, userId: string, matchKey: string, now = Date.now()): boolean {
  for (const [k, at] of botRemovedReactions) if (now - at > BOT_REMOVAL_TTL_MS) botRemovedReactions.delete(k);
  const key = botRemovalKey(messageId, userId, matchKey);
  if (!botRemovedReactions.has(key)) return false;
  botRemovedReactions.delete(key);
  return true;
}
export function noteBotReactionRemoval(messageId: string, userId: string, matchKey: string, now = Date.now()): void {
  botRemovedReactions.set(botRemovalKey(messageId, userId, matchKey), now);
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
    // Click-time policy: panels created before the role policy existed, or
    // whose role gained permissions later, must still not grant staff roles;
    // and an FCM-banned player must not reclaim roles stripped by the ban.
    const refusal = await reactionClaimRefusal(guild, mapping.roleId, resolved.u.id);
    if (refusal) {
      logger.warn({ userId: resolved.u.id, roleId: mapping.roleId, refusal }, 'reaction-role: claim refused');
      noteBotReactionRemoval(reaction.message.id, resolved.u.id, mapping.matchKey);
      await resolved.r.users.remove(resolved.u.id).catch(() => undefined);
      return;
    }
    const member = await guild.members.fetch(resolved.u.id);
    await member.roles.add(mapping.roleId, 'Reaction role');
    logger.info({ userId: resolved.u.id, roleId: mapping.roleId }, 'reaction-role: granted role');
  } catch (err) {
    logger.warn({ err, roleId: mapping.roleId }, 'reaction-role: failed to grant role (check Manage Roles + hierarchy)');
  }
}

/** Why a member's reaction may not grant `roleId` right now, or null. */
export async function reactionClaimRefusal(guild: Guild, roleId: string, discordUserId: string): Promise<string | null> {
  const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
  const roleRefusal = reactionRoleRefusal(role, { guildId: guild.id, protectedRoleIds: protectedReactionRoleIds() });
  if (roleRefusal) return roleRefusal;
  const standing = await checkPostingStanding({ discordId: discordUserId });
  // Bans block claims; a failed lookup also fails closed. Mutes and kick
  // cooldowns restrict chat only, not cosmetic/notification roles.
  if (standing && (standing.reason === 'banned' || standing.reason === 'unavailable')) return `FCM standing: ${standing.reason}`;
  return null;
}

async function onRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (user.bot) return;
  const panel = await getPanel(reaction.message.id);
  if (!panel) return;
  const resolved = await resolveFull(reaction, user);
  if (!resolved) return;
  const mapping = panel.mappings.find((m) => m.matchKey === emojiKey(resolved.r));
  if (!mapping) return;
  if (consumeBotReactionRemoval(reaction.message.id, resolved.u.id, mapping.matchKey)) return;
  try {
    const guild = await clientRef!.guilds.fetch(panel.guildId);
    // A panel never manages a protected/staff role, in either direction.
    const role = guild.roles.cache.get(mapping.roleId) ?? await guild.roles.fetch(mapping.roleId).catch(() => null);
    if (reactionRoleRefusal(role, { guildId: guild.id, protectedRoleIds: protectedReactionRoleIds() })) {
      logger.warn({ userId: resolved.u.id, roleId: mapping.roleId }, 'reaction-role: refusing to remove a protected role');
      return;
    }
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

export default { register, createPanel, listPanels, deletePanel, buildMappings, parseEmoji, assertPanelRolesAllowed };
module.exports = {
  register, createPanel, listPanels, deletePanel, buildMappings, parseEmoji, assertPanelRolesAllowed,
  checkPanelRoles, reactionRoleRefusal, reactionClaimRefusal, protectedReactionRoleIds,
  DANGEROUS_REACTION_ROLE_PERMISSIONS, ReactionRolePanelError, ReactionRoleNotAllowedError,
};
