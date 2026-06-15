import crypto from 'crypto';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import logger from '../config/logger';

const TOKEN_PREFIX = 'fcm_mcp_';
const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 90;

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateRawToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

const MAX_ACTIVE_TOKENS_PER_USER = 10;

/**
 * Mint a new MCP token for a user.
 * Returns the plaintext token ONCE — only the hash is stored.
 * Rejects with 422 if the user already has MAX_ACTIVE_TOKENS_PER_USER active tokens.
 */
async function mintToken(
  ownerId: string,
  env: 'dev' | 'prod',
  label?: string,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  // Per-user token cap — count active (non-revoked, non-expired) tokens
  const activeCount = await prisma.mcpApiKey.count({
    where: {
      ownerId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
    const err: any = new Error(
      `Token cap reached: you may have at most ${MAX_ACTIVE_TOKENS_PER_USER} active tokens. ` +
      'Revoke an existing token before minting a new one.',
    );
    err.status = 422;
    err.type = 'https://fo76chat.app/errors/token-cap-exceeded';
    throw err;
  }

  const raw = generateRawToken();
  const keyHash = sha256(raw);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400 * 1000);

  const row = await prisma.mcpApiKey.create({
    data: { keyHash, ownerId, env, label: label ?? null, expiresAt },
    select: { id: true, expiresAt: true },
  });

  return { id: row.id, token: raw, expiresAt: row.expiresAt };
}

/**
 * List all non-revoked tokens for a user — metadata only, no hashes.
 */
async function listTokensForUser(ownerId: string) {
  return prisma.mcpApiKey.findMany({
    where: { ownerId, revokedAt: null },
    select: { id: true, label: true, env: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Revoke a token by ID, enforcing ownership.
 */
async function revokeToken(ownerId: string, id: string): Promise<void> {
  const row = await prisma.mcpApiKey.findUnique({
    where: { id },
    select: { id: true, ownerId: true, revokedAt: true, expiresAt: true, env: true },
  });

  if (!row) {
    throw createError(404, 'Token not found');
  }
  if (row.ownerId !== ownerId) {
    throw createError(403, 'Forbidden');
  }

  await prisma.mcpApiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  logger.info({ tokenId: id, ownerId }, 'MCP token revoked');
}

/**
 * Verify a plaintext MCP token for the given env.
 * Returns the DB row (with ownerId) on success, null on failure.
 * Updates lastUsedAt on success (best-effort, non-blocking).
 */
async function verifyToken(
  raw: string,
  env: 'dev' | 'prod',
): Promise<{ id: string; ownerId: string; env: string } | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const keyHash = sha256(raw);
  const row = await prisma.mcpApiKey.findUnique({
    where: { keyHash },
    select: { id: true, ownerId: true, env: true, revokedAt: true, expiresAt: true },
  });

  if (!row) return null;
  if (row.env !== env) return null;
  if (row.revokedAt !== null) return null;
  if (new Date(row.expiresAt) < new Date()) return null;

  // Update lastUsedAt non-blocking
  prisma.mcpApiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => logger.warn({ err, tokenId: row.id }, 'Failed to update lastUsedAt'));

  return { id: row.id, ownerId: row.ownerId, env: row.env };
}

export { mintToken, listTokensForUser, revokeToken, verifyToken };
module.exports = { mintToken, listTokensForUser, revokeToken, verifyToken };
