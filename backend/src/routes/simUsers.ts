import express from 'express';
import { randomInt, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/prisma';
import { getRedisClient } from '../config/redis';
import env from '../config/environment';
import { constantTimeEquals } from '../utils/constantTimeEquals';
import { v4 as uuidv4Stream } from 'uuid';
const { broadcast } = require('../websocket/handlers');
import messageQueue from '../queues/messagePersist';

const router = express.Router();

const SESSION_TTL = 86_400; // 24 hours

const GENERAL_CHANNEL_ID = '00000000-0000-0000-0000-000000000001';

// Unique pre-composed names — realistic FO76 player tags, no suffix formula.
// Shared by POST /users (seeding) and POST /stream (live drip).
const SIM_NAMES = [
  'CrusaderBobby','NukaColaDrinker','TheWastelandKing','RaiderQueen76','AtomicMaiden',
  'BottleCapKing','VaultTechEngineer','GhoulWhisperer','SteelRainFalling','CranberryBogRunner',
  'AppalachiaOutlaw','NukaCherryBomb','RadSurfer','MirelurkSlayer','EnclaveSurvivor',
  'FissurePatrol','ScorchedEarther','UltraciteHunter','VulcanPilot','GleamingDepthsDiver',
  'TheRogueSentinel','AtomCatMechanic','WastelandWitch','SteelDawnKnight','BlueMountainHiker',
  'NukaBomber','ThePhosphorGlow','CranberryMoonshine','FoundationBuilder','TradingPostKing',
  'WhitespringButler','AppalachiaRanger','ScrappyOutlaw','CryptoVaultDweller','MeadowBandit',
  'RadstormChaser','NightOwlPatrol','TheGhoulFather','LegendaryHunter','SteelReign76',
  'CapCollectorPro','AtomFanatic','TinkerMechanic','DrifterOfTheWastes','VaultEscapee',
  'MoleMinerKing','EvictionNoticeSender','BloatflyRider','MirelurkQueen76','NukaWorldTourist',
  'PipboyNerd','PowerArmorPilot','FalloutVeteran','TheLastRaider','RadScorpWrangler',
  'ScorchBeastKiller','TheEnclaveSpy','BrotherhoodSquire','TreasureHunter76','SatchelSamurai',
];

// Synthetic FO76-flavored chat lines — templated, never sourced from real prod
// content. Placeholders are filled at drip time for variety.
const SIM_LINE_TEMPLATES = [
  'Anyone running {event} at the {location}? Need a hand.',
  'Selling {item} for {caps} caps, message me!',
  'LFG {event} — got room for 2 more.',
  'Just found a {item} out near {location}, what a haul.',
  'Heading to {location}, who wants to team up?',
  'Free {item} on my CAMP, come grab it before I log.',
  'Nuke dropping on {location} in 10 — get clear or come fight {event}.',
  'WTB {item}, paying {caps} caps or trade.',
  'GG on that {event}, that was a wild fight.',
  'My CAMP is open for vendors near {location} if anyone needs {item}.',
  'Wish me luck, going for the {event} solo.',
  'Stocked up on {item}, prices are {caps} caps each.',
];
const SIM_EVENTS = ['Eviction Notice','Radiation Rumble','Scorched Earth','a Queen run','Moonshine Jamboree','Test Your Metal','Project Paradise','an Earle run'];
const SIM_LOCATIONS = ['Whitespring','the Cranberry Bog','Watoga','Morgantown','the Mire','Foundation','the Forest','Toxic Valley'];
const SIM_ITEMS = ['a Two Shot Explosive','some Flux','an Ultracite plan','Stimpaks','a Fixer plan','Legendary Cores','some Nuclear Material','a Bloodied set'];

// Coerce a request-controlled numeric input to a finite positive integer and
// clamp it into [min, max] so an unbounded/NaN/Infinity value can never drive a
// loop or allocation. Falls back to `fallback` when the input is non-numeric.
function clampCount(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return Math.min(Math.max(fallback, min), max);
  return Math.min(Math.max(n, min), max);
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(arr.length)] as T;
}

function buildSimLine(): string {
  return pick(SIM_LINE_TEMPLATES)
    .replace('{event}', pick(SIM_EVENTS))
    .replace('{location}', pick(SIM_LOCATIONS))
    .replace('{item}', pick(SIM_ITEMS))
    .replace('{caps}', String((randomInt(40) + 1) * 25));
}

/**
 * POST /api/admin/sim/users
 * Bulk-creates simulation users, issues session tokens, clears any existing
 * authLimiter Redis key for the caller's IP so immediate re-runs work.
 * Requires: Authorization: Bearer <ADMIN_API_KEY>
 * Body: { count?: number }   (default 100, max 200)
 */
router.post('/users', async (req, res, next) => {
  try {
    const apiKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!env.ADMIN_API_KEY || !apiKey || !constantTimeEquals(apiKey, env.ADMIN_API_KEY)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const count = clampCount(req.body?.count, 100, 1, 200);
    const redis = await getRedisClient();

    // Clear rate-limit keys for the caller's IP so the sim script can re-run
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    const cleanIp = ip.replace(/^::ffff:/, '');
    const rlKeys = await redis.keys(`rl_auth:${cleanIp}*`);
    if (rlKeys.length > 0) await redis.del(rlKeys);

    const users = [];
    for (let i = 0; i < count; i++) {
      const username = SIM_NAMES[i % SIM_NAMES.length];
      // Deterministic install token — same index always maps to same user, so
      // re-runs UPDATE the existing row instead of hitting a unique constraint.
      const installToken = `sim-v2-${String(i).padStart(4, '0')}`;
      const sessionToken = uuidv4();

      // Upsert by username (unique) so existing sim users are reused and their
      // installToken is updated to the deterministic value for consistency.
      const user = await prisma.user.upsert({
        where: { username },
        create: { username, installToken },
        update: { installToken },
        select: { id: true, username: true },
      });

      await redis.set(`session:${sessionToken}`, user.id, { EX: SESSION_TTL });
      users.push({ username: user.username, userId: user.id, token: sessionToken });
    }

    res.json({ data: { count: users.length, users } });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/sim/users
 * Deletes all simulation users (installToken starts with 'sim-').
 * Requires: Authorization: Bearer <ADMIN_API_KEY>
 */
router.delete('/users', async (req, res, next) => {
  try {
    const apiKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!env.ADMIN_API_KEY || !apiKey || !constantTimeEquals(apiKey, env.ADMIN_API_KEY)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const simUsers = await prisma.user.findMany({
      where: { installToken: { startsWith: 'sim-' } },
      select: { id: true },
    });
    const ids = simUsers.map(u => u.id);

    await prisma.message.deleteMany({ where: { userId: { in: ids } } });
    const deleted = await prisma.user.deleteMany({
      where: { id: { in: ids } },
    });

    res.json({ data: { deleted: deleted.count } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/sim/stream
 * Drips `count` synthetic FO76-flavored chat messages, authored by existing sim
 * users, through the REAL WebSocket broadcast path (handlers.broadcast → live
 * clients + HUD push) at `intervalMs` spacing, and queues each for write-behind
 * persistence — exactly like a real chat:message. Fire-and-forget: returns
 * immediately and self-terminates after `count` messages.
 *
 * Requires: Authorization: Bearer <ADMIN_API_KEY>
 * Body: {
 *   count?: number       // default 20, max 200
 *   intervalMs?: number  // default 1500, min 100, max 30000
 *   channelId?: string   // default General (seeded) channel
 * }
 */
router.post('/stream', async (req, res, next) => {
  try {
    const apiKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!env.ADMIN_API_KEY || !apiKey || !constantTimeEquals(apiKey, env.ADMIN_API_KEY)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Inline bounds (in addition to clampCount) so the upper/lower limits are
    // visible at the loop/timer sink — CodeQL-recognized resource-exhaustion guard.
    const count = Math.max(1, Math.min(200, clampCount(req.body?.count, 20, 1, 200)));
    // Explicit constant bounds on the timer duration (CodeQL resource-exhaustion
    // barrier): a non-finite/out-of-range request value falls back to the default
    // then clamps to [100ms, 30s] before it can reach setInterval.
    let intervalMs = Math.floor(Number(req.body?.intervalMs));
    if (!Number.isFinite(intervalMs)) intervalMs = 1500;
    if (intervalMs < 100) intervalMs = 100;
    if (intervalMs > 30_000) intervalMs = 30_000;
    const channelId = typeof req.body?.channelId === 'string' && req.body.channelId.trim()
      ? req.body.channelId.trim()
      : GENERAL_CHANNEL_ID;

    // Resolve the sim users that will author the drip. Fall back to ephemeral
    // synthetic authors if none have been seeded yet (so /stream still works).
    const simUsers = await prisma.user.findMany({
      where: { installToken: { startsWith: 'sim-' } },
      select: { id: true, username: true },
      take: 200,
    });

    let sent = 0;
    const timer = setInterval(() => {
      const author = simUsers.length > 0
        ? simUsers[randomInt(simUsers.length)]
        : { id: `sim-ephemeral-${randomBytes(8).toString('hex')}`, username: pick(SIM_NAMES) };

      const messageId = uuidv4Stream();
      const createdAt = new Date().toISOString();
      const content = buildSimLine();

      broadcast({
        type: 'chat:message',
        payload: {
          id: messageId,
          content,
          username: author.username,
          userId: author.id,
          channelId,
          source: 'game',
          timestamp: createdAt,
          isSim: true,
        },
      });

      // Write-behind persistence, identical to the real path. Skip for
      // ephemeral authors (no real user row → FK would fail).
      if (simUsers.length > 0) {
        messageQueue.add({
          id: messageId,
          content,
          userId: author.id,
          channelId,
          source: 'game',
          createdAt,
        }).catch(() => { /* sim persistence is best-effort */ });
      }

      sent += 1;
      if (sent >= count) clearInterval(timer);
    }, intervalMs);
    // Don't keep the event loop alive solely for the sim drip.
    if (typeof timer.unref === 'function') timer.unref();

    res.json({ data: { started: true, count, intervalMs, channelId, authors: simUsers.length } });
  } catch (err) {
    next(err);
  }
});

export default router;
module.exports = router;
