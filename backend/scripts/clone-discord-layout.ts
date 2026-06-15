/**
 * clone-discord-layout.ts — MAINTAINER-RUN Discord layout cloner.
 *
 * See docs/deployment/hosted-dev-environment.md ("Dev Discord provisioning").
 * Reads a SOURCE guild's roles + channels/categories (incl. permission
 * overwrites) and recreates anything MISSING in a TARGET guild, then prints the
 * new role-ID env mapping for the dev backend.
 *
 * Why: a Discord Server Template copies structure but the cloned roles get
 * BRAND-NEW IDs, so the dev backend's OWNER_ROLE_ID / ADMIN_ROLE_ID /
 * MODERATOR_ROLE_ID / DEVELOPER_ROLE_ID env vars must point at the TARGET guild's
 * IDs. This script captures them and prints ready-to-paste env lines.
 *
 * The bot needs Manage Roles + Manage Channels in the TARGET guild only. It must
 * NOT be added to the production guild if SOURCE is prod — but reading the source
 * does require the bot to be a member of the source guild. Recommended: run the
 * extract from a maintainer machine where the bot is in BOTH the (throwaway)
 * template-source and the dev target, never adding the dev bot to live prod.
 *
 * Env:
 *   DISCORD_BOT_TOKEN   bot token (member of SOURCE + TARGET guilds)
 *   SOURCE_GUILD_ID     guild to copy layout from
 *   TARGET_GUILD_ID     guild to recreate missing roles/channels in
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=*** SOURCE_GUILD_ID=... TARGET_GUILD_ID=... \
 *   node --import tsx scripts/clone-discord-layout.ts
 */

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  OverwriteType,
  PermissionsBitField,
  type Guild,
  type Role,
  type GuildChannel,
  type GuildChannelTypes,
  type OverwriteResolvable,
} from 'discord.js';
import { formatRoleEnvLines, type ClonedRole } from '../src/utils/devSeedHelpers';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[clone-discord] FATAL: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

/** Roles eligible for cloning: skip @everyone and bot-managed (integration) roles. */
function clonableRoles(guild: Guild): Role[] {
  return [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => a.position - b.position); // low → high so hierarchy is built bottom-up
}

/**
 * Recreate roles missing in target (matched by name). Returns the full set of
 * roles in the target that correspond to source roles, as {name, id}.
 */
async function cloneRoles(source: Guild, target: Guild): Promise<ClonedRole[]> {
  const result: ClonedRole[] = [];
  for (const role of clonableRoles(source)) {
    let targetRole = target.roles.cache.find((r) => r.name === role.name && !r.managed);
    if (!targetRole) {
      console.log(`[clone-discord] creating role: ${role.name}`);
      targetRole = await target.roles.create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        permissions: role.permissions,
        mentionable: role.mentionable,
        reason: 'clone-discord-layout: recreate source role layout',
      });
    } else {
      console.log(`[clone-discord] role exists, skipping: ${role.name}`);
    }
    result.push({ name: targetRole.name, id: targetRole.id });
  }
  return result;
}

/**
 * Translate a source channel's permission overwrites into target-guild
 * overwrites, remapping role IDs by NAME (cloned roles have new IDs). Member
 * overwrites are dropped (dev guild has no real members to map to).
 */
function remapOverwrites(
  channel: GuildChannel,
  source: Guild,
  target: Guild,
): OverwriteResolvable[] {
  const out: OverwriteResolvable[] = [];
  for (const ow of channel.permissionOverwrites.cache.values()) {
    if (ow.type === OverwriteType.Member) continue; // no member mapping in dev
    let targetId: string | undefined;
    if (ow.id === source.id) {
      targetId = target.id; // @everyone
    } else {
      const srcRole = source.roles.cache.get(ow.id);
      if (!srcRole) continue;
      targetId = target.roles.cache.find((r) => r.name === srcRole.name)?.id;
    }
    if (!targetId) continue;
    out.push({
      id: targetId,
      type: OverwriteType.Role,
      allow: new PermissionsBitField(ow.allow.bitfield),
      deny: new PermissionsBitField(ow.deny.bitfield),
    });
  }
  return out;
}

const CLONABLE_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildCategory,
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildStageVoice,
]);

/** Recreate missing categories first, then their children, remapping parents. */
async function cloneChannels(source: Guild, target: Guild): Promise<void> {
  const channels = [...source.channels.cache.values()]
    .filter((c) => !c.isThread() && CLONABLE_CHANNEL_TYPES.has(c.type))
    .map((c) => c as GuildChannel)
    .sort((a, b) => {
      // categories before non-categories, then by position
      const ac = a.type === ChannelType.GuildCategory ? 0 : 1;
      const bc = b.type === ChannelType.GuildCategory ? 0 : 1;
      return ac - bc || a.position - b.position;
    });

  // Map source-category-id -> target-category-id as we go.
  const categoryMap = new Map<string, string>();

  for (const ch of channels) {
    const existing = target.channels.cache.find(
      (t) => t.name === ch.name && t.type === ch.type,
    );
    let parentTargetId: string | undefined;
    if (ch.parentId) parentTargetId = categoryMap.get(ch.parentId);

    if (existing) {
      console.log(`[clone-discord] channel exists, skipping: ${ch.name}`);
      if (ch.type === ChannelType.GuildCategory) categoryMap.set(ch.id, existing.id);
      continue;
    }

    console.log(`[clone-discord] creating channel: ${ch.name} (${ChannelType[ch.type]})`);
    const created = await target.channels.create({
      name: ch.name,
      type: ch.type as GuildChannelTypes,
      parent: parentTargetId,
      topic: 'topic' in ch ? (ch as { topic: string | null }).topic ?? undefined : undefined,
      nsfw: 'nsfw' in ch ? Boolean((ch as { nsfw: boolean }).nsfw) : undefined,
      permissionOverwrites: remapOverwrites(ch, source, target),
      reason: 'clone-discord-layout: recreate source channel layout',
    });
    if (ch.type === ChannelType.GuildCategory) categoryMap.set(ch.id, created.id);
  }
}

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_BOT_TOKEN');
  const sourceId = requireEnv('SOURCE_GUILD_ID');
  const targetId = requireEnv('TARGET_GUILD_ID');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  console.log(`[clone-discord] logged in as ${client.user?.tag}`);

  try {
    const source = await client.guilds.fetch(sourceId);
    const target = await client.guilds.fetch(targetId);
    // Hydrate caches.
    await source.roles.fetch();
    await source.channels.fetch();
    await target.roles.fetch();
    await target.channels.fetch();

    console.log(`[clone-discord] SOURCE: ${source.name}  →  TARGET: ${target.name}`);

    const clonedRoles = await cloneRoles(source, target);
    // Re-fetch target roles so overwrite remapping sees the new roles.
    await target.roles.fetch();
    await cloneChannels(source, target);

    const envLines = formatRoleEnvLines(clonedRoles);
    console.log('\n[clone-discord] ===== ready-to-paste env (TARGET guild role IDs) =====');
    if (envLines.length === 0) {
      console.log('[clone-discord] (no roles matched OWNER/ADMIN/MODERATOR/DEVELOPER)');
    } else {
      for (const line of envLines) console.log(line);
    }
    console.log('[clone-discord] =========================================================');
  } finally {
    await client.destroy();
  }
}

main().catch((err) => {
  console.error('[clone-discord] FAILED:', err);
  process.exit(1);
});
