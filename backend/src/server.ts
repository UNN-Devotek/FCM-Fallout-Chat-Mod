// dotenv is loaded in config/environment.ts before any env vars are read
import { constantTimeEquals } from './utils/constantTimeEquals';
import { clientIp } from './utils/clientIp';
import { requireAuth, requireAnyAuthedClient } from './middleware/auth';
import { mergeUserInto } from './utils/mergeUser';
import { devPersonaDiscordId, devPersonaUsername } from './utils/devPersonaDiscordId';

import http from 'http';

import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';

import env from './config/environment';
import logger from './config/logger';
import { getRedisClient, client as redisClient } from './config/redis';
import prisma from './config/prisma';
import { Prisma } from '@prisma/client';
import { errorHandler, createError } from './middleware/errorHandler';
import { apiLimiter, debugReportLimiter, channelsLimiter, partiesListLimiter, hudFeedLimiter } from './middleware/rateLimiter';
import { requireAdminKey } from './middleware/requireAdminKey';
import { requireClientAuth } from './middleware/requireClientAuth';
import { query as dbQueryFn } from './config/database';

// Routes
import healthRouter from './routes/health';
import versionRouter from './routes/version';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import devicesRouter from './routes/devices';
import channelsRouter from './routes/channels';
import messagesRouter from './routes/messages';
import reportsRouter from './routes/reports';
import moderationRouter from './routes/moderation';
import moderationActionsRouter from './routes/moderationActions';
import { sweepExpired as sweepModExpired } from './services/moderationActionsService';
import auditLogRouter from './routes/auditLog';
import adminUsersRouter from './routes/adminUsers';
import releasesRouter from './routes/releases';
import nameBlacklistRouter from './routes/nameBlacklist';
import { loadBlacklist, subscribeBlacklistUpdates } from './services/nameBlacklistService';
import adminStatusRouter from './routes/adminStatus';
import commandsRouter from './routes/commands';
import wikiRouter from './routes/wiki';
import campRouter from './routes/camp';
import playerReportsRouter from './routes/playerReports';
import applicationsRouter from './routes/applications';
import simUsersRouter from './routes/simUsers';
import mcpTokensRouter from './routes/mcpTokens';
import mcpRouter from './routes/mcp';
import mcpAdminRouter from './routes/mcpAdmin';
import playerListRouter from './routes/playerList';
import gameBridgeRouter from './routes/gameBridge';
import adminTelemetryRouter from './routes/adminTelemetry';
import verifyDevRoleRouter from './routes/verifyDevRole';
import { publicModerationLog } from './controllers/publicModerationController';
import publicStatsRouter from './routes/publicStats';
import { startOnlineSnapshotJob } from './jobs/onlineSnapshotJob';
import { makeJobTracker } from './jobs/jobTracker';
import discordEmojisRouter from './routes/discordEmojis';
import tenorSearchRouter from './routes/tenorSearch';
import blockRouter from './routes/block';
import {
  ingestRouter as clientMetricsIngestRouter,
  adminRouter as clientMetricsAdminRouter,
  debugRouter as clientMetricsDebugRouter,
} from './routes/clientMetrics';
import { startClientMetricsPurgeJob } from './jobs/clientMetricsPurge';
import {
  adminRouter as communityStatsAdminRouter,
  debugRouter as communityStatsDebugRouter,
} from './routes/adminCommunityStats';
import migrationRouter from './routes/migration';
import { requireMigrationKey } from './middleware/requireMigrationKey';

// Services
import * as discordService from './services/discordService';
import { captureAvatar, buildAvatarUrl } from './services/avatarService';
import { getAvatarObject, getPartyImageObject } from './config/storage';
import * as roleVerificationService from './services/roleVerificationService';
import { handleConnection, broadcast, broadcastMessageDeletion, broadcastReportAlert, broadcastChannelUpdate, broadcastCommandsUpdate, getClientCount, initPubSub, snapshotActiveClients, broadcastTelemetrySet, resolveDisplayName, pushToUser, isUserWsConnected, isPendingDisconnect, refreshClientIdentity, broadcastToPartyMembers, getConnectedUserIds, refreshClientBlocks } from './websocket/handlers';
import { startPartyReapJob } from './jobs/partyReap';
import { startWikiIngestJob } from './jobs/wikiIngest';
import { startWikiSyncSchedule } from './jobs/wikiSyncSchedule';
import { triggerWikiIngest, getWikiUpdates } from './controllers/wikiAdminController';
import { triggerCampIngest, getCampUpdates } from './controllers/campAdminController';
import { ingestCampDatabase, isCampTableEmpty } from './services/campService';
import { startCampSyncSchedule } from './jobs/campSyncSchedule';
import partiesRouter from './routes/parties';
import {
  adminListParties,
  adminGetParty,
  adminListPartyMessages,
  adminDeletePartyMessage,
  listPublicParties,
  listPublicPartyMessages,
} from './controllers/partiesController';
import { requireDiscordRole } from './middleware/auth';
import { initHudPushTcp } from './services/hudPushTcp';
import { initHudPushWs } from './services/hudPushWs';
import { initLatestVersion } from './services/latestReleaseVersion';
import hudFeedRouter from './routes/hudFeed';

const app = express();
const server = http.createServer(app);

// -- Middleware ----------------------------------------------------------------
// helmet sets secure HTTP headers (XSS, clickjacking, MIME sniffing, etc.)
// CSP (finding #14): policy is owned by Express so prod + dev share the same
// allowlist and rogue inline scripts are blocked regardless of reverse-proxy
// config. The admin dashboard SPA is served from this same origin (see
// express.static(dashboardDist) below) so 'self' covers its bundle. Verified
// admin-dashboard/dist/index.html contains no inline scripts — Vite emits a
// single <script type="module" src="..."> tag.
const isProd = env.NODE_ENV === 'production';
const cspConnectSrc: string[] = ["'self'", 'wss://falloutchatmod.com', 'https://cdn.discordapp.com'];
if (!isProd) {
  cspConnectSrc.push('ws://localhost:*', 'http://localhost:*');
}
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'https:', 'data:'],
      connectSrc: cspConnectSrc,
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));

app.use(cors({
  origin: env.CLIENT_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
}));

// Trust proxy for real client-IP detection behind Dokploy/Traefik (+ Cloudflare).
// 1 hop = Traefik. The clientIp() helper additionally prefers CF-Connecting-IP
// once Cloudflare is in front, so per-IP limits don't collapse all users into
// one edge IP. Gated on TRUST_PROXY so a direct deploy can't be spoofed.
app.set('trust proxy', env.TRUST_PROXY ? 1 : false);

// Game bridge must be mounted BEFORE express.json() so its own captureAnyBody
// middleware handles body parsing — the global JSON parser would otherwise reject
// Scaleform's non-standard bodies before the route handler sees them.
if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
  app.use('/api/game/player-bridge', gameBridgeRouter);
}

// Capture the raw request body so device-signature middleware can hash the
// exact bytes the client signed (req.body is the parsed object, which can't
// be re-serialised byte-identically). req.rawBody is the unparsed Buffer.
app.use(express.json({
  limit: '64kb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false }));

// Sessions backed by Redis
app.use(session({
  store: new RedisStore({ client: redisClient as any }),
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 4 * 60 * 60 * 1000, // 4h
  },
}));

app.use('/api/', apiLimiter);

// -- Discord OAuth2 routes ----------------------------------------------------

// Dev-only persona logins — skips Discord entirely.
// Gated POSITIVELY: requires development mode AND an explicit ENABLE_DEV_LOGIN
// opt-in, so these credential-less admin sessions can never appear in a
// non-development deploy (even a misconfigured one).
if (env.NODE_ENV === 'development' && env.ENABLE_DEV_LOGIN) {
  const DEV_PERSONAS: Record<string, { id: string; username: string; role: string }> = {
    user:      { id: 'dev-user-001',      username: 'System User',      role: env.DEV_USER_ROLE },
    mod:       { id: 'dev-user-002',      username: 'System Mod',       role: env.DEV_MOD_ROLE },
    moderator: { id: 'dev-user-002',      username: 'System Moderator', role: env.DEV_MOD_ROLE },
    admin:     { id: 'dev-user-003',      username: 'System Admin',     role: env.DEV_ADMIN_ROLE },
    supporter: { id: 'dev-user-004',      username: 'System Supporter', role: env.DEV_SUPPORTER_ROLE },
    developer: { id: 'dev-user-005',      username: 'System Developer', role: env.DEV_DEVELOPER_ROLE },
    owner:     { id: 'dev-user-006',      username: 'System Owner',     role: 'owner' },
  };

  const DEV_PRIVILEGED = ['owner', 'admin', 'moderator', 'supporter', 'developer'];
  app.get('/auth/dev-login/:persona', (req: Request, res: Response) => {
    const persona = DEV_PERSONAS[req.params.persona];
    if (!persona) { res.status(404).send('Unknown dev persona'); return; }
    (req.session as any).discordUser = { ...persona, avatar: null, roles: [] };
    const dest = DEV_PRIVILEGED.includes(persona.role) ? 'server-health' : 'chat';
    req.session.save(() => res.redirect(`${env.CLIENT_ORIGINS[0].replace(/\/$/, '')}/${dest}`));
  });

  // Keep old /auth/dev-login as alias for admin persona
  app.get('/auth/dev-login', (req: Request, res: Response) => {
    (req.session as any).discordUser = { ...DEV_PERSONAS.admin, avatar: null, roles: [] };
    req.session.save(() => res.redirect(`${env.CLIENT_ORIGINS[0].replace(/\/$/, '')}/server-health`));
  });

  // Dev shortcuts for public auth (apply / report) — sets publicUser session, no Discord needed
  app.get('/auth/dev-public/:intent', (req: Request, res: Response) => {
    const intent = req.params.intent;
    if (intent !== 'apply' && intent !== 'report') { res.status(404).send('Unknown intent'); return; }
    (req.session as any).publicUser = {
      discordId: 'dev-public-001',
      username: 'DevUser',
      discordDisplayName: 'Dev User',
      avatar: null,
      intent,
    };
    req.session.save(() => res.redirect(`${env.CLIENT_ORIGINS[0].replace(/\/$/, '')}/${intent}`));
  });

  // Overlay dev login — returns a session token directly (no Discord OAuth needed).
  // Called by the unpackaged Electron overlay's onboarding "Login as system user" buttons.
  app.post('/api/dev/login-as', async (req: Request, res: Response) => {
    const { persona, installToken } = req.body as { persona?: string; installToken?: string };
    if (!persona || !installToken) { res.status(400).json({ error: 'Missing persona or installToken' }); return; }
    const p = DEV_PERSONAS[persona];
    if (!p) { res.status(404).json({ error: 'Unknown persona' }); return; }
    try {
      // Unique per (persona, install) so multiple local installs can each adopt
      // the same persona without colliding on the discord_id_link unique
      // constraint. Persona still drives the role via the adminUser upsert below.
      const fakeDiscordId = devPersonaDiscordId(persona, installToken);
      await prisma.user.upsert({
        where: { installToken },
        create: {
          installToken,
          // Canonical username is @unique → must be unique per install; the clean
          // persona name is preserved in discordDisplayName + the response below.
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
      if (DEV_PRIVILEGED.includes(p.role)) {
        await prisma.adminUser.upsert({
          where: { discordId: fakeDiscordId },
          create: { discordId: fakeDiscordId, username: p.username, role: p.role, updatedAt: new Date() },
          update: { role: p.role, updatedAt: new Date() },
        });
      }
      const user = await prisma.user.findUnique({ where: { installToken }, select: { id: true } });
      if (!user) throw new Error('User not found after upsert');
      const redis = await getRedisClient();
      const token = uuidv4();
      const SESSION_TTL = 24 * 60 * 60; // 24 hours (was 30 days)
      await redis.set(`session:${token}`, user.id, { EX: SESSION_TTL });
      res.json({ data: { token, displayName: p.username, discordLinked: true, role: p.role } });
    } catch (err) {
      logger.error({ err }, '[dev] login-as failed');
      res.status(500).json({ error: 'Dev login failed' });
    }
  });
}

app.get('/auth/discord', async (req: Request, res: Response) => {
  // CSRF protection: store state token in Redis (session cookies unreliable behind reverse proxies)
  const intent = (req.query.intent as string) || 'admin';
  const state = uuidv4();
  try {
    const redis = await getRedisClient();
    await redis.set(`oauth_state:${state}`, JSON.stringify({ intent }), { EX: 300 }); // 5 min TTL
  } catch (err) {
    logger.error({ err }, 'Failed to store OAuth state in Redis');
    res.status(500).send('Internal error');
    return;
  }
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code) { res.status(400).send('Missing code'); return; }

  // Validate CSRF state token from Redis
  let stateData: { intent: string } = { intent: 'admin' };
  try {
    const redis = await getRedisClient();
    const valid = await redis.get(`oauth_state:${state}`); await redis.del(`oauth_state:${state}`);
    if (!state || !valid) {
      res.status(403).send('Invalid OAuth state -- possible CSRF. Please try logging in again.');
      return;
    }
    try { stateData = JSON.parse(valid); } catch { stateData = { intent: 'admin' }; }
  } catch (err) {
    logger.error({ err }, 'Failed to validate OAuth state');
    res.status(500).send('Internal error');
    return;
  }

  const isPublicAuth = stateData.intent === 'report' || stateData.intent === 'apply';
  const frontendBase = env.CLIENT_ORIGINS[0].replace(/\/$/, '');

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.DISCORD_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json() as any;
    if (!tokenData.access_token) throw new Error('No access token');

    // Fetch user identity
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json() as any;

    // Verify server membership — required for all auth flows
    const memberRes = await fetch(
      `https://discord.com/api/users/@me/guilds/${env.DISCORD_SERVER_ID}/member`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!memberRes.ok) {
      res.redirect(`${frontendBase}/login?error=not_in_discord`);
      return;
    }

    if (isPublicAuth) {
      // Public auth (report/apply) — no admin role enforcement
      // global_name is Discord's display name (may differ from username handle)
      // SR-008: coerce to string — discordUser is typed any, guard against unexpected types
      const discordDisplayName: string = String(discordUser.global_name || discordUser.username).slice(0, 128);
      // Upsert discord_display_name on any linked user record
      await prisma.user.updateMany({
        where: { discordId: discordUser.id },
        data: { discordDisplayName },
      });
      (req.session as any).publicUser = {
        discordId: discordUser.id,
        username: discordUser.username,
        discordDisplayName,
        avatar: discordUser.avatar,
        intent: stateData.intent,
      };
      await new Promise<void>(resolve => req.session.save(() => resolve()));
      res.redirect(`${frontendBase}/${stateData.intent}`);
      return;
    }

    const member = await memberRes.json() as any;
    const qualifyingRoles = [env.OWNER_ROLE_ID, env.ADMIN_ROLE_ID, env.MODERATOR_ROLE_ID].filter(Boolean);
    const userRoles: string[] = member.roles || [];
    const matchedRoles = qualifyingRoles.filter((r) => userRoles.includes(r));

    // Open access: every member of the Discord guild can sign in. Users with a
    // designated admin/mod role get that role; everyone else gets 'member',
    // which the dashboard's RoleGuard sends to the chat overlay. Guild
    // membership itself is enforced by the upstream `memberRes` check.
    const adminRole = roleVerificationService.resolveRole(matchedRoles) || 'member';

    // Only upsert into admin_users for actual admin/mod roles — keep that
    // table reserved for elevated identities, not every member.
    if (adminRole !== 'member') {
      await prisma.adminUser.upsert({
        where: { discordId: discordUser.id },
        update: { username: discordUser.username, role: adminRole },
        create: { discordId: discordUser.id, username: discordUser.username, role: adminRole },
      }).catch((err: Error) => logger.warn({ err }, 'Failed to upsert admin_users (non-fatal)'));
    }

    // Update game user record if linked. discordDisplayName is refreshed on
    // every login so the user's chat label tracks Discord global-name changes.
    await prisma.user.updateMany({
      where: { discordId: discordUser.id },
      data: {
        discordUsername: discordUser.username,
        discordAvatar: discordUser.avatar || null,
        discordDisplayName: String(discordUser.global_name || discordUser.username).slice(0, 128),
      },
    }).catch(() => { /* non-fatal */ });

    // Capture avatar to MinIO (fire-and-forget)
    captureAvatar(discordUser.id, discordUser.avatar).catch(() => { /* non-fatal */ });

    // Ensure admin has a game user record so they appear in user management
    const adminDisplayName = String(discordUser.global_name || discordUser.username).slice(0, 128);
    const existingGameUser = await prisma.user.findFirst({ where: { discordId: discordUser.id } });
    if (!existingGameUser) {
      await prisma.user.create({
        data: {
          username: discordUser.global_name || discordUser.username,
          installToken: uuidv4(),
          discordId: discordUser.id,
          discordUsername: discordUser.username,
          discordDisplayName: adminDisplayName,
          discordAvatar: discordUser.avatar || null,
        },
      }).catch((err: Error) => logger.warn({ err }, 'Failed to auto-create game user for admin'));
    } else {
      // Keep discordDisplayName in sync on every admin login
      await prisma.user.update({
        where: { id: existingGameUser.id },
        data: { discordDisplayName: adminDisplayName },
      }).catch(() => { /* non-fatal */ });
    }

    // Cache the verified role in Redis
    await roleVerificationService.cacheRole(discordUser.id, adminRole).catch(() => { /* non-fatal */ });

    (req.session as any).discordUser = {
      id: discordUser.id,
      username: discordUser.username,
      discordDisplayName: String(discordUser.global_name || discordUser.username).slice(0, 128),
      avatar: discordUser.avatar,
      roles: matchedRoles,
      role: adminRole,
    };

    // Redirect to the frontend dashboard. Members (non-admin) land on /chat;
    // admin/mod roles land on /server-health.
    await new Promise<void>(resolve => req.session.save(() => resolve()));
    res.redirect(`${frontendBase}${adminRole === 'member' ? '/chat' : '/server-health'}`);
  } catch (err) {
    logger.error({ err }, 'Discord OAuth callback error');
    res.status(500).send('Authentication failed.');
  }
});

// -- Discord OAuth2 link routes (desktop game clients) ------------------------

const PIP_BOY_HTML = (title: string, heading: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png"     href="/favicon.png" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0900;
      color: #f0e8cc;
      font-family: 'Courier New', Courier, monospace;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .site-title {
      font-size: 1rem;
      letter-spacing: 0.25em;
      color: #d4b040;
      text-transform: uppercase;
      margin-bottom: 2rem;
      opacity: 0.7;
    }
    .card {
      border: 1px solid rgba(212,176,64,0.35);
      background: #1e1908;
      max-width: 480px;
      width: 100%;
      padding: 2rem 2.5rem;
      box-shadow: 0 0 24px rgba(212,176,64,0.15), 0 0 2px rgba(212,176,64,0.3);
    }
    h1 {
      font-size: 1.1rem;
      letter-spacing: 0.12em;
      margin-bottom: 1.25rem;
      text-transform: uppercase;
      color: #d4b040;
      text-shadow: 0 0 8px rgba(212,176,64,0.5);
    }
    p { line-height: 1.7; font-size: 0.9rem; color: #c0a870; }
    p strong { color: #f0e8cc; }
    a { color: #d4b040; }
    .dim { color: #7a6438; font-size: 0.75rem; margin-top: 1rem; }
    .divider { border: none; border-top: 1px solid rgba(212,176,64,0.2); margin: 1.25rem 0; }
  </style>
</head>
<body>
  <div class="site-title">Fallout Chat Mod</div>
  <div class="card">
    <h1>${heading}</h1>
    <hr class="divider" />
    ${body}
  </div>
</body>
</html>`;

/**
 * GET /auth/discord/link
 * Initiates Discord OAuth linking for a desktop game client identified by installToken.
 */
app.get('/auth/discord/link', async (req: Request, res: Response) => {
  const { installToken } = req.query as { installToken?: string };
  if (!installToken) { res.status(400).send('Missing installToken'); return; }

  // NO pre-creation. Per the "no user record until Discord login" rule, the user
  // row is created in the OAuth CALLBACK once Discord actually confirms identity —
  // so an abandoned link (user closes the OAuth window) leaves NO orphan row. The
  // OAuth state lives in Redis (below), not in a user row.

  const state = uuidv4();
  try {
    const redis = await getRedisClient();
    await redis.set(`oauth_link_state:${state}`, installToken, { EX: 300 }); // 5 min TTL
  } catch (err) {
    logger.error({ err }, 'Failed to store OAuth link state in Redis');
    res.status(500).send('Internal error');
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:7076';
  const linkRedirectUri = env.DISCORD_LINK_REDIRECT_URI || `${proto}://${host}/auth/discord/link/callback`;

  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: linkRedirectUri,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

/**
 * GET /auth/discord/link/callback
 * OAuth callback for desktop game client Discord linking.
 */
app.get('/auth/discord/link/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code) { res.status(400).send('Missing code'); return; }

  let installToken: string;
  try {
    const redis = await getRedisClient();
    const stored = await redis.get(`oauth_link_state:${state}`); await redis.del(`oauth_link_state:${state}`);
    if (!state || !stored) {
      res.status(403).send('Invalid OAuth state — possible CSRF. Please try again.');
      return;
    }
    installToken = stored;
  } catch (err) {
    logger.error({ err }, 'Failed to validate OAuth link state');
    res.status(500).send('Internal error');
    return;
  }

  try {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:7076';
    const linkRedirectUri = env.DISCORD_LINK_REDIRECT_URI || `${proto}://${host}/auth/discord/link/callback`;

    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: linkRedirectUri,
      }),
    });
    const tokenData = await tokenRes.json() as any;
    if (!tokenData.access_token) throw new Error('No access token from Discord');

    // Fetch Discord identity
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json() as any;

    // Check guild membership (guilds.members.read scope)
    const memberRes = await fetch(
      `https://discord.com/api/users/@me/guilds/${env.DISCORD_SERVER_ID}/member`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!memberRes.ok) {
      res.status(403).send(PIP_BOY_HTML(
        'Not a Member — Fallout Chat Mod',
        'Access Denied',
        `<p>You must join the Fallout Chat Mod Discord server before linking your account.</p>
         <p style="margin-top:1rem"><a href="https://discord.gg/NJBJqyvRJC" target="_blank">Join the server &rarr;</a></p>
         <p class="dim">Once you've joined, return to the game and try linking again.</p>`
      ));
      return;
    }

    const member = await memberRes.json() as any;
    const discordDisplayName = member.nick || discordUser.global_name || discordUser.username;

    const redis = await getRedisClient();

    // Check for any existing row already claiming this Discord ID (placeholder OR real).
    // discordId is now the canonical identity anchor — if ANY row owns it we merge into it.
    const existingAccount = await prisma.user.findFirst({
      where: { discordId: discordUser.id, NOT: { installToken } },
      select: { id: true, username: true },
    });

    if (existingAccount) {
      // Account reclaim: the new install's placeholder must be merged into the canonical
      // row, ALL FK tables re-pointed, then the placeholder deleted. mergeUserInto()
      // handles every FK table including collision-safe @@unique tables.
      const placeholder = await prisma.user.findUnique({ where: { installToken }, select: { id: true } });
      await prisma.$transaction(async (tx) => {
        if (placeholder && placeholder.id !== existingAccount.id) {
          await mergeUserInto(existingAccount.id, placeholder.id, tx);
        }
        await tx.user.update({
          where: { id: existingAccount.id },
          data: { installToken, discordUsername: discordUser.username, discordAvatar: discordUser.avatar, discordDisplayName, discordAuthedAt: new Date() },
        });
      });

      captureAvatar(discordUser.id, discordUser.avatar).catch(() => {});

      // Push updated identity to any open WS sessions for the reclaimed account.
      try {
        refreshClientIdentity(
          existingAccount.id,
          existingAccount.username,
          discordUser.username,
          discordDisplayName,
          installToken,
        );
      } catch (err) {
        logger.warn({ err, userId: existingAccount.id }, 'Discord link reclaim: refreshClientIdentity failed (non-fatal)');
      }

      await redis.set(
        `discord_link:${installToken}`,
        JSON.stringify({
          discordId: discordUser.id,
          discordUsername: discordUser.username,
          discordAvatar: discordUser.avatar,
          discordDisplayName,
          reclaimed: true,
          existingUsername: existingAccount.username,
        }),
        { EX: 600 },
      );

      logger.info({ installToken, discordId: discordUser.id, existingUsername: existingAccount.username }, 'Discord link — account reclaimed');

      res.send(PIP_BOY_HTML(
        'Welcome Back — Fallout Chat Mod',
        'Account Restored',
        `<p>Your Discord account <strong>${discordUser.username}</strong> has been linked to your game client.</p>
         <p>Your previous account for <strong>${existingAccount.username}</strong> has been restored.</p>
         <p class="dim">You can close this window and return to the game.</p>`
      ));
      return;
    }

    // Safety net: clear any lingering discordId claim from placeholder rows that
    // were NOT caught by the existingAccount reclaim path above (e.g. old rows
    // created before this fix was deployed). Placeholder = pending-*, Overlay\d+,
    // or discord: synthetic relay users. Never touch real-name rows (that would
    // break register()-side self-reclaim for already-linked users).
    await prisma.user.updateMany({
      where: {
        discordId: discordUser.id,
        NOT: { installToken },
        OR: [
          { username: { startsWith: 'pending-' } },
          { installToken: { startsWith: 'discord:' } },
        ],
      },
      data: { discordId: null },
    });

    // Persist Discord identity. UPSERT (not update): the install row no longer
    // exists until this point (the link endpoint no longer pre-creates it and
    // register() is gated for unlinked installs), so we CREATE the canonical
    // user here on first successful Discord auth. The username is a unique
    // `discord:<id>` placeholder — resolveDisplayName() treats it as a placeholder
    // and renders discordDisplayName until the user sets a real FO76 name.
    // We refresh discordDisplayName on every callback so the chat name tracks any
    // Discord global/nick change.
    const linkedUser = await prisma.user.upsert({
      where: { installToken },
      update: {
        discordId: discordUser.id,
        discordUsername: discordUser.username,
        discordAvatar: discordUser.avatar,
        discordDisplayName,
        discordAuthedAt: new Date(),
      },
      create: {
        installToken,
        username: `discord:${discordUser.id}`,
        discordId: discordUser.id,
        discordUsername: discordUser.username,
        discordAvatar: discordUser.avatar,
        discordDisplayName,
        discordAuthedAt: new Date(),
      },
      select: { id: true, username: true },
    });

    // Push updated identity to any open WS sessions so rendered names update live.
    try {
      refreshClientIdentity(
        linkedUser.id,
        linkedUser.username,
        discordUser.username,
        discordDisplayName,
        installToken,
      );
    } catch (err) {
      logger.warn({ err, userId: linkedUser.id }, 'Discord link: refreshClientIdentity failed (non-fatal)');
    }

    captureAvatar(discordUser.id, discordUser.avatar).catch(() => { /* non-fatal */ });

    await redis.set(
      `discord_link:${installToken}`,
      JSON.stringify({
        discordId: discordUser.id,
        discordUsername: discordUser.username,
        discordAvatar: discordUser.avatar,
        discordDisplayName,
      }),
      { EX: 600 },
    );

    logger.info({ installToken, discordId: discordUser.id }, 'Discord account linked to game client');

    res.send(PIP_BOY_HTML(
      'Discord Linked — Fallout Chat Mod',
      'Discord Linked Successfully',
      `<p>Your Discord account <strong>${discordUser.username}</strong> has been linked to your game client.</p>
       <p class="dim">You can close this window and return to the game.</p>`
    ));
  } catch (err) {
    logger.error({ err, installToken }, 'Discord link callback error');
    res.send(PIP_BOY_HTML(
      'Error — Fallout Chat Mod',
      'Authentication Failed',
      `<p>Something went wrong linking your Discord account. Please try again.</p>
       <p class="dim">If this keeps happening, try closing the setup wizard and reopening it.</p>`
    ));
  }
});

/**
 * GET /api/auth/discord-status/:installToken
 * Polling endpoint for desktop clients to check Discord link status.
 */
app.get('/api/auth/discord-status/:installToken', async (req: Request, res: Response) => {
  const { installToken } = req.params;
  if (!installToken) { res.status(400).json({ data: { linked: false } }); return; }

  try {
    // Always resolve the live account row so we can return the FO76 username +
    // resolved displayName + avatar URL. After a Discord-link reclaim the
    // installToken points at the reclaimed account, so this is how the overlay
    // discovers its REAL identity (e.g. "Devotek-") and can re-register without
    // clobbering it with a stale local placeholder name.
    const user = await prisma.user.findUnique({
      where: { installToken },
      select: { username: true, discordId: true, discordUsername: true, discordDisplayName: true, discordAvatar: true, installToken: true },
    });
    const isPlaceholder = (u?: string | null) => !u || u === 'Wanderer' || u.startsWith('pending-');
    const fo76Username = user && !isPlaceholder(user.username) ? user.username : null;
    const displayName = user ? resolveDisplayName(user) : null;
    const discordAvatarUrl = user?.discordId && user.discordAvatar
      ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.discordAvatar}.png?size=128`
      : null;

    const redis = await getRedisClient();
    const cached = await redis.get(`discord_link:${installToken}`);
    if (cached) {
      const parsed = JSON.parse(cached);
      res.json({ data: { linked: true, username: fo76Username, displayName, discordAvatarUrl, ...parsed } });
      return;
    }

    if (user?.discordId) {
      res.json({
        data: {
          linked: true,
          username: fo76Username,
          displayName,
          discordId: user.discordId,
          discordUsername: user.discordUsername,
          discordAvatar: user.discordAvatar,
          discordAvatarUrl,
          discordDisplayName: user.discordDisplayName || user.discordUsername,
        },
      });
      return;
    }

    res.json({ data: { linked: false, username: fo76Username, displayName, discordAvatarUrl: null } });
  } catch (err) {
    logger.error({ err }, 'Failed to check discord-status');
    res.status(500).json({ data: { linked: false } });
  }
});

app.get('/auth/logout', (req: Request, res: Response) => {
  req.session.destroy(() => res.redirect('/'));
});

/**
 * GET /auth/ws-ticket -- issues a 60-second single-use WS ticket for admin observers.
 * Only privileged roles (owner/admin/moderator) may obtain a ticket.
 */
app.get('/auth/ws-ticket', async (req: Request, res: Response) => {
  if (!(req.session as any)?.discordUser) { res.status(401).json({ data: null }); return; }

  const discordUser = (req.session as any).discordUser;
  // Role gate: only privileged staff may open admin-observer sockets.
  const { isPrivilegedRole } = await import('./services/userRoleService');
  if (!isPrivilegedRole(discordUser.role)) {
    res.status(403).json({ data: null });
    return;
  }

  const ticket = uuidv4();
  try {
    const redis = await getRedisClient();
    await redis.set(`ws_ticket:${ticket}`, JSON.stringify({
      type: 'admin',
      discordId: discordUser.id,
      username: discordUser.username,
      role: discordUser.role,
    }), { EX: 60 });
    res.json({ data: { ticket } });
  } catch (err) {
    logger.error({ err }, 'Failed to create WS ticket');
    res.status(500).json({ data: null });
  }
});

app.get('/auth/me', async (req: Request, res: Response) => {
  const sessionUser = (req.session as any).discordUser;
  if (!sessionUser) { res.status(401).json({ data: null }); return; }

  let fo76Name: string | null = null;
  let discordDisplayName: string = sessionUser.discordDisplayName ?? sessionUser.username;
  // Avatar resolution is AUTHORITATIVE from the DB: captureAvatar runs on every
  // auth and the user row's discordId/discordAvatar reflect the latest Discord
  // avatar hash. Build the served URL from the DB row whenever a hash is stored,
  // so the header/overlay get a real avatarUrl even when this particular session
  // didn't carry an `avatar` field. Fall back to the session avatar.
  let avatarUrl: string | null = null;
  try {
    const row = await prisma.user.findFirst({
      where: { discordId: sessionUser.id },
      select: { username: true, discordDisplayName: true, discordId: true, discordAvatar: true },
    });
    if (row?.username && row.username.trim() !== '' && row.username !== 'Wanderer' && !row.username.startsWith('discord:')) {
      fo76Name = row.username;
    }
    if (row?.discordDisplayName) discordDisplayName = row.discordDisplayName;
    if (row?.discordAvatar && row.discordId) {
      avatarUrl = buildAvatarUrl(row.discordId);
    }
  } catch (_err) {
    // non-fatal — proceed without fo76Name / DB-derived avatar
  }

  // Fall back to the session avatar (e.g. row not yet created, or dev persona
  // resolved below). Server-stored avatar lives on our domain and is refreshed
  // on every Discord auth. Null → frontend falls back to its default avatar.
  if (!avatarUrl && sessionUser.avatar) {
    avatarUrl = buildAvatarUrl(sessionUser.id);
  }

  // Dev personas (local logins, non-production) have no real Discord avatar and
  // a non-numeric id that the /avatars/:discordId route rejects. Point them at
  // the bundled default so local testing always shows *an* avatar image.
  if (!avatarUrl && env.NODE_ENV !== 'production' && String(sessionUser.id).startsWith('dev-')) {
    avatarUrl = '/avatars/default';
  }

  res.json({ data: { ...sessionUser, fo76Name, discordDisplayName, avatarUrl } });
});

// -- Served avatars -----------------------------------------------------------
// Streams the user's server-stored Discord avatar (MinIO object
// avatars/<discordId>.png) from OUR domain, so the overlay/dashboard render it
// same-origin regardless of MinIO's public-URL config. The stored copy is
// refreshed on every Discord auth (see captureAvatar). 404 when missing → the
// frontend falls back to its default avatar. discordId is digits-only.
// Bundled default avatar (Pip-Boy phosphor-green silhouette). Inlined as a
// string so it survives `tsc` without an asset-copy step. Used by dev personas
// (which have no real Discord avatar) and as a generic fallback target.
const DEFAULT_AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
  '<rect width="128" height="128" fill="#0a1a0e"/>' +
  '<circle cx="64" cy="64" r="62" fill="none" stroke="#18FF62" stroke-width="2"/>' +
  '<circle cx="64" cy="50" r="22" fill="#18FF62"/>' +
  '<path d="M24 116c0-22 18-36 40-36s40 14 40 36" fill="#18FF62"/>' +
  '</svg>';

app.get('/avatars/default', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(DEFAULT_AVATAR_SVG);
});

// Redirect to the live Discord CDN for a user's avatar. Used as the fallback
// when MinIO has no stored copy (the prod MinIO has historically been
// unreachable via the shared `minio` network alias, so the stored cache is
// usually empty). Looks up the stored avatar hash; null when the user has no
// linked Discord or no custom avatar (caller falls back to /avatars/default).
async function discordCdnAvatarUrl(discordId: string): Promise<string | null> {
  const user = await prisma.user.findFirst({
    where: { discordId },
    select: { discordAvatar: true },
  });
  if (!user?.discordAvatar) return null;
  // Animated avatars (hash prefixed a_) still serve fine as .png.
  return `https://cdn.discordapp.com/avatars/${discordId}/${user.discordAvatar}.png?size=128`;
}

app.get('/avatars/:discordId', async (req: Request, res: Response) => {
  const discordId = String(req.params.discordId || '').replace(/\.png$/i, '');
  if (!/^\d{1,32}$/.test(discordId)) { res.status(404).end(); return; }
  try {
    const obj = await getAvatarObject(discordId);
    if (!obj) {
      // No stored copy — redirect to the live Discord CDN if we know the hash.
      const cdn = await discordCdnAvatarUrl(discordId);
      if (cdn) { res.redirect(302, cdn); return; }
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Cache-Control', 'public, max-age=300'); // short cache; refreshed each auth
    if (obj.contentLength != null) res.setHeader('Content-Length', String(obj.contentLength));
    obj.body.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); });
    obj.body.pipe(res);
  } catch (err) {
    logger.warn({ err, discordId }, 'avatar stream failed');
    // Last-ditch: try the Discord CDN before giving up.
    try {
      const cdn = await discordCdnAvatarUrl(discordId);
      if (cdn && !res.headersSent) { res.redirect(302, cdn); return; }
    } catch { /* ignore */ }
    if (!res.headersSent) res.status(404).end();
  }
});

// -- Served party images -------------------------------------------------------
// Streams party-chat images (MinIO key party-images/<uuid>.<ext>) from our own
// domain. The imageId path param is <uuid>.<ext> (e.g. abc123.jpg).
// The id must be <uuid>.<safe-ext> to reject path traversal / arbitrary reads.
app.get('/party-images/:imageId', async (req: Request, res: Response) => {
  const raw = String(req.params.imageId || '');
  // Allow UUIDs (with hyphens) followed by a dot and a safe image extension.
  const m = raw.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|bin)$/i);
  if (!m) { res.status(404).end(); return; }
  const [, imageId, ext] = m;
  try {
    const obj = await getPartyImageObject(imageId, ext);
    if (!obj) { res.status(404).end(); return; }
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (obj.contentLength != null) res.setHeader('Content-Length', String(obj.contentLength));
    obj.body.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); });
    obj.body.pipe(res);
  } catch (err) {
    logger.warn({ err, imageId }, 'party-image stream failed');
    if (!res.headersSent) res.status(404).end();
  }
});

// -- API Routes ----------------------------------------------------------------
app.use('/api/health', healthRouter);
app.use('/api/version', versionRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/devices', devicesRouter); // device-keypair enrol + admin list/revoke
app.use('/api/channels', channelsLimiter, channelsRouter);
app.use('/api/messages', messagesRouter);
// Wiki catalog — public read endpoints (search + entry).
// Mounted BEFORE requireClientAuth so the logged-out website overlay and
// unauthenticated clients can query the local catalog without a session token.
// These routes NEVER call Fandom — they serve only from the local Postgres catalog.
app.use('/api/wiki', wikiRouter);

// CAMP item search — public, unauthenticated (same pattern as /api/wiki).
// Serves autocomplete results from the local camp_items table.
app.use('/api/camp', campRouter);

// HUD feed — public, unauthenticated. Polled by FCMBridge.swf via ZFE
// readRemoteData every ~300 s (ZFE cache). Returns { t: "record|record..." }.
app.use('/api/game/hud-feed', hudFeedLimiter, hudFeedRouter);

// Public, unauthenticated, read-only party endpoints (logged-out website overlay).
// Registered BEFORE the auth-gated /api/parties mount so these specific routes are
// not captured by requireClientAuth. Strictly limited to PUBLIC parties.
app.get('/api/parties/public', partiesListLimiter, listPublicParties);
app.get('/api/parties/public/:id/messages', partiesListLimiter, listPublicPartyMessages);
app.use('/api/parties', requireClientAuth, partiesRouter);
app.use('/api/block', requireClientAuth, blockRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/moderation', moderationRouter);
app.use('/api/moderation', moderationActionsRouter); // /kicks /mutes /bans /evidence /users/lookup
app.use('/api/audit-log', auditLogRouter);
app.use('/api/admin-users', adminUsersRouter);
app.use('/admin/releases', releasesRouter);
app.use('/api/releases', releasesRouter);
app.use('/api/admin/name-blacklist', nameBlacklistRouter);
app.use('/api/admin/status', adminStatusRouter);
app.use('/api/commands', commandsRouter);
// MCP token self-service (Discord OAuth session auth — dashboard users manage their own tokens)
app.use('/api/me/mcp-tokens', mcpTokensRouter);
// MCP tool API (dev env) — protected by MCP token auth, NOT behind Cloudflare Access
app.use('/api/mcp', mcpRouter);
// MCP tool API (prod/owner) — protected by prod MCP token auth, OWNER-ONLY
app.use('/api/mcp-admin', mcpAdminRouter);
app.use('/api/player-reports', playerReportsRouter);
// PROD-only narrow dev-role verification (Bearer PROD_VERIFY_TOKEN, returns
// { hasDevRole } only). Lives on prod because only the PROD bot can read the
// prod guild. See controllers/verifyDevRoleController.ts.
app.use('/api/internal', verifyDevRoleRouter);
app.use('/api/applications', applicationsRouter);
// Simulation/test surface — development opt-in only; never mounted in prod.
if (env.NODE_ENV === 'development' && env.ENABLE_DEV_LOGIN) {
  app.use('/api/admin/sim', simUsersRouter);
}
app.use('/api/player-list', playerListRouter);
// Client performance metrics — ingest (per-client) + admin views.
app.use('/api/client-metrics', clientMetricsIngestRouter);
app.use('/api/admin/client-metrics', clientMetricsAdminRouter);
app.use('/admin/debug/client-metrics', clientMetricsDebugRouter);

// Community stats — aggregated signup / message / version / download metrics.
// GET /api/admin/community-stats?range=90d   (Discord OAuth admin role)
// GET /admin/debug/community-stats?range=90d  (X-Admin-API-Key mirror)
app.use('/api/admin/community-stats', communityStatsAdminRouter);
app.use('/admin/debug/community-stats', communityStatsDebugRouter);

// ── Database migration suite ─────────────────────────────────────────────────
// POST /admin/migration/sql      — execute ad-hoc SQL (returns up to 1000 rows)
// POST /admin/migration/dump     — stream a pg_dump as a .sql attachment
// POST /admin/migration/restore  — pipe a .sql dump into psql (OVERWRITES data)
//
// Gated exclusively by X-Migration-Key (requireMigrationKey).  This key is
// separate from ADMIN_API_KEY and ADMIN_RELEASE_TOKEN.  The endpoints are NOT
// mounted under /api/ so they are outside the apiLimiter bucket; they carry
// their own strict rate limiter (10 req / 15 min per IP).
//
// pg_dump / psql binaries must be present in the container PATH.  They ship in
// the official postgres image; add `postgresql-client` if using a slim variant.
app.use('/admin/migration', requireMigrationKey, migrationRouter);

// Party admin endpoints — view all parties (incl. private), messages, and delete messages.
// Gated by Discord role (OWNER|ADMIN) for /api/admin/* and X-Admin-API-Key for /admin/debug/*.
// These share the same handler functions — only the auth middleware differs.
import { PARTIES_ENABLED } from './config/features';
// Feature gate: when PARTIES_ENABLED is false (default), the admin + debug party
// endpoints also return a clean JSON 404 so the feature is fully inert.
const requirePartiesEnabled: express.RequestHandler = (_req, _res, next) =>
  PARTIES_ENABLED ? next() : next(createError(404, 'Not found'));
app.get('/api/admin/parties', requirePartiesEnabled, requireDiscordRole('owner', 'admin'), adminListParties);
app.get('/api/admin/parties/:id', requirePartiesEnabled, requireDiscordRole('owner', 'admin'), adminGetParty);
app.get('/api/admin/parties/:id/messages', requirePartiesEnabled, requireDiscordRole('owner', 'admin'), adminListPartyMessages);
app.delete('/api/admin/parties/:partyId/messages/:messageId', requirePartiesEnabled, requireDiscordRole('owner', 'admin'), adminDeletePartyMessage);
// X-Admin-API-Key debug mirrors (CLI tooling)
app.get('/admin/debug/parties', requirePartiesEnabled, requireAdminKey, adminListParties);
app.get('/admin/debug/parties/:id', requirePartiesEnabled, requireAdminKey, adminGetParty);
app.get('/admin/debug/parties/:id/messages', requirePartiesEnabled, requireAdminKey, adminListPartyMessages);
app.delete('/admin/debug/parties/:partyId/messages/:messageId', requirePartiesEnabled, requireAdminKey, adminDeletePartyMessage);

// Wiki catalog — admin endpoints (owner|admin only)
// POST /api/admin/wiki/ingest  — trigger ingestion (incremental default or full)
// GET  /api/admin/wiki/updates — update-availability status (cached ~5 min)
app.post('/api/admin/wiki/ingest', requireDiscordRole('owner', 'admin'), triggerWikiIngest);
app.get('/api/admin/wiki/updates', requireDiscordRole('owner', 'admin'), getWikiUpdates);

// CAMP database — admin endpoints (owner|admin only)
// POST /api/admin/camp/ingest   — full re-sync: fetch, upsert, mirror images
// GET  /api/admin/camp/updates  — update-availability status (cached ~5 min)
app.post('/api/admin/camp/ingest',   requireDiscordRole('owner', 'admin'), triggerCampIngest);
app.get('/api/admin/camp/updates',   requireDiscordRole('owner', 'admin'), getCampUpdates);

// Remote telemetry control — admin GET/POST (Discord-OAuth admin role).
app.use('/api/admin/telemetry', adminTelemetryRouter);

// Admin-key authenticated mirrors of the telemetry endpoints — used by CLI
// tooling that can't carry a Discord OAuth session. Same semantics as
// /api/admin/telemetry but gated by X-Admin-API-Key.
app.get('/admin/debug/telemetry', requireAdminKey, async (_req, res, next) => {
  try {
    const { getTelemetryAdminView } = await import('./services/telemetryService');
    res.json({ data: await getTelemetryAdminView() });
  } catch (err) { next(err); }
});
app.post('/admin/debug/telemetry', requireAdminKey, async (req, res, next) => {
  try {
    const { setTelemetry } = await import('./services/telemetryService');
    const { scope: scopeStr, userId, enabled } = req.body as { scope: string; userId?: string; enabled: boolean };
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: '`enabled` must be a boolean' }); return; }
    if (scopeStr !== 'global' && scopeStr !== 'user') { res.status(400).json({ error: '`scope` must be "global" or "user"' }); return; }
    if (scopeStr === 'user' && !userId) { res.status(400).json({ error: '`userId` is required when scope is "user"' }); return; }
    const scope = scopeStr === 'global' ? { kind: 'global' as const } : { kind: 'user' as const, userId: userId! };
    const result = await setTelemetry(scope, enabled, 'admin-api');
    const broadcastFn = (global as any).broadcastTelemetrySet as ((enabled: boolean, userId: string | null) => void) | undefined;
    if (broadcastFn) broadcastFn(enabled, scope.kind === 'user' ? scope.userId : null);
    res.json({ data: result });
  } catch (err) { next(err); }
});
// SR-002: gate both proxy routes behind install-token auth (consumers — the
// chat overlay + dashboard — already have the token; this stops anonymous
// abuse of our Tenor API quota and the guild-emoji metadata leak).
app.use('/api/discord-emojis', requireAnyAuthedClient, discordEmojisRouter);
app.use('/api/tenor-search', requireAnyAuthedClient, tenorSearchRouter);

// AutoMod debug mirrors — same data as /api/moderation/automod-* but gated by X-Admin-API-Key.
import {
  listAutoModRules as debugListAutoModRules,
  listAutoModViolations as debugListAutoModViolations,
  invalidateAutoModCacheHandler,
} from './controllers/autoModRulesController';
app.get('/admin/debug/automod-rules', requireAdminKey, debugListAutoModRules);
app.get('/admin/debug/automod-violations', requireAdminKey, debugListAutoModViolations);
app.post('/admin/debug/automod-rules/invalidate-cache', requireAdminKey, invalidateAutoModCacheHandler);

// Overlay diagnostic reports — GameMonitor POSTs periodic snapshots of the
// local environment (FO76 process state, memory-scan results, AV detection,
// etc.) so support can diagnose why scanning isn't firing on a user's machine.
import { submitOverlayReport, listOverlayReports } from './controllers/debugReportsController';
app.post('/api/debug/overlay-report', debugReportLimiter, requireClientAuth, submitOverlayReport);
app.get('/admin/debug/overlay-reports', requireAdminKey, listOverlayReports);

// Admin: one-shot hard wipe of every user + derived per-user state. Used once
// during the X-App-Client-Key hard flip. Requires ADMIN_API_KEY plus a
// confirmation token (?confirm=yes-delete-everything) to avoid accidental fires.
import { nukeUsers } from './controllers/adminNukeController';
app.post('/admin/nuke-users', requireAdminKey, nukeUsers);
app.get('/api/public/moderation-log', publicModerationLog);
// Public aggregate stats — no auth required (world-readable, cached 30s).
app.use('/api/public/stats', publicStatsRouter);

// Admin: list currently-connected WebSocket game clients. Lets me verify whether
// a user's overlay is actually attached to the backend (WS open, session alive)
// vs. running but disconnected vs. not running at all.
// Authed via ADMIN_API_KEY.
app.get('/admin/debug/ws-clients', requireAdminKey, (_req: Request, res: Response) => {
  res.json({ data: snapshotActiveClients() });
});

// Redis ring buffer of raw presence:update payloads per user. Lets admins
// see exactly what the desktop client is sending without container logs.
//   GET /admin/debug/presence-audit?userId=<uuid>&limit=20
app.get('/admin/debug/presence-audit', requireAdminKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req.query.userId as string | undefined)?.trim();
    if (!userId) {
      res.status(400).json({ type: 'https://fo76chat.app/errors/400', title: 'Bad Request', status: 400, detail: 'Provide ?userId' });
      return;
    }
    const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));
    const { getRedisClient } = await import('./config/redis');
    const redis = await getRedisClient();
    const raws = await redis.lRange(`presence:audit:${userId}`, 0, limit - 1);
    const items = raws.map(r => { try { return JSON.parse(r); } catch { return { parseError: true, raw: r }; } });
    res.json({ data: { userId, count: items.length, items } });
  } catch (err) { next(err); }
});

// Clear rate-limit Redis keys (recovery for "100 req/15min per session token /
// 500 req/15min per IP" exhaustion during heavy iteration cycles).
//   POST /admin/debug/clear-rate-limit            — clears ALL rl_api:* keys
//   POST /admin/debug/clear-rate-limit?key=<...>  — clears a specific key
app.post('/admin/debug/clear-rate-limit', requireAdminKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getRedisClient } = await import('./config/redis');
    const redis = await getRedisClient();
    const specificKey = (req.query.key as string | undefined)?.trim();
    let cleared = 0;
    if (specificKey) {
      const k = specificKey.startsWith('rl_api:') ? specificKey : `rl_api:${specificKey}`;
      const n = await redis.del(k);
      cleared = typeof n === 'number' ? n : 0;
      res.json({ data: { cleared, keys: [k] } });
      return;
    }
    const keys: string[] = [];
    for await (const k of redis.scanIterator({ MATCH: 'rl_api:*', COUNT: 200 })) {
      const anyK: any = k;
      if (typeof anyK === 'string') keys.push(anyK);
      else if (anyK && typeof anyK.key === 'string') keys.push(anyK.key);
      else if (Array.isArray(anyK)) for (const item of anyK) if (typeof item === 'string') keys.push(item);
    }
    if (keys.length > 0) {
      const n = await redis.del(keys);
      cleared = typeof n === 'number' ? n : keys.length;
    }
    res.json({ data: { cleared, sampleKeys: keys.slice(0, 10), totalKeys: keys.length } });
  } catch (err) { next(err); }
});


// GET /admin/debug/users/:userId/aliases — alias history mirror (X-Admin-API-Key)
app.get('/admin/debug/users/:userId/aliases', requireAdminKey, async (req: Request, res: Response, next: NextFunction) => {
  const UUID_RE_LOCAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE_LOCAL.test(req.params.userId)) {
    res.status(400).json({ error: 'Invalid user ID format' });
    return;
  }
  try {
    const rows = await (prisma as any).$queryRaw`
      SELECT alias, created_at AS "createdAt"
      FROM user_aliases
      WHERE user_id = ${req.params.userId}::uuid
      ORDER BY created_at DESC
    ` as Array<{ alias: string; createdAt: Date }>;
    res.json({ data: { aliases: rows.map((a: { alias: string; createdAt: Date }) => ({ alias: a.alias, createdAt: a.createdAt.toISOString() })) } });
  } catch (err) {
    next(err);
  }
});

// Admin: directly set a user's username. Used to recover when a bad row must be reset manually.
// Authed via ADMIN_API_KEY.
//   POST /admin/debug/set-username  { userId, username }
app.post('/admin/debug/set-username', requireAdminKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, username } = req.body ?? {};
    if (typeof userId !== 'string' || typeof username !== 'string') {
      res.status(400).json({ error: 'Body must be { userId, username }' });
      return;
    }
    // Length + control-char guard so this admin-key endpoint can't be used
    // to write garbage (10K-char strings, NULs, ANSI escapes) that would
    // break downstream rendering. Matches the register-path filter.
    const trimmed = username.trim();
    if (trimmed.length < 1 || trimmed.length > 64) {
      res.status(400).json({ error: 'username must be 1..64 characters' });
      return;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1F\x7F]/.test(trimmed)) {
      res.status(400).json({ error: 'username contains control characters' });
      return;
    }
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { username: trimmed },
      select: { id: true, username: true, discordId: true, discordUsername: true, discordDisplayName: true, installToken: true },
    });
    // Refresh any live WS session's cached displayName so chat renders the
    // new name instantly without requiring the overlay to reconnect.
    try {
      const { refreshClientIdentity } = require('./websocket/handlers');
      if (typeof refreshClientIdentity === 'function') {
        refreshClientIdentity(updated.id, updated.username, updated.discordUsername, updated.discordDisplayName, updated.installToken);
      }
    } catch { /* non-fatal */ }
    res.json({ data: updated });
  } catch (err) { next(err); }
});



// Admin: merge a dormant duplicate user row into the active one. Used when the
// memory-scanner creates a second row for the same player (different FO76 name
// normalisation, e.g. "Devotek" vs "Devotek-") and one row has the Discord link
// while the other has the live session. Deletes the source, copies its Discord
// identity onto the target only if target has no Discord link yet.
// Authed via ADMIN_API_KEY.
//
//   POST /admin/debug/merge-users  { targetId, sourceId }
app.post('/admin/debug/merge-users', requireAdminKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { targetId, sourceId } = req.body ?? {};
    if (typeof targetId !== 'string' || typeof sourceId !== 'string' || targetId === sourceId) {
      res.status(400).json({ error: 'Body must be { targetId, sourceId } with two distinct UUIDs' });
      return;
    }

    const [target, source] = await Promise.all([
      prisma.user.findUnique({ where: { id: targetId } }),
      prisma.user.findUnique({ where: { id: sourceId } }),
    ]);
    if (!target || !source) {
      res.status(404).json({ error: 'target or source user not found' });
      return;
    }

    // Copy Discord identity from source → target only if target has none yet
    const patch: any = {};
    if (!target.discordId          && source.discordId)          patch.discordId          = source.discordId;
    if (!target.discordUsername    && source.discordUsername)    patch.discordUsername    = source.discordUsername;
    if (!target.discordAvatar      && source.discordAvatar)      patch.discordAvatar      = source.discordAvatar;
    if (!target.discordDisplayName && source.discordDisplayName) patch.discordDisplayName = source.discordDisplayName;

    // Null out discordId on source FIRST to avoid unique-constraint collision
    // when we copy it onto target.
    await prisma.user.update({
      where: { id: sourceId },
      data: { discordId: null },
    });

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: patch,
      select: { id: true, username: true, discordId: true, discordUsername: true, discordDisplayName: true },
    });

    await prisma.user.delete({ where: { id: sourceId } });

    res.json({ data: { message: 'Merged', target: updated, deletedSourceId: sourceId } });
  } catch (err) { next(err); }
});


// VirusTotal redirect — URL stored in Redis so it updates without a restart
app.get('/virustotal', async (_req: Request, res: Response) => {
  try {
    const redis = await getRedisClient();
    const url = (await redis.get('virustotal:url')) || env.VIRUSTOTAL_URL;
    if (url) {
      res.redirect(302, url);
    } else {
      res.status(404).send('No VirusTotal scan linked for this release yet. Check back after the next published release.');
    }
  } catch {
    res.status(503).send('Temporarily unavailable.');
  }
});

// Admin: update VirusTotal URL (called by build-installer.ps1 after each release scan)
app.post('/admin/virustotal-url', (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const apiKeyHeader = req.headers['x-admin-api-key'] as string | undefined;
  const releaseToken = process.env.ADMIN_RELEASE_TOKEN;
  const adminKey = process.env.ADMIN_API_KEY;
  // Constant-time compare prevents timing-side-channel recovery of admin tokens.
  const validBearer = !!(releaseToken && bearerToken && constantTimeEquals(bearerToken, releaseToken));
  const validApiKey = !!(adminKey && apiKeyHeader && constantTimeEquals(apiKeyHeader, adminKey));
  if (!validBearer && !validApiKey) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}, async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  if (typeof url !== 'string' || !url.startsWith('https://www.virustotal.com/')) {
    res.status(400).json({ error: 'Invalid VirusTotal URL' });
    return;
  }
  const redis = await getRedisClient();
  await redis.set('virustotal:url', url);
  res.json({ ok: true, url });
});

app.get('/auth/me/public', async (req: Request, res: Response) => {
  const pub = (req.session as any).publicUser;
  if (!pub) { res.status(401).json({ authenticated: false }); return; }
  // Enrich from DB — handles sessions created before discordDisplayName was added
  let fo76Name: string | null = null;
  let discordDisplayName: string | undefined = pub.discordDisplayName;
  try {
    const linked = await prisma.user.findFirst({
      where: { discordId: pub.discordId },
      select: { username: true, discordDisplayName: true },
    });
    if (linked) {
      const uname = linked.username ?? '';
      if (uname && uname !== 'Wanderer' && !uname.startsWith('discord:')) fo76Name = uname;
      if (linked.discordDisplayName) discordDisplayName = linked.discordDisplayName;
    }
  } catch { /* non-critical */ }
  res.json({ authenticated: true, user: { ...pub, fo76Name, discordDisplayName } });
});

// -- Downloads — static hosting for installer .exe files ----------------------
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { incrementDownloadCount, versionFromFilename } from './controllers/releasesController';

const downloadsDir = path.join(__dirname, '../downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// Intercept installer downloads to increment the per-version counter.
// Must be registered BEFORE the express.static handler so it runs first.
// Only count .exe files matching the release filename pattern; other static
// assets (README, checksums) are served without counting.
app.use('/downloads', (req: Request, _res: Response, next: NextFunction) => {
  // Best-effort download counting — must NEVER 500 the download. Guard the
  // function refs + wrap in try/catch: a module-init/circular-import quirk once
  // left versionFromFilename undefined at runtime, which broke EVERY /downloads
  // request (the feed + installers). Counting failing is fine; serving must not.
  try {
    const filename = path.basename(req.path);
    if (typeof versionFromFilename === 'function') {
      const version = versionFromFilename(filename);
      if (version && typeof incrementDownloadCount === 'function') {
        void incrementDownloadCount(version);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'download counter failed (non-fatal)');
  }
  next();
});

app.use('/downloads', express.static(downloadsDir));

// ── CLI installers (vanity URLs):
//     Linux:   curl -fsSL https://falloutchatmod.com/install.sh | bash
//     Windows: irm https://falloutchatmod.com/install.ps1 | iex
// Canonical scripts live in the repo (Packaging/linux/*.sh, Packaging/windows/
// install.ps1); on boot we seed copies into downloadsDir so they ship on backend
// deploy (repo path is in the image) and persist on the volume. Served as
// text/plain so `curl|bash` / `irm|iex` get the raw script, never an HTML error.
const SCRIPT_SOURCES: Record<string, string> = {
  'install.sh': 'linux',
  'uninstall.sh': 'linux',
  'install.ps1': 'windows',
};
const scriptCandidates = (name: string): string[] => {
  const sub = SCRIPT_SOURCES[name] || '';
  return [
    path.join(downloadsDir, name),
    path.join(__dirname, '../../Packaging', sub, name),
    path.join(__dirname, '../Packaging', sub, name),
  ];
};
try {
  for (const name of Object.keys(SCRIPT_SOURCES)) {
    const src = scriptCandidates(name).find((p) => p !== path.join(downloadsDir, name) && fs.existsSync(p));
    if (src) fs.copyFileSync(src, path.join(downloadsDir, name));
  }
} catch (err) {
  logger.warn({ err }, 'seeding CLI install scripts failed (non-fatal)');
}
const serveScript = (name: string) => (_req: Request, res: Response) => {
  const file = scriptCandidates(name).find((p) => fs.existsSync(p));
  if (!file) {
    res.status(404).type('text/plain').send(`# ${name} is not available on this server yet.\n`);
    return;
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(500).type('text/plain').send(`# failed to read ${name}\n`);
  });
};
app.get('/install.sh', serveScript('install.sh'));
app.get('/uninstall.sh', serveScript('uninstall.sh'));
app.get('/install.ps1', serveScript('install.ps1'));

// Strict allowlist for release installer filenames — rejects any path traversal
// (`..`, `/`, `\`) or variant naming. Fix #11.
const RELEASE_FILENAME_RE = /^FalloutChatMod_Setup_v\d+\.\d+\.\d+\.exe$/;

const releaseUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, downloadsDir),
    filename: (_req, file, cb) => {
      // path.basename strips any directory components from a hostile originalname
      // like "../../evil.exe" before we validate the remaining basename.
      const safeName = path.basename(file.originalname);
      if (!RELEASE_FILENAME_RE.test(safeName)) {
        cb(new Error('Invalid filename'), '');
        return;
      }
      cb(null, safeName);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max
  fileFilter: (_req, file, cb) => {
    const safeName = path.basename(file.originalname);
    if (!RELEASE_FILENAME_RE.test(safeName)) {
      cb(new Error('Invalid filename'));
      return;
    }
    cb(null, true);
  },
});

app.post('/admin/upload-release', (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const apiKeyHeader = req.headers['x-admin-api-key'] as string | undefined;
  const releaseToken = process.env.ADMIN_RELEASE_TOKEN;
  const adminKey = process.env.ADMIN_API_KEY;
  // Constant-time compare prevents timing-side-channel recovery of admin tokens.
  const validBearer = !!(releaseToken && bearerToken && constantTimeEquals(bearerToken, releaseToken));
  const validApiKey = !!(adminKey && apiKeyHeader && constantTimeEquals(apiKeyHeader, adminKey));
  if (!validBearer && !validApiKey) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}, releaseUpload.single('file'), (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded or not an .exe' }); return; }

  // Defence-in-depth: verify the saved path is still within downloadsDir after
  // multer rename. If somehow the filename escaped (shouldn't given the regex),
  // unlink and 400 out rather than return a URL that could leak paths.
  const resolvedDir  = path.resolve(downloadsDir);
  const resolvedFile = path.resolve(req.file.path);
  if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
    try { fs.unlinkSync(resolvedFile); } catch { /* best-effort */ }
    res.status(400).json({ error: 'Invalid upload path' });
    return;
  }

  const url = `${req.protocol}://${req.get('host')}/downloads/${req.file.filename}`;
  res.json({ data: { filename: req.file.filename, url } });
});

// -- Admin dashboard (SPA) — served from backend when built into the image ----
const dashboardDist = path.join(__dirname, '../admin-dashboard/dist');
app.use(express.static(dashboardDist));
app.get('*', (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path === '/ws' || req.path.startsWith('/ws/')) {
    return next();
  }
  res.sendFile(path.join(dashboardDist, 'index.html'), (err) => {
    if (err) next(); // dashboard not built into this image — fall through to 404
  });
});

// -- 404 handler --------------------------------------------------------------
app.use((req: Request, _res: Response, next: NextFunction) => {
  next(createError(404, `Route ${req.method} ${req.path} not found`));
});

// -- Global error handler -----------------------------------------------------
app.use(errorHandler);

// -- WebSocket Server ---------------------------------------------------------
// maxPayload: 8KB -- game messages are capped at 500 chars; this prevents large frame DoS
//
// Hardening for the public launch:
//  - Origin allow-list: browsers send Origin and can't forge it, so this blocks
//    cross-site WebSocket hijacking from random sites. The native desktop client
//    sends no Origin header, so it's unaffected (auth + rate limits cover it).
//  - Per-IP connection cap: a single client IP can't exhaust sockets.
//  - Heartbeat: ping every 30s and reap dead sockets, and keep connections alive
//    under Cloudflare's ~100s idle timeout.
const MAX_WS_CONNS_PER_IP = parseInt(process.env.MAX_WS_CONNS_PER_IP || '10', 10);
const wsConnsByIp = new Map<string, number>();

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 8 * 1024,
  verifyClient: (info, cb) => {
    // Origin allow-list — only enforced when an Origin header is present.
    const origin = info.origin;
    if (origin && !env.ALLOWED_ORIGINS.includes(origin)) {
      logger.warn({ origin }, 'WS handshake rejected: origin not in allow-list');
      return cb(false, 403, 'Forbidden origin');
    }
    // Per-IP connection cap.
    const ip = clientIp(info.req);
    if ((wsConnsByIp.get(ip) || 0) >= MAX_WS_CONNS_PER_IP) {
      logger.warn({ ip }, 'WS handshake rejected: per-IP connection cap reached');
      return cb(false, 429, 'Too many connections');
    }
    cb(true);
  },
});

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  wsConnsByIp.set(ip, (wsConnsByIp.get(ip) || 0) + 1);

  // Heartbeat liveness flag.
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });

  ws.on('close', () => {
    const n = (wsConnsByIp.get(ip) || 1) - 1;
    if (n <= 0) wsConnsByIp.delete(ip);
    else wsConnsByIp.set(ip, n);
  });

  handleConnection(ws, req);
});

// Heartbeat sweep: terminate sockets that missed the previous ping's pong,
// then ping the rest. 30s interval stays well under Cloudflare's idle timeout.
const wsHeartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any).isAlive === false) { ws.terminate(); return; }
    (ws as any).isAlive = false;
    try { ws.ping(); } catch { /* socket already closing */ }
  });
}, 30_000);
wss.on('close', () => clearInterval(wsHeartbeat));

// Expose broadcast fns to routes and Discord service
(global as any).broadcast = broadcast;
(global as any).broadcastMessageDeletion = broadcastMessageDeletion;
(global as any).broadcastReportAlert = broadcastReportAlert;
(global as any).broadcastChannelUpdate = broadcastChannelUpdate;
(global as any).broadcastCommandsUpdate = broadcastCommandsUpdate;
(global as any).broadcastTelemetrySet = broadcastTelemetrySet;
// Party helpers — used by partiesController for invite pushes and member-update broadcasts
(global as any).pushToUser = pushToUser;
(global as any).broadcastToPartyMembers = broadcastToPartyMembers;
// Block enforcement — blockController calls this on add/remove so the connected
// blocker's cached blocked-set updates immediately (live, no reconnect needed).
(global as any).refreshClientBlocks = refreshClientBlocks;
discordService.setBroadcast(broadcast);

// Update health route with live metrics
setInterval(() => {
  (healthRouter as any).setWsClientCount(getClientCount());
}, 5000);

// Periodic sessions cleanup -- purge expired DB sessions every hour
setInterval(() => {
  prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch((err: Error) =>
    logger.warn({ err }, 'Sessions cleanup failed (non-fatal)')
  );
}, 60 * 60 * 1000);

// Client performance metrics — daily purge (rows older than 30 days).
startClientMetricsPurgeJob();

// Online-snapshot cron — inserts the live WS client count every 5 min so the
// public stats endpoint can serve an onlineOverTime chart. Purges rows older
// than 7 days daily at 04:07 UTC.
startOnlineSnapshotJob();
startWikiIngestJob();
startWikiSyncSchedule();
startCampSyncSchedule();

// CAMP database — auto-populate on first boot if the table is empty.
// A single 7.6 MB JSON fetch; completes in seconds.
isCampTableEmpty().then(empty => {
  if (empty) {
    logger.info('[camp] camp_items table is empty — running initial ingest');
    ingestCampDatabase().then(({ fetched, upserted }) => {
      logger.info({ fetched, upserted }, '[camp] initial CAMP ingest complete');
    }).catch(err => {
      logger.error({ err }, '[camp] initial CAMP ingest failed');
    });
  }
}).catch(err => {
  logger.warn({ err }, '[camp] could not check camp_items table — skipping auto-ingest');
});

// Party reap sweep — ephemeral parties with 0 online members are soft-deleted every ~60s.
// Also GCs persistent parties with 0 members and expires stale invites.
startPartyReapJob({
  prisma: prisma as any,
  getOnlineUserIds: () => {
    const ids = new Set<string>();
    for (const id of getConnectedUserIds()) ids.add(id);
    return ids;
  },
  broadcastToPartyMembers,
});

// Moderation sweeps — every 5 min clear expired bans/mutes/kicks. WS guards
// also auto-expire on access for connected users; this catches offline ones
// and ensures the public unban/unmute announcement still fires.
const modSweepTracker = makeJobTracker('[mod-sweep]');
cron.schedule('*/5 * * * *', () => {
  modSweepTracker(async () => {
    const r = await sweepModExpired();
    if (r.unbanned || r.unmuted || r.kickCooldownsCleared) {
      logger.info(r, '[mod-sweep] cleared expired ban/mute/kick state');
    }
  });
});



// Rolling purge -- messages and audit_logs -- runs daily at 3 AM
// Set MESSAGE_RETENTION_DAYS=0 to keep messages forever.
if (env.MESSAGE_RETENTION_DAYS > 0) {
  const retentionMs = env.MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const retentionTracker = makeJobTracker('[retention-purge]');
  cron.schedule('0 3 * * *', () => {
    retentionTracker(async () => {
      const cutoff = new Date(Date.now() - retentionMs);
      const msgResult = await dbQueryFn(
        "DELETE FROM messages WHERE created_at < $1",
        [cutoff.toISOString()]
      );
      const auditResult = await dbQueryFn(
        "DELETE FROM audit_logs WHERE created_at < $1",
        [cutoff.toISOString()]
      );
      // Also purge party messages under the same retention window
      const partyMsgResult = await dbQueryFn(
        "DELETE FROM party_messages WHERE created_at < $1",
        [cutoff.toISOString()]
      );
      logger.info(
        { messagesDeleted: msgResult.rowCount, auditLogsDeleted: auditResult.rowCount, partyMessagesDeleted: partyMsgResult.rowCount, retentionDays: env.MESSAGE_RETENTION_DAYS },
        'Message purge complete'
      );
    });
  });
  logger.info({ retentionDays: env.MESSAGE_RETENTION_DAYS }, 'Message retention purge scheduled');
} else {
  logger.info('Message retention disabled (MESSAGE_RETENTION_DAYS=0) — keeping messages forever');
}

// -- Startup ------------------------------------------------------------------
async function start(): Promise<void> {
  try {
    // Verify Redis connection
    await getRedisClient();
    logger.info('Redis connected');

    // Initialise Redis Pub/Sub for multi-instance message broadcast.
    await initPubSub();

    // HUD push transports — Path A (raw TCP) and Path B (WebSocket /ws/hud).
    await initHudPushTcp();
    initHudPushWs(server);

    // Ensure default channels exist regardless of migration state
    try {
      // Structure:
      //   Fallout 76 (main, previously named "General")
      //     ├── General (new sub — default landing spot)
      //     ├── Trading
      //     ├── Events
      //     └── Raids
      const FO76_MAIN = '00000000-0000-0000-0000-000000000001';
      const defaults = [
        { id: FO76_MAIN,                                  name: 'Fallout 76', parentId: null,     sortOrder: 0,  forceRename: true },
        { id: '00000000-0000-0000-0000-000000000005',    name: 'General',    parentId: FO76_MAIN, sortOrder: 5 },
        { id: '00000000-0000-0000-0000-000000000002',    name: 'Trading',    parentId: FO76_MAIN, sortOrder: 10 },
        { id: '00000000-0000-0000-0000-000000000003',    name: 'Events',     parentId: FO76_MAIN, sortOrder: 20 },
        { id: '983995c1-f9ab-44c0-9b78-8b4cbf497273',    name: 'Infests',    parentId: FO76_MAIN, sortOrder: 25, color: '#b384e0' },
        { id: '00000000-0000-0000-0000-000000000004',    name: 'Raids',      parentId: FO76_MAIN, sortOrder: 30 },
      ];
      for (const ch of defaults) {
        const update: any = { parentId: ch.parentId, sortOrder: ch.sortOrder };
        if (ch.forceRename) update.name = ch.name; // force existing row rename
        await prisma.channel.upsert({
          where: { id: ch.id },
          update,
          create: { id: ch.id, name: ch.name, color: (ch as any).color ?? '#18FF62', parentId: ch.parentId, sortOrder: ch.sortOrder },
        });
      }
      logger.info('Default channels ensured');
    } catch (err) {
      logger.warn({ err }, 'Failed to ensure default channels (non-fatal)');
    }

    // Ensure the default automod rules + mod-log channel exist regardless of
    // migration state. The original seed migration shipped with invalid UUIDs
    // and the baseline-migrations script can mark a migration "applied" without
    // its INSERT running — so seed here (create-only, idempotent) instead of
    // trusting migration seed data. Rules ship DISABLED; admins enable them.
    try {
      const automodDefaults = [
        {
          id: 'a0000000-0000-0000-0000-000000000001',
          name: 'Block spam content',
          triggerType: 'SPAM',
          triggerMetadata: { dupe_limit: 5, dupe_window_ms: 10000, rate_limit: 10, rate_window_ms: 30000 },
        },
        {
          id: 'a0000000-0000-0000-0000-000000000002',
          name: 'Block flagged words',
          triggerType: 'KEYWORD_PRESET',
          triggerMetadata: { presets: ['PROFANITY', 'SEXUAL_CONTENT', 'SLURS'], allow_list: ['ass', 'damn', 'fuck', 'hell', 'shit'] },
        },
        {
          id: 'a0000000-0000-0000-0000-000000000003',
          name: 'Block mention spam',
          triggerType: 'MENTION_SPAM',
          triggerMetadata: { mention_total_limit: 20 },
        },
      ];
      for (const r of automodDefaults) {
        await (prisma as any).autoModRule.upsert({
          where: { id: r.id },
          update: {}, // never clobber admin edits (enabled state, actions, etc.)
          create: {
            id: r.id,
            name: r.name,
            enabled: false,
            triggerType: r.triggerType,
            triggerMetadata: r.triggerMetadata,
            actions: [{ type: 'BLOCK' }, { type: 'ALERT' }],
            exemptChannelIds: [],
            exemptRoles: [],
          },
        });
      }
      // mod_log_channel_id: create-only so an admin's later change is preserved.
      await prisma.moderationSetting.upsert({
        where: { key: 'mod_log_channel_id' },
        update: {},
        create: { key: 'mod_log_channel_id', value: '1509345764654977035' },
      });
      logger.info('Default automod rules + mod-log channel ensured');
    } catch (err) {
      logger.warn({ err }, 'Failed to ensure default automod rules (non-fatal)');
    }

    // Seed built-in form commands (/apply, /report) — create only; never overwrite formFields
    try {
      const DEFAULT_FORM_FIELDS: Record<string, string> = {
        '/apply': JSON.stringify([
          { key: 'inGameName',   label: 'IN-GAME NAME (FO76)',          type: 'text',     required: true,  placeholder: 'Your Fallout 76 character name' },
          { key: 'age',          label: 'AGE',                          type: 'text',     required: true,  placeholder: 'e.g. 22' },
          { key: 'timezone',     label: 'TIMEZONE',                     type: 'text',     required: true,  placeholder: 'e.g. EST, GMT+2' },
          { key: 'availability', label: 'AVAILABILITY (HRS/WEEK, TIMES)', type: 'text',  required: true,  placeholder: 'e.g. 20hrs/week, evenings EST' },
          { key: 'experience',   label: 'RELEVANT EXPERIENCE',          type: 'textarea', required: true,  placeholder: 'Prior moderation, community management, or relevant experience' },
          { key: 'motivation',   label: 'WHY DO YOU WANT TO JOIN?',     type: 'textarea', required: true,  placeholder: 'Tell us why you want to be part of the moderation team' },
        ]),
        '/report': JSON.stringify([
          { key: 'content', label: 'DESCRIBE THE ISSUE', type: 'textarea', required: true, placeholder: 'Describe the behavior you are reporting. Include player names, channel, and time if possible.' },
        ]),
      };
      for (const [trigger, formFields] of Object.entries(DEFAULT_FORM_FIELDS)) {
        await prisma.chatCommand.upsert({
          where: { trigger },
          update: {},  // never overwrite — admin may have customised fields
          create: { trigger, description: trigger === '/apply' ? 'Submit a staff application' : 'Submit a player report', actionType: 'form', formFields, response: '', enabled: true, requiresArgs: false, cooldownSec: 0 },
        });
      }
      logger.info('Default form commands ensured');
    } catch (err) {
      logger.warn({ err }, 'Failed to ensure form commands (non-fatal)');
    }

    // Ensure event announce commands relay to Discord, and seed /ss if missing.
    // Prisma migrate deploy silently skips data-only migrations when a prior
    // migration is in a failed state — so apply these here idempotently instead.
    try {
      await prisma.chatCommand.updateMany({
        where: { actionType: 'announce', relayToDiscord: false },
        data:  { relayToDiscord: true },
      });
      await prisma.chatCommand.upsert({
        where: { trigger: '/ss' },
        update: { response: 'Sinkhole Solutions event on this server.' },
        create: {
          trigger: '/ss', description: 'Announce Sinkhole Solutions',
          response: 'Sinkhole Solutions event on this server.',
          actionType: 'announce',
          targetChannelId: '00000000-0000-0000-0000-000000000003',
          allowedChannelId: '00000000-0000-0000-0000-000000000001',
          cooldownSec: 30, enabled: true, requiresArgs: false, relayToDiscord: true,
        },
      });
      // Wire Infests channel to its Discord channel if not already set.
      await prisma.channel.updateMany({
        where: { id: '983995c1-f9ab-44c0-9b78-8b4cbf497273', discordChannelId: null },
        data:  { discordRelay: true, discordChannelId: '1513363450888454184' },
      });
      logger.info('Event command relay flags and Infests Discord channel ensured');
    } catch (err) {
      logger.warn({ err }, 'Failed to ensure event command defaults (non-fatal)');
    }

    // Initialize the latest release version cache from DB so newly connecting
    // overlays receive the app:update-available handshake message immediately.
    await initLatestVersion();

    // Load name blacklist into in-memory cache and subscribe to cross-instance refresh broadcasts.
    await loadBlacklist();
    await subscribeBlacklistUpdates();

    // Start Discord bridge; callback keeps health status in sync after bot connects
    await discordService.start((status: string) => (healthRouter as any).setDiscordStatus(status));
    (healthRouter as any).setDiscordStatus(discordService.getStatus());

    // Start background role re-verification
    roleVerificationService.start();

    server.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
    });
  } catch (err) {
    logger.error({ err }, 'Startup failed');
    process.exit(1);
  }
}

// Only auto-start when run directly (not when required by tests)
if (require.main === module) {
  start();
}

export { app, server, start };
module.exports = { app, server, start };
