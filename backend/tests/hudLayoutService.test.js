jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { hudPairingToken: {
  findFirst: jest.fn(), updateMany: jest.fn(),
} } }));
const prisma = require('../src/config/prisma').default;
const { parseHudLayout, parseHudLayoutControl, readHudLayout, writeHudLayout } = require('../src/services/relay/hudLayoutService');
const layout = { x: 20, y: 40, width: 600, height: 400 };
beforeEach(() => jest.clearAllMocks());
test('validates finite integral on-screen geometry and rejects extra identity/config fields', () => {
  expect(parseHudLayout(layout)).toEqual(layout);
  for (const bad of [null, [], { ...layout, x: -1 }, { ...layout, y: Infinity },
    { ...layout, width: 2000 }, { ...layout, height: 20 }, { ...layout, x: 0.5 },
    { ...layout, userId: 'another-device' }, { ...layout, x: 1500 }]) expect(parseHudLayout(bad)).toBeNull();
});
test('control parser bounds payloads and correlates GET/SET requests', () => {
  expect(parseHudLayoutControl('FCMCTL/1/LAYOUT/GET;one-2')).toEqual({ requestId: 'one-2' });
  expect(parseHudLayoutControl('FCMCTL/1/LAYOUT/SET;one-2;' + JSON.stringify(layout))).toEqual({ requestId: 'one-2', layout });
  for (const bad of ['FCMCTL/1/LAYOUT/GET;one;extra', 'FCMCTL/1/LAYOUT/SET;one;{}',
    'FCMCTL/1/LAYOUT/SET;one;null', 'FCMCTL/1/LAYOUT/GET;../../other', 'x'.repeat(1025)]) {
    expect(parseHudLayoutControl(bad)).toBeNull();
  }
});
test('reads only the active authenticated device and treats missing or corrupt data as absent', async () => {
  prisma.hudPairingToken.findFirst.mockResolvedValueOnce({ hudLayout: layout }).mockResolvedValueOnce(null);
  expect(await readHudLayout('device-a')).toEqual(layout);
  expect(prisma.hudPairingToken.findFirst).toHaveBeenCalledWith({ where: { userId: 'device-a', revokedAt: null }, select: { hudLayout: true } });
  expect(await readHudLayout('device-b')).toBeNull();
});
test('writes geometry only to the active token identity', async () => {
  await writeHudLayout('device-a', layout);
  expect(prisma.hudPairingToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'device-a', revokedAt: null }, data: { hudLayout: layout } });
});

test('persists optional HUD sizing settings and supports legacy geometry records', async () => {
  const sized = { ...layout, fontSize: 18, inputHeight: 48, inputFontSize: 24, autoHideEnabled: false, autoHideSec: 95 };
  expect(parseHudLayout(sized)).toEqual(sized);
  expect(parseHudLayout({ ...sized, inputFontSize: 0 })).toEqual({ ...sized, inputFontSize: 0 });
  for (const [key, values] of Object.entries({ fontSize: [0, 48, null], inputHeight: [27, 121, '48'], inputFontSize: [-1, 1, 48, 1.5] })) {
    for (const value of values) expect(parseHudLayout({ ...sized, [key]: value })).toBeNull();
  }
  for (const value of ['false', 0, null]) expect(parseHudLayout({ ...sized, autoHideEnabled: value })).toBeNull();
  for (const value of [-1, 601, 0.5, null]) expect(parseHudLayout({ ...sized, autoHideSec: value })).toBeNull();
  const body = 'FCMCTL/1/LAYOUT/SET;' + 'a'.repeat(64) + ';' + JSON.stringify(sized);
  expect(parseHudLayoutControl(body)).toEqual({ requestId: 'a'.repeat(64), layout: sized });
  await writeHudLayout('device-a', sized);
  expect(prisma.hudPairingToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'device-a', revokedAt: null }, data: { hudLayout: sized } });
  prisma.hudPairingToken.findFirst.mockResolvedValueOnce({ hudLayout: sized });
  expect(await readHudLayout('device-a')).toEqual(sized);
});

test('appearance payloads persist only allowed finite colors and opacity', async () => {
  const colors = ['bgColor', 'tabRowColor', 'inputBgColor', 'borderColor', 'textColor',
    'inputTextColor', 'senderColor', 'tabActiveColor', 'tabInactiveColor', 'promptColor'];
  const appearance = { ...layout, fontSize: 18, inputHeight: 48, inputFontSize: 24,
    autoHideEnabled: false, autoHideSec: 95, bgAlpha: 0.3,
    ...Object.fromEntries(colors.map(key => [key, 0x123456])) };
  expect(parseHudLayout(appearance)).toEqual(appearance);
  for (const field of colors) {
    for (const bad of [-1, 0x1000000, 0.5, '#123456', null])
      expect(parseHudLayout({ ...appearance, [field]: bad })).toBeNull();
  }
  for (const bgAlpha of [-0.1, 1.1, NaN, Infinity, '0.5', null])
    expect(parseHudLayout({ ...appearance, bgAlpha })).toBeNull();
  for (const field of ['inputWidth', 'inputAlignment', 'showChannelTag', 'defaultChannel', 'visibleChannels', 'emojiEnabled', 'badges', 'colorGeneral'])
    expect(parseHudLayout({ ...appearance, [field]: 1 })).toBeNull();
  const body = 'FCMCTL/1/LAYOUT/SET;' + 'a'.repeat(64) + ';' + JSON.stringify(appearance);
  expect(body.length).toBeGreaterThan(300);
  expect(parseHudLayoutControl(body)).toEqual({ requestId: 'a'.repeat(64), layout: appearance });
  expect(parseHudLayoutControl(body + ' '.repeat(1025))).toBeNull();
  await writeHudLayout('device-a', appearance);
  prisma.hudPairingToken.findFirst.mockResolvedValueOnce({ hudLayout: appearance });
  expect(await readHudLayout('device-a')).toEqual(appearance);
});
