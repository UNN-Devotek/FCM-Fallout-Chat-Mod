/**
 * Pure projections for Discord Scheduled Events.
 *
 * This module deliberately has no Discord, Prisma, WebSocket, or environment
 * dependencies. Runtime integrations can use these helpers without coupling
 * projection behavior to an external service.
 */

import { createHash } from 'node:crypto';

export const DISCORD_EVENT_SOURCE_STATES = {
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  CANCELED: 'CANCELED',
  /**
   * Synthetic state used after Discord emits a delete notification.
   */
  DELETED: 'DELETED',
} as const;

export type DiscordEventSourceState =
  typeof DISCORD_EVENT_SOURCE_STATES[keyof typeof DISCORD_EVENT_SOURCE_STATES];

/**
 * Stable, guild-scoped public identifier for a Discord scheduled event.
 * Keeping the guild in the digest prevents the same Discord event snowflake
 * from colliding if records from multiple guilds ever share a database.
 */
export function stableDiscordEventCode(guildId: string, scheduledEventId: string): string {
  const digest = createHash('sha256')
    .update(`${guildId}:${scheduledEventId}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `EVT-${digest}`;
}

export const PUBLIC_EVENT_STATUSES = {
  UPCOMING: 'Upcoming',
  LIVE: 'Live',
  ENDED: 'Ended',
  CANCELED: 'Canceled',
  DELETED: 'Deleted',
} as const;

export type PublicEventStatus =
  typeof PUBLIC_EVENT_STATUSES[keyof typeof PUBLIC_EVENT_STATUSES];

export const PUBLIC_EVENT_STATUS_BY_SOURCE = {
  SCHEDULED: PUBLIC_EVENT_STATUSES.UPCOMING,
  ACTIVE: PUBLIC_EVENT_STATUSES.LIVE,
  COMPLETED: PUBLIC_EVENT_STATUSES.ENDED,
  CANCELED: PUBLIC_EVENT_STATUSES.CANCELED,
  DELETED: PUBLIC_EVENT_STATUSES.DELETED,
} as const satisfies Record<DiscordEventSourceState, PublicEventStatus>;

export interface PublicEventLifecycle {
  readonly status: PublicEventStatus;
  readonly isTerminal: boolean;
}

const unreachable = (value: never): never => {
  throw new Error('Unhandled Discord event state: ' + String(value));
};

/**
 * Map a Discord source state to the public FCM label and terminal behavior.
 */
export function mapDiscordEventLifecycle(
  sourceState: DiscordEventSourceState,
): PublicEventLifecycle {
  switch (sourceState) {
    case DISCORD_EVENT_SOURCE_STATES.SCHEDULED:
      return { status: PUBLIC_EVENT_STATUSES.UPCOMING, isTerminal: false };
    case DISCORD_EVENT_SOURCE_STATES.ACTIVE:
      return { status: PUBLIC_EVENT_STATUSES.LIVE, isTerminal: false };
    case DISCORD_EVENT_SOURCE_STATES.COMPLETED:
      return { status: PUBLIC_EVENT_STATUSES.ENDED, isTerminal: true };
    case DISCORD_EVENT_SOURCE_STATES.CANCELED:
      return { status: PUBLIC_EVENT_STATUSES.CANCELED, isTerminal: true };
    case DISCORD_EVENT_SOURCE_STATES.DELETED:
      return { status: PUBLIC_EVENT_STATUSES.DELETED, isTerminal: true };
    default:
      return unreachable(sourceState);
  }
}

/**
 * Return whether a public event record is final and must be read-only.
 */
export function isTerminalPublicEventStatus(status: PublicEventStatus): boolean {
  switch (status) {
    case PUBLIC_EVENT_STATUSES.UPCOMING:
    case PUBLIC_EVENT_STATUSES.LIVE:
      return false;
    case PUBLIC_EVENT_STATUSES.ENDED:
    case PUBLIC_EVENT_STATUSES.CANCELED:
    case PUBLIC_EVENT_STATUSES.DELETED:
      return true;
    default:
      return unreachable(status);
  }
}

const isValidAnnouncementMessageUrl = (value: string): boolean => {
  if (value.length === 0 || value.trim() !== value) {
    return false;
  }

  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.hostname.length > 0
      && !value.includes('<')
      && !value.includes('>');
  } catch {
    return false;
  }
};

const isValidEventCode = (value: string): boolean =>
  value.length > 0
  && value.trim() === value
  && !value.includes('\r')
  && !value.includes('\n')
  && !value.includes(']');

const GENERATED_EVENT_DETAILS_SUFFIX =
  /^FCM event details \[[^\r\n\]]+\]: (https?:\/\/[^\s\r\n]+)$/;
const GENERATED_SUFFIX_SEPARATORS = ['\n\n', '\r\n\r\n'] as const;

const isValidGeneratedEventDetailsSuffix = (value: string): boolean => {
  const match = GENERATED_EVENT_DETAILS_SUFFIX.exec(value);
  const url = match?.[1];
  return url !== undefined && isValidAnnouncementMessageUrl(url);
};

/**
 * Remove one exact, previously stored generated suffix.
 *
 * previousGeneratedSuffix is the suffix text itself, without its separating
 * blank line. Suffix-looking creator text is left untouched when it does not
 * exactly match this explicit state.
 */
export function stripExactGeneratedEventDetailsSuffix(
  description: string,
  previousGeneratedSuffix: string,
): string {
  if (!isValidGeneratedEventDetailsSuffix(previousGeneratedSuffix)) {
    return description;
  }

  if (description === previousGeneratedSuffix) {
    return '';
  }

  for (const separator of GENERATED_SUFFIX_SEPARATORS) {
    const marker = separator + previousGeneratedSuffix;
    if (description.endsWith(marker)) {
      return description.slice(0, description.length - marker.length);
    }
  }

  return description;
}

const hasExactGeneratedEventDetailsSuffix = (
  description: string,
  generatedSuffix: string,
): boolean => description === generatedSuffix
  || GENERATED_SUFFIX_SEPARATORS.some(
    (separator) => description.endsWith(separator + generatedSuffix),
  );

const exceedsDescriptionLength = (
  description: string,
  maxDescriptionLength: number | undefined,
): boolean => maxDescriptionLength !== undefined
  && (
    !Number.isFinite(maxDescriptionLength)
    || maxDescriptionLength < 0
    || description.length > Math.floor(maxDescriptionLength)
  );

/**
 * Append or replace exactly one generated event-details suffix.
 *
 * Invalid or placeholder-like URLs leave the original description untouched,
 * so a failed announcement post can never publish a dead link.
 *
 * Without previousGeneratedSuffix, suffix-looking text is creator content.
 * maxDescriptionLength applies to the complete generated description; an
 * overflow returns the creator description unchanged.
 */
export function appendOrReplaceEventDetailsSuffix(
  description: string,
  eventCode: string,
  announcementMessageUrl: string,
  previousGeneratedSuffix?: string,
  maxDescriptionLength?: number,
): string {
  if (!isValidEventCode(eventCode) || !isValidAnnouncementMessageUrl(announcementMessageUrl)) {
    return description;
  }

  const generatedSuffix =
    'FCM event details [' + eventCode + ']: ' + announcementMessageUrl;
  if (hasExactGeneratedEventDetailsSuffix(description, generatedSuffix)) {
    return description;
  }

  const creatorDescription = previousGeneratedSuffix === undefined
    ? description
    : stripExactGeneratedEventDetailsSuffix(description, previousGeneratedSuffix);
  const nextDescription = creatorDescription.length === 0
    ? generatedSuffix
    : creatorDescription + '\n\n' + generatedSuffix;

  return exceedsDescriptionLength(nextDescription, maxDescriptionLength)
    ? creatorDescription
    : nextDescription;
}

export const HUD_EVENT_MAX_LINE_LENGTH = 70;
const HUD_EVENT_PREFIX = '[EVENTS] [EVENT] FCM: ';

/**
 * Match the existing hudFeedService.zfeSafe rules without importing its
 * Prisma-backed module. The event row is the content field of FCMHUD/1.
 */
export function escapeHudEventText(value: string): string {
  return value
    .replace(/"/g, '‘')
    .replace(/\\/g, '/')
    .replace(/\|/g, '¦')
    .replace(/~/g, '∼')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/&/g, '+')
    .replace(/[\r\n]+/g, ' ');
}

const formatUpcomingTime = (startUtc: string | null | undefined): string => {
  const date = new Date(startUtc ?? '');
  if (Number.isNaN(date.getTime())) {
    return 'UPCOMING';
  }

  return String(date.getUTCHours()).padStart(2, '0')
    + ':'
    + String(date.getUTCMinutes()).padStart(2, '0')
    + ' UTC';
};

const formatHudStatusOrTime = (
  status: PublicEventStatus,
  startUtc: string | null | undefined,
): string => {
  switch (status) {
    case PUBLIC_EVENT_STATUSES.UPCOMING:
      return formatUpcomingTime(startUtc);
    case PUBLIC_EVENT_STATUSES.LIVE:
      return 'LIVE';
    case PUBLIC_EVENT_STATUSES.ENDED:
      return 'ENDED';
    case PUBLIC_EVENT_STATUSES.CANCELED:
      return 'CANCELED';
    case PUBLIC_EVENT_STATUSES.DELETED:
      return 'DELETED';
    default:
      return unreachable(status);
  }
};

const formatInterestedCount = (count: number): string => {
  if (!Number.isFinite(count) || count < 0) {
    return '0';
  }

  const wholeCount = Math.floor(count);
  const text = String(wholeCount);
  return text.length <= 9 ? text : '999999999+';
};

const truncateEventName = (name: string, maxLength: number): string => {
  if (name.length <= maxLength) {
    return name;
  }

  if (maxLength <= 3) {
    return name.slice(0, maxLength);
  }

  return name.slice(0, maxLength - 3) + '...';
};

export interface CompactHudEventInput {
  readonly name: string;
  readonly status: PublicEventStatus;
  readonly startUtc?: string | null;
  readonly interestedCount: number;
  readonly eventCode?: string | null;
}

/**
 * Build an informational FCMHUD/1 event row.
 *
 * Status/time and Interested count are fixed before the event name is fitted
 * into the 70-character content budget. HUD attendance remains read-only.
 */
export function buildCompactHudEventRow(input: CompactHudEventInput): string {
  const safeName = escapeHudEventText(input.name);
  const statusOrTime = formatHudStatusOrTime(input.status, input.startUtc);
  const interestedCount = formatInterestedCount(input.interestedCount);
  const suffix =
    ' | ' + statusOrTime + ' | ' + interestedCount + ' interested';
  const nameBudgetWithoutEventCode =
    HUD_EVENT_MAX_LINE_LENGTH - HUD_EVENT_PREFIX.length - suffix.length;
  const safeEventCode = input.eventCode === undefined || input.eventCode === null
    ? ''
    : escapeHudEventText(input.eventCode);
  const eventCodeToken = safeEventCode.length === 0
    ? ''
    : ' [' + safeEventCode + ']';

  if (eventCodeToken.length > 0) {
    const nameBudgetWithEventCode =
      HUD_EVENT_MAX_LINE_LENGTH
      - HUD_EVENT_PREFIX.length
      - eventCodeToken.length
      - suffix.length;
    if (nameBudgetWithEventCode >= 0) {
      const fittedName = truncateEventName(safeName, nameBudgetWithEventCode);
      return HUD_EVENT_PREFIX + fittedName + eventCodeToken + suffix;
    }
  }

  const fittedName = truncateEventName(
    safeName,
    Math.max(0, nameBudgetWithoutEventCode),
  );
  return HUD_EVENT_PREFIX + fittedName + suffix;
}
