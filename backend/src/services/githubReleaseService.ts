/**
 * GitHub Releases — mirror each published release to a GitHub Release.
 *
 * Called best-effort from `publishRelease` AFTER the Discord announcement + DB
 * record, so the same notes also land on GitHub. It NEVER throws: a GitHub API
 * hiccup must not block or fail the release (Discord stays the hard-required
 * channel). Idempotent — re-publishing a version updates its existing release.
 *
 * The body LINKS to the artifacts on `/downloads` (env-aware via
 * `releaseAnnouncement`) rather than uploading them as assets — the website +
 * Nexus remain the download sources. Dev/QA versions (a `-suffix`) publish as
 * GitHub PRE-releases so they never show as "Latest".
 *
 * Config (skips cleanly if absent): `GITHUB_OWNER` / `GITHUB_REPO` and a token —
 * `GITHUB_RELEASE_TOKEN` if set (use a token with `contents: write`), else the
 * shared `GITHUB_PAT` from the ticketing integration.
 */

import logger from '../config/logger';
import { releaseDownloadFieldValue, nexusEndorseFieldValue } from '../utils/releaseAnnouncement';

export interface GitHubReleaseConfig {
  token: string;
  owner: string;
  repo: string;
}

// The repo is fixed for this project; env vars only need to OVERRIDE it (e.g. a
// fork). Prod sets GITHUB_PAT but not GITHUB_OWNER/GITHUB_REPO, so default them.
const DEFAULT_OWNER = 'UNN-Devotek';
const DEFAULT_REPO = 'FCM-Fallout-Chat-Mod';

/** Resolve config from env; null only if no token is available (→ skip cleanly). */
export function githubReleaseConfig(): GitHubReleaseConfig | null {
  const token = process.env.GITHUB_RELEASE_TOKEN || process.env.GITHUB_PAT;
  if (!token) return null;
  return {
    token,
    owner: process.env.GITHUB_OWNER || DEFAULT_OWNER,
    repo: process.env.GITHUB_REPO || DEFAULT_REPO,
  };
}

/** A `-suffix` (e.g. `1.3.91-dev`) marks a pre-release. */
export function isPrereleaseVersion(version: string): boolean {
  return version.includes('-');
}

export function releaseTag(version: string): string {
  return `v${version}`;
}

/** Release body: the notes, then the same env-aware download links + Nexus-endorse copy as the Discord embed. */
export function buildGitHubReleaseBody(version: string, releaseNotes: string): string {
  return [
    (releaseNotes || 'A new version is available.').trim(),
    '',
    '## Download',
    releaseDownloadFieldValue(version),
    '',
    '## Endorse on Nexus',
    nexusEndorseFieldValue(),
  ].join('\n');
}

export interface GitHubReleasePayload {
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  make_latest: 'true' | 'false';
}

/** The create/update payload for the GitHub Releases API. */
export function githubReleasePayload(version: string, releaseNotes: string): GitHubReleasePayload {
  const pre = isPrereleaseVersion(version);
  return {
    tag_name: releaseTag(version),
    name: `Fallout Chat Mod ${releaseTag(version)}`,
    body: buildGitHubReleaseBody(version, releaseNotes),
    prerelease: pre,
    make_latest: pre ? 'false' : 'true',
  };
}

type FetchLike = typeof fetch;

/**
 * Create (or update) the GitHub Release for `version`. Best-effort — catches all
 * errors, logs, and returns; never throws. Idempotent: PATCHes an existing
 * release for the tag, otherwise POSTs a new one. `fetchImpl` is injectable for tests.
 */
export async function createGitHubRelease(
  version: string,
  releaseNotes: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const cfg = githubReleaseConfig();
  if (!cfg) {
    logger.info('[githubRelease] skipped — GITHUB_OWNER/GITHUB_REPO/token not configured');
    return;
  }
  const f = opts.fetchImpl || fetch;
  const base = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fcm-release',
  };
  const payload = githubReleasePayload(version, releaseNotes);
  const tag = payload.tag_name;
  const attemptDelays = [0, 1000, 3000]; // 3 tries

  let lastErr: unknown = null;
  for (let i = 0; i < attemptDelays.length; i++) {
    if (attemptDelays[i] > 0) await new Promise((r) => setTimeout(r, attemptDelays[i]));
    try {
      // Idempotent: update an existing release for the tag if one is present.
      const existing = await f(`${base}/releases/tags/${encodeURIComponent(tag)}`, { headers });
      if (existing.ok) {
        const { id } = (await existing.json()) as { id: number };
        const res = await f(`${base}/releases/${id}`, { method: 'PATCH', headers, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`PATCH /releases/${id} -> ${res.status}`);
      } else if (existing.status === 404) {
        const res = await f(`${base}/releases`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`POST /releases -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      } else {
        throw new Error(`GET /releases/tags/${tag} -> ${existing.status}`);
      }
      logger.info({ version, tag, prerelease: payload.prerelease }, '[githubRelease] published GitHub release');
      return;
    } catch (err) {
      lastErr = err;
      logger.warn({ err, version, attempt: i + 1 }, '[githubRelease] attempt failed; will retry');
    }
  }
  logger.error(
    { err: lastErr, version },
    '[githubRelease] failed after retries — release recorded without a GitHub release (best-effort, non-fatal)',
  );
}
