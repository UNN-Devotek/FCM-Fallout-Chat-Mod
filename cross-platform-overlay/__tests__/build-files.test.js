// Regression test: every local require('./X') in main-process source files
// must be covered by package.json `build.files` so it lands in app.asar.
//
// This test would have FAILED before overlay-core.js was added to build.files
// (main.js required('./overlay-core') but overlay-core.js was excluded, bricking
// the packaged release with "Cannot find module './overlay-core'").

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

// minimatch is a dep of electron-builder so it's always available in this repo.
import { minimatch } from 'minimatch';

const ROOT = resolve(import.meta.dirname, '..');

/** Extract all `require('./X')` / `require("./X")` targets from source text. */
function extractLocalRequires(src) {
  const pattern = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
  const found = new Set();
  let m;
  while ((m = pattern.exec(src)) !== null) {
    // Strip leading './' and any extension so we can normalise to *.js check.
    let dep = m[1].replace(/^\.\//, '');
    // If the require target already carries an extension, strip it.
    dep = dep.replace(/\.(js|ts|cjs|mjs)$/, '');
    found.add(dep);
  }
  return found;
}

/** Return true if filename is covered by any glob/literal in the build.files array. */
function isCovered(filename, buildFiles) {
  for (const pattern of buildFiles) {
    if (typeof pattern !== 'string') continue;
    // Exact match
    if (pattern === filename) return true;
    // Glob match (minimatch handles '**' etc.)
    if (minimatch(filename, pattern)) return true;
  }
  return false;
}

describe('electron-builder build.files completeness', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const buildFiles = pkg?.build?.files ?? [];

  // The main-process entry points that ship into app.asar.
  // Add new top-level main-process files here if they are introduced.
  const mainProcessFiles = ['main.js', 'preload.js', 'overlay-core.js'];

  it('build.files must be a non-empty array', () => {
    expect(Array.isArray(buildFiles)).toBe(true);
    expect(buildFiles.length).toBeGreaterThan(0);
  });

  for (const sourceFile of mainProcessFiles) {
    it(`build.files covers ${sourceFile} itself`, () => {
      const covered = isCovered(sourceFile, buildFiles);
      expect(
        covered,
        `"${sourceFile}" is a main-process file but is NOT listed in package.json build.files. ` +
          `It will be missing from app.asar and crash the packaged app.`
      ).toBe(true);
    });

    it(`all local require()s in ${sourceFile} are covered by build.files`, () => {
      let src;
      try {
        src = readFileSync(join(ROOT, sourceFile), 'utf8');
      } catch {
        // File doesn't exist yet — skip rather than fail (handles optional files).
        return;
      }

      const deps = extractLocalRequires(src);
      const missing = [];

      for (const dep of deps) {
        // Special case: package.json is a JSON file, not .js
        const filename = dep === 'package.json' ? 'package.json' : `${dep}.js`;
        if (!isCovered(filename, buildFiles)) {
          missing.push(filename);
        }
      }

      expect(
        missing,
        `${sourceFile} requires the following local module(s) that are NOT in ` +
          `package.json build.files:\n  ${missing.join('\n  ')}\n` +
          `These files will be absent from app.asar and crash the packaged overlay on launch.`
      ).toEqual([]);
    });
  }
});
