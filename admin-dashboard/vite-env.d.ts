/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_PERSONAS?: string;
}

// Injected at build time by vite.config.ts (`define` → reads package.json "version").
declare const __APP_VERSION__: string;
