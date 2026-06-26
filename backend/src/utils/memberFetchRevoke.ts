/**
 * Decide whether a NON-OK Discord guild-member fetch is a definitive signal that
 * an admin/mod genuinely lost access (and should be revoked from admin_users).
 *
 * Only a 404 means "this user is not a member of the guild" — that is the single
 * status safe to revoke on. Every other non-OK status is non-definitive:
 *   - 429: Discord rate-limit (the verification cycle hits the API once per admin,
 *          so a burst of admins easily trips this)
 *   - 5xx: Discord outage / gateway error
 *   - 401/403: bot token / permission problem — a bot-side issue, not the user's
 *
 * Revoking on those previously wiped valid moderators/admins during a transient
 * Discord blip (and, because logins were also failing, they couldn't re-add
 * themselves). They must be treated as "skip and retry next cycle" instead.
 */
export function shouldRevokeOnMemberFetchStatus(status: number): boolean {
  return status === 404;
}

export default { shouldRevokeOnMemberFetchStatus };
module.exports = { shouldRevokeOnMemberFetchStatus };
