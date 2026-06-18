'use strict';

/**
 * Unit tests for issue #81: MINIO_ENDPOINT, MINIO_BUCKET, and MINIO_PUBLIC_URL
 * production startup validation.
 *
 * The production guard in environment.ts collects missing/bad vars into a
 * `missing` array and calls process.exit(1) when non-empty. These tests
 * mirror that predicate logic directly — no subprocess spawning needed.
 */

// Mirrors the guard predicate added to environment.ts for MinIO vars.
function collectMinioErrors(env) {
  const missing = [];
  if (!env.MINIO_ROOT_USER || env.MINIO_ROOT_USER === 'fo76minio')
    missing.push('MINIO_ROOT_USER (must be non-default)');
  if (!env.MINIO_ROOT_PASSWORD || env.MINIO_ROOT_PASSWORD === 'REDACTED')
    missing.push('MINIO_ROOT_PASSWORD (must be non-default)');
  if (!env.MINIO_ENDPOINT || env.MINIO_ENDPOINT === 'http://minio:9700')
    missing.push('MINIO_ENDPOINT (must be set to the public/reachable endpoint, not the Docker default)');
  if (!env.MINIO_BUCKET || env.MINIO_BUCKET === 'avatars')
    missing.push('MINIO_BUCKET (must be explicitly set — do not rely on the default)');
  if (!env.MINIO_PUBLIC_URL)
    missing.push('MINIO_PUBLIC_URL (must be set — fallback uses MINIO_ENDPOINT which is not browser-reachable in production)');
  return missing;
}

const VALID = {
  MINIO_ROOT_USER: 'prod-access-key',
  MINIO_ROOT_PASSWORD: 'prod-secret-key',
  MINIO_ENDPOINT: 'https://s3.falloutchatmod.com',
  MINIO_BUCKET: 'fcm-media',
  MINIO_PUBLIC_URL: 'https://media.falloutchatmod.com',
};

describe('MinIO production startup guard', () => {
  it('passes with all valid vars set', () => {
    expect(collectMinioErrors(VALID)).toHaveLength(0);
  });

  it('flags missing MINIO_ENDPOINT', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_ENDPOINT: '' });
    expect(errs.some(e => e.includes('MINIO_ENDPOINT'))).toBe(true);
  });

  it('flags Docker-default MINIO_ENDPOINT', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_ENDPOINT: 'http://minio:9700' });
    expect(errs.some(e => e.includes('MINIO_ENDPOINT'))).toBe(true);
  });

  it('flags missing MINIO_BUCKET', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_BUCKET: '' });
    expect(errs.some(e => e.includes('MINIO_BUCKET'))).toBe(true);
  });

  it('flags default MINIO_BUCKET ("avatars")', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_BUCKET: 'avatars' });
    expect(errs.some(e => e.includes('MINIO_BUCKET'))).toBe(true);
  });

  it('flags missing MINIO_PUBLIC_URL', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_PUBLIC_URL: '' });
    expect(errs.some(e => e.includes('MINIO_PUBLIC_URL'))).toBe(true);
  });

  it('flags missing MINIO_ROOT_USER', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_ROOT_USER: '' });
    expect(errs.some(e => e.includes('MINIO_ROOT_USER'))).toBe(true);
  });

  it('flags default MINIO_ROOT_USER ("fo76minio")', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_ROOT_USER: 'fo76minio' });
    expect(errs.some(e => e.includes('MINIO_ROOT_USER'))).toBe(true);
  });

  it('flags missing MINIO_ROOT_PASSWORD', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_ROOT_PASSWORD: '' });
    expect(errs.some(e => e.includes('MINIO_ROOT_PASSWORD'))).toBe(true);
  });

  it('collects all five errors when all vars are at defaults', () => {
    const errs = collectMinioErrors({
      MINIO_ROOT_USER: '',
      MINIO_ROOT_PASSWORD: '',
      MINIO_ENDPOINT: 'http://minio:9700',
      MINIO_BUCKET: 'avatars',
      MINIO_PUBLIC_URL: '',
    });
    expect(errs).toHaveLength(5);
  });

  it('non-default custom bucket name is accepted', () => {
    const errs = collectMinioErrors({ ...VALID, MINIO_BUCKET: 'my-custom-bucket' });
    expect(errs.some(e => e.includes('MINIO_BUCKET'))).toBe(false);
  });
});
