import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import { parseInfobox } from './wikiParser';
import { apiGet as fandomApiGet } from '../lib/fandomApiClient';

// Fallout 76 entity lookup against the Fandom (Nukapedia) MediaWiki API.
//
// Spike findings (see docs/roadmap/fan-site-integrations.md):
//   - prop=extracts is empty for items/weapons/armor — the data lives in the infobox.
//   - prop=pageimages gives clean transparent renders (thumbnail + hi-res original).
//   - action=parse&prop=wikitext&section=0 returns the {{Infobox … FO76}} block, which we
//     parse into key→value pairs for a stat card.
//
// Content is CC-BY-SA 3.0 — callers MUST attribute "Fallout Wiki" + link the article.

const FETCH_TIMEOUT_MS = 8000;
const ENTITY_TTL_SEC = 86_400;   // 24h — wiki content changes slowly
const SEARCH_TTL_SEC = 3600;     // 1h
const THUMB_SIZE = 300;

export interface WikiSearchHit {
  title: string;
  url: string;
}

export interface WikiEntity {
  title: string;
  pageId: number;
  url: string;
  /** Infobox template name, e.g. "Infobox weapon FO76" → kind "weapon". */
  kind: string | null;
  /** Parsed infobox key→value pairs (cleaned of wiki markup). */
  infobox: Record<string, string>;
  thumbnail: { url: string; width: number; height: number } | null;
  original: { url: string; width: number; height: number } | null;
  fetchedAt: number;
}

// ── HTTP helper (delegated to shared fandomApiClient) ──────────────────────────

function apiGet(params: Record<string, string>): Promise<any | null> {
  return fandomApiGet(params, FETCH_TIMEOUT_MS) as Promise<any | null>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Typo-naive title search via opensearch. (Fuzzy/alias search is layered on top in P2.) */
export async function searchTitles(query: string, limit = 6): Promise<WikiSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const key = `fo76:wiki:search:${q.toLowerCase()}`;
  try {
    const redis = await getRedisClient();
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as WikiSearchHit[];
  } catch { /* best-effort */ }

  const json = await apiGet({ action: 'opensearch', search: q, limit: String(limit) });
  if (!Array.isArray(json) || !Array.isArray(json[1])) return [];
  const titles: string[] = json[1];
  const urls: string[] = Array.isArray(json[3]) ? json[3] : [];
  const hits: WikiSearchHit[] = titles.map((title, i) => ({ title, url: urls[i] ?? '' }));

  try {
    const redis = await getRedisClient();
    await redis.set(key, JSON.stringify(hits), { EX: SEARCH_TTL_SEC });
  } catch { /* best-effort */ }
  return hits;
}

/** Fetch a single entity: image(s) + parsed infobox. Cached 24h. */
export async function getEntity(title: string): Promise<WikiEntity | null> {
  const t = title.trim();
  if (!t) return null;
  const key = `fo76:wiki:entity:${t.toLowerCase()}`;
  try {
    const redis = await getRedisClient();
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as WikiEntity;
  } catch { /* best-effort */ }

  // 1) images + canonical title/pageid (redirects resolved)
  const meta = await apiGet({
    action: 'query',
    prop: 'pageimages|info',
    inprop: 'url',
    piprop: 'thumbnail|original',
    pithumbsize: String(THUMB_SIZE),
    redirects: '1',
    titles: t,
  });
  const page: any = meta?.query?.pages ? Object.values(meta.query.pages)[0] : null;
  if (!page || page.missing !== undefined) return null;

  // 2) infobox wikitext
  const parsed = await apiGet({ action: 'parse', page: page.title, prop: 'wikitext', section: '0' });
  const wikitext: string = parsed?.parse?.wikitext?.['*'] ?? '';
  const { kind, fields } = parseInfobox(wikitext);

  const entity: WikiEntity = {
    title: page.title,
    pageId: page.pageid,
    url: page.fullurl ?? `https://fallout.fandom.com/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    kind,
    infobox: fields,
    thumbnail: page.thumbnail
      ? { url: page.thumbnail.source, width: page.thumbnail.width, height: page.thumbnail.height }
      : null,
    original: page.original
      ? { url: page.original.source, width: page.original.width, height: page.original.height }
      : null,
    fetchedAt: Date.now(),
  };

  try {
    const redis = await getRedisClient();
    await redis.set(key, JSON.stringify(entity), { EX: ENTITY_TTL_SEC });
  } catch { /* best-effort */ }
  return entity;
}
