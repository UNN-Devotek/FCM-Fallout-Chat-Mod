import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dedicated Vitest config — kept separate from vite.config.ts so unit/component
// tests never interfere with the production `vite build` pipeline.
export default defineConfig({
  plugins: [react()],
  define: {
    // Mirrors the vite.config.ts define so the production constant resolves in tests.
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'tests/**', '.playwright-cli/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Thresholds intentionally omitted for now — report only.
    },
  },
});
