/**
 * Network bridge — installs global `fetch` + `WebSocket` shims so the REAL,
 * UNMODIFIED admin-dashboard ChatOverlay component (and its `services/api`)
 * reach the live production relay through the Electron main-process proxy.
 *
 * The dashboard component:
 *   - calls `api.get('/api/channels')` etc. → plain `fetch('/api/...', {credentials:'include'})`
 *   - calls `fetch('/auth/ws-ticket')` then `new WebSocket('wss://host/ws?ticket=...')`
 *
 * We intercept both. Token auth (X-Auth-Token) is applied in main.js, so the
 * component needs zero changes.
 */

interface RelayBridge {
  getInfo(): Promise<{ clickThrough: boolean; toggleShortcut: string; platform: string; relayHost: string; appVersion?: string; keybinds?: Record<string, string>; isDev?: boolean }>;
  getRelayHostSync?(): string;
  onBlurInput?(cb: () => void): void;
  http(req: { method: string; path: string; body: string | null; headers: Record<string, string> }): Promise<{ status: number; body: string }>;
  wsOpen(id: string): void;
  wsSend(id: string, data: string): void;
  wsClose(id: string): void;
  onWsOpen(cb: (m: { id: string }) => void): void;
  onWsMessage(cb: (m: { id: string; data: string }) => void): void;
  onWsClose(cb: (m: { id: string; code: number; reason: string }) => void): void;
  onWsError(cb: (m: { id: string; message: string }) => void): void;
  onStatus(cb: (s: {
    state: string;
    message?: string;
    displayName?: string;
    discordLinked?: boolean;
    discordName?: string;
    discordUsername?: string;
    discordDisplayName?: string;
    discordAvatarUrl?: string | null;
    steamLinked?: boolean;
    username?: string;
  }) => void): void;
  onClickThrough(cb: (on: boolean) => void): void;
  // Shell window controls (the web component has no chrome of its own).
  minimizeWindow(): void;
  hideWindow(): void;
  closeWindow(): void;
  hideViaSlash(): void;
  setClickThrough(enabled: boolean): void;
  setInteractive(interactive: boolean): void;
  setModalInteractive?(open: boolean): void;
  saveSettings?(settings: unknown): void;
  // Set the FO76 character name as the chat display name (re-registers with the
  // backend). Resolves with the outcome; 'taken' means another user owns it.
  setIdentityName?(name: string): Promise<{ ok: boolean; reason?: string; displayName?: string; message?: string }>;
  collapse(headerHeight: number, fullAutoHide?: boolean): void;
  expand(focusInput: boolean): void;
  onFocusInput(cb: (on: boolean) => void): void;
  onForceExpand(cb: () => void): void;
  onCommand(cb: (cmd: string) => void): void;
  // Live keybind map pushed from main on (re)register — for the footer help text.
  onKeybinds?(cb: (kb: Record<string, string>) => void): void;
  // Position presets + provider OAuth.
  getBounds?(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void;
  resizeBounds?(bounds: { x: number; y: number; width: number; height: number }): void;
  /** WM-independent pointer-drag MOVE (ticket #104). Sends the desired window
   *  top-left {x,y}; main clamps to work area and applies setPosition. */
  moveBounds?(pos: { x: number; y: number }): void;
  /** Main-process drag-move (Linux): main reads the cursor via
   *  getCursorScreenPoint() so coords stay in DIP and never drift. Renderer just
   *  signals the gesture — start on pointerdown, tick on each move, end on up. */
  moveStart?(): void;
  moveTick?(): void;
  moveEnd?(): void;
  setWindowOpacity?(v: number): void;
  linkDiscord?(): void;
  linkSteam?(): void;
  openExternal?(url: string): void;
  /** Surface a renderer-side diagnostic line into the main-process log (main.log). */
  logDiag?(msg: string): void;
  // Discord link/supporter-role refresh: asks main to poll the backend and fires onDiscordStatus.
  refreshDiscordStatus?(): void;
  onDiscordStatus?(cb: (status: { linked: boolean; discordName: string }) => void): void;
  /** Steam OpenID link/status refresh for the desktop install. */
  refreshSteamStatus?(): void;
  onSteamStatus?(cb: (status: { linked: boolean; steamLinked?: boolean }) => void): void;
  /** Show the OS right-click context menu on the chat input (cut/copy/paste/select-all). */
  showInputContextMenu?(x?: number, y?: number): void;
  /** Return focus to Fallout 76 after sending a message. Blurs the overlay window. */
  returnToGame?(): void;
  /** Notify main whether the chat input is currently focused (for post-reload re-focus). */
  notifyInputFocusState?(focused: boolean): void;
  /** Game-gate: tell main whether the user is fully set up (authenticated + past onboarding).
   *  true → enforce FO76-must-be-running gate; false → allow show (onboarding/login reachable). */
  notifyChatActive?(active: boolean): void;
  /** Onboarding finished: engages the game-gate AND shows a guiding system notification
   *  (overlay stays up if FO76 is running, else drops to tray + "launch the game" toast). */
  notifyOnboardingComplete?(): void;
  /** In-game presence: main pushes the current FO76 game-running state (true = game is running).
   *  The renderer subscribes and sends client:status { inGame } over the WS whenever the value
   *  changes, so the backend can gate "online" status on in-game state rather than just WS open. */
  onGameState?(cb: (inGame: boolean) => void): void;
  /** WS lifecycle (hybrid): main pushes overlay visibility on show/hide.
   *  Combined with onGameState — connect when visible OR in-game; disconnect
   *  only when hidden AND game closed. 20s grace on hide applied in main.js. */
  onVisibility?(cb: (isVisible: boolean) => void): void;
  /** Cross-channel @mention: ask main to show the overlay from tray when an
   *  @mention arrives in a channel the user is NOT currently viewing. Main
   *  respects canShowOverlay() — it will NOT pop over the desktop when FO76 is
   *  not running (unless the user is privileged / forceVisible). userHidden is
   *  cleared the same way game-launch does so a single mention un-hides once. */
  showForMention?(): void;
  /** Main notifies the renderer once per session when a newer version is available
   *  (fired after the OS toast). The renderer uses this to show a red-dot indicator
   *  on the version string in the settings panel. */
  onUpdateAvailable?(cb: (payload: { latestVersion: string }) => void): void;
  /** Query main for a pending update version - catches update signals that fired
   *  before the onUpdateAvailable listener was registered on startup. */
  getPendingUpdate?(): Promise<string | null>;
  /** Dev-only: log in as a system persona, bypassing Discord OAuth.
   *  Hard-gated by !app.isPackaged in main.js — always { ok: false } in prod. */
  devLoginAs?(persona: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    relayBridge: RelayBridge;
    // Desktop-overlay shell parity hook the real ChatOverlay component reads
    // (getOverlayShell()): renders the FALLOUT 76 title + refresh/min/close in
    // its header. Set HERE (before the component module is imported) so it's
    // present on first render. Never set on the website.
    __FCM_OVERLAY_SHELL__?: {
      title: string;
      onRefresh?: () => void;
      onMinimize?: () => void;
      onClose?: () => void;
      onSettings?: () => void;
      // Absolute HTTP base of the relay (e.g. "http://localhost:7076" in dev,
      // "https://falloutchatmod.com" in prod). The overlay renderer is served
      // from the Vite/app origin, NOT the backend — and <img src> does NOT go
      // through the bridge fetch-proxy — so same-origin avatar paths
      // ("/avatars/<id>") must be resolved against THIS base to hit the backend.
      // Populated async from relayBridge.getInfo() right after the shell hook
      // is installed; consumers read it lazily when rendering avatars.
      relayBase?: string;
    };
  }
}

import {
  buildShellHook,
  applyRelayBase,
  installFetchShim,
  installWebSocketShim,
} from './bridge-core';

const bridge = window.relayBridge;

// Install the desktop-shell parity hook immediately. The refresh button re-fetches
// channels by remounting the route (custom event the renderer listens for); the
// gear opens the full desktop-parity settings panel; minimize/close go straight
// to the Electron IPC.
window.__FCM_OVERLAY_SHELL__ = buildShellHook(bridge, window);

// Set relayBase synchronously so avatar <img> tags have the correct base URL
// on first render. The async path caused a race where avatars fired onError
// before relayBase was ready, permanently showing letter fallbacks.
// Sync call — returns immediately before any component renders.
try { applyRelayBase(window.__FCM_OVERLAY_SHELL__, (bridge as any).getRelayHostSync?.()); } catch { /* non-fatal */ }
// Async fallback for environments where the sync path isn't available.
bridge.getInfo().then((info) => applyRelayBase(window.__FCM_OVERLAY_SHELL__, info?.relayHost || '')).catch(() => {});

// ── fetch shim ────────────────────────────────────────────────────────────────
// Only intercept same-origin relay paths (/api, /auth). Anything else (e.g.
// Vite asset requests, data URIs) falls through to the native fetch.
installFetchShim(window, bridge);

// ── WebSocket shim ──────────────────────────────────────────────────────────
// A minimal EventTarget-compatible WebSocket that proxies through main.js. The
// component only uses: new WebSocket(url), .onopen/.onclose/.onmessage,
// .readyState, .send(), .close(), and the WebSocket.OPEN constant. Native is
// kept on window.__NativeWebSocket in case anything else needs it.
installWebSocketShim(window as any, bridge);

export {};
