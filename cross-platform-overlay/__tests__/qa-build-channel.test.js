import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';
import { computeQaVersion, qaBuildOverrides } from '../scripts/build-qa.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('QA build channel plumbing', () => {
  it('vite.config defines __BUILD_CHANNEL__ and honors FCM_BUILD_VERSION', () => {
    const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/__BUILD_CHANNEL__/);
    expect(cfg).toMatch(/FCM_BUILD_VERSION/);
  });
  it('env.d.ts declares __BUILD_CHANNEL__', () => {
    const env = readFileSync(join(ROOT, 'src', 'env.d.ts'), 'utf8');
    expect(env).toMatch(/__BUILD_CHANNEL__/);
  });
  it('dist:qa runs the build-qa wrapper', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['dist:qa']).toBe('node scripts/build-qa.mjs');
  });
  it('build-qa.mjs injects fcmChannel + a unique version into both build stages', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'build-qa.mjs'), 'utf8');
    expect(qaBuildOverrides('1.4.3')).toMatchObject({
      'extraMetadata.fcmChannel': 'qa', 'extraMetadata.version': '1.4.3',
    });
    expect(src).toMatch(/FCM_BUILD_VERSION/);
    expect(src).toMatch(/BUILD_CHANNEL/);
  });
  it('build-qa.mjs lets an explicit FCM_BUILD_VERSION pin the version (coordinated multi-platform builds)', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'build-qa.mjs'), 'utf8');
    expect(src).toMatch(/process\.env\.FCM_BUILD_VERSION\s*\|\|/);
  });
});

describe('QA installation identity', () => {
  it('isolates the app profile, Windows installation and Linux package from stable', () => {
    const stable = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const qa = qaBuildOverrides('1.4.3');
    expect(qa['extraMetadata.productName']).toBe(qa.productName);
    expect(qa.productName).not.toBe(stable.productName);
    expect(qa.appId).not.toBe(stable.build.appId);
    expect(qa['nsis.shortcutName']).not.toBe(stable.build.nsis.shortcutName);
    expect(qa['linux.executableName']).not.toBe(stable.build.linux.executableName);
    expect(qa['extraMetadata.desktopName']).toBe(qa['linux.executableName'] + '.desktop');
    expect(qa['deb.packageName']).toBe('fallout-chatmod-qa');
    expect(qa['deb.artifactName']).toBe('Fallout Chat Mod QA-1.4.3.deb');
  });
  it('the QA installer stops only QA and does not run a stable legacy uninstaller', () => {
    const include = qaBuildOverrides('1.4.3')['nsis.include'];
    const script = readFileSync(join(ROOT, include), 'utf8');
    expect([...script.matchAll(/taskkill \/F \/IM "([^"]+)"/g)].map(match => match[1]))
      .toEqual(['Fallout Chat Mod QA.exe']);
    expect(script).not.toMatch(/Uninstall/);
  });
  it.each(['1.4.3;touch x', '1.4.3$(pwd)', 'bad'])('rejects an invalid pinned build version: %s', version => {
    expect(() => qaBuildOverrides(version)).toThrow('Invalid QA build version');
  });
});

describe('computeQaVersion (unique per-build QA version)', () => {
  it('appends -qa.<stamp> to the base version', () => {
    expect(computeQaVersion('1.3.91-dev', '20260626014530')).toBe('1.3.91-qa.20260626014530');
  });
  it('works when the base has no prerelease', () => {
    expect(computeQaVersion('1.3.91', 'abc')).toBe('1.3.91-qa.abc');
  });
  it('re-stamps idempotently (strips an existing -qa.* prerelease)', () => {
    expect(computeQaVersion('1.3.91-qa.OLD', 'NEW')).toBe('1.3.91-qa.NEW');
  });
  it('produces distinct versions for distinct stamps so the lock can retire old builds', () => {
    expect(computeQaVersion('1.3.91-dev', '20260626010000'))
      .not.toBe(computeQaVersion('1.3.91-dev', '20260626020000'));
  });
});
