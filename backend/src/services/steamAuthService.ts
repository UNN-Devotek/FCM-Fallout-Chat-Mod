/**
 * Steam OpenID helpers.
 *
 * Steam's browser flow is OpenID 2.0 rather than OAuth: the browser is sent to
 * Steam, then Steam posts an assertion back to our callback. The callback must
 * validate that assertion server-side before treating the returned SteamID64 as
 * an authenticated identity.
 */

export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const STEAM_IDENTITY_PREFIX = 'https://steamcommunity.com/openid/id/';

export function isValidSteamId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17}$/.test(value);
}

/** Extract a SteamID64 only from Steam's canonical identity URL. */
export function extractSteamId(identity: unknown): string | null {
  if (typeof identity !== 'string' || !identity.startsWith(STEAM_IDENTITY_PREFIX)) return null;
  const id = identity.slice(STEAM_IDENTITY_PREFIX.length);
  return isValidSteamId(id) ? id : null;
}

export function buildSteamOpenIdUrl(opts: { returnTo: string; realm: string }): string {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': opts.returnTo,
    'openid.realm': opts.realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

/**
 * Ask Steam to validate the complete callback assertion. Only OpenID fields are
 * copied into the request; no caller-controlled URL is ever fetched.
 */
export async function validateSteamAssertion(
  assertion: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(assertion)) {
    if (key.startsWith('openid.')) params.set(key, value);
  }
  params.set('openid.mode', 'check_authentication');

  const response = await fetchImpl(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!response.ok) return false;
  const body = await response.text();
  return /^is_valid\s*:\s*true\s*$/im.test(body);
}
