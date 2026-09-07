import { isValidSteamId } from './steamAuthService';
import { sanitizeChatName } from '../utils/chatName';

/** OpenID proves the ID; only Steam's server response supplies the profile name. */
export async function fetchSteamDisplayName(
  steamId: string,
  apiKey = process.env.STEAM_WEB_API_KEY || '',
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!isValidSteamId(steamId) || !apiKey) return null;
  try {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('steamids', steamId);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) return null;
    const data = await response.json() as { response?: { players?: { steamid?: unknown; personaname?: unknown }[] } };
    if (!Array.isArray(data?.response?.players)) return null;
    const player = data.response.players.find(p => p?.steamid === steamId);
    if (typeof player?.personaname !== 'string') return null;
    const name = sanitizeChatName(player.personaname).slice(0, 128).trim();
    return name || null;
  } catch {
    // Profile outages must not invalidate a verified login. Never log key-bearing URLs.
    return null;
  }
}
