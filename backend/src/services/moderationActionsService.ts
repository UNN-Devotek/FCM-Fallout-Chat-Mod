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
import { isProtectedTarget } from './userRoleService';
import { revokeTokensForLinkedUser } from './relay/tokenService';
import type { GuildMember } from 'discord.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const KICK_COOLDOWN_MS = 5 * 60 * 1000;        // 5 min
const MAX_MUTE_MS      = 30 * 24 * 60 * 60 * 1000; // 30 d (hard cap)
const DISCORD_TIMEOUT_CAP_MS = 28 * 24 * 60 * 60 * 1000; // Discord API ceiling
const WS_CLOSE_BANNED = 4002;

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

export class ProtectedTargetError extends Error {
  constructor(public role: string) {
    super(`target holds protected role "${role}" — remove role in Discord first`);
    this.name = 'ProtectedTargetError';
  }
}

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

async function ensureNotProtected(targetId: string): Promise<void> {
  if (await isProtectedTarget(targetId)) {
    const role = (await prisma.user.findUnique({ where: { id: targetId }, select: { discordId: true } }))?.discordId
      ? (await prisma.adminUser.findUnique({ where: { discordId: (await prisma.user.findUnique({ where: { id: targetId }, select: { discordId: true } }))!.discordId! }, select: { role: true } }))?.role
      : null;
    throw new ProtectedTargetError(role || 'unknown');
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
async function liftDiscordBanLockdown(discordId: string | null, savedRoles: string[]): Promise<void> {
  if (!discordId) return;
  const client = getDiscordClient();
  if (!client) return;
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    // Lift guild ban if one exists (no-op if not)
    await guild.bans.remove(discordId, 'Ban reversed').catch(() => {});
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
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, discordDisplayName: true, discordUsername: true } });
  if (!u) return 'unknown';
  if (u.username && u.username !== 'Wanderer' && !u.username.startsWith('pending-')) return u.username;
  return u.discordDisplayName || u.discordUsername || u.username || 'unknown';
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
  if (!reason?.trim()) throw new Error('Kick reason is required');
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
  options: { banDiscord?: boolean } = {},
): Promise<{ banId: string; disconnected: number; discordLockdown: DiscordLockdownResult }> {
  return runRequiredBundle('moderation', 'moderationActionsService:a83bdbf67288', async () => {
  await ensureNotProtected(targetId);
  if (evidence.length === 0) throw new Error('Ban requires at least one piece of evidence');

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
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { discordId: true } });
  const lockdown = await applyDiscordBanLockdown(target?.discordId ?? null, bannedUntil === null || options.banDiscord === true, `${category}: ${reasonText}`);

  await (<PreparedArgs extends Parameters<typeof prisma.user.update>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('moderation', '318528ede67adf1297515df7', { stage: 'primary-write-unconfirmed', rowId: targetId }, () => prisma.user.update(preparedArgs), isPrismaAtomicRefusal, undefined, undefined))({
    where: { id: targetId },
    data: {
      isBanned: true,
      bannedUntil,
      banReason: reasonText.slice(0, 500),
      banCategory: category,
      bannedById: actorId,
      bannedAt: new Date(),
      savedDiscordRoles: lockdown.stripped as any,
    },
  });

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
  return { banId: ban.id, disconnected, discordLockdown: lockdown };

  });
}

/**
 * Delete a persisted public message through the same soft-delete and live
 * broadcast path used by the dashboard. Message IDs are globally unique in
 * the API even though the database table has a composite primary key.
 */
export async function deleteMessageById(messageId: string, actorId: string, reason = ''): Promise<void> {
  return runRequiredBundle('moderation', 'moderationActionsService:3e78ae1aa02c', async () => {
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
  }).catch((err) => logger.warn({ err, messageId }, 'message deletion audit write failed'));
  broadcastMessageDeletion(messageId);
  postModAlert({
    title: '🗑️ Message Deleted',
    color: '#FFA500',
    fields: [
      { name: 'Message ID', value: messageId, inline: false },
      { name: 'Reason', value: reason.slice(0, 1024) || 'No reason provided' },
    ],
    timestamp: true,
    footerText: `Actor ID: ${actorId}`,
  }).catch(() => {});

  });
}

export async function reverseBan(banId: string, actorId: string, reverseReason: string): Promise<void> {
  return runRequiredBundle('moderation', 'moderationActionsService:1072e4a69ab4', async () => {
  // Atomic guard: updateMany with where:{id, reversedAt:null} acts as a
  // compare-and-swap — it only writes if the ban hasn't been reversed yet.
  // This eliminates the TOCTOU window that existed between the old findUnique
  // check and the subsequent update, where two concurrent callers could both
  // pass the "already reversed?" guard and both clear the user's ban state and
  // trigger Discord role-restore.
  const { count } = await (<PreparedArgs extends Parameters<typeof prisma.ban.updateMany>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('moderation', '7fe0589348884b260e4c2140', { stage: 'primary-write-unconfirmed', rowId: banId }, () => prisma.ban.updateMany(preparedArgs), isPrismaAtomicRefusal, undefined, isRowCountNoChange))({
    where: { id: banId, reversedAt: null },
    data: { reversedAt: new Date(), reversedById: actorId, reverseReason: reverseReason.slice(0, 500) },
  });
  if (count === 0) {
    // Either the ban doesn't exist or it was already reversed — check which.
    const existing = await prisma.ban.findUnique({ where: { id: banId }, select: { reversedAt: true } });
    if (!existing) throw new Error('Ban not found');
    throw new Error('Ban already reversed');
  }
  const ban = await prisma.ban.findUniqueOrThrow({ where: { id: banId }, select: { userId: true } });

  // Only clear the User's current-state flags if THIS ban is the active one
  // (the user has a row for ban.userId where isBanned=true matching this ban).
  const u = await prisma.user.findUnique({ where: { id: ban.userId }, select: { isBanned: true, savedDiscordRoles: true, discordId: true } });
  if (u?.isBanned) {
    await runRequiredMutation('moderation', '3307b5b2d4082631a3ed1c1b', { stage: 'primary-write-unconfirmed', rowId: ban.userId }, () => prisma.user.update({
      where: { id: ban.userId },
      data: { isBanned: false, bannedUntil: null, banReason: null, banCategory: null, bannedById: null, bannedAt: null, savedDiscordRoles: undefined as any },
    }), isPrismaAtomicRefusal, undefined, undefined);
    // Restore Discord roles + lift guild ban
    const saved = Array.isArray(u.savedDiscordRoles) ? (u.savedDiscordRoles as unknown as string[]) : [];
    await liftDiscordBanLockdown(u.discordId, saved);
  }
  await audit(actorId, 'unban', ban.userId, reverseReason, { banId });
  const [actorName, targetName] = await Promise.all([displayNameOf(actorId), displayNameOf(ban.userId)]);
  // Mod-log alert (fire-and-forget — never throws)
  postModAlert({
    title: '✅ Ban Reversed',
    color: '#00FF7F',
    fields: [
      { name: 'Actor', value: actorName, inline: true },
      { name: 'Target', value: targetName, inline: true },
      { name: 'Reason', value: reverseReason.slice(0, 1024) || 'No reason given' },
    ],
    timestamp: true,
    footerText: `Ban ID: ${banId} | Target ID: ${ban.userId}`,
  }).catch(() => {});

  });
}

// ── Sweep — called by cron every 5 min ────────────────────────────────────────
export async function sweepExpired(): Promise<{ unbanned: number; unmuted: number; kickCooldownsCleared: number }> {
  return runRequiredBundle('moderation', 'moderationActionsService:da8a182a3ce3', async () => {
  const now = new Date();

  const expiredBans = await prisma.user.findMany({
    where: { isBanned: true, bannedUntil: { lte: now } },
    select: { id: true, discordId: true, savedDiscordRoles: true },
  });
  for (const u of expiredBans) {
    await runRequiredMutation('moderation', 'b7e296dedf2d87821619959c', { stage: 'primary-write-unconfirmed', rowId: u.id }, () => prisma.user.update({
      where: { id: u.id },
      data: { isBanned: false, bannedUntil: null, banReason: null, banCategory: null, bannedById: null, bannedAt: null, savedDiscordRoles: undefined as any },
    }), isPrismaAtomicRefusal, undefined, undefined);
    // Restore Discord state (roles + lift guild ban — for temp bans this is no-op
    // since temps don't apply guild ban, but role restore still runs).
    const saved = Array.isArray(u.savedDiscordRoles) ? (u.savedDiscordRoles as unknown as string[]) : [];
    await liftDiscordBanLockdown(u.discordId, saved);
    const name = await displayNameOf(u.id);
    postModAlert({
      title: '⌛ Temporary Ban Expired',
      color: '#00FF7F',
      fields: [{ name: 'Target', value: name, inline: true }],
      timestamp: true,
      footerText: `Target ID: ${u.id}`,
    }).catch(() => {});
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

  return { unbanned: expiredBans.length, unmuted: expiredMutes.length, kickCooldownsCleared: kickCleared.count };

  });
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const totalHr = Math.round(ms / 3_600_000);
  if (totalHr < 48) return `${totalHr} hr`;
  return `${Math.round(ms / 86_400_000)} days`;
}

export default { kickUser, muteUser, unmuteUser, createBan, reverseBan, deleteMessageById, sweepExpired, REASON_CATEGORIES, ProtectedTargetError };
module.exports = { kickUser, muteUser, unmuteUser, createBan, reverseBan, deleteMessageById, sweepExpired, REASON_CATEGORIES, ProtectedTargetError };
