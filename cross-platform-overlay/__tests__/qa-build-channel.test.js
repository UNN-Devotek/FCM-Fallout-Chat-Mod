import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';
import { computeQaVersion } from '../scripts/build-qa.mjs';

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
    expect(src).toMatch(/extraMetadata\.fcmChannel=qa/);
    expect(src).toMatch(/extraMetadata\.version=/);
    expect(src).toMatch(/FCM_BUILD_VERSION/);
    expect(src).toMatch(/BUILD_CHANNEL/);
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
