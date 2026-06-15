import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
dotenv.config();
if (existsSync('.env.local')) dotenv.config({ path: '.env.local', override: true });

export interface Environment {
  NODE_ENV: string;
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD: string;
  REDIS_URL: string;
  CLIENT_ORIGINS: string[];
  ALLOWED_ORIGINS: string[];
  TRUST_PROXY: boolean;
  LOG_LEVEL: string;
  MESSAGE_RETENTION_DAYS: number;
  DISCORD_TOKEN: string;
  DISCORD_CHANNEL_ID: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_SERVER_ID: string;
  DISCORD_REDIRECT_URI: string;
  DISCORD_LINK_REDIRECT_URI: string;
  OWNER_ROLE_ID: string;
  ADMIN_ROLE_ID: string;
  MODERATOR_ROLE_ID: string;
  SESSION_SECRET: string;
  APP_CLIENT_KEY: string;
  ADMIN_API_KEY: string;
  // Migration API key — grants raw DB access (ad-hoc SQL, pg_dump, pg_restore).
  // Optional: when unset the migration endpoints fail-closed (always 401).
  // Must be separate from ADMIN_API_KEY and ADMIN_RELEASE_TOKEN.
  // Use a long random secret (>=32 chars) and rotate after each use.
  MIGRATION_API_KEY: string;
  SPAM_MESSAGE_LIMIT: number;
  SPAM_WINDOW_MS: number;
  MINIO_ENDPOINT: string;
  MINIO_ROOT_USER: string;
  MINIO_ROOT_PASSWORD: string;
  MINIO_BUCKET: string;
  MINIO_PUBLIC_URL: string;
  VIRUSTOTAL_URL: string;
  // Tenor GIF search proxy
  TENOR_API_KEY: string;
  // Dev-only fake personas
  DEV_USER_ROLE: string;
  DEV_MOD_ROLE: string;
  DEV_ADMIN_ROLE: string;
  DEV_SUPPORTER_ROLE: string;
  DEV_DEVELOPER_ROLE: string;
  // Positive opt-in for the credential-less dev-login + simulation routes.
  // Only honored when NODE_ENV === 'development'; never in production.
  ENABLE_DEV_LOGIN: boolean;
  // Explicit opt-in to expose /api/mcp/sim/* routes. Must be 'true' AND
  // NODE_ENV must not be 'production'. Default off — both conditions required.
  ENABLE_SIM_ROUTES: boolean;
  // How often to run incremental wiki sync (hours). 0 or unset = disabled.
  WIKI_SYNC_INTERVAL_HOURS: number;
  // How often to run full CAMP database sync (hours). 0 or unset = disabled.
  CAMP_SYNC_INTERVAL_HOURS: number;
  // HUD push — raw TCP front-end (Path A)
  HUD_PUSH_TCP_ENABLED: boolean;
  // When false, registerClient sends no backfill (HELLO~1~0) — the in-game feed
  // shows ONLY live messages, no stale history. Default true.
  HUD_PUSH_BACKFILL_ENABLED: boolean;
  HUD_PUSH_TCP_PORT: number;
  // Bind host for the TCP HUD push listener. Defaults to 127.0.0.1 (loopback)
  // so the port is not publicly exposed in dev. Set to 0.0.0.0 only when the
  // game client runs on a different host (unusual). Production guard prevents
  // the listener from starting regardless of this value.
  HUD_PUSH_TCP_HOST: string;
  // TLS for the TCP HUD push listener. ZFE wraps host:port endpoints in
  // Schannel TLS 1.2 and does NOT validate the certificate, so a self-signed
  // cert is sufficient. Both must be set (paths to PEM files) to enable TLS;
  // either empty = plaintext net.Server.
  // See docs/overlay/zfe/realtime-socket.md "Probe findings".
  HUD_PUSH_TCP_TLS_CERT: string;
  HUD_PUSH_TCP_TLS_KEY: string;
  // When true, the TCP HUD push listener appends DIAG/HELLO/SEND lines to
  // hud-diag.log. The DIAG verb writes UNAUTHENTICATED, attacker-controlled
  // content to disk, so this defaults to false (off) to avoid a disk-fill /
  // log-injection vector; enable only for local debugging. (SR-005)
  HUD_PUSH_DIAG_LOG: boolean;
  // HUD push — WebSocket front-end (Path B)
  HUD_PUSH_WS_ENABLED: boolean;
  // M7 two-way chat: HMAC-SHA256 key used to derive identityHash from FO76 accountName.
  // Required when HUD_PUSH_TCP_ENABLED=true and inbound parsing is active.
  // Dev default is allowed here; must be a strong secret in production.
  HUD_IDENTITY_SECRET: string;
  // HUD default send channel — the leaf channel the in-game SWF targets when the
  // player has not explicitly selected a channel. Defaults to General
  // (00000000-0000-0000-0000-000000000005). The SWF uses this as a fallback; the
  // backend does NOT auto-redirect sends — if the SWF sends to the wrong channel
  // the send guard rejects it and the SWF must pick a valid leaf channel.
  HUD_DEFAULT_CHANNEL_ID: string;
  // Dual Discord role gate for the hosted dev environment.
  // See docs/deployment/hosted-dev-environment.md and devAuthService.ts.
  // IDs only — never prod secrets.
  PROD_GUILD_ID: string;
  PROD_DEVELOPER_ROLE_ID: string;
  DEV_GUILD_ID: string;
  DEV_DEVELOPER_ROLE_ID: string;
  // Fallback prod verification endpoint — used when guilds.members.read cannot
  // read the prod guild without the dev bot.
  PROD_VERIFY_URL: string;
  PROD_VERIFY_TOKEN: string;
}

const env: Environment = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '7076', 10),

  // Database
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: parseInt(process.env.DB_PORT || '7077', 10),
  DB_USER: process.env.DB_USER || 'fo76_user',
  DB_PASSWORD: process.env.DB_PASSWORD || '',
  DB_NAME: process.env.DB_NAME || 'fo76_chat',

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '7078', 10),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || '',
  REDIS_URL: process.env.REDIS_URL || '',

  // CORS — comma-separated list of allowed origins. Parsed into a string[]
  // so we can feed it directly to cors({ origin: [...] }). Empty entries and
  // whitespace are stripped. Validated below for production safety.
  CLIENT_ORIGINS: (process.env.CLIENT_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),

  // Tightened allow-list for WS/HTTP origin checks behind the proxy. Defaults
  // to CLIENT_ORIGINS when unset so existing deploys keep working.
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || process.env.CLIENT_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),

  // Behind Traefik (+ Cloudflare): trust forwarded headers so the real client
  // IP can be resolved for per-IP limits. See server.ts / clientIp().
  TRUST_PROXY: (process.env.TRUST_PROXY || 'false').toLowerCase() === 'true',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  MESSAGE_RETENTION_DAYS: parseInt(process.env.MESSAGE_RETENTION_DAYS || '90', 10),

  // Discord bridge
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || '',
  DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID || '',

  // Discord OAuth2
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || '',
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || '',
  DISCORD_SERVER_ID: process.env.DISCORD_SERVER_ID || '',
  DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI || 'http://localhost:7076/auth/discord/callback',
  DISCORD_LINK_REDIRECT_URI: process.env.DISCORD_LINK_REDIRECT_URI || '',
  OWNER_ROLE_ID: process.env.OWNER_ROLE_ID || '',
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || '',
  MODERATOR_ROLE_ID: process.env.MODERATOR_ROLE_ID || '',

  SESSION_SECRET: process.env.SESSION_SECRET || '',

  APP_CLIENT_KEY: process.env.APP_CLIENT_KEY || '',

  // Admin API key — bypass Discord OAuth for API-driven admin actions
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || '',
  // Migration API key (optional; fail-closed when unset — see requireMigrationKey)
  MIGRATION_API_KEY: process.env.MIGRATION_API_KEY || '',

  // Auto-moderation spam detection thresholds
  SPAM_MESSAGE_LIMIT: parseInt(process.env.SPAM_MESSAGE_LIMIT || '6', 10),
  SPAM_WINDOW_MS: parseInt(process.env.SPAM_WINDOW_MS || '10000', 10),

  // MinIO object storage
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || 'http://minio:9700',
  MINIO_ROOT_USER: process.env.MINIO_ROOT_USER || '',
  MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD || '',
  MINIO_BUCKET: process.env.MINIO_BUCKET || 'avatars',
  MINIO_PUBLIC_URL: process.env.MINIO_PUBLIC_URL || '',

  VIRUSTOTAL_URL: process.env.VIRUSTOTAL_URL || '',

  // Tenor GIF search proxy (optional — without it, /api/tenor-search returns 503)
  TENOR_API_KEY: process.env.TENOR_API_KEY || '',

  // Dev-only fake personas — only used when NODE_ENV !== 'production'
  DEV_USER_ROLE: process.env.DEV_USER_ROLE || 'user',
  DEV_MOD_ROLE: process.env.DEV_MOD_ROLE || 'moderator',
  DEV_ADMIN_ROLE: process.env.DEV_ADMIN_ROLE || 'admin',
  DEV_SUPPORTER_ROLE: process.env.DEV_SUPPORTER_ROLE || 'supporter',
  DEV_DEVELOPER_ROLE: process.env.DEV_DEVELOPER_ROLE || 'developer',
  ENABLE_DEV_LOGIN: process.env.ENABLE_DEV_LOGIN === 'true',
  ENABLE_SIM_ROUTES: process.env.ENABLE_SIM_ROUTES === 'true',
  WIKI_SYNC_INTERVAL_HOURS: parseFloat(process.env.WIKI_SYNC_INTERVAL_HOURS || '0'),
  CAMP_SYNC_INTERVAL_HOURS: parseFloat(process.env.CAMP_SYNC_INTERVAL_HOURS || '0'),
  // HUD push — raw TCP front-end (Path A)
  HUD_PUSH_TCP_ENABLED: (process.env.HUD_PUSH_TCP_ENABLED || 'false').toLowerCase() === 'true',
  HUD_PUSH_BACKFILL_ENABLED: (process.env.HUD_PUSH_BACKFILL_ENABLED || 'true').toLowerCase() === 'true',
  HUD_PUSH_TCP_PORT: parseInt(process.env.HUD_PUSH_TCP_PORT || '4001', 10),
  HUD_PUSH_TCP_HOST: process.env.HUD_PUSH_TCP_HOST || '127.0.0.1',
  HUD_PUSH_TCP_TLS_CERT: process.env.HUD_PUSH_TCP_TLS_CERT || '',
  HUD_PUSH_TCP_TLS_KEY: process.env.HUD_PUSH_TCP_TLS_KEY || '',
  HUD_PUSH_DIAG_LOG: (process.env.HUD_PUSH_DIAG_LOG || 'false').toLowerCase() === 'true',
  // HUD push — WebSocket front-end (Path B)
  HUD_PUSH_WS_ENABLED: (process.env.HUD_PUSH_WS_ENABLED || 'false').toLowerCase() === 'true',
  // HUD default send channel (General leaf channel)
  HUD_DEFAULT_CHANNEL_ID: process.env.HUD_DEFAULT_CHANNEL_ID || '00000000-0000-0000-0000-000000000005',
  // M7 two-way chat identity secret (HMAC-SHA256 key for identityHash derivation)
  HUD_IDENTITY_SECRET: process.env.HUD_IDENTITY_SECRET || 'dev-hud-identity-secret-change-me',

  // Dual Discord role gate (hosted dev environment) — IDs only, never secrets.
  PROD_GUILD_ID: process.env.PROD_GUILD_ID || '',
  PROD_DEVELOPER_ROLE_ID: process.env.PROD_DEVELOPER_ROLE_ID || '',
  DEV_GUILD_ID: process.env.DEV_GUILD_ID || '',
  DEV_DEVELOPER_ROLE_ID: process.env.DEV_DEVELOPER_ROLE_ID || '',
  PROD_VERIFY_URL: process.env.PROD_VERIFY_URL || '',
  PROD_VERIFY_TOKEN: process.env.PROD_VERIFY_TOKEN || '',
};

// Fail fast on an unrecognized NODE_ENV. Without this, a typo like 'prod' or
// 'Production' silently falls through to development behavior (dev-login,
// sim routes, relaxed CORS) — a foot-gun that could expose those surfaces in
// what was meant to be a production deploy.
{
  const allowed = ['development', 'production', 'test'];
  if (!allowed.includes(env.NODE_ENV)) {
    console.error(
      `FATAL: NODE_ENV="${env.NODE_ENV}" is not one of ${allowed.join(', ')}. ` +
      'Refusing to start to avoid accidentally enabling development-only surfaces.',
    );
    process.exit(1);
  }
}

// Startup guard: refuse to boot in production with insecure defaults
if (env.NODE_ENV === 'production') {
  const missing: string[] = [];
  if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!env.DB_PASSWORD) missing.push('DB_PASSWORD');
  if (!env.DISCORD_CLIENT_ID) missing.push('DISCORD_CLIENT_ID');
  if (!env.DISCORD_CLIENT_SECRET) missing.push('DISCORD_CLIENT_SECRET');
  if (!env.REDIS_PASSWORD && !env.REDIS_URL) missing.push('REDIS_PASSWORD');
  if (!env.MINIO_ROOT_USER || env.MINIO_ROOT_USER === 'fo76minio') missing.push('MINIO_ROOT_USER (must be non-default)');
  if (!env.MINIO_ROOT_PASSWORD || env.MINIO_ROOT_PASSWORD === 'REDACTED') missing.push('MINIO_ROOT_PASSWORD (must be non-default)');
  if (missing.length > 0) {
    console.error(`FATAL: Missing required env vars in production: ${missing.join(', ')}`);
    process.exit(1);
  }

  // CORS allowlist hardening (finding #13): production must NEVER run with an
  // empty allowlist, a literal '*', or any wildcard substring — that would
  // allow any origin to send credentialed cross-origin requests.
  if (env.CLIENT_ORIGINS.length === 0) {
    console.error('FATAL: CLIENT_ORIGINS is empty in production. Set an explicit comma-separated allowlist.');
    process.exit(1);
  }
  const hasWildcard = env.CLIENT_ORIGINS.some((o) => o === '*' || o.includes('*'));
  if (hasWildcard) {
    console.error(
      `FATAL: CLIENT_ORIGINS contains a wildcard entry (${env.CLIENT_ORIGINS.join(', ')}). ` +
      'Wildcards are not permitted in production — list exact origins only.',
    );
    process.exit(1);
  }
} else {
  // Dev/test: warn but allow. Helps catch misconfiguration early without
  // blocking local development.
  if (env.CLIENT_ORIGINS.length === 0) {
    console.warn('WARN: CLIENT_ORIGINS is empty — CORS will reject all cross-origin requests.');
  } else if (env.CLIENT_ORIGINS.some((o) => o === '*' || o.includes('*'))) {
    console.warn(
      `WARN: CLIENT_ORIGINS contains a wildcard (${env.CLIENT_ORIGINS.join(', ')}). ` +
      'This would be rejected in production.',
    );
  }
}

export default env;
module.exports = env;
