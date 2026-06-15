import { createHash } from 'crypto';

/**
 * Stable, install-scoped fake Discord ID for a dev persona (used by the
 * development-only `/api/dev/login-as` endpoint).
 *
 * Bug this fixes: the endpoint upserts the user row by `installToken`, but the
 * persona's Discord ID used to be a FIXED per-persona string (`dev-user-001`,
 * `dev-owner-006`, …). When two local installs (e.g. the dev overlay + a test
 * script, each with its own installToken) adopted the SAME persona, both tried
 * to claim that one Discord ID, hitting the `discord_id_link` unique constraint
 * and returning a 500 ("Dev login failed").
 *
 * Deriving the ID from BOTH the persona and the installToken keeps it unique per
 * install (no collision) while the persona still drives the granted role (the
 * adminUser upsert is keyed on this same ID). Deterministic — repeat calls for
 * the same (persona, install) yield the same ID, so the upsert stays idempotent.
 */
export function devPersonaDiscordId(persona: string, installToken: string): string {
  const suffix = createHash('sha1').update(installToken).digest('hex').slice(0, 16);
  return `dev-${persona}-${suffix}`;
}

/**
 * Install-scoped username for a dev persona.
 *
 * `User.username` is ALSO `@unique`, so — like the Discord ID above — two installs
 * adopting the same persona collided on the persona's fixed display name
 * ("System Owner", …) → 500. Append a short install-derived suffix so the row is
 * unique per install. The clean, un-suffixed persona name is still used for the
 * user-facing display name (`discordDisplayName` / the login-as response), so
 * this only affects the internal canonical `username` column.
 */
export function devPersonaUsername(baseName: string, installToken: string): string {
  const suffix = createHash('sha1').update(installToken).digest('hex').slice(0, 6);
  return `${baseName} ${suffix}`;
}
