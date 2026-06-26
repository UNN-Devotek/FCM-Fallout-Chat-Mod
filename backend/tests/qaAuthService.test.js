const DEV_GUILD = 'dev-guild-1';
const QA_ROLE = 'qa-role-1';

const env = require('../src/config/environment');
env.DEV_GUILD_ID = DEV_GUILD;
env.DEV_QA_ROLE_ID = QA_ROLE;

const { verifyQaRole, checkQaAccess } = require('../src/services/qaAuthService');

function fakeDeps(rolesByGuild) {
  return { fetchGuildMemberRoles: async (guildId) => rolesByGuild[guildId] || [] };
}

describe('verifyQaRole (pure)', () => {
  test('has QA role -> authorized', () => {
    expect(verifyQaRole([QA_ROLE, 'x'], QA_ROLE)).toEqual({ authorized: true });
  });
  test('missing QA role -> denied with reason', () => {
    const r = verifyQaRole(['x'], QA_ROLE);
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/QA role/i);
  });
  test('missing role id (unconfigured) -> denied', () => {
    expect(verifyQaRole([QA_ROLE], '').authorized).toBe(false);
  });
  test('non-array roles -> denied (no throw)', () => {
    expect(verifyQaRole(undefined, QA_ROLE).authorized).toBe(false);
  });
});

describe('checkQaAccess (env + injected fakes)', () => {
  test('QA role present in dev guild -> authorized', async () => {
    const deps = fakeDeps({ [DEV_GUILD]: [QA_ROLE] });
    const r = await checkQaAccess('user-1', deps, 'tok');
    expect(r).toEqual({ discordUserId: 'user-1', authorized: true });
  });
  test('QA role absent -> denied', async () => {
    const deps = fakeDeps({ [DEV_GUILD]: ['other'] });
    const r = await checkQaAccess('user-1', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.discordUserId).toBe('user-1');
  });
  test('deps throw -> denied (fail closed)', async () => {
    const deps = { fetchGuildMemberRoles: async () => { throw new Error('discord down'); } };
    const r = await checkQaAccess('user-1', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/membership/i);
  });
});
