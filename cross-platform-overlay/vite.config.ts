import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Version FOLLOWS the main desktop app: the canonical version lives in
// ChatOverlay/ChatOverlay.csproj's <Version> (patched by build-installer.ps1).
// We read it at config time so __APP_VERSION__ stays in lock-step with the
// desktop client. Falls back to this package's own version if the .csproj
// isn't reachable (e.g. a packaged build without the source tree).
const _require = createRequire(import.meta.url);
function readMainAppVersion(): string {
  try {
    const csproj = fs.readFileSync(
      path.resolve(__dirname, '..', 'ChatOverlay', 'ChatOverlay.csproj'),
      'utf8',
    );
    const m = csproj.match(/<Version>\s*([^<\s]+)\s*<\/Version>/);
    if (m) return m[1];
  } catch { /* fall back to package.json */ }
  return (_require('./package.json') as { version: string }).version;
}
const pkgVersion = readMainAppVersion();

/**
 * Vite config for the cross-platform overlay prototype.
 *
 * This app mounts the REAL admin-dashboard ChatOverlay component
 * (../admin-dashboard/src/features/chat/ChatOverlay.tsx) UNMODIFIED via the
 * `@dashboard` alias. The component (and its real `services/api`) is left
 * intact — we bridge data by overriding the global `fetch` and `WebSocket` in
 * src/bridge.ts so the component's own network layer talks to the live relay
 * through token auth instead of dashboard cookies. No source edits, no api stub.
 *
 * Tailwind v4 + the dashboard's index.css are loaded by src/main.tsx so the
 * preflight/fonts/theme vars match the website exactly.
 */
const repoRoot = path.resolve(__dirname, '..');
const dashboardSrc = path.resolve(repoRoot, 'admin-dashboard', 'src');

export default defineConfig({
  root: __dirname,
  base: './', // Electron loads via file:// — relative asset paths required.
  plugins: [react(), tailwindcss()],
  define: {
    // FCM_BUILD_VERSION (set by scripts/build-qa.mjs for a unique per-build QA
    // version) wins; otherwise resolved from package.json at build/dev-server
    // start time. Keeps the renderer's displayed version in lock-step with the
    // packaged version + the X-Client-Version the golden-build lock checks.
    __APP_VERSION__: JSON.stringify(process.env.FCM_BUILD_VERSION || pkgVersion),
    __BUILD_CHANNEL__: JSON.stringify(process.env.BUILD_CHANNEL || 'stable'),
  },
  resolve: {
    alias: [
      // Mount-point alias to the REAL dashboard source.
      { find: '@dashboard', replacement: dashboardSrc },
    ],
    // The dashboard source resolves its own copies of these from
    // admin-dashboard/node_modules. We MUST force a single instance of each, or
    // React context (QueryClientProvider, Router, hooks) breaks across the two
    // module trees ("No QueryClient set" / "Invalid hook call").
    dedupe: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
    preserveSymlinks: false,
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    // The renderer only ever runs inside our bundled Electron (modern Chromium),
    // so there is no need to down-level modern JS to the conservative web baseline.
    // esbuild >=0.28 refuses to lower some destructuring to es2020/safari14; an
    // esnext target avoids that transform entirely and produces smaller output.
    target: 'esnext',
  },
  // The DEV SERVER pre-bundles deps with a SEPARATE esbuild target that does NOT
  // inherit build.target — it defaults to the conservative web baseline. With the
  // pinned esbuild >=0.28 (overrides), that default makes esbuild throw
  // "Transforming destructuring to ... is not supported yet" on react-router /
  // @tanstack deps, breaking `npm run dev:local`. The renderer only runs in modern
  // Electron Chromium, so pre-bundle for esnext (no lowering) to match build.target.
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
  },
  // Source-file transforms in dev also use esbuild. Vite 8 removed `target` from
  // the top-level `esbuild` options (it's managed via build.target / optimizeDeps
  // above); esbuild's source transform doesn't down-level without an explicit
  // lower target, so the renderer stays on modern (esnext) syntax regardless.
  server: {
    port: 5290,
    strictPort: true, // fail immediately if 5290 is taken — never drift to 5291+
    // The dashboard source lives on the Windows drive (/mnt/d) and this dev
    // server runs under WSL. inotify does NOT deliver fs events for DrvFs
    // (Windows-mounted) files, so HMR never fires on edits. Poll instead so
    // edits to ChatOverlay.tsx / shell.ts hot-reload reliably.
    watch: { usePolling: true, interval: 250 },
  },
});
