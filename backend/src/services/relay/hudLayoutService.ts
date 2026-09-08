import prisma from '../../config/prisma';

export const HUD_LAYOUT_CONTROL = 'FCMCTL/1/LAYOUT/';
export const HUD_LAYOUT_EVENT = 'FCMLAYOUT/1;';
export interface HudLayout { x: number; y: number; width: number; height: number }

export function parseHudLayout(value: unknown): HudLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const bounds = { x: [0, 1920], y: [0, 1080], width: [200, 1920], height: [120, 1080] };
  if (Object.keys(v).some(k => !Object.prototype.hasOwnProperty.call(bounds, k))) return null;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return null;
  }
  const layout = v as unknown as HudLayout;
  if (layout.x + layout.width > 1920 || layout.y + layout.height > 1080) return null;
  return { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
}

export function parseHudLayoutControl(body: string): { requestId: string; layout?: HudLayout } | null {
  if (body.length > 300) return null;
  const m = /^FCMCTL\/1\/LAYOUT\/(GET|SET);([a-z0-9-]{1,64})(?:;(.*))?$/.exec(body);
  if (!m) return null;
  if (m[1] === 'GET') return m[3] === undefined ? { requestId: m[2] } : null;
  try {
    const layout = parseHudLayout(JSON.parse(m[3] ?? ''));
    return layout ? { requestId: m[2], layout } : null;
  } catch { return null; }
}

/** Device scope is the authenticated relay identity, never an account or a client-supplied ID. */
export async function readHudLayout(relayUserId: string): Promise<HudLayout | null> {
  const row = await prisma.hudPairingToken.findFirst({
    where: { userId: relayUserId, revokedAt: null }, select: { hudLayout: true },
  });
  return parseHudLayout(row?.hudLayout);
}

export async function writeHudLayout(relayUserId: string, layout: HudLayout): Promise<void> {
  await prisma.hudPairingToken.updateMany({
    where: { userId: relayUserId, revokedAt: null }, data: { hudLayout: { ...layout } },
  });
}
