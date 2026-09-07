/**
 * The small HUD projection understood by the in-game HUD widget.
 *
 * The web clients receive the complete cosmetics object. The HUD only needs the
 * validated custom tag and the immutable supporter marker, so keeping this
 * projection explicit prevents accidental exposure of unsupported effects or
 * arbitrary badge text on the Scaleform surface.
 */

export interface RelayHudCosmetics {
  tag?: string;
  supporterStar?: true;
  starColor?: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const HUD_COSMETICS_TRANSPORT_PREFIX = 'FCMHUD/1;';

/** Project server-resolved cosmetics into the additive chat.v1 HUD fields. */
export function relayHudCosmetics(source: Record<string, unknown>): RelayHudCosmetics {
  const result: RelayHudCosmetics = {};
  if (typeof source.tag === 'string' && source.tag.trim()) {
    result.tag = source.tag;
  }

  const badges = Array.isArray(source.badges) ? source.badges : [];
  const hasSupporterTier = badges.includes('supporter') || badges.includes('overseer');
  if (!hasSupporterTier) return result;

  result.supporterStar = true;
  if (typeof source.starColor === 'string' && HEX_COLOR.test(source.starColor)) {
    result.starColor = source.starColor;
  }
  return result;
}

/** Remove only the HUD cosmetic fields before serving an older widget build. */
export function withoutRelayHudCosmetics<T extends Record<string, unknown>>(event: T): T {
  const next = { ...event } as T & Partial<RelayHudCosmetics>;
  delete next.tag;
  delete next.supporterStar;
  delete next.starColor;
  return next as T;
}

/**
 * Encode the HUD message identity and cosmetic projection in the existing, native-known targetUserId
 * member. ZFE's native chat bridge filters unknown JSON members before returning
 * an event to Scaleform, while targetUserId is already part of the chat.v1 event
 * schema and is empty for ordinary channel messages.
 *
 * This is a transport envelope only; it is never used as a real recipient. Keep
 * the additive fields on the event too so raw relay consumers retain the normal
 * JSON contract. The version-gated caller is responsible for sending this only
 * to widgets that know how to decode it.
 */
export function relayHudCosmeticTransport(
  cosmetics: RelayHudCosmetics,
  messageId?: string,
): string {
  const fields: string[] = [];
  const stableMessageId = typeof messageId === 'string' ? messageId.trim() : '';
  if (stableMessageId && stableMessageId.length <= 128) {
    fields.push(`m=${encodeURIComponent(stableMessageId)}`);
  }
  if (cosmetics.supporterStar) fields.push('s=1');
  if (cosmetics.starColor && HEX_COLOR.test(cosmetics.starColor)) {
    fields.push(`c=${encodeURIComponent(cosmetics.starColor)}`);
  }
  if (typeof cosmetics.tag === 'string' && cosmetics.tag.trim()) {
    fields.push(`t=${encodeURIComponent(cosmetics.tag)}`);
  }
  return fields.length > 0
    ? `${HUD_COSMETICS_TRANSPORT_PREFIX}${fields.join(';')}`
    : '';
}

/**
 * Prepare one event for a native HUD subscriber. Older/raw clients retain the
 * additive JSON projection; the native-known transport envelope is added only
 * for a widget build that explicitly negotiated support for it. ZFE filters the
 * additive members before old widgets can see them, while raw relay consumers
 * continue to receive the established JSON contract.
 */
export function relayHudEventForClient<T extends Record<string, unknown>>(
  event: T,
  supportsCosmeticTransport: boolean,
): T {
  const cosmetics = relayHudCosmetics(event);
  // History and server-room events already contain the validated projection but
  // intentionally do not carry the full badges array. Preserve that projection
  // when adapting those events for the native transport.
  if (event.supporterStar === true) {
    cosmetics.supporterStar = true;
    if (typeof event.starColor === 'string' && HEX_COLOR.test(event.starColor)) {
      cosmetics.starColor = event.starColor;
    }
  }
  if (!supportsCosmeticTransport) return event;

  const transport = relayHudCosmeticTransport(
    cosmetics,
    typeof event.messageId === 'string' ? event.messageId : '',
  );
  return transport
    ? ({ ...event, targetUserId: transport } as T)
    : event;
}

/**
 * Adapt a send acknowledgement for the native HUD bridge, including its stable
 * message ID so the widget can reconcile its optimistic local row.
 *
 * ZFE preserves the established `targetUserId` member but may discard newer
 * cosmetic members from RPC responses. Keep the additive fields for raw relay
 * clients and mirror the validated projection through the same carrier used by
 * live events when the widget negotiated support for it.
 */
export function relayHudSendAck<T extends Record<string, unknown>>(
  ack: T,
  cosmetics: RelayHudCosmetics,
  supportsCosmeticTransport: boolean,
): T {
  const next = { ...ack, ...cosmetics } as T;
  if (!supportsCosmeticTransport) return next;

  const transport = relayHudCosmeticTransport(
    cosmetics,
    typeof next.messageId === 'string' ? next.messageId : '',
  );
  return transport
    ? ({ ...next, targetUserId: transport } as T)
    : next;
}

export default {
  relayHudCosmetics,
  withoutRelayHudCosmetics,
  relayHudCosmeticTransport,
  relayHudEventForClient,
  relayHudSendAck,
};
