import prisma from '../../config/prisma';

export const HUD_LAYOUT_CONTROL = 'FCMCTL/1/LAYOUT/';
export const HUD_LAYOUT_EVENT = 'FCMLAYOUT/1;';
const HUD_COLOR_FIELDS = ['bgColor', 'tabRowColor', 'inputBgColor', 'borderColor', 'textColor',
  'inputTextColor', 'senderColor', 'tabActiveColor', 'tabInactiveColor', 'promptColor'] as const;
type HudColorSettings = Partial<Record<typeof HUD_COLOR_FIELDS[number], number>>;
export interface HudLayout extends HudColorSettings { bgAlpha?: number; x: number; y: number; width: number; height: number; fontSize?: number; inputHeight?: number; inputFontSize?: number; autoHideSec?: number; autoHideEnabled?: boolean }

export function parseHudLayout(value: unknown): HudLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const bounds = { x: [0, 1920], y: [0, 1080], width: [200, 1920], height: [120, 1080] };
  const optionalBounds = { fontSize: [8, 47], inputHeight: [28, 120], inputFontSize: [8, 47], autoHideSec: [0, 600] } as const;
  if (Object.keys(v).some(k => !Object.prototype.hasOwnProperty.call(bounds, k)
    && !Object.prototype.hasOwnProperty.call(optionalBounds, k) && k !== 'autoHideEnabled' && k !== 'bgAlpha' && !HUD_COLOR_FIELDS.some(field => field === k))) return null;
  const settings: Omit<HudLayout, 'x' | 'y' | 'width' | 'height'> = {};
  for (const key of ['fontSize', 'inputHeight', 'inputFontSize', 'autoHideSec'] as const) {
    if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
    const n = v[key];
    const [min, max] = optionalBounds[key];
    if (typeof n !== 'number' || !Number.isInteger(n)
      || (n < min && !(key === 'inputFontSize' && n === 0)) || n > max) return null;
    settings[key] = n;
  }
  if (Object.prototype.hasOwnProperty.call(v, 'autoHideEnabled')) {
    if (typeof v.autoHideEnabled !== 'boolean') return null;
    settings.autoHideEnabled = v.autoHideEnabled;
  }
  for (const key of HUD_COLOR_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
    const n = v[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 0xFFFFFF) return null;
    settings[key] = n;
  }
  if (Object.prototype.hasOwnProperty.call(v, 'bgAlpha')) {
    const alpha = v.bgAlpha;
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
    settings.bgAlpha = alpha;
  }
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return null;
  }
  const layout = v as unknown as HudLayout;
  if (layout.x + layout.width > 1920 || layout.y + layout.height > 1080) return null;
  return { x: layout.x, y: layout.y, width: layout.width, height: layout.height, ...settings };
}

export function parseHudLayoutControl(body: string): { requestId: string; layout?: HudLayout } | null {
  if (body.length > 1024) return null;
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
