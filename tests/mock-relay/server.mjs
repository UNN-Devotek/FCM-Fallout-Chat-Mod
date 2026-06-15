/**
 * tests/mock-relay/server.mjs
 *
 * Hermetic mock server for the overlay auto-update E2E test.
 *
 * Serves two things on a single HTTP port (default 0 = OS-assigned):
 *
 *  A) electron-updater "generic" feed
 *     GET /downloads/electron/latest-linux.yml  — feed for the N+1 version
 *     GET /downloads/electron/latest.yml        — same (Windows feed, same content)
 *     GET /downloads/electron/<artifact>        — the "binary" (a tiny sentinel file)
 *
 *  B) Minimal relay/auth endpoints so the overlay can boot without hitting prod
 *     POST /api/users                           — returns a fake session token
 *     GET  /auth/ws-ticket                      — returns { data: { ticket: 'mock' } }
 *     GET  /api/health                          — 200 OK
 *     GET  /api/channels                        — returns an empty array
 *     GET  /api/messages                        — returns an empty array
 *     WebSocket /ws                             — opens and stays open (no messages)
 *
 * Usage (programmatic — imported by the E2E test):
 *
 *   import { startMockServer } from './server.mjs';
 *   const { port, close, setVersion } = await startMockServer({
 *     currentVersion: '1.3.83',   // version the "installed" app reports
 *     nextVersion:    '1.3.99',   // version N+1 served in the feed
 *   });
 *   // ... run test ...
 *   await close();
 *
 * The artifact served is a minimal valid AppImage stub (just a magic-byte prefix
 * and some padding) — large enough for electron-updater to attempt a download but
 * tiny enough to complete in milliseconds.  electron-updater verifies the sha512
 * from the feed, so the fake YML must have the hash of the fake file.  We
 * compute it at server-start time.
 */

import http from 'node:http';
import crypto from 'node:crypto';
// Use the ws package from cross-platform-overlay's node_modules (already a dep)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
// Resolve ws from the overlay's node_modules so we don't need a separate install
let WebSocketServer;
try {
  const overlayWs = path.join(__dirname, '..', '..', 'cross-platform-overlay', 'node_modules', 'ws');
  const ws = _require(overlayWs);
  WebSocketServer = ws.WebSocketServer || ws.Server;
} catch {
  WebSocketServer = null; // WS stub not available — mock will use HTTP upgrade handler
}

// ── Fake AppImage artifact ────────────────────────────────────────────────────
// A real AppImage starts with the ELF magic bytes and an ISO 9660 magic at
// byte 8. electron-updater on Linux does NOT verify the AppImage magic —
// it only verifies the sha512.  So any bytes work; we use a small placeholder.
function buildFakeArtifact(version) {
  // 4 KiB of identifiable content — large enough to trigger progress events
  // but tiny enough for CI (≪ 1 MB).
  const buf = Buffer.alloc(4096);
  buf.write(`FCM-MOCK-APPIMAGE version=${version}\n`, 0, 'utf8');
  buf.fill(0xab, 40); // fill rest with pattern
  return buf;
}

// ── Fake Windows NSIS artifact ────────────────────────────────────────────────
// electron-updater on Windows only verifies the sha512 from the feed — it does
// not inspect the PE/NSIS structure.  A small identifiable buffer is sufficient.
function buildFakeWindowsArtifact(version) {
  const buf = Buffer.alloc(4096);
  buf.write(`FCM-MOCK-NSIS version=${version}\n`, 0, 'utf8');
  buf.fill(0xcd, 40); // fill rest with a distinct pattern
  return buf;
}

function sha512Base64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

/**
 * Build the YAML text for the electron-updater generic provider feed.
 *
 * electron-updater parses this with js-yaml.  The required fields are:
 *   version, files[].url, files[].sha512, files[].size, path, sha512, releaseDate
 *
 * The `path` and first `files[].url` MUST match the filename the server
 * serves under /downloads/electron/<name>.
 */
function buildFeedYaml({ version, artifactName, artifact }) {
  const hash = sha512Base64(artifact);
  const size = artifact.length;
  const date = new Date().toISOString();
  return [
    `version: ${version}`,
    `files:`,
    `  - url: ${artifactName}`,
    `    sha512: ${hash}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${hash}`,
    `releaseDate: '${date}'`,
    '',
  ].join('\n');
}

// ── HTTP request handlers ─────────────────────────────────────────────────────

function jsonResp(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function makeRequestHandler({ feedYaml, artifact, artifactName, windowsFeedYaml, windowsArtifact, windowsArtifactName }) {
  // Pre-encode artifact names so we can match against percent-encoded pathnames
  // that electron-updater sends (spaces → %20, etc.).
  const encodedArtifactName = encodeURIComponent(artifactName);
  const encodedWindowsArtifactName = encodeURIComponent(windowsArtifactName);

  return function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // pathname is already percent-encoded by the URL parser; keep it encoded
    // for comparison against our pre-encoded artifact names.
    const path = url.pathname;

    // ── electron-updater feed endpoints ──────────────────────────────────────
    if (path === '/downloads/electron/latest-linux.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(feedYaml) });
      res.end(feedYaml);
      return;
    }

    // Windows feed — filename must be "Fallout Chat Mod Setup {version}.exe"
    if (path === '/downloads/electron/latest.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(windowsFeedYaml) });
      res.end(windowsFeedYaml);
      return;
    }

    // Linux AppImage artifact
    if (path === `/downloads/electron/${encodedArtifactName}`) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': artifact.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(artifact);
      return;
    }

    // Windows NSIS artifact — serve for both percent-encoded and raw paths since
    // electron-updater may request either form depending on the platform/version.
    if (path === `/downloads/electron/${encodedWindowsArtifactName}` ||
        path === `/downloads/electron/${windowsArtifactName}`) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': windowsArtifact.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(windowsArtifact);
      return;
    }

    // ── Relay auth / API stubs ────────────────────────────────────────────────
    if (path === '/api/health') {
      jsonResp(res, 200, { status: 'ok' });
      return;
    }

    if (path === '/api/users') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch { /* ignore */ }
          jsonResp(res, 201, {
            data: {
              token: 'mock-session-token-' + Math.random().toString(36).slice(2),
              userId: 'mock-user-1',
              username: parsed.username || 'MockUser',
              displayName: parsed.username || 'MockUser',
              discordLinked: false,
              role: null,
            },
          });
        });
        return;
      }
      jsonResp(res, 401, { detail: 'auth required' });
      return;
    }

    if (path.startsWith('/auth/ws-ticket')) {
      jsonResp(res, 200, { data: { ticket: 'mock-ticket' } });
      return;
    }

    if (path === '/api/channels') {
      jsonResp(res, 200, { data: [] });
      return;
    }

    if (path === '/api/messages') {
      jsonResp(res, 200, { data: [] });
      return;
    }

    // ── 404 for anything else ─────────────────────────────────────────────────
    jsonResp(res, 404, { detail: `mock: no handler for ${path}` });
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the mock server and return control handles.
 *
 * @param {object} opts
 * @param {string} opts.currentVersion  — version the "installed" app claims to run
 * @param {string} opts.nextVersion     — version N+1 to serve in the feed
 * @param {number} [opts.port]          — port to bind (default 0 = OS pick)
 * @returns {Promise<{ port: number, baseUrl: string, close: () => Promise<void> }>}
 */
export async function startMockServer({ currentVersion, nextVersion, port: preferredPort = 0 }) {
  const artifact = buildFakeArtifact(nextVersion);
  const artifactName = `Fallout Chat Mod-${nextVersion}.AppImage`;
  const feedYaml = buildFeedYaml({ version: nextVersion, artifactName, artifact });

  const windowsArtifact = buildFakeWindowsArtifact(nextVersion);
  const windowsArtifactName = `Fallout Chat Mod Setup ${nextVersion}.exe`;
  const windowsFeedYaml = buildFeedYaml({ version: nextVersion, artifactName: windowsArtifactName, artifact: windowsArtifact });

  const server = http.createServer(makeRequestHandler({
    feedYaml, artifact, artifactName,
    windowsFeedYaml, windowsArtifact, windowsArtifactName,
  }));

  // WebSocket server on /ws — the overlay proxy opens a WS here after auth.
  // We keep it open and silent; the overlay handles a quiet WS gracefully.
  let wss = null;
  if (WebSocketServer) {
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
    });
  } else {
    // Fallback: handle WS upgrade with a raw 101 response so the overlay
    // doesn't crash (it will see the socket close immediately, which it retries)
    server.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n\r\n'
      );
      // Close immediately — overlay will retry per its reconnect logic
      socket.end();
    });
  }

  await new Promise((resolve, reject) => {
    server.listen(preferredPort, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const actualPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  return {
    port: actualPort,
    baseUrl,
    feedYaml,
    artifactName,
    artifact,
    windowsFeedYaml,
    windowsArtifactName,
    windowsArtifact,
    close: () => new Promise((resolve, reject) => {
      // Force-close lingering keep-alive connections so server.close() doesn't
      // hang waiting for orphaned electron processes to release their sockets.
      server.closeAllConnections?.();
      const done = (err) => (err ? reject(err) : resolve());
      if (wss) wss.close(() => server.close(done));
      else server.close(done);
      // Hard timeout — if server.close() still hangs (e.g. wss draining), resolve
      // anyway after 3 seconds so the test process can exit cleanly.
      setTimeout(resolve, 3000);
    }),
  };
}

// ── Standalone entrypoint (for manual testing) ────────────────────────────────
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { port, baseUrl } = await startMockServer({
    currentVersion: '1.3.83',
    nextVersion: '1.3.99',
  });
  console.log(`Mock relay running at ${baseUrl}`);
  console.log(`  Feed:     ${baseUrl}/downloads/electron/latest-linux.yml`);
  console.log(`  Register: POST ${baseUrl}/api/users`);
  console.log('  Ctrl+C to stop');
}
