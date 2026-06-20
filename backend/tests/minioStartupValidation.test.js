'use strict';

/**
 * Unit tests for issue #81: MINIO_* production startup validation.
 *
 * These exercise the REAL exported predicate (collectMinioProductionErrors in
 * src/config/environment.ts) — the same function the module-load production guard
 * calls before process.exit(1) — so reverting any check makes them fail. (The
 * earlier version of this suite re-implemented the predicate locally, which gave
 * zero regression protection; see the #109 review, and the sibling
 * environmentStartupGuard.test.js which imports hudIdentitySecretGuardFails the
 * same way.)
 *
 * Note on MINIO_ENDPOINT: it is the SERVER-SIDE S3 client endpoint and is meant to
 * stay Docker-internal in the Dokploy topology, so a value like the real prod
 * alias 'http://fcm-minio:9700' is VALID — only the literal compose default
 * 'http://minio:9700' is rejected. Browser reachability is MINIO_PUBLIC_URL's job.
 * MINIO_BUCKET must be set but its value is unconstrained — 'avatars' (the code
 * default in storage.ts) is a valid bucket name and must NOT be rejected.
 */

const { collectMinioProductionErrors } = require('../src/config/environment');

const VALID = {
  MINIO_ROOT_USER: 'prod-access-key',
  MINIO_ROOT_PASSWORD: 'prod-secret-key',
  MINIO_ENDPOINT: 'http://fcm-minio:9700', // Docker-internal alias is valid (not the default)
  MINIO_BUCKET: 'fcm-media',
  MINIO_PUBLIC_URL: 'https://media.falloutchatmod.com',
};

const flagged = (env, key) => collectMinioProductionErrors(env).some(e => e.includes(key));

describe('MinIO production startup guard (collectMinioProductionErrors)', () => {
  it('passes with all valid vars set', () => {
    expect(collectMinioProductionErrors(VALID)).toHaveLength(0);
  });

  it('flags missing MINIO_ENDPOINT', () => {
    expect(flagged({ ...VALID, MINIO_ENDPOINT: '' }, 'MINIO_ENDPOINT')).toBe(true);
  });

  it('flags the Docker compose default MINIO_ENDPOINT', () => {
    expect(flagged({ ...VALID, MINIO_ENDPOINT: 'http://minio:9700' }, 'MINIO_ENDPOINT')).toBe(true);
  });

  it('flags missing MINIO_BUCKET', () => {
    expect(flagged({ ...VALID, MINIO_BUCKET: '' }, 'MINIO_BUCKET')).toBe(true);
  });

  it('accepts the bucket name "avatars" (the storage.ts code default is valid)', () => {
    expect(flagged({ ...VALID, MINIO_BUCKET: 'avatars' }, 'MINIO_BUCKET')).toBe(false);
  });

  it('accepts a non-default custom bucket name', () => {
    expect(flagged({ ...VALID, MINIO_BUCKET: 'my-custom-bucket' }, 'MINIO_BUCKET')).toBe(false);
  });

  it('flags missing MINIO_PUBLIC_URL', () => {
    expect(flagged({ ...VALID, MINIO_PUBLIC_URL: '' }, 'MINIO_PUBLIC_URL')).toBe(true);
  });

  it('flags missing MINIO_ROOT_USER', () => {
    expect(flagged({ ...VALID, MINIO_ROOT_USER: '' }, 'MINIO_ROOT_USER')).toBe(true);
  });

  it('flags the default MINIO_ROOT_USER ("fo76minio")', () => {
    expect(flagged({ ...VALID, MINIO_ROOT_USER: 'fo76minio' }, 'MINIO_ROOT_USER')).toBe(true);
  });

  it('flags missing MINIO_ROOT_PASSWORD', () => {
    expect(flagged({ ...VALID, MINIO_ROOT_PASSWORD: '' }, 'MINIO_ROOT_PASSWORD')).toBe(true);
  });

  it('collects every guarded error when all vars are empty/default', () => {
    const errs = collectMinioProductionErrors({
      MINIO_ROOT_USER: 'fo76minio',
      MINIO_ROOT_PASSWORD: 'REDACTED',
      MINIO_ENDPOINT: 'http://minio:9700',
      MINIO_BUCKET: '',
      MINIO_PUBLIC_URL: '',
    });
    expect(errs).toHaveLength(5);
    for (const key of ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD', 'MINIO_ENDPOINT', 'MINIO_BUCKET', 'MINIO_PUBLIC_URL']) {
      expect(errs.some(e => e.includes(key))).toBe(true);
    }
  });
});
