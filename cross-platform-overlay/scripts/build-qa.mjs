#!/usr/bin/env node
// Builds the "golden" QA overlay artifact with a UNIQUE per-build version so the
// dev backend's golden-build lock (QA_ACTIVE_VERSION) can tell a fresh build from
// a retired one. Run via `npm run dist:qa`.
//
// The version is `<base>-qa.<UTC-timestamp>` (e.g. 1.3.91-qa.20260626014530). The
// SAME version is injected into BOTH:
//   - the renderer build  (FCM_BUILD_VERSION -> vite `__APP_VERSION__`)
//   - the packaged app    (electron-builder `-c.extraMetadata.version` -> the
//     packaged package.json, which main.js reads as APP_VERSION and sends as the
//     `X-Client-Version` header the lock checks)
// so the displayed version, the packaged version, and the lock key all match.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Derive a unique QA version from the package version + a build stamp. Strips any
 * existing prerelease so re-stamping is idempotent:
 *   computeQaVersion('1.3.91-dev', '20260626014530') === '1.3.91-qa.20260626014530'
 *   computeQaVersion('1.3.91-qa.OLD', 'NEW')         === '1.3.91-qa.NEW'
 */
export function computeQaVersion(pkgVersion, stamp) {
  const base = String(pkgVersion).split('-')[0];
  return `${base}-qa.${stamp}`;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS (UTC)
  const version = computeQaVersion(pkg.version, stamp);
  console.log(`[dist:qa] building QA version ${version}`);
  const env = { ...process.env, BUILD_CHANNEL: 'qa', FCM_BUILD_VERSION: version };
  execSync('npm run build:renderer', { stdio: 'inherit', cwd: root, env });
  execSync(
    `electron-builder -c.extraMetadata.fcmChannel=qa -c.extraMetadata.version=${version} -c.productName="Fallout Chat Mod QA"`,
    { stdio: 'inherit', cwd: root, env },
  );
  console.log(`\n[dist:qa] done. Bless this build on the dev backend with:  QA_ACTIVE_VERSION=${version}`);
}
