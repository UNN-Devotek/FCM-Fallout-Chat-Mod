import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import pkg from './package.json' with { type: 'json' };

export default defineConfig(({ mode }) => {
  // loadEnv reads .env, .env.local, .env.[mode], .env.[mode].local — the same
  // files Vite uses for import.meta.env. Third arg '' loads ALL vars, not just VITE_.
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_API_URL || 'http://localhost:7177';

  // Path A: when VITE_API_URL points at a remote host (e.g. https://dev.falloutchatmod.com),
  // the Vite dev server proxies /api, /auth, and /ws to that host with changeOrigin so the
  // browser sees same-origin requests and session cookies flow correctly. No CF Access headers
  // are needed — the dev backend accepts plain session cookies. When VITE_API_URL is unset or
  // points at localhost the proxy works identically, targeting the local backend on port 7177.

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@promo': resolve(__dirname, '../marketing/promo/src'),
        // Promo files live outside admin-dashboard/ so Rollup's node_modules walk
        // never reaches our node_modules. Pin these packages explicitly.
        // (react/react-dom needed since Vite 8's Rolldown — unlike Vite 6's esbuild —
        // won't resolve them for the @promo sources in the Docker build, where only
        // marketing/promo/src is copied without its node_modules.)
        react: resolve(__dirname, 'node_modules/react'),
        'react-dom': resolve(__dirname, 'node_modules/react-dom'),
        remotion: resolve(__dirname, 'node_modules/remotion'),
        '@remotion/player': resolve(__dirname, 'node_modules/@remotion/player'),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: 7075,
      host: true,
      allowedHosts: true,
      watch: {
        usePolling: true,
        interval: 300,
      },
      proxy: {
        // Local backend listens on 7177 (.env.local PORT=7177).
        // Override with VITE_API_URL in .env.local to point at another instance.
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/auth': {
          target: backendUrl,
          changeOrigin: true,
        },
        // WebSocket relay — the chat client connects to `window.location.host/ws`,
        // so it MUST be proxied (with ws:true) or live chat silently fails in dev.
        '/ws': {
          target: backendUrl,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
