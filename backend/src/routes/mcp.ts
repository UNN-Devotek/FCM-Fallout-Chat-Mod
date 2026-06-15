import express, { Request, Response, NextFunction } from 'express';
import { requireMcpToken, mcpLimiter } from '../middleware/requireMcpToken';
import { createError } from '../middleware/errorHandler';
import { ingestMessage } from '../services/ingestMessage';
import prisma from '../config/prisma';
import logger from '../config/logger';

const router = express.Router();

// Apply rate limiter and MCP auth to all routes
router.use(mcpLimiter);
router.use(requireMcpToken('dev'));

// GET /api/mcp/health
router.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok', timestamp: new Date().toISOString() } });
});

// GET /api/mcp/version
router.get('/version', (_req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../../package.json') as { version: string };
    res.json({ data: { version: pkg.version } });
  } catch {
    res.json({ data: { version: 'unknown' } });
  }
});

// GET /api/mcp/wiki/search?q=
router.get('/wiki/search', async (req, res, next) => {
  try {
    const { searchWiki } = require('../controllers/wikiController');
    return searchWiki(req, res, next);
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/camp/search?q=
router.get('/camp/search', async (req, res, next) => {
  try {
    const { searchCamp } = require('../controllers/campController');
    return searchCamp(req, res, next);
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/channels
router.get('/channels', async (_req, res, next) => {
  try {
    const channels = await prisma.channel.findMany({
      where: { isArchived: false },
      select: { id: true, name: true, color: true, parentId: true, sortOrder: true, discordRelay: true, allowGifs: true, allowEmojis: true },
      orderBy: { sortOrder: 'asc' },
    });
    res.json({ data: channels });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/commands
router.get('/commands', async (_req, res, next) => {
  try {
    const commands = await prisma.chatCommand.findMany({
      where: { enabled: true },
      select: { id: true, trigger: true, description: true, actionType: true, cooldownSec: true, requiresArgs: true, alias: true },
      orderBy: { trigger: 'asc' },
    });
    res.json({ data: commands });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/messages?channelId=&limit=50
router.get('/messages', async (req, res, next) => {
  try {
    const channelId = req.query.channelId as string;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    if (!channelId) return next(createError(400, 'channelId is required'));
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(channelId)) return next(createError(400, 'channelId must be a valid UUID'));
    const messages = await prisma.message.findMany({
      where: { channelId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, content: true, userId: true, channelId: true, source: true, createdAt: true },
    });
    res.json({ data: messages.reverse() });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/parties
router.get('/parties', async (_req, res, next) => {
  try {
    const parties = await prisma.party.findMany({
      where: { isDeleted: false },
      select: { id: true, name: true, color: true, isPrivate: true, category: true, description: true, maxMembers: true, lastMessageAt: true, createdAt: true },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
    });
    res.json({ data: parties });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/users/search?q=
router.get('/users/search', async (req, res, next) => {
  try {
    const q = (req.query.q as string || '').trim().slice(0, 64);
    if (!q) return next(createError(400, 'q query param is required'));
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { discordUsername: { contains: q, mode: 'insensitive' } },
          { discordDisplayName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, username: true, discordUsername: true, discordDisplayName: true, isBanned: true, isMuted: true },
      take: 20,
    });
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/releases
router.get('/releases', async (_req, res, next) => {
  try {
    const releases = await prisma.release.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { id: true, version: true, downloadUrl: true, releaseNotes: true, publishedAt: true, downloadCount: true },
    });
    res.json({ data: releases });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp/ws/snapshot
router.get('/ws/snapshot', (_req, res) => {
  try {
    const { snapshotActiveClients } = require('../websocket/handlers');
    res.json({ data: snapshotActiveClients() });
  } catch (err) {
    res.json({ data: { totalClients: 0, totalAdminObservers: 0, clients: [] } });
  }
});

// GET /api/mcp/ws/count
router.get('/ws/count', (_req, res) => {
  try {
    const { getClientCount } = require('../websocket/handlers');
    res.json({ data: { count: getClientCount() } });
  } catch {
    res.json({ data: { count: 0 } });
  }
});

// POST /api/mcp/messages/send — send a message as the MCP user (through full governance pipeline)
router.post('/messages/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channelId, content } = req.body || {};
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!content || typeof content !== 'string' || content.trim().length === 0)
      return next(createError(400, 'content is required'));
    if (content.length > 500)
      return next(createError(400, 'Message too long (max 500 chars)'));
    if (!channelId || !UUID_RE.test(channelId))
      return next(createError(400, 'channelId must be a valid UUID'));

    const user = req.user as any;
    if (!user) return next(createError(401, 'MCP user not resolved'));

    // Route through the full governance pipeline (mute, rate-limit, automod, channel validation).
    const result = await ingestMessage({
      userId: user.id,
      channelId,
      rawContent: content.trim(),
      source: 'mcp',
    });

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        muted: 403,
        'rate-limited': 429,
        automod: 403,
        'invalid-content': 400,
        'invalid-channel': 400,
        'channel-not-found': 404,
        'slash-command-dropped': 400,
      };
      const status = statusMap[result.reason ?? ''] ?? 400;
      return next(createError(status, `Message rejected: ${result.reason ?? 'unknown'}`));
    }

    res.json({ data: { id: result.messageId, content: content.trim(), channelId } });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp/sim/stream — gate: dev/test only + explicit opt-in
router.post('/sim/stream', async (req: Request, res: Response, next: NextFunction) => {
  const env = require('../config/environment');
  if (process.env.NODE_ENV === 'production' || !env.ENABLE_SIM_ROUTES) {
    return next(createError(403, 'Sim endpoints are not available. Set ENABLE_SIM_ROUTES=true in a non-production environment.'));
  }
  try {
    const { count = 20, intervalMs = 1500, channelId } = req.body || {};
    const { broadcast } = require('../websocket/handlers');
    const messageQueue = require('../queues/messagePersist');
    const { v4: uuidv4 } = require('uuid');

    const safeCount = Math.min(Math.max(Number(count) || 20, 1), 200);
    const safeInterval = Math.min(Math.max(Number(intervalMs) || 1500, 100), 30_000);
    const GENERAL_CHANNEL_ID = '00000000-0000-0000-0000-000000000001';
    const safeChannelId = typeof channelId === 'string' && channelId.trim() ? channelId.trim() : GENERAL_CHANNEL_ID;

    const simUsers = await prisma.user.findMany({
      where: { installToken: { startsWith: 'sim-' } },
      select: { id: true, username: true },
      take: 200,
    });

    const SIM_NAMES = ['CrusaderBobby', 'NukaColaDrinker', 'TheWastelandKing', 'RaiderQueen76', 'AtomicMaiden'];
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)] as T;

    let sent = 0;
    const timer = setInterval(() => {
      const author = simUsers.length > 0
        ? simUsers[Math.floor(Math.random() * simUsers.length)]
        : { id: `sim-ephemeral-${Math.floor(Math.random() * 1e6)}`, username: pick(SIM_NAMES) };
      const messageId = uuidv4();
      const createdAt = new Date().toISOString();
      broadcast({ type: 'chat:message', payload: { id: messageId, content: `[sim] test message ${sent}`, username: author.username, userId: author.id, channelId: safeChannelId, source: 'game', timestamp: createdAt, isSim: true } });
      if (simUsers.length > 0) {
        messageQueue.add({ id: messageId, content: `[sim] test message ${sent}`, userId: author.id, channelId: safeChannelId, source: 'game', createdAt }).catch(() => {});
      }
      sent++;
      if (sent >= safeCount) clearInterval(timer);
    }, safeInterval);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();

    res.json({ data: { started: true, count: safeCount, intervalMs: safeInterval, channelId: safeChannelId } });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp/sim/users — gate: dev/test only + explicit opt-in
router.post('/sim/users', async (req: Request, res: Response, next: NextFunction) => {
  const env = require('../config/environment');
  if (process.env.NODE_ENV === 'production' || !env.ENABLE_SIM_ROUTES) {
    return next(createError(403, 'Sim endpoints are not available. Set ENABLE_SIM_ROUTES=true in a non-production environment.'));
  }
  try {
    const { count = 10 } = req.body || {};
    const safeCount = Math.min(Math.max(Number(count) || 10, 1), 200);
    const SIM_NAMES = ['CrusaderBobby', 'NukaColaDrinker', 'TheWastelandKing', 'RaiderQueen76', 'AtomicMaiden', 'BottleCapKing', 'VaultTechEngineer', 'GhoulWhisperer', 'SteelRainFalling', 'CranberryBogRunner'];
    const { getRedisClient } = require('../config/redis');
    const redis = await getRedisClient();
    const { v4: uuidv4 } = require('uuid');
    const SESSION_TTL = 86400;
    const users = [];
    for (let i = 0; i < safeCount; i++) {
      const username = SIM_NAMES[i % SIM_NAMES.length];
      const installToken = `sim-mcp-${String(i).padStart(4, '0')}`;
      const sessionToken = uuidv4();
      const user = await prisma.user.upsert({
        where: { username },
        create: { username, installToken },
        update: { installToken },
        select: { id: true, username: true },
      });
      await redis.set(`session:${sessionToken}`, user.id, { EX: SESSION_TTL });
      users.push({ username: user.username, userId: user.id });
    }
    res.json({ data: { count: users.length, users } });
  } catch (err) {
    next(err);
  }
});

export default router;
module.exports = router;
