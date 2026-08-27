/**
 * Dual Discord role gate — access control for the hosted dev environment.
 *
 * Spec: docs/deployment/hosted-dev-environment.md
 *       § "Developer authorization — dual Discord role gate".
 *
 * To consume any dev resource (dashboard, remote DB, pg_dump/pg_restore,
 * migrations, object store) a contributor MUST simultaneously hold the
 * developer role in BOTH the production guild AND the dev guild. Either one
 * alone grants nothing. This is an *access* control, not a confidentiality
 * control — the dev dataset is fake by construction.
 *
 * This module is the PURE, TESTABLE core only. All Discord HTTP sits behind an
 * injectable `DevAuthDeps` boundary so the verification logic is unit-testable
 * without network.
 *
 * ---------------------------------------------------------------------------
 * TODO (deferred — out of scope for this module):
 *   - Broker: mint/return short-lived Cloudflare Access service tokens +
 *     time-boxed DB credentials after both roles verify (the "Infra
 *     credentials" half of § Broker).
 *   - Route wiring for infrastructure credentials: the hosted DEV persona
 *     OAuth/session flow is wired in server.ts; DB/object-store credential
 *     brokering remains deferred.
 *   - fcm-dev-cli login flow for contributors.
 * ---------------------------------------------------------------------------
 */

import env from '../config/environment';

export interface VerifyDualRoleInput {
  /** Role IDs the user holds in the production guild. */
  prodMemberRoles: string[];
  /** Role IDs the user holds in the dev guild. */
  devMemberRoles: string[];
  /** The developer role ID in the production guild. */
  prodRoleId: string;
  /** The developer role ID in the dev guild. */
  devRoleId: string;
}

export interface DualRoleResult {
  authorized: boolean;
  /** Human-readable deny reason. Absent when authorized. */
  reason?: string;
}

/**
 * Pure dual-role check. Authorized ONLY if the user holds the prod developer
 * role in the prod guild AND the dev developer role in the dev guild.
 *
 * No network, no env access — fully deterministic given its inputs.
 */
export function verifyDualRole(input: VerifyDualRoleInput): DualRoleResult {
  const { prodMemberRoles, devMemberRoles, prodRoleId, devRoleId } = input;

  if (!prodRoleId || !devRoleId) {
    return {
      authorized: false,
      reason: 'Dual-role gate is not configured (missing prod or dev developer role ID).',
    };
  }

  const hasProd = Array.isArray(prodMemberRoles) && prodMemberRoles.includes(prodRoleId);
  const hasDev = Array.isArray(devMemberRoles) && devMemberRoles.includes(devRoleId);

  if (!hasProd && !hasDev) {
    return { authorized: false, reason: 'Missing developer role in both the prod and dev guilds.' };
  }
  if (!hasProd) {
    return { authorized: false, reason: 'Missing developer role in the prod guild.' };
  }
  if (!hasDev) {
    return { authorized: false, reason: 'Missing developer role in the dev guild.' };
  }

  return { authorized: true };
}

/**
 * Injectable boundary for all Discord HTTP. Implementations fetch a user's
 * role IDs within a specific guild. Keeping this as an interface lets the
 * higher-level logic be unit-tested with fakes (no network).
 */
export interface DevAuthDeps {
  /**
   * Fetch the role IDs the user holds in `guildId`.
   * Returns an empty array if the user is in the guild with no roles; should
   * throw if the membership cannot be read (e.g. user not in guild / auth
   * failure) so callers can deny rather than silently treat as "no roles".
   */
  fetchGuildMemberRoles(guildId: string, userId: string, accessToken: string): Promise<string[]>;
}

export interface DeveloperAccessResult extends DualRoleResult {
  discordUserId: string;
}

/**
 * Higher-level gate. Reads guild/role IDs from env, fetches the caller's roles
 * in both guilds via the injected deps, and applies `verifyDualRole`.
 *
 * @param discordUserId  the authenticated user's Discord ID
 * @param deps           injectable role-fetching boundary
 * @param accessToken    the user's OAuth access token (guilds.members.read).
 *                       Optional here so fakes/tests need not supply one.
 */
export async function checkDeveloperAccess(
  discordUserId: string,
  deps: DevAuthDeps,
  accessToken = '',
): Promise<DeveloperAccessResult> {
  const prodGuildId = env.PROD_GUILD_ID;
  const prodRoleId = env.PROD_DEVELOPER_ROLE_ID;
  const devGuildId = env.DEV_GUILD_ID;
  const devRoleId = env.DEV_DEVELOPER_ROLE_ID;

  if (!prodGuildId || !devGuildId || !prodRoleId || !devRoleId) {
    return {
      discordUserId,
      authorized: false,
      reason: 'Dual-role gate is not configured (missing guild or role IDs).',
    };
  }

  let prodMemberRoles: string[];
  let devMemberRoles: string[];
  try {
    // Dev-guild check is always local (dev bot is in the dev guild). The
    // prod-guild read relies on the user's OAuth token reaching the prod guild
    // (see fetch helper note). Both go through the same deps boundary.
    [prodMemberRoles, devMemberRoles] = await Promise.all([
      deps.fetchGuildMemberRoles(prodGuildId, discordUserId, accessToken),
      deps.fetchGuildMemberRoles(devGuildId, discordUserId, accessToken),
    ]);
  } catch (err) {
    return {
      discordUserId,
      authorized: false,
      reason: `Failed to read guild membership: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = verifyDualRole({ prodMemberRoles, devMemberRoles, prodRoleId, devRoleId });
  return { discordUserId, ...result };
}

/**
 * Real (but isolated) implementation of the deps interface. Reads the calling
 * user's own member object — roles included — in a specific guild using the
 * user's OAuth access token and the `guilds.members.read` scope:
 *
 *   GET /users/@me/guilds/{guildId}/member   (Authorization: Bearer <token>)
 *
 * NOTE (verify separately): it is NOT yet confirmed that this reaches the PROD
 * guild with only the user's token when the dev bot is absent from the prod
 * server. If Discord refuses, fall back to the narrow prod boolean endpoint
 * (PROD_VERIFY_URL / PROD_VERIFY_TOKEN — see TODO at top of file). The dev-guild
 * read always works because the dev bot is present there.
 */
export const discordOAuthDeps: DevAuthDeps = {
  async fetchGuildMemberRoles(guildId: string, _userId: string, accessToken: string): Promise<string[]> {
    if (!accessToken) {
      throw new Error('Missing OAuth access token for guilds.members.read');
    }
    const res = await fetch(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Discord member lookup failed for guild ${guildId} (HTTP ${res.status})`);
    }
    const member = (await res.json()) as { roles?: string[] };
    return Array.isArray(member.roles) ? member.roles : [];
  },
};

/**
 * Injectable HTTP boundary for the prod verify call. Lets the dev-side deps be
 * unit-tested without network. Given the user's Discord ID, asks the PROD
 * backend whether they hold the prod developer role; returns the boolean.
 */
export interface ProdVerifyClient {
  (discordId: string): Promise<boolean>;
}

/**
 * Default prod-verify client: HTTP GET against the PROD backend's narrow
 * endpoint with the shared service token.
 *
 *   GET {PROD_VERIFY_URL}?discordId=<id>   (Authorization: Bearer PROD_VERIFY_TOKEN)
 *   → { data: { hasDevRole: boolean } }
 *
 * PROD_VERIFY_URL should be the full endpoint URL, e.g.
 *   https://falloutchatmod.com/api/internal/verify-dev-role
 */
export const defaultProdVerifyClient: ProdVerifyClient = async (discordId: string): Promise<boolean> => {
  if (!env.PROD_VERIFY_URL || !env.PROD_VERIFY_TOKEN) {
    throw new Error('Prod verify endpoint is not configured (PROD_VERIFY_URL / PROD_VERIFY_TOKEN).');
  }
  const url = new URL(env.PROD_VERIFY_URL);
  url.searchParams.set('discordId', discordId);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.PROD_VERIFY_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Prod verify endpoint returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: { hasDevRole?: boolean } };
  return body?.data?.hasDevRole === true;
};

/**
 * Dev-side `DevAuthDeps` implementation (the fallback path). The DEV bot cannot
 * read the PROD guild, so:
 *   - prod-guild reads delegate to the PROD backend's verify endpoint
 *     (via `prodVerify`), synthesizing a roles array of just the prod role ID
 *     when `hasDevRole` is true so `verifyDualRole` matches as usual;
 *   - dev-guild reads are local via the DEV bot's token over the Discord REST
 *     API (the dev bot IS in the dev guild).
 *
 * Both boundaries are injectable so this is unit-testable without network.
 *
 * @param prodVerify   prod-verify client (defaults to `defaultProdVerifyClient`)
 * @param devBotToken  the DEV bot token (defaults to env.DISCORD_TOKEN)
 */
export function makeDevSideDeps(
  prodVerify: ProdVerifyClient = defaultProdVerifyClient,
  devBotToken: string = env.DISCORD_TOKEN,
): DevAuthDeps {
  const prodGuildId = env.PROD_GUILD_ID;
  const prodRoleId = env.PROD_DEVELOPER_ROLE_ID;
  return {
    async fetchGuildMemberRoles(guildId: string, userId: string, _accessToken: string): Promise<string[]> {
      if (guildId === prodGuildId) {
        // Prod guild: ask the prod backend. Synthesize a roles array so the
        // pure dual-role check sees the prod role iff the prod side says so.
        const hasDevRole = await prodVerify(userId);
        return hasDevRole ? [prodRoleId] : [];
      }
      // Dev guild: read locally via the dev bot (it is a member of the dev guild).
      if (!devBotToken) {
        throw new Error('Missing dev bot token for dev-guild membership read.');
      }
      const res = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
        { headers: { Authorization: `Bot ${devBotToken}` } },
      );
      if (res.status === 404) return []; // not in dev guild
      if (!res.ok) {
        throw new Error(`Dev-guild member lookup failed (HTTP ${res.status})`);
      }
      const member = (await res.json()) as { roles?: string[] };
      return Array.isArray(member.roles) ? member.roles : [];
    },
  };
}

export default {
  verifyDualRole,
  checkDeveloperAccess,
  discordOAuthDeps,
  makeDevSideDeps,
  defaultProdVerifyClient,
};
module.exports = {
  verifyDualRole,
  checkDeveloperAccess,
  discordOAuthDeps,
  makeDevSideDeps,
  defaultProdVerifyClient,
};
