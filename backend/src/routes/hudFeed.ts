/**
 * GET /api/game/hud-feed
 *
 * Public, unauthenticated read-only endpoint consumed by FCMBridge.swf
 * running inside Fallout 76's Scaleform layer via ZFE's readRemoteData API.
 *
 * ZFE caches the response on the client side for 300 s (FCMBridge.ini:
 * CacheSeconds=300 — ZFE's documented minimum), so the backend sees at most
 * ~1 request per 5 min per player. Cache-Control lets Cloudflare edge-cache.
 *
 * Response shape: {"t":"<records>"} where <records> is `|`-joined message
 * records, each record `~`-joined fields `color~channel~user~content`:
 *   {"t":"#C8A840~General~Devotek~hello|#4A9FE0~Trade~Vault101~WTS plans"}
 * Per-field records let the SWF color each segment to match ChatOverlay.tsx
 * (channel tag in channel color, bold gold username, cream content).
 * ZFE requires a valid-JSON body (it rejects plain text with InvalidJson at
 * cache-write), but the SWF cannot reliably parse nested/escaped JSON, so
 * the payload is a single quote-free string field. See zfeSafe below.
 */

import env from '../config/environment';
import { Router, Request, Response, NextFunction } from 'express';
import logger from '../config/logger';
import {
  zfeSafe,
  buildFeedLines,
  fetchFeedRows,
} from '../services/hudFeedService';

// Re-export so existing test files (src/routes/__tests__/hudFeed.test.ts and
// tests/hudFeed.test.js) that import from this module continue to work unchanged.
export { zfeSafe, buildFeedLines } from '../services/hudFeedService';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // When backfill is disabled, the poll returns no history either — so the
    // in-game feed shows ONLY live messages (matches the socket path).
    const lines = env.HUD_PUSH_BACKFILL_ENABLED
      ? buildFeedLines((await fetchFeedRows()).reverse())
      : [];

    res.setHeader('Cache-Control', 'public, max-age=30');
    // ZFE rejects non-JSON bodies (cache-write err=InvalidJson), so wrap the
    // pre-rendered lines in a minimal JSON object. The "t" value is quote-free
    // (zfeSafe), so ZFE's one-level escape round-trip cannot corrupt it.
    res.json({ t: lines.join('|') });
  } catch (err) {
    logger.warn({ err }, '[hud-feed] query failed');
    next(err);
  }
});

export default router;
