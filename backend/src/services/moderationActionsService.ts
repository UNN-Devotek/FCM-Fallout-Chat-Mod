import { createRequiredAudit, isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredLookup, runRequiredEffect, runRequiredMutation } from '../lib/requiredEffects';
/**
 * Core moderation actions: kick, mute, unmute, ban, reverseBan.
 *
 * Each action:
 *   1. Mutates DB state (User flags + history rows)
 *   2. Mirrors to live WS (disconnect, mute-flag flip)
 *   3. Propagates to Discord where applicable (timeouts)
 *   4. Writes an audit_log row
 *   5. Posts a staff-only Vault Security (mod-log) embed for the action
 *
 * The WS guards consume this state; the REST controller drives this service.
 */
import prisma from '../config/prisma';
import logger from '../config/logger';
import env from '../config/environment';
import { broadcastMessageDeletion, markClientMuted, notifyAndDisconnect } from '../websocket/handlers';
import { getDiscordClient, postModAlert } from './discordService';
import { resolveTargetProtection } from './userRoleService';
import { ModerationError, ProtectedTargetError } from './moderationErrors';
import { isValidSteamId } from './steamAuthService';
import { Prisma } from '@prisma/client';
import { DISPLAY_NAME_SELECT, resolveUserDisplayName } from '../utils/userDisplayName';
import { revokeTokensForLinkedUser } from './relay/tokenService';
import type { GuildMember } from 'discord.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const KICK_COOLDOWN_MS = 5 * 60 * 1000;        // 5 min
const MAX_MUTE_MS      = 30 * 24 * 60 * 60 * 1000; // 30 d (hard cap)
const DISCORD_TIMEOUT_CAP_MS = 28 * 24 * 60 * 60 * 1000; // Discord API ceiling
const WS_CLOSE_BANNED = 4002;
/** Lazily-expired temp bans newer than this still get their roles restored by the sweep. */
const ORPHAN_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function evictRelaySessions(targetId: string, reason: 'banned' | 'kicked'): Promise<void> {
  try {
    // Keep this import dynamic: relayHandler dispatches moderationAction through
    // this service, so a static import would create a module initialization cycle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const relay = require('./relay/relayHandler') as {
      evictRelayUser?: (linkedUserId: string, options: { code: string; message: string }) => Promise<number>;
    };
    const evict = relay.evictRelayUser;
    if (typeof evict === 'function') {
      await runRequiredEffect('moderation:relay-evict', { targetId, stage: 'relay-eviction-unconfirmed' }, () => evict(targetId, {
        code: reason === 'banned' ? 'user_banned' : 'user_kicked',
        message: reason === 'banned' ? 'This account is banned' : 'This account is temporarily kicked',
      }));
    }
  } catch (err) {
    // The primary account-state write and the main /ws eviction remain valid if
    // the optional relay eviction path is unavailable during startup/shutdown.
    logger.warn({ err, targetId, reason }, 'failed to evict relay sessions');
  }
}

// ── Categories (kept loose; UI enforces, server only checks "present") ───────
export const REASON_CATEGORIES = [
  'Harassment', 'HateSpeech', 'Spam', 'Cheating', 'NSFW', 'Threats', 'Doxxing', 'Other',
] as const;
export type ReasonCategory = typeof REASON_CATEGORIES[number];

// Stable error codes live in moderationErrors.ts; re-exported for callers
// that already import them from this service.
export { ModerationError, ProtectedTargetError } from './moderationErrors';
export type { ModerationErrorCode } from './moderationErrors';

// ── Helpers ───────────────────────────────────────────────────────────────────
async function audit(actorId: string | null, action: string, targetId: string, reason: string, metadata?: unknown): Promise<void> {
  await createRequiredAudit(prisma.auditLog, {
    data: {
      actorId,
      action,
      targetType: 'user',
      targetId,
      reason,
      metadata: metadata as any,
    },
  }).catch((err) => logger.warn({ err, action }, 'audit log write failed'));
}

/**
 * Refuse the action when the target is staff. Fails CLOSED: if the role
 * lookup itself fails (DB/Redis hiccup) the action is refused with
 * ProtectionCheckFailed rather than treating the target as a normal user.
 */
async function ensureNotProtected(targetId: string): Promise<void> {
  let protection: Awaited<ReturnType<typeof resolveTargetProtection>>;
  try {
    protection = await resolveTargetProtection(targetId);
  } catch (err) {
    logger.warn({ err, targetId }, 'protected-target lookup failed — refusing moderation action');
    throw new ModerationError('ProtectionCheckFailed', 'Could not verify that the target is not staff; try again shortly');
  }
  if (!protection.found) throw new ModerationError('TargetNotFound', 'Target user not found');
  if (protection.role) throw new ProtectedTargetError(protection.role);
}

/** An unreversed ban that is permanent or has not yet expired. */
function activeBanWhere(now: Date): Prisma.BanWhereInput {
  return { reversedAt: null, OR: [{ bannedUntil: null }, { bannedUntil: { gt: now } }] };
}

function savedRolesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Provider identities (Discord, Steam, Nexus/other linked) currently owned by a user. */
async function providerIdentitiesOf(userId: string): Promise<Array<{ provider: string; providerUid: string }>> {
  const [u, linked] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { discordId: true, steamId: true } }),
    prisma.linkedIdentity.findMany({ where: { userId }, select: { provider: true, providerUid: true } }),
  ]);
  const out: Array<{ provider: string; providerUid: string }> = [];
  if (u?.discordId) out.push({ provider: 'discord', providerUid: u.discordId });
  if (u?.steamId && isValidSteamId(u.steamId)) out.push({ provider: 'steam', providerUid: u.steamId });
  for (const l of linked) {
    if (l.provider && l.providerUid && !out.some((o) => o.provider === l.provider && o.providerUid === l.providerUid)) {
      out.push({ provider: l.provider, providerUid: l.providerUid });
    }
  }
  return out;
}

function denyListReason(banId: string, category: string): string {
  return `ban:${banId} ${category}`.slice(0, 500);
}

/**
 * Permanent ban: deny-list every provider identity the target owns so the same
 * Discord/Steam/Nexus account cannot be re-linked to a fresh FCM account
 * (read by isBannedIdentity at the OAuth/link gates). Best-effort: the
 * account-level ban still stands if this fails. Returns the count written.
 */
async function denyListIdentities(targetId: string, banId: string, category: string): Promise<number> {
  try {
    const identities = await providerIdentitiesOf(targetId);
    const reason = denyListReason(banId, category);
    for (const id of identities) {
      await runRequiredEffect('moderation:identity-deny-list', { targetId, banId, provider: id.provider, stage: 'permanent-ban-identity-deny-list-unconfirmed' }, () => prisma.bannedIdentity.upsert({
        where: { provider_providerUid: { provider: id.provider, providerUid: id.providerUid } },
        update: { reason },
        create: { provider: id.provider, providerUid: id.providerUid, reason },
      }));
    }
    return identities.length;
  } catch (err) {
    logger.warn({ err, targetId, banId }, 'failed to deny-list provider identities on permanent ban');
    return 0;
  }
}

/** Remove the deny-list rows written for this ban / owned by this user. */
async function liftIdentityDenyList(userId: string, banId: string): Promise<void> {
  try {
    const identities = await providerIdentitiesOf(userId);
    await runRequiredEffect('moderation:identity-deny-list-lift', { userId, banId, stage: 'ban-reversal-identity-deny-list-unconfirmed' }, () => prisma.bannedIdentity.deleteMany({
      where: { OR: [
        { reason: { startsWith: `ban:${banId}` } },
        ...identities.map((i) => ({ provider: i.provider, providerUid: i.providerUid })),
      ] },
    }), undefined, undefined, isRowCountNoChange);
  } catch (err) {
    logger.warn({ err, userId, banId }, 'failed to lift provider identity deny-list on ban reversal');
  }
}

async function applyDiscordTimeout(discordId: string | null, ms: number, reason: string): Promise<boolean> {
  if (!discordId) return false;
  const client = getDiscordClient();
  if (!client) { logger.warn('Discord client not connected — skipping timeout'); return false; }
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) return false;
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return false;
    const clamped = Math.min(ms, DISCORD_TIMEOUT_CAP_MS);
    await member.timeout(clamped, reason.slice(0, 512));
    return true;
  } catch (err) {
    logger.warn({ err, discordId }, 'failed to apply Discord timeout (bot perms / hierarchy?)');
    return false;
  }
}

async function applyDiscordKick(discordId: string | null, reason: string): Promise<{ applied: boolean; warning?: string }> {
  if (!discordId) return { applied: false, warning: 'Target has no linked Discord account' };
  const client = getDiscordClient();
  if (!client) return { applied: false, warning: 'Discord bot not connected' };
  if (!env.DISCORD_SERVER_ID) return { applied: false, warning: 'DISCORD_SERVER_ID not configured' };
  try {
    const guild = await client.guilds.fetch(env.DISCORD_SERVER_ID);
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return { applied: false, warning: 'Target is not in the Discord guild' };
    await member.kick(reason.slice(0, 512));
    return { applied: true };
  } catch (err: any) {
    logger.warn({ err, discordId }, 'failed to kick Discord member');
    return { applied: false, warning: `Discord kick failed: ${err?.message ?? 'unknown'} (check Kick Members permission and role hierarchy)` };
  }
}

export interface DiscordLockdownResult {
  /** Discord role IDs stripped from the target (caller persists for unban-restore). */
  stripped: string[];
  /** Whether voice disconnect succeeded (true if not in voice). */
  voiceDisconnected: boolean;
  /** Permanent guild ban applied (only set when isPermanent=true; null when n/a). */
  guildBanApplied: boolean | null;
  /** Non-fatal warnings the controller can surface to the dashboard. */
  warnings: string[];
}

/**
 * On ban: save the user's current Discord role IDs, strip every assignable role,
 * disconnect from voice. For permanent bans, also apply a guild-level ban.
 * Temporary bans never guild-ban: a guild ban removes the member from the
 * server, so the expiry sweep could not restore the stripped roles.
 * Returns a structured result so the controller can surface partial failures
 * (e.g. "guild ban skipped — bot lacks Ban Members perm") to the dashboard
 * instead of pretending everything worked.
 */
async function applyDiscordBanLockdown(discordId: string | null, isPermanent: boolean, reason: string): Promise<DiscordLockdownResult> {
  const result: DiscordLockdownResult = { stripped: [], voiceDisconnected: true, guildBanApplied: isPermanent ? false : null, warnings: [] };
  if (!discordId) { result.warnings.push('Target has no linked Discord account — overlay-only ban'); return result; }
  const client = getDiscordClient();
  if (!client) { result.warnings.push('Discord bot not connected — no Discord propagation'); return result; }
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) { result.warnings.push('DISCORD_SERVER_ID not configured'); return result; }
  try {
    const guild = await client.guilds.fetch(guildId);
    const me = await guild.members.fetchMe();
    const member: GuildMember | null = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      result.warnings.push('Target is not in the Discord guild');
      if (isPermanent) {
        try {
          await guild.bans.create(discordId, { reason: reason.slice(0, 512) });
          result.guildBanApplied = true;
        } catch (err: any) {
          result.warnings.push(`Permanent guild ban failed: ${err?.message ?? 'unknown'}`);
        }
      }
      return result;
    }
    // Save and strip every role we can manage (below our highest, not @everyone, not managed)
    const botTop = me.roles.highest.position;
    const stripped: string[] = [];
    const skippedAbove: string[] = [];
    for (const role of member.roles.cache.values()) {
      if (role.id === guild.id) continue; // @everyone
      if (role.managed) continue;          // managed by integrations
      if (role.position >= botTop) { skippedAbove.push(role.name); continue; }
      stripped.push(role.id);
    }
    if (skippedAbove.length > 0) {
      result.warnings.push(`Could not strip ${skippedAbove.length} role(s) above bot's top role: ${skippedAbove.slice(0, 5).join(', ')}`);
    }
    if (stripped.length > 0) {
      try {
        await member.roles.remove(stripped, `Ban: ${reason}`.slice(0, 512));
      } catch (err: any) {
        result.warnings.push(`Role strip failed: ${err?.message ?? 'unknown'} (check bot Manage Roles permission)`);
        logger.warn({ err, discordId }, 'failed to strip Discord roles');
      }
    }
    result.stripped = stripped;
    // Disconnect from voice if connected
    if (member.voice.channelId) {
      try {
        await member.voice.disconnect(`Ban: ${reason}`.slice(0, 512));
      } catch (err: any) {
        result.voiceDisconnected = false;
        result.warnings.push(`Voice disconnect failed: ${err?.message ?? 'unknown'}`);
      }
    }
    // Permanent guild ban
    if (isPermanent) {
      try {
        await guild.bans.create(discordId, { reason: reason.slice(0, 512), deleteMessageSeconds: 0 });
        result.guildBanApplied = true;
      } catch (err: any) {
        result.warnings.push(`Permanent guild ban failed: ${err?.message ?? 'unknown'} (check bot Ban Members permission)`);
        logger.warn({ err, discordId }, 'failed to apply permanent guild ban');
      }
    }
    return result;
  } catch (err: any) {
    logger.warn({ err, discordId }, 'applyDiscordBanLockdown failed');
    result.warnings.push(`Discord propagation failed: ${err?.message ?? 'unknown'}`);
    return result;
  }
}

/** On unban: restore previously-stripped roles + lift permanent guild ban if present. */
/**
 * True when the guild ban on record was placed by FCM for this user (FCM bans
 * with the ban's reason text, truncated to 512). A guild ban some other
 * moderator placed for Discord conduct must survive an FCM ban ending.
 */
async function isFcmPlacedGuildBan(userId: string, guildBanReason: string | null | undefined): Promise<boolean> {
  const reason = guildBanReason?.trim();
  if (!reason) return false;
  const match = await prisma.ban.findFirst({ where: { userId, reasonText: { startsWith: reason } }, select: { id: true } }).catch(() => null);
  return Boolean(match);
}

async function liftDiscordBanLockdown(userId: string, discordId: string | null, savedRoles: string[]): Promise<void> {
  if (!discordId) return;
  const client = getDiscordClient();
  if (!client) return;
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    // Lift the guild ban only if FCM placed it.
    const guildBan = await guild.bans.fetch(discordId).catch(() => null);
    if (guildBan && await isFcmPlacedGuildBan(userId, guildBan.reason)) {
      await guild.bans.remove(discordId, 'Ban reversed').catch(() => {});
    }
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return;
    if (savedRoles.length > 0) {
      // Filter to roles that still exist + that we can grant
      const me = await guild.members.fetchMe();
      const botTop = me.roles.highest.position;
      const restorable = savedRoles.filter((id) => {
        const r = guild.roles.cache.get(id);
        return r && !r.managed && r.position < botTop;
      });
      if (restorable.length > 0) {
        await member.roles.add(restorable, 'Ban reversed — restoring roles').catch((err) =>
          logger.warn({ err, discordId }, 'failed to restore Discord roles'),
        );
      }
    }
  } catch (err) {
    logger.warn({ err, discordId }, 'liftDiscordBanLockdown failed');
  }
}

async function clearDiscordTimeout(discordId: string | null): Promise<void> {
  if (!discordId) return;
  const client = getDiscordClient();
  if (!client) return;
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return;
    await member.timeout(null, 'Mute lifted');
  } catch (err) {
    logger.warn({ err, discordId }, 'failed to clear Discord timeout');
  }
}

async function displayNameOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: DISPLAY_NAME_SELECT });
  return resolveUserDisplayName(u);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function kickUser(
  targetId: string,
  actorId: string,
  reason: string,
  options: { kickDiscord?: boolean } = {},
): Promise<{ disconnected: number; until: Date; discordKicked: boolean; discordWarning?: string }> {
  return runRequiredBundle('moderation', 'moderationActionsService:1fb7d6867234', async () => {
  await ensureNotProtected(targetId);
  if (!reason?.trim()) throw new ModerationError('InvalidInput', 'Kick reason is required');
  const until = new Date(Date.now() + KICK_COOLDOWN_MS);
  const target = await runRequiredMutation('moderation', '2628f8edd471e0924f3b2074', { stage: 'primary-write-unconfirmed', rowId: targetId }, () => prisma.user.update({ where: { id: targetId }, data: { kickedUntil: until }, select: { discordId: true } }), isPrismaAtomicRefusal, undefined, undefined);
  const discordKick = options.kickDiscord
    ? await applyDiscordKick(target.discordId, `FCM kick: ${reason}`)
    : { applied: false as const };
  // Notify before close so the overlay can render "You were kicked: <reason>"
  const disconnected = notifyAndDisconnect(
    targetId,
    { type: 'user:kicked', payload: { until: until.toISOString(), reason, durationSeconds: Math.ceil(KICK_COOLDOWN_MS / 1000) } },
    WS_CLOSE_BANNED,
    `KICK_COOLDOWN:${Math.ceil(KICK_COOLDOWN_MS / 1000)}`,
  );
  await evictRelaySessions(targetId, 'kicked');
  await audit(actorId, 'kick', targetId, reason, { until: until.toISOString(), disconnected, discordKicked: discordKick.applied, discordWarning: discordKick.warning });
  const [actorName, targetName] = await Promise.all([displayNameOf(actorId), displayNameOf(targetId)]);
  // Mod-log alert (fire-and-forget — never throws)
  postModAlert({
    title: '👢 User Kicked',
    color: '#FFA500',
    fields: [
      { name: 'Actor', value: actorName, inline: true },
      { name: 'Target', value: targetName, inline: true },
      { name: 'Reason', value: reason.slice(0, 1024) },
      { name: 'Cooldown', value: '5 minutes', inline: true },
      { name: 'Until', value: until.toISOString(), inline: true },
    ],
    timestamp: true,
    footerText: `Target ID: ${targetId}`,
  }).catch(() => {});
  return { disconnected, until, discordKicked: discordKick.applied, discordWarning: discordKick.warning };

  });
}

export async function muteUser(
  targetId: string,
  actorId: string,
  durationMs: number,
  category: string,
  reason: string,
  skipDiscord = false,
): Promise<{ until: Date; discordPropagated: boolean }> {
  return runRequiredBundle('moderation', 'moderationActionsService:985d0f7b5e51', async () => {
  await ensureNotProtected(targetId);
  const clamped = Math.max(60_000, Math.min(durationMs, MAX_MUTE_MS));
  const until = new Date(Date.now() + clamped);
  const updated = await (<PreparedArgs extends Parameters<typeof prisma.user.update>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('moderation', 'd2836039ef4eb6fd1c4285c5', { stage: 'primary-write-unconfirmed', rowId: targetId }, () => prisma.user.update(preparedArgs), isPrismaAtomicRefusal, undefined, undefined))({
    where: { id: targetId },
    data: { isMuted: true, muteExpiresAt: until, muteReason: reason.slice(0, 500), muteCategory: category, mutedById: actorId },
    select: { discordId: true },
  });
  markClientMuted(targetId, true, { until: until.toISOString(), reason, category });
  let discordPropagated = false;
  if (!skipDiscord && updated.discordId) {
    discordPropagated = await applyDiscordTimeout(updated.discordId, clamped, `${category}: ${reason}`);
  }
  await audit(actorId, 'mute', targetId, `${category}: ${reason}`, { until: until.toISOString(), durationMs: clamped, discordPropagated });
  const [actorName, targetName] = await Promise.all([displayNameOf(actorId), displayNameOf(targetId)]);
  const humanDur = formatDuration(clamped);
  // Mod-log alert (fire-and-forget — never throws)
  postModAlert({
    title: '🔇 User Muted',
    color: '#FFD700',
    fields: [
      { name: 'Actor', value: actorName, inline: true },
      { name: 'Target', value: targetName, inline: true },
      { name: 'Duration', value: humanDur, inline: true },
      { name: 'Category', value: category, inline: true },
      { name: 'Discord Propagated', value: String(discordPropagated), inline: true },
      { name: 'Reason', value: reason.slice(0, 1024) },
    ],
    timestamp: true,
    footerText: `Target ID: ${targetId}`,
  }).catch(() => {});
  return { until, discordPropagated };

  });
}

export async function unmuteUser(targetId: string, actorId: string, reason: string): Promise<void> {
  return runRequiredBundle('moderation', 'moderationActionsService:268b04831c0a', async () => {
  const u = await runRequiredMutation('moderation', '46adc873432309072cd5001f', { stage: 'primary-write-unconfirmed', rowId: targetId }, () => prisma.user.update({
    where: { id: targetId },
    data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null },
    select: { discordId: true },
  }), isPrismaAtomicRefusal, undefined, undefined);
  markClientMuted(targetId, false);
  if (u.discordId) await clearDiscordTimeout(u.discordId);
  await audit(actorId, 'unmute', targetId, reason);
  const [actorName, targetName] = await Promise.all([displayNameOf(actorId), displayNameOf(targetId)]);
  postModAlert({
    title: '🔊 User Unmuted',
    color: '#00FF7F',
    fields: [
      { name: 'Actor', value: actorName, inline: true },
      { name: 'Target', value: targetName, inline: true },
      { name: 'Reason', value: reason.slice(0, 1024) || 'No reason provided' },
    ],
    timestamp: true,
    footerText: `Target ID: ${targetId}`,
  }).catch(() => {});

  });
}

export interface NewBanEvidence {
  type: 'text' | 'image';
  textContent?: string;
  objectKey?: string;
  mime?: string;
  sizeBytes?: number;
}

export async function createBan(
  targetId: string,
  actorId: string,
  category: string,
  reasonText: string,
  bannedUntil: Date | null, // null = permanent
  evidence: NewBanEvidence[],
  // banDiscord is accepted for caller compatibility but no longer changes the
  // Discord effect: permanent bans always guild-ban, temporary bans never do
  // (roles are stripped and restored on expiry instead).
  _options: { banDiscord?: boolean } = {},
): Promise<{ banId: string; disconnected: number; discordLockdown: DiscordLockdownResult; identitiesDenyListed: number }> {
  return runRequiredBundle('moderation', 'moderationActionsService:a83bdbf67288', async () => {
  await ensureNotProtected(targetId);
  if (evidence.length === 0) throw new ModerationError('InvalidInput', 'Ban requires at least one piece of evidence');

  // Already-banned guard: a second ban would add a duplicate active bans row
  // and overwrite savedDiscordRoles with [] (the roles were already stripped),
  // so a later unban would restore nothing.
  const now = new Date();
  const [current, activeBan] = await Promise.all([
    prisma.user.findUnique({ where: { id: targetId }, select: { isBanned: true, bannedUntil: true, discordId: true, savedDiscordRoles: true } }),
    prisma.ban.findFirst({ where: { userId: targetId, ...activeBanWhere(now) }, select: { id: true } }),
  ]);
  if (!current) throw new ModerationError('TargetNotFound', 'Target user not found');
  const flagActive = current.isBanned && (current.bannedUntil === null || current.bannedUntil.getTime() > now.getTime());
  // A ban row is only "active" while the user flag still enforces it. The old
  // DELETE /api/users/:id/ban cleared the flag without reversing the row; such
  // stale rows must not block a new ban.
  if (flagActive || (activeBan && current.isBanned)) {
    throw new ModerationError('AlreadyBanned', activeBan
      ? `Target is already banned (ban ${activeBan.id}); reverse it before issuing a new ban`
      : 'Target is already banned; reverse the existing ban before issuing a new one');
  }

  const ban = await (<PreparedArgs extends Parameters<typeof prisma.ban.create>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('moderation', '234393b10c7910e25a503df4', { stage: 'primary-write-unconfirmed', userId: targetId }, () => prisma.ban.create(preparedArgs), isPrismaAtomicRefusal, undefined, undefined))({
    data: {
      userId: targetId,
      bannedById: actorId,
      reasonCategory: category,
      reasonText: reasonText.slice(0, 4000),
      bannedUntil,
      evidence: { create: evidence.map((e) => ({
        type: e.type,
        textContent: e.textContent ?? null,
        objectKey: e.objectKey ?? null,
        mime: e.mime ?? null,
        sizeBytes: e.sizeBytes ?? null,
      })) },
    },
    select: { id: true },
  });

  // Discord lockdown: strip roles + disconnect voice; permanent bans and the
  // Discord slash-ban path apply a guild ban. Save the stripped role IDs so we
  // can restore on unban.
  // Surfaces warnings (missing perms, role-hierarchy issues, guild-ban failure)
  // back to the controller so the dashboard can show "ban applied — Discord
  // propagation skipped role X above bot's top role".
  const lockdown = await applyDiscordBanLockdown(current.discordId ?? null, bannedUntil === null, `${category}: ${reasonText}`);
  // Never replace a non-empty role snapshot with an empty one: if the roles are
  // still stripped from an earlier (lazily expired, not yet swept) ban, this
  // strip finds nothing and the earlier snapshot is the only record of them.
  const previousRoles = savedRolesOf(current.savedDiscordRoles);
  const rolesToSave = lockdown.stripped.length > 0 ? lockdown.stripped : previousRoles;

  await (<PreparedArgs extends Parameters<typeof prisma.user.update>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('moderation', '318528ede67adf1297515df7', { stage: 'primary-write-unconfirmed', rowId: targetId }, () => prisma.user.update(preparedArgs), isPrismaAtomicRefusal, undefined, undefined))({
    where: { id: targetId },
    data: {
      isBanned: true,
      bannedUntil,
      banReason: reasonText.slice(0, 500),
      banCategory: category,
      bannedById: actorId,
      bannedAt: new Date(),
      savedDiscordRoles: rolesToSave as any,
    },
  });

  const identitiesDenyListed = bannedUntil === null ? await denyListIdentities(targetId, ban.id, category) : 0;

  // Permanent ban → revoke this user's device key(s) so a re-install can't
  // immediately re-auth under the old keypair. They'd have to re-enroll (TOFU),
  // which we can keep blocking while the ban stands. Temp bans don't revoke —
  // the device is fine again once the ban lifts. Matched by install_token via
  // the user row. Best-effort (non-fatal).
  if (bannedUntil === null) {
    try {
      const u = await runRequiredLookup('moderation', 'permanent-ban:device-discovery', () => prisma.user.findUnique({ where: { id: targetId }, select: { installToken: true } }));
      if (u?.installToken) {
        await runRequiredEffect('moderation:device-revoke', { targetId, stage: 'permanent-ban-device-revocation-unconfirmed' }, () => prisma.device.updateMany({
          where: { installToken: u.installToken, revokedAt: null },
          data: { revokedAt: new Date() },
        }));
      }
    } catch (err) {
      logger.warn({ err, targetId }, 'failed to revoke device key on permanent ban');
    }
    try {
      await runRequiredEffect('moderation:relay-revoke', { targetId, stage: 'permanent-ban-relay-revocation-unconfirmed' }, () => revokeTokensForLinkedUser(targetId));
    } catch (err) {
      logger.warn({ err, targetId }, 'failed to revoke relay token on permanent ban');
    }
  }

  // Notify before close — the overlay can render "You were banned (perm/until X): <reason>"
  const disconnected = notifyAndDisconnect(
    targetId,
    { type: 'user:banned', payload: { until: bannedUntil?.toISOString() ?? null, category, reason: reasonText, permanent: bannedUntil === null } },
    WS_CLOSE_BANNED,
    'Banned',
  );
  await evictRelaySessions(targetId, 'banned');
  await audit(actorId, 'ban', targetId, `${category}: ${reasonText}`, {
    banId: ban.id, until: bannedUntil?.toISOString() ?? null,
    evidenceCount: evidence.length,
    discordRolesStripped: lockdown.stripped.length,
    discordGuildBanApplied: lockdown.guildBanApplied,
    discordWarnings: lockdown.warnings,
    identitiesDenyListed,
  });
  const [actorName, targetName] = await Promise.all([displayNameOf(actorId), displayNameOf(targetId)]);
  const dur = bannedUntil ? formatDuration(bannedUntil.getTime() - Date.now()) : 'permanent';
  // Mod-log alert (fire-and-forget — never throws)
  postModAlert({
    title: '🔨 User Banned',
    color: '#FF0000',
    fields: [
      { name: 'Actor', value: actorName, inline: true },
      { name: 'Target', value: targetName, inline: true },
      { name: 'Duration', value: dur, inline: true },
      { name: 'Category', value: category, inline: true },
      { name: 'Evidence Count', value: String(evidence.length), inline: true },
      { name: 'Reason', value: reasonText.slice(0, 1024) },
      ...(lockdown.warnings.length > 0 ? [{ name: 'Discord Warnings', value: lockdown.warnings.slice(0, 3).join('\n').slice(0, 1024) }] : []),
    ],
    timestamp: true,
    footerText: `Ban ID: ${ban.id} | Target ID: ${targetId}`,
  }).catch(() => {});
  return { banId: ban.id, disconnected, discordLockdown: lockdown, identitiesDenyListed };

  });
}

/**
 * Delete a persisted public message through the same soft-delete and live
 * broadcast path used by the dashboard. Message IDs are globally unique in
 * the API even though the database table has a composite primary key.
 */
export async function deleteMessageById(messageId: string, actorId: string, reason = ''): Promise<void> {
  return runRequiredBundle('moderation', 'moderationActionsService:3e78ae1aa02c', async () => {
  // Best-effort read for the mod-log embed; the delete itself never depends on it.
  let before: { content: string; user: Parameters<typeof resolveUserDisplayName>[0]; channel: { name: string } | null } | null = null;
  try {
    before = await prisma.message.findFirst({
      where: { id: messageId },
      select: { content: true, user: { select: DISPLAY_NAME_SELECT }, channel: { select: { name: true } } },
    }) ?? null;
  } catch { before = null; }
  const result = await runRequiredMutation('moderation', 'b52323ff5aea65ce0badb849', { stage: 'primary-write-unconfirmed' }, () => prisma.$executeRaw`
    UPDATE messages SET is_deleted = TRUE
    WHERE id = ${messageId}::uuid AND NOT is_deleted`, undefined, undefined, isRowCountNoChange);
  if (result === 0) throw new Error('Message not found');

  await createRequiredAudit(prisma.auditLog, {
    data: {
      actorId,
      action: 'delete_message',
      targetId: messageId,
      targetType: 'message',
      reason: reason.slice(0, 500) || null,
    },
  });
  broadcastMessageDeletion(messageId);
  const actorName = await displayNameOf(actorId).catch(() => actorId);
  const excerpt = before?.content ? (before.content.length > 300 ? `${before.content.slice(0, 297)}...` : before.content) : null;
  postModAlert({
    title: 'Message Deleted',
    color: '#FFA500',
    fields: [
      { name: 'Deleted by', value: actorName, inline: true },
      ...(before ? [
        { name: 'Author', value: resolveUserDisplayName(before.user), inline: true },
        { name: 'Channel', value: before.channel?.name ? `#${before.channel.name}` : 'unknown', inline: true },
      ] : []),
      ...(excerpt ? [{ name: 'Message', value: excerpt, inline: false }] : []),
      { name: 'Message ID', value: messageId, inline: false },
      { name: 'Reason', value: reason.slice(0, 1024) || 'No reason provided' },
    ],
    timestamp: true,
    footerText: `Actor ID: ${actorId}`,
  }).catch(() => {});

  });
}

/**
 * Clear the denormalized users ban flags, drop the saved role snapshot and
 * restore the stripped Discord roles (and lift any guild ban).
 */
async function clearUserBanState(userId: string, discordId: string | null, savedRoles: unknown, writerId: string): Promise<void> {
  await runRequiredMutation('moderation', writerId, { stage: 'primary-write-unconfirmed', rowId: userId }, () => prisma.user.update({
    where: { id: userId },
    data: { isBanned: false, bannedUntil: null, banReason: null, banCategory: null, bannedById: null, bannedAt: null, savedDiscordRoles: Prisma.DbNull },
  }), isPrismaAtomicRefusal, undefined, undefined);
  await liftDiscordBanLockdown(userId, discordId, savedRolesOf(savedRoles));
}

/**
 * Reverse one ban row. The user's current ban state (flags, Discord roles,
 * guild ban) is only lifted when the reversed ban was itself still active AND
 * no other active ban remains for that user — reversing an old, expired or
 * superseded ban never lifts a different, currently active ban. The provider
 * deny-list is lifted when a permanent ban is reversed and no other
 * unreversed permanent ban remains.
 */
export async function reverseBan(banId: string, actorId: string, reverseReason: string): Promise<void> {
  return runRequiredBundle('moderation', 'moderationActionsService:1072e4a69ab4', async () => {
  const target = await prisma.ban.findUnique({ where: { id: banId }, select: { userId: true, bannedUntil: true } });
  if (!target) throw new ModerationError('BanNotFound', 'Ban not found');
  // Atomic guard: updateMany with where:{id, reversedAt:null} acts as a
  // compare-and-swap — it only writes if the ban hasn't been reversed yet, so
  // two concurrent callers cannot both lift state / restore Discord roles.
  const { count } = await (<PreparedArgs extends Parameters<typeof prisma.ban.updateMany>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('moderation', '7fe0589348884b260e4c2140', { stage: 'primary-write-unconfirmed', rowId: banId }, () => prisma.ban.updateMany(preparedArgs), isPrismaAtomicRefusal, undefined, isRowCountNoChange))({
    where: { id: banId, reversedAt: null },
    data: { reversedAt: new Date(), reversedById: actorId, reverseReason: reverseReason.slice(0, 500) },
  });
  if (count === 0) throw new ModerationError('BanAlreadyReversed', 'Ban already reversed');
  const userId = target.userId;
  const now = new Date();
  const wasActive = target.bannedUntil === null || target.bannedUntil.getTime() > now.getTime();

  const otherActive = await prisma.ban.count({ where: { userId, id: { not: banId }, ...activeBanWhere(now) } });
  let stateLifted = false;
  if (wasActive && otherActive === 0) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { isBanned: true, savedDiscordRoles: true, discordId: true } });
    if (u?.isBanned) {
      await clearUserBanState(userId, u.discordId, u.savedDiscordRoles, '3307b5b2d4082631a3ed1c1b');
      stateLifted = true;
    }
  }
  if (target.bannedUntil === null) {
    const otherPermanent = await prisma.ban.count({ where: { userId, id: { not: banId }, reversedAt: null, bannedUntil: null } });
    if (otherPermanent === 0) await liftIdentityDenyList(userId, banId);
  }
  await audit(actorId, 'unban', userId, reverseReason, { banId, stateLifted, otherActiveBans: otherActive });
  const [actorName, targetName] = await Promise.all([displayNameOf(actorId), displayNameOf(userId)]);
  // Mod-log alert (fire-and-forget — never throws)
  postModAlert({
    title: '✅ Ban Reversed',
    color: '#00FF7F',
    fields: [
      { name: 'Actor', value: actorName, inline: true },
      { name: 'Target', value: targetName, inline: true },
      { name: 'Reason', value: reverseReason.slice(0, 1024) || 'No reason given' },
      ...(stateLifted ? [] : [{ name: 'Note', value: otherActive > 0 ? 'Another active ban remains in force' : 'Ban was no longer active; user state unchanged' }]),
    ],
    timestamp: true,
    footerText: `Ban ID: ${banId} | Target ID: ${userId}`,
  }).catch(() => {});

  });
}

/**
 * Unban by user (legacy DELETE /api/users/:id/ban). Reverses every active ban
 * row for the user through reverseBan. A user flagged banned with no bans row
 * (pre-bans-table legacy ban) has the flag state cleared directly.
 */
export async function unbanUser(targetId: string, actorId: string, reason: string): Promise<{ reversedBanIds: string[] }> {
  return runRequiredBundle('moderation', 'moderationActionsService:5e0c1d7a2f41', async () => {
  const now = new Date();
  const [u, active] = await Promise.all([
    prisma.user.findUnique({ where: { id: targetId }, select: { isBanned: true, savedDiscordRoles: true, discordId: true } }),
    prisma.ban.findMany({ where: { userId: targetId, ...activeBanWhere(now) }, select: { id: true }, orderBy: { createdAt: 'asc' } }),
  ]);
  if (!u) throw new ModerationError('TargetNotFound', 'Target user not found');
  if (active.length > 0) {
    for (const b of active) await reverseBan(b.id, actorId, reason);
    return { reversedBanIds: active.map((b) => b.id) };
  }
  if (!u.isBanned) throw new ModerationError('NotBanned', 'Target has no active ban');
  await clearUserBanState(targetId, u.discordId, u.savedDiscordRoles, '9c4f2e81b7a35d06e1f2a4c8');
  await audit(actorId, 'unban', targetId, reason, { legacyFlagOnly: true });
  postModAlert({
    title: 'Ban Lifted',
    color: '#00FF7F',
    fields: [
      { name: 'Actor', value: await displayNameOf(actorId), inline: true },
      { name: 'Target', value: await displayNameOf(targetId), inline: true },
      { name: 'Reason', value: reason.slice(0, 1024) || 'No reason given' },
    ],
    timestamp: true,
    footerText: `Target ID: ${targetId}`,
  }).catch(() => {});
  return { reversedBanIds: [] };

  });
}

// ── Sweep — called by cron every 5 min ────────────────────────────────────────
export async function sweepExpired(): Promise<{ unbanned: number; unmuted: number; kickCooldownsCleared: number; rolesRestored: number }> {
  return runRequiredBundle('moderation', 'moderationActionsService:da8a182a3ce3', async () => {
  const now = new Date();

  const expiredBans = await prisma.user.findMany({
    where: { isBanned: true, bannedUntil: { lte: now } },
    select: { id: true, discordId: true, savedDiscordRoles: true },
  });
  for (const u of expiredBans) {
    // Temporary bans strip roles but never guild-ban, so the member is still
    // in the guild and the saved roles can be restored here.
    await clearUserBanState(u.id, u.discordId, u.savedDiscordRoles, 'b7e296dedf2d87821619959c');
    const name = await displayNameOf(u.id);
    postModAlert({
      title: '⌛ Temporary Ban Expired',
      color: '#00FF7F',
      fields: [{ name: 'Target', value: name, inline: true }],
      timestamp: true,
      footerText: `Target ID: ${u.id}`,
    }).catch(() => {});
  }

  // Expired bans can also be cleared lazily by the auth / link / WS
  // reconnect paths, which reset the flags but leave savedDiscordRoles. Pick
  // up those orphaned snapshots (not banned, snapshot still present) and
  // restore the roles so a lazily-expired temp ban does not lose them. Only a
  // snapshot backed by a temp ban that expired within ORPHAN_RESTORE_WINDOW_MS
  // is restored; older (pre-fix, already handled) snapshots are just dropped
  // so this never re-grants roles staff removed long after an unban.
  const orphaned = await prisma.user.findMany({
    where: { isBanned: false, NOT: [{ savedDiscordRoles: { equals: Prisma.DbNull } }] },
    select: { id: true, discordId: true, savedDiscordRoles: true },
    take: 200,
  });
  let rolesRestored = 0;
  for (const u of orphaned) {
    const recentExpiry = await prisma.ban.findFirst({
      where: { userId: u.id, reversedAt: null, bannedUntil: { lte: now, gte: new Date(now.getTime() - ORPHAN_RESTORE_WINDOW_MS) } },
      select: { id: true },
    });
    const roles = recentExpiry ? savedRolesOf(u.savedDiscordRoles) : [];
    const cleared = await runRequiredMutation('moderation', '4b8d1e6f0a2c7395b1e8d4f2', { stage: 'primary-write-unconfirmed', rowId: u.id }, () => prisma.user.updateMany({
      where: { id: u.id, isBanned: false },
      data: { savedDiscordRoles: Prisma.DbNull },
    }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    // A ban landing between the read and this update keeps its snapshot;
    // only restore roles when this pass actually cleared the row.
    const clearedCount = typeof cleared === 'number' ? cleared : (cleared as { count?: number } | undefined)?.count;
    if (roles.length > 0 && clearedCount === 1) {
      await liftDiscordBanLockdown(u.id, u.discordId, roles);
      rolesRestored += 1;
    }
  }

  const expiredMutes = await prisma.user.findMany({
    where: { isMuted: true, muteExpiresAt: { lte: now } },
    select: { id: true, discordId: true },
  });
  for (const u of expiredMutes) {
    await runRequiredMutation('moderation', '759b48119dfa487a00006d59', { stage: 'primary-write-unconfirmed', rowId: u.id }, () => prisma.user.update({
      where: { id: u.id },
      data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null },
    }), isPrismaAtomicRefusal, undefined, undefined);
    markClientMuted(u.id, false);
    if (u.discordId) await clearDiscordTimeout(u.discordId);
  }

  const kickCleared = await runRequiredMutation('moderation', '689819425a5c9f17ff1a2386', { stage: 'primary-write-unconfirmed' }, () => prisma.user.updateMany({
    where: { kickedUntil: { lte: now } },
    data: { kickedUntil: null },
  }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);

  return { unbanned: expiredBans.length, unmuted: expiredMutes.length, kickCooldownsCleared: kickCleared.count, rolesRestored };

  });
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const totalHr = Math.round(ms / 3_600_000);
  if (totalHr < 48) return `${totalHr} hr`;
  return `${Math.round(ms / 86_400_000)} days`;
}

export default { kickUser, muteUser, unmuteUser, createBan, reverseBan, unbanUser, deleteMessageById, sweepExpired, REASON_CATEGORIES, ProtectedTargetError, ModerationError };
module.exports = { kickUser, muteUser, unmuteUser, createBan, reverseBan, unbanUser, deleteMessageById, sweepExpired, REASON_CATEGORIES, ProtectedTargetError, ModerationError };
