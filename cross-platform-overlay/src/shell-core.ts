// shell-core.ts — pure, side-effect-free helpers extracted from shell.ts.
//
// Nothing in this module touches the DOM directly, electron, or module-level
// mutable state. Every function takes its inputs explicitly and returns a value,
// so it can be unit-tested in isolation (vitest). shell.ts imports these and
// keeps its thin DOM/IPC wrappers around them.
//
// The one exception is `isDragTarget`, which walks an element ancestry chain —
// but it only reads standard HTMLElement properties (classList, tagName,
// isContentEditable, id, style.webkitAppRegion) that jsdom fully supports, and
// it never mutates anything. The stop sentinel (document root) is injected so
// the function stays free of any global lookup.

// ── Constants (shared with shell.ts) ─────────────────────────────────────────

export const BASE_FONT = 14;
export const RESIZE_MIN_WIDTH = 320;
export const RESIZE_MIN_HEIGHT = 280;

// Scale (CSS zoom) is clamped to this range.
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2.5;
// Below this absolute difference from 1.0 we leave `zoom` unset (see applyScale
// comment in shell.ts — setting zoom:1 still establishes a containing block).
export const SCALE_UNSET_EPSILON = 0.005;

// ── Theme palette ────────────────────────────────────────────────────────────

export interface ShellPaletteEntry {
  primary: string;
  text: string;
}

export const SHELL_PALETTE: Record<string, ShellPaletteEntry> = {
  'fo76-wasteland':  { primary: '#C8A840', text: '#E8DFC0' },
  'vault-tec-green': { primary: '#18FF62', text: '#18FF62' },
  'amber':           { primary: '#FFB000', text: '#FFB000' },
  'white':           { primary: '#F0F0F0', text: '#F0F0F0' },
};

// Green stays only as the fallback when no theme is set / unknown.
export const SHELL_PALETTE_FALLBACK: ShellPaletteEntry = { primary: '#18FF62', text: '#18FF62' };

/**
 * Resolve the three chrome CSS-variable values for a theme id. Unknown/empty id
 * falls back to green. The dim accent is the primary at 18% alpha (hex8 '2E').
 */
export function chromeThemeVars(themeId: string | undefined): {
  primary: string;
  text: string;
  primaryDim: string;
} {
  const pal = (themeId && SHELL_PALETTE[themeId]) || SHELL_PALETTE_FALLBACK;
  return {
    primary: pal.primary,
    text: pal.text,
    primaryDim: pal.primary + '2E',
  };
}

// ── Accelerator helpers ────────────────────────────────────────────────────────

/** The subset of a DOM KeyboardEvent that accelFromEvent needs. */
export interface AccelKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Capture a (DOM-like) keyboard event into an Electron accelerator string.
 * Modifier ordering is always CommandOrControl → Alt → Shift → key.
 * A bare modifier returns null; ' ' maps to 'Space'; single chars are
 * upper-cased; named keys (Insert, Delete, Home, …) pass through verbatim.
 */
/**
 * Keys that must never be used as keybind accelerators — either because
 * Electron's globalShortcut cannot register them, they are OS-reserved in a
 * way that always breaks the user's workflow, or they represent incomplete /
 * IME-composed keystrokes that produce no usable accelerator string.
 */
export const BLOCKED_KEYS = new Set([
  // ── clear-bind sentinel (handled by the settings UI, not a real bind) ───
  'Escape',
  // ── modifier keys (must always combine with another key) ─────────────────
  'Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Hyper', 'Super',
  // ── lock keys — toggle OS state, not reliably registerable ───────────────
  'CapsLock', 'NumLock', 'ScrollLock',
  // ── keys Electron's globalShortcut cannot register ────────────────────────
  'Pause', 'ContextMenu',
  // ── incomplete / IME / unknown keystrokes ─────────────────────────────────
  'Unidentified', 'Dead', 'Process', 'Compose',
  // ── OS-owned function keys (brightness, keyboard backlight, etc.) ─────────
  'BrightnessDown', 'BrightnessUp',
  'KeyboardBacklightDown', 'KeyboardBacklightToggle', 'KeyboardBacklightUp',
  // ── power management — never appropriate as an app keybind ───────────────
  'Power', 'Standby', 'WakeUp', 'Hibernate', 'SleepModeToggle',
]);

export function accelFromEvent(e: AccelKeyEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = e.key;
  // Block modifier-only, clear-bind sentinel, OS-reserved, and unregisterable keys.
  if (BLOCKED_KEYS.has(key)) return null;
  // 'Dead' is a prefix for dead accent keys (e.g. 'Dead`') — block all variants.
  if (key.startsWith('Dead')) return null;
  // Normalize DOM key names to Electron accelerator key names.
  if (key === ' ') key = 'Space';
  // DOM fires 'ArrowLeft' etc.; Electron uses 'Left', 'Right', 'Up', 'Down'.
  else if (key.startsWith('Arrow')) key = key.slice(5);
  // DOM fires 'Enter'; Electron accelerator format requires 'Return'.
  else if (key === 'Enter') key = 'Return';
  else if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join('+');
}

/**
 * Pretty-print an Electron accelerator for display. CommandOrControl becomes
 * 'Cmd' on Mac and 'Ctrl' elsewhere; '+' separators get spaced out.
 */
export function prettyAccel(a: string, isMac: boolean): string {
  return a
    .replace('CommandOrControl', isMac ? 'Cmd' : 'Ctrl')
    .replace(/\+/g, ' + ');
}

/**
 * Fallout 76 default gameplay/UI keys. Binding the overlay to one of these as a
 * BARE (modifier-less) key means pressing it in-game triggers BOTH the overlay
 * action AND the game (issue #136: the reporter bound Tab=nextChannel, so every
 * Pip-Boy open also popped the overlay). The editor WARNS — it does not block — so
 * a user who really wants it can still bind it. The value is a short human label of
 * what the game uses the key for, used to build the warning. Keys are in Electron
 * accelerator form (single letters upper-cased; 'Space'/'Tab' named) so they match
 * accelFromEvent output exactly.
 */
export const GAME_RESERVED_KEYS: Record<string, string> = {
  Tab: 'the Pip-Boy',
  Space: 'jump',
  E: 'use / interact',
  R: 'reload',
  Q: 'quick-action',
  F: 'melee / take-all',
  C: 'crouch',
  V: 'melee bash',
  T: 'voice / push-to-talk',
  // WASD movement
  W: 'move forward',
  A: 'move left',
  S: 'move back',
  D: 'move right',
};

/**
 * If `accel` is a bare FO76 gameplay key, return a human warning string; otherwise
 * null. A modifier combo (Ctrl/Alt/Shift/Cmd/Super + key) is never reserved — the
 * game won't see it — so those always return null. See GAME_RESERVED_KEYS / #136.
 */
export function gameReservedWarning(accel: string | null | undefined): string | null {
  if (!accel || typeof accel !== 'string') return null;
  // Any modifier-prefixed combo is safe (game never receives Ctrl/Alt/Shift+key).
  if (/^(CommandOrControl|Ctrl|Control|Cmd|Command|Shift|Alt|Option|Super|Meta|Hyper)\+/i.test(accel)) return null;
  const use = GAME_RESERVED_KEYS[accel];
  if (!use) return null;
  return `Fallout 76 uses ${accel} for ${use}. Binding it will also trigger the game in-game. Pick another key or add a modifier (e.g. Alt+${accel}).`;
}

/**
 * Non-destructive keybind reset (issue #136 §3.1). The one-time reset must NOT wipe
 * a user's customised binds. It returns a full keybind map that starts from the
 * defaults and then keeps every bind the user actually SET (a non-empty string),
 * filling only the unset/blank ones. So a reinstall — or a KEYBIND_RESET_VERSION
 * bump that adds a new default action — never clobbers a working config. Inputs are
 * not mutated; non-string user values are treated as unset.
 */
export function mergeKeybindDefaults<T extends Record<string, string>>(
  current: Partial<T> | null | undefined,
  defaults: T,
): T {
  const out: T = { ...defaults };
  if (current && typeof current === 'object') {
    for (const k of Object.keys(out) as (keyof T)[]) {
      const v = current[k];
      if (typeof v === 'string' && v.trim() !== '') out[k] = v as T[keyof T];
    }
  }
  return out;
}

// ── Channel normalization ──────────────────────────────────────────────────────

/**
 * Normalize a list of raw tab labels into the channel candidate set. The four
 * defaults (General/Trading/Events/Raids) are always present. Each raw label is
 * Title-cased (first char upper, rest lower), deduped, and the result is sorted
 * with locale compare.
 */
export function collectChannels(rawLabels: Iterable<string>): string[] {
  const set = new Set<string>(['General', 'Trading', 'Events', 'Raids']);
  for (const raw of rawLabels) {
    const t = (raw || '').trim();
    if (t) set.add(t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ── Nav (channel/tab) index math ──────────────────────────────────────────────

/**
 * Compute the next tab index for a directional nav. Wraps in both directions.
 * Returns -1 when there are no tabs (caller should no-op). `cur` is clamped to
 * a non-negative index first (callers pass 0 when nothing is active).
 */
export function nextNavIndex(cur: number, dir: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  const c = cur < 0 ? 0 : cur;
  return (c + dir + count) % count;
}

// ── Scale / opacity → CSS mapping ──────────────────────────────────────────────

/**
 * Map a desired font size to a CSS `zoom` value. Returns '' (meaning: leave
 * zoom unset) when the requested scale is within SCALE_UNSET_EPSILON of 1.0,
 * otherwise the clamped numeric scale as a string.
 */
export function scaleZoomValue(fontSize: number): string {
  const requested = Math.max(SCALE_MIN, Math.min(SCALE_MAX, fontSize / BASE_FONT));
  return Math.abs(requested - 1) < SCALE_UNSET_EPSILON ? '' : String(requested);
}

/** Clamp the chrome background alpha (--fcm-chrome-bg-alpha) to 0..1. */
export function chromeBgAlpha(windowOpacity: number): number {
  return Math.max(0, Math.min(1, windowOpacity));
}

/** Clamp the text opacity (--fcm-text-opacity) to 0.1..1 (never fully invisible). */
export function textOpacityValue(textOpacity: number): number {
  return Math.max(0.1, Math.min(1, textOpacity));
}

/** Clamp the scanline intensity to 0..1. */
export function scanlineOpacityValue(intensity: number): number {
  return Math.max(0, Math.min(1, intensity));
}

// Idle auto-collapse delay (seconds) bounds. The overlay collapses to its header
// strip after this many seconds of no activity. Kept user-configurable because
// the previous fixed 25s felt too short for some players. Bounded so a stray
// persisted value can never disable the collapse (0) or strand it for hours.
export const IDLE_COLLAPSE_SECONDS_MIN = 5;
export const IDLE_COLLAPSE_SECONDS_MAX = 120;
export const IDLE_COLLAPSE_SECONDS_DEFAULT = 25;

/**
 * Clamp/sanitise the idle-collapse delay (seconds). Non-finite or out-of-range
 * values fall back to the default (NaN/undefined) or the nearest bound.
 */
export function clampIdleCollapseSeconds(seconds: number | undefined | null): number {
  const n = typeof seconds === 'number' ? seconds : NaN;
  if (!Number.isFinite(n)) return IDLE_COLLAPSE_SECONDS_DEFAULT;
  return Math.max(IDLE_COLLAPSE_SECONDS_MIN, Math.min(IDLE_COLLAPSE_SECONDS_MAX, Math.round(n)));
}

// ── Idle-collapse header-strip height math ──────────────────────────────────────
// The overlay collapses to a window showing only the shell bar + the two tab rows.
// The window height (visual/DIP px) is the shell-bar height plus the header strip
// height, clamped to a plausible band so a bad mid-reflow measurement can never
// reveal the message body / input.
//
// CSS-zoom gotcha (root cause of the "collapses to the input box" bug): the strip
// is measured with getBoundingClientRect() on elements inside the CSS-`zoom`ed
// #root. Whether that rect already includes the zoom depends on the Chromium
// build — Chromium ≤127 (Electron ≤31) returned UNSCALED CSS-px; Chromium 138
// (Electron 39) returns zoom-SCALED px. The caller passes `rectToVisual` (1 when
// rects are already scaled, else the zoom factor) so this stays a pure unit
// conversion. Pure + DOM-free → unit-tested for both modes.
export interface CollapsedHeightInput {
  barH: number;                  // shell-bar height — already visual px (outside #root)
  rawDelta: number | null;       // measured (subRowBottom − hostTop) in RAW rect px, or null
  rectToVisual: number;          // raw-rect px → visual px (1 if rects are zoom-scaled)
  safeVisual: number;            // fallback header height (visual px)
  minVisual: number;             // plausibility band, visual px
  maxVisual: number;
}
export function resolveCollapsedHeight(o: CollapsedHeightInput): number {
  const candidateVisual = o.rawDelta == null ? null : o.rawDelta * o.rectToVisual;
  const headerVisual =
    candidateVisual != null && candidateVisual >= o.minVisual && candidateVisual <= o.maxVisual
      ? candidateVisual
      : o.safeVisual;
  // +1 for the sub-tab row's 1px bottom border (needs a full px above it).
  return Math.round(o.barH + Math.ceil(headerVisual)) + 1;
}

// Minimal element shape for the reveal helper — just the classList.remove we use.
// HTMLElement satisfies this, so shell.ts passes real elements unchanged, and the
// helper stays DOM-free for unit tests.
export interface ClassListTarget {
  classList: { remove(token: string): void };
}
// Fully reveal collapsed content: drop the root 'collapsed' class AND clear
// 'fcm-collapsed-hidden' from every element hidden during collapse. Both expand
// paths (setCollapsed's deferred reveal and the force-expand/Insert handler) must
// funnel through this so they can't diverge — the divergence was #327, where the
// force-expand path removed 'collapsed' but left the body/input/footer hidden.
export function revealCollapsedElements(
  root: ClassListTarget | null,
  hidden: Iterable<ClassListTarget>,
): void {
  root?.classList.remove('collapsed');
  for (const el of hidden) el.classList.remove('fcm-collapsed-hidden');
}

// ── Shell → React-component settings mirror ─────────────────────────────────────
// The Electron shell owns the full ShellSettings, but the shared ChatOverlay
// component reads a SUBSET from its own localStorage key (WEB_SETTINGS_KEY). The
// shell mirrors that subset on every change AND on load (see initShell) so the
// component never reads a stale mirror after a reload. Pure + DOM-free so the
// "mirror carries every component-facing field" invariant is unit-tested.
export interface WebMirrorInput {
  themeId: string;
  textOpacity: number;
  showHints: boolean;
  showTimestamps: boolean;
  timestampFormat: '12h' | '24h';
  disableNameMotion: boolean;
  channelFilters: string[];
  notifyKeywords: string[];
  showTypingWhenCollapsed: boolean;
  notifySoundEnabled: boolean;
  notifySoundVolume: number;
}
export interface WebMirrorSettings {
  themeId: string;
  windowOpacity: number;
  textOpacity: number;
  fontSize: number;
  showHints: boolean;
  showTimestamps: boolean;
  timestampFormat: '12h' | '24h';
  disableNameMotion: boolean;
  channelFilters: string[];
  notifyKeywords: string[];
  showTypingWhenCollapsed: boolean;
  notifySoundEnabled: boolean;
  notifySoundVolume: number;
}
export function shellToWebSettings(s: WebMirrorInput): WebMirrorSettings {
  return {
    themeId: s.themeId,
    // Chrome opacity is applied via the --fcm-chrome-bg-alpha CSS variable, so the
    // component must NOT also dim the whole window → its own windowOpacity is 1.
    windowOpacity: 1,
    textOpacity: s.textOpacity,
    // The shell scales the whole UI via CSS zoom; the component keeps the base
    // font so the two don't compound.
    fontSize: BASE_FONT,
    showHints: s.showHints,
    showTimestamps: s.showTimestamps,
    timestampFormat: s.timestampFormat,
    // Viewer opt-out for animated supporter name effects. MUST be carried here — a
    // field that exists in ShellSettings but is missing from the mirror persists fine
    // and never reaches ChatOverlay, which is the classic silent failure for this
    // pattern (see the mirror-completeness test below).
    disableNameMotion: s.disableNameMotion,
    // Hidden-channel names — the component filters these out of the feed and
    // per-channel views (case-insensitive). Copied so the array can't alias.
    channelFilters: Array.isArray(s.channelFilters) ? s.channelFilters.slice() : [],
    // Words that highlight a message like an @mention of you (#422). Copied so
    // the array can't alias back into shell state.
    notifyKeywords: Array.isArray(s.notifyKeywords) ? s.notifyKeywords.slice() : [],
    // Keep the typing indicator in the tab strip while collapsed (#420).
    // Opt-in: `=== true` so a MISSING key (settings persisted before this
    // existed) resolves to false and matches the default. Using `!== false`
    // here would silently switch the feature ON for every existing install.
    showTypingWhenCollapsed: s.showTypingWhenCollapsed === true,
    // Opt-in like the typing indicator: a MISSING key must read as off, so
    // existing installs never start making noise after an update (#437).
    notifySoundEnabled: s.notifySoundEnabled === true,
    notifySoundVolume: typeof s.notifySoundVolume === 'number'
      ? Math.max(0, Math.min(1, s.notifySoundVolume))
      : 0.5,
  };
}

// ── Resize bounds math ─────────────────────────────────────────────────────────

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w';

/**
 * Compute the new window bounds for an edge/corner resize gesture.
 *   • n: moves the top edge → changes y and height (height = startH - dy).
 *   • s: moves the bottom edge → changes height only (height = startH + dy).
 *   • e: moves the right edge → changes width only (width = startW + dx).
 *   • w: moves the left edge → changes x and width (width = startW - dx).
 * Minimum width/height are enforced; when an n/w edge would shrink past the
 * minimum, the opposite anchor is held fixed by re-deriving x/y.
 *
 * Returns RAW (un-rounded) bounds — the caller rounds before sending to main.
 */
export function computeResizeBounds(
  edges: readonly ResizeEdge[],
  start: Bounds,
  dx: number,
  dy: number,
  minWidth: number = RESIZE_MIN_WIDTH,
  minHeight: number = RESIZE_MIN_HEIGHT,
): Bounds {
  let { x, y, width, height } = start;

  if (edges.includes('n')) {
    y = start.y + dy;
    height = start.height - dy;
  }
  if (edges.includes('s')) {
    height = start.height + dy;
  }
  if (edges.includes('e')) {
    width = start.width + dx;
  }
  if (edges.includes('w')) {
    x = start.x + dx;
    width = start.width - dx;
  }

  if (width < minWidth) {
    if (edges.includes('w')) x = start.x + start.width - minWidth;
    width = minWidth;
  }
  if (height < minHeight) {
    if (edges.includes('n')) y = start.y + start.height - minHeight;
    height = minHeight;
  }

  return { x, y, width, height };
}

// ── Drag-target detection ──────────────────────────────────────────────────────

/** Minimal element shape isDragTarget walks. Real HTMLElements satisfy this. */
export interface DragTargetEl {
  classList: { contains(token: string): boolean };
  tagName: string;
  isContentEditable: boolean;
  id: string;
  style: { webkitAppRegion?: string } & Record<string, unknown>;
  parentElement: DragTargetEl | null;
}

/**
 * Returns true if the element (or any ancestor up to — but not including — the
 * `stop` sentinel, normally document.documentElement) is a drag-eligible
 * overlay header element.
 *
 * Opt-OUT (return false immediately):
 *   • .shell-rz resize zones
 *   • .shell-btn header buttons
 *   • interactive tags: BUTTON / INPUT / SELECT / TEXTAREA
 *   • contentEditable elements
 *   • the settings/onboarding modal backdrops
 * Opt-IN (return true):
 *   • #shell-bar (pre-auth strip)
 *   • any element whose inline style.webkitAppRegion === 'drag'
 */
export function isDragTarget(
  target: DragTargetEl | null,
  stop: DragTargetEl | null,
): boolean {
  let el: DragTargetEl | null = target;
  while (el && el !== stop) {
    if (el.classList.contains('shell-rz')) return false;
    if (el.classList.contains('shell-btn')) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;
    if (el.isContentEditable) return false;
    if (el.id === 'shell-settings-backdrop' || el.id === 'shell-onboarding-backdrop') return false;

    if (el.id === 'shell-bar') return true;
    if (el.style.webkitAppRegion === 'drag') return true;

    el = el.parentElement;
  }
  return false;
}

// ── Text-entry Escape handling ────────────────────────────────────────────────

/** Minimal element shape walked by shouldExitTextEntryOnEscape. */
export interface TextEntryTargetEl {
  tagName?: string;
  isContentEditable?: boolean;
  id?: string;
  parentElement?: TextEntryTargetEl | null;
}

/** The subset of a DOM KeyboardEvent needed for text-entry Escape decisions. */
export interface TextEntryEscapeEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

function asTextEntryTargetEl(value: unknown): TextEntryTargetEl | null {
  if (!value || typeof value !== 'object') return null;
  const el = value as TextEntryTargetEl;
  if (typeof el.tagName !== 'string' && typeof el.id !== 'string' && !('parentElement' in el)) return null;
  return el;
}

/**
 * Returns true only for an unmodified Escape keydown that originated from an
 * editable chat input inside the overlay host. This intentionally stays
 * renderer-local; Escape must never be registered as an Electron globalShortcut.
 */
export function shouldExitTextEntryOnEscape(e: TextEntryEscapeEvent): boolean {
  if (e.key !== 'Escape') return false;
  if (e.defaultPrevented) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;

  let el = asTextEntryTargetEl(e.target);
  let sawEditable = false;
  while (el) {
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable === true) {
      sawEditable = true;
    }
    if (el.id === 'shell-settings-backdrop' || el.id === 'shell-onboarding-backdrop') return false;
    if (el.id === 'shell-overlay-host') return sawEditable;
    el = asTextEntryTargetEl(el.parentElement);
  }
  return false;
}

/**
 * Decide whether the renderer is running on Linux. `navigator.platform` is
 * deprecated and may be reduced to '' by newer Chromium (Electron 39+); the
 * userAgent still reliably contains 'Linux'. Used to gate the Linux-only
 * drag+resize handlers in shell.ts — a wrong `false` leaves the frameless
 * window impossible to move/resize on KDE Wayland (app-region drag is
 * unreliable there, so the JS pointer-drag path is the only way).
 */
export function detectLinuxRenderer(
  platform: string | null | undefined,
  userAgent: string | null | undefined,
): boolean {
  return /linux/i.test(platform || '') || /linux/i.test(userAgent || '');
}
