import type { Request, Response, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import env from '../config/environment';
import prisma from '../config/prisma';
import { getRedisClient } from '../config/redis';
import { checkDeveloperAccess, makeDevSideDeps } from '../services/devAuthService';
import { devPersonaDiscordId, devPersonaUsername } from '../utils/devPersonaDiscordId';
import { clientIp } from '../utils/clientIp';
import { constantTimeEquals } from '../utils/constantTimeEquals';

const STATE_TTL_SECONDS = 5 * 60;
const GRANT_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface DevPersona {
  id: string;
  username: string;
  role: string;
}

export interface DevPersonaLoginState {
  installToken: string;
  persona: string;
}

export interface DevPersonaGrant {
  token: string;
  userId: string;
  displayName: string;
  role: string;
}

export interface DevPersonaIdentity {
  id: string;
  username?: string;
}

export interface DevPersonaCallbackDeps {
  consumeState(state: string): Promise<DevPersonaLoginState | null>;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  fetchIdentity(accessToken: string): Promise<DevPersonaIdentity>;
  checkDeveloperAccess(discordUserId: string): Promise<{ authorized: boolean; reason?: string }>;
  issueSession(installToken: string, persona: string): Promise<DevPersonaGrant>;
  storeGrant(installToken: string, grant: DevPersonaGrant): Promise<void>;
  storeDenial?(installToken: string, reason: string): Promise<void>;
}

export interface DevPersonaStatusDeps {
  consumeGrant(installToken: string): Promise<DevPersonaGrant | null>;
  consumeDenial?(installToken: string): Promise<string | null>;
}

export interface DevPersonaLoginAsDeps {
  issueSession(installToken: string, persona: string): Promise<DevPersonaGrant>;
  /** Override for tests; production uses the configured environment secret. */
  personaLoginSecret?: string;
}

export interface DevPersonaCompletionDeps {
  checkDeveloperAccess(discordUserId: string): Promise<{ authorized: boolean; reason?: string }>;
  issueSession(installToken: string, persona: string): Promise<DevPersonaGrant>;
  storeGrant(installToken: string, grant: DevPersonaGrant): Promise<void>;
  storeDenial?(installToken: string, reason: string): Promise<void>;
}

export const DEV_PRIVILEGED_ROLES = ['owner', 'admin', 'moderator', 'supporter', 'developer'];

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Direct persona login is intentionally convenient on a developer machine,
 * but the hosted DEV relay is internet-reachable. Keep the local shortcut and
 * require a separate, dev-only shared key for every remote caller.
 */
export function isDevPersonaLoginAuthorized(req: Request, secret = env.DEV_PERSONA_LOGIN_SECRET): boolean {
  const supplied = String(req.headers['x-dev-persona-key'] || '').trim();
  // Once the hosted stack has a key configured, require it for every caller.
  // This prevents a misconfigured proxy from making all tunnel connections
  // appear loopback-local and bypassing the remote gate.
  if (secret) return supplied.length > 0 && constantTimeEquals(supplied, secret);
  return isLoopbackAddress(clientIp(req));
}

export function getDevPersona(persona: string): DevPersona | null {
  const personas: Record<string, DevPersona> = {
    user:      { id: 'dev-user-001', username: 'System User',      role: env.DEV_USER_ROLE },
    mod:       { id: 'dev-user-002', username: 'System Mod',       role: env.DEV_MOD_ROLE },
    moderator: { id: 'dev-user-002', username: 'System Moderator', role: env.DEV_MOD_ROLE },
    admin:     { id: 'dev-user-003', username: 'System Admin',     role: env.DEV_ADMIN_ROLE },
    supporter: { id: 'dev-user-004', username: 'System Supporter', role: env.DEV_SUPPORTER_ROLE },
    developer: { id: 'dev-user-005', username: 'System Developer', role: env.DEV_DEVELOPER_ROLE },
    owner:     { id: 'dev-user-006', username: 'System Owner',     role: 'owner' },
  };
  return personas[persona] || null;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui,Segoe UI,sans-serif;background:#0b0f0b;color:#18FF62;padding:24px;line-height:1.5">` +
    `${body}</body>`;
}

function redirectUri(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'dev.falloutchatmod.com';
  // Reuse the already-registered desktop-link callback. This avoids requiring
  // another Discord application redirect URI for the hosted DEV flow.
  return env.DISCORD_LINK_REDIRECT_URI || `${proto}://${host}/auth/discord/link/callback`;
}

/** GET /auth/discord/dev-login?installToken=...&persona=... -> Discord OAuth. */
export async function devPersonaStart(req: Request, res: Response): Promise<void> {
  const installToken = String(req.query.installToken || '').trim();
  const persona = String(req.query.persona || '').trim().toLowerCase();
  if (!installToken || !persona) { res.status(400).send('Missing installToken or persona'); return; }
  if (!getDevPersona(persona)) { res.status(404).send('Unknown dev persona'); return; }

  const state = uuidv4();
  try {
    const redis = await getRedisClient();
    // A fresh attempt must not consume the result of a previous attempt for the
    // same install token (the status endpoint is intentionally public and
    // keyed by this token, like the existing QA flow).
    await redis.del([`dev_persona_grant:${installToken}`, `dev_persona_denied:${installToken}`]);
    await redis.set(`dev_persona_oauth_state:${state}`, JSON.stringify({ installToken, persona }), { EX: STATE_TTL_SECONDS });
  } catch {
    res.status(500).send('Internal error');
    return;
  }

  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
}

/**
 * Callback core. The caller must authenticate the Discord identity through the
 * dual-role verifier before this handler issues a persona session.
 */
export function makeDevPersonaCallbackHandler(deps: DevPersonaCallbackDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state) { res.status(400).send(page('DEV login', '<h3>Missing code or state.</h3>')); return; }

    let pending: DevPersonaLoginState | null;
    try {
      pending = await deps.consumeState(state);
    } catch {
      res.status(500).send(page('DEV login', '<h3>Login could not be started. Please try again.</h3>'));
      return;
    }
    if (!pending || !pending.installToken || !getDevPersona(pending.persona)) {
      res.status(400).send(page('DEV login', '<h3>Login expired. Please start again from the overlay.</h3>'));
      return;
    }

    let identity: DevPersonaIdentity;
    let accessToken: string;
    try {
      ({ accessToken } = await deps.exchangeCode(code, redirectUri(req)));
      identity = await deps.fetchIdentity(accessToken);
    } catch {
      res.status(502).send(page('DEV login', '<h3>Could not reach Discord. Please try again.</h3>'));
      return;
    }

    try {
      const result = await completeDevPersonaLogin(pending, identity.id, deps);
      if (!result.authorized) {
        res.status(403).send(page('DEV login', '<h3>Access denied</h3><p>You need the developer role in both the production and DEV Discord servers.</p>'));
        return;
      }
    } catch {
      res.status(500).send(page('DEV login', '<h3>Could not create your DEV session. Please try again.</h3>'));
      return;
    }

    res.status(200).send(page('DEV access granted', '<h3>DEV access granted</h3><p>You can close this window and return to the overlay.</p>'));
  };
}

export async function completeDevPersonaLogin(
  pending: DevPersonaLoginState,
  discordUserId: string,
  deps: DevPersonaCompletionDeps,
): Promise<{ authorized: boolean; grant?: DevPersonaGrant }> {
  let decision: { authorized: boolean; reason?: string };
  try {
    decision = await deps.checkDeveloperAccess(discordUserId);
  } catch {
    decision = { authorized: false };
  }
  if (!decision.authorized) {
    await deps.storeDenial?.(pending.installToken, decision.reason || 'Hosted DEV access was denied.');
    return { authorized: false };
  }
  const grant = await deps.issueSession(pending.installToken, pending.persona);
  await deps.storeGrant(pending.installToken, grant);
  return { authorized: true, grant };
}

export function makeDevPersonaStatusHandler(deps: DevPersonaStatusDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const installToken = String(req.params.installToken || '').trim();
    if (!installToken) { res.status(400).json({ data: { authorized: false } }); return; }
    const grant = await deps.consumeGrant(installToken);
    if (grant) { res.json({ data: { authorized: true, ...grant } }); return; }
    const denial = await deps.consumeDenial?.(installToken);
    if (denial) { res.json({ data: { authorized: false, error: denial } }); return; }
    res.json({ data: { authorized: false } });
  };
}

/** POST /api/dev/login-as — issue a synthetic persona session in development. */
export function makeDevPersonaLoginAsHandler(
  deps: DevPersonaLoginAsDeps = { issueSession: issueDevPersonaSession },
): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    if (!isDevPersonaLoginAuthorized(req, deps.personaLoginSecret)) {
      res.status(403).json({ error: 'Dev persona login is restricted to local development or an authorized hosted-DEV client' });
      return;
    }
    const persona = String(req.body?.persona || '').trim().toLowerCase();
    const installToken = String(req.body?.installToken || '').trim();
    if (!persona || !installToken) {
      res.status(400).json({ error: 'Missing persona or installToken' });
      return;
    }
    if (!getDevPersona(persona)) {
      res.status(404).json({ error: 'Unknown persona' });
      return;
    }
    try {
      const grant = await deps.issueSession(installToken, persona);
      res.json({ data: { ...grant, discordLinked: true } });
    } catch {
      res.status(500).json({ error: 'Dev login failed' });
    }
  };
}

export async function issueDevPersonaSession(installToken: string, persona: string): Promise<DevPersonaGrant> {
  const p = getDevPersona(persona);
  if (!p) throw new Error('Unknown dev persona');

  const fakeDiscordId = devPersonaDiscordId(persona, installToken);
  await prisma.user.upsert({
    where: { installToken },
    create: {
      installToken,
      username: devPersonaUsername(p.username, installToken),
      discordId: fakeDiscordId,
      discordUsername: p.username,
      discordDisplayName: p.username,
      discordAuthedAt: new Date(),
    },
    update: {
      discordId: fakeDiscordId,
      discordUsername: p.username,
      discordDisplayName: p.username,
      discordAuthedAt: new Date(),
    },
  });
  if (DEV_PRIVILEGED_ROLES.includes(p.role)) {
    await prisma.adminUser.upsert({
      where: { discordId: fakeDiscordId },
      create: { discordId: fakeDiscordId, username: p.username, role: p.role, updatedAt: new Date() },
      update: { role: p.role, updatedAt: new Date() },
    });
  }
  const user = await prisma.user.findUnique({ where: { installToken }, select: { id: true } });
  if (!user) throw new Error('User not found after upsert');
  const token = uuidv4();
  const redis = await getRedisClient();
  await redis.set(`session:${token}`, user.id, { EX: SESSION_TTL_SECONDS });
  prisma.session.create({ data: { token, userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) } })
    .catch(() => {});
  return { token, userId: user.id, displayName: p.username, role: p.role };
}

export const defaultDevPersonaCallbackDeps: DevPersonaCallbackDeps = {
  async consumeState(state) {
    const redis = await getRedisClient();
    const raw = await redis.getDel(`dev_persona_oauth_state:${state}`);
    if (!raw) return null;
    try { return JSON.parse(raw) as DevPersonaLoginState; } catch { return null; }
  },
  async exchangeCode(code, callbackRedirectUri) {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackRedirectUri,
      }),
    });
    if (!r.ok) throw new Error(`token exchange HTTP ${r.status}`);
    const json = await r.json() as { access_token?: string };
    if (!json.access_token) throw new Error('No access token from Discord');
    return { accessToken: json.access_token };
  },
  async fetchIdentity(accessToken) {
    const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`identity HTTP ${r.status}`);
    return await r.json() as DevPersonaIdentity;
  },
  async checkDeveloperAccess(discordUserId) {
    return checkDeveloperAccess(discordUserId, makeDevSideDeps());
  },
  issueSession: issueDevPersonaSession,
  async storeGrant(installToken, grant) {
    const redis = await getRedisClient();
    await redis.set(`dev_persona_grant:${installToken}`, JSON.stringify(grant), { EX: GRANT_TTL_SECONDS });
  },
  async storeDenial(installToken, reason) {
    const redis = await getRedisClient();
    await redis.set(`dev_persona_denied:${installToken}`, reason.slice(0, 200), { EX: GRANT_TTL_SECONDS });
  },
};

export const defaultDevPersonaStatusDeps: DevPersonaStatusDeps = {
  async consumeGrant(installToken) {
    const redis = await getRedisClient();
    const raw = await redis.getDel(`dev_persona_grant:${installToken}`);
    if (!raw) return null;
    try { return JSON.parse(raw) as DevPersonaGrant; } catch { return null; }
  },
  async consumeDenial(installToken) {
    const redis = await getRedisClient();
    return redis.getDel(`dev_persona_denied:${installToken}`);
  },
};
