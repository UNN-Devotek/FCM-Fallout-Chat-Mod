import { beginRuntimeFetch as fetch, discardRuntimeResponse } from '../runtime/nativeFetch';
import { bindRequiredTransactionClient, isPrismaAtomicRefusal, runRequiredBundle, runRequiredMutation, runRequiredTransaction } from '../lib/requiredEffects';
import { Request, Response, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { runtime } from '../runtime';
import env from '../config/environment';
import { verifyQaRole } from '../services/qaAuthService';
import { captureAvatar } from '../services/avatarService';
import { mergeUserInto } from '../utils/mergeUser';

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
  return runRequiredBundle('session', 'qaOAuthController:f68c7c730994', async () => {
  const installToken = String(req.query.installToken || '');
  if (!installToken) { res.status(400).send('Missing installToken'); return; }
  const state = uuidv4();
  try {
    const redis = await getRedisClient();
    await runRequiredMutation('session', '029cfe3541ce42b4da5a96d6', { stage: 'primary-write-unconfirmed' }, () => redis.set(`qa_oauth_state:${state}`, installToken, { EX: STATE_TTL }), undefined, undefined, undefined);
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
  // The state is single-use. A cached 302 can replay an already-consumed state
  // on a later login attempt, which correctly fails CSRF validation but strands
  // the user. Never let browsers or intermediary caches reuse this redirect.
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);

  });
}

export interface QaIdentity { id: string; username: string; global_name?: string; avatar?: string | null; }

export interface QaCallbackDeps {
  consumeState(state: string): Promise<string | null>;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  fetchIdentity(accessToken: string): Promise<QaIdentity>;
  fetchDevGuildRoles(discordUserId: string, accessToken: string): Promise<string[]>;
  upsertUser(identity: QaIdentity, installToken: string): Promise<{ id: string; displayName: string }>;
  captureAvatar(discordId: string, avatarHash: string | null): Promise<unknown>;
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
      // Persist the Discord avatar before granting the session so the first
      // Identity-card refresh can use our same-origin object-store URL.
      try {
        await deps.captureAvatar(identity.id, identity.avatar ?? null);
      } catch (err) {
        // Avatar storage is enrichment, never an authentication dependency.
        logger.warn({ err, discordId: identity.id }, '[qa-oauth] avatar capture failed (non-fatal)');
      }
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
  return runRequiredBundle('identity', 'qaOAuthController:66f376181fba', async () => {
    const redis = await getRedisClient();
    const it = await runRequiredMutation('identity', 'a0def3410121eb448de6e1db', { stage: 'primary-write-unconfirmed' }, () => redis.getDel(`qa_oauth_state:${state}`), undefined, undefined, reply => reply === null);
    return it ?? null;

  });
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
    if (!r.ok) { await r.text(); throw new Error(`token exchange HTTP ${r.status}`); }
    const j = (await r.json()) as { access_token: string };
    return { accessToken: j.access_token };
  },
  async fetchIdentity(accessToken) {
    const r = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) { await discardRuntimeResponse(r); throw new Error(`identity HTTP ${r.status}`); }
    return (await r.json()) as QaIdentity;
  },
  async fetchDevGuildRoles(_discordUserId, accessToken) {
    const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${env.DEV_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      await discardRuntimeResponse(r);
      if (r.status === 404) return [];
      throw new Error(`dev-guild member HTTP ${r.status}`);
    }
    const m = (await r.json()) as { roles?: string[] };
    return Array.isArray(m.roles) ? m.roles : [];
  },
  async upsertUser(identity, installToken) {
  return runRequiredBundle('identity', 'qaOAuthController:efd2ff7f5add', async () => {
    const displayName = String(identity.global_name || identity.username).slice(0, 128);
    const discordProfile = {
      discordId: identity.id,
      discordUsername: identity.username,
      discordAvatar: identity.avatar ?? null,
      discordDisplayName: displayName,
      discordAuthedAt: new Date(),
    };

    // A verified Discord ID is the canonical account anchor. A QA build may
    // arrive with a new install token and an install-scoped placeholder, but it
    // must reclaim the existing Discord/Steam account rather than detach Discord
    // and strand the placeholder's HUD history on a second user row.
    const existingAccount = await prisma.user.findFirst({
      where: { discordId: identity.id, NOT: { installToken } },
      select: { id: true, username: true },
    });
    if (existingAccount) {
      const placeholder = await prisma.user.findUnique({
        where: { installToken },
        select: { id: true },
      });
      await runRequiredTransaction('identity', '056c6eb149424890f6da5c45', { stage: 'transaction-completion-unconfirmed' }, () => prisma.$transaction(async (tx) => {
      bindRequiredTransactionClient(tx);
        if (placeholder && placeholder.id !== existingAccount.id) {
          await mergeUserInto(existingAccount.id, placeholder.id, tx);
        }
        await runRequiredMutation('identity', 'ca750bf729101a5c9ab2bc27', { stage: 'primary-write-unconfirmed', rowId: existingAccount.id }, () => tx.user.update({
          where: { id: existingAccount.id },
          data: { installToken, ...discordProfile },
        }), isPrismaAtomicRefusal, tx, undefined);
      }), { confirmedRollback: isPrismaAtomicRefusal });
      return { id: existingAccount.id, displayName };
    }

    const user = await runRequiredMutation('identity', 'd3d09f70eb65827d6c3ffd81', { stage: 'primary-write-unconfirmed' }, () => prisma.user.upsert({
      where: { installToken },
      update: discordProfile,
      create: {
        installToken,
        username: `pending-qa-${uuidv4()}`,
        ...discordProfile,
      },
      select: { id: true, username: true },
    }), isPrismaAtomicRefusal, undefined, undefined);
    return { id: user.id, displayName: displayName };

  });
},
  async captureAvatar(discordId, avatarHash) {
    return captureAvatar(discordId, avatarHash);
  },
  async mintSession(userId) {
  return runRequiredBundle('session', 'qaOAuthController:4a71d1f5166f', async () => {
    const token = uuidv4();
    const redis = await getRedisClient();
    await runRequiredMutation('session', 'db9e5993fdeb271cfd262d26', { stage: 'primary-write-unconfirmed' }, () => redis.set(`session:${token}`, userId, { EX: SESSION_TTL_SECONDS }), undefined, undefined, undefined);
    void runtime.required('session:persist', () => prisma.session.create({ data: { token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) } }),
      { userId, source: 'qa' })
      .catch((err: Error) => logger.warn({ err }, '[qa-oauth] failed to persist session to DB'));
    return token;

  });
},
  async storeGrant(installToken, grant) {
  return runRequiredBundle('session', 'qaOAuthController:20429f86aa21', async () => {
    const redis = await getRedisClient();
    await runRequiredMutation('session', '661594f13f5d443238ee77d1', { stage: 'primary-write-unconfirmed' }, () => redis.set(`qa_grant:${installToken}`, JSON.stringify(grant), { EX: GRANT_TTL }), undefined, undefined, undefined);

  });
},
};
