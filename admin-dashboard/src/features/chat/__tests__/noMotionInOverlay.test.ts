/**
 * Guard: the Motion animation library must never become reachable from ChatOverlay.
 *
 * ChatOverlay is the ONE component rendered on all three surfaces, including the
 * Electron overlay, which draws transparently on top of Fallout 76. Motion is
 * JS-driven: pulling it into that import graph would add a per-element animation loop
 * running alongside a live game, and would break the memoization the virtualized feed
 * depends on. Per-message name effects are therefore pure CSS (nameEffects.css)
 * driven by CSS custom properties.
 *
 * Motion IS used, deliberately, in CosmeticsPanel — a low-element-count,
 * interaction-driven dashboard route the overlay never loads. This test encodes
 * exactly that split, so a well-meaning future refactor that "unifies" the animation
 * approach fails CI instead of quietly costing frames in game.
 *
 * Walks the real import graph rather than checking one file, because the risk is a
 * transitive import through a helper, not a direct one.
 *
 * Uses Vite's ?raw glob rather than node:fs, matching indexHtmlSeo.test.ts — the
 * admin-dashboard tsconfig is browser-only and does not type node builtins.
 */
import { describe, it, expect } from 'vitest';

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const ENTRY = '/src/features/chat/ChatOverlay.tsx';
const PANEL = '/src/features/profile/CosmeticsPanel.tsx';

const BANNED = [/^motion(\/|$)/, /^framer-motion(\/|$)/];
const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Resolve a relative specifier against a module path, POSIX-style. */
function resolveRelative(spec: string, fromFile: string): string | null {
  const fromDir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  const segments = `${fromDir}/${spec}`.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  const base = `/${out.join('/')}`;
  for (const ext of EXTENSIONS) {
    if (SOURCES[base + ext] !== undefined) return base + ext;
  }
  return null;
}

/** Everything reachable from `entry` via relative imports, plus bare specifiers seen. */
function walk(entry: string) {
  const files = new Set<string>();
  const bare = new Map<string, string[]>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);

    const source = SOURCES[file];
    if (source === undefined) continue;

    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(spec, file);
        if (resolved) queue.push(resolved);
      } else {
        bare.set(spec, [...(bare.get(spec) ?? []), file]);
      }
    }
  }
  return { files, bare };
}

describe('overlay bundle guard', () => {
  const graph = walk(ENTRY);

  it('walks a non-trivial import graph (the guard is actually looking at something)', () => {
    expect(SOURCES[ENTRY]).toBeTypeOf('string');
    expect(graph.files.size).toBeGreaterThan(3);
  });

  it('sees real third-party imports (proves bare specifiers are being collected)', () => {
    expect([...graph.bare.keys()]).toContain('react');
  });

  it('never imports Motion, directly or transitively', () => {
    const offenders: string[] = [];
    for (const [spec, importers] of graph.bare) {
      if (BANNED.some(re => re.test(spec))) {
        offenders.push(`${spec} imported by: ${importers.join(', ')}`);
      }
    }
    expect(
      offenders,
      'Motion is JS-driven animation and must not reach the Electron overlay bundle, ' +
      'which renders on top of a running game. Use CSS (see nameEffects.css) for anything ' +
      'rendered per-message.',
    ).toEqual([]);
  });

  it('CosmeticsPanel DOES use Motion — the split is intentional, not an accident', () => {
    expect(SOURCES[PANEL]).toMatch(/from ['"]motion\/react['"]/);
  });

  it('CosmeticsPanel is not reachable from ChatOverlay', () => {
    expect(graph.files.has(PANEL)).toBe(false);
  });
});
