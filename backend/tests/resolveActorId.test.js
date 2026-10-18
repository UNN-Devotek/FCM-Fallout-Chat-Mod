jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
} }));
const prisma = require('../src/config/prisma').default;
const { resolveInternalActorId } = require('../src/utils/resolveActorId');
const internalId = '11111111-1111-4111-8111-111111111111';
const discordId = '123456789012345678';
beforeEach(() => jest.resetAllMocks());

test('internal attribution verifies that the UUID belongs to an existing user', async () => {
  prisma.user.findUnique.mockResolvedValue({ id: internalId });
  await expect(resolveInternalActorId(internalId)).resolves.toBe(internalId);
  expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: internalId }, select: { id: true } });
});
test('a Discord actor resolves only its linked internal user', async () => {
  prisma.user.findFirst.mockResolvedValue({ id: internalId });
  await expect(resolveInternalActorId(discordId)).resolves.toBe(internalId);
});
test('confirmed unlinked Discord and API-key actors have nullable attribution', async () => {
  prisma.user.findFirst.mockResolvedValue(null);
  await expect(resolveInternalActorId(discordId)).resolves.toBeNull();
  await expect(resolveInternalActorId('api-key')).resolves.toBeNull();
  expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
});
test.each([undefined, null, 123, {}, '', 'not-an-actor'])('invalid identity %p is distinct from confirmed nullable attribution', async value => {
  await expect(resolveInternalActorId(value)).rejects.toMatchObject({ code: 'ACTOR_IDENTITY_INVALID' });
  expect(prisma.user.findUnique).not.toHaveBeenCalled();
  expect(prisma.user.findFirst).not.toHaveBeenCalled();
});
test('a nonexistent internal UUID is refused before a primary mutation', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  await expect(resolveInternalActorId(internalId)).rejects.toMatchObject({ code: 'ACTOR_INTERNAL_USER_MISSING' });
});
test.each(['internal', 'discord'])('%s lookup failure is unavailable, never confirmed unlinked', async kind => {
  prisma.user.findUnique.mockRejectedValue(new Error('private database diagnostic'));
  prisma.user.findFirst.mockRejectedValue(new Error('private database diagnostic'));
  await expect(resolveInternalActorId(kind === 'internal' ? internalId : discordId))
    .rejects.toMatchObject({ code: 'ACTOR_LOOKUP_UNAVAILABLE' });
  await expect(resolveInternalActorId(kind === 'internal' ? internalId : discordId))
    .rejects.not.toThrow('private database diagnostic');
});
