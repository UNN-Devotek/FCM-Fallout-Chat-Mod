/**
 * upgradeRouter.ts — single HTTP "upgrade" router for the chat WebSocket server.
 *
 * The chat server runs in `noServer: true` mode and routes upgrades here:
 *   - '/ws'      → chat server `handleUpgrade` (verifyClient/origin/IP guard
 *                  still runs — it lives inside handleUpgrade, not the auto
 *                  listener).
 *   - '/relay'   → ZFE chat.v1 JSON-frame relay adapter (handleRelayConnection);
 *                  dev-only (refused in production until R6 lifts the guard).
 *   - any other path → rejected (socket destroyed) so unknown upgrade paths do
 *                  not leak hanging sockets.
 */

import type http from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import { handleRelayConnection } from '../services/relay/relayHandler';
import logger from '../config/logger';
import { clientIp, clientIpRef } from '../utils/clientIp';
import { randomUUID } from 'node:crypto';

/** Path for the main chat WebSocket. */
export const CHAT_WS_PATH = '/ws';
/** Path for the ZFE chat.v1 relay adapter. */
export const RELAY_WS_PATH = '/relay';

// Internal WebSocketServer for the relay path (noServer mode).
// Created once per process; relay connections are dispatched to handleRelayConnection.
let relayWss: WebSocketServer | null = null;
const relayConnsByIp = new Map<string, number>();
const upgradedRequests = new WeakSet<http.IncomingMessage>();

// Relay frames contain a small JSON operation plus a token and a chat body (capped at
// 500 characters by the handler). Keep this aligned with the main chat WS limit so
// unauthenticated upgrade traffic cannot use ws's 100 MiB default frame allowance.
const RELAY_MAX_PAYLOAD_BYTES = 8 * 1024;
const RELAY_MAX_CONNS_PER_IP = 5;

function getRelayWss(): WebSocketServer {
  if (!relayWss) {
    relayWss = new WebSocketServer({
      noServer: true,
      maxPayload: RELAY_MAX_PAYLOAD_BYTES,
      // Native ZFE clients deliberately send no Origin, so do not require one
      // here. Authentication is frame-based; this guard only bounds sockets.
      verifyClient: (info, cb) => {
        const ip = clientIp(info.req);
        const ipRef = clientIpRef(info.req);
        const current = relayConnsByIp.get(ip) ?? 0;
        if (current >= RELAY_MAX_CONNS_PER_IP) {
          logger.warn(
            { ipRef, current, limit: RELAY_MAX_CONNS_PER_IP },
            '[relayUpgrade] concurrent relay connection cap reached',
          );
          return cb(false, 429, 'Too many relay connections');
        }
        // Reserve before completing the upgrade. Connection callbacks run after
        // the handshake, so reserving there would allow a burst of parallel
        // upgrades to all observe the same pre-connection count.
        relayConnsByIp.set(ip, current + 1);
        const connectionRef = randomUUID();
        logger.debug?.({ event: 'relay_slot', action: 'reserved', connectionRef, ipRef,
          current: current + 1, limit: RELAY_MAX_CONNS_PER_IP }, '[relayUpgrade] connection slot');
        // The TCP stream may abort before completeUpgrade emits a WebSocket
        // connection. Own the reservation on that stream, so both aborted and
        // completed upgrades release it exactly once.
        info.req.socket.once('close', () => {
          const remaining = (relayConnsByIp.get(ip) ?? 1) - 1;
          if (remaining <= 0) relayConnsByIp.delete(ip);
          else relayConnsByIp.set(ip, remaining);
          const diagnostic = { event: 'relay_slot', action: 'released', connectionRef, ipRef,
            current: Math.max(0, remaining), limit: RELAY_MAX_CONNS_PER_IP };
          if (upgradedRequests.has(info.req)) logger.debug?.(diagnostic, '[relayUpgrade] connection slot');
          else logger.info?.(diagnostic, '[relayUpgrade] aborted upgrade released');
        });
        cb(true);
      },
    });
    relayWss.on('connection', (ws, req) => {
      upgradedRequests.add(req);
      handleRelayConnection(ws, req);
    });
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
 * exactly once after `wss` (noServer) is created. The relay WSServer for
 * RELAY_WS_PATH is created lazily here.
 */
export function attachChatUpgradeRouter(
  server: http.Server,
  wss: WebSocketServer,
): void {
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
    } else {
      // Unknown WS path.
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
  relayConnsByIp.clear();
}
