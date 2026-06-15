/**
 * PROD-side narrow developer-role verification endpoint.
 *
 *   GET /api/internal/verify-dev-role?discordId=<id>
 *
 * Spec: docs/deployment/hosted-dev-environment.md
 *       § "Developer authorization — dual Discord role gate".
 *
 * WHY THIS EXISTS: Discord's `guilds.members.read` OAuth scope requires the
 * calling app's bot to be present IN the guild. The DEV app's bot is NOT in the
 * PROD guild, so the dev backend cannot read a user's prod-guild roles directly.
 * The only viable prod-guild check is this endpoint on the PROD backend, which
 * uses the PROD bot (already a member of the prod guild) to look up the member
 * and returns ONLY a boolean. It never leaks roles, usernames, or any other
 * member data.
 *
 * This endpoint lives on PROD (unlike the dev-only sim routes) and is gated by a
 * shared service token (PROD_VERIFY_TOKEN), constant-time compared.
 */

import type { Request, Response, NextFunction } from 'express';
import env from '../config/environment';
import logger from '../config/logger';
import { constantTimeEquals } from '../utils/constantTimeEquals';

/**
 * Injectable boundary for the prod-bot member lookup so the controller is
 * unit-testable without network. Returns the role IDs the user holds in the
 * prod guild, or `null` if the member is not in the guild (NOT an error).
 * Throws only on a genuine fetch/transport failure.
 */
export interface ProdMemberRolesFetcher {
  (guildId: string, discordId: string): Promise<string[] | null>;
}

/**
 * Default fetcher — uses the PROD bot token via the Discord REST API:
 *
 *   GET /guilds/{guildId}/members/{userId}   (Authorization: Bot <DISCORD_TOKEN>)
 *
 * Mirrors roleVerificationService.verifyAdminUser. A 404 means the user is not
 * in the guild → resolves to `null` (hasDevRole:false), not an error.
 */
export const defaultProdMemberRolesFetcher: ProdMemberRolesFetcher = async (guildId, discordId) => {
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
    { headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` } },
  );
  if (res.status === 404) return null; // member not in guild
  if (!res.ok) {
    throw new Error(`Discord member lookup failed (HTTP ${res.status})`);
  }
  const member = (await res.json()) as { roles?: string[] };
  return Array.isArray(member.roles) ? member.roles : [];
};

/**
 * Build the GET /api/internal/verify-dev-role handler. The fetcher is injectable
 * for tests; production wiring passes `defaultProdMemberRolesFetcher`.
 */
export function makeVerifyDevRoleHandler(fetcher: ProdMemberRolesFetcher = defaultProdMemberRolesFetcher) {
  return async function verifyDevRole(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // ── Service-token auth (constant-time) ───────────────────────────────
      const expected = env.PROD_VERIFY_TOKEN;
      if (!expected) {
        // Not configured → fail closed. Do not leak which half is missing.
        res.status(403).type('application/problem+json').json({
          type: 'https://fo76chat.app/errors/403',
          title: 'Forbidden',
          status: 403,
          detail: 'Verification endpoint is not configured.',
        });
        return;
      }
      const header = req.headers.authorization || '';
      const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (!bearer || !constantTimeEquals(bearer, expected)) {
        res.status(403).type('application/problem+json').json({
          type: 'https://fo76chat.app/errors/403',
          title: 'Forbidden',
          status: 403,
          detail: 'Invalid or missing service token.',
        });
        return;
      }

      // ── Input ────────────────────────────────────────────────────────────
      const discordId = String(req.query.discordId || '').trim();
      if (!discordId || !/^\d{1,32}$/.test(discordId)) {
        res.status(400).type('application/problem+json').json({
          type: 'https://fo76chat.app/errors/400',
          title: 'Bad Request',
          status: 400,
          detail: 'A numeric `discordId` query parameter is required.',
        });
        return;
      }

      const guildId = env.PROD_GUILD_ID;
      const roleId = env.PROD_DEVELOPER_ROLE_ID;
      if (!guildId || !roleId) {
        res.status(403).type('application/problem+json').json({
          type: 'https://fo76chat.app/errors/403',
          title: 'Forbidden',
          status: 403,
          detail: 'Verification endpoint is not configured.',
        });
        return;
      }

      // ── Prod-bot lookup → boolean only ───────────────────────────────────
      let roles: string[] | null;
      try {
        roles = await fetcher(guildId, discordId);
      } catch (err) {
        logger.warn({ err }, '[verify-dev-role] prod member lookup failed');
        // Transport failure → 502 (do not pretend the user lacks the role).
        res.status(502).type('application/problem+json').json({
          type: 'https://fo76chat.app/errors/502',
          title: 'Bad Gateway',
          status: 502,
          detail: 'Failed to reach Discord to verify the role.',
        });
        return;
      }

      // member not in guild (null) → hasDevRole:false (not an error)
      const hasDevRole = Array.isArray(roles) && roles.includes(roleId);
      res.json({ data: { hasDevRole } });
    } catch (err) {
      next(err);
    }
  };
}

export default { makeVerifyDevRoleHandler, defaultProdMemberRolesFetcher };
module.exports = { makeVerifyDevRoleHandler, defaultProdMemberRolesFetcher };
