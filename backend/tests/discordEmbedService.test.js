const prisma = {
  discordEmbed: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  auditLog: { create: jest.fn() },
};
const postEmbed = jest.fn();
const buildMappings = jest.fn();
const createPanel = jest.fn();
const assertPanelRolesAllowed = jest.fn(async () => undefined);

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prisma }));
jest.mock('../src/services/discordService', () => ({ postEmbed }));
jest.mock('../src/services/reactionRoleService', () => ({
  __esModule: true,
  ReactionRolePanelError: class ReactionRolePanelError extends Error { constructor(cause) { super('Reaction-role panel setup failed'); this.causeClass = cause?.constructor?.name ?? 'UnknownError'; } },
  default: { buildMappings, createPanel, assertPanelRolesAllowed },
}));

const service = require('../src/services/discordEmbedService').default;

describe('discordEmbedService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('previews a canonical embed without mutating the input', () => {
    const input = {
      title: 'Welcome',
      description: 'Pick a role',
      color: '#F1C40F',
      fields: [{ name: 'Platform', value: 'PC', inline: true }],
      ignored: 'not part of EmbedData',
    };
    const original = structuredClone(input);

    expect(service.preview(input)).toEqual({
      embed: {
        title: 'Welcome',
        description: 'Pick a role',
        color: '#F1C40F',
        fields: [{ name: 'Platform', value: 'PC', inline: true }],
      },
      warnings: [],
    });
    expect(input).toEqual(original);
  });

  it('rejects invalid embeds and reaction-role inputs with the established messages', () => {
    expect(service.validateEmbed({})).toBe('embed must have at least a title, description, image, or one field');
    expect(service.validateEmbed({ title: 'x', color: 'yellow' })).toBe('color must be a 6-digit hex value (e.g. #18FF62)');
    expect(service.validateReactionRoles([{ emoji: '', roleId: '123' }]).error)
      .toBe('each reaction role needs either a unicode emoji or a valid customEmojiId snowflake');
  });

  it.each([
    [{ title: 42 }, 'title must be a string'],
    [{ title: 'x', imageUrl: 42 }, 'imageUrl must be a string'],
    [{ title: 'x', timestamp: 'yes' }, 'timestamp must be a boolean'],
    [{ title: 'x', color: false }, 'color must be a 6-digit hex value or an integer from 0 to 16777215'],
    [{ title: 'x', color: 0x1000000 }, 'color must be a 6-digit hex value or an integer from 0 to 16777215'],
    [{ fields: [{ name: 1, value: 'value' }] }, 'each field needs a string name and value'],
    [{ fields: [{ name: 'name', value: 'value', inline: 'yes' }] }, 'field inline must be a boolean'],
    [{ title: 'x', url: 'javascript:alert(1)' }, 'url must be an http or https URL'],
    [{ title: 'x', imageUrl: 'not a URL' }, 'imageUrl must be a valid http or https URL'],
    [{ title: 'x', content: 'c'.repeat(2001) }, 'content must be 2000 characters or fewer'],
  ])('rejects malformed known embed properties', (input, expected) => {
    expect(service.validateEmbed(input)).toBe(expected);
  });

  it('enforces Discord aggregate text and URL limits', () => {
    expect(service.validateEmbed({
      title: 't'.repeat(256),
      description: 'd'.repeat(4096),
      authorName: 'a'.repeat(256),
      footerText: 'f'.repeat(1393),
    })).toBe('embed text must total 6000 characters or fewer');
    expect(service.validateEmbed({ title: 'x', url: `https://example.com/${'a'.repeat(2030)}` }))
      .toBe('url must be 2048 characters or fewer');
  });

  it('never accepts an embed that canonical preview reduces to an empty payload', () => {
    expect(service.validateEmbed({ title: 1, unknown: 'value' })).toBe('title must be a string');
    expect(() => service.preview({ title: 1, unknown: 'value' })).toThrow('title must be a string');
  });

  it('rejects a malformed custom emoji ID even when a unicode emoji is valid', () => {
    expect(service.validateReactionRoles([{
      emoji: '🎮', customEmojiId: 'not-a-snowflake', roleId: '52345678901234567',
    }]).error).toBe('customEmojiId must be a valid Discord snowflake ID');
  });

  it('provides list, get, create, update, and delete operations', async () => {
    prisma.discordEmbed.findMany.mockResolvedValue([{ id: 1 }]);
    prisma.discordEmbed.findUnique.mockResolvedValue({ id: 1 });
    prisma.discordEmbed.create.mockResolvedValue({ id: 2 });
    prisma.discordEmbed.update.mockResolvedValue({ id: 1, name: 'Updated' });
    prisma.discordEmbed.delete.mockResolvedValue({ id: 1 });

    await expect(service.list()).resolves.toEqual([{ id: 1 }]);
    await expect(service.get(1)).resolves.toEqual({ id: 1 });
    const createData = { title: 'Hello', fields: [{ name: 'A', value: 'B' }], futureOption: 'preserved' };
    const updateData = { imageUrl: 'https://example.com/image.png', customMetadata: { source: 'dashboard' } };
    await expect(service.create('  New  ', createData)).resolves.toEqual({ id: 2 });
    await expect(service.update(1, ' Updated ', updateData))
      .resolves.toEqual({ id: 1, name: 'Updated' });
    await expect(service.remove(1)).resolves.toBeUndefined();
    expect(prisma.discordEmbed.create).toHaveBeenCalledWith({ data: { name: 'New', data: createData } });
    expect(prisma.discordEmbed.update).toHaveBeenCalledWith({
      where: { id: 1 }, data: { name: 'Updated', data: updateData },
    });
    expect(createData.fields[0]).not.toHaveProperty('inline');
  });

  it('sends through the canonical Discord and reaction-role services and audits', async () => {
    const message = { id: '12345678901234567', guildId: '22345678901234567', client: {} };
    const mappings = [{ emoji: 'vault', matchKey: '32345678901234567' }];
    postEmbed.mockResolvedValue(message);
    buildMappings.mockReturnValue(mappings);
    createPanel.mockResolvedValue(undefined);
    prisma.auditLog.create.mockResolvedValue({});

    await expect(service.send({
      channelId: '42345678901234567',
      embed: { title: 'Roles' },
      actorId: 'actor-id',
      reactionRoles: [{ emoji: 'vault', customEmojiId: '32345678901234567', roleId: '52345678901234567' }],
    })).resolves.toEqual({ sent: true, messageId: message.id, reactionRoles: 1 });

    expect(postEmbed).toHaveBeenCalledWith('42345678901234567', { title: 'Roles' });
    expect(buildMappings).toHaveBeenCalledWith(message.client, message.guildId, expect.any(Array));
    expect(createPanel).toHaveBeenCalledWith(message, mappings);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'actor-id', action: 'send_discord_embed' }),
    }));
  });

  it('refuses a panel role before posting the embed', async () => {
    assertPanelRolesAllowed.mockRejectedValueOnce(new Error('The role "Mod" is a configured staff, access or supporter role and cannot be offered on a reaction panel.'));
    await expect(service.send({
      channelId: '42345678901234567', embed: { title: 'Roles' }, actorId: 'actor-id',
      reactionRoles: [{ emoji: '🎮', roleId: '52345678901234567' }],
    })).rejects.toThrow('configured staff');
    expect(assertPanelRolesAllowed).toHaveBeenCalledWith('42345678901234567', ['52345678901234567'], 'actor-id');
    expect(postEmbed).not.toHaveBeenCalled();
    expect(createPanel).not.toHaveBeenCalled();
  });

  it('supports MCP-owned auditing and preserves partial-send semantics when panel creation fails', async () => {
    const message = { id: '12345678901234567', guildId: '22345678901234567', client: {} };
    postEmbed.mockResolvedValue(message);
    buildMappings.mockReturnValue([{ emoji: '🎮', matchKey: '🎮', reactValue: '🎮', roleId: '52345678901234567' }]);
    createPanel.mockRejectedValueOnce(new Error('panel persistence failed'));

    const pending = service.send({
      channelId: '42345678901234567', embed: { title: 'Roles' }, reactionRoles: [{ emoji: '🎮', roleId: '52345678901234567' }], suppressAudit: true,
    });
    await expect(pending).rejects.toMatchObject({
      name: 'PartialEmbedSendError', code: 'embed_sent_panel_failed', messageId: message.id,
      channelId: '42345678901234567', causeClass: 'Error',
    });

    expect(postEmbed).toHaveBeenCalledTimes(1);
    expect(createPanel).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
