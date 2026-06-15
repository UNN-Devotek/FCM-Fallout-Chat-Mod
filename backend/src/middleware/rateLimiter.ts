import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';
import { clientIp } from '../utils/clientIp';
import logger from '../config/logger';

// ── Dev-mode rate-limit bypass ────────────────────────────────────────────────
// A dev/test overlay relaunches constantly (each launch re-registers), tripping
// the strict register/auth limiters ("Too many registrations"). Two paths:
//
//  1. AUTOMATIC (zero-config): an UNPACKAGED overlay (app.isPackaged === false,
//     i.e. `electron .` / `npm start`) auto-sends `X-Overlay-Dev: 1`. We treat
//     such requests as dev and give them a HIGH-but-bounded cap (devCap()) rather
//     than a full skip — that header is self-asserted/spoofable, so a full skip
//     would let anyone bypass prod's register limit. A high cap is effectively
//     unlimited for a relaunch workflow while keeping abuse bounded.
//  2. SECURE FULL SKIP (opt-in): if DEV_RATELIMIT_BYPASS_TOKEN is set and the
//     request carries the matching `X-Dev-Bypass`, rate limiting is fully skipped.
//     Token-gated, so prod clients (no token) are unaffected.
const DEV_RATELIMIT_BYPASS_TOKEN = process.env.DEV_RATELIMIT_BYPASS_TOKEN || '';
function devBypassSkip(req: any): boolean {
  return !!DEV_RATELIMIT_BYPASS_TOKEN && req.headers['x-dev-bypass'] === DEV_RATELIMIT_BYPASS_TOKEN;
}
function isDevOverlay(req: any): boolean {
  return req.headers['x-overlay-dev'] === '1';
}
// Returns the dev cap if the request is from an unpackaged dev overlay, else the
// supplied normal cap. High enough that constant relaunch never trips it.
function devCap(req: any, normal: number, dev: number): number {
  return isDevOverlay(req) ? dev : normal;
}

// Shared Redis store -- ensures rate limit counts are consistent across multiple
// backend replicas (NFR-SCAL: Multi-instance readiness, Fix #9).
function makeRedisStore(prefix: string): RedisStore {
  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      try {
        const client = await getRedisClient();
        return client.sendCommand(args);
      } catch (err) {
        // Redis is unavailable -- fail open so a Redis outage doesn't take down rate limiting
        // and cascade into a complete service outage. Log once per store call.
        const logger = require('../config/logger');
        logger.warn({ err, prefix }, 'Rate limit Redis store unavailable, failing open');
        throw err; // express-rate-limit will fall back to in-memory on store error
      }
    },
  });
}

/**
 * REST API rate limiter: 100 req / 15 min per session token (authenticated)
 * or 500 req / 15 min per IP (unauthenticated).
 *
 * Skips `/api/player-list` — that route has its own dedicated limiter
 * (`playerListLimiter`) because the desktop client legitimately POSTs
 * every 5s during warm cadence.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req: any) => (req.headers['x-auth-token'] ? 100 : 500),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_api:'),
  // Skip endpoints that have their own dedicated limiter (player-list) or that
  // are read-mostly with their own caching and are called on every WS reconnect
  // / channels:refresh push. The channels endpoint has its own channelsLimiter
  // (500/15min/token) because it is called on every cold overlay start.
  skip: (req: any) => req.path?.startsWith('/player-list')
                   || req.path === '/channels'
                   || req.path?.startsWith('/channels/'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'You have exceeded the rate limit. Please wait before retrying.',
  },
});

/**
 * Dedicated limiter for `GET /api/channels`: 500 req / 15 min per token.
 * Channels is fetched on every WS reconnect and every server-pushed
 * `channels:refresh`. The response is Redis-cached 30s, so DB load doesn't
 * scale with this cap.
 */
const channelsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req: any) => (req.headers['x-auth-token'] ? 500 : 500),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_chans:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Channels rate limit exceeded.',
  },
});

/**
 * Dedicated limiter for `/api/player-list`: 30 req / min per session token.
 * The desktop scanner legitimately POSTs every 5s in warm cadence (12/min)
 * and faster during hot mode. 30/min gives 2.5x headroom for hot bursts plus
 * occasional ForceRefresh calls. Lower than this and `429s` block welcome
 * server-count messages on world join.
 */
const playerListLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_plist:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Player-list rate limit exceeded.',
  },
});

/**
 * Strict limiter for auth endpoints: 20 req / 15 min per IP.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 20/15min for real clients; 500/15min for an unpackaged dev overlay.
  max: (req: any) => devCap(req, 20, 500),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  skip: devBypassSkip, // secure full skip when a valid X-Dev-Bypass token is sent
  store: makeRedisStore('rl_auth:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Too many authentication attempts. Please wait before retrying.',
  },
});

/**
 * Limiter for `/api/debug/overlay-report`: 10 req / min per IP. The endpoint is
 * authed via `X-App-Client-Key` but the key ships in every installed overlay,
 * so we still need a per-IP cap to prevent abusive clients from flooding Redis
 * storage (Fix #10).
 */
const debugReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  store: makeRedisStore('rl_dbgrpt:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Debug report rate limit exceeded.',
  },
});

/**
 * Strict limiter for new-account registration (finding #1 + reconnect-churn fix).
 *
 * Key strategy: key by `installToken` (req.body.installToken) when present,
 * falling back to `clientIp`. This means each physical device gets its own
 * bucket rather than sharing one with every other device behind the same NAT.
 * Shared-NAT users (e.g. college dorms, office networks) and reconnect churn
 * (overlay hide→show → re-register) no longer exhaust a shared IP budget.
 *
 * Abuse bound: a secondary generous per-IP guard (30/min/IP, see
 * registerIpFloodLimiter below) applied in the route layer alongside this one
 * stops token-rotation spam. The authLimiter (20/15min/IP) and WS per-IP conn
 * cap provide additional upstream bounds.
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  // 10/min per install token — reconnect churn from alt-tab / Delete-to-tray
  // can easily hit 3/min in normal gameplay; 10/min leaves headroom.
  max: (req: any) => devCap(req, 10, 60),
  standardHeaders: true,
  legacyHeaders: false,
  // Key per install token so each device has its own bucket, not per IP.
  // Falls back to clientIp for requests without a body installToken (e.g. old clients).
  keyGenerator: (req: any) => {
    const token = typeof req.body?.installToken === 'string' && req.body.installToken
      ? req.body.installToken
      : null;
    return token ?? clientIp(req);
  },
  skip: devBypassSkip, // secure full skip when a valid X-Dev-Bypass token is sent
  store: makeRedisStore('rl_register:'),
  handler: (req: any, res: any) => {
    const token = typeof req.body?.installToken === 'string' && req.body.installToken
      ? `token:${req.body.installToken.slice(0, 8)}`
      : `ip:${clientIp(req)}`;
    logger.warn({ key: token, path: req.path }, '[registerLimiter] 429 — too many registration attempts');
    res.status(429).json({
      type: 'https://fo76chat.app/errors/429',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many registration attempts. Please wait before retrying.',
    });
  },
});

/**
 * Secondary IP-level flood guard for registration — applied alongside
 * registerLimiter (per-token). Generous cap (30/min/IP) so a normal household
 * (multiple family members on the same NAT) isn't affected, but token-rotation
 * spam from a single IP is bounded.
 */
const registerIpFloodLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  skip: devBypassSkip,
  store: makeRedisStore('rl_register_ip:'),
  handler: (req: any, res: any) => {
    logger.warn({ ip: clientIp(req), path: req.path }, '[registerIpFloodLimiter] 429 — IP flood on register');
    res.status(429).json({
      type: 'https://fo76chat.app/errors/429',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Too many registration attempts from this network. Please wait before retrying.',
    });
  },
});

/**
 * Strict per-IP cap on staff applications: 3 per hour. The form is
 * intentionally unauthenticated so prospective contributors who don't yet
 * have an account can apply, but without this an attacker could fill the
 * staff_applications table indefinitely from a single IP.
 */
const applicationsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  store: makeRedisStore('rl_apps:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Too many application submissions from this IP. Please wait an hour before trying again.',
  },
});

/**
 * Party system rate limiters — all keyed by x-auth-token (authenticated) with
 * fail-open Redis store so a Redis outage doesn't block party operations.
 */

/** List/search parties: 120 req / min per token. Read-heavy, called on tab open + search input. */
const partiesListLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_parties_list:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Party list rate limit exceeded.',
  },
});

/** Create party: 4 req / min per token. Prevents room-spam. */
const partyCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_parties_create:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Party creation rate limit exceeded.',
  },
});

/** Join party: 8 req / min per token. */
const partyJoinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_parties_join:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Party join rate limit exceeded.',
  },
});

/** Invite to party: 15 req / min per token. Owners/co-mods inviting members. */
const partyInviteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_parties_invite:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Party invite rate limit exceeded.',
  },
});

/**
 * Wiki search limiter — generous separate bucket so autocomplete per-keystroke
 * debounce doesn't eat the main apiLimiter budget.
 * 300 req / 15 min per session token (or IP for unauthenticated callers).
 */
const wikiSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_wiki_search:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Wiki search rate limit exceeded. Please wait before retrying.',
  },
});

/**
 * CAMP item search: mirrors wiki search budget.
 * 300 req / 15 min per session token or IP.
 */
const campSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_camp_search:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'CAMP search rate limit exceeded. Please wait before retrying.',
  },
});

/**
 * HUD feed: 120 req / 15 min per IP.
 * ZFE caches the response for 30 s, so normal play is ~2 req/min. This cap
 * gives 4x headroom for restarts/testing while keeping abuse bounded.
 */
const hudFeedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => clientIp(req),
  store: makeRedisStore('rl_hudfeed:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'HUD feed rate limit exceeded.',
  },
});

/** Party image upload: 10 uploads / min per token. Prevents storage spam. */
const partyImageUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers['x-auth-token'] || clientIp(req),
  store: makeRedisStore('rl_party_img:'),
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Party image upload rate limit exceeded.',
  },
});

export { apiLimiter, authLimiter, debugReportLimiter, registerLimiter, registerIpFloodLimiter, playerListLimiter, channelsLimiter, applicationsLimiter, partiesListLimiter, partyCreateLimiter, partyJoinLimiter, partyInviteLimiter, partyImageUploadLimiter, wikiSearchLimiter, campSearchLimiter, hudFeedLimiter };
module.exports = { apiLimiter, authLimiter, debugReportLimiter, registerLimiter, registerIpFloodLimiter, playerListLimiter, channelsLimiter, applicationsLimiter, partiesListLimiter, partyCreateLimiter, partyJoinLimiter, partyInviteLimiter, partyImageUploadLimiter, wikiSearchLimiter, campSearchLimiter, hudFeedLimiter };
