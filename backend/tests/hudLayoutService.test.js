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
    'FCMCTL/1/LAYOUT/SET;one;null', 'FCMCTL/1/LAYOUT/GET;../../other', 'x'.repeat(301)]) {
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
