/**
 * Tests for backend/src/services/devAuthService.ts — dual Discord role gate.
 *
 * Spec: docs/deployment/hosted-dev-environment.md
 *       § "Developer authorization — dual Discord role gate".
 *
 * Authorized ONLY if the user holds the developer role in BOTH the prod guild
 * AND the dev guild. Both the pure verifyDualRole and the env-driven
 * checkDeveloperAccess (with injected fakes, no network) are exercised.
 */

const PROD_GUILD = 'prod-guild-1';
const DEV_GUILD = 'dev-guild-1';
const PROD_ROLE = 'prod-dev-role';
const DEV_ROLE = 'dev-dev-role';

// environment.ts loads .env.local with override:true (when present locally),
// which would clobber any process.env we set here. So we require the cached env
// object and overwrite its fields directly — the service reads from this object.
const env = require('../src/config/environment');
env.PROD_GUILD_ID = PROD_GUILD;
env.DEV_GUILD_ID = DEV_GUILD;
env.PROD_DEVELOPER_ROLE_ID = PROD_ROLE;
env.DEV_DEVELOPER_ROLE_ID = DEV_ROLE;

const { verifyDualRole, checkDeveloperAccess } = require('../src/services/devAuthService');

/** Build a fake deps whose role map is keyed by guild ID. */
function fakeDeps(rolesByGuild) {
  return {
    fetchGuildMemberRoles: async (guildId) => rolesByGuild[guildId] || [],
  };
}

describe('verifyDualRole (pure)', () => {
  const base = { prodRoleId: PROD_ROLE, devRoleId: DEV_ROLE };

  test('both roles present -> authorized', () => {
    const r = verifyDualRole({ ...base, prodMemberRoles: [PROD_ROLE, 'x'], devMemberRoles: [DEV_ROLE] });
    expect(r.authorized).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  test('missing prod role -> denied', () => {
    const r = verifyDualRole({ ...base, prodMemberRoles: ['other'], devMemberRoles: [DEV_ROLE] });
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/prod guild/i);
  });

  test('missing dev role -> denied', () => {
    const r = verifyDualRole({ ...base, prodMemberRoles: [PROD_ROLE], devMemberRoles: ['other'] });
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/dev guild/i);
  });

  test('missing both roles -> denied', () => {
    const r = verifyDualRole({ ...base, prodMemberRoles: [], devMemberRoles: [] });
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/both/i);
  });

  test('unconfigured role IDs -> denied', () => {
    const r = verifyDualRole({ prodRoleId: '', devRoleId: '', prodMemberRoles: [], devMemberRoles: [] });
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/not configured/i);
  });
});

describe('checkDeveloperAccess (env + injected fakes)', () => {
  test('both roles present -> authorized', async () => {
    const deps = fakeDeps({ [PROD_GUILD]: [PROD_ROLE], [DEV_GUILD]: [DEV_ROLE] });
    const r = await checkDeveloperAccess('user-1', deps, 'tok');
    expect(r.authorized).toBe(true);
    expect(r.discordUserId).toBe('user-1');
  });

  test('missing prod role -> denied', async () => {
    const deps = fakeDeps({ [PROD_GUILD]: [], [DEV_GUILD]: [DEV_ROLE] });
    const r = await checkDeveloperAccess('user-2', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/prod guild/i);
  });

  test('missing dev role -> denied', async () => {
    const deps = fakeDeps({ [PROD_GUILD]: [PROD_ROLE], [DEV_GUILD]: [] });
    const r = await checkDeveloperAccess('user-3', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/dev guild/i);
  });

  test('missing both roles -> denied', async () => {
    const deps = fakeDeps({ [PROD_GUILD]: [], [DEV_GUILD]: [] });
    const r = await checkDeveloperAccess('user-4', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/both/i);
  });

  test('membership read failure -> denied (no throw)', async () => {
    const deps = {
      fetchGuildMemberRoles: async () => { throw new Error('not in guild'); },
    };
    const r = await checkDeveloperAccess('user-5', deps, 'tok');
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/Failed to read guild membership/i);
  });
});
