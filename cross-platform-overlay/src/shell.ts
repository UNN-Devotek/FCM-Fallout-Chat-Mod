/**
 * Electron overlay shell — desktop-parity behaviors layered over the shared
 * ChatOverlay component without forking it:
 *
 *   1. Idle auto-collapse: after idle time (default 25 s) collapse to the
 *      header/tab strip; expand on any interaction or a new message.
 *   2. Full settings panel: theme, opacities, scanline, font, keybinds,
 *      blocked users, channel filters. Persisted to the Electron state file
 *      and mirrored to the localStorage key the React component reads.
 *   3. Main→renderer commands (channel:next / channel:prev / settings:open)
 *      driven by Electron globalShortcuts.
 *   4. Auto click-through hover reporting (native builds only).
 *
 * Visual settings the component doesn't expose (background dim, scanline
 * intensity) are applied as shell-managed CSS layers.
 */

import {
  RESIZE_MIN_WIDTH,
  RESIZE_MIN_HEIGHT,
  chromeThemeVars,
  accelFromEvent as accelFromEventCore,
  prettyAccel as prettyAccelCore,
  collectChannels as collectChannelsCore,
  nextNavIndex,
  scaleZoomValue,
  chromeBgAlpha,
  textOpacityValue,
  scanlineOpacityValue,
  clampIdleCollapseSeconds,
  IDLE_COLLAPSE_SECONDS_MIN,
  IDLE_COLLAPSE_SECONDS_MAX,
  IDLE_COLLAPSE_SECONDS_DEFAULT,
  shellToWebSettings,
  resolveCollapsedHeight,
  revealCollapsedElements,
  computeResizeBounds,
  isDragTarget as isDragTargetCore,
  detectLinuxRenderer,
  gameReservedWarning,
  mergeKeybindDefaults,
  type ResizeEdge,
} from './shell-core';

// ── Settings model (desktop-parity superset) ──────────────────────────────────

export interface ShellSettings {
  playsFo76: boolean;
  fo76Name: string;
  // Discord link state; the real link happens via browser OAuth (linkDiscord()).
  discordLinked: boolean;
  discordName: string;
  // Profile fields recalled from the latest relay:status — persist across settings opens.
  discordAvatarUrl: string;    // Discord CDN avatar URL or ''
  discordDisplayName: string;  // Discord display name (may differ from discordName)
  discordUsername: string;     // Discord @handle
  resolvedDisplayName: string; // Chat display name resolved by the backend
  // Mirrored into the React component (fcm_web_overlay_settings):
  themeId: string;          // default 'fo76-wasteland'
  windowOpacity: number;    // 0.3..1.0  → background/chrome alpha
  textOpacity: number;      // 0.3..1.0
  fontSize: number;         // px
  showHints: boolean;
  // Shell-managed (no native component support → applied as CSS layers):
  backgroundOpacity: number; // 0..1 extra background dim
  scanlineIntensity: number; // 0..1 (default 0.08)
  fadeWhenIdle: boolean;     // default true
  // Seconds of inactivity before collapsing to the header strip (5..120, default 25).
  idleCollapseSeconds: number;
  // Per-message timestamps rendered in the viewer's local time. Mirrored to WEB_SETTINGS_KEY.
  showTimestamps: boolean;
  timestampFormat: '12h' | '24h';
  blockedUsers: string[];
  channelFilters: string[];
  // Electron globalShortcut accelerator strings.
  keybinds: {
    toggle: string;
    focus: string;
    clickThrough: string;
    nextChannel: string;
    prevChannel: string;
    settings: string;
    recentParty: string;
    goFo76: string;
    party1: string;
    party2: string;
    party3: string;
    party4: string;
    party5: string;
    party6: string;
    party7: string;
    party8: string;
  };
  // See KEYBIND_RESET_VERSION. Persisted so the one-time reset runs exactly once per bump.
  keybindsResetVersion?: number;
  // Position presets (Shift+F1..F8): each stores a hotkey + captured window rect.
  presets: PositionPreset[];
  // Set to true once onboarding is completed or skipped; only shown on fresh install.
  onboarded: boolean;
}

export interface PositionPreset {
  keybind: string;          // Electron accelerator, e.g. 'Shift+F1'
  x?: number; y?: number;   // captured window position (undefined = unset)
  w?: number; h?: number;   // captured window size
}

// Bump to fill any NEW default binds for existing users exactly once. The reset is
// NON-DESTRUCTIVE (issue #136 §3.1): it only fills unset/blank binds and preserves
// every bind the user customised (see mergeKeybindDefaults), so a reinstall or a
// version bump never clobbers a working config. Must NOT be baked into
// DEFAULT_SHELL_SETTINGS — the default leaves keybindsResetVersion undefined (→ 0)
// so the guard (stored < current) can fire.
// v5: goFo76 and recentParty default to '' — single-char defaults (/,\) were broken
//     because isSinglePrintableChar gating prevented them from ever firing.
export const KEYBIND_RESET_VERSION = 5;

export const DEFAULT_SHELL_SETTINGS: ShellSettings = {
  playsFo76: false,
  fo76Name: '',
  discordLinked: false,
  discordName: '',
  discordAvatarUrl: '',
  discordDisplayName: '',
  discordUsername: '',
  resolvedDisplayName: '',
  themeId: 'fo76-wasteland',
  windowOpacity: 0.9,
  textOpacity: 1.0,
  fontSize: 14,
  showHints: true,
  backgroundOpacity: 0,
  // Low default: scanline divs are dark (see index.html), so 0.08 gives a faint
  // CRT texture rather than heavy bars.
  scanlineIntensity: 0.08,
  fadeWhenIdle: true,
  idleCollapseSeconds: IDLE_COLLAPSE_SECONDS_DEFAULT,
  showTimestamps: false,
  timestampFormat: '12h',
  blockedUsers: [],
  channelFilters: [],
  // Single-key defaults from the nav cluster (not used by FO76 gameplay binds).
  // Global single keys are intercepted before the game sees them.
  keybinds: {
    focus: 'Insert',        // open + focus chat input
    toggle: 'Delete',       // hide / show the overlay
    clickThrough: 'End',    // toggle click-through
    prevChannel: 'PageUp',  // cycle channel ◄
    nextChannel: 'PageDown',// cycle channel ►
    settings: 'Home',       // open settings
    recentParty: '',        // jump to the party that last posted in General (user-bindable, no safe default)
    goFo76: '',             // jump to the Fallout 76 (General) tab (user-bindable, no safe default)
    party1: '', party2: '', party3: '', party4: '',
    party5: '', party6: '', party7: '', party8: '',
  },
  // keybindsResetVersion intentionally omitted — see KEYBIND_RESET_VERSION.
  presets: Array.from({ length: 8 }, (_, i) => ({ keybind: `Shift+F${i + 1}` })),
  onboarded: false,
};

const WEB_SETTINGS_KEY = 'fcm_web_overlay_settings';
const SHELL_SETTINGS_KEY = 'fcm_shell_settings';

const THEMES: { id: string; name: string }[] = [
  { id: 'fo76-wasteland', name: 'Fallout 76 (amber)' },
  { id: 'vault-tec-green', name: 'Vault-Tec Green' },
  { id: 'amber', name: 'Amber' },
  { id: 'white', name: 'White' },
];

/**
 * Apply the chosen theme's chrome colors as CSS variables on :root so the
 * shell-bar buttons and loading/error screens follow the theme. Call before
 * first paint and again whenever the theme changes. Sets:
 *   --shell-primary      accent (buttons, borders, status)
 *   --shell-primary-dim  accent at low alpha (hover backgrounds)
 *   --shell-text         readable body/loading text
 */
export function applyShellChromeTheme(themeId?: string) {
  const id = themeId || loadShellSettings().themeId;
  const vars = chromeThemeVars(id);
  const root = document.documentElement.style;
  root.setProperty('--shell-primary', vars.primary);
  root.setProperty('--shell-text', vars.text);
  // 18% alpha tint for hover backgrounds (hex8).
  root.setProperty('--shell-primary-dim', vars.primaryDim);
}

// ── Persistence ────────────────────────────────────────────────────────────────

export function loadShellSettings(): ShellSettings {
  let s: ShellSettings = { ...DEFAULT_SHELL_SETTINGS };
  try {
    const raw = localStorage.getItem(SHELL_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      s = { ...s, ...parsed, keybinds: { ...s.keybinds, ...(parsed.keybinds || {}) } };
    } else {
      // No local settings — fresh install or wiped localStorage. Fall back to
      // settings seeded synchronously by preload from overlay-state.json into
      // __FCM_SAVED_SETTINGS__. Restores applied settings AND onboarded flag.
      const seeded = (window as unknown as { __FCM_SAVED_SETTINGS__?: Partial<ShellSettings> | null }).__FCM_SAVED_SETTINGS__;
      if (seeded && typeof seeded === 'object') {
        s = { ...s, ...seeded, keybinds: { ...s.keybinds, ...(seeded.keybinds || {}) } };
        // Mirror into localStorage for consistent reads this session.
        try { localStorage.setItem(SHELL_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
      }
    }
  } catch { /* defaults */ }
  // One-time keybind reset (NON-DESTRUCTIVE — issue #136 §3.1): when the persisted
  // version is older, fill only UNSET/blank binds with the current defaults and keep
  // every bind the user actually set, then stamp the version. The old code wiped the
  // whole map back to defaults, so a reinstall re-broke a working config; now it
  // never clobbers a customised bind.
  if ((s.keybindsResetVersion ?? 0) < KEYBIND_RESET_VERSION) {
    s.keybinds = mergeKeybindDefaults(s.keybinds, DEFAULT_SHELL_SETTINGS.keybinds);
    s.keybindsResetVersion = KEYBIND_RESET_VERSION;
    try { localStorage.setItem(SHELL_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }
  // Always present exactly 8 presets (fill any gaps with default Shift+F<n>).
  const saved = Array.isArray(s.presets) ? s.presets : [];
  s.presets = Array.from({ length: 8 }, (_, i) => ({
    keybind: saved[i]?.keybind || `Shift+F${i + 1}`,
    x: saved[i]?.x, y: saved[i]?.y, w: saved[i]?.w, h: saved[i]?.h,
  }));
  return s;
}

// Synchronous local persistence — safe to call on every slider tick.
function persistLocal(s: ShellSettings) {
  try { localStorage.setItem(SHELL_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  // Mirror the subset the React component reads natively (see shellToWebSettings in shell-core).
  try {
    localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(shellToWebSettings(s)));
  } catch { /* ignore */ }
}

// Flush to the Electron state file (survives localStorage wipe; re-registers
// globalShortcuts). Debounced away from per-tick drags.
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
function flushToMain(s: ShellSettings) {
  try { window.relayBridge.saveSettings?.(s); } catch { /* optional */ }
}
function scheduleFlush(s: ShellSettings) {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => flushToMain(s), 400);
}

function persistShellSettings(s: ShellSettings) {
  persistLocal(s);
  flushToMain(s);
}

// ── Visual layers the component doesn't expose ────────────────────────────────

function applyVisualLayers(s: ShellSettings) {
  // The bg-dim plate is retired — background opacity is now applied via
  // --fcm-chrome-bg-alpha. Keep the element pinned invisible.
  const dim = document.getElementById('shell-bg-dim');
  if (dim) dim.style.opacity = '0';
  const scan = document.getElementById('shell-scanline');
  if (scan) scan.style.opacity = String(scanlineOpacityValue(s.scanlineIntensity));
}

// Apply chrome + text opacity live (overlay + modal):
//   --fcm-chrome-bg-alpha  makes panel/tab backgrounds transparent (window stays at 1.0).
//   --fcm-text-opacity     live preview; the overlay component applies it on next remount.
function applyWindowVisual(s: ShellSettings) {
  const chromeAlpha = chromeBgAlpha(s.windowOpacity);
  document.documentElement.style.setProperty('--fcm-chrome-bg-alpha', String(chromeAlpha));
  // Notify main so it can restore the value on reload.
  try { window.relayBridge.setWindowOpacity?.(chromeAlpha); } catch { /* ignore */ }
  document.documentElement.style.setProperty('--fcm-text-opacity', String(textOpacityValue(s.textOpacity)));
  // Keep the settings panel + backdrop READABLE — clear any inline overrides so
  // they use their solid CSS values (never dim the chat text behind them).
  const panel = document.getElementById('shell-settings');
  if (panel) panel.style.background = ''; // keep solid CSS values; never dim behind modal
  const backdrop = document.getElementById('shell-settings-backdrop');
  if (backdrop) backdrop.style.background = '';
}

// Scale the whole overlay (#root) live via CSS zoom. No window-height clamp —
// the old clamp caused a Wayland bug where a transient resize hit the 0.6 floor
// and permanently shrank the font. Overflow is handled by the scrollable message list.
// Leave `zoom` unset at default scale: even zoom:1 establishes a containing block
// for position:fixed descendants, breaking the emoji/GIF picker anchor.
// The settings modal is NOT zoomed — zooming a fixed, centered panel overflowed
// the viewport and didn't revert cleanly.
function applyScale(s: ShellSettings) {
  const root = document.getElementById('root') as HTMLElement | null;
  if (root) root.style.zoom = scaleZoomValue(s.fontSize);
  const panel = document.getElementById('shell-settings') as HTMLElement | null;
  if (panel && panel.style.zoom) panel.style.zoom = ''; // clear stale zoom from older builds
}

// ── Idle auto-collapse ────────────────────────────────────────────────────────

// Idle-collapse delay in ms. Updated live when settings change.
let idleFadeMs = IDLE_COLLAPSE_SECONDS_DEFAULT * 1000;
/** Set the idle-collapse delay from a (possibly untrusted) seconds value. */
function setIdleFadeFromSeconds(seconds: number | undefined | null): void {
  idleFadeMs = clampIdleCollapseSeconds(seconds) * 1000;
}
// Debounce message-driven expand so a burst of WS messages counts as one activity event.
const MSG_ACTIVITY_DEBOUNCE = 1500; // ms
let idleTimer: ReturnType<typeof setInterval> | null = null;
let lastActivityMs = Date.now();
let collapsed = false;
let fadeEnabled = true;
let msgActivityTimeout: ReturnType<typeof setTimeout> | null = null;
let msgObserver: MutationObserver | null = null;
// Elements hidden during collapse (body + input + footer below the sub-tab row).
// Walking the sub-tab row's following siblings is structure-independent; the old
// nth-child rule was brittle and could hide the sub-tab row itself.
let collapsedHidden: HTMLElement[] = [];
// Timestamp of last collapse/expand. The main process animates the window height
// over ~240ms, emitting resize events that must NOT re-clamp the scale mid-animation
// (tabs would visibly shrink and snap back). Suppress applyScale during settlement.
let lastTransitionMs = 0;
const TRANSITION_SETTLE_MS = 550;

// Collapsed height = shell drag strip + both tab rows (no body, no input).
// Measured live from the sub-tab row bottom so it tracks font-size changes.
// SAFE_HEADER_DIP is the fallback when a trustworthy measurement isn't available;
// it must show both tab rows but never reveal the message body/input.
const SAFE_HEADER_DIP = 62;  // main-tab row (~34) + sub-tab row (~28), before barH
// Plausibility band (DIP, excluding the shell bar). Anything outside [MIN, MAX]
// is a bad measurement (transient mid-reflow or a descendant rect into the body)
// and is rejected in favour of SAFE_HEADER_DIP.
const HEADER_DIP_MIN = 24;
const HEADER_DIP_MAX = 160;
// Does getBoundingClientRect() already include the CSS `zoom` on an ancestor?
// Chromium ≤127 (Electron ≤31) returned UNSCALED CSS-px; Chromium 138 (Electron 39)
// returns zoom-SCALED px. Detected once via an offscreen probe (a 100px box under
// zoom:2 measures 200 when scaled). Cached — the answer is constant per Chromium
// build. Does NOT touch #root, so it never perturbs the live UI.
let _rectsZoomScaledCache: boolean | null = null;
function rectsAreZoomScaled(): boolean {
  if (_rectsZoomScaledCache !== null) return _rectsZoomScaledCache;
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;zoom:2;pointer-events:none;visibility:hidden';
    const inner = document.createElement('div');
    inner.style.cssText = 'width:100px;height:1px';
    probe.appendChild(inner);
    document.body.appendChild(probe);
    const w = inner.getBoundingClientRect().width;
    document.body.removeChild(probe);
    _rectsZoomScaledCache = w > 150; // 200 → scaled, 100 → not
  } catch {
    _rectsZoomScaledCache = true; // modern Chromium default
  }
  return _rectsZoomScaledCache;
}

function headerStripHeight(): number {
  const bar = document.getElementById('shell-bar');
  const barH = bar ? bar.getBoundingClientRect().height : 0; // outside #root → visual px
  const host = document.getElementById('shell-overlay-host');

  const root = document.getElementById('root');
  const zoomStr = root ? root.style.zoom : '';
  const zoomFactor = zoomStr ? (parseFloat(zoomStr) || 1) : 1;
  // Raw getBoundingClientRect px → visual/DIP px. On modern Chromium the rect is
  // ALREADY zoom-scaled (factor 1); on Chromium ≤127 it's unscaled (multiply by
  // the zoom). Using the wrong factor was the "collapses to the input box at
  // Scale > 1" bug — the old code unconditionally multiplied, double-applying the
  // zoom on Electron 39 and leaving the window tall enough to show the input.
  const rectToVisual = rectsAreZoomScaled() ? 1 : zoomFactor;

  let rawDelta: number | null = null;
  if (host) {
    const hostTop = host.getBoundingClientRect().top;
    const subRow = subTabRowEl();
    if (subRow) {
      // Anchor to the lowest VISIBLE bottom edge among the sub-tab row and its
      // descendants (the Party row nests tabs in an inner flex container that can
      // render a hair taller). Cap the search at rowBottom + ~8 visual px of slack
      // so a transient / mid-reflow absolute descendant can't drag the anchor into
      // the message body.
      const rowBottom = subRow.getBoundingClientRect().bottom;
      const childCeil = rowBottom + 8 / rectToVisual; // ~8 visual px in raw-rect units
      let bottom = rowBottom;
      subRow.querySelectorAll<HTMLElement>('*').forEach((c) => {
        if (c.offsetParent === null) return;
        if (c.getAttribute('aria-hidden') === 'true') return;
        if (getComputedStyle(c).visibility === 'hidden') return;
        const cb = c.getBoundingClientRect().bottom;
        if (cb > bottom && cb <= childCeil) bottom = cb;
      });
      rawDelta = bottom - hostTop;
    }
  }

  return resolveCollapsedHeight({
    barH,
    rawDelta,
    rectToVisual,
    safeVisual: SAFE_HEADER_DIP,
    minVisual: HEADER_DIP_MIN,
    maxVisual: HEADER_DIP_MAX,
  });
}

// Hide everything below the sub-tab row (body + input + footer) by walking
// following siblings. Anchor preference:
//   1. the resolved (visible) sub-tab row — keeps both tab rows.
//   2. fallback: the main-tab row (first child), which still never reveals
//      the body/input. Never use querySelector('*'), which could pick a nested
//      node and blank the tabs.
// Idempotent — rebuilds collapsedHidden from scratch each call.
function applyCollapsedHidden() {
  const resolvedSub = subTabRowEl();
  const container = resolvedSub?.parentElement
    ?? (document.getElementById('shell-overlay-host')?.firstElementChild as HTMLElement | null);
  const anchor: HTMLElement | null = resolvedSub
    ?? (container?.firstElementChild as HTMLElement | null);
  collapsedHidden = [];
  let sib = anchor?.nextElementSibling as HTMLElement | null;
  while (sib) {
    sib.classList.add('fcm-collapsed-hidden');
    collapsedHidden.push(sib);
    sib = sib.nextElementSibling as HTMLElement | null;
  }
}

function setCollapsed(next: boolean, focusInput = false) {
  if (collapsed === next) return;
  lastTransitionMs = Date.now();
  const root = document.getElementById('root');
  if (next) {
    // Measure the strip height BEFORE applying the 'collapsed' class so the
    // sub-tab row is still in its normal position when we read its offset.
    const h = headerStripHeight();
    applyCollapsedHidden();
    collapsed = true;
    root?.classList.add('collapsed');
    window.relayBridge.collapse(h);
    // Notify the React overlay that it idle-collapsed so it can close any
    // absolutely-positioned floating UI (e.g. the party member panel) that
    // would otherwise hang over the collapsed header strip.
    try { window.dispatchEvent(new CustomEvent('fcm-overlay-collapsed')); } catch { /* non-fatal */ }
  } else {
    collapsed = false;
    // Keep 'collapsed' on root through the 240ms expand animation — removing it
    // immediately flashes the header from dark to transparent while the window
    // is still at header height. Strip it only after the window is full-size.
    window.relayBridge.expand(focusInput);
    const hiddenEls = collapsedHidden.slice();
    collapsedHidden = [];
    // 260ms > 240ms animation — reveal content once fully expanded.
    setTimeout(() => {
      if (collapsed) return;
      revealCollapsedElements(root, hiddenEls);
      // Jump the feed to the latest message so the user sees the most recent
      // chat after expanding. Defer a frame so the body has laid out first.
      scrollMessagesToBottomDeferred();
    }, 260);
  }
}

// Dispatch 'fcm-scroll-bottom' so ChatOverlay scrolls its message list to the
// latest message. Direct scrollTop writes don't survive React re-renders.
// Three dispatches cover: initial layout (rAF), React settle (120ms), and the
// Linux/XWayland case where mainWindow.focus() triggers a KWin resize that resets
// scrollTop to 0 — the 350ms retry lands after that reflow.
function scrollMessagesToBottomDeferred() {
  try {
    requestAnimationFrame(() => {
      try { window.dispatchEvent(new Event('fcm-scroll-bottom')); } catch { /* non-fatal */ }
      setTimeout(() => {
        try { window.dispatchEvent(new Event('fcm-scroll-bottom')); } catch { /* non-fatal */ }
      }, 120);
      setTimeout(() => {
        try { window.dispatchEvent(new Event('fcm-scroll-bottom')); } catch { /* non-fatal */ }
      }, 350);
    });
  } catch { /* non-fatal */ }
}

// Re-assert the collapsed layout after an external resize (e.g. FO76 launch/close
// on Wayland). A compositor-driven resize can strip the fcm-collapsed-hidden class
// and scroll the message list, causing the input to peek into view. This re-applies
// the hidden class, resets any scroll the React side applied, and re-sends the
// collapse height. Does NOT focus the input or scrollIntoView — both cause the
// jump-to-input. Only runs while collapsed.
function reassertCollapsed() {
  if (!collapsed) return;
  applyCollapsedHidden();
  // Reset any scroll the React overlay applied so the input can't be revealed.
  const host = document.getElementById('shell-overlay-host');
  if (host && host.scrollTop !== 0) host.scrollTop = 0;
  const scroller = document.scrollingElement as HTMLElement | null;
  if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0;
  // Re-anchor to the header strip; suppress scale re-clamp during settlement.
  lastTransitionMs = Date.now();
  try { window.relayBridge.collapse(headerStripHeight()); } catch { /* non-fatal */ }
}

/** Reset the idle timer + expand (desktop MarkChatActivity). */
export function markActivity() {
  lastActivityMs = Date.now();
  if (collapsed) setCollapsed(false);
}

/** Mark activity from an incoming message. Debounced to prevent burst thrashing. */
function markMessageActivity() {
  if (msgActivityTimeout) return; // already scheduled, skip duplicate
  msgActivityTimeout = setTimeout(() => {
    msgActivityTimeout = null;
    markActivity();
  }, MSG_ACTIVITY_DEBOUNCE);
}

function isSettingsOpen(): boolean {
  return !!document.getElementById('shell-settings-backdrop')?.classList.contains('open');
}

function isOnboardingOpen(): boolean {
  return !!document.getElementById('shell-onboarding-backdrop')?.classList.contains('open');
}

function tickIdle() {
  if (!fadeEnabled) { if (collapsed) setCollapsed(false); return; }
  // Never auto-hide while settings, onboarding, or the Discord login wall is open.
  if (isSettingsOpen() || isOnboardingOpen() || !!document.getElementById('shell-discord-login-wall')) { lastActivityMs = Date.now(); return; }
  // Hold the idle collapse while a right-click context menu is open (the React
  // overlay sets window.__fcmMenuOpen true while any ctx menu / popover is up).
  // Keep the timer reset so the overlay never auto-hides mid-menu; normal idle
  // resumes the moment the menu closes and the flag clears.
  if ((window as unknown as { __fcmMenuOpen?: boolean }).__fcmMenuOpen) { lastActivityMs = Date.now(); return; }
  // Don't collapse while the user is typing (input focused) — matches the
  // desktop's `!_inputActive` guard.
  const active = document.activeElement as HTMLElement | null;
  const typing = !!active && (
    active.tagName === 'TEXTAREA'
    || active.tagName === 'INPUT'
    // The overlay's rich chat input is a contentEditable <div> — treat focus on
    // it the same as a focused textarea so the overlay never collapses mid-type.
    || active.isContentEditable
  );
  if (typing) { lastActivityMs = Date.now(); return; }
  if (Date.now() - lastActivityMs >= idleFadeMs) setCollapsed(true);
}

function startIdleLoop(s: ShellSettings) {
  fadeEnabled = s.fadeWhenIdle;
  setIdleFadeFromSeconds(s.idleCollapseSeconds);
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = setInterval(tickIdle, 1000);
  // Test hooks for CDP-driven QA: deterministically trigger collapse without
  // waiting out the timer. Go through the real setCollapsed path.
  try {
    (window as unknown as { __fcmForceCollapse?: () => void }).__fcmForceCollapse = () => setCollapsed(true);
    (window as unknown as { __fcmForceExpand?: () => void }).__fcmForceExpand = () => setCollapsed(false);
    (window as unknown as { __fcmHeaderStripHeight?: () => number }).__fcmHeaderStripHeight = () => headerStripHeight();
  } catch { /* non-fatal */ }
  // Any direct user interaction (mouse, keyboard, wheel) resets the timer / expands.
  for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel'] as const) {
    document.addEventListener(ev, markActivity, true);
  }
  // New message in the currently-viewed channel: the React overlay fires this event;
  // we expand and reset the idle timer. The MutationObserver path still fires for
  // any message; this gives an immediate, precise expand for the active view.
  window.addEventListener('fcm-active-message', () => { markActivity(); });
  // @mention: expand and ask main to un-hide from tray (game-gated). Fires for ALL
  // mentions — a hidden overlay hides even the active channel.
  window.addEventListener('fcm-mention-appear', () => {
    markActivity();
    try { window.relayBridge.showForMention?.(); } catch { /* non-fatal in web context */ }
  });
  // Observe the message list for new child nodes. No subtree watch — that would
  // fire on cursor blinks and attribute changes, preventing auto-collapse.
  // Also watches for the container to mount (it appears after auth).
  const attachMsgObserver = () => {
    if (msgObserver) { msgObserver.disconnect(); msgObserver = null; }
    // The message list is a scrollable div inside the overlay host. It's the
    // only childList target that matters for "new message" detection.
    // Walk the host's descendants to find a scrollable div with many message
    // children (rather than relying on an unstable class/id that could change).
    const host = document.getElementById('shell-overlay-host');
    if (!host) return false;
    // Heuristic: the message container is the first deeply-nested div with
    // overflow:auto/scroll and multiple children. Retry on the next DOM settle if not found.
    const divs = Array.from(host.querySelectorAll<HTMLDivElement>('div'));
    const msgContainer = divs.find(el => {
      const cs = getComputedStyle(el);
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.children.length > 2;
    });
    if (!msgContainer) return false;
    msgObserver = new MutationObserver((mutations) => {
      // Only act on childList mutations (new message nodes). Attribute/character-data
      // changes fire on every cursor blink and must not trigger expand.
      const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
      if (hasNewNodes) markMessageActivity();
    });
    // childList only — no subtree watch.
    msgObserver.observe(msgContainer, { childList: true });
    return true;
  };

  // Try immediately; if the message container isn't mounted yet, retry with a
  // small observer on the host until it appears.
  if (!attachMsgObserver()) {
    const mountWatcher = new MutationObserver(() => {
      if (attachMsgObserver()) mountWatcher.disconnect();
    });
    const host = document.getElementById('shell-overlay-host');
    if (host) mountWatcher.observe(host, { childList: true, subtree: true });
  }
}

// ── Channel navigation via simulated tab clicks ───────────────────────────────
// The component owns channel state; we drive next/prev by clicking sub-tab spans.

// Locate the sub-tab row container via the stable `data-fcm-subtab-row` marker.
// Both the FO76 and Party rows carry this marker, so collapse anchoring works on
// either tab. Falls back to the text-matched span's parent for older renders.
function subTabRowEl(): HTMLElement | null {
  const host = document.getElementById('shell-overlay-host');
  if (!host) return null;
  const marked = Array.from(host.querySelectorAll<HTMLElement>('[data-fcm-subtab-row]'))
    .find(el => el.offsetParent !== null);
  if (marked) return marked;
  return (subTabSpans()[0]?.parentElement as HTMLElement | null) ?? null;
}

const SUBTAB_NAMES = /^(general|trading|events|raids|server)/i;
function subTabSpans(): HTMLElement[] {
  // Match clickable <span>s whose text is a channel name (case-insensitive),
  // then keep only spans in the lowest visual row (the sub-tab strip).
  const host = document.getElementById('shell-overlay-host');
  if (!host) return [];
  const candidates = Array.from(host.querySelectorAll<HTMLElement>('span'))
    .filter(el => {
      const cs = getComputedStyle(el);
      const txt = (el.textContent || '').trim();
      return cs.cursor === 'pointer' && el.offsetParent !== null && SUBTAB_NAMES.test(txt);
    });
  if (candidates.length === 0) return [];
  const byTop = new Map<number, HTMLElement[]>();
  for (const el of candidates) {
    const top = Math.round(el.getBoundingClientRect().top / 4) * 4;
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top)!.push(el);
  }
  const rows = [...byTop.entries()].sort((a, b) => a[0] - b[0]);
  // Prefer the lowest row (sub-tabs) if there are >=2 rows; else the only row.
  return rows.length >= 2 ? rows[rows.length - 1][1] : rows[0][1];
}

function activeTabIndex(spans: HTMLElement[]): number {
  let idx = spans.findIndex(el => getComputedStyle(el).fontWeight === 'bold' || parseInt(getComputedStyle(el).fontWeight, 10) >= 600);
  if (idx < 0) idx = 0;
  return idx;
}

export function navChannel(dir: 1 | -1) {
  markActivity();
  const spans = subTabSpans();
  if (spans.length === 0) return;
  const cur = activeTabIndex(spans);
  const next = nextNavIndex(cur, dir, spans.length);
  if (next < 0) return;
  spans[next].click();
}

export function openComponentSettings() {
  markActivity();
  // The settings cog is the gear SVG button in the header. Click its container.
  const host = document.getElementById('shell-overlay-host');
  if (!host) return;
  const cog = host.querySelector('svg circle[r="4.2"]')?.closest('span') as HTMLElement | null;
  if (cog) cog.click();
}

// ── Settings panel (full desktop parity) ──────────────────────────────────────

let currentSettings: ShellSettings = DEFAULT_SHELL_SETTINGS;
let onSettingsChange: ((s: ShellSettings) => void) | null = null;
/** Reference to the version span — set once the settings panel is built. */
let verSpanEl: HTMLElement | null = null;
/** Latched when an update signal arrives before the panel is built. */
let pendingUpdateVersion: string | null = null;

function applyUpdateDot(latestVersion: string): void {
  if (!verSpanEl) return;
  if (!verSpanEl.querySelector('.ss-update-dot')) {
    const dot = document.createElement('span');
    dot.className = 'ss-update-dot';
    dot.title = `Update available: v${latestVersion}`;
    dot.style.cssText = [
      'display:inline-block',
      'width:7px',
      'height:7px',
      'border-radius:50%',
      'background:#e74c3c',
      'box-shadow:0 0 5px rgba(231,76,60,0.8)',
      'margin-left:5px',
      'vertical-align:middle',
      'flex-shrink:0',
    ].join(';');
    verSpanEl.style.display = 'inline-flex';
    verSpanEl.style.alignItems = 'center';
    verSpanEl.appendChild(dot);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Partial<HTMLElementTagNameMap[K]> & { className?: string }, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) Object.assign(node, attrs);
  for (const k of kids) node.append(k);
  return node;
}

// ── Autocomplete candidate sources ────────────────────────────────────────────

function collectChannels(): string[] {
  // Normalization (defaults + Title-case + sort/dedupe) lives in shell-core.
  return collectChannelsCore(subTabSpans().map(s => s.textContent || ''));
}

// ── Autocomplete chip field ───────────────────────────────────────────────────
// Text input that shows a popover of matching candidates; picking one adds it as
// a removable chip. Popover appended to <body> with fixed positioning + flip.
function chipField(opts: {
  label: string;
  placeholder: string;
  get: () => string[];
  set: (values: string[]) => void;
  candidates: () => string[];
  allowCustom?: boolean;
}): HTMLElement {
  const row = el('div', { className: 'ss-row' });
  row.append(el('label', { className: 'ss-lbl' }, opts.label));

  const chipsWrap = el('div', { className: 'ss-chips' });
  const input = el('input', { type: 'text', className: 'ss-chipinput' }) as HTMLInputElement;
  input.placeholder = opts.placeholder;

  const pop = el('div', { className: 'ss-ac' }); // popover (appended to body lazily)
  let activeIdx = -1;
  let filtered: string[] = [];

  const renderChips = () => {
    chipsWrap.querySelectorAll('.ss-chip').forEach(c => c.remove());
    const values = opts.get();
    values.forEach(v => {
      const chip = el('span', { className: 'ss-chip' }, v);
      const x = el('span', { className: 'ss-chip-x', title: 'Remove' }, '✕');
      x.addEventListener('click', () => { opts.set(values.filter(u => u !== v)); renderChips(); });
      chip.append(x);
      chipsWrap.insertBefore(chip, input);
    });
  };

  const closePop = () => { pop.classList.remove('open'); activeIdx = -1; };
  const positionPop = () => {
    const r = input.getBoundingClientRect();
    pop.style.left = `${Math.round(r.left)}px`;
    pop.style.width = `${Math.round(r.width)}px`;
    // Flip above if there isn't room below.
    const belowSpace = window.innerHeight - r.bottom;
    pop.style.maxHeight = '180px';
    if (belowSpace < 190 && r.top > belowSpace) {
      pop.style.top = ''; pop.style.bottom = `${Math.round(window.innerHeight - r.top + 2)}px`;
    } else {
      pop.style.bottom = ''; pop.style.top = `${Math.round(r.bottom + 2)}px`;
    }
  };
  const highlight = () => {
    [...pop.children].forEach((c, i) => c.classList.toggle('active', i === activeIdx));
  };
  const addValue = (v: string) => {
    const val = v.trim();
    if (!val) return;
    const cur = opts.get();
    if (!cur.some(u => u.toLowerCase() === val.toLowerCase())) opts.set([...cur, val]);
    input.value = '';
    renderChips();
    closePop();
  };
  const openPop = () => {
    const q = input.value.trim().toLowerCase();
    const chosen = new Set(opts.get().map(u => u.toLowerCase()));
    filtered = opts.candidates()
      .filter(c => !chosen.has(c.toLowerCase()))
      .filter(c => !q || c.toLowerCase().includes(q))
      .slice(0, 8);
    pop.replaceChildren();
    if (filtered.length === 0) { closePop(); return; }
    filtered.forEach((c, i) => {
      const item = el('div', { className: 'ss-ac-item' }, c);
      item.addEventListener('mousedown', (e) => { e.preventDefault(); addValue(c); });
      item.addEventListener('mousemove', () => { activeIdx = i; highlight(); });
      pop.append(item);
    });
    if (!pop.isConnected) document.body.append(pop);
    positionPop();
    pop.classList.add('open');
    activeIdx = -1;
  };

  input.addEventListener('input', openPop);
  input.addEventListener('focus', openPop);
  input.addEventListener('blur', () => setTimeout(closePop, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered.length) { activeIdx = (activeIdx + 1) % filtered.length; highlight(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (filtered.length) { activeIdx = (activeIdx - 1 + filtered.length) % filtered.length; highlight(); } }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIdx >= 0 && filtered[activeIdx]) { e.preventDefault(); addValue(filtered[activeIdx]); }
      else if (opts.allowCustom !== false && input.value.trim()) { e.preventDefault(); addValue(input.value); }
    } else if (e.key === 'Escape') { closePop(); }
    else if (e.key === 'Backspace' && !input.value) {
      const cur = opts.get(); if (cur.length) { opts.set(cur.slice(0, -1)); renderChips(); }
    }
  });

  chipsWrap.append(input);
  row.append(chipsWrap);
  renderChips();
  // Clean up the body-attached popover when the row is removed.
  return row;
}

// ── Account-level blocked-users field ─────────────────────────────────────────
// Multi-select field backed by the server-side block list (hides user across all
// chats). Search via GET /api/block/search; block via POST /api/block; unblock
// via DELETE /api/block/:id. Reuses chipField styling. Requests go through the
// shimmed fetch in bridge.ts which proxies /api/* to the relay with auth.
function accountBlockField(opts: { label: string; placeholder: string }): HTMLElement {
  const row = el('div', { className: 'ss-row' });
  row.append(el('label', { className: 'ss-lbl' }, opts.label));
  const chipsWrap = el('div', { className: 'ss-chips' });
  const input = el('input', { type: 'text', className: 'ss-chipinput' }) as HTMLInputElement;
  input.placeholder = opts.placeholder;
  const pop = el('div', { className: 'ss-ac' });
  let activeIdx = -1;
  let results: { userId: string; displayName: string }[] = [];
  let blocked: { userId: string; displayName: string }[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const apiCall = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(path, init);
    let json: any = null;
    try { json = await res.json(); } catch { /* empty body (e.g. 204 DELETE) */ }
    if (!res.ok) throw new Error((json && (json.detail || json.title)) || `HTTP ${res.status}`);
    return json?.data ?? json;
  };

  const renderChips = () => {
    chipsWrap.querySelectorAll('.ss-chip').forEach(c => c.remove());
    blocked.forEach(u => {
      const chip = el('span', { className: 'ss-chip' }, u.displayName || u.userId);
      const x = el('span', { className: 'ss-chip-x', title: 'Unblock' }, '✕');
      x.addEventListener('click', async () => {
        const prev = blocked;
        blocked = blocked.filter(b => b.userId !== u.userId); renderChips();
        try { await apiCall(`/api/block/${encodeURIComponent(u.userId)}`, { method: 'DELETE' }); }
        catch { blocked = prev; renderChips(); }   // revert on failure
      });
      chip.append(x);
      chipsWrap.insertBefore(chip, input);
    });
  };

  const closePop = () => { pop.classList.remove('open'); activeIdx = -1; };
  const positionPop = () => {
    const r = input.getBoundingClientRect();
    pop.style.left = `${Math.round(r.left)}px`;
    pop.style.width = `${Math.round(r.width)}px`;
    const belowSpace = window.innerHeight - r.bottom;
    pop.style.maxHeight = '180px';
    if (belowSpace < 190 && r.top > belowSpace) {
      pop.style.top = ''; pop.style.bottom = `${Math.round(window.innerHeight - r.top + 2)}px`;
    } else {
      pop.style.bottom = ''; pop.style.top = `${Math.round(r.bottom + 2)}px`;
    }
  };
  const highlight = () => { [...pop.children].forEach((c, i) => c.classList.toggle('active', i === activeIdx)); };

  const blockUser = async (u: { userId: string; displayName: string }) => {
    input.value = ''; closePop();
    if (blocked.some(b => b.userId === u.userId)) return;
    blocked = [...blocked, u]; renderChips();
    try { await apiCall('/api/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: u.userId }) }); }
    catch { blocked = blocked.filter(b => b.userId !== u.userId); renderChips(); }   // revert on failure
  };

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) { closePop(); return; }
    try {
      const data = await apiCall(`/api/block/search?q=${encodeURIComponent(q)}`);
      const blockedIds = new Set(blocked.map(b => b.userId));
      results = (data?.results ?? []).filter((r: any) => !blockedIds.has(r.userId)).slice(0, 8);
    } catch { results = []; }
    pop.replaceChildren();
    if (!results.length) { closePop(); return; }
    results.forEach((r, i) => {
      const item = el('div', { className: 'ss-ac-item' }, r.displayName || r.userId);
      item.addEventListener('mousedown', (e) => { e.preventDefault(); blockUser(r); });
      item.addEventListener('mousemove', () => { activeIdx = i; highlight(); });
      pop.append(item);
    });
    if (!pop.isConnected) document.body.append(pop);
    positionPop(); pop.classList.add('open'); activeIdx = -1;
  };

  input.addEventListener('input', () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(doSearch, 220); });
  input.addEventListener('focus', () => { if (input.value.trim()) doSearch(); });
  input.addEventListener('blur', () => setTimeout(closePop, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) { activeIdx = (activeIdx + 1) % results.length; highlight(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) { activeIdx = (activeIdx - 1 + results.length) % results.length; highlight(); } }
    else if (e.key === 'Enter') { if (activeIdx >= 0 && results[activeIdx]) { e.preventDefault(); blockUser(results[activeIdx]); } }
    else if (e.key === 'Escape') closePop();
  });

  chipsWrap.append(input);
  row.append(chipsWrap);
  // Initial load of the current block list.
  apiCall('/api/block').then((data: any) => { blocked = data?.blocked ?? []; renderChips(); }).catch(() => { /* not logged in / offline */ });
  return row;
}

// Keybind rows for the rebinder UI.
const KEYBIND_ROWS: { key: keyof ShellSettings['keybinds']; label: string }[] = [
  { key: 'focus',        label: 'Open chat input' },
  { key: 'toggle',       label: 'Show / hide overlay' },
  { key: 'settings',     label: 'Open settings' },
  { key: 'nextChannel',  label: 'Cycle channel (next)' },
  { key: 'prevChannel',  label: 'Cycle channel (prev)' },
  { key: 'recentParty',  label: 'Jump to recent party' },
  { key: 'goFo76',       label: 'Go to Fallout 76 tab' },
  { key: 'clickThrough', label: 'Toggle click-through' },
  { key: 'party1',       label: 'Jump to party 1' },
  { key: 'party2',       label: 'Jump to party 2' },
  { key: 'party3',       label: 'Jump to party 3' },
  { key: 'party4',       label: 'Jump to party 4' },
  { key: 'party5',       label: 'Jump to party 5' },
  { key: 'party6',       label: 'Jump to party 6' },
  { key: 'party7',       label: 'Jump to party 7' },
  { key: 'party8',       label: 'Jump to party 8' },
];

function accelFromEvent(e: KeyboardEvent): string | null {
  return accelFromEventCore(e);
}

/**
 * Build the settings panel (IDENTITY / KEYBINDS / APPEARANCE sections).
 */
function buildSettingsPanel() {
  const backdrop = el('div', { id: 'shell-settings-backdrop' });
  const panel = el('div', { id: 'shell-settings' });
  backdrop.append(panel);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) closeSettings(); });

  // ── Header ──
  const head = el('div', { className: 'ss-head' });
  head.append(el('span', { className: 'ss-title' }, 'SETTINGS'));
  // Show the build-time version from the Vite define constant. No live fetch —
  // the displayed version is always the installed build version.
  const verSpan = el('span', { className: 'ss-ver' }, `v${__APP_VERSION__}`);
  verSpanEl = verSpan;
  if (pendingUpdateVersion) applyUpdateDot(pendingUpdateVersion);
  head.append(verSpan);
  panel.append(head);
  // Official non-affiliation disclaimer — shown at the top of Settings, under the
  // title (Bethesda/ZeniMax trademark; unofficial fan project).
  const disclaimer = el('div', { className: 'ss-disclaimer' },
    'Unofficial fan project — not affiliated with, endorsed, or sponsored by Bethesda Softworks or ZeniMax Media. Fallout® is a trademark of ZeniMax Media, Inc.');
  panel.append(disclaimer);

  // ── Nav bar ──
  const nav = el('div', { className: 'ss-nav' });
  const sectionNames = ['IDENTITY', 'KEYBINDS', 'APPEARANCE'];
  const navBtns: HTMLElement[] = [];
  const sectionEls: HTMLElement[] = [];
  let activeSection = 0;
  const showSection = (i: number) => {
    activeSection = i;
    navBtns.forEach((b, j) => b.classList.toggle('active', j === i));
    sectionEls.forEach((s, j) => { s.style.display = j === i ? 'block' : 'none'; });
  };
  sectionNames.forEach((name, i) => {
    const b = el('div', { className: 'ss-navbtn' }, name);
    b.addEventListener('click', () => showSection(i));
    navBtns.push(b);
    nav.append(b);
  });
  const navX = el('div', { className: 'ss-navx', title: 'Close' }, '✕');
  navX.addEventListener('click', closeSettings);
  nav.append(navX);
  panel.append(nav);

  // ── Body (scrollable; one section shown at a time) ──
  const body = el('div', { className: 'ss-body' });
  panel.append(body);

  // applyLive: update + paint the prototype-managed visuals (dim / scanline /
  // scale) instantly with NO React remount — used for real-time slider drags.
  // The full set is flushed to the main process on a short debounce.
  const applyLive = (patch: Partial<ShellSettings>) => {
    currentSettings = { ...currentSettings, ...patch };
    persistLocal(currentSettings);
    applyVisualLayers(currentSettings);
    applyScale(currentSettings);
    applyWindowVisual(currentSettings);
    fadeEnabled = currentSettings.fadeWhenIdle;
    setIdleFadeFromSeconds(currentSettings.idleCollapseSeconds);
    scheduleFlush(currentSettings);
  };
  // commit: applyLive + remount the React component so settings it reads natively
  // (theme, opacities, hints) take effect, and flush to main immediately.
  const commit = (patch: Partial<ShellSettings>) => {
    currentSettings = { ...currentSettings, ...patch };
    persistShellSettings(currentSettings);
    applyShellChromeTheme(currentSettings.themeId);
    applyVisualLayers(currentSettings);
    applyScale(currentSettings);
    applyWindowVisual(currentSettings);
    fadeEnabled = currentSettings.fadeWhenIdle;
    setIdleFadeFromSeconds(currentSettings.idleCollapseSeconds);
    if (!fadeEnabled) setCollapsed(false);
    onSettingsChange?.(currentSettings);
  };

  // Helpers shared by sections.
  const makeSection = () => { const s = el('div', { className: 'ss-section' }); body.append(s); sectionEls.push(s); return s; };
  const heading = (parent: HTMLElement, t: string) => parent.append(el('div', { className: 'ss-sec' }, t));
  const hint = (parent: HTMLElement, t: string) => parent.append(el('div', { className: 'ss-note' }, t));
  // live=true → apply on every 'input' tick (smooth real-time preview, no
  // remount). live=false → preview the label live but only commit on release.
  const slider = (parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, live = false, onRelease?: (v: number) => void) => {
    const r = el('div', { className: 'ss-row' });
    r.append(el('label', { className: 'ss-lbl' }, label));
    const line = el('div', { className: 'ss-line' });
    // FULLY CUSTOM visual: track + fill + thumb divs we control, with a
    // transparent native <input type=range> layered on top purely as the
    // pointer-interaction surface (its value/state drive everything). The native
    // track/thumb rendering proved unreliable in this Electron build (track
    // gradient dropped, thumb didn't reposition), so we draw our own and keep
    // them in sync via --fcm-range-fill on the wrapper.
    const wrap = el('div', { className: 'ss-range-wrap' });
    const trackEl = el('div', { className: 'ss-range-track' });
    const fillEl = el('div', { className: 'ss-range-fill' });
    const thumbEl = el('div', { className: 'ss-range-thumb' });
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) });
    wrap.append(trackEl, fillEl, thumbEl, input);
    const val = el('span', { className: 'ss-val' }, fmt(get()));
    // Position the custom fill + thumb from the current value (--fcm-range-fill
    // is read by the .ss-range-fill width and .ss-range-thumb left in CSS).
    const paintFill = () => {
      const v = parseFloat(input.value);
      const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
      wrap.style.setProperty('--fcm-range-fill', `${Math.max(0, Math.min(100, pct))}%`);
    };
    paintFill();
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = fmt(v);
      paintFill();
      if (live) set(v);
    });
    // live=false → commit on release; live=true with onRelease → live preview on
    // every tick PLUS a heavier commit (e.g. React remount) once on release.
    if (!live) input.addEventListener('change', () => set(parseFloat(input.value)));
    else if (onRelease) input.addEventListener('change', () => onRelease(parseFloat(input.value)));

    // Manual pointer-driven dragging. The native <input type=range> drag proved
    // UNRELIABLE in this Electron overlay (verified: real OS mouse events reach
    // the control — nav buttons respond — but the native range value never
    // updates on press/drag, likely an appearance:none custom-thumb quirk). So
    // we compute the value from the pointer's X position ourselves and fire the
    // same 'input'/'change' events the listeners above expect. setPointerCapture
    // keeps the drag alive if the pointer leaves the track.
    const setFromClientX = (clientX: number) => {
      const rect = input.getBoundingClientRect();
      if (rect.width <= 0) return;
      let frac = (clientX - rect.left) / rect.width;
      frac = Math.max(0, Math.min(1, frac));
      let v = min + frac * (max - min);
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, v));
      const sv = String(parseFloat(v.toFixed(6)));
      if (input.value !== sv) {
        input.value = sv;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    let dragging = false;
    input.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { input.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      setFromClientX(e.clientX);
      e.preventDefault();
    });
    input.addEventListener('pointermove', (e) => { if (dragging) setFromClientX(e.clientX); });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { input.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    input.addEventListener('pointerup', endDrag);
    input.addEventListener('pointercancel', endDrag);

    line.append(wrap, val); r.append(line); parent.append(r);
  };
  const toggle = (parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void) => {
    const r = el('div', { className: 'ss-row' });
    const t = el('div', { className: 'ss-toggle' });
    const box = el('span', { className: 'ss-check' }, get() ? '✓' : '');
    t.append(box, document.createTextNode(label));
    t.addEventListener('click', () => { const v = !get(); set(v); box.textContent = v ? '✓' : ''; });
    r.append(t); parent.append(r);
  };

  // ── IDENTITY ──
  {
    const s = makeSection();

    // ── PROFILE BLOCK (shown when authenticated) ──
    const profileBlock = el('div', { className: 'ss-profile-block' });

    // Avatar
    const avatarWrap = el('div', { className: 'ss-profile-avatar-wrap' });
    const avatarImg = el('img', { className: 'ss-profile-avatar' }) as HTMLImageElement;
    avatarImg.alt = '';
    const avatarInitials = el('div', { className: 'ss-profile-avatar-placeholder' });
    avatarWrap.append(avatarImg, avatarInitials);

    // Profile fields
    const profileFields = el('div', { className: 'ss-profile-fields' });
    const profileFo76Name   = el('div', { className: 'ss-profile-field' });
    const profileDisplayName = el('div', { className: 'ss-profile-field' });
    const profileDiscordName = el('div', { className: 'ss-profile-field' });
    const profileLinkedBadge = el('div', { className: 'ss-profile-linked' });
    profileFields.append(profileFo76Name, profileDisplayName, profileDiscordName, profileLinkedBadge);
    profileBlock.append(avatarWrap, profileFields);
    s.append(profileBlock);

    // Always render the initials first so they're ready as the fallback; the
    // avatar <img> only displaces them once it has successfully loaded.
    const showInitialsFallback = () => {
      avatarImg.style.display = 'none';
      avatarInitials.style.display = '';
      const name = currentSettings.discordDisplayName || currentSettings.discordName || currentSettings.fo76Name || '?';
      avatarInitials.textContent = name.charAt(0).toUpperCase();
    };
    // Relative avatar paths ("/avatars/<id>") don't resolve in the Electron renderer
    // (no backend origin), so prefix with relayBase. Absolute URLs (Discord CDN) pass
    // through untouched. Any load failure falls back to the initials circle.
    avatarImg.addEventListener('load', () => {
      avatarImg.style.display = '';
      avatarInitials.style.display = 'none';
    });
    avatarImg.addEventListener('error', showInitialsFallback);

    const renderProfile = () => {
      const avatarUrl = currentSettings.discordAvatarUrl;
      // Always seed the initials so the circle is never blank while the image loads.
      showInitialsFallback();
      if (avatarUrl) {
        let resolved = avatarUrl;
        if (/^\//.test(avatarUrl)) {
          const base = window.__FCM_OVERLAY_SHELL__?.relayBase;
          // No base yet — leave the initials fallback; the next renderProfile call will have the base.
          resolved = base ? base.replace(/\/$/, '') + avatarUrl : '';
        }
        if (resolved) {
          avatarImg.src = resolved;
        }
      }
      profileFo76Name.replaceChildren(
        el('span', { className: 'ss-profile-label' }, 'Username'),
        el('span', { className: 'ss-profile-value' }, currentSettings.fo76Name || '—'),
      );
      profileDisplayName.replaceChildren(
        el('span', { className: 'ss-profile-label' }, 'Display name'),
        el('span', { className: 'ss-profile-value' }, currentSettings.resolvedDisplayName || currentSettings.fo76Name || currentSettings.discordDisplayName || '—'),
      );
      profileDiscordName.replaceChildren(
        el('span', { className: 'ss-profile-label' }, 'Discord'),
        el('span', { className: 'ss-profile-value' }, currentSettings.discordDisplayName || currentSettings.discordName || '—'),
      );
      const linked = !!currentSettings.discordLinked;
      profileLinkedBadge.className = 'ss-profile-linked' + (linked ? ' linked' : '');
      profileLinkedBadge.replaceChildren(
        el('span', { className: 'ss-dot' }),
        document.createTextNode(linked ? '✓ Account linked' : 'Not linked'),
      );
    };
    renderProfile();

    // Fallout 76 opt-in
    const optRow = el('div', { className: 'ss-row' });
    const optWrap = el('div', { className: 'ss-toggle' });
    const optBox = el('span', { className: 'ss-check' }, currentSettings.playsFo76 ? '✓' : '');
    optWrap.append(optBox, document.createTextNode('Fallout 76'));
    optRow.append(optWrap); s.append(optRow);

    heading(s, 'FALLOUT 76 CHARACTER NAME');
    const nameRow = el('div', { className: 'ss-row ss-name-row' });
    const nameInput = el('input', { type: 'text', value: currentSettings.fo76Name, maxLength: 32 }) as HTMLInputElement;
    nameInput.placeholder = 'Your in-game name';
    // Persist locally on change (so the value survives without a backend round-trip).
    nameInput.addEventListener('change', () => commit({ fo76Name: nameInput.value.trim() }));

    // SAVE NAME button — calls setIdentityName to re-register with the backend.
    const saveNameBtn = el('button', { className: 'ss-fbtn ss-save-name-btn' }, 'SAVE NAME') as HTMLButtonElement;
    const saveNameFeedback = el('span', { className: 'ss-save-name-feedback' });
    let saveFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

    saveNameBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      saveNameBtn.setAttribute('disabled', 'disabled');
      saveNameBtn.textContent = '…';
      saveNameFeedback.textContent = '';
      try {
        const result = await window.relayBridge.setIdentityName?.(name);
        if (!result) {
          saveNameFeedback.textContent = 'Error';
        } else if (result.ok) {
          saveNameFeedback.textContent = '✓ Saved';
              const resolvedDisplay = result.displayName || name;
          commit({ fo76Name: name, resolvedDisplayName: resolvedDisplay });
          renderProfile();
        } else if (result.reason === 'taken') {
          saveNameFeedback.textContent = 'Name taken';
        } else {
          saveNameFeedback.textContent = 'Error';
        }
      } catch {
        saveNameFeedback.textContent = 'Error';
      }
      saveNameBtn.textContent = 'SAVE NAME';
      saveNameBtn.removeAttribute('disabled');
      if (saveFeedbackTimer) clearTimeout(saveFeedbackTimer);
      saveFeedbackTimer = setTimeout(() => { saveNameFeedback.textContent = ''; }, 3000);
    });

    nameRow.append(nameInput, saveNameBtn, saveNameFeedback);
    s.append(nameRow);
    hint(s, 'Required for playing Fallout 76. Please use your in-game name. (If left blank, your Discord display name is used.) Click SAVE NAME to register the name with the server.');

    const fo76Block = [s.querySelector('.ss-sec'), nameRow, s.querySelector('.ss-note')] as HTMLElement[];
    const applyOpt = () => { const show = currentSettings.playsFo76 || !!currentSettings.fo76Name; fo76Block.forEach(e => { if (e) e.style.display = show ? '' : 'none'; }); };
    optWrap.addEventListener('click', () => { const v = !currentSettings.playsFo76; commit({ playsFo76: v }); optBox.textContent = v ? '✓' : ''; applyOpt(); });
    applyOpt();

    // ── DISCORD ACCOUNT ──
    heading(s, 'DISCORD ACCOUNT');
    const dStatus = el('div', { className: 'ss-discord-status' });
    const renderDiscordStatus = () => {
      const linked = !!currentSettings.discordLinked;
      dStatus.classList.toggle('linked', linked);
      dStatus.replaceChildren(
        el('span', { className: 'ss-dot' }),
        document.createTextNode(linked
          ? `Linked${currentSettings.discordName ? ' as ' + currentSettings.discordName : ''}`
          : 'Not linked'),
      );
    };
    renderDiscordStatus();
    s.append(dStatus);

    const dBtns = el('div', { className: 'ss-discord-btns' });
    const linkBtn = el('button', { className: 'ss-fbtn ss-discord-link' }, 'LINK DISCORD');
    linkBtn.addEventListener('click', () => {
      window.relayBridge.linkDiscord?.();
    });
    const relinkBtn = el('button', { className: 'ss-fbtn' }, 'RELINK');
    relinkBtn.addEventListener('click', () => { window.relayBridge.linkDiscord?.(); });
    const refreshStatusBtn = el('button', { className: 'ss-fbtn' }, 'REFRESH STATUS');
    refreshStatusBtn.title = 'Re-check your Discord link status from the server';
    refreshStatusBtn.addEventListener('click', () => {
      refreshStatusBtn.textContent = '…';
      refreshStatusBtn.setAttribute('disabled', 'disabled');
      window.relayBridge.refreshDiscordStatus?.();
      setTimeout(() => {
        refreshStatusBtn.textContent = 'REFRESH STATUS';
        refreshStatusBtn.removeAttribute('disabled');
      }, 3000);
    });
    const unlinkBtn = el('button', { className: 'ss-fbtn ss-discord-unlink' }, 'UNLINK');
    unlinkBtn.addEventListener('click', () => {
      if (!confirm('Unlink your Discord account from this overlay?\n\nNote: this only clears the local display — a full server-side unlink is not yet supported.')) return;
      // TODO: call a backend unlink endpoint when one exists (FR: DELETE /api/users/me/discord).
      // For now this only clears the local state so the panel shows "Not linked".
      commit({ discordLinked: false, discordName: '' });
      renderDiscordStatus();
      renderProfile();
    });
    dBtns.append(linkBtn, relinkBtn, refreshStatusBtn, unlinkBtn);
    s.append(dBtns);
    hint(s, 'Linking opens Discord in your browser to authorise this install. Click REFRESH STATUS after returning to update the panel. Your chat display name comes from your FO76 name above, or your Discord display name.');

    window.relayBridge.onDiscordStatus?.((status) => {
      commit({ discordLinked: status.linked, discordName: status.discordName || '' });
      renderDiscordStatus();
      renderProfile();
    });

    window.relayBridge.onStatus?.((s) => {
      if (s.state !== 'authenticated') return;
      const patch: Partial<ShellSettings> = {};
      if (s.displayName)        patch.resolvedDisplayName = s.displayName;
      if (s.discordLinked != null) patch.discordLinked = !!s.discordLinked;
      if (s.discordName)        patch.discordName = s.discordName;
      if (s.discordUsername)    patch.discordUsername = s.discordUsername;
      if (s.discordDisplayName) patch.discordDisplayName = s.discordDisplayName;
      if (s.discordAvatarUrl != null) patch.discordAvatarUrl = s.discordAvatarUrl || '';
      if (s.username)           patch.fo76Name = s.username;
      if (Object.keys(patch).length) commit(patch);
      renderDiscordStatus();
      renderProfile();
    });
  }

  // ── KEYBINDS (+ filters) ──
  {
    const s = makeSection();
    heading(s, 'KEYBINDS');
    KEYBIND_ROWS.forEach(({ key, label }) => {
      const r = el('div', { className: 'ss-kbrow' });
      r.append(el('span', { className: 'ss-kb-lbl' }, label));
      const btn = el('button', { className: 'ss-kbbtn' }, prettyAccel(currentSettings.keybinds[key]));
      btn.addEventListener('click', () => {
        btn.textContent = 'press keys or Esc to clear…';
        btn.classList.add('listening');
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') {
            window.removeEventListener('keydown', onKey, true);
            btn.classList.remove('listening');
            const next = { ...currentSettings.keybinds, [key]: '' };
            commit({ keybinds: next });
            btn.textContent = prettyAccel('');
            return;
          }
          const accel = accelFromEvent(e);
          if (!accel) return; // wait for a non-modifier key
          window.removeEventListener('keydown', onKey, true);
          btn.classList.remove('listening');
          // Warn (don't block) on a bare FO76 gameplay key — pressing it in-game would
          // trigger both the overlay and the game (issue #136: Tab=nextChannel popped
          // the overlay on every Pip-Boy open). The user can still bind it.
          const warn = gameReservedWarning(accel);
          if (warn && !window.confirm(warn + '\n\nBind it anyway?')) {
            btn.textContent = prettyAccel(currentSettings.keybinds[key]); // keep the existing bind
            return;
          }
          const next = { ...currentSettings.keybinds, [key]: accel };
          commit({ keybinds: next });
          btn.textContent = prettyAccel(accel);
        };
        window.addEventListener('keydown', onKey, true);
      });
      r.append(btn); s.append(r);
    });
    hint(s, 'Click a binding then press your desired key combo. Press Esc to clear it entirely. Unbound keys are hidden from the hint bar.');

    heading(s, 'FILTERS');
    s.append(accountBlockField({
      label: 'Blocked users',
      placeholder: 'Search a user to block…',
    }));
    hint(s, 'Start typing to find an existing user, then pick them to block. Blocks sync to your account and hide them from chat + member lists everywhere. Click ✕ on a chip to unblock.');

    s.append(chipField({
      label: 'Hidden channels',
      placeholder: 'Type a channel to hide…',
      get: () => currentSettings.channelFilters,
      set: (v) => commit({ channelFilters: v }),
      candidates: collectChannels,
      allowCustom: false,
    }));
    hint(s, 'Pick channels to hide from the feed. Click ✕ on a chip to show it again.');

    // ── POSITION PRESETS (desktop SettingsForm.cs parity) ──
    heading(s, 'POSITION PRESETS');
    hint(s, 'Move + size the overlay, then click SET POS to capture it into a preset. Press the preset’s hotkey to snap the overlay back to that position.');
    currentSettings.presets.forEach((preset, idx) => {
      const r = el('div', { className: 'ss-preset' });
      r.append(el('span', { className: 'ss-preset-lbl' }, `Preset ${idx + 1}`));

      const kbBtn = el('button', { className: 'ss-kbbtn ss-preset-kb' }, prettyAccel(preset.keybind));
      kbBtn.addEventListener('click', () => {
        kbBtn.textContent = 'press keys or Esc to clear…';
        kbBtn.classList.add('listening');
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') {
            window.removeEventListener('keydown', onKey, true);
            kbBtn.classList.remove('listening');
            const next = currentSettings.presets.map((p, j) => j === idx ? { ...p, keybind: '' } : p);
            commit({ presets: next });
            kbBtn.textContent = prettyAccel('');
            return;
          }
          const accel = accelFromEvent(e);
          if (!accel) return;
          window.removeEventListener('keydown', onKey, true);
          kbBtn.classList.remove('listening');
          const next = currentSettings.presets.map((p, j) => j === idx ? { ...p, keybind: accel } : p);
          commit({ presets: next });
          kbBtn.textContent = prettyAccel(accel);
        };
        window.addEventListener('keydown', onKey, true);
      });
      r.append(kbBtn);

      const status = el('span', { className: 'ss-preset-status' },
        preset.x != null ? `${preset.w}×${preset.h} @ ${preset.x},${preset.y}` : '— unsaved —');
      if (preset.x == null) status.classList.add('unset');

      const setBtn = el('button', { className: 'ss-fbtn ss-preset-set' }, 'SET POS');
      setBtn.addEventListener('click', async () => {
        const b = await window.relayBridge.getBounds?.();
        if (!b) return;
        const next = currentSettings.presets.map((p, j) => j === idx ? { ...p, x: b.x, y: b.y, w: b.width, h: b.height } : p);
        commit({ presets: next });
        status.textContent = `${b.width}×${b.height} @ ${b.x},${b.y}`;
        status.classList.remove('unset');
      });
      r.append(setBtn, status);
      s.append(r);
    });
    hint(s, 'Snap-to-preset hotkeys are native-only (under WSLg the Windows desktop owns the keys).');
  }

  // ── APPEARANCE ──
  {
    const s = makeSection();
    heading(s, 'APPEARANCE');
    const themeRow = el('div', { className: 'ss-row' });
    themeRow.append(el('label', { className: 'ss-lbl' }, 'Theme'));
    // Native <select> popups don't render in frameless/transparent Electron windows — use a custom button + popover instead.
    const ddWrap = el('div', { className: 'ss-select' });
    const ddBtn = el('button', { className: 'ss-select-btn', type: 'button' }) as HTMLButtonElement;
    const themeName = (id: string) => THEMES.find(t => t.id === id)?.name ?? id;
    const ddText = el('span', { className: 'ss-select-text' }, themeName(currentSettings.themeId));
    ddBtn.append(ddText, el('span', { className: 'ss-select-caret' }, '▾'));
    const ddPop = el('div', { className: 'ss-select-pop' });
    const rebuildThemeItems = () => {
      ddPop.replaceChildren();
      for (const th of THEMES) {
        const item = el('div', { className: 'ss-select-item' + (th.id === currentSettings.themeId ? ' active' : '') }, th.name);
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          ddPop.classList.remove('open');
          ddText.textContent = th.name;
          commit({ themeId: th.id });
          rebuildThemeItems();
        });
        ddPop.append(item);
      }
    };
    rebuildThemeItems();
    ddBtn.addEventListener('click', (e) => { e.stopPropagation(); ddPop.classList.toggle('open'); });
    document.addEventListener('click', () => ddPop.classList.remove('open'));
    ddWrap.append(ddBtn, ddPop);
    themeRow.append(ddWrap); s.append(themeRow);

    slider(s, 'Background Opacity', 0, 1, 0.01, () => currentSettings.windowOpacity, v => applyLive({ windowOpacity: v }), v => `${Math.round(v * 100)}%`, true);
    // Text opacity previews live; commits on release so the component re-applies its text alpha.
    slider(s, 'Text Opacity', 0.3, 1, 0.01, () => currentSettings.textOpacity, v => applyLive({ textOpacity: v }), v => `${Math.round(v * 100)}%`, true, v => commit({ textOpacity: v }));
    slider(s, 'Scanline Intensity', 0, 1, 0.01, () => currentSettings.scanlineIntensity, v => applyLive({ scanlineIntensity: v }), v => `${Math.round(v * 100)}%`, true);
    slider(s, 'Scale (font size)', 9, 22, 1, () => currentSettings.fontSize, v => applyLive({ fontSize: v }), v => `${v}pt`, true);

    toggle(s, 'Show footer hints (keybind bar at the bottom)', () => currentSettings.showHints, v => commit({ showHints: v }));
    toggle(s, 'Auto-hide chat when idle (collapse to header)', () => currentSettings.fadeWhenIdle, v => commit({ fadeWhenIdle: v }));
    slider(
      s, 'Auto-hide delay', IDLE_COLLAPSE_SECONDS_MIN, IDLE_COLLAPSE_SECONDS_MAX, 1,
      () => currentSettings.idleCollapseSeconds,
      v => applyLive({ idleCollapseSeconds: v }),
      v => `${v}s`,
      true,
      v => commit({ idleCollapseSeconds: v }),
    );

    const fmtRow = el('div', { className: 'ss-row' });
    fmtRow.append(el('label', { className: 'ss-lbl' }, 'Time format'));
    const fmtWrap = el('div', { className: 'ss-seg' });
    fmtWrap.style.display = 'flex';
    fmtWrap.style.gap = '6px';
    const mkFmtBtn = (fmt: '12h' | '24h', label: string) => {
      const b = el('button', { className: 'ss-fbtn', type: 'button' }, label) as HTMLButtonElement;
      const sync = () => {
        const active = currentSettings.timestampFormat === fmt;
        b.style.background = active ? 'var(--shell-primary-dim)' : 'transparent';
        b.style.borderColor = active ? 'var(--shell-primary)' : '';
      };
      b.addEventListener('click', () => { commit({ timestampFormat: fmt }); b12.sync(); b24.sync(); });
      return { b, sync };
    };
    const b12 = mkFmtBtn('12h', '12-hour');
    const b24 = mkFmtBtn('24h', '24-hour');
    b12.sync(); b24.sync();
    fmtWrap.append(b12.b, b24.b);
    fmtRow.append(fmtWrap);
    fmtRow.style.display = currentSettings.showTimestamps ? '' : 'none';
    toggle(s, 'Show message timestamps', () => currentSettings.showTimestamps, v => {
      commit({ showTimestamps: v });
      fmtRow.style.display = v ? '' : 'none';
    });
    s.append(fmtRow);
  }

  // ── Footer ──
  const footer = el('div', { className: 'ss-footer' });
  const resetBtn = el('button', { className: 'ss-fbtn' }, 'RESET DEFAULTS');
  resetBtn.addEventListener('click', () => {
    if (!confirm('Reset all settings to defaults? Your FO76 name is kept.')) return;
    const keepName = currentSettings.fo76Name, keepPlays = currentSettings.playsFo76;
    currentSettings = { ...DEFAULT_SHELL_SETTINGS, fo76Name: keepName, playsFo76: keepPlays };
    persistShellSettings(currentSettings);
    applyVisualLayers(currentSettings);
    applyScale(currentSettings);
    applyWindowVisual(currentSettings);
    fadeEnabled = currentSettings.fadeWhenIdle;
    setIdleFadeFromSeconds(currentSettings.idleCollapseSeconds);
    onSettingsChange?.(currentSettings);
    closeSettings();
  });
  const cancelBtn = el('button', { className: 'ss-fbtn' }, 'CLOSE');
  cancelBtn.addEventListener('click', closeSettings);
  footer.append(resetBtn, el('div', { className: 'ss-fspacer' }), cancelBtn);
  panel.append(footer);

  showSection(0);
  document.body.append(backdrop);
  return backdrop;
}

// Pretty-print an Electron accelerator for display (Ctrl/⌘ etc.).
function prettyAccel(a: string): string {
  return prettyAccelCore(a, navigator.platform.startsWith('Mac'));
}

let _ctToastTimer: ReturnType<typeof setTimeout> | null = null;
function showClickThroughToast(on: boolean) {
  let toast = document.getElementById('shell-ct-toast') as HTMLElement | null;
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'shell-ct-toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '36px', left: '50%', transform: 'translateX(-50%)',
      padding: '4px 12px', borderRadius: '4px', fontSize: '11px', fontWeight: '600',
      letterSpacing: '0.06em', pointerEvents: 'none', zIndex: '99999',
      transition: 'opacity 0.2s',
      background: 'rgba(0,0,0,0.75)', color: '#ccc', border: '1px solid rgba(255,255,255,0.15)',
    });
    document.body.appendChild(toast);
  }
  toast.textContent = on ? 'CLICK-THROUGH ON' : 'CLICK-THROUGH OFF';
  toast.style.opacity = '1';
  if (_ctToastTimer) clearTimeout(_ctToastTimer);
  _ctToastTimer = setTimeout(() => {
    if (toast) toast.style.opacity = '0';
  }, 1500);
}

let panelEl: HTMLElement | null = null;
export function openSettings() {
  markActivity();
  if (!panelEl) panelEl = buildSettingsPanel();
  panelEl.classList.add('open');
  try { window.relayBridge.setModalInteractive?.(true); } catch { /* non-fatal */ }
}
export function closeSettings() {
  panelEl?.classList.remove('open');
  try { window.relayBridge.setModalInteractive?.(false); } catch { /* non-fatal */ }
}
function toggleSettings() {
  if (panelEl?.classList.contains('open')) closeSettings(); else openSettings();
}

// Called by onboarding.ts on Finish/Skip so the settings panel + React component
// see the collected values immediately.
export function applyOnboardingSettings(patch: Partial<ShellSettings>) {
  currentSettings = { ...currentSettings, ...patch };
  persistShellSettings(currentSettings);
  applyShellChromeTheme(currentSettings.themeId);
  applyVisualLayers(currentSettings);
  applyScale(currentSettings);
  applyWindowVisual(currentSettings);
  fadeEnabled = currentSettings.fadeWhenIdle;
  if (!fadeEnabled) setCollapsed(false);
  onSettingsChange?.(currentSettings);
}

// ── Boot ───────────────────────────────────────────────────────────────────────

export function initShell(opts: { onSettingsChange: (s: ShellSettings) => void }) {
  // `?resetSettings=1` wipes persisted shell/web settings. A sessionStorage flag
  // prevents Vite HMR reloads from re-clearing within the same session.
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('resetSettings') && !sessionStorage.getItem('fcm_reset_done')) {
      localStorage.removeItem(SHELL_SETTINGS_KEY);
      localStorage.removeItem(WEB_SETTINGS_KEY);
      sessionStorage.setItem('fcm_reset_done', '1');
    }
  } catch { /* ignore */ }
  currentSettings = loadShellSettings();
  // Re-sync WEB_SETTINGS_KEY so ChatOverlay reads current values on boot,
  // not a stale mirror left from a previous session.
  persistLocal(currentSettings);
  onSettingsChange = opts.onSettingsChange;

  // DEV-ONLY: test hooks for the screenshot harness.
  (window as unknown as { __ovTest?: unknown }).__ovTest = {
    collapse: () => setCollapsed(true),
    expand: () => setCollapsed(false),
    noIdle: () => { fadeEnabled = false; if (collapsed) setCollapsed(false); },
  };

  applyVisualLayers(currentSettings);
  applyScale(currentSettings);
  applyWindowVisual(currentSettings);
  // NOTE: we no longer re-apply scale on window resize. Scale is now purely a
  // function of the user's chosen font size (no window-height clamp), so resizes
  // must NOT touch it. This is critical on Wayland (Bazzite): the compositor
  // resizes the overlay when Fallout 76 launches/closes, and the old resize→
  // re-clamp path is what reset the font to ~8px on every game launch.
  startIdleLoop(currentSettings);

  // Version update indicator: when main signals a newer version is available,
  // latch the version and apply a red dot to the settings panel version span.
  // The panel may not be built yet (it's lazy), so we store the version and
  // apply it when the panel is first opened.
  window.relayBridge.onUpdateAvailable?.(({ latestVersion }) => {
    pendingUpdateVersion = latestVersion;
    applyUpdateDot(latestVersion);
  });
  // Also poll on startup — the update event may have fired before this listener
  // was registered (WS connects early, before initShell completes).
  window.relayBridge.getPendingUpdate?.().then(v => {
    if (v) { pendingUpdateVersion = v; applyUpdateDot(v); }
  }).catch(() => { /* non-fatal */ });

  // While collapsed, re-assert on any window resize (compositor-driven or manual)
  // so the viewport never jumps to the chat input. Debounced; skips the
  // collapse/expand animation's own resize burst (within TRANSITION_SETTLE_MS).
  let resizeReassertTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (!collapsed) return;
    if (resizeReassertTimer) clearTimeout(resizeReassertTimer);
    resizeReassertTimer = setTimeout(() => {
      resizeReassertTimer = null;
      if (Date.now() - lastTransitionMs < TRANSITION_SETTLE_MS) return;
      reassertCollapsed();
    }, 60);
  });

  const MIN_WIDTH = RESIZE_MIN_WIDTH;
  const MIN_HEIGHT = RESIZE_MIN_HEIGHT;

  // ── In-app edge/corner resize zones (Linux/Wayland only) ────────────────────
  // WM edge-resize is unreliable for frameless windows on KDE Plasma 6 / Wayland,
  // so invisible hit-target divs along each edge/corner send computed bounds via
  // overlay:resize-bounds. Skipped on Windows/macOS where native thickFrame resize
  // works and this z-9999 layer would conflict with the drag-to-move header.
  // Active only when not collapsed and not in click-through mode.
  // navigator.platform is deprecated and may be reduced to '' by newer Chromium
  // (Electron 39+). Fall back to the userAgent, which still reliably contains
  // 'Linux' — otherwise an affected build skips the ENTIRE Linux drag+resize block
  // below, leaving the window impossible to move or resize (app-region drag is
  // unreliable on KDE Wayland, so the JS path here is the only way to move it).
  const IS_LINUX_RENDERER = detectLinuxRenderer(navigator.platform, navigator.userAgent);
  try {
    window.relayBridge.logDiag?.(
      `[drag] linux-renderer=${IS_LINUX_RENDERER} platform="${navigator.platform}" ua="${(navigator.userAgent || '').slice(0, 48)}"`,
    );
  } catch { /* noop */ }
  if (IS_LINUX_RENDERER) {
    const ZONE_THICKNESS = 6; // px — hit area width/height for each edge zone
    const CORNER_SIZE = 14;   // px — corner hit areas are larger for easier grab
    // Each zone descriptor: id, edge membership, cursor.
    // Edges: 'n' north (top), 's' south (bottom), 'e' east (right), 'w' west (left).
    const zones: Array<{
      id: string;
      edges: string; // subset of 'nse w' — which bounds values this zone changes
      cursor: string;
      style: Partial<CSSStyleDeclaration>;
    }> = [
      // Edges
      {
        id: 'rz-n', edges: 'n', cursor: 'ns-resize',
        style: { top: '0', left: String(CORNER_SIZE) + 'px', right: String(CORNER_SIZE) + 'px', height: String(ZONE_THICKNESS) + 'px' },
      },
      {
        id: 'rz-s', edges: 's', cursor: 'ns-resize',
        style: { bottom: '0', left: String(CORNER_SIZE) + 'px', right: String(CORNER_SIZE) + 'px', height: String(ZONE_THICKNESS) + 'px' },
      },
      {
        id: 'rz-e', edges: 'e', cursor: 'ew-resize',
        style: { top: String(CORNER_SIZE) + 'px', bottom: String(CORNER_SIZE) + 'px', right: '0', width: String(ZONE_THICKNESS) + 'px' },
      },
      {
        id: 'rz-w', edges: 'w', cursor: 'ew-resize',
        style: { top: String(CORNER_SIZE) + 'px', bottom: String(CORNER_SIZE) + 'px', left: '0', width: String(ZONE_THICKNESS) + 'px' },
      },
      // Corners
      {
        id: 'rz-nw', edges: 'nw', cursor: 'nwse-resize',
        style: { top: '0', left: '0', width: String(CORNER_SIZE) + 'px', height: String(CORNER_SIZE) + 'px' },
      },
      {
        id: 'rz-ne', edges: 'ne', cursor: 'nesw-resize',
        style: { top: '0', right: '0', width: String(CORNER_SIZE) + 'px', height: String(CORNER_SIZE) + 'px' },
      },
      {
        id: 'rz-sw', edges: 'sw', cursor: 'nesw-resize',
        style: { bottom: '0', left: '0', width: String(CORNER_SIZE) + 'px', height: String(CORNER_SIZE) + 'px' },
      },
      {
        id: 'rz-se', edges: 'se', cursor: 'nwse-resize',
        style: { bottom: '0', right: '0', width: String(CORNER_SIZE) + 'px', height: String(CORNER_SIZE) + 'px' },
      },
    ];

    const rzContainer = document.createElement('div');
    rzContainer.id = 'shell-resize-zones';
    Object.assign(rzContainer.style, {
      position: 'fixed',
      top: '0', left: '0', right: '0', bottom: '0',
      pointerEvents: 'none',
      zIndex: '9999',
      userSelect: 'none',
      webkitAppRegion: 'no-drag',
    } as Partial<CSSStyleDeclaration>);

    let rzVisible = true; // zones enabled (non-collapsed, non-click-through)

    const syncZoneVisibility = () => {
      const modalOpen = !!document.querySelector('#shell-settings-backdrop.open, #shell-onboarding-backdrop.open');
      rzVisible = !collapsed && !modalOpen;
      rzContainer.querySelectorAll<HTMLElement>('.shell-rz').forEach(z => {
        z.style.pointerEvents = rzVisible ? 'auto' : 'none';
      });
    };
    window.addEventListener('fcm-overlay-collapsed', () => syncZoneVisibility());
    window.addEventListener('resize', () => syncZoneVisibility());

    try {
      const rzMo = new MutationObserver(syncZoneVisibility);
      rzMo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
    } catch { /* non-fatal */ }

    window.relayBridge.onClickThrough?.((on: boolean) => {
      if (!on) syncZoneVisibility();
      showClickThroughToast(on);
    });

    zones.forEach(({ id, edges, cursor, style }) => {
      const zone = document.createElement('div');
      zone.id = id;
      zone.className = 'shell-rz';
      Object.assign(zone.style, {
        position: 'absolute',
        ...style,
        cursor,
        pointerEvents: rzVisible ? 'auto' : 'none',
        background: 'transparent',
        webkitAppRegion: 'no-drag',
      } as Partial<CSSStyleDeclaration>);

      let resizing = false;
      let startPointerX = 0;
      let startPointerY = 0;
      let startBounds: { x: number; y: number; width: number; height: number } | null = null;

      zone.addEventListener('pointerdown', async (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!rzVisible) return;
        e.preventDefault();
        e.stopPropagation();
        try { zone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        try {
          startBounds = await (window.relayBridge.getBounds?.() as Promise<{ x: number; y: number; width: number; height: number } | null>);
        } catch { startBounds = null; }
        if (!startBounds) return;

        startPointerX = e.screenX;
        startPointerY = e.screenY;
        resizing = true;

      });

      zone.addEventListener('pointermove', (e: PointerEvent) => {
        if (!resizing || !startBounds) return;
        e.preventDefault();

        const dx = e.screenX - startPointerX;
        const dy = e.screenY - startPointerY;

        const edgeList = [...edges] as ResizeEdge[];
        const { x, y, width, height } = computeResizeBounds(
          edgeList, startBounds, dx, dy, MIN_WIDTH, MIN_HEIGHT,
        );

        try {
          window.relayBridge.resizeBounds?.({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
        } catch { /* ignore */ }
      });

      const endResize = (e: PointerEvent) => {
        if (!resizing) return;
        resizing = false;
        startBounds = null;
        try { zone.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      };
      zone.addEventListener('pointerup', endResize);
      zone.addEventListener('pointercancel', endResize);

      rzContainer.appendChild(zone);
    });

    document.body.appendChild(rzContainer);
    syncZoneVisibility();
  }

  // ── WM-independent pointer-drag MOVE (Linux/Wayland only) ───────────────────
  // On KDE Plasma 6 / Wayland, -webkit-app-region:drag is unreliable for frameless
  // windows. JS pointer-drag via moveStart/moveTick IPC is used instead.
  //
  // To prevent the WM from starting a competing drag over the same gesture (which
  // caused jitter), a stylesheet forces -webkit-app-region:no-drag !important for
  // the WM's used value while el.style.webkitAppRegion stays 'drag' so isDragTarget
  // detection still works. Windows/macOS keep native WM-driven drag; this handler
  // stays off there.
  if (IS_LINUX_RENDERER) {
    // `!important` overrides React's non-important inline webkitAppRegion for the
    // compositor without affecting el.style reads used by isDragTarget.
    const noDragStyle = document.createElement('style');
    noDragStyle.id = 'shell-linux-nodrag';
    noDragStyle.textContent = '* { -webkit-app-region: no-drag !important; }';
    document.head.appendChild(noDragStyle);

    let moveActive = false;
    let moveCaptureEl: HTMLElement | null = null;
    let clickThroughOn = false;

    window.relayBridge.onClickThrough?.((on: boolean) => { clickThroughOn = on; });

    const isDragTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return isDragTargetCore(
        target as unknown as Parameters<typeof isDragTargetCore>[0],
        document.documentElement as unknown as Parameters<typeof isDragTargetCore>[0],
      );
    };

    document.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (clickThroughOn) return;
      const modalOpen = !!document.querySelector('#shell-settings-backdrop.open, #shell-onboarding-backdrop.open');
      if (modalOpen) return;
      // Diagnostic: record the drag decision for every left-click so a user log
      // tells us whether the top bar is recognised as a drag target (the move IPC
      // is otherwise silent). Drop once the Linux drag issue is confirmed fixed.
      const dragOk = isDragTarget(e.target);
      try {
        window.relayBridge.logDiag?.(`[drag] pointerdown dragTarget=${dragOk} tag=${(e.target as HTMLElement)?.tagName || '?'}`);
      } catch { /* noop */ }
      if (!dragOk) return;
      moveActive = true;
      moveCaptureEl = e.target as HTMLElement;
      try { moveCaptureEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      try { window.relayBridge.moveStart?.(); } catch { /* ignore */ }
      e.preventDefault();
      e.stopPropagation();
    }, true /* capture */);

    document.addEventListener('pointermove', (e: PointerEvent) => {
      if (!moveActive) return;
      e.preventDefault();
      try { window.relayBridge.moveTick?.(); } catch { /* ignore */ }
    }, true /* capture */);

    const endMove = (e: PointerEvent) => {
      if (!moveActive) return;
      moveActive = false;
      try { window.relayBridge.moveEnd?.(); } catch { /* ignore */ }
      try { moveCaptureEl?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      moveCaptureEl = null;
    };
    document.addEventListener('pointerup', endMove, true);
    document.addEventListener('pointercancel', endMove, true);
  }

  // Esc closes the settings panel.
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && panelEl?.classList.contains('open')) closeSettings(); }, true);

  window.relayBridge.onCommand((cmd) => {
    if (cmd === 'channel:next') navChannel(1);
    else if (cmd === 'channel:prev') navChannel(-1);
    else if (cmd === 'settings:open') toggleSettings();
    else if (cmd === 'party:recent') window.dispatchEvent(new CustomEvent('fcm-recent-party'));
  });

  // On focus-input, jump the feed to the latest message (idempotent; only on explicit activation).
  window.relayBridge.onFocusInput(() => { scrollMessagesToBottomDeferred(); });

  // Overlay shown without input capture — blur so keystrokes stay in the game.
  window.relayBridge.onBlurInput?.(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setTimeout(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, 100);
  });

  // Clear idle state + un-collapse (e.g. focus-to-chat while faded). Main owns the window-height grow.
  window.relayBridge.onForceExpand(() => {
    lastActivityMs = Date.now();
    // Cancel any pending debounced message-activity expand to prevent thrash.
    if (msgActivityTimeout) { clearTimeout(msgActivityTimeout); msgActivityTimeout = null; }
    if (collapsed) {
      collapsed = false;
      // #327: fully reveal — not just the root 'collapsed' class. Previously this
      // path left the body/input/footer carrying 'fcm-collapsed-hidden', so when
      // the Insert hotkey's force-expand won the race against the local
      // keydown→setCollapsed(false) path (which then no-op'd on its guard), the
      // overlay expanded but showed nothing but the top bar. Funnel through the
      // same reveal as setCollapsed so the two paths can't diverge.
      const hiddenEls = collapsedHidden.slice();
      collapsedHidden = [];
      revealCollapsedElements(document.getElementById('root'), hiddenEls);
      scrollMessagesToBottomDeferred();
    }
  });

  // Report hover state so main can flip mouse-ignore automatically.
  let lastInteractive = true;
  document.addEventListener('mousemove', (e) => {
    // While a modal is open the window is always interactive — slider drags fire
    // mousemove and the cursor can wander onto the backdrop; without this guard
    // the window would flip to click-through mid-drag and kill the gesture.
    // #fcm-picker-portal and .ss-ac are portaled to <body> (outside #root) and
    // must also count as interactive UI.
    const modalOpen = !!document.querySelector('#shell-settings-backdrop.open, #shell-onboarding-backdrop.open');
    const overUi = modalOpen
      || !!(e.target as HTMLElement)?.closest('#shell-overlay-host, #shell-bar, #shell-settings-backdrop, #shell-onboarding-backdrop, #fcm-picker-portal, .ss-ac');
    if (overUi !== lastInteractive) {
      lastInteractive = overUi;
      window.relayBridge.setInteractive(overUi);
    }
  });

  // Watch modal `.open` class and force full-window interactivity while open
  // (overrides click-through). Decoupled from call sites — won't be missed.
  // setModalInteractive → `overlay:set-modal` is NOT gated by autoClickThrough.
  let lastModalPinned = false;
  const syncModalPin = () => {
    const open = !!document.querySelector('#shell-settings-backdrop.open, #shell-onboarding-backdrop.open');
    if (open !== lastModalPinned) {
      lastModalPinned = open;
      try { window.relayBridge.setModalInteractive?.(open); } catch { /* non-fatal */ }
    }
  };
  try {
    const mo = new MutationObserver(syncModalPin);
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  } catch { /* non-fatal */ }

  return { settings: currentSettings, openSettings, toggleSettings };
}
