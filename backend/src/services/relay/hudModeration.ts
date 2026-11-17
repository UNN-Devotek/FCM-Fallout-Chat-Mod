/**
 * hudModeration.ts — pure helpers for the chat.v1 `moderationAction` relay op.
 *
 * WHY AN ENVELOPE
 *
 * ZFE builds each native request frame itself and only the documented members are known to
 * survive (`action`, `messageId`, `targetUserId`, `reason`). A newer additive member such as
 * `durationMinutes` may be dropped before it reaches the relay. A timed in-game ban therefore
 * cannot rely on that member. The widget mirrors its duration, explicit permanent flag, or
 * by-name unban/unmute target into the otherwise unused `messageId` member of account-level
 * actions, using the `FCMMOD/1;` envelope:
 *
 *   FCMMOD/1;d=1440      timed ban/mute in minutes
 *   FCMMOD/1;p=1         explicit permanent ban
 *   FCMMOD/1;n=<name>    by-name unban/unmute target (URI-encoded)
 *
 * The JSON members (`durationMinutes`, `permanent`, `targetName`) remain authoritative when
 * present so raw relay clients keep the plain contract. A ban never becomes permanent because
 * a duration was lost: it needs a positive duration or an explicit permanent flag.
 *
 * Remote deletions reach native HUD subscribers as a private `system` chat.message whose body is
 * `FCMDEL/1;m=<messageId>` — the same carrier shape as the existing FCMACK/FCMCTL control events.
 * Only widgets that negotiated MIN_HUD_MODERATION_EVENTS_VERSION receive it, because older widgets
 * treat an unknown system body as a link notice.
 */

import { deinterleaveZfeNulEscapes } from './wireSanitize';

export const HUD_MODERATION_ENVELOPE_PREFIX = 'FCMMOD/1;';
export const HUD_DELETE_EVENT_PREFIX = 'FCMDEL/1;';
/** Matches the widget's 1-minute to 30-day range for mutes and timed bans. */
export const MAX_MODERATION_MINUTES = 30 * 24 * 60;
/** Relay fallback for a mute from a raw client that sends no duration. */
export const DEFAULT_MUTE_MINUTES = 10;

export const RELAY_MODERATION_ACTIONS: ReadonlySet<string> = new Set([
  'deleteMessage', 'kickUser', 'muteUser', 'unmuteUser', 'banUser', 'unbanUser', 'setSlowMode',
]);

export interface ModerationEnvelope {
  minutes?: number;
  permanent?: boolean;
  targetName?: string;
}

/** Parse an `FCMMOD/1;` envelope. Unknown keys are ignored; malformed values are omitted. */
export function parseModerationEnvelope(raw: unknown): ModerationEnvelope | null {
  if (typeof raw !== 'string' || !raw.startsWith(HUD_MODERATION_ENVELOPE_PREFIX)) return null;
  const result: ModerationEnvelope = {};
  for (const field of raw.slice(HUD_MODERATION_ENVELOPE_PREFIX.length).split(';')) {
    const eq = field.indexOf('=');
    if (eq <= 0) continue;
    const key = field.slice(0, eq);
    let value: string;
    try { value = decodeURIComponent(field.slice(eq + 1)); } catch { continue; }
    if (key === 'd') {
      // Keep the raw value: validation (and its error) belongs to resolveModerationDuration.
      result.minutes = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
    } else if (key === 'p') {
      result.permanent = value === '1';
    } else if (key === 'n') {
      const name = value.trim();
      if (name && name.length <= 64) result.targetName = name;
    }
  }
  return result;
}

export type DurationResult =
  | { ok: true; minutes: number | null }
  | { ok: false; message: string };

function readMinutes(frame: Record<string, unknown>, envelope: ModerationEnvelope | null): number | undefined | 'invalid' {
  let raw: unknown = frame.durationMinutes;
  if (raw === undefined && typeof frame.durationHours === 'number') raw = frame.durationHours * 60;
  if (raw === undefined || raw === null) raw = envelope?.minutes;
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_MODERATION_MINUTES) return 'invalid';
  return value;
}

/**
 * Resolve a mute or ban duration. `minutes: null` means an explicit permanent ban.
 * Zero, negative, fractional, oversized or non-numeric durations are rejected instead of
 * being clamped or reinterpreted as permanent.
 */
export function resolveModerationDuration(
  action: 'muteUser' | 'banUser',
  frame: Record<string, unknown>,
  envelope: ModerationEnvelope | null,
): DurationResult {
  const permanent = frame.permanent === true || envelope?.permanent === true;
  const minutes = readMinutes(frame, envelope);
  if (minutes === 'invalid') {
    return { ok: false, message: `durationMinutes must be a whole number from 1 to ${MAX_MODERATION_MINUTES}` };
  }
  if (action === 'muteUser') {
    if (permanent) return { ok: false, message: 'Mutes cannot be permanent' };
    return { ok: true, minutes: minutes ?? DEFAULT_MUTE_MINUTES };
  }
  if (permanent && minutes !== undefined) {
    return { ok: false, message: 'A ban cannot have both a duration and permanent=true' };
  }
  if (permanent) return { ok: true, minutes: null };
  if (minutes === undefined) {
    return { ok: false, message: 'A ban requires durationMinutes or an explicit permanent=true' };
  }
  return { ok: true, minutes };
}

/**
 * Undo ZFE's per-character `u0000` padding on the string members of a moderation frame.
 * Like the send path, repair is corroborated: it happens only when the padded `action`
 * decodes to a known moderation verb. A clean frame is returned untouched.
 */
export function repairModerationFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const action = typeof frame.action === 'string' ? frame.action : '';
  if (!action || RELAY_MODERATION_ACTIONS.has(action)) return frame;
  const decoded = deinterleaveZfeNulEscapes(action);
  if (decoded === action || !RELAY_MODERATION_ACTIONS.has(decoded)) return frame;
  const next: Record<string, unknown> = { ...frame, action: decoded };
  for (const key of ['messageId', 'targetUserId', 'reason', 'category', 'targetName']) {
    if (typeof frame[key] === 'string') next[key] = deinterleaveZfeNulEscapes(frame[key] as string, 1);
  }
  return next;
}

/**
 * Stable relay error code for a moderation service failure, or null when the error is unknown
 * (the caller rethrows). Matches the moderationErrors `code` and the historical error names and
 * messages so it works before and after the typed service errors land.
 */
export function relayModerationError(err: unknown): { code: string; message: string } | null {
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (code === 'ProtectedTarget' || name === 'ProtectedTargetError') {
    return { code: 'protected_target', message: 'Staff accounts cannot be moderated from the HUD; use Discord' };
  }
  if (code === 'ProtectionCheckFailed') {
    return { code: 'moderation_unavailable', message: 'Could not verify the target; try again shortly' };
  }
  if (code === 'AlreadyBanned') return { code: 'already_banned', message: 'That player is already banned' };
  if (code === 'NotBanned' || code === 'BanAlreadyReversed' || code === 'BanNotFound'
      || message === 'Ban not found' || message === 'Ban already reversed') {
    return { code: 'not_banned', message: 'That player has no active ban' };
  }
  if (code === 'TargetNotFound') return { code: 'target_not_found', message: 'That player was not found' };
  if (message === 'Message not found' || code === 'MessageNotFound') {
    return { code: 'message_not_found', message: 'That message was not found or was already deleted' };
  }
  if (code === 'InvalidInput') return { code: 'invalid_request', message: message || 'Invalid moderation request' };
  return null;
}

/** Private system body announcing that a message was removed. */
export function hudDeleteEventBody(messageId: string): string {
  return `${HUD_DELETE_EVENT_PREFIX}m=${encodeURIComponent(messageId)}`;
}

/** Message id carried by a `chat:delete` broadcast, or null when it is not a deletion frame. */
export function deletedMessageIdFromBroadcast(envelope: Record<string, unknown>): string | null {
  if (envelope.type !== 'chat:delete') return null;
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const id = (payload as Record<string, unknown>).messageId;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null;
}
