import { beginRuntimeFetch as fetch } from '../runtime/nativeFetch';
import { runRequiredBundle, runRequiredCallback, runRequiredMutation } from '../lib/requiredEffects';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import env from '../config/environment';
import { getRedisClient } from '../config/redis';
import { McpOAuthError, MCP_SCOPES, mcpAuthorizationService } from '../services/mcpAuthorizationService';
import { matchesRegisteredRedirectUri, McpClientMetadataError, registerOAuthClient, resolveOAuthClient } from '../services/mcpClientMetadataService';
import { mcpRoleService } from '../services/mcpRoleService';
import logger from '../config/logger';
import { classifyMcpRoleDenial, noteMcpSecurityEvent, recordMcpMetric } from '../services/mcpAuditService';

const STATE_TTL = 300;
const headers = (res: Response) => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
const issuer = () => env.MCP_ISSUER_URL.replace(/\/$/, '');
const oauthError = (res: Response, status: number, error: string, description: string) => { recordMcpMetric('oauth', { outcome: 'failure' }); return res.status(status).json({ error, error_description: description }); };
const scalar = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
// Codex currently repeats the same resource indicator when both its local
// server configuration and protected-resource discovery provide it. OAuth
// resource indicators can be repeated, but this server authorizes one
// resource only: accept duplicate byte-identical values and reject conflicts.
const resourceIndicator = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string') || value.some(item => item !== value[0])) return undefined;
  return value[0];
};
const logContext = (req: Request, error: unknown) => ({ routeRequestId: scalar(req.headers['x-request-id']) || 'unavailable', errorType: error instanceof Error ? error.name : typeof error });
const sign = (payload: string) => createHmac('sha256', env.MCP_OAUTH_STATE_SECRET).update(payload).digest('base64url');
const seal = (value: object) => { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${sign(payload)}`; };
const unseal = <T>(value: string): T => {
  const split = value.lastIndexOf('.'); if (split < 1) throw new Error('OAuth state signature is invalid');
  const payload = value.slice(0, split), actual = Buffer.from(value.slice(split + 1)), expected = Buffer.from(sign(payload));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('OAuth state signature is invalid');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
};
function redirectOAuthError(res: Response, redirectUri: string, state: string | undefined, error: string, description: string) {
  recordMcpMetric('oauth', { outcome: 'failure' });
  const target = new URL(redirectUri); target.searchParams.set('error', error); target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state); res.redirect(target.href);
}

type Pending = { sessionId: string; clientId: string; redirectUri: string; resource: string; scopes: string[]; pkceChallenge: string; clientState?: string };

export function protectedResourceMetadata(_req: Request, res: Response) {
  res.json({ resource: env.MCP_RESOURCE_URL, authorization_servers: [issuer()], scopes_supported: MCP_SCOPES, bearer_methods_supported: ['header'] });
}

export function authorizationServerMetadata(_req: Request, res: Response) {
  res.json({ issuer: issuer(), authorization_endpoint: `${issuer()}/oauth/authorize`, token_endpoint: `${issuer()}/oauth/token`, revocation_endpoint: `${issuer()}/oauth/revoke`, registration_endpoint: `${issuer()}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: MCP_SCOPES, client_id_metadata_document_supported: true });
}

export async function register(req: Request, res: Response) {
  try { res.status(201).json(await registerOAuthClient(req.body)); }
  catch (error) {
    if (error instanceof McpClientMetadataError) oauthError(res, 400, 'invalid_client_metadata', error.message);
    else { logger.error({ ...logContext(req, error), route: 'oauth/register' }, 'OAuth DCR failed'); oauthError(res, 500, 'server_error', 'Client registration is temporarily unavailable'); }
  }
}

export async function authorize(req: Request, res: Response) {
  return runRequiredBundle('oauth', 'mcpOAuthController:84edfa109ee8', async () => {
  const clientId = scalar(req.query.client_id), redirectUri = scalar(req.query.redirect_uri), resource = resourceIndicator(req.query.resource);
  const challenge = scalar(req.query.code_challenge), method = scalar(req.query.code_challenge_method), responseType = scalar(req.query.response_type);
  let trustedRedirect: string | undefined; let clientState: string | undefined;
  try {
    if (!env.MCP_REMOTE_ENABLED || env.NODE_ENV !== 'production') throw new McpClientMetadataError('Remote MCP is unavailable');
    // Establish redirect trust before validating anything that is safe to
    // report through that redirect. A missing/unknown client or non-exact URI
    // always receives a local JSON error and never a redirect.
    if (!clientId || !redirectUri) throw new McpClientMetadataError('client_id and redirect_uri are required');
    const client = await resolveOAuthClient(clientId);
    if (!matchesRegisteredRedirectUri(client.redirectUris, redirectUri)) throw new McpClientMetadataError('redirect_uri is not registered exactly');
    trustedRedirect = redirectUri; clientState = scalar(req.query.state);
    if (!responseType) { redirectOAuthError(res, trustedRedirect, clientState, 'invalid_request', 'response_type is required'); return; }
    if (responseType !== 'code') { redirectOAuthError(res, trustedRedirect, clientState, 'unsupported_response_type', 'Only code response_type is supported'); return; }
    if (!resource) { redirectOAuthError(res, trustedRedirect, clientState, 'invalid_request', 'resource is required'); return; }
    try {
      if (new URL(resource).href !== new URL(env.MCP_RESOURCE_URL).href) { redirectOAuthError(res, trustedRedirect, clientState, 'invalid_target', 'resource is not allowed'); return; }
    } catch { redirectOAuthError(res, trustedRedirect, clientState, 'invalid_target', 'resource is invalid'); return; }
    if (method !== 'S256') { redirectOAuthError(res, trustedRedirect, clientState, 'invalid_request', 'code_challenge_method must be S256'); return; }
    if (!challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) { redirectOAuthError(res, trustedRedirect, clientState, 'invalid_request', 'code_challenge is invalid'); return; }
    const requested = (scalar(req.query.scope) || 'fcm:read').split(/\s+/).filter(Boolean);
    if (!requested.length || requested.some(scope => !(MCP_SCOPES as readonly string[]).includes(scope))) { redirectOAuthError(res, trustedRedirect, clientState, 'invalid_scope', 'Requested scope is invalid'); return; }
    const state = randomBytes(32).toString('base64url');
    const pending: Pending = { sessionId: req.sessionID, clientId, redirectUri, resource, scopes: requested, pkceChallenge: challenge, ...(clientState ? { clientState } : {}) };
    const redis = await getRedisClient();
    await runRequiredMutation('oauth', 'd9ab18c117deefc827dc72c7', { stage: 'primary-write-unconfirmed' }, () => redis.set(`mcp_oauth_state:${state}`, seal(pending), { EX: STATE_TTL }), undefined, undefined, undefined);
    (req.session as unknown as Record<string, unknown>).mcpOAuthState = state;
    await runRequiredCallback('oauth:browser-session-save',
      { stage: 'oauth-browser-session-save-unconfirmed' }, done => req.session.save(done));
    const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: `${issuer()}/oauth/discord/callback`, response_type: 'code', scope: 'identify guilds.members.read', state });
    recordMcpMetric('oauth', { outcome: 'success' });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  } catch (error) {
    const known = error instanceof McpClientMetadataError; const message = known ? error.message : 'Authorization is temporarily unavailable';
    if (!known) logger.error({ ...logContext(req, error), route: 'oauth/authorize' }, 'OAuth authorization failed');
    if (trustedRedirect) redirectOAuthError(res, trustedRedirect, clientState, known ? 'invalid_request' : 'server_error', message);
    else oauthError(res, known ? 400 : 500, known ? 'invalid_request' : 'server_error', message);
  }

  });
}

export async function discordCallback(req: Request, res: Response) {
  return runRequiredBundle('oauth', 'mcpOAuthController:ab64d98b690b', async () => {
  headers(res);
  const code = scalar(req.query.code), state = scalar(req.query.state), providerError = scalar(req.query.error);
  if (!state || (!code && !providerError)) { oauthError(res, 400, 'invalid_request', 'Missing Discord result or state'); return; }
  let pending: Pending | undefined;
  try {
    const redis = await getRedisClient();
    const raw = await runRequiredMutation('oauth', 'de9562b8500eb696216d33b2', { stage: 'primary-write-unconfirmed' }, () => redis.getDel(`mcp_oauth_state:${state}`), undefined, undefined, reply => reply === null);
    if (!raw) throw new Error('State is invalid, expired, or already used');
    pending = unseal<Pending>(raw);
    if (pending.sessionId !== req.sessionID || (req.session as unknown as Record<string, unknown>).mcpOAuthState !== state) throw new Error('State is not bound to this browser session');
    if (providerError) { redirectOAuthError(res, pending.redirectUri, pending.clientState, 'access_denied', 'Discord authorization was denied'); return; }
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: code!, redirect_uri: `${issuer()}/oauth/discord/callback` }) });
    const token = await tokenResponse.json() as { access_token?: unknown };
    if (!tokenResponse.ok || typeof token.access_token !== 'string') throw new Error('Discord authorization failed');
    const identityResponse = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    const identity = await identityResponse.json() as { id?: unknown };
    if (!identityResponse.ok || typeof identity.id !== 'string' || !/^\d{15,22}$/.test(identity.id)) throw new Error('Discord identity could not be verified');
    const role = await mcpRoleService.authorize(identity.id);
    if (!role.authorized) { recordMcpMetric('role_denial', { reason: classifyMcpRoleDenial(role.reason) }); noteMcpSecurityEvent('role_gate_failure'); redirectOAuthError(res, pending.redirectUri, pending.clientState, 'access_denied', 'This Discord account is not authorized for FCM MCP'); return; }
    const consent = randomBytes(32).toString('base64url');
    await runRequiredMutation('oauth', 'c9b04350f6ae665246c7f052', { stage: 'primary-write-unconfirmed' }, () => redis.set(`mcp_oauth_consent:${consent}`, seal({ ...pending, discordId: identity.id }), { EX: STATE_TTL }), undefined, undefined, undefined);
    const client = await resolveOAuthClient(pending.clientId); const metadata = client.metadata as { client_name?: string };
    const name = escapeHtml(metadata.client_name || pending.clientId);
    const scopeFields = pending.scopes.map(scope => `<li>${escapeHtml(scope)}</li>`).join('');
    recordMcpMetric('oauth', { outcome: 'success' });
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Authorize FCM MCP</title></head><body><main><h1>Authorize ${name}</h1><p>Signed in as an authorized ${role.role}.</p><ul>${scopeFields}</ul><form method="post" action="/oauth/authorize/consent"><input type="hidden" name="consent_token" value="${consent}"><input type="hidden" name="decision" value="approve"><input type="submit" value="Authorize"></form><form method="post" action="/oauth/authorize/consent"><input type="hidden" name="consent_token" value="${consent}"><input type="hidden" name="decision" value="deny"><input type="submit" value="Deny"></form></main></body></html>`);
  } catch (error) {
    const message = 'Authorization is temporarily unavailable'; logger.error({ ...logContext(req, error), route: 'oauth/discord/callback' }, 'Discord OAuth callback failed');
    if (pending) redirectOAuthError(res, pending.redirectUri, pending.clientState, 'access_denied', message);
    else oauthError(res, 403, 'access_denied', message);
  }

  });
}

export async function consent(req: Request, res: Response) {
  return runRequiredBundle('oauth', 'mcpOAuthController:3197d3f679bc', async () => {
  headers(res);
  let pending: (Pending & { discordId: string }) | undefined;
  try {
    const consentToken = scalar(req.body.consent_token);
    if (!consentToken) throw new Error('Consent token is required');
    const redis = await getRedisClient(); const raw = await redis.get(`mcp_oauth_consent:${consentToken}`);
    if (!raw) throw new McpOAuthError('invalid_grant', 'Consent is invalid or expired');
    pending = unseal<Pending & { discordId: string }>(raw);
    if (pending.sessionId !== req.sessionID) throw new Error('Consent is not bound to this browser session');
    const decision = scalar(req.body.decision);
    if (decision !== 'approve' && decision !== 'deny') throw new McpOAuthError('invalid_grant', 'Consent decision is invalid');
    const decisionKey = `mcp_oauth_consent_decision:${consentToken}`;
    const claimed = await runRequiredMutation('oauth', '6e146f7574fbf3ab28f39f26', { stage: 'primary-write-unconfirmed' }, () => redis.set(decisionKey, decision, { EX: STATE_TTL, NX: true }), undefined, undefined, reply => reply === null);
    if (!claimed && await redis.get(decisionKey) !== decision) throw new McpOAuthError('invalid_grant', 'Consent decision is already final');
    const target = new URL(pending.redirectUri);
    if (decision !== 'approve') { target.searchParams.set('error', 'access_denied'); recordMcpMetric('oauth', { outcome: 'failure' }); }
    else {
      const grant = await mcpAuthorizationService.issueAuthorizationCode({ clientId: pending.clientId, discordId: pending.discordId, redirectUri: pending.redirectUri, resource: pending.resource, pkceChallenge: pending.pkceChallenge, codeChallengeMethod: 'S256', scopes: pending.scopes, consentIdempotencyKey: consentToken });
      target.searchParams.set('code', grant.code);
      recordMcpMetric('oauth', { outcome: 'success' });
    }
    if (pending.clientState) target.searchParams.set('state', pending.clientState);
    res.redirect(target.href);
  } catch (error) {
    const known = error instanceof McpOAuthError; const message = known ? error.message : 'Consent is temporarily unavailable';
    if (!known) logger.error({ ...logContext(req, error), route: 'oauth/authorize/consent' }, 'OAuth consent failed');
    if (pending) redirectOAuthError(res, pending.redirectUri, pending.clientState, known ? 'invalid_request' : 'server_error', message);
    else oauthError(res, known ? 400 : 500, known ? 'invalid_request' : 'server_error', message);
  }

  });
}

export async function token(req: Request, res: Response) {
  headers(res);
  try {
    const grantType = scalar(req.body.grant_type), clientId = scalar(req.body.client_id), resource = scalar(req.body.resource);
    if (!clientId || !resource) throw new McpOAuthError('invalid_client', 'client_id and resource are required');
    const result = grantType === 'authorization_code'
      ? await mcpAuthorizationService.exchangeAuthorizationCode({ code: scalar(req.body.code) || '', clientId, redirectUri: scalar(req.body.redirect_uri) || '', resource, codeVerifier: scalar(req.body.code_verifier) || '' })
      : grantType === 'refresh_token'
        ? await mcpAuthorizationService.refresh({ refreshToken: scalar(req.body.refresh_token) || '', clientId, resource, scopes: scalar(req.body.scope)?.split(/\s+/) })
        : (() => { throw new Error('unsupported_grant_type'); })();
    recordMcpMetric('oauth', { outcome: 'success' });
    res.json({ access_token: result.accessToken, refresh_token: result.refreshToken, token_type: result.tokenType, expires_in: result.expiresIn, scope: result.scopes.join(' ') });
  } catch (error) {
    const unsupported = error instanceof Error && error.message === 'unsupported_grant_type';
    if (!unsupported && !(error instanceof McpOAuthError)) { logger.error({ ...logContext(req, error), route: 'oauth/token' }, 'OAuth token exchange failed'); oauthError(res, 500, 'server_error', 'Token service is temporarily unavailable'); return; }
    oauthError(res, error instanceof McpOAuthError && error.code === 'invalid_client' ? 401 : 400, unsupported ? 'unsupported_grant_type' : (error as McpOAuthError).code, unsupported ? 'grant_type is unsupported' : (error as McpOAuthError).message);
  }
}

export async function revoke(req: Request, res: Response) {
  headers(res); const value = scalar(req.body.token);
  try { if (value) await mcpAuthorizationService.revokeToken(value); res.status(200).send(); }
  catch (error) { logger.error({ ...logContext(req, error), route: 'oauth/revoke' }, 'OAuth revocation failed'); oauthError(res, 503, 'temporarily_unavailable', 'Revocation is temporarily unavailable'); }
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
