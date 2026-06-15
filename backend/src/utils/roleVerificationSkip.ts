/**
 * Dev-login personas (`/api/dev/login-as`) get a synthetic Discord ID of the form
 * `dev-<persona>-<hash>`. They are NOT real guild members, so the guild-membership
 * verifier (roleVerificationService) would revoke their admin role on every cycle —
 * making the local dev overlay drop privilege (and, when no game is running, hide +
 * disconnect its WebSocket).
 *
 * When dev-login is enabled (development only) the verifier skips these IDs. Prod
 * never sets ENABLE_DEV_LOGIN, so real admins are always verified.
 *
 * Standalone + dependency-free so it can be unit-tested without importing the full
 * service graph.
 */
export function shouldSkipRoleVerification(
  discordId: string,
  opts: { devLoginEnabled: boolean },
): boolean {
  return opts.devLoginEnabled && discordId.startsWith('dev-');
}
