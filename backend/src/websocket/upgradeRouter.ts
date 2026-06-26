/**
 * upgradeRouter.ts — single HTTP "upgrade" router for the chat WebSocket server.
 *
 * Why this exists:
 *   The main chat server (`wss`) used to be created with
 *   `new WebSocketServer({ server, path: '/ws' })`. In that mode `ws` attaches
 *   its own `upgrade` listener whose `handleUpgrade()` calls `shouldHandle()`
 *   and **aborts every non-'/ws' upgrade with HTTP 400** — and it runs before
 *   hudPushWs's own `/ws/hud` listener, so it killed the HUD live socket before
 *   it could be claimed (observed as a 400 on `wss://…/ws/hud`).
 *   See docs/overlay/zfe/realtime-socket.md.
 *
 * Fix: run the chat server in `noServer: true` mode and route upgrades here:
 *   - '/ws'      → chat server `handleUpgrade` (verifyClient/origin/IP guard
 *                  still runs — it lives inside handleUpgrade, not the auto
 *                  listener).
 *   - '/ws/hud'  → left untouched so `initHudPushWs()`'s own listener can claim
 *                  it (when HUD_PUSH_WS_ENABLED and NODE_ENV!=='production').
 *   - '/relay'   → ZFE chat.v1 JSON-frame relay adapter (handleRelayConnection);
 *                  dev-only (refused in production until R6 lifts the guard).
 *   - any other path → rejected (socket destroyed) so unknown upgrade paths do
 *                  not leak hanging sockets.
 */

import type http from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import { handleRelayConnection } from '../services/relay/relayHandler';

/** Path reserved for the HUD live-push WebSocket (handled by hudPushWs). */
export const HUD_WS_PATH = '/ws/hud';
/** Path for the main chat WebSocket. */
export const CHAT_WS_PATH = '/ws';
/** Path for the ZFE chat.v1 relay adapter. */
export const RELAY_WS_PATH = '/relay';

// Internal WebSocketServer for the relay path (noServer mode).
// Created once per process; relay connections are dispatched to handleRelayConnection.
let relayWss: WebSocketServer | null = null;

function getRelayWss(): WebSocketServer {
  if (!relayWss) {
    relayWss = new WebSocketServer({ noServer: true });
    relayWss.on('connection', handleRelayConnection);
  }
  return relayWss;
}

/**
 * Extract the pathname from an upgrade request URL, ignoring the query string.
 * Robust against malformed URLs (returns '' so the caller rejects them).
 */
export function upgradePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '', 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/**
 * Attach the chat-upgrade router to `server`. Idempotent per call-site: call
 * exactly once after `wss` (noServer) is created. `initHudPushWs()` attaches a
 * separate listener for HUD_WS_PATH; this router deliberately leaves that path
 * alone. The relay WSSserver for RELAY_WS_PATH is created lazily here.
 */
export function attachChatUpgradeRouter(server: http.Server, wss: WebSocketServer): void {
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = upgradePathname(req.url);
    if (pathname === CHAT_WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (pathname === RELAY_WS_PATH) {
      // ZFE chat.v1 relay adapter — dev-only (the handler itself enforces the
      // NODE_ENV=production guard and closes with 1008).
      getRelayWss().handleUpgrade(req, socket, head, (ws) => {
        getRelayWss().emit('connection', ws, req);
      });
    } else if (pathname !== HUD_WS_PATH) {
      // Unknown WS path. '/ws/hud' is intentionally skipped so hudPushWs's
      // listener can handle it; everything else is rejected.
      socket.destroy();
    }
  });
}

/**
 * Close the relay WebSocket server. Called in test teardown to free the
 * internal server handle and allow the process to exit cleanly.
 */
export function closeRelayWss(): Promise<void> {
  return new Promise((resolve) => {
    if (!relayWss) return resolve();
    relayWss.close(() => {
      relayWss = null;
      resolve();
    });
  });
}

/** Reset the relay WSS singleton — for test isolation only. */
export function _resetRelayWss(): void {
  relayWss = null;
}
