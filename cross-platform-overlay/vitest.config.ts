import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default to 'node' for plain unit/logic tests. Renderer/React component
    // tests that need a DOM should opt in per-file with a docblock at the top:
    //   // @vitest-environment jsdom
    environment: 'node',
    globals: true,
    include: [
      '__tests__/**/*.{test,spec}.{js,ts}',
      'src/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['node_modules/**', 'dist-renderer/**', 'dist-electron/**'],
    coverage: {
      provider: 'v8',
      // Report-only: no thresholds enforced.
    },
  },
});
