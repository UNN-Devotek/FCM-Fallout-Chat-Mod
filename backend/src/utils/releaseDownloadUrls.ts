/**
 * Release download-URL helpers + SSRF allow-list — ENVIRONMENT-AWARE.
 *
 * This is a deliberately ZERO-DEPENDENCY module: the publish-verify gate
 * (`releasesController.publishRelease`) calls these to build and validate the
 * five artifact URLs it HEAD-checks before recording a release. A module with no
 * imports can never fail to resolve, so the gate's robustness intent ("never
 * depend on another module's export resolving") is preserved — while making the
 * logic unit-testable without pulling in Prisma/Discord.
 *
 * The downloads origin defaults to PROD. The dev/QA stack sets
 * `RELEASE_DOWNLOAD_HOST=dev.falloutchatmod.com` so publish-to-dev verifies and
 * links dev-hosted artifacts instead of prod's. The host is OPERATOR-controlled
 * (an env var, never request-derived), so the SSRF guard stays a single-host
 * allow-list — `POST /admin/releases` still cannot be used to HEAD-probe
 * arbitrary internal hosts. Read at call time so tests/redeploys pick up the env.
 *
 * Filenames must match the electron-builder output: productName "Fallout Chat
 * Mod" (WITH spaces).
 */

export const DEFAULT_RELEASE_DOWNLOAD_HOST = 'falloutchatmod.com';

/** The configured downloads host (prod by default; dev stack overrides). */
export function releaseDownloadHost(): string {
  return process.env.RELEASE_DOWNLOAD_HOST || DEFAULT_RELEASE_DOWNLOAD_HOST;
}

/** `https://<host>/downloads/electron` — base for every electron artifact URL. */
export function electronDownloadsBase(): string {
  return `https://${releaseDownloadHost()}/downloads/electron`;
}

// Human-download ZIP (website + Nexus buttons).
export function linuxZipUrl(version: string): string {
  return `${electronDownloadsBase()}/${encodeURIComponent(`Fallout Chat Mod-${version}.AppImage (Linux).zip`)}`;
}
export function windowsZipUrl(version: string): string {
  return `${electronDownloadsBase()}/${encodeURIComponent(`Fallout Chat Mod Setup ${version} (Windows).zip`)}`;
}

// Raw installer files — consumed by the CLI installer / direct download.
export function rawWindowsInstallerUrl(version: string): string {
  return `${electronDownloadsBase()}/${encodeURIComponent(`Fallout Chat Mod Setup ${version}.exe`)}`;
}
export function rawLinuxAppImageUrl(version: string): string {
  return `${electronDownloadsBase()}/${encodeURIComponent(`Fallout Chat Mod-${version}.AppImage`)}`;
}
export function rawLinuxDebUrl(version: string): string {
  return `${electronDownloadsBase()}/${encodeURIComponent(`Fallout Chat Mod-${version}.deb`)}`;
}

/**
 * SSRF allow-list predicate: true only for an https URL on the configured
 * downloads host with a `/downloads/` path. Backs the release-body schema.
 */
export function isAllowedDownloadUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === releaseDownloadHost() &&
    u.pathname.startsWith('/downloads/')
  );
}

/** Throwing form of {@link isAllowedDownloadUrl} — used before any HEAD probe. */
export function assertAllowedDownloadUrl(url: string): void {
  if (!isAllowedDownloadUrl(url)) {
    throw new Error(`downloadUrl must be an https://${releaseDownloadHost()}/downloads/ URL`);
  }
}
