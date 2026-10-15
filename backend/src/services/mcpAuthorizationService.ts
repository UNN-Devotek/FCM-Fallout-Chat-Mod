import { bindRequiredTransactionClient, isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation, runRequiredTransaction } from '../lib/requiredEffects';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import env from '../config/environment';
import { matchesRegisteredRedirectUri } from './mcpClientMetadataService';
import prisma from '../config/prisma';
import { McpRoleService, McpStaffRole, mcpRoleService } from './mcpRoleService';
import { classifyMcpRoleDenial, noteMcpSecurityEvent, recordMcpMetric } from './mcpAuditService';

export const MCP_SCOPES = ['fcm:read', 'fcm:discord:write', 'fcm:moderation:write'] as const;
export type McpScope = typeof MCP_SCOPES[number];

export class McpOAuthError extends Error {
  constructor(public readonly code: 'invalid_grant' | 'invalid_client' | 'invalid_scope' | 'invalid_token' | 'access_denied', message: string) {
    super(message);
  }
}

type PrismaLike = typeof prisma;
interface Options {
  prisma?: PrismaLike;
  roleService?: Pick<McpRoleService, 'authorize'>;
  now?: () => Date;
  enabled?: () => boolean;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}

export interface IssueCodeInput {
  clientId: string; discordId: string; redirectUri: string; resource: string;
  pkceChallenge: string; codeChallengeMethod: string; scopes: readonly string[]; ttlSeconds?: number;
  consentIdempotencyKey?: string;
}
export interface ExchangeCodeInput { code: string; clientId: string; redirectUri: string; resource: string; codeVerifier: string; }
export interface RefreshInput { refreshToken: string; clientId: string; resource: string; scopes?: readonly string[]; }

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const opaque = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;
const authorizationCodeForConsent = (consentIdempotencyKey: string): string =>
  `fcm_code_${createHmac('sha256', env.MCP_OAUTH_STATE_SECRET).update(`authorization-code:${consentIdempotencyKey}`).digest('base64url')}`;
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const CONSENT_VALUE = /^[A-Za-z0-9_-]{43}$/;
const normalizeScopes = (scopes: readonly string[]): McpScope[] => [...new Set(scopes)].sort().map((scope) => {
  if (!(MCP_SCOPES as readonly string[]).includes(scope)) throw new McpOAuthError('invalid_scope', `Unsupported scope: ${scope}`);
  return scope as McpScope;
});
const permittedFor = (role: McpStaffRole): readonly McpScope[] => role === 'developer'
  ? ['fcm:read', 'fcm:discord:write'] : MCP_SCOPES;

export function pkceS256(verifier: string): string { return createHash('sha256').update(verifier).digest('base64url'); }

export class McpAuthorizationService {
  private readonly db: PrismaLike;
  private readonly roles: Pick<McpRoleService, 'authorize'>;
  private readonly now: () => Date;
  private readonly enabled: () => boolean;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(options: Options = {}) {
    this.db = options.prisma ?? prisma;
    this.roles = options.roleService ?? mcpRoleService;
    this.now = options.now ?? (() => new Date());
    this.enabled = options.enabled ?? (() => env.NODE_ENV === 'production' && env.MCP_REMOTE_ENABLED);
    this.accessTtl = Math.min(900, Math.max(60, options.accessTtlSeconds ?? env.MCP_ACCESS_TOKEN_TTL_SECONDS));
    this.refreshTtl = Math.min(259_200, Math.max(86_400, options.refreshTtlSeconds ?? env.MCP_REFRESH_TOKEN_TTL_SECONDS));
  }

  async issueAuthorizationCode(input: IssueCodeInput): Promise<{ code: string; expiresAt: Date }> {
  return runRequiredBundle('oauth', 'mcpAuthorizationService:92d6f6c0185d', async () => {
    this.assertEnabled();
    this.assertResource(input.resource);
    if (input.codeChallengeMethod !== 'S256' || !input.pkceChallenge || !PKCE_VALUE.test(input.pkceChallenge)) {
      throw new McpOAuthError('invalid_grant', 'PKCE S256 challenge is required');
    }
    const client = await this.db.mcpOAuthClient.findUnique({ where: { clientId: input.clientId } });
    if (!client || client.disabledAt || !matchesRegisteredRedirectUri(client.redirectUris, input.redirectUri)) throw new McpOAuthError('invalid_client', 'Client or redirect URI is invalid');
    const role = await this.requireRole(input.discordId);
    const scopes = this.authorizeScopes(role, input.scopes);
    if (input.consentIdempotencyKey !== undefined && !CONSENT_VALUE.test(input.consentIdempotencyKey)) {
      throw new McpOAuthError('invalid_grant', 'Consent idempotency key is invalid');
    }
    const code = input.consentIdempotencyKey
      ? authorizationCodeForConsent(input.consentIdempotencyKey)
      : opaque('fcm_code_');
    const expiresAt = new Date(this.now().getTime() + Math.min(600, Math.max(1, input.ttlSeconds ?? 300)) * 1000);
    const data = {
      codeHash: hash(code), clientId: input.clientId, discordId: input.discordId,
      redirectUri: input.redirectUri, pkceChallenge: input.pkceChallenge, codeChallengeMethod: 'S256',
      resource: input.resource, scopes, expiresAt,
    };
    if (!input.consentIdempotencyKey) {
      await runRequiredMutation('oauth', 'ae78c9ed58ed2a8d98b0cdc1', { stage: 'primary-write-unconfirmed' }, () => this.db.mcpOAuthCode.create({ data }), isPrismaAtomicRefusal, undefined, undefined);
      return { code, expiresAt };
    }
    const stored = await runRequiredMutation('oauth', 'f6be64664258081887f449c1', { stage: 'primary-write-unconfirmed' }, () => this.db.mcpOAuthCode.upsert({
      where: { codeHash: data.codeHash },
      create: data,
      update: {},
      select: { clientId: true, discordId: true, redirectUri: true, pkceChallenge: true, codeChallengeMethod: true, resource: true, scopes: true, expiresAt: true },
    }), isPrismaAtomicRefusal, undefined, undefined);
    const sameBinding = stored.clientId === data.clientId && stored.discordId === data.discordId
      && stored.redirectUri === data.redirectUri && stored.pkceChallenge === data.pkceChallenge
      && stored.codeChallengeMethod === data.codeChallengeMethod && stored.resource === data.resource
      && stored.scopes.length === data.scopes.length && stored.scopes.every((scope, index) => scope === data.scopes[index]);
    if (!sameBinding) throw new McpOAuthError('invalid_grant', 'Consent replay binding is invalid');
    return { code, expiresAt: stored.expiresAt };

  }, error => error instanceof McpOAuthError);
}

  async exchangeAuthorizationCode(input: ExchangeCodeInput) {
  return runRequiredBundle('oauth', 'mcpAuthorizationService:720e043a6cfc', async () => {
    this.assertEnabled();
    this.assertResource(input.resource);
    if (!PKCE_VALUE.test(input.codeVerifier)) throw new McpOAuthError('invalid_grant', 'PKCE verifier is invalid');
    const codeHash = hash(input.code);
    const now = this.now();
    const code = await this.db.mcpOAuthCode.findUnique({ where: { codeHash } });
    if (!code) throw new McpOAuthError('invalid_grant', 'Authorization code is unavailable');
    await this.requireActiveClient(code.clientId);
    const role = await this.requireRole(code.discordId);
    this.authorizeScopes(role, code.scopes);
    return runRequiredTransaction('oauth', '8d8023fe54324c84e3813b85', { stage: 'transaction-completion-unconfirmed' }, () => this.db.$transaction(async (tx) => {
      bindRequiredTransactionClient(tx);
      const consumed = await runRequiredMutation('oauth', 'ad3670ca33c492a1134c3db5', { stage: 'primary-write-unconfirmed' }, () => tx.mcpOAuthCode.updateMany({
        where: { codeHash, consumedAt: null, expiresAt: { gt: now }, clientId: input.clientId,
          redirectUri: input.redirectUri, resource: input.resource, codeChallengeMethod: 'S256',
          pkceChallenge: pkceS256(input.codeVerifier) }, data: { consumedAt: now },
      }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
      if (consumed.count !== 1) throw new McpOAuthError('invalid_grant', 'Authorization code is invalid, expired, consumed, or incorrectly bound');
      return this.createGrant(code.discordId, code.clientId, code.resource, code.scopes, tx as PrismaLike);
    }), { confirmedRollback: error => isPrismaAtomicRefusal(error) || error instanceof McpOAuthError && error.code === 'invalid_grant' });

  }, error => error instanceof McpOAuthError);
}

  async refresh(input: RefreshInput) {
    try { return await this.refreshInternal(input); }
    catch (error) { recordMcpMetric('refresh', { outcome: 'failure' }); throw error; }
  }

  private async refreshInternal(input: RefreshInput) {
  return runRequiredBundle('oauth', 'mcpAuthorizationService:b342ffe7a17b', async () => {
    this.assertEnabled();
    this.assertResource(input.resource);
    const refreshHash = hash(input.refreshToken);
    const now = this.now();
    const grant = await this.db.mcpOAuthGrant.findFirst({ where: { OR: [
      { refreshTokenHash: refreshHash }, { usedRefreshTokenHashes: { has: refreshHash } },
    ] } });
    if (!grant || grant.clientId !== input.clientId || grant.audience !== input.resource) throw new McpOAuthError('invalid_grant', 'Refresh token binding is invalid');
    if (grant.usedRefreshTokenHashes.includes(refreshHash)) {
      await runRequiredMutation('oauth', 'd4e5fc3230d33e8cb23272df', { stage: 'primary-write-unconfirmed' }, () => this.db.mcpOAuthGrant.updateMany({ where: { familyId: grant.familyId, revokedAt: null }, data: { revokedAt: now } }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
      recordMcpMetric('refresh', { outcome: 'reuse' });
      noteMcpSecurityEvent('refresh_reuse');
      throw new McpOAuthError('invalid_grant', 'Refresh token reuse detected; token family revoked');
    }
    if (grant.revokedAt) throw new McpOAuthError('invalid_grant', 'Refresh token is expired or revoked');
    if (grant.refreshTokenExpiresAt <= now) {
      await this.bestEffortRevokeFamily(grant.familyId);
      throw new McpOAuthError('invalid_grant', 'Refresh token is expired or revoked');
    }
    let role: McpStaffRole;
    try {
      await this.requireActiveClient(grant.clientId);
      role = await this.requireRole(grant.discordId);
    } catch {
      await this.bestEffortRevokeFamily(grant.familyId);
      // Do not disclose whether the identity, role, ban, or client caused the
      // denial; refresh-token errors are intentionally non-enumerating.
      throw new McpOAuthError('invalid_grant', 'Refresh token is invalid');
    }
    // Validate the grant as issued before considering a caller-requested
    // narrowing. Otherwise an admin grant could survive an admin→developer
    // downgrade merely by requesting only its read subset during refresh.
    if (grant.scopes.some((scope) => !permittedFor(role).includes(scope as McpScope))) {
      await this.bestEffortRevokeFamily(grant.familyId);
      throw new McpOAuthError('invalid_grant', 'Refresh token is invalid');
    }
    const requested = normalizeScopes(input.scopes ?? grant.scopes);
    if (requested.some((scope) => !grant.scopes.includes(scope))) throw new McpOAuthError('invalid_scope', 'Refresh cannot increase scope');
    this.authorizeScopes(role, requested);
    const accessToken = opaque('fcm_at_');
    const refreshToken = opaque('fcm_rt_');
    const accessTokenExpiresAt = new Date(Math.min(
      now.getTime() + this.accessTtl * 1000,
      grant.refreshTokenExpiresAt.getTime(),
    ));
    const expiresIn = Math.max(1, Math.ceil((accessTokenExpiresAt.getTime() - now.getTime()) / 1000));
    const updated = await runRequiredMutation('oauth', 'f2fa7b8449b56c55c7254dab', { stage: 'primary-write-unconfirmed', rowId: grant.id }, () => this.db.mcpOAuthGrant.updateMany({ where: { id: grant.id, refreshTokenHash: refreshHash, revokedAt: null }, data: {
      accessTokenHash: hash(accessToken), accessTokenExpiresAt,
      usedRefreshTokenHashes: [...grant.usedRefreshTokenHashes, refreshHash],
      refreshTokenHash: hash(refreshToken), scopes: requested, lastUsedAt: now,
    } }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    if (updated.count !== 1) {
      await runRequiredMutation('oauth', '05aaede62dcfe6bfd537a4aa', { stage: 'primary-write-unconfirmed' }, () => this.db.mcpOAuthGrant.updateMany({ where: { familyId: grant.familyId, revokedAt: null }, data: { revokedAt: now } }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
      recordMcpMetric('refresh', { outcome: 'reuse' });
      noteMcpSecurityEvent('refresh_reuse');
      throw new McpOAuthError('invalid_grant', 'Concurrent refresh reuse detected; token family revoked');
    }
    recordMcpMetric('refresh', { outcome: 'success' });
    return { accessToken, refreshToken, expiresIn, scopes: requested, tokenType: 'Bearer' as const };

  }, error => error instanceof McpOAuthError);
}

  async verifyAccessToken(token: string, audience: string, requiredScopes: readonly string[] = []) {
    this.assertEnabled();
    this.assertResource(audience);
    const now = this.now();
    const grant = await this.db.mcpOAuthGrant.findUnique({ where: { accessTokenHash: hash(token) } });
    if (!grant || grant.revokedAt || grant.accessTokenExpiresAt <= now || grant.audience !== audience) throw new McpOAuthError('invalid_token', 'Access token is invalid');
    if (grant.refreshTokenExpiresAt <= now) {
      await this.bestEffortRevokeFamily(grant.familyId);
      throw new McpOAuthError('invalid_token', 'Access token is invalid');
    }
    let role: McpStaffRole;
    try {
      await this.requireActiveClient(grant.clientId);
      role = await this.requireRole(grant.discordId);
    } catch {
      await this.bestEffortRevokeFamily(grant.familyId);
      // All post-lookup authorization failures collapse to invalid_token.
      throw new McpOAuthError('invalid_token', 'Access token is invalid');
    }
    const required = normalizeScopes(requiredScopes);
    if (required.some((scope) => !grant.scopes.includes(scope)) || grant.scopes.some((scope) => !permittedFor(role).includes(scope as McpScope))) {
      await this.bestEffortRevokeFamily(grant.familyId);
      throw new McpOAuthError('invalid_scope', 'Token scope is unavailable');
    }
    await this.db.mcpOAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: now } });
    return { discordId: grant.discordId, clientId: grant.clientId, scopes: grant.scopes as McpScope[], role, grantId: grant.id };
  }

  async revokeToken(token: string): Promise<void> {
    const tokenHash = hash(token);
    const grant = await this.db.mcpOAuthGrant.findFirst({ where: { OR: [
      { accessTokenHash: tokenHash }, { refreshTokenHash: tokenHash }, { usedRefreshTokenHashes: { has: tokenHash } },
    ] } });
    if (grant) await this.revokeFamily(grant.familyId);
  }

  private async createGrant(discordId: string, clientId: string, audience: string, scopes: readonly string[], db: PrismaLike = this.db) {
  return runRequiredBundle('oauth', 'mcpAuthorizationService:59d4a4c55a0d', async () => {
    const now = this.now();
    const accessToken = opaque('fcm_at_'); const refreshToken = opaque('fcm_rt_');
    const accessTokenExpiresAt = new Date(now.getTime() + this.accessTtl * 1000);
    const refreshTokenExpiresAt = new Date(now.getTime() + this.refreshTtl * 1000);
    await runRequiredMutation('oauth', '8198d6ce8d260a7b93f16441', { stage: 'primary-write-unconfirmed', discordId: discordId }, () => db.mcpOAuthGrant.create({ data: { familyId: randomUUID(), discordId, clientId, audience,
      scopes: [...scopes], accessTokenHash: hash(accessToken), accessTokenExpiresAt,
      refreshTokenHash: hash(refreshToken), refreshTokenExpiresAt } }), isPrismaAtomicRefusal, db, undefined);
    return { accessToken, refreshToken, expiresIn: this.accessTtl, scopes: [...scopes], tokenType: 'Bearer' as const };

  }, error => error instanceof McpOAuthError);
}

  private async requireActiveClient(clientId: string): Promise<void> {
    const client = await this.db.mcpOAuthClient.findUnique({ where: { clientId }, select: { disabledAt: true } });
    if (!client || client.disabledAt) throw new McpOAuthError('invalid_client', 'OAuth client is disabled');
  }
  private async requireRole(discordId: string): Promise<McpStaffRole> {
    const result = await this.roles.authorize(discordId);
    if (!result.authorized) {
      const reason = classifyMcpRoleDenial(result.reason);
      recordMcpMetric('role_denial', { reason });
      noteMcpSecurityEvent('role_gate_failure');
      throw new McpOAuthError('access_denied', `MCP access denied: ${result.reason}`);
    }
    return result.role;
  }
  private authorizeScopes(role: McpStaffRole, requested: readonly string[]): McpScope[] {
    const scopes = normalizeScopes(requested);
    if (scopes.some((scope) => !permittedFor(role).includes(scope))) throw new McpOAuthError('invalid_scope', 'Requested scope exceeds current role');
    return scopes;
  }
  private async revokeFamily(familyId: string): Promise<void> {
  return runRequiredBundle('oauth', 'mcpAuthorizationService:dfe22876e374', async () => {
    await runRequiredMutation('oauth', 'e964e5a5bfc2bd770b2dd6d5', { stage: 'primary-write-unconfirmed' }, () => this.db.mcpOAuthGrant.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: this.now() } }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);

  }, error => error instanceof McpOAuthError);
}
  private async bestEffortRevokeFamily(familyId: string): Promise<void> {
    try { await this.revokeFamily(familyId); } catch { /* preserve non-enumerating OAuth denial */ }
  }
  private assertEnabled(): void {
    if (!this.enabled()) throw new McpOAuthError('access_denied', 'Remote MCP is disabled');
  }
  private assertResource(resource: string): void {
    let actual: string; let expected: string;
    try { actual = new URL(resource).href; expected = new URL(env.MCP_RESOURCE_URL).href; }
    catch { throw new McpOAuthError('invalid_grant', 'Resource audience is invalid'); }
    if (actual !== expected) throw new McpOAuthError('invalid_grant', 'Resource audience is not allowed');
  }
}

export const mcpAuthorizationService = new McpAuthorizationService();
