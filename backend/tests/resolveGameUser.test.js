jest.mock('../src/config/prisma', () => ({ __esModule: true, default: { user: { findFirst: jest.fn() } } }));
const prisma = require('../src/config/prisma').default;
const { resolveGameUser } = require('../src/middleware/resolveGameUser');
beforeEach(() => jest.clearAllMocks());
test('Steam cookie resolves canonical account by verified provider ID, ignoring stale user ID', async () => {
  prisma.user.findFirst.mockResolvedValue({ id: 'canonical' });
  expect(await resolveGameUser({ headers: {}, session: { steamUser: { steamId: '76561198000000001', userId: 'stale' } } })).toEqual({ userId: 'canonical', via: 'steam-session' });
  expect(prisma.user.findFirst).toHaveBeenCalledWith({ where: { steamId: '76561198000000001' }, select: { id: true } });
});
test('invalid Steam identity and unlinked identity cannot authenticate', async () => {
  expect(await resolveGameUser({ headers: {}, session: { steamUser: { steamId: 'invalid', userId: 'forged' } } })).toBeNull();
  expect(prisma.user.findFirst).not.toHaveBeenCalled();
  prisma.user.findFirst.mockResolvedValue(null);
  expect(await resolveGameUser({ headers: {}, session: { steamUser: { steamId: '76561198000000001' } } })).toBeNull();
});
