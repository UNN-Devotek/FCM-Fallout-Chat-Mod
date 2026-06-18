// Regression test: package.json and package-lock.json must stay in sync for the
// dependencies CI installs with `npm ci`.
//
// `npm ci` is FAIL-CLOSED: if package.json declares a dependency range that the
// committed package-lock.json doesn't satisfy, `npm ci` aborts with EUSAGE and
// the whole CI lane (lint-typecheck, build:renderer, the launch smoke) never
// runs — i.e. the bump can't be validated.
//
// This test would have FAILED on PR #96's pre-fix state: package.json was bumped
// to react-router-dom ^7.17.0 but package-lock.json still pinned 6.30.x, so the
// lockfile entry did not satisfy the declared range. Reverting the lockfile back
// to v6 re-breaks this test (and `npm ci`), so it genuinely guards the fix.

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';
import { satisfies, minVersion, major } from 'semver';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

/** Resolved version of a top-level package from the lockfile (lockfileVersion 3). */
function resolvedVersion(name) {
  const node = lock.packages?.[`node_modules/${name}`];
  return node?.version ?? null;
}

describe('package-lock.json stays in sync with package.json (npm ci is fail-closed)', () => {
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };

  it('lockfile is lockfileVersion 3 (npm ci compatible)', () => {
    expect(lock.lockfileVersion).toBe(3);
  });

  it('every declared dependency range is satisfied by the locked version', () => {
    const mismatches = [];
    for (const [name, range] of Object.entries(declared)) {
      // Skip ranges npm ci can resolve but semver.satisfies can't parse
      // (git/file/url specifiers); the version-range check below is for
      // registry semver ranges, which is what drifted in PR #96.
      if (!/^[~^]?\d|^\d|\*|x|^>=|^<=|^>|^<|^\d.*-/.test(range) && range !== '*') continue;
      const locked = resolvedVersion(name);
      if (locked == null) {
        mismatches.push(`${name}: declared "${range}" but ABSENT from package-lock.json`);
        continue;
      }
      if (!satisfies(locked, range)) {
        mismatches.push(`${name}: locked ${locked} does NOT satisfy declared "${range}"`);
      }
    }
    expect(
      mismatches,
      'package-lock.json is out of sync with package.json — `npm ci` will fail (EUSAGE):\n  ' +
        mismatches.join('\n  ') +
        '\nRun `npm install` and commit the regenerated package-lock.json.'
    ).toEqual([]);
  });

  // react-router-dom is the dependency PR #96 bumped to v7. Pin the assertion
  // explicitly so a silent regression to the v6 lockfile is caught even if the
  // package.json range were also (incorrectly) reverted.
  it('react-router-dom resolves to the v7 major in both package.json and the lockfile', () => {
    const declaredRange = declared['react-router-dom'];
    expect(declaredRange, 'react-router-dom missing from package.json dependencies').toBeTruthy();
    expect(
      major(minVersion(declaredRange)),
      `package.json declares react-router-dom "${declaredRange}" — expected the v7 major`
    ).toBe(7);

    const locked = resolvedVersion('react-router-dom');
    expect(locked, 'react-router-dom absent from package-lock.json').toBeTruthy();
    expect(
      major(locked),
      `package-lock.json resolved react-router-dom ${locked} — expected v7 (the bump). ` +
        'A v6 lock means the lockfile was not regenerated and `npm ci` will fail.'
    ).toBe(7);
    expect(
      satisfies(locked, declaredRange),
      `locked react-router-dom ${locked} does not satisfy declared "${declaredRange}"`
    ).toBe(true);
  });
});
