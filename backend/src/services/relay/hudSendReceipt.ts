import { createHash } from 'node:crypto';

export interface HudSendCarrier { id: string; room: string }
export function parseHudSendCarrier(value: string): HudSendCarrier | null {
  const match = /^FCMOUT\/1;i=([a-zA-Z0-9_-]{16,96});r=([^;]*)$/.exec(value);
  if (!match) return null;
  try {
    const room = decodeURIComponent(match[2]!);
    if (room.length > 128 || /[\x00-\x1f]/.test(room)) return null;
    return { id: match[1]!, room };
  } catch { return null; }
}

// Retain claims longer than the HUD's 24h queue lifetime. Never take over an
// abandoned claim: publishing/queueing and this receipt are not one transaction.
export const HUD_SEND_RECEIPT_SECONDS = 7 * 24 * 60 * 60;
export interface ReceiptStore {
  set(key: string, value: string, options: { NX: true; EX: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
}
export type ReceiptClaim =
  | { kind: 'claimed'; key: string; fingerprint: string }
  | { kind: 'replay'; response: Record<string, unknown> }
  | { kind: 'pending' | 'uncertain' | 'conflict' };
export function hudSendReceiptIdentity(deviceId: string, accountId: string, request: HudSendCarrier, channel: string, body: string) {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    key: `relay:hud-send:${hash([deviceId, accountId, request.id])}`,
    fingerprint: hash([channel, body, request.room]),
  };
}
export async function claimHudSend(store: ReceiptStore, identity: { key: string; fingerprint: string }): Promise<ReceiptClaim> {
  const { key, fingerprint } = identity;
  const inserted = await store.set(key, JSON.stringify({ fingerprint, createdAt: Date.now() }), { NX: true, EX: HUD_SEND_RECEIPT_SECONDS });
  if (inserted === 'OK') return { kind: 'claimed', key, fingerprint };
  const existing: unknown = JSON.parse(await store.get(key) ?? 'null');
  if (!existing || typeof existing !== 'object' || !('fingerprint' in existing) || existing.fingerprint !== fingerprint) return { kind: 'conflict' };
  if ('response' in existing && existing.response && typeof existing.response === 'object' && !Array.isArray(existing.response)) {
    return { kind: 'replay', response: existing.response as Record<string, unknown> };
  }
  return { kind: 'createdAt' in existing && typeof existing.createdAt === 'number' && Date.now() - existing.createdAt > 120_000 ? 'uncertain' : 'pending' };
}
export function hudSendResponse(response: Record<string, unknown>, id: string): Record<string, unknown> {
  const carrier = typeof response.targetUserId === 'string' && response.targetUserId.startsWith('FCMHUD/1;')
    ? response.targetUserId : 'FCMHUD/1';
  return { ...response, targetUserId: `${carrier.replace(/;q=[a-zA-Z0-9_-]+/g, "")};q=${id}` };
}
