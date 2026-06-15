/**
 * hudPushTcp.ts — raw TCP front-end for the HUD push feed (Path A)
 *
 * Listens on HUD_PUSH_TCP_PORT (default 4001) when HUD_PUSH_TCP_ENABLED=true.
 * Each accepted connection is registered with the transport-agnostic hudPush
 * core, which handles HELLO + backfill + live fan-out.
 *
 * ZFE's native bridge connects to this server (ZFE_TEXT_CHAT_ENDPOINT=host:port)
 * and streams FCMHUD/1 lines.  Inbound lines are parsed for M7 two-way chat:
 *   HELLO~<accountName>~<characterName> — identity handshake; must arrive first.
 *   SEND~<channelId>~<text>             — ingest as real chat message.
 * Unknown verbs are silently ignored.  Per-line cap: MAX_LINE_BYTES (replaces
 * the old blunt 4 KB total cap — flood control is the shared rate-limiter).
 *
 * Per-IP connection cap: 3 concurrent connections (mirrors wsConnsByIp in server.ts).
 *
 * TLS: ZFE wraps host:port endpoints in Schannel TLS 1.2 and does NOT validate
 * the certificate — a self-signed cert is sufficient. Set HUD_PUSH_TCP_TLS_CERT
 * and HUD_PUSH_TCP_TLS_KEY (paths to PEM files) to enable. When either is empty
 * the server falls back to plaintext net.Server.
 *
 * Start/stop are exported for wiring into server.ts start() and for test teardown.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';
import env from '../config/environment';
import logger from '../config/logger';
import { registerClient, unregisterClientPublic, switchClientChannel, type HudPushClient } from './hudPush';
import { deriveIdentityHash, resolveHudIdentity, getActiveBlock, usingDefaultIdentitySecret } from './hudIdentityService';
import { ingestMessage } from './ingestMessage';

// ── Constants ─────────────────────────────────────────────────────────────────

// Per-line length cap — flood control is handled by the shared rate-limiter in
// ingestMessage rather than a blunt total-bytes cap.
const MAX_LINE_BYTES    = 2048;          // max bytes in a single inbound line
const MAX_WRITE_BUFFER  = 64 * 1024;    // 64 KB write-buffer cap
const PER_IP_CAP        = 3;            // max concurrent TCP connections per IP
const BUFFER_CHECK_INTERVAL_MS = 5_000; // how often to poll bufferSize

// ── Per-socket inbound state ──────────────────────────────────────────────────

interface HudSocketState {
  identified: boolean;
  identityHash?: string;
  userId?: string;
  lineBuf: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

const tcpConnsByIp = new Map<string, number>();
let tcpServer: net.Server | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function remoteIp(socket: net.Socket): string {
  return socket.remoteAddress ?? 'unknown';
}

function destroySocket(socket: net.Socket, reason: string): void {
  logger.warn({ reason, ip: remoteIp(socket) }, '[hudPushTcp] destroying socket');
  try { socket.destroy(); } catch { /* already gone */ }
}

/**
 * Append a line to hud-diag.log ONLY when HUD_PUSH_DIAG_LOG is enabled (SR-005).
 * The DIAG verb is unauthenticated and the content is attacker-controlled, so
 * disk writes are off by default to prevent a disk-fill / log-injection vector.
 */
function diagLog(line: string): void {
  if (!env.HUD_PUSH_DIAG_LOG) return;
  try { fs.appendFileSync('hud-diag.log', `${new Date().toISOString()} ${line}\n`); } catch { /* non-fatal */ }
}

// ── Shared connection handler (net.Socket and tls.TLSSocket are compatible) ──

function handleConnection(socket: net.Socket): void {
  const ip = remoteIp(socket);

  // Per-IP connection cap.
  const currentCount = tcpConnsByIp.get(ip) ?? 0;
  diagLog(`CONN-ACCEPT ip=${ip} existingForIp=${currentCount}`);
  if (currentCount >= PER_IP_CAP) {
    diagLog(`CONN-REJECT ip=${ip} reason=per-IP-cap count=${currentCount}`);
    destroySocket(socket, 'per-IP cap reached');
    return;
  }
  tcpConnsByIp.set(ip, currentCount + 1);

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);

  // ── Per-socket inbound state ─────────────────────────────────────────────
  const state: HudSocketState = {
    identified: false,
    lineBuf: '',
  };

  // Wrap the raw socket as a HudPushClient so the core can fan out lines.
  const client: HudPushClient = {
    transport: 'tcp',
    // Default to the configured General channel; updated by CHAN verb.
    activeChannelId: env.HUD_DEFAULT_CHANNEL_ID,
    send(line: string): void {
      // Guard: destroy if write buffer is too large before sending.
      if (socket.writableLength > MAX_WRITE_BUFFER) {
        destroySocket(socket, 'write buffer exceeded');
        throw new Error('write buffer exceeded');
      }
      socket.write(line);
    },
    close(): void {
      try { socket.destroy(); } catch { /* already gone */ }
    },
  };

  registerClient(client);
  diagLog(`CONN-REGISTERED ip=${ip} (HELLO+backfill queued)`);

  socket.on('close', () => diagLog(`CONN-CLOSE ip=${ip}`));
  socket.on('error', (e) => diagLog(`CONN-ERROR ip=${ip} ${String((e as Error)?.message)}`));

  // Guard against double-cleanup from both error + close firing on the same conn.
  let cleaned = false;
  function cleanupOnce(): void {
    if (cleaned) return;
    cleaned = true;
    clearInterval(bufferGuard);
    unregisterClientPublic(client);
    const n = (tcpConnsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) tcpConnsByIp.delete(ip);
    else tcpConnsByIp.set(ip, n);
  }

  // Periodic buffer-size guard (catches backlog that grows between sends).
  const bufferGuard = setInterval(() => {
    if (!socket.writable) { cleanupOnce(); return; }
    if (socket.writableLength > MAX_WRITE_BUFFER) {
      cleanupOnce();
      destroySocket(socket, 'write buffer exceeded (interval check)');
    }
  }, BUFFER_CHECK_INTERVAL_MS);
  bufferGuard.unref();

  // NOTE: HELLO is OPTIONAL. The one-way feed client is receive-only and never
  // sends a HELLO — it must NOT be dropped. HELLO only ever ENABLES the inbound
  // SEND path (identity handshake); its absence simply means this connection can
  // receive the feed but cannot post. Never destroy a socket for "no HELLO".

  // ── Inbound line parser ──────────────────────────────────────────────────
  // Lines are UTF-8, \n-terminated, ~-delimited (FCMHUD/1 framing, ALL-CAPS verb).
  // Serialize line handling per connection: HELLO and SEND often arrive in the
  // same TCP chunk, and handleLine is async (awaits DB lookups). Without a chain,
  // SEND's `state.identified` check could run before HELLO resolves and wrongly
  // reject the message. The promise chain guarantees sequential processing.
  let lineChain: Promise<void> = Promise.resolve();
  socket.on('data', (chunk: Buffer) => {
    const str = chunk.toString('utf8');
    diagLog(`INBOUND ip=${ip} bytes=${chunk.length} raw=${JSON.stringify(str.slice(0, 120))}`);
    for (const ch of str) {
      if (ch === '\n') {
        const line = state.lineBuf;
        state.lineBuf = '';
        if (line.length === 0) continue;
        lineChain = lineChain.then(() => handleLine(line, socket, state, cleanupOnce, client));
      } else {
        state.lineBuf += ch;
        if (state.lineBuf.length > MAX_LINE_BYTES) {
          logger.warn({ ip, len: state.lineBuf.length }, '[hudPushTcp] inbound line exceeds MAX_LINE_BYTES; dropping');
          state.lineBuf = '';
        }
      }
    }
  });

  socket.on('close', () => { cleanupOnce(); });

  socket.on('error', (err) => {
    logger.warn({ err, ip }, '[hudPushTcp] socket error');
    cleanupOnce();
  });
}

// ── Inbound line handler ──────────────────────────────────────────────────────

/**
 * Handle a single complete inbound line from the ZFE socket.
 *
 * Recognized verbs:
 *   HELLO~<accountName>~<characterName>
 *   SEND~<channelId>~<text>
 *
 * Unknown verbs are silently ignored (forward-compatible).
 * Fire-and-forget (void); errors are logged, never propagated.
 */
async function handleLine(
  line: string,
  socket: net.Socket,
  state: HudSocketState,
  cleanupOnce: () => void,
  client?: HudPushClient,
): Promise<void> {
  const firstTilde = line.indexOf('~');
  if (firstTilde === -1) return; // no verb separator — ignore
  const verb = line.slice(0, firstTilde).toUpperCase();
  const rest = line.slice(firstTilde + 1);

  try {
    switch (verb) {
      case 'DIAG': {
        // Diagnostic line from the in-game SWF — append to a readable file so the
        // patched HUDMenu's behavior is visible even when the ZFE logger isn't
        // reachable from its context. Dev aid; harmless if unused.
        diagLog(`DIAG ${rest}`);
        logger.info({ diag: rest }, '[hudPushTcp] DIAG');
        return;
      }

      case 'HELLO': {
        // HELLO~<accountName>~<characterName>
        const secondTilde = rest.indexOf('~');
        if (secondTilde === -1) {
          logger.warn({ verb: 'HELLO' }, '[hudPushTcp] malformed HELLO — missing characterName');
          return;
        }
        const accountName   = rest.slice(0, secondTilde).trim();
        const characterName = rest.slice(secondTilde + 1).trim();

        if (accountName.length === 0 || characterName.length === 0) {
          logger.warn('[hudPushTcp] HELLO with empty accountName or characterName — ignoring');
          return;
        }

        const identityHash = deriveIdentityHash(accountName);

        // Check for a ban block — destroy socket immediately.
        const block = await getActiveBlock(identityHash);
        if (block && block.type === 'ban') {
          logger.info({ identityHash: identityHash.slice(0, 12) }, '[hudPushTcp] banned hash — destroying socket');
          cleanupOnce();
          destroySocket(socket, 'banned identity');
          return;
        }

        // Resolve or provision user.
        const identity = await resolveHudIdentity(accountName, characterName);
        if (!identity) {
          logger.warn('[hudPushTcp] resolveHudIdentity failed — destroying socket');
          cleanupOnce();
          destroySocket(socket, 'identity resolution failed');
          return;
        }

        state.identityHash = identity.identityHash;
        state.userId       = identity.userId;
        state.identified   = true;
        logger.info(
          { userId: state.userId, identityHash: state.identityHash.slice(0, 12), characterName },
          '[hudPushTcp] HELLO accepted',
        );
        diagLog(`HELLO-ACCEPTED user=${state.userId} char=${characterName}`);
        break;
      }

      case 'SEND': {
        // SEND~<channelId>~<text>
        if (!state.identified || !state.userId) {
          logger.warn('[hudPushTcp] SEND before HELLO — ignoring');
          return;
        }

        const secondTilde = rest.indexOf('~');
        if (secondTilde === -1) return; // malformed — no text field

        const channelId = rest.slice(0, secondTilde).trim();
        // Text may itself contain ~ — join the remainder
        const text = rest.slice(secondTilde + 1);

        if (text.trim().length === 0) return;

        const result = await ingestMessage({
          userId:       state.userId,
          channelId,
          rawContent:   text,
          source:       'hud',
          identityHash: state.identityHash,
        });

        if (!result.ok) {
          logger.info(
            { userId: state.userId, reason: result.reason },
            '[hudPushTcp] SEND rejected by ingestMessage',
          );
        }
        diagLog(`SEND ch=${channelId} ok=${result.ok}${result.reason ? ' reason=' + result.reason : ''} text=${JSON.stringify(text.slice(0, 60))}`);
        break;
      }

      case 'CHAN': {
        // CHAN~<channelId>  — switch the active channel for this connection.
        // The client receives ACTIVECHAN~<name> + last 30 messages of the new channel.
        // Invalid (non-leaf / archived / unknown) channel IDs are silently ignored.
        if (!client) break; // safety: should always be provided from handleConnection
        const channelId = rest.trim();
        if (channelId.length === 0) break;
        diagLog(`CHAN ch=${channelId}`);
        switchClientChannel(client, channelId);
        break;
      }

      default:
        // Unknown verbs are silently ignored (PING, AUTH2, JOIN are legacy/outbound — safe to discard).
        break;
    }
  } catch (err) {
    logger.warn({ err, verb }, '[hudPushTcp] handleLine error (non-fatal)');
  }
}

// ── TLS cert loading ──────────────────────────────────────────────────────────

/**
 * Resolve a cert/key path relative to the backend process cwd so that relative
 * paths in .env.local work regardless of where the TS runner resolves from.
 */
function resolvePemPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

interface TlsPems {
  cert: Buffer;
  key: Buffer;
}

/**
 * Attempt to read TLS PEM files. Returns undefined when paths are not configured.
 * Throws on read failure — the caller should abort start rather than silently
 * falling back to plaintext (a plaintext listener would be a confusing dev trap).
 */
function loadTlsPems(certPath: string, keyPath: string): TlsPems | undefined {
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    throw new Error(
      'HUD_PUSH_TCP_TLS_CERT and HUD_PUSH_TCP_TLS_KEY must both be set (or both empty). ' +
      `Got cert="${certPath}" key="${keyPath}".`,
    );
  }
  const resolvedCert = resolvePemPath(certPath);
  const resolvedKey  = resolvePemPath(keyPath);
  const cert = fs.readFileSync(resolvedCert);
  const key  = fs.readFileSync(resolvedKey);
  return { cert, key };
}

// ── Server factory (accepts optional port override for tests) ─────────────────

export function createTcpServer(pems?: TlsPems): net.Server {
  if (pems) {
    return tls.createServer({ cert: pems.cert, key: pems.key }, handleConnection);
  }
  return net.createServer(handleConnection);
}

// ── Start / stop ──────────────────────────────────────────────────────────────

/**
 * Start the TCP listener.  port defaults to env.HUD_PUSH_TCP_PORT; pass an
 * explicit value (e.g. 0 for ephemeral) to override — used in integration tests.
 *
 * TLS is driven by env.HUD_PUSH_TCP_TLS_CERT / env.HUD_PUSH_TCP_TLS_KEY.
 * On cert-read failure the function rejects (does not fall back to plaintext).
 */
export function startTcpServer(port?: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    let pems: TlsPems | undefined;
    try {
      pems = loadTlsPems(env.HUD_PUSH_TCP_TLS_CERT, env.HUD_PUSH_TCP_TLS_KEY);
    } catch (err) {
      logger.error({ err }, '[hudPushTcp] failed to read TLS cert/key — refusing to start (would silently serve plaintext)');
      return reject(err);
    }

    const useTls = !!pems;
    const listenPort = port ?? env.HUD_PUSH_TCP_PORT;
    const server = createTcpServer(pems);
    tcpServer = server;
    const listenHost = env.HUD_PUSH_TCP_HOST;
    server.listen(listenPort, listenHost, () => {
      const addr = server.address() as net.AddressInfo;
      logger.info({ port: addr.port, tls: useTls }, `[hudPushTcp] TCP listener started (tls=${useTls})`);
      resolve(server);
    });
    server.on('error', (err) => {
      logger.error({ err }, '[hudPushTcp] TCP server error');
      reject(err);
    });
  });
}

export function stopTcpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!tcpServer) return resolve();
    tcpServer.close(() => resolve());
    tcpServer = null;
  });
}

/**
 * Wire into server.ts start().  Logs and swallows when the flag is off.
 */
export async function initHudPushTcp(): Promise<void> {
  // Dev-only until the M6 production-exposure decision is made (see
  // docs/overlay/zfe/realtime-socket.md). The env flag alone must not be able
  // to enable this in production — remove this guard as part of M6.
  if (env.NODE_ENV === 'production') {
    if (env.HUD_PUSH_TCP_ENABLED) {
      logger.warn('[hudPushTcp] HUD_PUSH_TCP_ENABLED is set but HUD push is dev-only; refusing to start in production');
    }
    return;
  }
  if (!env.HUD_PUSH_TCP_ENABLED) {
    logger.info('[hudPushTcp] disabled (HUD_PUSH_TCP_ENABLED=false)');
    return;
  }
  // SR-003: the inbound SEND/HELLO path derives identityHash from
  // HUD_IDENTITY_SECRET. If it is still the public dev default, identities are
  // forgeable — fail closed rather than start an inbound chat path with a
  // known key. (The prod guard above already blocks production; this also
  // protects any non-prod host that enables inbound chat without a real secret.)
  if (usingDefaultIdentitySecret()) {
    logger.error('[hudPushTcp] HUD_IDENTITY_SECRET is unset or the dev default — refusing to start inbound HUD chat (identities would be forgeable). Set a strong HUD_IDENTITY_SECRET.');
    return;
  }
  try {
    await startTcpServer();
  } catch (err) {
    logger.error({ err }, '[hudPushTcp] failed to start TCP server (non-fatal — HUD push TCP unavailable)');
  }
}
