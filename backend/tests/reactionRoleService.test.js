const prisma = {
  reactionRolePanel: {
    upsert: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), delete: jest.fn(),
  },
  user: { findMany: jest.fn(), findUnique: jest.fn() },
};
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { MODERATOR_ROLE_ID: '90000000000000001', SUPPORTER_ROLE_ID: '90000000000000002' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prisma }));
const service = require('../src/services/reactionRoleService');
function role(id, overrides = {}) {
  return { id, name: `Role ${id.slice(-2)}`, position: 1, managed: false, permissions: new PermissionsBitField(0n), ...overrides };
}
function guild(roles, extra = {}) {
  const cache = new Map(roles.map((r) => [r.id, r]));
  return { id: '55555555555555555', ownerId: '99999999999999999', roles: { cache, fetch: jest.fn(async (id) => cache.get(id) ?? null) }, members: { fetch: jest.fn() }, ...extra };
}

describe('reactionRoleService strict panel creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.reactionRolePanel.upsert.mockResolvedValue({});
    prisma.reactionRolePanel.deleteMany.mockResolvedValue({ count: 1 });
  });

  function message(react) {
    return {
      id: '44444444444444444', channelId: '11111111111111111', guildId: '55555555555555555',
      guild: guild([role('22222222222222222'), role('33333333333333333'), role('44444444444444444')]),
      react, reactions: { removeAll: jest.fn().mockResolvedValue(undefined) },
    };
  }

  it('refuses to persist a panel that offers a configured staff role', async () => {
    const msg = message(jest.fn().mockResolvedValue({}));
    msg.guild = guild([role('90000000000000001', { name: 'Moderator' })]);
    await expect(service.createPanel(msg, [
      { emoji: '🎮', matchKey: '🎮', reactValue: '🎮', roleId: '90000000000000001' },
    ])).rejects.toMatchObject({ name: 'ReactionRolePanelError', causeClass: 'ReactionRoleNotAllowedError' });
    expect(prisma.reactionRolePanel.upsert).not.toHaveBeenCalled();
    expect(msg.react).not.toHaveBeenCalled();
  });

  it('persists only a panel whose every reaction Discord accepts', async () => {
    const msg = message(jest.fn().mockResolvedValue({}));
    await expect(service.createPanel(msg, [
      { emoji: '🎮', matchKey: '🎮', reactValue: '🎮', roleId: '22222222222222222' },
      { emoji: '✅', matchKey: '✅', reactValue: '✅', roleId: '33333333333333333' },
    ])).resolves.toBeUndefined();
    expect(msg.react).toHaveBeenCalledTimes(2);
    expect(prisma.reactionRolePanel.deleteMany).not.toHaveBeenCalled();
  });

  it('treats invalid or deleted emoji rejection as failure and rolls back storage and reactions', async () => {
    const msg = message(jest.fn().mockRejectedValueOnce(new Error('Unknown Emoji')));
    await expect(service.createPanel(msg, [
      { emoji: 'notemoji', matchKey: 'notemoji', reactValue: 'notemoji', roleId: '22222222222222222' },
    ])).rejects.toMatchObject({ name: 'ReactionRolePanelError', causeClass: 'Error' });
    expect(prisma.reactionRolePanel.deleteMany).toHaveBeenCalledWith({ where: { messageId: msg.id } });
    expect(msg.reactions.removeAll).toHaveBeenCalledTimes(1);
  });

  it('rolls back previously accepted reactions when a later reaction fails', async () => {
    const msg = message(jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new TypeError('deleted custom emoji')));
    await expect(service.createPanel(msg, [
      { emoji: '🎮', matchKey: '🎮', reactValue: '🎮', roleId: '22222222222222222' },
      { emoji: '<:gone:33333333333333333>', matchKey: '33333333333333333', reactValue: 'gone:33333333333333333', roleId: '44444444444444444' },
    ])).rejects.toMatchObject({ name: 'ReactionRolePanelError', causeClass: 'TypeError' });
    expect(msg.react).toHaveBeenCalledTimes(2);
    expect(prisma.reactionRolePanel.deleteMany).toHaveBeenCalledTimes(1);
    expect(msg.reactions.removeAll).toHaveBeenCalledTimes(1);
  });
});

describe('reaction-role policy', () => {
  const ctx = { guildId: '55555555555555555', protectedRoleIds: new Set(['90000000000000001']) };

  it('allows an ordinary role below the creating moderator', () => {
    expect(service.reactionRoleRefusal(role('22222222222222222', { position: 3 }), { ...ctx, actorHighestPosition: 5 })).toBeNull();
  });

  it.each([
    ['configured staff role', role('90000000000000001'), /configured staff/],
    ['role with Ban Members', role('22222222222222222', { permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers) }), /Ban Members/],
    ['Administrator role', role('22222222222222222', { permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) }), /Administrator/],
    ['integration-managed role', role('22222222222222222', { managed: true }), /managed/],
    ['missing role', null, /no longer exists/],
  ])('refuses a %s', (_label, candidate, reason) => {
    expect(service.reactionRoleRefusal(candidate, ctx)).toMatch(reason);
  });

  it('refuses a role at or above the creating moderator', () => {
    expect(service.reactionRoleRefusal(role('22222222222222222', { position: 5 }), { ...ctx, actorHighestPosition: 5 })).toMatch(/at or above your highest/);
  });

  it('checks the creating moderator hierarchy from their Discord member', async () => {
    const g = guild([role('22222222222222222', { position: 4 })]);
    g.members.fetch.mockResolvedValue({ roles: { highest: { position: 4 } } });
    await expect(service.checkPanelRoles(g, ['22222222222222222'], '12121212121212121')).resolves.toMatch(/at or above/);
    g.members.fetch.mockResolvedValue({ roles: { highest: { position: 9 } } });
    await expect(service.checkPanelRoles(g, ['22222222222222222'], '12121212121212121')).resolves.toBeNull();
  });
});

describe('reaction-role click time', () => {
  const handlers = new Map();
  const member = { roles: { add: jest.fn(), remove: jest.fn() } };
  const g = guild([role('22222222222222222'), role('90000000000000002', { name: 'Supporter' })]);
  g.members.fetch.mockResolvedValue(member);
  service.register({ on: (event, cb) => handlers.set(event, cb), once: jest.fn(), guilds: { fetch: jest.fn(async () => g) } });

  function reaction(emoji) {
    return { partial: false, emoji: { id: null, name: emoji }, message: { id: '66666666666666666' }, users: { remove: jest.fn().mockResolvedValue(undefined) } };
  }
  const user = { id: '77777777777777777', bot: false, partial: false };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    g.members.fetch.mockResolvedValue(member);
    prisma.reactionRolePanel.findUnique.mockResolvedValue({
      channelId: '11111111111111111', guildId: '55555555555555555',
      mappings: [
        { emoji: '🎮', matchKey: '🎮', reactValue: '🎮', roleId: '22222222222222222' },
        { emoji: '💛', matchKey: '💛', reactValue: '💛', roleId: '90000000000000002' },
      ],
    });
  });

  it('grants an ordinary role to a member in good standing', async () => {
    prisma.user.findMany.mockResolvedValue([{ isBanned: false, bannedUntil: null, kickedUntil: null, isMuted: false, muteExpiresAt: null }]);
    handlers.get('messageReactionAdd')(reaction('🎮'), user);
    await flush(); await flush();
    expect(member.roles.add).toHaveBeenCalledWith('22222222222222222', 'Reaction role');
  });

  it('does not let an FCM-banned member reclaim a role and removes the reaction', async () => {
    prisma.user.findMany.mockResolvedValue([{ isBanned: true, bannedUntil: null, kickedUntil: null, isMuted: false, muteExpiresAt: null }]);
    const r = reaction('🎮');
    handlers.get('messageReactionAdd')(r, user);
    await flush(); await flush();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(r.users.remove).toHaveBeenCalledWith(user.id);
  });

  it('does not strip a role when the bot removes a refused reaction', async () => {
    prisma.user.findMany.mockResolvedValue([{ isBanned: true, bannedUntil: null, kickedUntil: null, isMuted: false, muteExpiresAt: null }]);
    handlers.get('messageReactionAdd')(reaction('🎮'), user);
    await flush(); await flush();
    // Discord echoes the bot's own removal back as messageReactionRemove.
    handlers.get('messageReactionRemove')(reaction('🎮'), user);
    await flush(); await flush();
    expect(member.roles.remove).not.toHaveBeenCalled();
    // A later, genuine un-react still removes the ordinary role.
    handlers.get('messageReactionRemove')(reaction('🎮'), user);
    await flush(); await flush();
    expect(member.roles.remove).toHaveBeenCalledWith('22222222222222222', 'Reaction role removed');
  });

  it('never removes a protected role through a panel', async () => {
    handlers.get('messageReactionRemove')(reaction('💛'), user);
    await flush(); await flush();
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it('refuses a stored panel mapping that now points at a protected role', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    handlers.get('messageReactionAdd')(reaction('💛'), user);
    await flush(); await flush();
    expect(member.roles.add).not.toHaveBeenCalled();
  });
});
