import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
dotenv.config();
if (existsSync('.env.local')) dotenv.config({ path: '.env.local', override: true });

// Keep the raw value long enough to distinguish an intentional `false` from a
// missing or malformed production setting. The parsed boolean alone would
// silently disable the paid supporter feature when a deployment regenerates
// `.env` without this variable.
const rawSupporterTierEnabled = process.env.SUPPORTER_TIER_ENABLED?.trim().toLowerCase();
const supporterTierEnabledConfigured = rawSupporterTierEnabled === 'true'
  || rawSupporterTierEnabled === 'false';

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
  /** Optional command-only Discord channel where the bot maintains a sticky help embed. */
  DISCORD_BOT_COMMANDS_CHANNEL_ID: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_SERVER_ID: string;
  // Scheduled-event mirroring is always registered when the Discord bot runs.
  // The bot does not create an Events channel or mutate native Interested state.
  DISCORD_EVENTS_CHANNEL_ID: string;
  /** Opt-in role pinged for desktop overlay release announcements. */
  OVERLAY_UPDATE_NOTIFICATION_ROLE_ID: string;
  /** Opt-in role pinged for in-game HUD mod release announcements. */
  HUD_MOD_UPDATE_NOTIFICATION_ROLE_ID: string;
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
  FCM_PUBLIC_BASE_URL: string;
  VIRUSTOTAL_URL: string;
  // Tenor GIF search proxy
  TENOR_API_KEY: string;
  // OpenAI Moderation API (optional — absent key degrades to the keyword filter)
  OPENAI_API_KEY: string;
  // Dev-only fake personas
  DEV_USER_ROLE: string;
  DEV_MOD_ROLE: string;
  DEV_ADMIN_ROLE: string;
  DEV_SUPPORTER_ROLE: string;
  DEV_DEVELOPER_ROLE: string;
  // Positive opt-in for browser-only DEV persona aliases and simulation routes.
  // Remote browser aliases still require an owner/admin session; local loopback
  // and overlay persona login are separately gated.
  // Only honored when NODE_ENV === 'development'; never in production.
  ENABLE_DEV_LOGIN: boolean;
  // Optional shared key for remote hosted-DEV DevAccount requests. Loopback
  // local-dev requests do not need it; remote requests fail closed when unset.
  DEV_PERSONA_LOGIN_SECRET: string;
  // Explicit opt-in to expose /api/mcp/sim/* routes. Must be 'true' AND
  // NODE_ENV must not be 'production'. Default off — both conditions required.
  ENABLE_SIM_ROUTES: boolean;
  // How often to run incremental wiki sync (hours). 0 or unset = disabled.
  WIKI_SYNC_INTERVAL_HOURS: number;
  // How often to run full CAMP database sync (hours). 0 or unset = disabled.
  CAMP_SYNC_INTERVAL_HOURS: number;
  // chat.v1 relay is default-off in production; a reviewed rollout must enable it.
  RELAY_PRODUCTION_ENABLED: boolean;
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
  // QA tester gate — dev guild only. The QA role ID in the DEV Discord guild.
  DEV_QA_ROLE_ID: string;
  // Optional explicit redirect URI for the QA OAuth callback; falls back to the
  // request's proto+host + /auth/discord/qa/callback when empty.
  DISCORD_QA_REDIRECT_URI: string;
  // Golden-build version lock (dev-only). The single currently-active QA build
  // version, and the on/off switch for the lock.
  QA_ACTIVE_VERSION: string;
  QA_BUILD_LOCK: boolean;
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
  MCP_REMOTE_ENABLED: boolean;
  MCP_ISSUER_URL: string;
  MCP_RESOURCE_URL: string;
  MCP_ALLOWED_ORIGINS: string[];
  MCP_OAUTH_STATE_SECRET: string;
  MCP_ACCESS_TOKEN_TTL_SECONDS: number;
  MCP_REFRESH_TOKEN_TTL_SECONDS: number;
  // Role @-pinged in bug/suggestion ticket threads (support team).
  SUPPORT_ROLE_ID: string;
  // Nexus OAuth 2.0 + PKCE (feature-flagged: disabled when creds are absent)
  // Confidential client: client_secret required at token endpoint alongside PKCE.
  // Registration: email Nexus support (https://nexusmods.com/users/myaccount?tab=api).
  // OIDC discovery: https://users.nexusmods.com/.well-known/openid-configuration
  NEXUS_OAUTH_CLIENT_ID: string;
  NEXUS_OAUTH_CLIENT_SECRET: string;
  NEXUS_OAUTH_REDIRECT_URI: string;
  // Steam OpenID 2.0. The realm/return URI are derived from the request when
  // unset; set them explicitly for the public HTTPS deployment.
  STEAM_OPENID_REALM: string;
  STEAM_OPENID_RETURN_URI: string;
  // HMAC key for privacy-preserving native HUD room diagnostics.
  HUD_IDENTITY_HASH_SECRET: string;
  // ── Supporter tier (cosmetics entitlement) ────────────────────────────────
  // Discord Server Subscription tier roles. Discord assigns these automatically on
  // purchase and removes them on cancellation, so the ROLE is the entitlement signal
  // (see supporterService.resolveSupporterTier). ADMIN_ROLE_ID is also treated as
  // an Overseer-level cosmetics bypass when the feature is enabled, but it remains
  // deliberately separate from the owner/admin/moderator cascade in
  // roleVerificationService: this never grants or changes moderation privileges.
  SUPPORTER_ROLE_ID: string;
  OVERSEER_CIRCLE_ROLE_ID: string;
  // Master switch for the supporter/cosmetics feature. When false, all cosmetics —
  // including the admin-role bypass — are disabled. This lets the code ship to prod
  // well ahead of the commercial switch-on.
  SUPPORTER_TIER_ENABLED: boolean;
  // Public URL of the Discord server shop / subscription page, used by the pricing CTA
  // and the /cosmetics upsell copy. Point at the WEB purchase path — mobile purchases
  // net materially less after the app-store cut.
  DISCORD_SERVER_SHOP_URL: string;
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
  DISCORD_BOT_COMMANDS_CHANNEL_ID: process.env.DISCORD_BOT_COMMANDS_CHANNEL_ID || '',

  // Discord OAuth2
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || '',
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || '',
  DISCORD_SERVER_ID: process.env.DISCORD_SERVER_ID || '',
  DISCORD_EVENTS_CHANNEL_ID: process.env.DISCORD_EVENTS_CHANNEL_ID || '',
  OVERLAY_UPDATE_NOTIFICATION_ROLE_ID: process.env.OVERLAY_UPDATE_NOTIFICATION_ROLE_ID || '',
  HUD_MOD_UPDATE_NOTIFICATION_ROLE_ID: process.env.HUD_MOD_UPDATE_NOTIFICATION_ROLE_ID || '',
  DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI || 'http://localhost:7076/auth/discord/callback',
  DISCORD_LINK_REDIRECT_URI: process.env.DISCORD_LINK_REDIRECT_URI || '',
  OWNER_ROLE_ID: process.env.OWNER_ROLE_ID || '',
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || '',
  MODERATOR_ROLE_ID: process.env.MODERATOR_ROLE_ID || '',
  SUPPORTER_ROLE_ID: process.env.SUPPORTER_ROLE_ID || '',
  OVERSEER_CIRCLE_ROLE_ID: process.env.OVERSEER_CIRCLE_ROLE_ID || '',
  SUPPORTER_TIER_ENABLED: rawSupporterTierEnabled === 'true',
  DISCORD_SERVER_SHOP_URL: process.env.DISCORD_SERVER_SHOP_URL || '',

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
  // Public web base for user-facing links (e.g. the chat link-flow URL the in-game HUD shows).
  // Prod default; the dev stack sets this to https://dev.falloutchatmod.com via its compose env.
  FCM_PUBLIC_BASE_URL: process.env.FCM_PUBLIC_BASE_URL || 'https://falloutchatmod.com',

  VIRUSTOTAL_URL: process.env.VIRUSTOTAL_URL || '',

  // Tenor GIF search proxy (optional — without it, /api/tenor-search returns 503)
  TENOR_API_KEY: process.env.TENOR_API_KEY || '',

  // OpenAI Moderation API key. DELIBERATELY NOT in the production `missing[]`
  // startup guard below: AI moderation is fail-open by design, so an absent key
  // must degrade to the keyword denylists rather than refuse to boot.
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',

  // Dev-only fake personas — only used when NODE_ENV !== 'production'
  DEV_USER_ROLE: process.env.DEV_USER_ROLE || 'user',
  DEV_MOD_ROLE: process.env.DEV_MOD_ROLE || 'moderator',
  DEV_ADMIN_ROLE: process.env.DEV_ADMIN_ROLE || 'admin',
  DEV_SUPPORTER_ROLE: process.env.DEV_SUPPORTER_ROLE || 'supporter',
  DEV_DEVELOPER_ROLE: process.env.DEV_DEVELOPER_ROLE || 'developer',
  ENABLE_DEV_LOGIN: process.env.ENABLE_DEV_LOGIN === 'true',
  DEV_PERSONA_LOGIN_SECRET: process.env.DEV_PERSONA_LOGIN_SECRET || '',
  ENABLE_SIM_ROUTES: process.env.ENABLE_SIM_ROUTES === 'true',
  WIKI_SYNC_INTERVAL_HOURS: parseFloat(process.env.WIKI_SYNC_INTERVAL_HOURS || '0'),
  CAMP_SYNC_INTERVAL_HOURS: parseFloat(process.env.CAMP_SYNC_INTERVAL_HOURS || '0'),
  RELAY_PRODUCTION_ENABLED: (process.env.RELAY_PRODUCTION_ENABLED || 'false').toLowerCase() === 'true',

  // Dual Discord role gate (hosted dev environment) — IDs only, never secrets.
  PROD_GUILD_ID: process.env.PROD_GUILD_ID || '',
  PROD_DEVELOPER_ROLE_ID: process.env.PROD_DEVELOPER_ROLE_ID || '',
  DEV_GUILD_ID: process.env.DEV_GUILD_ID || '',
  DEV_DEVELOPER_ROLE_ID: process.env.DEV_DEVELOPER_ROLE_ID || '',
  PROD_VERIFY_URL: process.env.PROD_VERIFY_URL || '',
  PROD_VERIFY_TOKEN: process.env.PROD_VERIFY_TOKEN || '',
  DEV_QA_ROLE_ID: process.env.DEV_QA_ROLE_ID || '',
  DISCORD_QA_REDIRECT_URI: process.env.DISCORD_QA_REDIRECT_URI || '',
  QA_ACTIVE_VERSION: process.env.QA_ACTIVE_VERSION || '',
  QA_BUILD_LOCK: process.env.QA_BUILD_LOCK === 'true',

  // GitHub ticketing
  GITHUB_PAT: process.env.GITHUB_PAT || '',
  GITHUB_OWNER: process.env.GITHUB_OWNER || 'UNN-Devotek',
  GITHUB_REPO: process.env.GITHUB_REPO || 'FCM-Fallout-Chat-Mod',
  GITHUB_PROJECT_NUMBER: parseInt(process.env.GITHUB_PROJECT_NUMBER || '5', 10),
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || '',
  DEVELOPER_ROLE_ID: process.env.DEVELOPER_ROLE_ID || '',
  MCP_REMOTE_ENABLED: process.env.MCP_REMOTE_ENABLED === 'true',
  MCP_ISSUER_URL: process.env.MCP_ISSUER_URL || 'https://falloutchatmod.com',
  MCP_RESOURCE_URL: process.env.MCP_RESOURCE_URL || 'https://falloutchatmod.com/mcp',
  MCP_ALLOWED_ORIGINS: (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  MCP_OAUTH_STATE_SECRET: process.env.MCP_OAUTH_STATE_SECRET || '',
  MCP_ACCESS_TOKEN_TTL_SECONDS: Math.min(900, Math.max(60, Number.parseInt(process.env.MCP_ACCESS_TOKEN_TTL_SECONDS || '600', 10) || 600)),
  MCP_REFRESH_TOKEN_TTL_SECONDS: Math.min(259200, Math.max(86400, Number.parseInt(process.env.MCP_REFRESH_TOKEN_TTL_SECONDS || '259200', 10) || 259200)),
  SUPPORT_ROLE_ID: process.env.SUPPORT_ROLE_ID || '',
  // Nexus OAuth 2.0 + PKCE (feature-flagged: disabled when creds are absent)
  NEXUS_OAUTH_CLIENT_ID: process.env.NEXUS_OAUTH_CLIENT_ID || '',
  NEXUS_OAUTH_CLIENT_SECRET: process.env.NEXUS_OAUTH_CLIENT_SECRET || '',
  // Empty means derive the callback from the forwarded request host. A
  // localhost default can send production users back to a developer machine.
  NEXUS_OAUTH_REDIRECT_URI: process.env.NEXUS_OAUTH_REDIRECT_URI || '',
  // Empty means derive from the forwarded request host. Steam requires the
  // realm to be an origin owned by this deployment.
  STEAM_OPENID_REALM: process.env.STEAM_OPENID_REALM || '',
  STEAM_OPENID_RETURN_URI: process.env.STEAM_OPENID_RETURN_URI || '',
  HUD_IDENTITY_HASH_SECRET: process.env.HUD_IDENTITY_HASH_SECRET || '',
};

/**
 * Pure predicate: collect the reasons the production startup guard would refuse to
 * boot the supporter tier (empty array = OK). Exported (and re-attached to
 * module.exports below) so the unit test asserts the REAL guard rather than a copy.
 *
 * The tier is a PAID product: production must explicitly declare the master switch.
 * An omitted or malformed switch otherwise parses as false and silently disables the
 * feature after a deployment platform regenerates `.env`. An explicit `false` remains
 * supported as a deliberate kill switch. When enabled, missing tier role IDs would let
 * Discord take a subscriber's money while resolveSupporterTier could never match a role
 * — the buyer pays and receives nothing, silently and indefinitely. Refuse to boot
 * instead. The shop URL is optional: when it is absent, the purchase CTA is omitted
 * while supporter cosmetics remain available.
 */
export function collectSupporterTierProductionErrors(opts: {
  nodeEnv: string;
  supporterTierEnabled: boolean;
  /** True only when SUPPORTER_TIER_ENABLED is an explicit `true` or `false`. */
  supporterTierEnabledConfigured: boolean;
  supporterRoleId: string | undefined | null;
  overseerCircleRoleId: string | undefined | null;
  /** Optional purchase CTA destination; it must never block supporter cosmetics. */
  discordServerShopUrl?: string | null;
}): string[] {
  if (opts.nodeEnv !== 'production') return [];
  const errors: string[] = [];
  if (!opts.supporterTierEnabledConfigured) errors.push('SUPPORTER_TIER_ENABLED');
  if (!opts.supporterTierEnabled) return errors;
  if (!opts.supporterRoleId) errors.push('SUPPORTER_ROLE_ID');
  if (!opts.overseerCircleRoleId) errors.push('OVERSEER_CIRCLE_ROLE_ID');
  return errors;
}

// Insecure/dev defaults the production MinIO guard rejects. Hoisted to single
// constants so the guard and any future drift-assertion test share one source of
// truth for the MinIO startup guard.
export const MINIO_DOCKER_DEFAULT_ENDPOINT = 'http://minio:9700';
export const DEV_DEFAULT_MINIO_ROOT_USER = 'fo76minio';
export const DEV_DEFAULT_MINIO_ROOT_PASSWORD = 'REDACTED';

/**
 * Pure predicate: collect the human-readable reasons the production startup guard
 * would refuse to boot for these MinIO vars (empty array = OK). Exported (and
 * re-attached to module.exports below) so the unit test asserts the REAL guard
 * rather than a re-implemented copy — a revert of any check then fails CI.
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
  if (env.MCP_REMOTE_ENABLED) {
    if (!process.env.MCP_ISSUER_URL) missing.push('MCP_ISSUER_URL');
    if (!process.env.MCP_RESOURCE_URL) missing.push('MCP_RESOURCE_URL');
    if (env.MCP_ALLOWED_ORIGINS.length === 0) missing.push('MCP_ALLOWED_ORIGINS');
    if (env.MCP_OAUTH_STATE_SECRET.length < 32) missing.push('MCP_OAUTH_STATE_SECRET (minimum 32 characters)');
    for (const [name, value] of [['MCP_ISSUER_URL', env.MCP_ISSUER_URL], ['MCP_RESOURCE_URL', env.MCP_RESOURCE_URL]] as const) {
      try { if (new URL(value).protocol !== 'https:') missing.push(`${name} (must be HTTPS)`); }
      catch { missing.push(`${name} (must be an absolute URL)`); }
    }
  }
  if (!env.REDIS_PASSWORD && !env.REDIS_URL) missing.push('REDIS_PASSWORD');
  missing.push(...collectMinioProductionErrors(env));
  missing.push(...collectSupporterTierProductionErrors({
    nodeEnv: env.NODE_ENV,
    supporterTierEnabled: env.SUPPORTER_TIER_ENABLED,
    supporterTierEnabledConfigured,
    supporterRoleId: env.SUPPORTER_ROLE_ID,
    overseerCircleRoleId: env.OVERSEER_CIRCLE_ROLE_ID,
    discordServerShopUrl: env.DISCORD_SERVER_SHOP_URL,
  }));
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
// `module.exports = env` makes require() return env directly (see consumers /
// tests). That clobbers esbuild's named CJS exports, so re-attach helpers.
(env as unknown as Record<string, unknown>).collectMinioProductionErrors = collectMinioProductionErrors;
(env as unknown as Record<string, unknown>).collectSupporterTierProductionErrors = collectSupporterTierProductionErrors;
module.exports = env;
