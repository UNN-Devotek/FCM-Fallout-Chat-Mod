/**
 * /api/game/player-bridge
 *
 * Receives player data POSTed directly from the FCMBridge.swf mod running
 * inside Fallout 76's Scaleform layer. The SWF has no auth token, so this
 * endpoint is intentionally unauthenticated — access is restricted to
 * localhost (127.0.0.1) at the Express middleware level.
 *
 * The backend stores the latest payload in memory (keyed by source IP) and
 * the Electron overlay's GameMonitor polls GET /api/game/player-bridge to
 * retrieve it.
 */

import { Router, Request, Response, text as expressText } from 'express';
import { execSync } from 'child_process';
import logger from '../config/logger';

const router = Router();

// WSL2: connections from Windows (127.0.0.1 on the Windows side) arrive at WSL2's
// TCP stack with remoteAddress = WSL2 host gateway IP (e.g. 172.25.16.1).
// Read the gateway once at startup so requireLocalhost can allow it.
function getWsl2HostIp(): string | null {
  try {
    const out = execSync('ip route show default 2>/dev/null', { encoding: 'utf8' });
    const m = out.match(/default via (\S+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
const WSL2_HOST_IP = getWsl2HostIp();
if (WSL2_HOST_IP) {
  logger.info(`[game-bridge] WSL2 host IP detected: ${WSL2_HOST_IP} — allowed for localhost check`);
}

interface BridgePlayer {
  a: string;   // accountName
  c: string;   // characterName
  l: boolean;  // isLocal (true = local player's server)
  v: number;   // level
}

interface BridgePayload {
  worldId: string;
  worldType: string;
  src: 'bsui' | 'lc';  // bsui = BSUIDataManager subscription worked, lc = LocalConnection fallback
  players: BridgePlayer[];
}

// In-memory latest payload — one per source IP (supports multiple local clients)
const latestPayload = new Map<string, { payload: BridgePayload; receivedAt: number }>();

/** Restrict to localhost-originating requests only */
function requireLocalhost(req: Request, res: Response, next: () => void): void {
  // req.socket.remoteAddress is the real TCP source — cannot be spoofed via header.
  // In WSL2, Windows processes (FO76) connect via the WSL2 virtual gateway IP
  // (e.g. 172.25.16.1) rather than 127.0.0.1, so we also allow that address.
  const addr = req.socket?.remoteAddress ?? req.ip ?? '';
  const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const isWsl2Host = WSL2_HOST_IP !== null && addr === WSL2_HOST_IP;
  if (isLoopback || isWsl2Host) {
    return next();
  }
  logger.warn({ addr }, '[game-bridge] rejected non-local request');
  res.status(403).json({ error: 'Forbidden' });
}

/**
 * POST /api/game/player-bridge
 * Called by FCMBridge.swf inside FO76 every 3 seconds with the current
 * server player list and world ID.
 *
 * Scaleform's URLLoader may not send Content-Type: application/json, so
 * express.json() may leave req.body unparsed. We fall back to parsing the
 * raw body string ourselves.
 */
// Scaleform URLLoader may send without Content-Type: application/json.
// expressText with a function matcher catches ALL content-types (including absent).
// express.json() runs first globally; if it already parsed, this is a no-op.
const captureAnyBody = expressText({ type: () => true, limit: '64kb' });

router.post('/', requireLocalhost, captureAnyBody, (req: Request, res: Response) => {
  let body = req.body as Partial<BridgePayload>;

  // captureAnyBody sets req.body to the raw string when Content-Type isn't parsed
  // by express.json(). Flash/Scaleform may also URL-encode the body (e.g. " → %22),
  // so try plain parse first, then URL-decoded fallback.
  if (typeof body === 'string') {
    const raw = body as string;
    try {
      body = JSON.parse(raw);
    } catch {
      try { body = JSON.parse(decodeURIComponent(raw)); } catch { body = {}; }
    }
    logger.debug({ ct: req.headers['content-type'] ?? 'none', raw: raw.slice(0, 100) }, '[game-bridge] string fallback');
  }

  if (!Array.isArray(body.players)) {
    res.status(400).json({ error: 'players must be an array' });
    return;
  }

  const payload: BridgePayload = {
    worldId: String(body.worldId ?? ''),
    worldType: String(body.worldType ?? ''),
    src: body.src === 'bsui' ? 'bsui' : 'lc',
    players: body.players
      .filter((p): p is BridgePlayer => p !== null && typeof p === 'object')
      .slice(0, 64)
      .map(p => ({
        a: String(p.a ?? '').slice(0, 64),
        c: String(p.c ?? '').slice(0, 64),
        l: p.l === true,
        v: Math.max(0, Math.min(9999, Number(p.v) || 0)),
      })),
  };

  const ip = req.ip ?? '127.0.0.1';
  latestPayload.set(ip, { payload, receivedAt: Date.now() });

  logger.debug({
    ip,
    src: payload.src,
    worldId: payload.worldId,
    players: payload.players.length,
  }, '[game-bridge] received player data from FCMBridge');

  res.status(204).end();
});

/**
 * GET /api/game/player-bridge
 * Polled by the Electron overlay's GameMonitor to get the latest player data.
 * Returns 204 if no data has been received yet (or data is stale > 30s).
 */
router.get('/', requireLocalhost, (req: Request, res: Response) => {
  const STALE_MS = 30_000;
  const now = Date.now();

  // Return the most-recently-received non-stale payload
  let best: BridgePayload | null = null;
  let bestTs = 0;

  for (const [, entry] of latestPayload) {
    if (now - entry.receivedAt < STALE_MS && entry.receivedAt > bestTs) {
      best = entry.payload;
      bestTs = entry.receivedAt;
    }
  }

  if (!best) {
    res.status(204).end();
    return;
  }

  res.json({
    data: {
      worldId: best.worldId,
      worldType: best.worldType,
      src: best.src,
      players: best.players.map(p => ({
        accountName: p.a,
        characterName: p.c,
        isLocal: p.l,
        level: p.v,
      })),
      receivedAt: bestTs,
    },
  });
});

export default router;
