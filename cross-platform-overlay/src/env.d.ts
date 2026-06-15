/// <reference types="vite/client" />

// Defined by Vite (vite.config.ts `define`). The dashboard's ChatOverlay
// renders `v{__APP_VERSION__}` in its settings panel.
declare const __APP_VERSION__: string;

// `@emoji-mart/data` ships without bundled types in some setups.
declare module '@emoji-mart/data';
