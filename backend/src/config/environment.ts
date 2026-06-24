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
  // GitHub ticketing (Discord <-> GitHub Issues/Projects). GITHUB_PAT is a
  // fine-grained PAT (owner UNN-Devotek) needing Issues:R/W + Projects:R/W.
  // Projects v2 are GraphQL-only; the *_NUMBER values are the /users/<owner>/projects/<N> numbers.
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  // Single master GitHub Project v2 board (all issues + features). Used for the panel link.
  GITHUB_PROJECT_NUMBER: number;
  // HMAC secret verifying inbound GitHub webhooks (X-Hub-Signature-256). Increment 2.
  GITHUB_WEBHOOK_SECRET: string;
  // Staff role for ticket gating (developers) — owner/admin/moderator reuse the existing ids.
  DEVELOPER_ROLE_ID: string;
  // Role @-pinged in bug/suggestion ticket threads (support team).
  SUPPORT_ROLE_ID: string;
  // Nexus OAuth 2.0 + PKCE (feature-flagged: disabled when creds are absent)
  // Confidential client: client_secret required at token endpoint alongside PKCE.
  // Registration: email Nexus support (https://nexusmods.com/users/myaccount?tab=api).
  // OIDC discovery: https://users.nexusmods.com/.well-known/openid-configuration
  NEXUS_OAUTH_CLIENT_ID: string;
  NEXUS_OAUTH_CLIENT_SECRET: string;
  NEXUS_OAUTH_REDIRECT_URI: string;
  // HUD identity hash secret (M6+): HMAC-SHA256 key for identityHash = HMAC(secret, userId)
  // Replaces HUD_IDENTITY_SECRET for account-derived (unforgeable) identity hashes.
  HUD_IDENTITY_HASH_SECRET: string;
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

  // GitHub ticketing
  GITHUB_PAT: process.env.GITHUB_PAT || '',
  GITHUB_OWNER: process.env.GITHUB_OWNER || 'UNN-Devotek',
  GITHUB_REPO: process.env.GITHUB_REPO || 'FCM-Fallout-Chat-Mod',
  GITHUB_PROJECT_NUMBER: parseInt(process.env.GITHUB_PROJECT_NUMBER || '5', 10),
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || '',
  DEVELOPER_ROLE_ID: process.env.DEVELOPER_ROLE_ID || '',
  SUPPORT_ROLE_ID: process.env.SUPPORT_ROLE_ID || '',
  // Nexus OAuth 2.0 + PKCE (feature-flagged: disabled when creds are absent)
  NEXUS_OAUTH_CLIENT_ID: process.env.NEXUS_OAUTH_CLIENT_ID || '',
  NEXUS_OAUTH_CLIENT_SECRET: process.env.NEXUS_OAUTH_CLIENT_SECRET || '',
  NEXUS_OAUTH_REDIRECT_URI: process.env.NEXUS_OAUTH_REDIRECT_URI || 'http://localhost:7177/auth/nexus/callback',
  HUD_IDENTITY_HASH_SECRET: process.env.HUD_IDENTITY_HASH_SECRET || '',
};

// The dev fallback value for HUD_IDENTITY_SECRET (the HMAC key that derives
// in-game HUD identityHashes). MUST stay byte-for-byte in sync with both the
// default assigned to HUD_IDENTITY_SECRET above and the sentinel exported as
// DEV_DEFAULT_IDENTITY_SECRET in services/hudIdentityService.ts. Defined here
// (the dependency-free config module) rather than imported from the service to
// avoid a circular import — the service imports `env` from this file. The
// startup guard below and hudIdentityService share this same literal, and
// environmentStartupGuard.test.js asserts the two never drift.
export const DEV_DEFAULT_HUD_IDENTITY_SECRET = 'dev-hud-identity-secret-change-me';

/**
 * Pure predicate: would the production startup guard refuse to boot for this
 * combination? Exported so it can be unit-tested without triggering
 * process.exit. The HUD identity secret is the HMAC key behind every in-game
 * HUD identityHash; with the public dev default (or empty) those identities are
 * forgeable, so production must never boot the inbound HUD chat path with it.
 * The guard only fires when the inbound TCP path is actually enabled.
 */
export function hudIdentitySecretGuardFails(opts: {
  nodeEnv: string;
  hudPushTcpEnabled: boolean;
  hudIdentitySecret: string | undefined | null;
}): boolean {
  if (opts.nodeEnv !== 'production') return false;
  if (!opts.hudPushTcpEnabled) return false;
  return !opts.hudIdentitySecret || opts.hudIdentitySecret === DEV_DEFAULT_HUD_IDENTITY_SECRET;
}

// Insecure/dev defaults the production MinIO guard rejects. Hoisted to single
// constants so the guard and any future drift-assertion test share one source of
// truth (mirrors the DEV_DEFAULT_HUD_IDENTITY_SECRET pattern above).
export const MINIO_DOCKER_DEFAULT_ENDPOINT = 'http://minio:9700';
export const DEV_DEFAULT_MINIO_ROOT_USER = 'fo76minio';
export const DEV_DEFAULT_MINIO_ROOT_PASSWORD = 'REDACTED';

/**
 * Pure predicate: collect the human-readable reasons the production startup guard
 * would refuse to boot for these MinIO vars (empty array = OK). Exported (and
 * re-attached to module.exports below) so the unit test asserts the REAL guard
 * rather than a re-implemented copy — a revert of any check then fails CI, the
 * way environmentStartupGuard.test.js covers hudIdentitySecretGuardFails.
 *
 * Note: MINIO_ENDPOINT is the SERVER-SIDE S3 client endpoint and is intended to
 * stay Docker-internal in the Dokploy topology; we only require it to be set and
 * not the literal compose default. Browser reachability is MINIO_PUBLIC_URL's job.
 * MINIO_BUCKET must be set but its value is NOT constrained — 'avatars' is the
 * long-standing code default (storage.ts) and a valid production bucket name.
 */
export function collectMinioProductionErrors(env: {
  MINIO_ROOT_USER?: string;
  MINIO_ROOT_PASSWORD?: string;
  MINIO_ENDPOINT?: string;
  MINIO_BUCKET?: string;
  MINIO_PUBLIC_URL?: string;
}): string[] {
  const missing: string[] = [];
  if (!env.MINIO_ROOT_USER || env.MINIO_ROOT_USER === DEV_DEFAULT_MINIO_ROOT_USER)
    missing.push('MINIO_ROOT_USER (must be non-default)');
  if (!env.MINIO_ROOT_PASSWORD || env.MINIO_ROOT_PASSWORD === DEV_DEFAULT_MINIO_ROOT_PASSWORD)
    missing.push('MINIO_ROOT_PASSWORD (must be non-default)');
  if (!env.MINIO_ENDPOINT || env.MINIO_ENDPOINT === MINIO_DOCKER_DEFAULT_ENDPOINT)
    missing.push('MINIO_ENDPOINT (must be set; not the Docker compose default)');
  if (!env.MINIO_BUCKET)
    missing.push('MINIO_BUCKET (must be explicitly set)');
  if (!env.MINIO_PUBLIC_URL)
    missing.push('MINIO_PUBLIC_URL (must be set — the fallback uses MINIO_ENDPOINT, which is not browser-reachable in production)');
  return missing;
}

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
  missing.push(...collectMinioProductionErrors(env));
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

  // HUD identity secret hardening (SR-003): when the inbound HUD chat path
  // (HUD_PUSH_TCP_ENABLED) is on, HUD_IDENTITY_SECRET is the HMAC key behind
  // every in-game identityHash. If it is empty or still the public dev default,
  // identities are forgeable — refuse to boot rather than start the inbound path
  // with a known key. hudPushTcp already fails the listener closed, but this
  // fail-closed boot guard catches the misconfiguration earlier and louder.
  if (hudIdentitySecretGuardFails({
    nodeEnv: env.NODE_ENV,
    hudPushTcpEnabled: env.HUD_PUSH_TCP_ENABLED,
    hudIdentitySecret: env.HUD_IDENTITY_SECRET,
  })) {
    console.error(
      'FATAL: HUD_PUSH_TCP_ENABLED is true but HUD_IDENTITY_SECRET is empty or the ' +
      'public dev default. In-game HUD identities would be forgeable. Set a strong, ' +
      'unique HUD_IDENTITY_SECRET (e.g. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`).',
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
// `module.exports = env` makes require() return env directly (see consumers /
// tests). That clobbers esbuild's named CJS exports, so re-attach the guard
// helper + sentinel onto env so they remain reachable from require('./environment').
(env as unknown as Record<string, unknown>).hudIdentitySecretGuardFails = hudIdentitySecretGuardFails;
(env as unknown as Record<string, unknown>).DEV_DEFAULT_HUD_IDENTITY_SECRET = DEV_DEFAULT_HUD_IDENTITY_SECRET;
(env as unknown as Record<string, unknown>).collectMinioProductionErrors = collectMinioProductionErrors;
module.exports = env;
