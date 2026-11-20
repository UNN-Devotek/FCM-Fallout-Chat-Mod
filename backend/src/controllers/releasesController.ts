import { isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
import { Request, Response, NextFunction } from 'express';
import { paramsOf } from '../utils/reqParams';
import { z } from 'zod';
import { createError } from '../middleware/errorHandler';
import prisma from '../config/prisma';
import { constantTimeEquals } from '../utils/constantTimeEquals';
import { postReleaseAnnouncement } from '../services/discordService';
import { setLatestVersion } from '../services/latestReleaseVersion';
import { createGitHubRelease } from '../services/githubReleaseService';
import {
  linuxZipUrl,
  rawWindowsInstallerUrl,
  rawLinuxAppImageUrl,
  rawLinuxDebUrl,
  assertAllowedDownloadUrl,
  isAllowedDownloadUrl,
} from '../utils/releaseDownloadUrls';

/**
 * Verify a download URL serves a real, full installer (not a 404/error page).
 * Guards the publish pipeline: a filename mismatch or truncated upload serves a
 * tiny HTML/JSON error page that gets saved as .exe/.AppImage → users see "file
 * corrupted". We HEAD the URL and require 200 + a plausible installer size.
 *
 * URL building + the SSRF allow-list live in `utils/releaseDownloadUrls.ts` — a
 * zero-dependency, environment-aware module (RELEASE_DOWNLOAD_HOST, default
 * prod) so the dev/QA stack can publish + verify dev-hosted artifacts.
 */
async function verifyDownload(url: string, label: string, minimumBytes = 1_000_000): Promise<void> {
  // Allow-list the target before issuing any request (SSRF defense).
  assertAllowedDownloadUrl(url);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    // redirect: 'error' blocks redirect-based pivots to internal IPs.
    res = await fetch(url, { method: 'HEAD', redirect: 'error' });
  } catch (e: any) {
    // Do not echo the raw URL — keeps this from acting as a reachability oracle.
    throw new Error(`${label} download is unreachable (${e?.message || e})`);
  }
  if (!res.ok) {
    throw new Error(`${label} download is missing (HTTP ${res.status}) — check the filename/upload`);
  }
  const len = Number(res.headers.get('content-length') || '0');
  if (len < minimumBytes) {
    throw new Error(`${label} download is only ${len} bytes — likely a 404/error page, not the installer`);
  }
}

export interface ReleaseEntry {
  version: string;
  downloadUrl: string;
  portableDownloadUrl?: string | null;
  releaseNotes: string;
  hudModVersion?: string | null;
  hudModUrl?: string | null;
  publishedAt: string;
  downloadCount: number;
}

const releaseBodySchema = z.object({
  version: z.string().min(1),
  downloadUrl: z
    .string()
    .url()
    .refine(isAllowedDownloadUrl, {
      message: 'downloadUrl must be an https URL on the configured downloads host (/downloads/…)',
    }),
  portableDownloadUrl: z
    .string()
    .url()
    .refine(isAllowedDownloadUrl, {
      message: 'portableDownloadUrl must be an https URL on the configured downloads host (/downloads/...)',
    })
    .optional(),
  releaseNotes: z.string().min(1),
  // Optional for backwards-compatible overlay-only releases. When present,
  // both fields are required so the website can show a truthful versioned HUD
  // download rather than a link with no version metadata.
  hudModVersion: z.string().min(1).optional(),
  hudModUrl: z
    .string()
    .url()
    .refine(isAllowedDownloadUrl, {
      message: 'hudModUrl must be an https URL on the configured downloads host (/downloads/...)',
    })
    .optional(),
  // The release operator must deliberately choose which client surfaces changed.
  // This controls both the Discord title and the opt-in notification roles.
  releaseTarget: z.enum(['overlay', 'hud', 'both']),
  // When false, skip the Discord announcement for THIS publish. The site download
  // and in-app update notification still update.
  announce: z.boolean().optional().default(true),
  suppressNotifications: z.boolean().optional().default(false),
}).refine(
  (value) => Boolean(value.hudModVersion) === Boolean(value.hudModUrl),
  { message: 'hudModVersion and hudModUrl must be provided together' },
).refine(
  (value) => value.releaseTarget === 'overlay'
    ? !value.hudModUrl
    : Boolean(value.hudModUrl),
  { message: 'overlay releases must omit HUD metadata; hud and both releases require hudModVersion and hudModUrl' },
);

function toEntry(r: {
  version: string;
  downloadUrl: string;
  portableDownloadUrl?: string | null;
  releaseNotes: string;
  hudModVersion?: string | null;
  hudModUrl?: string | null;
  publishedAt: Date;
  downloadCount: number;
}): ReleaseEntry {
  return {
    version: r.version,
    downloadUrl: r.downloadUrl,
    portableDownloadUrl: r.portableDownloadUrl ?? null,
    releaseNotes: r.releaseNotes,
    hudModVersion: r.hudModVersion ?? null,
    hudModUrl: r.hudModUrl ?? null,
    publishedAt: r.publishedAt.toISOString(),
    downloadCount: r.downloadCount,
  };
}

/**
 * Parse the version string out of an installer filename.
 * e.g. "FalloutChatMod_Setup_v1.3.30.exe" → "1.3.30"
 */
function versionFromFilename(filename: string): string | null {
  const m = filename.match(/FalloutChatMod_Setup_v(\d+\.\d+\.\d+)\.exe$/);
  return m ? m[1] : null;
}

/**
 * Increment the download_count for the given version (fire-and-forget — never
 * blocks or errors the download response).
 */
export async function incrementDownloadCount(version: string): Promise<void> {
  try {
    await prisma.release.updateMany({
      where: { version },
      data: { downloadCount: { increment: 1 } },
    });
  } catch {
    // Optional telemetry: a metric failure does not affect published downloads.
  }
}

export { versionFromFilename };

/**
 * POST /admin/releases -- Publishes a new release (upserts by version) and
 * persists it in the `releases` table so it survives container redeploys.
 * Auth: Bearer ADMIN_RELEASE_TOKEN or X-Admin-API-Key: ADMIN_API_KEY.
 */
async function publishRelease(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('domain', 'releasesController:3a90035d4fc7', async () => {
  try {
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const apiKey = req.headers['x-admin-api-key'] as string | undefined;
    const releaseToken = process.env.ADMIN_RELEASE_TOKEN;
    const adminKey = process.env.ADMIN_API_KEY;

    const validBearer = !!(releaseToken && bearerToken && constantTimeEquals(bearerToken, releaseToken));
    const validApiKey = !!(adminKey && apiKey && constantTimeEquals(apiKey, adminKey));
    if (!validBearer && !validApiKey) {
      return next(createError(401, 'Invalid or missing ADMIN_RELEASE_TOKEN'));
    }

    const parsed = releaseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      return next(createError(400, detail));
    }

    const { version, downloadUrl, portableDownloadUrl, releaseNotes, releaseTarget, announce, suppressNotifications, hudModUrl, hudModVersion } = parsed.data;
    const publishedAt = new Date();

    // Pipeline gate: verify all five overlay artifacts and, when supplied, the
    // HUD ZIP exist and are full-size on the
    // server BEFORE we announce or record. Stops filename mismatches / truncated
    // uploads from shipping a release whose buttons serve a corrupt file.
    //
    // - downloadUrl         = Windows ZIP (human download — website + Nexus)
    // - linuxZipUrl         = Linux ZIP   (human download — website + Nexus)
    // - rawWindowsInstallerUrl = raw .exe  (CLI installer / direct download)
    // - rawLinuxAppImageUrl    = raw .AppImage (CLI installer / direct download)
    // - rawLinuxDebUrl         = raw .deb (website / direct download)
    //
    // The zips are >1 MB; raw installers are also well above the 1 MB floor.
    try {
      await verifyDownload(downloadUrl, 'Windows ZIP');
      if (portableDownloadUrl) await verifyDownload(portableDownloadUrl, 'Windows portable ZIP');
      await verifyDownload(linuxZipUrl(version), 'Linux ZIP');
      await verifyDownload(rawWindowsInstallerUrl(version), 'Windows raw installer (CLI installer / direct download)');
      await verifyDownload(rawLinuxAppImageUrl(version), 'Linux raw AppImage (CLI installer / direct download)');
      await verifyDownload(rawLinuxDebUrl(version), 'Linux raw .deb (direct download)');
      if (hudModUrl) {
        // The HUD ZIP is intentionally much smaller than an Electron installer,
        // but it must still be a real uploaded artifact rather than an HTML 404.
        await verifyDownload(hudModUrl, 'ZFE FCM HUD Mod ZIP', 1_000);
      }
    } catch (e: any) {
      return next(createError(
        400,
        `Release download verification failed — no release recorded. ${e?.message || e}`,
      ));
    }

    // Post the announcement to the Discord Updates channel BEFORE committing the
    // DB row or broadcasting. The post is treated as part of the publish: if it
    // cannot get out (with retries), the publish fails and no DB row is created.
    //
    // `announce: false` opts out (a quiet publish): the site download + in-app
    // update notification still update below, but no Discord post fires — the
    // operator edits the existing announcement by hand.
    if (announce) {
      try {
        if (hudModUrl && hudModVersion) {
          await postReleaseAnnouncement(version, releaseNotes, { url: hudModUrl, version: hudModVersion }, {
            target: releaseTarget, suppressNotifications,
            ...(portableDownloadUrl ? { portableDownloadUrl } : {}),
          });
        } else {
          await postReleaseAnnouncement(version, releaseNotes, undefined, {
            target: releaseTarget, suppressNotifications,
            ...(portableDownloadUrl ? { portableDownloadUrl } : {}),
          });
        }
      } catch (e: any) {
        return next(createError(
          502,
          `Discord Updates-channel post is required for publish and failed: ${e?.message || e}. ` +
          `Check the Discord bot status and try again — no release was recorded.`,
        ));
      }
    }

    const saved = await runRequiredMutation('domain', '89a9d2f410a9441eafb930bc', { stage: 'primary-write-unconfirmed' }, () => prisma.release.upsert({
      where: { version },
      update: {
        downloadUrl,
        portableDownloadUrl: portableDownloadUrl ?? null,
        releaseNotes,
        publishedAt,
        ...(hudModUrl && hudModVersion ? { hudModUrl, hudModVersion } : {}),
      },
      create: { version, downloadUrl, portableDownloadUrl, releaseNotes, hudModUrl, hudModVersion, publishedAt },
    }), isPrismaAtomicRefusal, undefined, undefined);

    // Refresh the in-memory latest-version cache so newly connecting overlays
    // receive the updated version in their app:update-available handshake message.
    setLatestVersion(version);

    // Best-effort: mirror the release to GitHub Releases (same notes + the
    // env-aware download links). Never throws — a GitHub API failure must not
    // fail a publish that already announced + recorded. Discord stays the only
    // hard-required channel.
    await createGitHubRelease(
      version,
      releaseNotes,
      {
        target: releaseTarget,
        ...(portableDownloadUrl ? { portableDownloadUrl } : {}),
        ...(hudModUrl && hudModVersion ? { hudMod: { url: hudModUrl, version: hudModVersion } } : {}),
      },
    );

    res.json({ data: { message: `Release v${version} published`, ...toEntry(saved) } });
  } catch (err) {
    next(err);
  }

  });
}

/**
 * GET /api/releases -- Returns full release history (most recent first)
 */
async function getReleases(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.release.findMany({ orderBy: { publishedAt: 'desc' } });
    res.json({ data: rows.map(toEntry) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /admin/releases/:version -- Removes a release entry by version string.
 * Auth: Bearer ADMIN_RELEASE_TOKEN or X-Admin-API-Key: ADMIN_API_KEY.
 */
async function deleteRelease(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('domain', 'releasesController:1a8b7ec4d17a', async () => {
  try {
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const apiKey = req.headers['x-admin-api-key'] as string | undefined;
    const releaseToken = process.env.ADMIN_RELEASE_TOKEN;
    const adminKey = process.env.ADMIN_API_KEY;
    const validBearer = !!(releaseToken && bearerToken && constantTimeEquals(bearerToken, releaseToken));
    const validApiKey = !!(adminKey && apiKey && constantTimeEquals(apiKey, adminKey));
    if (!validBearer && !validApiKey) {
      return next(createError(401, 'Unauthorized'));
    }
    const { version } = paramsOf(req);
    const deleted = await runRequiredMutation('domain', '230a638e43f4376be07cbfb8', { stage: 'primary-write-unconfirmed' }, () => prisma.release.deleteMany({ where: { version } }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    if (deleted.count === 0) return next(createError(404, `Release ${version} not found`));
    res.json({ data: { deleted: true, version } });
  } catch (err) {
    next(err);
  }

  });
}

export { publishRelease, getReleases, deleteRelease };
module.exports = { publishRelease, getReleases, deleteRelease };
