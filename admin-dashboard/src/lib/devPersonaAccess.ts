/**
 * Dev persona controls are enabled by the build target, not Vite's mode.
 *
 * The hosted Dev dashboard is built into the backend image with a production
 * Vite build, so `import.meta.env.DEV` is false there even though the backend
 * is deliberately running in NODE_ENV=development. Production leaves the
 * build flag at its false default.
 */
export function isDevPersonaUiEnabled(config: { VITE_DEV_PERSONAS?: string }): boolean {
  return config.VITE_DEV_PERSONAS === 'true';
}

export const devPersonaUiEnabled = isDevPersonaUiEnabled(import.meta.env);
