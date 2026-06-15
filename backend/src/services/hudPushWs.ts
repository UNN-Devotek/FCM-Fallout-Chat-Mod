/**
 * hudPushWs.ts — WebSocket front-end for the HUD push feed (Path B)
 *
 * Listens on /ws/hud (noServer WebSocketServer) when HUD_PUSH_WS_ENABLED=true.
 * Each accepted connection is registered with the transport-agnostic hudPush
 * core, which handles HELLO + backfill + live fan-out.
 *
 * The game's ZFE bridge (or wscat for testing) connects to:
 *   ws://127.0.0.1:7177/ws/hud   (dev)
 *   wss://falloutchatmod.com/ws/hud (prod via cloudflared tunnel)
 *
 * NO auth and NO Origin check on /ws/hud — the game's WS client sends no/odd
 * Origin headers; this is a public read-only feed.
 *
 * Inbound bytes from the client (legacy AUTH2:/JOIN: commands from ZFE's side)
 * are read and discarded; the connection is terminated once a client has sent
 * more than 4 KB total.
 *
 * Per-IP connection cap: 3 concurrent connections (mirrors hudPushTcp.ts and
 * wsConnsByIp in server.ts).
 *
 * Upgrade handler coexistence: the existing `{server, path:'/ws'}` WebSocketServer
 * has its own built-in upgrade handler that fires only for the '/ws' path.  We
 * attach a separate server.on('upgrade') listener that handles ONLY '/ws/hud'
 * upgrades via hudWss.handleUpgrade().  For any other pathname we do NOTHING —
 * we must NOT destroy the socket or we would race the '/ws' server's own handler.
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import env from '../config/environment';
import logger from '../config/logger';
import { registerClient, unregisterClientPublic, type HudPushClient } from './hudPush';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_INBOUND_BYTES = 4096; // terminate if client sends more than this
const PER_IP_CAP        = 3;   // max concurrent WS /ws/hud connections per IP

// ── State ─────────────────────────────────────────────────────────────────────

const wsHudConnsByIp = new Map<string, number>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function remoteIp(req: http.IncomingMessage): string {
  // Mirror the codebase's clientIp() approach: trust req.socket.remoteAddress
  // directly (no forwarded header — the game client connects raw, not via proxy).
  return req.socket?.remoteAddress ?? 'unknown';
}

// ── WebSocket server (noServer — upgrade handled manually) ────────────────────

// maxPayload is set slightly above the 4 KB inbound cap so that the ws library
// passes the frame to our message handler which applies the byte counter and
// terminates cleanly.  The message handler enforces the real limit.
const hudWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

hudWss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const ip = remoteIp(req);

  // Per-IP connection cap.
  const currentCount = wsHudConnsByIp.get(ip) ?? 0;
  if (currentCount >= PER_IP_CAP) {
    logger.warn({ ip }, '[hudPushWs] per-IP cap reached; closing connection');
    ws.close(1008, 'Too many connections');
    return;
  }
  wsHudConnsByIp.set(ip, currentCount + 1);

  let inboundBytes = 0;

  // Wrap the WS as a HudPushClient so the core can fan out lines.
  const client: HudPushClient = {
    transport: 'ws',
    // Default to the configured General channel (same as TCP).
    activeChannelId: env.HUD_DEFAULT_CHANNEL_ID,
    send(line: string): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(line);
      }
    },
    close(): void {
      try { ws.close(); } catch { /* already closed */ }
    },
  };

  registerClient(client);

  // Guard against double-cleanup from both error + close firing on the same conn.
  let cleaned = false;
  function cleanupOnce(): void {
    if (cleaned) return;
    cleaned = true;
    unregisterClientPublic(client);
    const n = (wsHudConnsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) wsHudConnsByIp.delete(ip);
    else wsHudConnsByIp.set(ip, n);
  }

  // Inbound byte tracking — discard data; terminate past 4 KB.
  ws.on('message', (data: Buffer | string) => {
    const len = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data as string);
    inboundBytes += len;
    if (inboundBytes > MAX_INBOUND_BYTES) {
      logger.warn({ ip }, '[hudPushWs] inbound byte cap exceeded; terminating');
      cleanupOnce();
      ws.terminate();
    }
    // Discard all inbound data — this is a receive-only feed connection.
  });

  ws.on('close', () => { cleanupOnce(); });

  ws.on('error', (err: Error) => {
    logger.warn({ err, ip }, '[hudPushWs] socket error');
    cleanupOnce();
  });
});

// ── Upgrade handler attachment ────────────────────────────────────────────────

/**
 * Attach a server.on('upgrade') listener that routes only /ws/hud upgrades
 * to our hudWss.  All other pathnames are left alone (DO NOT destroy) so the
 * existing path-bound '/ws' WebSocketServer can handle them without racing.
 *
 * Wire into server.ts start() next to initHudPushTcp().
 */
export function initHudPushWs(server: http.Server): void {
  // Dev-only until the M6 production-exposure decision is made (see
  // docs/overlay/zfe/realtime-socket.md). The env flag alone must not be able
  // to enable this in production — remove this guard as part of M6.
  if (env.NODE_ENV === 'production') {
    if (env.HUD_PUSH_WS_ENABLED) {
      // Emit a loud error so misconfigured deployments are immediately visible
      // in the startup log. /ws/hud has NO auth — exposure in production would
      // be a security regression.
      logger.error('[hudPushWs] MISCONFIGURATION: HUD_PUSH_WS_ENABLED=true in production — /ws/hud would be unauthenticated; refusing to start');
    }
    return;
  }
  if (!env.HUD_PUSH_WS_ENABLED) {
    logger.info('[hudPushWs] disabled (HUD_PUSH_WS_ENABLED=false)');
    return;
  }

  server.on('upgrade', (req: http.IncomingMessage, socket, head: Buffer) => {
    const pathname = (() => {
      try { return new URL(req.url ?? '', 'http://x').pathname; } catch { return req.url ?? ''; }
    })();

    if (pathname !== '/ws/hud') {
      // Not our path — leave socket untouched so the main /ws server can handle it.
      return;
    }

    hudWss.handleUpgrade(req, socket, head, (ws) => {
      hudWss.emit('connection', ws, req);
    });
  });

  logger.info('[hudPushWs] WebSocket listener attached at /ws/hud');
}
