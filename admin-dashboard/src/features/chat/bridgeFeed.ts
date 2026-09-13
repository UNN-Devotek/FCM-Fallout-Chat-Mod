export type BridgeState = { status: 'ready'; channelId: string; bindingId: string }
  | { status: 'inactive' | 'ambiguous' | 'unavailable' };
export const INACTIVE_BRIDGE: BridgeState = { status: 'inactive' };

export function readBridgeState(value: unknown, enabled: boolean): BridgeState {
  if (!enabled || !value || typeof value !== 'object') return INACTIVE_BRIDGE;
  const p = value as Record<string, unknown>;
  if (p.status === 'ready' && typeof p.channelId === 'string' && /^server:r:[a-z0-9-]{1,64}$/.test(p.channelId)
    && typeof p.bindingId === 'string' && p.bindingId.length <= 256 && p.bindingId.endsWith(`/${p.channelId.slice(7)}`)) {
    return { status: 'ready', channelId: p.channelId, bindingId: p.bindingId };
  }
  return { status: p.status === 'ambiguous' || p.status === 'unavailable' ? p.status : 'inactive' };
}

type Row = { id: string; channelId: string; timestamp?: string };
/** Main General and Server render this same collection; never copy messages into
 * the General channel or collapse different IDs with matching text. */
export function mergeBridgeRows<T extends Row>(previous: T[], incoming: T[], state: BridgeState,
  frame: { bindingId?: unknown; channelId?: unknown }, cap: number): T[] {
  if (state.status !== 'ready' || state.bindingId !== frame.bindingId || state.channelId !== frame.channelId) return previous;
  const seen = new Set(previous.map(row => row.id));
  const fresh = incoming.filter(row => {
    if (row.channelId !== state.channelId || !row.id.startsWith(`${state.channelId}:`)
      || !/^[1-9][0-9]*$/.test(row.id.slice(state.channelId.length + 1)) || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  if (!fresh.length) return previous;
  return [...previous, ...fresh].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).slice(-cap);
}

export function clearBridgeRows<T extends Row>(rows: T[]): T[] {
  return rows.some(row => row.channelId.startsWith('server:')) ? rows.filter(row => !row.channelId.startsWith('server:')) : rows;
}

export function bridgeSendPayload<T extends { channelId?: string }>(payload: T, state: BridgeState): (T & { bridgeBindingId?: string }) | null {
  if (!payload.channelId?.startsWith('server:')) return payload;
  return state.status === 'ready' && payload.channelId === state.channelId
    ? { ...payload, bridgeBindingId: state.bindingId } : null;
}
