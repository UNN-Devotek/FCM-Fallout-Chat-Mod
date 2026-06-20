'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Locked-down bridge. The renderer's bridge.ts uses these to shim the global
// `fetch` + `WebSocket` so the REAL ChatOverlay component's own network layer
// transparently reaches the live relay (token auth applied in the main process).
contextBridge.exposeInMainWorld('relayBridge', {
  // App + relay metadata.
  getInfo: () => ipcRenderer.invoke('overlay:get-info'),
  // Synchronous relay host — used by bridge.ts to set relayBase before first render
  // so avatar <img> tags resolve against the backend, not the Vite dev origin.
  getRelayHostSync: () => ipcRenderer.sendSync('overlay:get-relay-host-sync'),

  // HTTP proxy: { method, path, body, headers } -> { status, body }.
  http: (reqDesc) => ipcRenderer.invoke('proxy:http', reqDesc),

  // WebSocket proxy (logical sockets keyed by id).
  wsOpen: (id) => ipcRenderer.send('proxy:ws:open', id),
  wsSend: (id, data) => ipcRenderer.send('proxy:ws:send', { id, data }),
  wsClose: (id) => ipcRenderer.send('proxy:ws:close', { id }),
  onWsOpen:    (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('proxy:ws:open',    h); return () => ipcRenderer.removeListener('proxy:ws:open',    h); },
  onWsMessage: (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('proxy:ws:message', h); return () => ipcRenderer.removeListener('proxy:ws:message', h); },
  onWsClose:   (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('proxy:ws:close',   h); return () => ipcRenderer.removeListener('proxy:ws:close',   h); },
  onWsError:   (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('proxy:ws:error',   h); return () => ipcRenderer.removeListener('proxy:ws:error',   h); },

  // Window controls (shell-provided chrome the web component lacks).
  // Usable WITHOUT global hotkeys — important under WSLg.
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  closeWindow: () => ipcRenderer.send('window:close'),
  hideViaSlash: () => ipcRenderer.send('window:hide-via-slash'),
  setClickThrough: (enabled) => ipcRenderer.send('overlay:set-click-through', enabled),

  // Auto click-through model: the renderer reports whether the pointer is over
  // interactive UI; main flips setIgnoreMouseEvents so clicks pass through to the
  // game when the pointer is over empty/transparent space (native builds only).
  setInteractive: (interactive) => ipcRenderer.send('overlay:set-interactive', interactive),
  // Pin full interactivity while a renderer modal (settings/onboarding) is open,
  // overriding auto/manual click-through so drags (e.g. sliders) work.
  setModalInteractive: (open) => ipcRenderer.send('overlay:set-modal', open),
  // Persist the full settings superset (incl. keybinds) to the Electron state
  // file so the main process can re-register global shortcuts from them.
  saveSettings: (settings) => ipcRenderer.send('overlay:save-settings', settings),
  // Identity: set the FO76 character name as the chat display name. Re-registers
  // with the backend and re-broadcasts authenticated status. Resolves with
  // { ok: true, displayName } or { ok: false, reason } ('taken' | 'empty' | ...).
  setIdentityName: (name) => ipcRenderer.invoke('identity:set-name', name),
  // Idle collapse/expand → main resizes the window height (top anchored).
  collapse: (headerHeight) => ipcRenderer.send('overlay:collapse', { headerHeight }),
  expand: (focusInput) => ipcRenderer.send('overlay:expand', { focusInput }),

  // Position presets: capture live bounds (SET POS) + snap to a saved rect.
  getBounds: () => ipcRenderer.invoke('window:get-bounds'),
  setBounds: (bounds) => ipcRenderer.send('window:set-bounds', bounds),
  // In-app edge resize from shell.ts resize zones. Sends the computed new bounds
  // (after pointer-drag math) to main which clamps + applies via setBounds.
  resizeBounds: (bounds) => ipcRenderer.send('overlay:resize-bounds', bounds),
  // WM-independent pointer-drag MOVE (ticket #104). Sends the desired top-left
  // position; main clamps to work area and calls setPosition. Used on Wayland
  // where -webkit-app-region:drag is unreliable for frameless windows.
  moveBounds: (pos) => ipcRenderer.send('overlay:move-bounds', pos),
  // Main-process drag-move (Linux): renderer only signals the gesture; main reads
  // the cursor via getCursorScreenPoint() so coords stay in DIP and don't drift.
  moveStart: () => ipcRenderer.send('overlay:move-start'),
  moveTick: () => ipcRenderer.send('overlay:move-tick'),
  moveEnd: () => ipcRenderer.send('overlay:move-end'),
  // Chrome Opacity = whole-window translucency (live; affects the modal too).
  setWindowOpacity: (v) => ipcRenderer.send('window:set-opacity', v),

  // Discord OAuth: open the desktop-client link/relink flow (or any URL) in the
  // user's default browser.
  linkDiscord: () => ipcRenderer.send('discord:link'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  // Surface a renderer-side diagnostic line into the main-process log file.
  logDiag: (msg) => ipcRenderer.send('shell:diag', msg),
  // Trigger a real-time Discord link status poll from the backend.
  // Main responds with 'relay:discord-status' when the result arrives.
  refreshDiscordStatus: () => ipcRenderer.send('discord:refresh-status'),
  // Called when main has a fresh Discord link status (post-link or on focus).
  onDiscordStatus: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('relay:discord-status', h); return () => ipcRenderer.removeListener('relay:discord-status', h); },

  // Lifecycle.
  onStatus:      (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on('relay:status',          h); return () => ipcRenderer.removeListener('relay:status',          h); },
  onClickThrough:(cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('overlay:click-through', h); return () => ipcRenderer.removeListener('overlay:click-through', h); },
  // Main asks the renderer to focus the chat input (Insert / focus-to-chat).
  onFocusInput:  (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('overlay:focus-input',   h); return () => ipcRenderer.removeListener('overlay:focus-input',   h); },
  onBlurInput:   (cb) => { const h = ()      => cb();  ipcRenderer.on('overlay:blur-input',    h); return () => ipcRenderer.removeListener('overlay:blur-input',    h); },
  // Main asks the renderer to clear idle state + un-collapse (focus-to-chat).
  onForceExpand: (cb) => { const h = ()      => cb();  ipcRenderer.on('overlay:force-expand',  h); return () => ipcRenderer.removeListener('overlay:force-expand',  h); },
  // Main notifies the renderer when a newer version is available (fires once per
  // session, after the OS toast). Used to show a persistent red-dot indicator.
  onUpdateAvailable: (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('relay:update-available', h); return () => ipcRenderer.removeListener('relay:update-available', h); },
  // Query main for a pending update version - catches signals that arrived
  // before the onUpdateAvailable listener was registered.
  getPendingUpdate: () => ipcRenderer.invoke('overlay:get-pending-update'),
  // Main → renderer commands: 'channel:next' | 'channel:prev' | 'settings:open' | 'party:recent'.
  onCommand:     (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('overlay:command',       h); return () => ipcRenderer.removeListener('overlay:command',       h); },
  // Main pushes the live keybind map whenever hotkeys are (re)registered, so the
  // footer help text can show the user's actual bound keys.
  onKeybinds:    (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('overlay:keybinds',      h); return () => ipcRenderer.removeListener('overlay:keybinds',      h); },

  // Task 3: Right-click context menu on the chat input (cut/copy/paste/select-all).
  // Renderer fires this on contextmenu events in the input area.
  showInputContextMenu: (x, y) => ipcRenderer.send('input:context-menu', { x, y }),

  // Return focus to Fallout 76 after sending a message — blurs the overlay so
  // the game reclaims foreground. Call this after Enter is pressed in the chat
  // input. Optional: the component checks window.relayBridge.returnToGame?.()
  returnToGame: () => ipcRenderer.send('overlay:return-to-game'),

  // Notify main of chat-input focus state so it can re-focus after a reload.
  notifyInputFocusState: (focused) => ipcRenderer.send('overlay:input-focus-state', focused),

  // Game-gate: renderer tells main whether the user is fully set up (authenticated
  // + past onboarding). When true, main enforces the FO76-must-be-running gate.
  // Send true once relay:status=authenticated AND onboarding is not needed;
  // send false during onboarding, login, or error states. Reset automatically
  // by main on each renderer reload.
  notifyChatActive: (active) => ipcRenderer.send('overlay:chat-active', active),

  // Onboarding finished: engages the game-gate (chatActive=true) AND shows a
  // system notification guiding the user — overlay stays up if FO76 is running,
  // otherwise it drops to the tray and tells them to launch the game (it then
  // auto-appears). Distinct from notifyChatActive so the toast only fires on a
  // genuine onboarding completion, not on every set-up startup.
  notifyOnboardingComplete: () => ipcRenderer.send('overlay:onboarding-complete'),

  // In-game presence: main pushes the current gameRunning state whenever it
  // changes and once on did-finish-load. The renderer subscribes and sends
  // client:status { inGame } over the WS so the backend can gate "online" status.
  onGameState:  (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('overlay:game-state',  h); return () => ipcRenderer.removeListener('overlay:game-state',  h); },

  // Main → renderer: overlay window visibility (show/hide). Feeds the hybrid WS
  // gate (connect when visible OR in-game). 20s grace on hide is applied in main.
  onVisibility: (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on('overlay:visibility',  h); return () => ipcRenderer.removeListener('overlay:visibility',  h); },

  // Cross-channel @mention: show the overlay from tray (if hidden). Main respects
  // canShowOverlay() so the window won't appear over the desktop when FO76 is not
  // running (unless privileged / forceVisible). userHidden is cleared on show so a
  // single mention gesture un-hides the overlay once, matching game-launch behavior.
  showForMention: () => ipcRenderer.send('overlay:show-for-mention'),

  // Dev-only: log in as a system persona without Discord OAuth.
  // main.js hard-gates this behind !app.isPackaged — returns { ok: false } in prod.
  devLoginAs: (persona) => ipcRenderer.invoke('overlay:dev-login-as', persona),
});

// Durable settings seeded SYNCHRONOUSLY from the Electron state file
// (overlay-state.json → settings). Exposed as a global the renderer reads at
// startup so loadShellSettings() can fall back to it when localStorage is empty
// (fresh install / rebuild). This restores the user's applied settings AND the
// `onboarded` flag, so an already-set-up user skips onboarding. Null when there
// are no persisted settings (genuine first run).
(() => {
  let saved = null;
  try { saved = ipcRenderer.sendSync('overlay:saved-settings-sync'); } catch { /* ignore */ }
  try { contextBridge.exposeInMainWorld('__FCM_SAVED_SETTINGS__', saved); } catch { /* ignore */ }
})();
