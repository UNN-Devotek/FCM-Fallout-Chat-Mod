import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GuildScheduledEvent,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  PartialGuildScheduledEvent,
  TextChannel,
  type Message,
  type User,
} from 'discord.js';

import prisma from '../config/prisma';
import env from '../config/environment';
import logger from '../config/logger';
import { persistMessage } from './messageService';
import { nextRelaySeq } from './relay/relaySeq';
import {
  appendOrReplaceEventDetailsSuffix,
  buildCompactHudEventRow,
  isTerminalPublicEventStatus,
  mapDiscordEventLifecycle,
  stripExactGeneratedEventDetailsSuffix,
  stableDiscordEventCode,
  type DiscordEventSourceState,
  type PublicEventStatus,
} from './discordEventProjection';
import { UUID_EVENTS } from './relay/channelMap';

const EVENT_BOT_INSTALL_TOKEN = 'discord:event-bot';
const EVENT_BOT_USERNAME = 'pending-discord-event-bot';
const HUD_EVENT_PREFIX = '[EVENTS] [EVENT] FCM: ';
// Keep event projections inside the existing messages.source contract. The
// structured metadata.type distinguishes these bot-authored rows from normal
// Discord chat without requiring a new database check-constraint value.
const EVENT_SOURCE = 'discord';
const DISCORD_DESCRIPTION_LIMIT = 1_000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;
const BROADCAST_EVENT_UPDATE = 'event:attendance-updated';

type Broadcast = (payload: Record<string, unknown>) => void;
type BroadcastToUsers = (payload: Record<string, unknown>, userIds: string[]) => Promise<number>;

interface EventSourceSnapshot {
  guildId: string;
  scheduledEventId: string;
  eventCode: string;
  sourceState: DiscordEventSourceState;
  publicStatus: PublicEventStatus;
  terminal: boolean;
  name: string;
  creatorDescription: string;
  startUtc: string | null;
  endUtc: string | null;
  location: string | null;
  discordEventUrl: string;
  imageUrl: string | null;
  sourceFingerprint: string;
  interestedCount: number;
}

interface EventProjectionMetadata {
  type: 'scheduled_event';
  kind: 'scheduled_event';
  eventCode: string;
  scheduledEventId: string;
  name: string;
  status: PublicEventStatus;
  startUtc: string | null;
  endUtc: string | null;
  location: string | null;
  descriptionSummary: string;
  announcementUrl: string | null;
  discordEventUrl: string | null;
  interestedCount: number;
  /** Deliberately omitted from shared metadata; viewer state is private. */
  isViewerInterested?: never;
}

interface StoredProjectionRow {
  id: string;
  content: string;
  metadata: unknown;
  created_at: Date;
}

interface SubscriberReconciliation {
  interestedCount: number;
  previousInterestedCount: number;
  viewerChanges: Array<{ userId: string; isViewerInterested: boolean }>;
}

interface RuntimeState {
  client: Client;
  broadcast: Broadcast;
  broadcastToUsers: BroadcastToUsers;
  eventChannel: TextChannel | null;
  reconcileTimer: NodeJS.Timeout | null;
  reconciliationInFlight: Promise<void> | null;
  queuedSyncs: Map<string, Promise<void>>;
}

let runtime: RuntimeState | null = null;

function sourceStateFromDiscordStatus(status: GuildScheduledEventStatus): DiscordEventSourceState {
  switch (status) {
    case GuildScheduledEventStatus.Scheduled:
      return 'SCHEDULED';
    case GuildScheduledEventStatus.Active:
      return 'ACTIVE';
    case GuildScheduledEventStatus.Completed:
      return 'COMPLETED';
    case GuildScheduledEventStatus.Canceled:
      return 'CANCELED';
    default:
      // discord.js currently exposes only the four scheduled-event states. A
      // future unknown state is safer as a no-op than as an active event.
      throw new Error(`Unsupported Discord scheduled-event status: ${String(status)}`);
  }
}

const stableEventCode = stableDiscordEventCode;

function validHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname || value.includes('<') || value.includes('>')) return null;
    return value;
  } catch {
    return null;
  }
}

function sourceDescription(event: GuildScheduledEvent, previousGeneratedSuffix?: string | null): string {
  const description = event.description ?? '';
  return previousGeneratedSuffix
    ? stripExactGeneratedEventDetailsSuffix(description, previousGeneratedSuffix)
    : description;
}

function descriptionSummary(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  return normalized.length <= 480 ? normalized : `${normalized.slice(0, 477)}...`;
}

function sourceFingerprint(input: Omit<EventSourceSnapshot, 'sourceFingerprint' | 'interestedCount'>): string {
  return createHash('sha256')
    .update(JSON.stringify({
      guildId: input.guildId,
      scheduledEventId: input.scheduledEventId,
      sourceState: input.sourceState,
      name: input.name,
      creatorDescription: input.creatorDescription,
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      location: input.location,
      discordEventUrl: input.discordEventUrl,
      imageUrl: input.imageUrl,
    }), 'utf8')
    .digest('hex');
}

function eventLocation(event: GuildScheduledEvent): string | null {
  const location = event.entityMetadata?.location?.trim();
  if (location) return location;
  return event.channel?.name?.trim() || null;
}

function eventSnapshot(
  event: GuildScheduledEvent,
  interestedCount: number,
  previousGeneratedSuffix?: string | null,
): EventSourceSnapshot {
  const eventCode = stableEventCode(event.guildId, event.id);
  const sourceState = sourceStateFromDiscordStatus(event.status);
  const lifecycle = mapDiscordEventLifecycle(sourceState);
  const snapshotWithoutFingerprint = {
    guildId: event.guildId,
    scheduledEventId: event.id,
    eventCode,
    sourceState,
    publicStatus: lifecycle.status,
    terminal: lifecycle.isTerminal,
    name: event.name.trim().slice(0, 256),
    creatorDescription: sourceDescription(event, previousGeneratedSuffix),
    startUtc: event.scheduledStartAt?.toISOString() ?? null,
    endUtc: event.scheduledEndAt?.toISOString() ?? null,
    location: eventLocation(event),
    discordEventUrl: validHttpUrl(event.url) ?? `https://discord.com/events/${event.guildId}/${event.id}`,
    imageUrl: validHttpUrl(event.coverImageURL() ?? null),
  };
  return {
    ...snapshotWithoutFingerprint,
    sourceFingerprint: sourceFingerprint(snapshotWithoutFingerprint),
    interestedCount: Math.max(0, Math.floor(interestedCount)),
  };
}

function statusColor(status: PublicEventStatus): number {
  switch (status) {
    case 'Upcoming': return 0xC8A840;
    case 'Live': return 0x55EFC4;
    case 'Ended': return 0x8A8A8A;
    case 'Canceled': return 0xFF6B4A;
    case 'Deleted': return 0x666666;
    default: return 0xC8A840;
  }
}

function discordTime(value: string | null): string {
  if (!value) return 'Not specified';
  const seconds = Math.floor(new Date(value).getTime() / 1_000);
  return Number.isFinite(seconds) ? `<t:${seconds}:F> (<t:${seconds}:R>)` : 'Not specified';
}

function announcementEmbed(snapshot: EventSourceSnapshot, announcementUrl: string | null): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(statusColor(snapshot.publicStatus))
    .setTitle(`◈ EVENT · ${snapshot.publicStatus.toUpperCase()}`)
    .addFields(
      { name: 'EVENT', value: snapshot.name || 'Untitled event', inline: false },
      { name: 'WHEN', value: snapshot.endUtc ? `${discordTime(snapshot.startUtc)} → ${discordTime(snapshot.endUtc)}` : discordTime(snapshot.startUtc), inline: false },
      { name: 'WHERE', value: snapshot.location || 'Discord event', inline: true },
      { name: 'INTERESTED', value: String(snapshot.interestedCount), inline: true },
    )
    .setFooter({ text: `Event code ${snapshot.eventCode}` });

  const summary = descriptionSummary(snapshot.creatorDescription);
  if (summary) embed.setDescription(summary);
  if (snapshot.imageUrl) embed.setThumbnail(snapshot.imageUrl);
  if (announcementUrl) embed.setURL(announcementUrl);
  return embed;
}

function announcementComponents(snapshot: EventSourceSnapshot): ActionRowBuilder<ButtonBuilder>[] {
  if (snapshot.publicStatus === 'Deleted' || !validHttpUrl(snapshot.discordEventUrl)) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Open Discord Event')
        .setURL(snapshot.discordEventUrl),
    ),
  ];
}

function announcementMatchesSnapshot(message: Message, snapshot: EventSourceSnapshot): boolean {
  const expectedEmbed = announcementEmbed(snapshot, null).toJSON();
  const actualEmbed = message.embeds[0]?.toJSON();
  if (JSON.stringify(actualEmbed) !== JSON.stringify(expectedEmbed)) return false;

  const expectedComponents = announcementComponents(snapshot).map((row) => row.toJSON());
  const actualComponents = message.components.map((row) => row.toJSON());
  return JSON.stringify(actualComponents) === JSON.stringify(expectedComponents);
}

function compactProjection(snapshot: EventSourceSnapshot, announcementUrl: string | null): EventProjectionMetadata {
  return {
    type: 'scheduled_event',
    kind: 'scheduled_event',
    eventCode: snapshot.eventCode,
    scheduledEventId: snapshot.scheduledEventId,
    name: snapshot.name,
    status: snapshot.publicStatus,
    startUtc: snapshot.startUtc,
    endUtc: snapshot.endUtc,
    location: snapshot.location,
    descriptionSummary: descriptionSummary(snapshot.creatorDescription),
    announcementUrl,
    discordEventUrl: validHttpUrl(snapshot.discordEventUrl),
    interestedCount: snapshot.interestedCount,
  };
}

function terminalState(sourceStatus: string): boolean {
  try {
    return isTerminalPublicEventStatus(mapDiscordEventLifecycle(sourceStatus as DiscordEventSourceState).status);
  } catch {
    return sourceStatus === 'DELETED' || sourceStatus === 'COMPLETED' || sourceStatus === 'CANCELED';
  }
}

function shouldIgnoreStaleState(existingSourceStatus: string, nextSourceStatus: DiscordEventSourceState): boolean {
  // Terminal Discord states are immutable. A repeated notification in the same
  // terminal state must still repair a missing announcement/projection, but a
  // late non-terminal or conflicting terminal payload must never reactivate or
  // rewrite the retained final record.
  return terminalState(existingSourceStatus) && existingSourceStatus !== nextSourceStatus;
}

async function configuredEventChannel(client: Client): Promise<TextChannel> {
  if (!env.DISCORD_SERVER_ID || !env.DISCORD_EVENTS_CHANNEL_ID) {
    throw new Error('DISCORD_SERVER_ID and DISCORD_EVENTS_CHANNEL_ID are required for scheduled-event mirroring');
  }
  const channel = await client.channels.fetch(env.DISCORD_EVENTS_CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !('guildId' in channel) || channel.guildId !== env.DISCORD_SERVER_ID) {
    throw new Error(`DISCORD_EVENTS_CHANNEL_ID=${env.DISCORD_EVENTS_CHANNEL_ID} is not a text channel in DISCORD_SERVER_ID=${env.DISCORD_SERVER_ID}`);
  }
  const textChannel = channel as TextChannel;
  const permissions = client.user ? textChannel.permissionsFor(client.user) : null;
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    // The bot appends the announcement URL to the source event description.
    PermissionFlagsBits.ManageEvents,
  ];
  if (!permissions || !permissions.has(requiredPermissions)) {
    throw new Error(`Bot lacks View Channel, Send Messages, Embed Links, Read Message History, or Manage Events for ${env.DISCORD_EVENTS_CHANNEL_ID}`);
  }
  return textChannel;
}

async function ensureAnnouncement(snapshot: EventSourceSnapshot, announcementMessageId: string | null): Promise<Message> {
  if (!runtime?.eventChannel) throw new Error('Discord scheduled-event channel has not been validated');
  const channel = runtime.eventChannel;
  const payload = {
    embeds: [announcementEmbed(snapshot, null)],
    components: announcementComponents(snapshot),
  };

  if (announcementMessageId) {
    try {
      const existing = await channel.messages.fetch(announcementMessageId);
      if (existing.author.id === runtime.client.user?.id) {
        if (announcementMatchesSnapshot(existing, snapshot)) return existing;
        const edited = await existing.edit(payload);
        return edited;
      }
      logger.warn({ announcementMessageId, eventCode: snapshot.eventCode }, '[discord-events] known announcement is not bot-authored; preserving unrelated message');
    } catch (err) {
      logger.info({ err, announcementMessageId, eventCode: snapshot.eventCode }, '[discord-events] announcement missing; recreating known event announcement');
    }
  }

  // A previous publish may have succeeded before its mirror row was written.
  // Recover the bot-authored message by its stable event-code footer before
  // posting anything new, so a retry cannot create a duplicate announcement.
  try {
    const recent = await channel.messages.fetch({ limit: 100 });
    const recovered = [...recent.values()].find((candidate) =>
      candidate.author.id === runtime?.client.user?.id
      && candidate.embeds.some((embed) => embed.footer?.text === `Event code ${snapshot.eventCode}`),
    );
    if (recovered) {
      if (announcementMatchesSnapshot(recovered, snapshot)) return recovered;
      return recovered.edit(payload);
    }
  } catch (err) {
    logger.debug({ err, eventCode: snapshot.eventCode }, '[discord-events] announcement recovery scan failed');
  }

  const message = await channel.send(payload);
  return message;
}

async function ensureEventBotUser(): Promise<{ id: string; username: string }> {
  if (!runtime?.client.user) throw new Error('Discord client is not ready');
  const user = await prisma.user.upsert({
    where: { installToken: EVENT_BOT_INSTALL_TOKEN },
    update: {
      discordId: runtime.client.user.id,
      discordUsername: runtime.client.user.username,
      discordDisplayName: '[EVENT] FCM',
    },
    create: {
      username: EVENT_BOT_USERNAME,
      installToken: EVENT_BOT_INSTALL_TOKEN,
      discordId: runtime.client.user.id,
      discordUsername: runtime.client.user.username,
      discordDisplayName: '[EVENT] FCM',
    },
    select: { id: true, username: true },
  });
  return user;
}

async function readStoredProjection(messageId: string): Promise<StoredProjectionRow | null> {
  const rows = await prisma.$queryRaw<StoredProjectionRow[]>`
    SELECT id, content, metadata, created_at
      FROM messages
     WHERE id = ${messageId}::uuid
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function findStoredProjection(eventCode: string): Promise<StoredProjectionRow | null> {
  const rows = await prisma.$queryRaw<StoredProjectionRow[]>`
    SELECT id, content, metadata, created_at
      FROM messages
     WHERE channel_id = ${UUID_EVENTS}::uuid
       AND NOT is_deleted
       AND metadata->>'type' = 'scheduled_event'
       AND metadata->>'eventCode' = ${eventCode}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function updateFcmProjection(
  mirrorId: string,
  snapshot: EventSourceSnapshot,
  announcementUrl: string | null,
  existingFcmMessageId: string | null,
): Promise<string> {
  const metadata = compactProjection(snapshot, announcementUrl);
  const hudRow = buildCompactHudEventRow({
    name: snapshot.name,
    status: snapshot.publicStatus,
    startUtc: snapshot.startUtc,
    interestedCount: snapshot.interestedCount,
    eventCode: snapshot.eventCode,
  });
  // hudFeedService adds the Events channel label and sender name around the
  // stored content. Keep only the body so live delivery and history render the
  // same `[EVENTS] [EVENT] FCM: ...` row without duplicating that prefix.
  const content = hudRow.startsWith(HUD_EVENT_PREFIX) ? hudRow.slice(HUD_EVENT_PREFIX.length) : hudRow;
  const now = new Date();
  const botUser = await ensureEventBotUser();

  const knownProjection = existingFcmMessageId
    ? await readStoredProjection(existingFcmMessageId)
    : null;
  const recoveredProjection = await findStoredProjection(snapshot.eventCode);
  // Prefer the mirror's known row when it still exists. If that row was
  // deleted or the mirror write was interrupted, recover a bot-authored event
  // row by stable event code before creating a new one.
  const existingProjection = knownProjection ?? recoveredProjection;
  const messageIdToUpdate = existingProjection?.id ?? null;
  if (messageIdToUpdate) {
    if (existingProjection) {
      if (existingProjection.content === content
        && JSON.stringify(existingProjection.metadata) === JSON.stringify(metadata)) {
        return messageIdToUpdate;
      }
      const relaySeq = await nextRelaySeq();
      await prisma.$executeRaw`
        UPDATE messages
           SET content = ${content},
               metadata = ${JSON.stringify(metadata)}::jsonb,
               relay_seq = ${BigInt(relaySeq)},
               edited_at = ${now}
         WHERE id = ${messageIdToUpdate}::uuid
      `;
      runtime?.broadcast({
        type: 'chat:edit',
        payload: {
          messageId: messageIdToUpdate,
          content,
          username: '[EVENT] FCM',
          metadata,
          source: EVENT_SOURCE,
          channelId: UUID_EVENTS,
          userId: botUser.id,
          relaySeq,
          editedAt: now.toISOString(),
          createdAt: existingProjection.created_at.toISOString(),
        },
      });
      return messageIdToUpdate;
    }
  }

  const messageId = uuidv4();
  const relaySeq = await nextRelaySeq();
  await persistMessage({
    id: messageId,
    content,
    userId: botUser.id,
    channelId: UUID_EVENTS,
    source: EVENT_SOURCE,
    createdAt: now,
    metadata,
    relaySeq,
  });
  runtime?.broadcast({
    type: 'chat:message',
    payload: {
      id: messageId,
      content,
      username: '[EVENT] FCM',
      userId: botUser.id,
      channelId: UUID_EVENTS,
      source: EVENT_SOURCE,
      timestamp: now.toISOString(),
      createdAt: now.toISOString(),
      metadata,
      relaySeq,
    },
  });
  return messageId;
}

async function reconcileSubscribers(event: GuildScheduledEvent, mirrorId: string): Promise<SubscriberReconciliation> {
  const beforeRows = await prisma.discordEventSubscriber.findMany({
    where: { mirrorId },
    select: { discordUserId: true, linkedFcmUserId: true },
  });
  const discordUserIds: string[] = [];
  let after: string | undefined;
  const pageSize = 100;
  // discord.js 14.27 forwards `after` to Discord's documented endpoint even
  // though the public TypeScript option omits it. Do not replace the mirror
  // set until every page has been fetched successfully.
  for (;;) {
    const options = {
      limit: pageSize,
      ...(after ? { after } : {}),
    } as Parameters<GuildScheduledEvent['fetchSubscribers']>[0];
    const page = await event.fetchSubscribers(options);
    const pageIds = [...page.values()]
      .map((entry) => entry.user.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    discordUserIds.push(...pageIds);
    if (pageIds.length < pageSize) break;
    const nextAfter = pageIds[pageIds.length - 1];
    if (!nextAfter || nextAfter === after) {
      throw new Error('Discord scheduled-event subscriber pagination did not advance');
    }
    after = nextAfter;
  }
  const currentDiscordUserIds = [...new Set(discordUserIds)];
  const linkedUsers = currentDiscordUserIds.length === 0
    ? []
    : await prisma.user.findMany({
      where: { discordId: { in: currentDiscordUserIds } },
      select: { id: true, discordId: true },
    });
  const linkedByDiscordId = new Map(
    linkedUsers.flatMap((user) => user.discordId ? [[user.discordId, user.id] as const] : []),
  );
  const syncedAt = new Date();

  await prisma.$transaction(async (tx) => {
    for (const discordUserId of currentDiscordUserIds) {
      await tx.discordEventSubscriber.upsert({
        where: { mirrorId_discordUserId: { mirrorId, discordUserId } },
        update: {
          linkedFcmUserId: linkedByDiscordId.get(discordUserId) ?? null,
          lastSyncedAt: syncedAt,
        },
        create: {
          mirrorId,
          discordUserId,
          linkedFcmUserId: linkedByDiscordId.get(discordUserId) ?? null,
          subscribedAt: syncedAt,
          lastSyncedAt: syncedAt,
        },
      });
    }
    await tx.discordEventSubscriber.deleteMany({
      where: {
        mirrorId,
        ...(currentDiscordUserIds.length > 0 ? { discordUserId: { notIn: currentDiscordUserIds } } : {}),
      },
    });
  });
  const beforeByDiscordId = new Map(beforeRows.map((row) => [row.discordUserId, row.linkedFcmUserId]));
  const currentSet = new Set(currentDiscordUserIds);
  const viewerChanges: SubscriberReconciliation['viewerChanges'] = [];
  for (const row of beforeRows) {
    if (!currentSet.has(row.discordUserId) && row.linkedFcmUserId) {
      viewerChanges.push({ userId: row.linkedFcmUserId, isViewerInterested: false });
    }
  }
  for (const discordUserId of currentDiscordUserIds) {
    const linkedFcmUserId = linkedByDiscordId.get(discordUserId) ?? null;
    const previousLinkedFcmUserId = beforeByDiscordId.get(discordUserId) ?? null;
    if (previousLinkedFcmUserId && previousLinkedFcmUserId !== linkedFcmUserId) {
      viewerChanges.push({ userId: previousLinkedFcmUserId, isViewerInterested: false });
    }
    if (linkedFcmUserId && previousLinkedFcmUserId !== linkedFcmUserId) {
      viewerChanges.push({ userId: linkedFcmUserId, isViewerInterested: true });
    }
  }
  return {
    interestedCount: currentDiscordUserIds.length,
    previousInterestedCount: beforeRows.length,
    viewerChanges,
  };
}

async function broadcastViewerChanges(
  eventCode: string,
  status: PublicEventStatus,
  changes: SubscriberReconciliation['viewerChanges'],
): Promise<void> {
  if (!runtime) return;
  for (const change of changes) {
    await runtime.broadcastToUsers({
      type: 'event:attendance-viewer',
      payload: { eventCode, status, isViewerInterested: change.isViewerInterested },
    }, [change.userId]);
  }
}

async function eventById(scheduledEventId: string): Promise<GuildScheduledEvent | null> {
  if (!runtime) return null;
  const guild = await runtime.client.guilds.fetch(env.DISCORD_SERVER_ID);
  try {
    return await guild.scheduledEvents.fetch({ guildScheduledEvent: scheduledEventId, withUserCount: true });
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    const status = typeof err === 'object' && err !== null && 'status' in err ? err.status : undefined;
    if (code === 10070 || status === 404) return null;
    throw err;
  }
}

async function appendAnnouncementLink(
  event: GuildScheduledEvent,
  snapshot: EventSourceSnapshot,
  announcementUrl: string,
  previousGeneratedSuffix?: string | null,
): Promise<void> {
  const creatorDescription = sourceDescription(event, previousGeneratedSuffix);
  const unboundedDescription = appendOrReplaceEventDetailsSuffix(
    event.description ?? '',
    snapshot.eventCode,
    announcementUrl,
    previousGeneratedSuffix ?? undefined,
  );
  const nextDescription = appendOrReplaceEventDetailsSuffix(
    event.description ?? '',
    snapshot.eventCode,
    announcementUrl,
    previousGeneratedSuffix ?? undefined,
    DISCORD_DESCRIPTION_LIMIT,
  );
  const suffix = `FCM event details [${snapshot.eventCode}]: ${announcementUrl}`;
  if (unboundedDescription.length > DISCORD_DESCRIPTION_LIMIT) {
    logger.warn({ eventCode: snapshot.eventCode, announcementUrl }, '[discord-events] creator description is too long for generated FCM link; preserving creator text and retaining repair URL');
    if (event.description !== creatorDescription) {
      try {
        // Remove only the previously generated suffix when replacement no
        // longer fits. Never leave a stale announcement URL in creator text.
        await event.edit({ description: creatorDescription });
      } catch (err) {
        logger.warn({ err, eventCode: snapshot.eventCode }, '[discord-events] could not remove stale generated description suffix during overflow repair');
      }
    }
    await prisma.discordEventMirror.update({
      where: { guildId_scheduledEventId: { guildId: snapshot.guildId, scheduledEventId: snapshot.scheduledEventId } },
      data: { generatedDescriptionLink: suffix },
    });
    return;
  }
  if (nextDescription === (event.description ?? '')) return;

  try {
    await event.edit({ description: nextDescription });
    await prisma.discordEventMirror.update({
      where: { guildId_scheduledEventId: { guildId: snapshot.guildId, scheduledEventId: snapshot.scheduledEventId } },
      data: { generatedDescriptionLink: suffix },
    });
  } catch (err) {
    logger.warn({ err, eventCode: snapshot.eventCode }, '[discord-events] failed to append FCM announcement link; will retry');
  }
}

async function syncEvent(event: GuildScheduledEvent): Promise<void> {
  if (!runtime || event.guildId !== env.DISCORD_SERVER_ID) return;
  const existing = await prisma.discordEventMirror.findUnique({
    where: { guildId_scheduledEventId: { guildId: event.guildId, scheduledEventId: event.id } },
  });
  const state = sourceStateFromDiscordStatus(event.status);
  if (existing && shouldIgnoreStaleState(existing.sourceStatus, state)) {
    logger.debug({ eventId: event.id, existing: existing.sourceStatus, incoming: state }, '[discord-events] ignored stale lifecycle update');
    return;
  }

  const mirroredSubscriberCount = existing
    ? await prisma.discordEventSubscriber.count({ where: { mirrorId: existing.id } })
    : 0;
  let interestedCount = Math.max(0, Math.floor(event.userCount ?? existing?.finalInterestedCount ?? mirroredSubscriberCount));
  let snapshot = eventSnapshot(event, interestedCount, existing?.generatedDescriptionLink);
  let mirror = await prisma.discordEventMirror.upsert({
    where: { guildId_scheduledEventId: { guildId: snapshot.guildId, scheduledEventId: snapshot.scheduledEventId } },
    update: {
      eventCode: snapshot.eventCode,
      sourceStatus: snapshot.sourceState,
      sourceName: snapshot.name,
      sourceStartUtc: snapshot.startUtc ? new Date(snapshot.startUtc) : null,
      sourceEndUtc: snapshot.endUtc ? new Date(snapshot.endUtc) : null,
      sourceLocation: snapshot.location,
      sourceDescriptionSummary: descriptionSummary(snapshot.creatorDescription),
      sourceDiscordEventUrl: snapshot.discordEventUrl,
      finalInterestedCount: snapshot.terminal ? snapshot.interestedCount : null,
      sourceFingerprint: snapshot.sourceFingerprint,
      lastSyncedAt: new Date(),
    },
    create: {
      guildId: snapshot.guildId,
      scheduledEventId: snapshot.scheduledEventId,
      eventCode: snapshot.eventCode,
      announcementChannelId: env.DISCORD_EVENTS_CHANNEL_ID,
      sourceStatus: snapshot.sourceState,
      sourceName: snapshot.name,
      sourceStartUtc: snapshot.startUtc ? new Date(snapshot.startUtc) : null,
      sourceEndUtc: snapshot.endUtc ? new Date(snapshot.endUtc) : null,
      sourceLocation: snapshot.location,
      sourceDescriptionSummary: descriptionSummary(snapshot.creatorDescription),
      sourceDiscordEventUrl: snapshot.discordEventUrl,
      finalInterestedCount: snapshot.terminal ? snapshot.interestedCount : null,
      sourceFingerprint: snapshot.sourceFingerprint,
      lastSyncedAt: new Date(),
    },
  });

  if (mirror.announcementChannelId !== env.DISCORD_EVENTS_CHANNEL_ID) {
    logger.error({
      eventCode: snapshot.eventCode,
      storedChannelId: mirror.announcementChannelId,
      configuredChannelId: env.DISCORD_EVENTS_CHANNEL_ID,
    }, '[discord-events] mirror channel is immutable; refusing to create a second announcement after configuration drift');
    return;
  }

  if (state === 'SCHEDULED' || state === 'ACTIVE') {
    try {
      const reconciliation = await reconcileSubscribers(event, mirror.id);
      interestedCount = reconciliation.interestedCount;
      snapshot = eventSnapshot(event, interestedCount, existing?.generatedDescriptionLink);
      mirror = await prisma.discordEventMirror.update({
        where: { id: mirror.id },
        data: {
          sourceStatus: snapshot.sourceState,
          sourceName: snapshot.name,
          sourceStartUtc: snapshot.startUtc ? new Date(snapshot.startUtc) : null,
          sourceEndUtc: snapshot.endUtc ? new Date(snapshot.endUtc) : null,
          sourceLocation: snapshot.location,
          sourceDescriptionSummary: descriptionSummary(snapshot.creatorDescription),
          sourceDiscordEventUrl: snapshot.discordEventUrl,
          finalInterestedCount: null,
          sourceFingerprint: snapshot.sourceFingerprint,
          lastSyncedAt: new Date(),
        },
      });
      await broadcastViewerChanges(snapshot.eventCode, snapshot.publicStatus, reconciliation.viewerChanges);
      if (reconciliation.interestedCount !== reconciliation.previousInterestedCount) {
        runtime.broadcast({
          type: BROADCAST_EVENT_UPDATE,
          payload: {
            eventCode: snapshot.eventCode,
            status: snapshot.publicStatus,
            interestedCount: reconciliation.interestedCount,
            updatedFields: ['interestedCount'],
          },
        });
      }
    } catch (err) {
      // The mirror is still useful when a transient permissions/rate-limit error
      // prevents the subscriber endpoint from responding; the next reconciliation
      // retries it and the persisted count never contains attendee identities.
      logger.warn({ err, eventCode: snapshot.eventCode }, '[discord-events] subscriber reconciliation failed; retaining last known count');
      interestedCount = existing?.finalInterestedCount ?? mirroredSubscriberCount ?? interestedCount;
      snapshot = eventSnapshot(event, interestedCount);
    }
  }

  const announcement = await ensureAnnouncement(snapshot, mirror.announcementMessageId);
  const announcementUrl = validHttpUrl(announcement.url) ?? announcement.url;
  const fcmMessageId = await updateFcmProjection(mirror.id, snapshot, announcementUrl, mirror.fcmMessageId);
  const updatedMirror = await prisma.discordEventMirror.update({
    where: { id: mirror.id },
    data: {
      announcementMessageId: announcement.id,
      announcementUrl,
      fcmMessageId,
    },
  });

  if (snapshot.publicStatus !== 'Deleted') {
    await appendAnnouncementLink(event, snapshot, announcementUrl, mirror.generatedDescriptionLink);
  }
  if (updatedMirror.sourceFingerprint !== snapshot.sourceFingerprint) {
    logger.debug({ eventCode: snapshot.eventCode }, '[discord-events] projection source fingerprint changed during repair');
  }
}

async function markDeleted(scheduledEventId: string): Promise<void> {
  if (!runtime) return;
  const mirror = await prisma.discordEventMirror.findUnique({
    where: { guildId_scheduledEventId: { guildId: env.DISCORD_SERVER_ID, scheduledEventId } },
  });
  if (!mirror || mirror.sourceStatus === 'DELETED') return;

  const mirroredSubscriberCount = await prisma.discordEventSubscriber.count({ where: { mirrorId: mirror.id } });
  const stored = mirror.fcmMessageId ? await readStoredProjection(mirror.fcmMessageId) : null;
  const existingMetadata = stored?.metadata;
  const metadata = stored && existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
    ? existingMetadata as Partial<EventProjectionMetadata>
    : {};
  const eventCode = typeof metadata.eventCode === 'string' ? metadata.eventCode : mirror.eventCode;
  const interestedCount = Math.max(0, Math.floor(
    mirror.finalInterestedCount
      ?? (typeof metadata.interestedCount === 'number' ? metadata.interestedCount : mirroredSubscriberCount),
  ));
  const snapshot: EventSourceSnapshot = {
    guildId: env.DISCORD_SERVER_ID,
    scheduledEventId,
    eventCode,
    sourceState: 'DELETED',
    publicStatus: 'Deleted',
    terminal: true,
    name: typeof metadata.name === 'string' ? metadata.name : mirror.sourceName ?? `Event ${eventCode}`,
    creatorDescription: typeof metadata.descriptionSummary === 'string'
      ? metadata.descriptionSummary
      : mirror.sourceDescriptionSummary ?? '',
    startUtc: typeof metadata.startUtc === 'string'
      ? metadata.startUtc
      : mirror.sourceStartUtc?.toISOString() ?? null,
    endUtc: typeof metadata.endUtc === 'string'
      ? metadata.endUtc
      : mirror.sourceEndUtc?.toISOString() ?? null,
    location: typeof metadata.location === 'string' ? metadata.location : mirror.sourceLocation,
    discordEventUrl: validHttpUrl(typeof metadata.discordEventUrl === 'string' ? metadata.discordEventUrl : mirror.sourceDiscordEventUrl)
      ?? `https://discord.com/events/${env.DISCORD_SERVER_ID}/${scheduledEventId}`,
    imageUrl: null,
    sourceFingerprint: mirror.sourceFingerprint ?? '',
    interestedCount,
  };

  const fcmMessageId = await updateFcmProjection(mirror.id, snapshot, mirror.announcementUrl, mirror.fcmMessageId);
  let announcementMessageId = mirror.announcementMessageId;
  let announcementUrl = mirror.announcementUrl;
  if (mirror.announcementChannelId === env.DISCORD_EVENTS_CHANNEL_ID) {
    try {
      const announcement = await ensureAnnouncement(snapshot, mirror.announcementMessageId);
      announcementMessageId = announcement.id;
      announcementUrl = validHttpUrl(announcement.url) ?? announcement.url;
    } catch (err) {
      logger.warn({ err, eventCode }, '[discord-events] retained Deleted FCM projection but could not update Discord announcement');
      // Keep the mirror non-terminal until the known announcement repair has
      // succeeded. Reconciliation will retry it; otherwise a partial delete
      // could become invisible to the repair pass after source removal.
      await prisma.discordEventMirror.update({
        where: { id: mirror.id },
        data: {
          fcmMessageId,
          announcementMessageId,
          announcementUrl,
          lastSyncedAt: new Date(),
        },
      });
      return;
    }
  } else {
    logger.error({ eventCode, channelId: mirror.announcementChannelId }, '[discord-events] skipped Deleted announcement repair because mirror channel differs from configured channel');
    await prisma.discordEventMirror.update({
      where: { id: mirror.id },
      data: { fcmMessageId, lastSyncedAt: new Date() },
    });
    return;
  }

  await prisma.discordEventMirror.update({
    where: { id: mirror.id },
    data: {
      sourceStatus: 'DELETED',
      finalInterestedCount: interestedCount,
      fcmMessageId,
      announcementMessageId,
      announcementUrl,
    },
  });
}

async function syncEventById(scheduledEventId: string): Promise<void> {
  const event = await eventById(scheduledEventId);
  if (!event) {
    await markDeleted(scheduledEventId);
    return;
  }
  await syncEvent(event);
}

function queueEventSync(scheduledEventId: string): Promise<void> {
  if (!runtime) return Promise.resolve();
  const prior = runtime.queuedSyncs.get(scheduledEventId) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => syncEventById(scheduledEventId))
    .catch((err) => logger.warn({ err, scheduledEventId }, '[discord-events] event sync failed; reconciliation will retry'));
  runtime.queuedSyncs.set(scheduledEventId, next);
  void next.finally(() => {
    if (runtime?.queuedSyncs.get(scheduledEventId) === next) runtime.queuedSyncs.delete(scheduledEventId);
  });
  return next;
}

async function syncSubscriberChange(eventRef: GuildScheduledEvent | PartialGuildScheduledEvent, user: User, subscribed: boolean): Promise<void> {
  if (!runtime || eventRef.guildId !== env.DISCORD_SERVER_ID || user.bot) return;
  const mirror = await prisma.discordEventMirror.findUnique({
    where: { guildId_scheduledEventId: { guildId: env.DISCORD_SERVER_ID, scheduledEventId: eventRef.id } },
  });
  if (!mirror || terminalState(mirror.sourceStatus)) return;

  const linked = await prisma.user.findFirst({ where: { discordId: user.id }, select: { id: true } });
  const now = new Date();
  if (subscribed) {
    await prisma.discordEventSubscriber.upsert({
      where: { mirrorId_discordUserId: { mirrorId: mirror.id, discordUserId: user.id } },
      update: { linkedFcmUserId: linked?.id ?? null, lastSyncedAt: now },
      create: {
        mirrorId: mirror.id,
        discordUserId: user.id,
        linkedFcmUserId: linked?.id ?? null,
        subscribedAt: now,
        lastSyncedAt: now,
      },
    });
  } else {
    await prisma.discordEventSubscriber.deleteMany({ where: { mirrorId: mirror.id, discordUserId: user.id } });
  }

  await queueEventSync(eventRef.id);
  const current = await prisma.discordEventMirror.findUnique({
    where: { guildId_scheduledEventId: { guildId: env.DISCORD_SERVER_ID, scheduledEventId: eventRef.id } },
    select: { id: true, eventCode: true, sourceStatus: true },
  });
  if (!current) return;
  const interestedCount = await prisma.discordEventSubscriber.count({ where: { mirrorId: current.id } });
  const lifecycle = mapDiscordEventLifecycle(current.sourceStatus as DiscordEventSourceState);
  runtime.broadcast({
    type: BROADCAST_EVENT_UPDATE,
    payload: {
      eventCode: current.eventCode,
      status: lifecycle.status,
      interestedCount,
      updatedFields: ['interestedCount'],
    },
  });
  if (linked?.id) {
    await runtime.broadcastToUsers({
      type: 'event:attendance-viewer',
      payload: {
        eventCode: current.eventCode,
        status: lifecycle.status,
        isViewerInterested: subscribed,
      },
    }, [linked.id]);
  }
}

async function reconcileGuild(): Promise<void> {
  if (!runtime || !runtime.eventChannel) return;
  if (runtime.reconciliationInFlight) return runtime.reconciliationInFlight;
  runtime.reconciliationInFlight = (async () => {
    const guild = await runtime!.client.guilds.fetch(env.DISCORD_SERVER_ID);
    const sourceEvents = await guild.scheduledEvents.fetch({ withUserCount: true });
    const seenIds = new Set<string>();
    for (const event of sourceEvents.values()) {
      seenIds.add(event.id);
      queueEventSync(event.id);
    }
    const mirrors = await prisma.discordEventMirror.findMany({
      where: { guildId: env.DISCORD_SERVER_ID, sourceStatus: { not: 'DELETED' } },
      select: { scheduledEventId: true },
    });
    for (const mirror of mirrors) {
      if (!seenIds.has(mirror.scheduledEventId)) await markDeleted(mirror.scheduledEventId);
    }
    await Promise.all([...runtime.queuedSyncs.values()]);
  })()
    .catch((err) => logger.warn({ err }, '[discord-events] reconciliation failed; bounded retry will run later'))
    .finally(() => {
      if (runtime) runtime.reconciliationInFlight = null;
    });
  return runtime.reconciliationInFlight;
}

async function validateAndReconcile(): Promise<void> {
  if (!runtime) return;
  try {
    runtime.eventChannel = await configuredEventChannel(runtime.client);
    await reconcileGuild();
  } catch (err) {
    runtime.eventChannel = null;
    logger.error({ err, guildId: env.DISCORD_SERVER_ID, channelId: env.DISCORD_EVENTS_CHANNEL_ID }, '[discord-events] configuration or permission validation failed; event mirroring is waiting for repair');
  }
}

export function register(client: Client, broadcast: Broadcast, broadcastToUsers: BroadcastToUsers): void {
  runtime = {
    client,
    broadcast,
    broadcastToUsers,
    eventChannel: null,
    reconcileTimer: null,
    reconciliationInFlight: null,
    queuedSyncs: new Map(),
  };

  client.on('ready', () => {
    void validateAndReconcile();
    if (runtime?.reconcileTimer === null) {
      // Revalidate channel ownership/permissions on every bounded pass so a
      // deployment that starts degraded can recover without a process restart.
      runtime.reconcileTimer = setInterval(() => { void validateAndReconcile(); }, RECONCILE_INTERVAL_MS);
      runtime.reconcileTimer.unref();
    }
  });
  client.on('guildScheduledEventCreate', (event) => queueEventSync(event.id));
  client.on('guildScheduledEventUpdate', (_oldEvent, event) => queueEventSync(event.id));
  client.on('guildScheduledEventDelete', (event) => {
    if (event.guildId === env.DISCORD_SERVER_ID) {
      void markDeleted(event.id).catch((err) => logger.warn({ err, eventId: event.id }, '[discord-events] delete projection failed'));
    }
  });
  client.on('guildScheduledEventUserAdd', (event, user) => {
    void syncSubscriberChange(event, user, true).catch((err) => logger.warn({ err, eventId: event.id, userId: user.id }, '[discord-events] subscriber add failed'));
  });
  client.on('guildScheduledEventUserRemove', (event, user) => {
    void syncSubscriberChange(event, user, false).catch((err) => logger.warn({ err, eventId: event.id, userId: user.id }, '[discord-events] subscriber remove failed'));
  });
}

export function _resetForTests(): void {
  if (runtime?.reconcileTimer) clearInterval(runtime.reconcileTimer);
  runtime = null;
}

export { stableEventCode };

module.exports = { register, _resetForTests, stableEventCode };
