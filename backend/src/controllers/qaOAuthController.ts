import { Request, Response, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import logger from '../config/logger';
import env from '../config/environment';
import { verifyQaRole } from '../services/qaAuthService';

const STATE_TTL = 300; // 5 min
const GRANT_TTL = 600; // 10 min
const SESSION_TTL_SECONDS = 24 * 60 * 60;

function qaRedirectUri(req: Request): string {
  if (env.DISCORD_QA_REDIRECT_URI) return env.DISCORD_QA_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'dev.falloutchatmod.com';
  return `${proto}://${host}/auth/discord/qa/callback`;
}

/** GET /auth/discord/qa/start?installToken=... -> redirect to Discord OAuth. */
export async function qaStart(req: Request, res: Response): Promise<void> {
  const installToken = String(req.query.installToken || '');
  if (!installToken) { res.status(400).send('Missing installToken'); return; }
  const state = uuidv4();
  try {
    const redis = await getRedisClient();
    await redis.set(`qa_oauth_state:${state}`, installToken, { EX: STATE_TTL });
  } catch (err) {
    logger.error({ err }, '[qa-oauth] failed to store state');
    res.status(500).send('Internal error');
    return;
  }
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: qaRedirectUri(req),
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
}

export interface QaIdentity { id: string; username: string; global_name?: string; avatar?: string | null; }

export interface QaCallbackDeps {
  consumeState(state: string): Promise<string | null>;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  fetchIdentity(accessToken: string): Promise<QaIdentity>;
  fetchDevGuildRoles(discordUserId: string, accessToken: string): Promise<string[]>;
  upsertUser(identity: QaIdentity, installToken: string): Promise<{ id: string; displayName: string }>;
  mintSession(userId: string): Promise<string>;
  storeGrant(installToken: string, grant: { token: string; userId: string; displayName: string; role: string }): Promise<void>;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui,Segoe UI,sans-serif;background:#0b0f0b;color:#18FF62;padding:24px;line-height:1.5">` +
    `${body}</body>`;
}

/** GET /auth/discord/qa/callback — role-gate, mint a session, store the grant. */
export function makeQaCallbackHandler(deps: QaCallbackDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state) { res.status(400).send(page('QA login', '<h3>Missing code/state.</h3>')); return; }

    const installToken = await deps.consumeState(state);
    if (!installToken) { res.status(400).send(page('QA login', '<h3>Login expired. Please try again from the app.</h3>')); return; }

    let accessToken: string;
    let identity: QaIdentity;
    let roles: string[];
    try {
      ({ accessToken } = await deps.exchangeCode(code, qaRedirectUri(req)));
      identity = await deps.fetchIdentity(accessToken);
      roles = await deps.fetchDevGuildRoles(identity.id, accessToken);
    } catch (err) {
      logger.warn({ err }, '[qa-oauth] callback discord exchange/lookup failed');
      res.status(502).send(page('QA login', '<h3>Could not reach Discord. Please try again.</h3>'));
      return;
    }

    const decision = verifyQaRole(roles, env.DEV_QA_ROLE_ID);
    if (!decision.authorized) {
      res.status(403).send(page('QA login',
        '<h3>Access denied</h3><p>You need the <strong>QA role</strong> in the FCM dev Discord. ' +
        'Ask a maintainer to grant it, then try again.</p>'));
      return;
    }

    let user: { id: string; displayName: string };
    let token: string;
    try {
      user = await deps.upsertUser(identity, installToken);
      token = await deps.mintSession(user.id);
      await deps.storeGrant(installToken, { token, userId: user.id, displayName: user.displayName, role: 'user' });
    } catch (err) {
      logger.error({ err }, '[qa-oauth] failed to issue QA session');
      res.status(500).send(page('QA login', '<h3>Could not create your session. Please try again.</h3>'));
      return;
    }

    res.status(200).send(page('QA access granted',
      '<h3>QA access granted</h3><p>You can close this window and return to the app.</p>'));
  };
}

/** Real deps wiring. */
export const defaultQaCallbackDeps: QaCallbackDeps = {
  async consumeState(state) {
    const redis = await getRedisClient();
    const it = await redis.get(`qa_oauth_state:${state}`);
    if (it) await redis.del(`qa_oauth_state:${state}`);
    return it;
  },
  async exchangeCode(code, redirectUri) {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!r.ok) throw new Error(`token exchange HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string };
    return { accessToken: j.access_token };
  },
  async fetchIdentity(accessToken) {
    const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`identity HTTP ${r.status}`);
    return (await r.json()) as QaIdentity;
  },
  async fetchDevGuildRoles(_discordUserId, accessToken) {
    const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${env.DEV_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`dev-guild member HTTP ${r.status}`);
    const m = (await r.json()) as { roles?: string[] };
    return Array.isArray(m.roles) ? m.roles : [];
  },
  async upsertUser(identity, installToken) {
    // Mirror the link-flow upsert at server.ts:734-753. Upsert by installToken so
    // the desktop-app user record is updated in-place; placeholder username keeps
    // the @unique username constraint clean.
    const displayName = String(identity.global_name || identity.username).slice(0, 128);
    const user = await prisma.user.upsert({
      where: { installToken },
      update: {
        discordId: identity.id,
        discordUsername: identity.username,
        discordAvatar: identity.avatar ?? null,
        discordDisplayName: displayName,
        discordAuthedAt: new Date(),
      },
      create: {
        installToken,
        username: `discord:${identity.id}`,
        discordId: identity.id,
        discordUsername: identity.username,
        discordAvatar: identity.avatar ?? null,
        discordDisplayName: displayName,
        discordAuthedAt: new Date(),
      },
      select: { id: true, username: true },
    });
    return { id: user.id, displayName: displayName };
  },
  async mintSession(userId) {
    const token = uuidv4();
    const redis = await getRedisClient();
    await redis.set(`session:${token}`, userId, { EX: SESSION_TTL_SECONDS });
    prisma.session.create({ data: { token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) } })
      .catch((err: Error) => logger.warn({ err }, '[qa-oauth] failed to persist session to DB'));
    return token;
  },
  async storeGrant(installToken, grant) {
    const redis = await getRedisClient();
    await redis.set(`qa_grant:${installToken}`, JSON.stringify(grant), { EX: GRANT_TTL });
  },
};
