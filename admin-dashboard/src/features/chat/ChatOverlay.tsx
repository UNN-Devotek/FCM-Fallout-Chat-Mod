import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOutletContext, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { AuthUser } from '../../contexts/AuthContext';
import EmojiPicker, {
  extractEmojiTokens,
  loadRecentEmojiTokens,
  recordRecentEmoji,
  saveRecentEmojiTokens,
} from './EmojiPicker';
import GifPicker from './GifPicker';
import { usePickerInsert } from './usePickerInsert';
import { useDebouncedSearch } from './useDebouncedSearch';
import { ChatEmbedCard } from './components/ChatEmbedCard';
import { ChatInlineEmbed } from './components/ChatInlineEmbed';
import ImageLightbox from './components/ImageLightbox';
import { OutboxQueue } from './outboxQueue';

/**
 * Web-based chat overlay — identical to the desktop SkiaSharp overlay.
 * Same Pip-Boy two-row channel tabs, message rendering, input box.
 * Admin/mod users get inline moderation controls on each message.
 *
 * PARITY RULE: This component MUST stay visually identical to
 * ChatOverlay/ChatOverlayWindow.cs (see CLAUDE.md).
 */

// ── Built-in theme definitions (mirrors ChatTheme.cs BuiltIn) ─────────────────

interface WebTheme {
  id: string;
  displayName: string;
  backgroundColor: string;
  chromeColor: string;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  activeTabTextColor: string;
  activeTabGradientTop: string | null;
  activeTabGradientBottom: string | null;
  inputTextColor: string;
  inputBgColor: string;
  bgAlpha: number;
  chromeAlpha: number;
  inputAlpha: number;
  fontFamily: string;
  filledActiveTab: boolean;
  glowEnabled: boolean;
  scanlinesEnabled: boolean;
  // Per-theme font-size multiplier (default 1). The monospace themes (Courier
  // New) render noticeably larger/wider than the default Segoe UI theme at the
  // same px, so they use a slightly smaller scale + tighter letter-spacing.
  fontScale?: number;
  // Per-theme letter-spacing for tab labels (default '0.04em'); tightened on the
  // wider monospace themes.
  tabLetterSpacing?: string;
}

const THEMES: WebTheme[] = [
  {
    id: 'fo76-wasteland',
    displayName: 'Fallout 76',
    backgroundColor: '#0A0907',
    chromeColor: '#0C0A08',
    // Sampled directly from the in-game header text (#F5CB5B) so tab + username
    // text matches Fallout 76's gold exactly at any background opacity.
    primaryColor: '#F5CB5B',
    secondaryColor: '#C9A84E',
    // Warm off-white, pushed a bit brighter than the game's avg (#E1DDCB) toward
    // its highlight (#FFFFCB) so chat copy stays legible over bright game scenes.
    textColor: '#FAF4DA',
    activeTabTextColor: '#120D00',
    activeTabGradientTop: '#F5CB5B',
    activeTabGradientBottom: '#6A4808',
    inputTextColor: '#F3ECCF',
    inputBgColor: '#0A0907',
    bgAlpha: 0.941,
    chromeAlpha: 0.980,
    inputAlpha: 0.941,
    fontFamily: 'Segoe UI, system-ui, sans-serif',
    filledActiveTab: true,
    glowEnabled: false,
    scanlinesEnabled: false,
  },
  {
    id: 'vault-tec-green',
    displayName: 'Vault-Tec Green',
    backgroundColor: '#0A0F0A',
    chromeColor: '#0A0F0A',
    primaryColor: '#18FF62',
    secondaryColor: '#0EA843',
    textColor: '#18FF62',
    activeTabTextColor: '#001A08',
    activeTabGradientTop: null,
    activeTabGradientBottom: null,
    inputTextColor: '#18FF62',
    inputBgColor: '#0C120C',
    bgAlpha: 0.314,
    chromeAlpha: 0.502,
    inputAlpha: 0.533,
    fontFamily: '"Courier New", Courier, monospace',
    filledActiveTab: false,
    glowEnabled: true,
    scanlinesEnabled: true,
  },
  {
    id: 'amber',
    displayName: 'Amber',
    backgroundColor: '#0F0A00',
    chromeColor: '#0F0A00',
    primaryColor: '#FFB000',
    secondaryColor: '#B07000',
    textColor: '#FFB000',
    activeTabTextColor: '#1A0800',
    activeTabGradientTop: null,
    activeTabGradientBottom: null,
    inputTextColor: '#FFB000',
    inputBgColor: '#120C00',
    bgAlpha: 0.314,
    chromeAlpha: 0.502,
    inputAlpha: 0.533,
    fontFamily: '"Courier New", Courier, monospace',
    filledActiveTab: false,
    glowEnabled: true,
    scanlinesEnabled: true,
  },
  {
    id: 'white',
    displayName: 'White',
    backgroundColor: '#0A0A0A',
    chromeColor: '#0A0A0A',
    primaryColor: '#F0F0F0',
    secondaryColor: '#A0A0A0',
    textColor: '#F0F0F0',
    activeTabTextColor: '#111111',
    activeTabGradientTop: null,
    activeTabGradientBottom: null,
    inputTextColor: '#F0F0F0',
    inputBgColor: '#0C0C0C',
    bgAlpha: 0.314,
    chromeAlpha: 0.502,
    inputAlpha: 0.533,
    fontFamily: '"Courier New", Courier, monospace',
    filledActiveTab: false,
    glowEnabled: false,
    scanlinesEnabled: false,
  },
];

export function findTheme(id: string): WebTheme {
  return THEMES.find(t => t.id === id) ?? THEMES[0];
}

/**
 * WebSocket reconnect backoff: full-jitter exponential backoff capped at 16s.
 * `rand` is an injectable [0,1) RNG (defaults to Math.random) so it can be
 * stubbed in tests. Delay = rand() × min(16000, 1000 × 2^attempt) ms.
 */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  return rand() * Math.min(16000, 1000 * 2 ** attempt);
}

/**
 * Returns the delay (ms) for the next ticket-fetch retry attempt.
 * Auth failures (consecutiveAuthFailures ≥ 3) must be handled by the caller
 * before calling this function (they should stop retrying and surface a
 * terminal state instead of scheduling another retry).
 *
 * Non-auth failures (network / 5xx) use the same full-jitter exponential
 * backoff as the WS close path.
 */
export function nextTicketRetryDelay(
  attempt: number,
  rand: () => number = Math.random,
): number {
  return backoffDelay(attempt, rand);
}

/**
 * Returns true when the consecutive-auth-failure count has crossed the
 * threshold at which the ticket-fetch retry loop should stop and the UI
 * should surface an "authentication expired" terminal state instead.
 */
export function isAuthTerminal(consecutiveAuthFailures: number): boolean {
  return consecutiveAuthFailures >= 3;
}

/**
 * Decide which channel IDs to request `chat:history` for on a WS (re)connect.
 *
 * Two jobs:
 *  1. First-load: any known channel not yet in `alreadyLoaded` needs its history.
 *     (When the channel list isn't known yet, fall back to the active channel.)
 *  2. Blank-after-show guard: ALWAYS include the currently-active channel, even
 *     when it's already loaded. A flapping socket (the in-game reconnect storm)
 *     can have its onopen history burst cut off by the server closing the socket
 *     before the response arrives, leaving the visible pane blank until a stray
 *     live frame lands. Re-requesting the one active channel refills it; if its
 *     messages are already present the response is identical (no visible flash).
 *
 * Returns a de-duplicated list. The active channel, when present, is requested
 * exactly once regardless of which rule(s) selected it.
 */
export function reconnectHistoryChannelIds(opts: {
  activeChannelId: string | null;
  alreadyLoaded: Set<string>;
  knownChannelIds: string[];
}): string[] {
  const { activeChannelId, alreadyLoaded, knownChannelIds } = opts;
  const out = new Set<string>();
  if (knownChannelIds.length > 0) {
    for (const id of knownChannelIds) {
      if (!alreadyLoaded.has(id)) out.add(id);
    }
  } else if (activeChannelId && !alreadyLoaded.has(activeChannelId)) {
    out.add(activeChannelId);
  }
  // Blank-after-show guard: the visible channel is always refreshed.
  if (activeChannelId) out.add(activeChannelId);
  return [...out];
}

/**
 * Merge an incoming chat:history batch into the existing message list.
 * CRITICAL: returns the SAME `prev` array reference when nothing is new, so the
 * [messages] effects (re-render + scrollToBottom) don't fire. The blank-after-show
 * guard re-requests the active channel on every WS reconnect; after auto-hide drops
 * the socket, refocus reconnects and that re-request previously returned a NEW
 * same-content array, re-rendering the whole feed + yanking scroll = the visible
 * "flash/reload" on refocus. De-dupes by id, sorts ascending by timestamp, caps.
 */
export function mergeHistoryMessages<T extends { id: string; timestamp?: string }>(
  prev: T[],
  incoming: T[],
  cap: number,
): T[] {
  const seen = new Set(prev.map(m => m.id));
  const fresh = incoming.filter(m => !seen.has(m.id));
  if (fresh.length === 0) return prev; // no-op: same ref → no re-render / scroll-jump
  const merged = [...prev, ...fresh];
  merged.sort((a, b) => {
    const at = a.timestamp || '', bt = b.timestamp || '';
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
  return merged.slice(-cap);
}

/**
 * The active main tab's "cutout" divider span, in LAYOUT px (offsetLeft/offsetWidth)
 * — NOT getBoundingClientRect, which on Electron 39 (Chromium 138) returns
 * zoom-SCALED px under the shell's CSS `zoom`, over-scaling the cutout (left segment
 * bleeds into the tab, right segment gaps). offsetLeft/offsetWidth match the
 * absolutely-positioned divider's CSS px regardless of zoom.
 */
export function computeMainTabCutout(offsetLeft: number, offsetWidth: number): { left: number; right: number } {
  return { left: Math.max(0, offsetLeft), right: Math.max(0, offsetLeft + offsetWidth) };
}

/**
 * Px from the bottom of the message list within which we treat the user as
 * "pinned to the latest message" and keep auto-scrolling on new appends. Beyond
 * it, the user has deliberately scrolled up to read history and must not be
 * yanked back down.
 */
export const STICK_TO_BOTTOM_THRESHOLD = 80;

/**
 * Looser bottom threshold for the typing-indicator re-pin. The indicator is a
 * small (~16px) sibling whose appearance/disappearance resizes the message
 * area, so a more generous band keeps the newest message visible without
 * yanking a user who has genuinely scrolled up to read history.
 */
export const TYPING_INDICATOR_STICK_THRESHOLD = 120;

/**
 * Whether a scroll position counts as "at the bottom" (stuck to the latest msg).
 *
 * This MUST be sampled from a real scroll event (the user's actual position),
 * NOT recomputed right after a tall message is appended: once a tall card is in
 * the DOM, `scrollHeight` has already grown while `scrollTop` hasn't moved, so
 * `scrollHeight - scrollTop - clientHeight` ≈ the card's height and a
 * post-append reading wrongly looks like "scrolled up". See #313 — the old
 * auto-scroll guard made exactly that mistake and never scrolled to `/camp`
 * and `/nukecodes` cards.
 */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold: number = STICK_TO_BOTTOM_THRESHOLD,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * Whether becoming-visible must force a WS reconnect. onVisibility(true) fires on
 * hidden->visible, so overlayVisible was false. Only kick when the gate WON'T
 * already re-run the WS effect: the game was running (gate = overlayVisible ||
 * wsGameActive was already true, so a mid-backoff socket needs the manual kick).
 * When the game is NOT running the gate flips true on this visibility and re-runs
 * the effect itself — kicking too would double-fire it (the double-teardown).
 */
export function shouldForceReconnectOnVisible(opts: {
  isVisible: boolean;
  connected: boolean;
  wsGameActive: boolean;
}): boolean {
  return opts.isVisible && !opts.connected && opts.wsGameActive;
}

/**
 * Raw "should the authed WebSocket be open?" decision, derived from mode +
 * visibility + game state. Extracted as a pure function so the gating policy is
 * unit-testable against the real code (not a re-implemented copy).
 *
 * - `isPublicMode` is a hard lockdown: public mode never opens the authed WS,
 *   regardless of visibility or game state. Folding it in here also means a
 *   session expiry (user -> null flips isPublicMode true) immediately feeds
 *   through the gate and tears the socket down rather than leaving it open until
 *   an unrelated change re-runs the effect.
 * - Web (no overlay shell) always connects when not public.
 * - In the overlay shell, connect when the overlay is visible OR the game is
 *   running (so chat history is warm the instant the overlay shows).
 */
export function deriveWsShouldConnect(opts: {
  isPublicMode: boolean;
  overlayShell: boolean;
  overlayVisible: boolean;
  wsGameActive: boolean;
}): boolean {
  return !opts.isPublicMode && (!opts.overlayShell || opts.overlayVisible || opts.wsGameActive);
}

/**
 * Hysteresis gate hook: returns a smoothed version of `wsShouldConnect` that
 * connects immediately (true propagates synchronously) but delays disconnecting
 * by `gracePeriodMs`. If the input flips false→true within the grace window the
 * timer is cancelled and the gate never becomes false, preventing the
 * double-teardown race caused by rapid visibility / game-gate flaps.
 *
 * @param wsShouldConnect raw combined gate boolean
 * @param gracePeriodMs   ms to wait before propagating false (default 500 prod / 200 dev)
 */
export function useWsGate(
  wsShouldConnect: boolean,
  gracePeriodMs = import.meta.env.DEV ? 200 : 500,
): boolean {
  const [gate, setGate] = useState(wsShouldConnect);
  const latestRef = useRef(wsShouldConnect);
  useEffect(() => {
    latestRef.current = wsShouldConnect;
    if (wsShouldConnect) {
      setGate(true);
    } else {
      const t = setTimeout(() => {
        if (!latestRef.current) setGate(false);
      }, gracePeriodMs);
      return () => clearTimeout(t);
    }
  }, [wsShouldConnect, gracePeriodMs]);
  return gate;
}

// ── Desktop-overlay shell parity (Electron prototype only) ─────────────────────
// The cross-platform Electron shell sets window.__FCM_OVERLAY_SHELL__ (with IPC
// callbacks) before this component mounts. When present, the header renders the
// WinForms-style "FALLOUT 76" title + refresh/minimize/close icon buttons and a
// bordered active main-tab, matching the desktop overlay + marketing screenshots.
// On the website this global is never set, so nothing below changes its look.
interface OverlayShell {
  title: string;
  onRefresh?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  // When provided, the header gear opens the shell's full (desktop-parity)
  // settings panel instead of the component's built-in (subset) modal.
  onSettings?: () => void;
  // Absolute HTTP base of the relay (set by the Electron shell). Avatars are
  // same-origin paths on the backend, but the overlay renderer is served from a
  // different origin and <img> bypasses the fetch proxy, so avatar paths are
  // resolved against this base. Undefined on the website (same origin → as-is).
  relayBase?: string;
}
export function getOverlayShell(): OverlayShell | null {
  try { return (window as unknown as { __FCM_OVERLAY_SHELL__?: OverlayShell }).__FCM_OVERLAY_SHELL__ ?? null; }
  catch { return null; }
}

/**
 * Is this relay host the PRODUCTION host? The overlay footer shows a "[DEV]"
 * indicator whenever the build is pointed at any NON-prod relay
 * (dev.falloutchatmod.com, a staging host, localhost, …) so a focus-tester can
 * tell at a glance they're not on prod. Pure — unit-tested. Port is ignored;
 * matching is case-insensitive.
 */
export function isProdRelayHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return h === 'falloutchatmod.com' || h === 'www.falloutchatmod.com';
}

/**
 * Is `candidate` a STRICTLY newer version than `current`?
 *
 * Mirrors the shell's `cmpVersions` guard (cross-platform-overlay/overlay-core.js):
 * the backend broadcasts `app:update-available` to EVERY client whenever it has a
 * latest version cached — it does NOT compare against the client's installed
 * build — so the update dot must do the comparison itself. We can't import the
 * shell's `cmpVersions` here (it's a CommonJS module in a different package, outside
 * the Vite build root), so this is a minimal, intentionally identical re-implementation.
 *
 * Uses locale-aware numeric compare so '1.3.10' > '1.3.9' (not string-ordered).
 * A pre-release suffix sorts AFTER the bare release (e.g. '1.3.91-dev' > '1.3.91'),
 * which matches the shell: a dev/QA build of a release must NOT light the dot for
 * that same release. Malformed / non-string inputs are treated as '0.0.0', so they
 * never appear newer than a real version.
 */
export function isVersionNewer(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const normalize = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : '0.0.0');
  return normalize(candidate).localeCompare(normalize(current), undefined, { numeric: true, sensitivity: 'base' }) > 0;
}

/**
 * Resolve a backend avatar path to a loadable URL.
 *
 * Backend sends `avatarUrl` as a RELATIVE same-origin path ("/avatars/<id>")
 * or null. On the website the renderer shares the backend origin, so the path
 * loads as-is. In the Electron overlay the renderer is served from the app/Vite
 * origin and <img src> does NOT route through the bridge fetch-proxy, so a bare
 * "/avatars/<id>" would hit the wrong origin (and 404). There we prefix it with
 * the relay HTTP base from the shell. Returns null when there's no avatar (the
 * caller renders its letter/default fallback).
 */
export function resolveAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  // Already absolute (e.g. legacy Discord CDN URL) — use directly.
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl;
  const shell = getOverlayShell();
  const relayBase = shell?.relayBase;
  if (shell && relayBase) {
    // Join without doubling the slash.
    return `${relayBase.replace(/\/$/, '')}${avatarUrl.startsWith('/') ? '' : '/'}${avatarUrl}`;
  }
  // Website (same origin) — or shell without a resolved base yet: use as-is.
  return avatarUrl;
}

/**
 * Resolve a relative media URL (e.g. "/party-images/<id>") to an absolute URL.
 *
 * Party-uploaded images are served as relative paths from the backend. On the
 * website the renderer shares the backend origin so the path loads as-is.
 * In the Electron overlay the renderer is a different origin, so we prefix with
 * the relay HTTP base (same as avatar URLs).
 */
export function resolveMediaUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  const shell = getOverlayShell();
  const relayBase = shell?.relayBase;
  if (shell && relayBase) {
    return `${relayBase.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
  }
  return url;
}

/** Computes the result of inserting `@displayName ` into `current` at [selStart, selEnd].
 *  Adds a space before the mention when the preceding character is not already a space.
 *  The returned string is capped at `maxLen` characters. */
export function buildMentionInsert(
  current: string,
  displayName: string,
  selStart: number,
  selEnd: number,
  maxLen = 255,
): string {
  const before = current.slice(0, selStart);
  const after = current.slice(selEnd);
  const spacer = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
  return (before + spacer + `@${displayName} ` + after).slice(0, maxLen);
}

/** Escape a value for safe interpolation into a double/single-quoted HTML attribute. */
export function escapeHtmlAttr(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the rich (HTML) representation from a plain-text string that may contain
 * `<:name:id>` / `<a:name:id>` custom-emoji tokens, for assigning to the
 * contentEditable input's innerHTML. This is the single HTML-producing sink for
 * the rich input, so all sanitization lives here:
 *  - Free text is HTML-escaped (`&`, `<`, `>`) — no user text can introduce tags.
 *  - The only raw markup emitted is the emoji `<img>`, whose attribute values are
 *    drawn from the regex capture groups (`name` = [A-Za-z0-9_]+, `id` = \d{16,22})
 *    and additionally run through `escapeHtmlAttr`, so no value can break out of
 *    the quoted attribute to inject new attributes/tags/handlers.
 * Unicode emoji glyphs are left as-is (they render natively).
 */
export function buildRichHtmlImpl(text: string): string {
  const CUSTOM_RE = /<(a?):([A-Za-z0-9_]+):(\d{16,22})>/g;
  let html = '';
  let last = 0;
  let m: RegExpExecArray | null;
  CUSTOM_RE.lastIndex = 0;
  while ((m = CUSTOM_RE.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before) html += before.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const animated = m[1] === 'a';
    const name = m[2];
    const id = m[3];
    const src = animated
      ? `https://cdn.discordapp.com/emojis/${id}.webp?animated=true`
      : `https://cdn.discordapp.com/emojis/${id}.png`;
    const token = m[0];
    html += `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(`:${name}:`)}" title="${escapeHtmlAttr(`:${name}:`)}" data-token="${escapeHtmlAttr(token)}" style="height:20px;vertical-align:middle;margin:0 1px;display:inline">`;
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail) html += tail.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return html;
}

/** Serialize rich-input DOM/fragment nodes back to the plain-text message form. */
export function serializeRichContent(input: Pick<ParentNode, 'childNodes'>): string {
  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeName === 'IMG') {
      const token = (node as HTMLImageElement).dataset.token;
      return token ?? (node as HTMLImageElement).alt ?? '';
    }
    if (node.nodeName === 'BR') return '\n';
    let out = '';
    const isBlock = node.nodeName === 'DIV' || node.nodeName === 'P';
    for (const child of Array.from(node.childNodes)) out += walk(child);
    if (isBlock && (node as Element).previousSibling) out = '\n' + out;
    return out;
  }

  let out = '';
  for (const node of Array.from(input.childNodes)) out += walk(node);
  return out.replace(/\n$/, '');
}

/** Compute plain-text selection offsets for the rich composer, if selection is inside it. */
export function getRichSelectionOffsets(
  el: HTMLDivElement,
  selection: Selection | null = window.getSelection(),
): { start: number; end: number } | null {
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;

  const startRange = document.createRange();
  startRange.selectNodeContents(el);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = document.createRange();
  endRange.selectNodeContents(el);
  endRange.setEnd(range.endContainer, range.endOffset);

  return {
    start: serializeRichContent(startRange.cloneContents()).length,
    end: serializeRichContent(endRange.cloneContents()).length,
  };
}

/** Restore the rich composer caret at a plain-text offset across text, <br>, and emoji <img> nodes. */
export function placeRichCaretAtOffset(
  el: HTMLDivElement,
  offset: number,
  selection: Selection | null = window.getSelection(),
): void {
  const targetOffset = Math.max(0, offset);
  let remaining = targetOffset;
  let placed = false;
  const range = document.createRange();

  function walk(node: Node) {
    if (placed) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).length;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        placed = true;
        return;
      }
      remaining -= len;
      return;
    }

    if (node.nodeName === 'IMG') {
      const token = (node as HTMLImageElement).dataset.token ?? (node as HTMLImageElement).alt ?? '';
      const len = token.length;
      if (remaining <= len) {
        range.setStartAfter(node);
        range.collapse(true);
        placed = true;
        return;
      }
      remaining -= len;
      return;
    }

    if (node.nodeName === 'BR') {
      if (remaining <= 1) {
        range.setStartAfter(node);
        range.collapse(true);
        placed = true;
        return;
      }
      remaining -= 1;
      return;
    }

    for (const child of Array.from(node.childNodes)) walk(child);
  }

  walk(el);

  if (!placed) {
    range.selectNodeContents(el);
    range.collapse(false);
  }

  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/** Insert a token into plain text, clamp to max length, and return the advanced caret offset. */
export function insertTokenIntoText(
  current: string,
  start: number,
  end: number,
  token: string,
  maxLength = 255,
): { text: string; caretOffset: number } {
  const safeStart = Math.max(0, Math.min(current.length, start));
  const safeEnd = Math.max(safeStart, Math.min(current.length, end));
  const text = (current.slice(0, safeStart) + token + current.slice(safeEnd)).slice(0, maxLength);
  return {
    text,
    caretOffset: Math.min(text.length, safeStart + token.length),
  };
}

/**
 * Resolve where the caret should land after the rich input's text is set from
 * OUTSIDE (autocomplete, emoji insert, clear-on-send). Normally we preserve the
 * previously-saved caret offset (clamped to the new length) so emoji/token
 * inserts don't yank the caret. But for command-autocomplete completions the
 * caret must collapse to the END — otherwise picking "/minerva" while the caret
 * sat at offset 4 ("/min") restores offset 4 and lands mid-command ("/min|erva").
 */
export function resolveExternalSetCaret(
  textLength: number,
  savedOffset: number,
  forceToEnd: boolean,
): number {
  if (forceToEnd) return textLength;
  return Math.min(textLength, Math.max(0, savedOffset));
}

/**
 * Round avatar: Discord image when available (resolved via resolveAvatarUrl),
 * otherwise a letter circle (first char of the name). On image load error it
 * falls back to the letter too. `size` in px; colors themed by the caller.
 */
function Avatar({
  avatarUrl, name, size, primaryColor,
}: { avatarUrl: string | null | undefined; name: string; size: number; primaryColor: string }) {
  const [failed, setFailed] = React.useState(false);
  const src = failed ? null : resolveAvatarUrl(avatarUrl);
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const common: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
    objectFit: 'cover', display: 'inline-block', verticalAlign: 'middle',
  };
  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={common}
      />
    );
  }
  return (
    <span style={{
      ...common,
      background: hexAlpha(primaryColor, 0.1),
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: `${Math.max(7, Math.round(size * 0.5))}px`, color: primaryColor, fontWeight: 'bold',
      lineHeight: 1,
    }}>{letter}</span>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────

export type TimestampFormat = '12h' | '24h';

interface WebOverlaySettings {
  themeId: string;
  windowOpacity: number;
  textOpacity: number;
  showHints: boolean;
  fontSize: number;
  // Optional per-message timestamps. Off by default. Each message carries a UTC
  // `createdAt`; the renderer formats it in THIS viewer's local time (see
  // formatMessageTimestamp), so everyone sees their own local time with no extra
  // wire data. `timestampFormat` only matters when showTimestamps is true.
  showTimestamps: boolean;
  timestampFormat: TimestampFormat;
  // Channel NAMES the viewer has chosen to hide (set via the overlay shell's
  // "Hidden channels" filter, mirrored here). Their messages are excluded from
  // the feed AND per-channel views. Case-insensitive match on channel name.
  channelFilters: string[];
}

const DEFAULT_SETTINGS: WebOverlaySettings = {
  themeId: 'fo76-wasteland',
  windowOpacity: 0.9,
  textOpacity: 1.0,
  showHints: true,
  fontSize: 14,
  showTimestamps: false,
  timestampFormat: '12h',
  channelFilters: [],
};

const SETTINGS_KEY = 'fcm_web_overlay_settings';

export function loadSettings(): WebOverlaySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: WebOverlaySettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/**
 * Format a message's UTC timestamp in the VIEWER's local time.
 *
 * Messages carry a UTC ISO-8601 `createdAt`/`timestamp`. `Date` parses it as an
 * absolute instant and `toLocaleTimeString` (no explicit timeZone) renders it in
 * the runtime's local zone — so every viewer sees the same instant in THEIR own
 * local time, with no per-user timezone needing to be captured or broadcast.
 *
 * `format` picks 12-hour ("3:07 PM") vs 24-hour ("15:07"). `opts.timeZone` /
 * `opts.locale` exist for deterministic unit tests; production passes neither so
 * the user's local zone + locale are used. Returns '' for missing/unparseable
 * input so the caller can render nothing.
 */
// Cache Intl.DateTimeFormat instances by (format|locale|timeZone). CONSTRUCTING a
// formatter is expensive (~the whole cost of toLocaleTimeString); reusing one and
// calling .format() is cheap. Without this, formatting timestamps for ~300 rows on
// every render dominated the CPU profile (60%) and made typing/Backspace lag.
const _tsFormatterCache = new Map<string, Intl.DateTimeFormat>();
export function formatMessageTimestamp(
  value: string | number | Date | null | undefined,
  format: TimestampFormat,
  opts: { locale?: string; timeZone?: string } = {},
): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const key = `${format}|${opts.locale ?? ''}|${opts.timeZone ?? ''}`;
  let fmt = _tsFormatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(opts.locale, {
      hour: format === '24h' ? '2-digit' : 'numeric',
      minute: '2-digit',
      hour12: format !== '24h',
      timeZone: opts.timeZone,
    });
    _tsFormatterCache.set(key, fmt);
  }
  return fmt.format(d);
}

// ── Color helpers ─────────────────────────────────────────────────────────────

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

export function hexAlpha(hex: string, alpha: number): string {
  return hexToRgba(hex, alpha);
}

// Background for popovers / dropdowns / right-click context menus. Their alpha
// is FLOORED (min 0.9) so they stay opaque enough to read even when Background
// Opacity (chromeBgAlpha) is turned way down/transparent — otherwise the menu
// text would be unreadable over the see-through chat/game behind it.
export function menuBgColor(theme: WebTheme, chromeBgAlpha: number, mult = 1.4): string {
  return hexToRgba(theme.chromeColor, Math.max(0.9, Math.min(1, theme.chromeAlpha * mult * chromeBgAlpha)));
}

/**
 * openUrl — open a URL via the Electron relay bridge (if present) or window.open.
 * Centralises the openExternal / window.open pattern used throughout the component.
 */
function openUrl(url: string): void {
  // Only open http(s) URLs — parse + scheme-check so a chat-provided link can't
  // smuggle javascript:/data:/etc. into window.open / the relay openExternal
  // bridge (CodeQL-recognized unvalidated-redirection barrier).
  let safe: string;
  try {
    const u = new URL(url, window.location.origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    safe = u.href;
  } catch { return; }
  const b = (window as any).relayBridge;
  if (b?.openExternal) { b.openExternal(safe); } else { window.open(safe, '_blank', 'noopener,noreferrer'); }
}

/**
 * SpinnerDot — tiny CSS-animated loading spinner.
 * Used in autocomplete headers while a search is in-flight.
 */
function SpinnerDot({ size = 9, color }: { size?: number; color: string }) {
  return (
    <div style={{
      width: `${size}px`, height: `${size}px`,
      border: `1.5px solid ${hexAlpha(color, 0.3)}`,
      borderTop: `1.5px solid ${color}`,
      borderRadius: '50%',
      animation: 'fcm-spin 0.8s linear infinite',
      flexShrink: 0,
    }} />
  );
}

/**
 * deriveThemeTokens — compute the shared panel/chrome token set from a theme.
 * Extracted to avoid copy-paste across WikiPanel, settings modals, and inline panels.
 */
function deriveThemeTokens(theme: WebTheme, primaryColor: string, chromeBgAlpha: number) {
  return {
    panelBg:   hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.4)),
    chromeBg:  hexToRgba(theme.chromeColor, Math.max(0.9, Math.min(1, theme.chromeAlpha * 1.4 * chromeBgAlpha))),
    borderCol: hexAlpha(primaryColor, 0.35),
    dimText:   hexAlpha(theme.secondaryColor, 0.85),
  };
}

// The selected main/sub tab, persisted at MODULE level so it survives a React
// remount. The Electron shell remounts ChatOverlay (key bump) whenever the
// relay identity is re-evaluated — e.g. clicking a tab focuses the window and a
// fresh relay:status arrives. Without this, every remount reset state and the
// default-selection effect snapped the user back to General. Restoring from
// these on mount keeps the user on the tab they picked. Only set in the Electron
// overlay path (the website route owns its own selection).
let lastSelectedMainId = '';
let lastSelectedSubId = '';

interface BlockedUser { userId: string; displayName: string; avatarUrl: string | null }

// ── Blocked-users management UI (shared) ────────────────────────────────────────
// The same search-to-add / list / unblock UI used in BOTH the website Settings
// modal (embedded) AND the standalone BlockManagerModal that the overlay's shell
// settings panel opens. Self-styled from the theme so it has no external style
// deps. Calls onBlockChange after any block/unblock so the parent overlay can
// refresh its client-side blockedIds filter.
function BlockManagerBody({ theme, onBlockChange }: { theme: WebTheme; onBlockChange?: () => void }) {
  const primary = theme.primaryColor;
  const dimText = hexAlpha(theme.secondaryColor, 0.85);
  const inputStyle: React.CSSProperties = {
    background: hexToRgba(theme.inputBgColor, theme.inputAlpha),
    border: `1px solid ${hexAlpha(primary, 0.25)}`,
    color: theme.textColor, fontFamily: theme.fontFamily, fontSize: '13px',
    padding: '5px 10px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '10px', color: dimText, marginBottom: '4px',
    letterSpacing: '0.08em', fontFamily: theme.fontFamily,
  };
  const fieldRow: React.CSSProperties = { marginBottom: '14px' };

  const [blocked, setBlocked] = React.useState<BlockedUser[]>([]);
  const [blockQ, setBlockQ] = React.useState('');
  const [blockResults, setBlockResults] = React.useState<BlockedUser[]>([]);
  const [blockSearching, setBlockSearching] = React.useState(false);
  const loadBlocked = React.useCallback(async () => {
    try {
      const res = await api.get<{ blocked: BlockedUser[] }>('/api/block');
      setBlocked(res?.blocked ?? []);
    } catch { /* ignore */ }
  }, []);
  React.useEffect(() => { loadBlocked(); }, [loadBlocked]);
  React.useEffect(() => {
    const term = blockQ.trim();
    if (term.length === 0) { setBlockResults([]); setBlockSearching(false); return; }
    setBlockSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ results: BlockedUser[] }>(`/api/block/search?q=${encodeURIComponent(term)}`);
        setBlockResults(res?.results ?? []);
      } catch { setBlockResults([]); }
      finally { setBlockSearching(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [blockQ]);
  const doBlock = async (u: BlockedUser) => {
    try { await api.post('/api/block', { userId: u.userId }); } catch { /* ignore */ }
    setBlockQ(''); setBlockResults([]);
    await loadBlocked();
    onBlockChange?.();
  };
  const doUnblock = async (userId: string) => {
    try { await api.delete(`/api/block/${userId}`); } catch { /* ignore */ }
    await loadBlocked();
    onBlockChange?.();
  };

  return (
    <>
      {/* Add via search */}
      <div style={fieldRow}>
        <label style={labelStyle}>BLOCK A USER</label>
        <input
          value={blockQ}
          onChange={e => setBlockQ(e.target.value)}
          placeholder="Search by name…"
          style={inputStyle}
        />
        {(blockSearching || blockResults.length > 0) && (
          <div style={{ marginTop: '6px', border: `1px solid ${hexAlpha(primary, 0.15)}`, maxHeight: '160px', overflowY: 'auto' }}>
            {blockSearching && blockResults.length === 0 && (
              <div style={{ padding: '6px 10px', fontSize: '11px', color: dimText }}>Searching…</div>
            )}
            {blockResults.map(r => (
              <div key={r.userId}
                onClick={() => doBlock(r)}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 10px', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = hexAlpha(primary, 0.1))}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Avatar avatarUrl={r.avatarUrl} name={r.displayName} size={22} primaryColor={primary} />
                <span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: theme.textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.displayName}</span>
                <span style={{ fontSize: '10px', color: '#FF6060' }}>block</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Current block list */}
      <div style={fieldRow}>
        <label style={labelStyle}>{blocked.length === 0 ? 'NO BLOCKED USERS' : `BLOCKED (${blocked.length})`}</label>
        {blocked.map(b => (
          <div key={b.userId} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
            <Avatar avatarUrl={b.avatarUrl} name={b.displayName} size={22} primaryColor={primary} />
            <span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: theme.textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.displayName}</span>
            <button
              onClick={() => doUnblock(b.userId)}
              style={{ minHeight: 0, boxSizing: 'border-box', padding: '3px 10px', fontSize: '10px', fontFamily: theme.fontFamily, background: 'transparent', border: `1px solid ${hexAlpha(primary, 0.4)}`, color: primary, cursor: 'pointer', letterSpacing: '0.04em' }}
            >UNBLOCK</button>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Standalone Block Manager modal ──────────────────────────────────────────────
// Opened independently of Settings (e.g. from the overlay shell-settings panel
// via the `fcm-open-block-manager` event). Reuses BlockManagerBody so there's no
// DOM duplication. Portalled to <body> like the other overlay modals.
function BlockManagerModal({ theme, onClose, onBlockChange, chromeBgAlpha = 1 }: { theme: WebTheme; onClose: () => void; onBlockChange?: () => void; chromeBgAlpha?: number }) {
  const primary = theme.primaryColor;
  const panelBg = hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.4));
  const chromeBg = hexToRgba(theme.chromeColor, Math.min(1, theme.chromeAlpha * chromeBgAlpha));
  const borderCol = hexAlpha(primary, 0.35);
  const dimText = hexAlpha(theme.secondaryColor, 0.85);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10002 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: panelBg, border: `1px solid ${borderCol}`, width: '420px', maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', fontFamily: theme.fontFamily, boxShadow: `0 0 40px ${hexAlpha(primary, 0.08)}` }}>
        <div style={{ background: chromeBg, borderBottom: `1px solid ${borderCol}`, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 'bold', color: primary, letterSpacing: '0.12em' }}>🚫 BLOCKED USERS</div>
            <div style={{ fontSize: '10px', color: dimText, marginTop: '2px' }}>Hidden from your chat &amp; member lists</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: dimText, cursor: 'pointer', fontSize: '16px', padding: '0 4px', fontFamily: theme.fontFamily, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '16px', flex: 1 }}>
          <BlockManagerBody theme={theme} onBlockChange={onBlockChange} />
        </div>
      </div>
    </div>
  );
}

// ── Settings modal ────────────────────────────────────────────────────────────

interface SettingsModalProps {
  settings: WebOverlaySettings;
  theme: WebTheme;
  onChange: (patch: Partial<WebOverlaySettings>) => void;
  onClose: () => void;
  // Logged-in user's own avatar + display name (for the modal header chip).
  selfAvatarUrl?: string | null;
  selfName?: string;
  // Called after the user blocks/unblocks someone here, so the parent overlay
  // can refresh its client-side block filter immediately.
  onBlockChange?: () => void;
  // When true (Electron shell), hide the chrome/text opacity sliders since
  // the shell's own settings panel is the source of truth for those.
  hideShellSliders?: boolean;
  chromeBgAlpha?: number;
}

function SettingsModal({ settings, theme, onChange, onClose, selfAvatarUrl, selfName, onBlockChange, hideShellSliders = false, chromeBgAlpha = 1 }: SettingsModalProps) {
  const primary = theme.primaryColor;
  const panelBg = hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.4));
  const chromeBg = hexToRgba(theme.chromeColor, Math.min(1, theme.chromeAlpha * chromeBgAlpha));
  const borderCol = hexAlpha(primary, 0.35);
  const dimText = hexAlpha(theme.secondaryColor, 0.85);

  const inputStyle: React.CSSProperties = {
    background: hexToRgba(theme.inputBgColor, theme.inputAlpha),
    border: `1px solid ${hexAlpha(primary, 0.25)}`,
    color: theme.textColor,
    fontFamily: theme.fontFamily,
    fontSize: '13px',
    padding: '5px 10px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '10px',
    color: dimText,
    marginBottom: '4px',
    letterSpacing: '0.08em',
    fontFamily: theme.fontFamily,
  };

  const sectionStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 'bold',
    letterSpacing: '0.15em',
    color: hexAlpha(primary, 0.6),
    borderBottom: `1px solid ${hexAlpha(primary, 0.2)}`,
    paddingBottom: '4px',
    marginBottom: '12px',
    fontFamily: theme.fontFamily,
  };

  const fieldRow: React.CSSProperties = {
    marginBottom: '14px',
  };

  const sliderRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  };

  const sliderValueStyle: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 'bold',
    color: primary,
    minWidth: '36px',
    textAlign: 'right',
    fontFamily: theme.fontFamily,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: panelBg,
          border: `1px solid ${borderCol}`,
          width: '460px',
          maxWidth: '95vw',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: theme.fontFamily,
          boxShadow: `0 0 40px ${hexAlpha(primary, 0.08)}`,
        }}
      >
        {/* Header */}
        <div style={{
          background: chromeBg,
          borderBottom: `1px solid ${borderCol}`,
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Logged-in user's avatar (Discord image or letter fallback). */}
            <Avatar avatarUrl={selfAvatarUrl} name={selfName || 'You'} size={32} primaryColor={primary} />
            <div>
              <div style={{ fontSize: '14px', fontWeight: 'bold', color: primary, letterSpacing: '0.12em', display: 'flex', alignItems: 'center' }}>
                ◈ SETTINGS
              </div>
              <div style={{ fontSize: '10px', color: dimText, marginTop: '2px' }}>
                {selfName ? selfName : 'Appearance'}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: dimText,
              cursor: 'pointer', fontSize: '16px', padding: '0 4px',
              fontFamily: theme.fontFamily, lineHeight: 1,
            }}
          >✕</button>
        </div>

        {/* Body — scrollable */}
        <div style={{ overflowY: 'auto', padding: '16px', flex: 1 }}>

          {/* ── APPEARANCE ── */}
          <div style={sectionStyle}>APPEARANCE</div>

          {/* Theme */}
          <div style={fieldRow}>
            <label style={labelStyle}>THEME</label>
            <select
              value={settings.themeId}
              onChange={e => onChange({ themeId: e.target.value })}
              style={{ ...inputStyle, cursor: 'pointer', appearance: 'none' }}
            >
              {THEMES.map(t => (
                <option key={t.id} value={t.id}>{t.displayName}</option>
              ))}
            </select>
          </div>

          {/* Chrome opacity — hidden in the Electron shell (shell panel owns this) */}
          {!hideShellSliders && (
            <div style={fieldRow}>
              <label style={labelStyle}>CHROME OPACITY (TABS / INPUT / HEADER)</label>
              <div style={sliderRow}>
                <input
                  type="range" min={0} max={100}
                  value={Math.round(settings.windowOpacity * 100)}
                  onChange={e => onChange({ windowOpacity: Number(e.target.value) / 100 })}
                  style={{ flex: 1, accentColor: primary }}
                />
                <span style={sliderValueStyle}>{Math.round(settings.windowOpacity * 100)}%</span>
              </div>
            </div>
          )}

          {/* Text opacity — hidden in the Electron shell (shell panel owns this) */}
          {!hideShellSliders && (
            <div style={fieldRow}>
              <label style={labelStyle}>TEXT OPACITY</label>
              <div style={sliderRow}>
                <input
                  type="range" min={0} max={100}
                  value={Math.round(settings.textOpacity * 100)}
                  onChange={e => onChange({ textOpacity: Number(e.target.value) / 100 })}
                  style={{ flex: 1, accentColor: primary }}
                />
                <span style={sliderValueStyle}>{Math.round(settings.textOpacity * 100)}%</span>
              </div>
            </div>
          )}

          {/* Font size */}
          <div style={fieldRow}>
            <label style={labelStyle}>TEXT SIZE</label>
            <div style={sliderRow}>
              <input
                type="range" min={7} max={24} step={1}
                value={settings.fontSize}
                onChange={e => onChange({ fontSize: Number(e.target.value) })}
                style={{ flex: 1, accentColor: primary }}
              />
              <span style={sliderValueStyle}>{settings.fontSize}px</span>
            </div>
          </div>

          {/* Show hints */}
          <div style={{ ...fieldRow, display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
            onClick={() => onChange({ showHints: !settings.showHints })}>
            <div style={{
              width: '14px', height: '14px', flexShrink: 0,
              border: `1px solid ${hexAlpha(primary, 0.6)}`,
              background: settings.showHints ? hexAlpha(primary, 0.3) : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {settings.showHints && <span style={{ color: primary, fontSize: '10px', lineHeight: 1 }}>✓</span>}
            </div>
            <span style={{ fontSize: '11px', color: theme.textColor }}>
              Show footer hints
            </span>
          </div>

          {/* Show timestamps (off by default) + 12h/24h picker when on */}
          <div style={{ ...fieldRow, display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
            onClick={() => onChange({ showTimestamps: !settings.showTimestamps })}>
            <div style={{
              width: '14px', height: '14px', flexShrink: 0,
              border: `1px solid ${hexAlpha(primary, 0.6)}`,
              background: settings.showTimestamps ? hexAlpha(primary, 0.3) : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {settings.showTimestamps && <span style={{ color: primary, fontSize: '10px', lineHeight: 1 }}>✓</span>}
            </div>
            <span style={{ fontSize: '11px', color: theme.textColor }}>
              Show message timestamps
            </span>
          </div>
          {settings.showTimestamps && (
            <div style={{ ...fieldRow, display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '24px' }}>
              <span style={{ fontSize: '11px', color: theme.textColor, opacity: 0.8 }}>Time format</span>
              {(['12h', '24h'] as const).map(fmt => (
                <button key={fmt} type="button"
                  onClick={() => onChange({ timestampFormat: fmt })}
                  style={{
                    fontSize: '11px', padding: '2px 8px', cursor: 'pointer',
                    border: `1px solid ${hexAlpha(primary, settings.timestampFormat === fmt ? 0.9 : 0.4)}`,
                    background: settings.timestampFormat === fmt ? hexAlpha(primary, 0.25) : 'transparent',
                    color: theme.textColor,
                  }}>
                  {fmt === '12h' ? '12-hour' : '24-hour'}
                </button>
              ))}
            </div>
          )}

          {/* ── BLOCKED USERS ── (shared body, also used by the standalone modal) */}
          <div style={{ ...sectionStyle, marginTop: '20px' }}>BLOCKED USERS</div>
          <BlockManagerBody theme={theme} onBlockChange={onBlockChange} />

        </div>

        {/* Footer */}
        <div style={{
          borderTop: `1px solid ${borderCol}`,
          padding: '10px 16px',
          display: 'flex',
          justifyContent: 'flex-end',
          flexShrink: 0,
          background: chromeBg,
        }}>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: `1px solid ${hexAlpha(primary, 0.4)}`,
              color: primary,
              fontFamily: theme.fontFamily,
              fontSize: '11px',
              letterSpacing: '0.1em',
              padding: '6px 20px',
              cursor: 'pointer',
            }}
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Data types ────────────────────────────────────────────────────────────────

// Structured metadata attached to special messages (e.g. the party-invite
// embed). null/undefined for normal chat messages.
interface PartyInviteMetadata {
  type: 'party_invite';
  partyId: string;
  partyName: string;
  color?: string | null;
}
interface NukeCodesMetadata {
  type: 'nuke_codes';
  alpha: string;
  bravo: string;
  charlie: string;
  validUntil?: string | null;
}
interface ServerStatusMetadata {
  type: 'server_status';
  status: string;
  checkedAt: string;
}
interface CampItemMetadata {
  type: 'camp_item';
  name: string;
  category: string;
  subCategory: string;
  budgetCost: number | null;
  plan: string | null;
  source: string;
  sourceUrl: string;
  imageUrl: string | null;
  sourceLabel: string | null;
  atomPrice?: number | null;
  atomBundle?: string | null;
}
interface MinervaMetadata {
  type: 'minerva';
  location: string;
  listNumber: number;
  isSuperSale: boolean;
  isActive: boolean;
  startUtc: string;
  endUtc: string;
  nextLocation: string | null;
  nextListNumber: number | null;
  nextIsSuperSale: boolean | null;
  nextStartUtc: string | null;
}
interface CardShareMetadata {
  type: 'card_share';
  command: string;
  label: string;
  accent: string;
  icon: string;
  sourceName?: string;
  sourceUrl?: string;
}
interface WikiShareMetadata {
  type: 'wiki_share';
  wikiEntryId?: string;
  name?: string;
  kind?: string;
  wikiTitle?: string;
}
interface GiveawayMetadata {
  type: 'giveaway';
  giveawayId: string;
  shortId: string;
  itemName: string;
  creatorName: string;
  createdByUserId: string;
  endsAt: string;
  durationMin: number;
  entryCount: number;
}
interface GiveawayWinnerMetadata {
  type: 'giveaway_winner';
  giveawayId: string;
  shortId: string;
  itemName: string;
  winnerName: string | null;
  entryCount: number;
  cancelled?: boolean;
}
interface GiveawayListEntry {
  giveawayId: string;
  shortId: string;
  itemName: string;
  creatorName: string;
  createdByUserId: string;
  endsAt: string;
  entryCount: number;
  status: string;
}
interface GiveawayListMetadata {
  type: 'giveaway_list';
  giveaways: GiveawayListEntry[];
}
interface GiveawayHistoryEntry {
  giveawayId: string;
  shortId: string;
  itemName: string;
  creatorName: string;
  winnerName: string | null;
  entryCount: number;
  status: string;
  createdAt: string;
}
interface GiveawayHistoryMetadata {
  type: 'giveaway_history';
  giveaways: GiveawayHistoryEntry[];
}
type ChatMessageMetadata = PartyInviteMetadata | NukeCodesMetadata | ServerStatusMetadata | CampItemMetadata | CardShareMetadata | WikiShareMetadata | GiveawayMetadata | GiveawayWinnerMetadata | GiveawayListMetadata | GiveawayHistoryMetadata | { type?: string; [k: string]: unknown } | null;

interface ChatMessage {
  id: string;
  content: string;
  username: string;
  userId?: string;
  channelId: string;
  source: string;
  timestamp?: string;
  responseColor?: string | null;
  avatarUrl?: string | null;
  metadata?: ChatMessageMetadata;
}

interface PrivateConversationSummary {
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string;
  lastMessagePreview: string;
  lastMessageSenderId: string | null;
  lastMessageAt: string;
  unreadCount: number;
}

interface PrivateMessagePayload {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  recipientId: string;
  content: string;
  createdAt: string;
}

interface PrivateUserSearchResult {
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
}

interface SubChannel {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  allowGifs?: boolean;
  allowEmojis?: boolean;
}

interface Channel {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  children?: SubChannel[];
  isVirtual?: boolean;
  serverEndpoint?: string;
  allowGifs?: boolean;
  allowEmojis?: boolean;
}

// ── Party interfaces ──────────────────────────────────────────────────────────

const PARTY_MAIN_ID = '__party__';
const PM_MAIN_ID = '__pm__';

// Per-channel initial history batch size (also the lazy-load page size). When a
// returned batch is smaller than this, we've hit the start of history.
const HISTORY_PAGE = 300;
// Generous in-memory cap on the combined (all-channels) message list. Large
// enough that lazy-loaded older batches aren't trimmed off the top when a new
// live message arrives, while still bounding memory.
const MESSAGE_CAP = 2000;

function toPrivateChatMessage(message: PrivateMessagePayload): ChatMessage {
  return {
    id: message.id,
    content: message.content,
    username: message.senderName,
    userId: message.senderId,
    channelId: message.conversationId,
    source: 'pm',
    timestamp: message.createdAt,
  };
}

function formatPrivateConversationPreview(
  conversation: PrivateConversationSummary,
  messages: ChatMessage[] | undefined,
  currentUserId: string,
): string {
  const latestMessage = messages && messages.length > 0 ? messages[messages.length - 1] : null;
  const previewText = latestMessage?.content ?? conversation.lastMessagePreview;
  if (!previewText) return '';

  const senderId = latestMessage?.userId ?? conversation.lastMessageSenderId;
  if (senderId === currentUserId) return `You: ${previewText}`;
  if (senderId && senderId === conversation.otherUserId) return `${conversation.otherDisplayName}: ${previewText}`;
  return previewText;
}

interface Party {
  id: string;
  name: string;
  color: string;
  isPrivate: boolean;
  reapPolicy: 'persistent' | 'ephemeral';
  ownerId: string;
  memberCount: number;
  onlineCount: number;
  recentMsgCount: number;
  lastMessageAt: string | null;
  isMember: boolean;
  role: 'owner' | 'comod' | 'member' | null;
  pendingInvite: boolean;
  maxMembers: number | null;
  category?: string;
  description?: string;
}

interface PartyMember {
  userId: string;
  username: string;
  role: 'owner' | 'comod' | 'member';
  online: boolean;
  avatarUrl?: string | null;
}

interface PartyInvite {
  id: string;
  partyId: string;
  partyName: string;
  inviterName: string;
  createdAt: string;
}

interface ServerFeedMessage {
  id: string;
  content: string;
  username: string;
  userId: string;
  serverEndpoint: string;
  isDeleted: boolean;
  createdAt: string;
}

interface ServerMember {
  id: string;
  username: string;
  discordUsername?: string;
  discordId?: string;
  discordAvatar?: string;
}

interface ModModalState {
  action: 'delete' | 'mute' | 'kick' | 'ban';
  target: ChatMessage;
  isServerMsg?: boolean;
}

interface SlashCommand {
  trigger: string;
  description: string;
  requiresArgs: boolean;
  actionType: string;
}

const SYNTHETIC_HELP: SlashCommand = {
  trigger: '/help',
  description: 'List all available commands',
  requiresArgs: false,
  actionType: 'message',
};

// Built-in relay shortcuts — trigger → (seeded channel UUID, fallback color if DB has none)
const BUILTIN_RELAYS: { cmd: SlashCommand; channelId: string | null; fallbackColor: string }[] = [
  { cmd: { trigger: '/g',    description: 'Send to General',             requiresArgs: true, actionType: 'relay' }, channelId: '00000000-0000-0000-0000-000000000005', fallbackColor: '#C8A840' },
  { cmd: { trigger: '/t',    description: 'Send to Trading',             requiresArgs: true, actionType: 'relay' }, channelId: '00000000-0000-0000-0000-000000000002', fallbackColor: '#4A9FE0' },
  { cmd: { trigger: '/e',    description: 'Send to Events',              requiresArgs: true, actionType: 'relay' }, channelId: '00000000-0000-0000-0000-000000000003', fallbackColor: '#50C878' },
  { cmd: { trigger: '/r',    description: 'Send to Raids',               requiresArgs: true, actionType: 'relay' }, channelId: '00000000-0000-0000-0000-000000000004', fallbackColor: '#FF6644' },
  { cmd: { trigger: '/i',    description: 'Send to Infests',             requiresArgs: true, actionType: 'relay' }, channelId: '983995c1-f9ab-44c0-9b78-8b4cbf497273', fallbackColor: '#CC44FF' },
  // /s omitted — server chat is pending re-enable (tracked in the server-scoped-chat
  // epic). A typed "/s ..." falls through to the backend, which returns a disabled notice.
];

// Hardcoded form/utility commands — mirrors the desktop overlay's _acCommands list exactly.
// These are excluded from the DB fetch so descriptions stay consistent.
export const BUILTIN_FORMS: SlashCommand[] = [
  { trigger: '/report bug',   description: 'Bug report — title, description, steps to reproduce, expected vs actual',            requiresArgs: true,  actionType: 'report'  },
  { trigger: '/report player', description: 'Player report — player name, reason, description',                                   requiresArgs: true,  actionType: 'report'  },
  { trigger: '/apply',        description: 'Join the mod team — in-game name, age, timezone, availability, experience, motivation', requiresArgs: false, actionType: 'message' },
  // FO76 data lookups — handled backend-side, reply privately to the sender.
  { trigger: '/online',       description: 'Show total users online in chat',                                                   requiresArgs: false, actionType: 'message' },
  { trigger: '/serverstatus', description: 'Show Fallout 76 server status (up/down)',                                            requiresArgs: false, actionType: 'message' },
  { trigger: '/nukecodes',    description: 'Show this week\'s nuke launch codes (Alpha/Bravo/Charlie)',                       requiresArgs: false, actionType: 'message' },
  { trigger: '/minerva',      description: 'Show Minerva\'s current or next Big Sale — location, list number, and dates',     requiresArgs: false, actionType: 'message' },
  { trigger: '/wiki',         description: 'Search the Fallout 76 wiki — weapons, armor, items, creatures, locations, quests…',  requiresArgs: true,  actionType: 'wiki'    },
  { trigger: '/camp',         description: 'Look up a CAMP item — category, sub-category, budget cost, and plan requirement',       requiresArgs: true,  actionType: 'message' },
  // Party shortcuts — resolved dynamically at send time; listed here for autocomplete only.
  { trigger: '/recent',  description: 'Send to most-recent party',                                    requiresArgs: true,  actionType: 'message' },
  { trigger: '/p1',      description: 'Send to 1st joined party',                                     requiresArgs: true,  actionType: 'message' },
  { trigger: '/p2',      description: 'Send to 2nd joined party',                                     requiresArgs: true,  actionType: 'message' },
  { trigger: '/p3',      description: 'Send to 3rd joined party',                                     requiresArgs: true,  actionType: 'message' },
  // Giveaways
  { trigger: '/giveaway start', description: 'Start a community item raffle (1–60 min, default 5)',   requiresArgs: true,  actionType: 'message' },
  { trigger: '/giveaway list',  description: 'Show all active giveaways',                             requiresArgs: false, actionType: 'message' },
  { trigger: '/giveaway last',  description: 'Show results of last 1–10 giveaways (default 5)',       requiresArgs: false, actionType: 'message' },
  { trigger: '/giveaway join',  description: 'Enter a giveaway by its short ID',                      requiresArgs: true,  actionType: 'message' },
  { trigger: '/giveaway leave', description: 'Leave a giveaway you entered',                          requiresArgs: true,  actionType: 'message' },
  { trigger: '/giveaway stop',  description: 'Cancel your giveaway (creator or mod only)',            requiresArgs: true,  actionType: 'message' },
];

const MOD_ROLES = ['owner', 'admin', 'moderator'];
const ADMIN_ROLES = ['owner', 'admin'];

/** Returns true when the role grants moderation privileges (owner/admin/moderator). */
export function isPrivilegedRole(role: string): boolean {
  return MOD_ROLES.includes(role);
}

/**
 * Pure helper: determines whether a message should appear in the main feed
 * (website "Feed" tab / overlay "General" channel).
 *
 * Inclusion rules (first match wins):
 *  1. Message belongs to the feed-parent channel itself.
 *  2. Message belongs to a child sub-channel of that parent.
 *  3. Message belongs to one of the user's joined (or public) parties.
 *  4. Privileged mod visibility: when `isMod && !isPublicMode`, all party
 *     messages (source === 'party') flow into the main feed so mods can
 *     observe foreign-party conversations inline. Server-enforced — regular
 *     users never receive foreign-party frames.
 */
export function shouldShowInMainFeed(
  m: { channelId: string; source?: string },
  ctx: {
    feedParentId: string;
    childIds: string[];
    feedPartyIds: string[];
    isMod: boolean;
    isPublicMode: boolean;
  },
): boolean {
  if (m.channelId === ctx.feedParentId) return true;
  if (ctx.childIds.includes(m.channelId)) return true;
  if (ctx.feedPartyIds.includes(m.channelId)) return true;
  // Privileged moderation visibility: all party messages flow into the main
  // feed (website Feed tab + overlay General). Never in public mode.
  if (ctx.isMod && !ctx.isPublicMode && m.source === 'party') return true;
  return false;
}

/**
 * Resolve hidden-channel NAMES (the user's "Hidden channels" filter) to the set of
 * channel IDs to exclude from the feed. Match is case-insensitive on channel name.
 * Pure + exported for tests.
 */
export function hiddenChannelIdSet(
  channelFilters: string[] | undefined,
  channels: { id: string; name?: string | null }[],
): Set<string> {
  const ids = new Set<string>();
  if (!channelFilters || channelFilters.length === 0) return ids;
  const wanted = new Set(channelFilters.map(f => f.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return ids;
  for (const c of channels) {
    if (c.name && wanted.has(c.name.toLowerCase())) ids.add(c.id);
  }
  return ids;
}
const MUTE_DURATIONS = [
  { label: '1 hour', value: 60 },
  { label: '6 hours', value: 360 },
  { label: '24 hours', value: 1440 },
  { label: '7 days', value: 10080 },
  { label: 'Permanent', value: 525600 },
];

// ── @mention + link helpers (parity with desktop overlay) ──────────────────────
const MENTION_RE = /@[A-Za-z0-9_.\-]{2,32}/g;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const EMOJI_RE = /<(a?):([A-Za-z0-9_]+):(\d{16,22})>/g;

/** Shorten a URL for in-overlay display (e.g. youtube.com/…); full URL is the href. */
export function truncateUrl(url: string): string {
  const trimmed = url.replace(/[.,;:!?)\]}'"]+$/, '');
  try {
    const u = new URL(trimmed);
    const host = u.hostname.replace(/^www\./i, '');
    const hasPath = u.pathname && u.pathname !== '/' || u.search || u.hash;
    const disp = hasPath ? `${host}/…` : host;
    return disp.length > 32 ? disp.slice(0, 31) + '…' : disp;
  } catch {
    return trimmed.length > 32 ? trimmed.slice(0, 31) + '…' : trimmed;
  }
}

/**
 * Detect inline media a Discord relay may have appended (attachment URLs,
 * resolved embed image/video URLs). Returns 'image' for animated GIFs / static
 * images, 'video' for MP4/WebM (Discord often serves animated GIFs as MP4),
 * or null for plain links.
 *
 * Host/extension rules mirror the desktop IsRenderableImageUrl exactly:
 *   - Direct image extensions: gif, png, jpg/jpeg, webp, bmp, apng
 *   - Tenor CDN shards: media.tenor.com, media1.tenor.com, media2.tenor.com, …
 *     (desktop regex: ^media\d*\.tenor\.com$)
 *   - Tenor alternate: c.tenor.com
 *   - Discord CDN: media.discordapp.net
 * For the host-based fallback, require path.length > 1 (i.e. not just "/")
 * matching the desktop's `path.Length > 1` guard.
 */
export function classifyMedia(url: string): 'image' | 'video' | null {
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = url.toLowerCase(); }
  if (/\.(gif|png|jpe?g|webp|apng|avif|bmp)(\?|$|#)/.test(path)) return 'image';
  if (/\.(mp4|webm|mov)(\?|$|#)/.test(path)) return 'video';
  // Tenor / Discord CDN host-based fallback (some links omit extensions).
  // media\d* covers numbered shards (media1, media2, …) as on desktop.
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  if (/^(media\d*\.tenor\.com|c\.tenor\.com|media\.discordapp\.net)$/.test(host) && path.length > 1) return 'image';
  return null;
}

type Part = {
  text: string;
  kind: 'plain' | 'mention' | 'url' | 'emoji';
  url?: string;
  /** For emoji kind: the name portion of <:name:id> */
  emojiName?: string;
};

/** Split content into plain / @mention / url / emoji segments so each can render its own way. */
export function splitParts(content: string): Part[] {
  type Span = { start: number; end: number; kind: 'mention' | 'url' | 'emoji'; url?: string; emojiName?: string };
  const spans: Span[] = [];
  for (const m of content.matchAll(MENTION_RE))
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: 'mention' });
  for (const m of content.matchAll(URL_RE))
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: 'url', url: m[0] });
  for (const m of content.matchAll(EMOJI_RE)) {
    const animated = m[1] === 'a';
    const name = m[2];
    const id = m[3];
    // Animated emojis: use .webp?animated=true, not .gif — emojis uploaded as
    // animated WebP/APNG 415 on the .gif rendition. WebP animates in <img>.
    const url = animated
      ? `https://cdn.discordapp.com/emojis/${id}.webp?animated=true`
      : `https://cdn.discordapp.com/emojis/${id}.png`;
    spans.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      kind: 'emoji',
      url,
      emojiName: name,
    });
  }
  spans.sort((a, b) => a.start - b.start);

  const parts: Part[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue; // overlapping spans (e.g. URL inside mention text)
    if (s.start > pos) parts.push({ text: content.slice(pos, s.start), kind: 'plain' });
    parts.push({ text: content.slice(s.start, s.end), kind: s.kind, url: s.url, emojiName: s.emojiName });
    pos = s.end;
  }
  if (pos < content.length) parts.push({ text: content.slice(pos), kind: 'plain' });
  return parts;
}

/** Legacy split kept for any non-link callers (none currently use it). */
export function splitMentions(content: string): { text: string; mention: boolean }[] {
  return splitParts(content).map(p => ({ text: p.text, mention: p.kind === 'mention' }));
}

/** Does `content` contain an @mention of `name` (case-insensitive, word-boundary)? */
export function contentMentionsName(content: string, name: string): boolean {
  if (!content || name.length < 2) return false;
  const lc = content.toLowerCase();
  const needle = ('@' + name).toLowerCase();
  let idx = lc.indexOf(needle);
  while (idx >= 0) {
    const after = idx + needle.length;
    if (after >= content.length || !/[A-Za-z0-9]/.test(content[after])) return true;
    idx = lc.indexOf(needle, after);
  }
  return false;
}

/**
 * Compute the per-message channel/source tag (label + color) shown before the
 * message body. Pure extraction of the inline tag logic in the render path so it
 * can be unit-tested. Rules (parity with desktop overlay):
 *   - system messages (source 'bot') → no tag (null label, defaultColor)
 *   - discord-relayed → purple [Discord]
 *   - server messages (source 'server' or channelId starting "server:") → [Server] amber
 *   - party messages (source 'party') → [PartyName] (party.color if set, else defaultColor)
 *   - otherwise → channel name (Trading renamed to "Trade"), channel.color if set
 * `channels` is the flattened channel list; `defaultColor` is the theme's
 * inactive-tab color used when nothing overrides it.
 */
export interface ChannelTag { label: string | null; color: string }
export function channelTag(
  msg: Pick<ChatMessage, 'source' | 'channelId'>,
  channels: Pick<Channel, 'id' | 'name' | 'color'>[],
  parties: Pick<Party, 'id' | 'name' | 'color'>[],
  defaultColor = '',
  activeChannelId?: string,
): ChannelTag {
  const isSystemMsg = msg.source === 'bot';
  const isServerMsg = !isSystemMsg && (msg.source === 'server' || (msg.channelId?.startsWith('server:') ?? false));
  let label: string | null = null;
  let color = defaultColor;
  if (!isSystemMsg) {
    if (msg.source === 'discord') {
      // In a feed view (activeChannelId differs from the message's channel), show
      // the source channel label so users know which channel the activity came from.
      const crossChannel = activeChannelId && msg.channelId !== activeChannelId;
      if (crossChannel) {
        const ch = channels.find(c => c.id === msg.channelId);
        if (ch) {
          label = ch.name === 'Trading' ? 'Trade' : ch.name;
          if (ch.color && ch.color.trim()) color = ch.color;
        } else {
          label = 'Discord';
          color = '#B57AFF';
        }
      } else {
        label = 'Discord';
        color = '#B57AFF';
      }
    } else if (isServerMsg) {
      label = 'Server';
      color = '#FFB000';
    } else if (msg.source === 'party') {
      const party = parties.find(p => p.id === msg.channelId);
      label = party ? party.name : 'Party';
      if (party?.color && party.color.trim()) color = party.color;
    } else {
      const ch = channels.find(c => c.id === msg.channelId);
      if (ch) {
        label = ch.name === 'Trading' ? 'Trade' : ch.name;
        if (ch.color && ch.color.trim()) color = ch.color;
      }
    }
  }
  return { label, color };
}

/**
 * Compute the fixed-position anchor (viewport-edge distances) for the emoji/GIF
 * picker so it opens bottom-right ABOVE the given trigger rect, clamped to stay
 * fully on-screen and capped in height so an oversized picker scrolls internally.
 *
 * ZOOM CORRECTION (Electron overlay only): the overlay shell scales #root with
 * CSS `zoom` at non-default font sizes (shell.ts applyScale). In Chromium, an
 * element inside a `zoom`ed subtree reports getBoundingClientRect() in PRE-ZOOM
 * (layout) coordinates, but it VISUALLY renders at `rect × zoom`. The picker is
 * portaled to <body> (unzoomed), so to place it at the trigger's VISUAL position
 * we must multiply the trigger's reported rect by the ancestor zoom factor —
 * otherwise (at zoom 1.14) the picker anchors to the smaller layout coordinates
 * and lands up-and-left of where the button actually appears (the user's reported
 * "opens in the middle" bug at fontSize 16). Verified empirically: at fontSize 16
 * the ☢ trigger reports top=438 but renders at ~500 (438 × 1.14). On the website
 * there is no #root zoom (factor 1) → this is a no-op.
 */
export function computePickerAnchor(
  rect: DOMRect, pickerW: number, pickerH: number, gap: number,
): { bottom: number; right: number; maxHeight: number; maxWidth: number } {
  // Ancestor zoom applied to #root by the overlay shell (1 on the website).
  let zoom = 1;
  const root = document.getElementById('root');
  if (root) {
    const z = parseFloat(root.style.zoom || '');
    if (Number.isFinite(z) && z > 0) zoom = z;
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  // Convert the trigger's PRE-ZOOM layout rect into the VISUAL viewport position
  // the portaled, position:fixed picker (on the unzoomed <body>) is measured in.
  const top = rect.top * zoom;
  const rightEdge = rect.right * zoom;
  // Desired anchor: picker bottom at the trigger's top edge, right edge aligned
  // with the trigger's right edge (opens up-and-left, above the button).
  let bottom = vh - top;
  let right = vw - rightEdge;
  // Cap height AND width to the viewport (with margins) so a picker bigger than
  // the window scrolls internally / reflows rather than clipping or running
  // off-screen. The picker components consume maxWidth/maxHeight + internal scroll.
  const maxHeight = Math.min(pickerH, vh - gap * 2);
  const maxWidth = Math.min(pickerW, vw - gap * 2);
  // Clamp so the picker never overflows any window edge (only moves it when
  // there isn't room; otherwise the values are untouched).
  bottom = Math.max(gap, Math.min(bottom, vh - maxHeight - gap));
  right = Math.max(gap, Math.min(right, vw - maxWidth - gap));
  return { bottom, right, maxHeight, maxWidth };
}

// ── Party error boundary ──────────────────────────────────────────────────────
//
// Isolates ALL party UI (main-tab content, browser, in-party view, member
// panel, invite toasts, create modal). If anything inside throws during render,
// this catches it and renders a tiny inline fallback instead of letting the
// exception bubble up and unmount the entire (transparent) chat overlay.
// A party-feature bug must NEVER take down chat.
class PartyErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  componentDidCatch(error: unknown, info: unknown) {
    // Log but never rethrow — the overlay must keep rendering.
    // eslint-disable-next-line no-console
    console.error('[PartyErrorBoundary] party UI threw — contained:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{
          padding: '10px 12px', fontSize: '10px', opacity: 0.6,
          fontFamily: '"Courier New", Courier, monospace',
        }}>
          Party unavailable
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Wiki thumbnail helper (autocomplete rows) ──────────────────────────────────
// wikiKindIcon / wikiKindLabel / wikiKindColor are now derived from WIKI_KINDS above.

// Loads the entry thumbnail; falls back to a per-category glyph when there is no
// image or it fails to load (so the autocomplete never shows a bare "?").
function WikiAcThumb({ url, kind, primaryColor }: { url: string | null; kind: string | null; primaryColor: string }) {
  const [err, setErr] = React.useState(false);
  if (!url || err) {
    return <span title={kind || undefined} style={{ fontSize: '13px', lineHeight: 1, color: hexAlpha(primaryColor, 0.7) }}>{wikiKindIcon(kind)}</span>;
  }
  return (
    <img
      src={resolveMediaUrl(url)} alt=""
      onError={() => setErr(true)}
      style={{ width: '28px', height: '24px', objectFit: 'contain', background: 'transparent', display: 'block' }}
    />
  );
}

// Per-category SVG icon for CAMP items (no emoji, icons only).
function campCategoryIcon(category: string | null | undefined): React.ReactNode {
  const c = (category || '').toLowerCase();
  if (c.includes('structure') || c.includes('wall') || c.includes('floor') || c.includes('roof')) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    );
  }
  if (c.includes('furniture') || c.includes('decor') || c.includes('display')) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <rect x="3" y="10" width="18" height="4" rx="1" />
        <line x1="5" y1="14" x2="5" y2="20" />
        <line x1="19" y1="14" x2="19" y2="20" />
        <line x1="3" y1="10" x2="3" y2="7" />
        <line x1="21" y1="10" x2="21" y2="7" />
      </svg>
    );
  }
  if (c.includes('craft') || c.includes('station') || c.includes('workbench')) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    );
  }
  if (c.includes('power') || c.includes('generator') || c.includes('electric')) {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// Thumbnail for CAMP autocomplete rows — image with per-category icon fallback.
function CampAcThumb({ url, category, primaryColor }: { url: string | null; category: string | null; primaryColor: string }) {
  const [err, setErr] = React.useState(false);
  if (!url || err) {
    return <span title={category || undefined} style={{ fontSize: '13px', lineHeight: 1, color: hexAlpha(primaryColor, 0.7) }}>{campCategoryIcon(category)}</span>;
  }
  return (
    <img
      src={resolveMediaUrl(url)} alt=""
      onError={() => setErr(true)}
      style={{ width: '28px', height: '24px', objectFit: 'contain', background: 'transparent', display: 'block' }}
    />
  );
}

// ── Wiki types ────────────────────────────────────────────────────────────────

// must match backend backend/src/services/wikiCatalogService.ts WikiSearchResult
interface WikiSearchResult {
  id: string;
  wikiTitle: string;
  name: string;
  kind: string | null;
  thumbnailUrl: string | null;
  score: number;
}

// must match backend backend/src/services/wikiCatalogService.ts WikiEntryImage
interface WikiEntryImage {
  url: string;
  aspect: string | null;
  isMap: boolean;
  width: number | null;
  height: number | null;
}

// must match backend backend/src/services/wikiCatalogService.ts WikiEntryResult
interface WikiEntry {
  id: string;
  wikiTitle: string;
  name: string;
  kind: string | null;
  fields: Record<string, string>;
  imageUrl: string | null;       // back-compat: equals images[0]?.url
  imageAspect: 'ultrawide' | 'portrait' | 'square' | 'unknown' | null;
  imageMime: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  images: WikiEntryImage[];      // primary first (position/order 0 first); maps have isMap=true
  // Each location row is an array of segments; a segment with `title` is a link
  // to that location's wiki page (only the name is a hyperlink, not the line).
  locations: WikiLocationSegment[][];
  articleUrl: string;
  attribution: string;
  campData?: CampMatch[];
  isStale?: boolean;
}

interface WikiLocationSegment {
  text: string;
  title?: string;
}

// must match backend backend/src/services/campService.ts CampMatch
interface CampMatch {
  id: string;
  name: string;
  category: string;
  subCategory: string;
  budgetCost: number | null;  // nullable — guard before .toFixed()/numeric use
  plan: string | null;
  sourceLabel: string | null;
  imageUrl: string | null;
  atomPrice?: number | null;
  atomBundle?: string | null;
}

/**
 * WIKI_KINDS — consolidated per-kind metadata (color, icon, label, fields).
 * Field lists must match backend/src/services/wikiCatalogService.ts KIND_FIELDS.
 */
interface WikiKindDef {
  color: string;
  /** Autocomplete row icon (glyph or SVG node). */
  icon: React.ReactNode;
  label: string;
  /** Infobox field allow-list (ordered by importance). */
  fields: string[] | null;
}

const WIKI_KINDS: Record<string, WikiKindDef> = {
  weapon: {
    color: '#FF8C42', icon: '⚔', label: 'WEAPON',
    fields: ['type','class','level','base type','damage','attack time','fire rate','range','accuracy','crit','ap used','projectiles','ammo','clip size','reload time','draw','sight','bash','block','stagger','speed','sound level','special','effects','perk mod','perk dmg','perk repair','perk leg','perk sneak','perk pen','modifiers','repair','craft','scrap','weight','value','plan','formid'],
  },
  armor: {
    color: '#4FC3F7', icon: '⛨', label: 'ARMOR',
    fields: ['type','class','dr','er','rr','resist','physical resistance','energy resistance','radiation resistance','variants','slots','effects','perks','weight','value','plan','formid'],
  },
  creature: {
    color: '#EF9A9A', icon: '☣', label: 'CREATURE',
    fields: ['type','class','level','variants','hp','xp','drops','perks','affiliation','quests','weakness','events','location','locations','formid'],
  },
  item: {
    color: '#A5D6A7', icon: '◆', label: 'ITEM',
    fields: ['type','effect','effects','duration','hunger','thirst','rads','modifies','mod slot','components','weight','value','food','component of','quests','disease','spoil','formid'],
  },
  perk: {
    color: '#CE93D8', icon: '★', label: 'PERK',
    fields: ['effects','equip cost','unlocked','race(s)','editor id','form id','type','requires'],
  },
  location: {
    color: '#80CBC4', icon: '⚑', label: 'LOCATION',
    fields: ['type','part of','factions','creatures','robots','quests','leaders','owners','terminal','refid','cell name','map marker','edid'],
  },
  character: {
    color: '#F48FB1', icon: '☻', label: 'CHARACTER',
    fields: ['race','role','class','level','gender','affiliation','factions','location','actor','aggression','refid','formid'],
  },
  currency: {
    color: '#DCE775', icon: '¤', label: 'CURRENCY',
    fields: ['uses','type','value','weight','tradeable','max','requirements','edid','formid'],
  },
  plan: {
    color: '#FFCA6B',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="13" y2="17" />
      </svg>
    ),
    label: 'PLAN',
    fields: ['unlocks','unlock types','value','value type','tradeable','weight','locations','formid'],
  },
  quest: {
    color: '#9FA8DA', icon: '※', label: 'QUEST',
    fields: ['type','location','given by','reward','related','leads to','previous','baddies','other npcs','formid'],
  },
  mutation: {
    color: '#B2DFDB', icon: 'ψ', label: 'MUTATION',
    fields: ['effects pos', 'effects neg', 'serum', 'suppressed by', 'formid'],
  },
  world_object: {
    color: '#D7CCC8', icon: '⌂', label: 'WORLD OBJECT',
    fields: ['type','location','edid','formid','learned by','components','objecttype','shelter','workshop','use','used for','perk'],
  },
  faction: {
    color: '#FFF176', icon: '⚐', label: 'FACTION',
    fields: ['type', 'status', 'leader', 'founded by', 'headquarters', 'members', 'divisions', 'locations', 'parent', 'related', 'formid'],
  },
  ammo: {
    color: '#FFAB91', icon: '⁌', label: 'AMMO',
    fields: ['item name', 'weight', 'value', 'edid', 'formid', 'item name2', 'weight2', 'value2', 'edid2', 'formid2'],
  },
  radio_station: {
    color: '#C5CAE9', icon: '⊚', label: 'RADIO STATION',
    fields: ['origin', 'range', 'quests', 'refid'],
  },
  other: {
    color: '#B0BEC5', icon: '◈', label: 'OTHER',
    fields: null,
  },
};

function wikiKindColor(kind: string | null | undefined): string {
  if (!kind) return WIKI_KINDS.other.color;
  return (WIKI_KINDS[kind.toLowerCase()] ?? WIKI_KINDS.other).color;
}

function wikiKindIcon(kind: string | null | undefined): React.ReactNode {
  if (!kind) return WIKI_KINDS.other.icon;
  return (WIKI_KINDS[kind.toLowerCase()] ?? WIKI_KINDS.other).icon;
}

function wikiKindLabel(kind: string | null | undefined): string {
  if (!kind) return WIKI_KINDS.other.label;
  return (WIKI_KINDS[kind.toLowerCase()] ?? WIKI_KINDS.other).label;
}

function wikiArticleUrl(wikiTitle: string): string {
  return `https://fallout.wiki/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, '_'))}`;
}

function wikiImageMaxHeight(aspect: WikiEntry['imageAspect']): number {
  if (aspect === 'ultrawide') return 72;
  if (aspect === 'portrait')  return 200;
  if (aspect === 'square')    return 160;
  return 140;
}

function wikiStatRows(entry: WikiEntry): { key: string; label: string; value: string }[] {
  const fields = (WIKI_KINDS[entry.kind?.toLowerCase() ?? ''] ?? WIKI_KINDS.other).fields;
  const ib = entry.fields ?? {};
  if (!fields) {
    return Object.entries(ib).slice(0, 14).map(([k, v]) => ({ key: k, label: k.replace(/_/g, ' '), value: String(v) }));
  }
  const rows: { key: string; label: string; value: string }[] = [];
  for (const k of fields) {
    // entry.fields keys are space-normalized server-side; accept either form.
    const v = ib[k] ?? ib[k.replace(/_/g, ' ')];
    if (v && String(v).trim()) {
      let value = String(v).trim();
      // Caps is the currency — label the value field clearly.
      if (k === 'value' && /^[\d,]+$/.test(value)) value = `${value} caps`;
      rows.push({ key: k, label: k.replace(/_/g, ' '), value });
    }
  }
  return rows;
}

// ── WikiPanel component ────────────────────────────────────────────────────────

interface WikiPanelProps {
  theme: WebTheme;
  chromeBgAlpha: number;
  primaryColor: string;
  isPublicMode: boolean;
  onClose: () => void;
  initialTerm?: string;
  /**
   * When true, `initialTerm` is treated as an exact `wikiTitle` — the panel
   * calls `doFetchEntry` only and never falls back to fuzzy `fetchBestMatch`.
   * Use this for wiki-share embed clicks where `wikiTitle` is the canonical
   * stored title, so a "(Fallout 76)" suffix cannot fuzzy-match a wrong article
   * (e.g. "SOAP (Fallout 76)" mis-hitting "Fallout 76 Railways").
   */
  exactTitle?: boolean;
  onShareToChat: (entry: WikiEntry, channelId: string) => Promise<void>;
  joinedParties: Pick<Party, 'id' | 'name' | 'color'>[];
}

// Channel options for the Share modal — FO76 built-in subs (no Main channel).
const WIKI_SHARE_CHANNELS: { id: string; label: string }[] = [
  { id: '00000000-0000-0000-0000-000000000005', label: 'General' },
  { id: '00000000-0000-0000-0000-000000000002', label: 'Trade' },
  { id: '00000000-0000-0000-0000-000000000003', label: 'Events' },
  { id: '00000000-0000-0000-0000-000000000004', label: 'Raids' },
];

function WikiPanel({
  theme, chromeBgAlpha, primaryColor, isPublicMode, onClose, initialTerm, exactTitle = false, onShareToChat, joinedParties,
}: WikiPanelProps) {
  const { panelBg, chromeBg, borderCol, dimText } = deriveThemeTokens(theme, primaryColor, chromeBgAlpha);
  const glowEnabled = theme.glowEnabled;
  const ff        = theme.fontFamily;

  type PanelState = 'loading' | 'success' | 'no-infobox' | 'error' | 'not-found';
  const [panelState, setPanelState] = React.useState<PanelState>('loading');
  const [entry, setEntry] = React.useState<WikiEntry | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string>('');
  const [history, setHistory] = React.useState<string[]>([]);
  const [imgError, setImgError] = React.useState(false);
  const [imgLoaded, setImgLoaded] = React.useState(false);
  const [imgRetry, setImgRetry] = React.useState(0);
  const [shareState, setShareState] = React.useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [shareModalOpen, setShareModalOpen] = React.useState(false);
  const [shareTargetId, setShareTargetId] = React.useState<string>(WIKI_SHARE_CHANNELS[0].id);
  const [copyFlashWiki, setCopyFlashWiki] = React.useState(false);
  const [carouselIdx, setCarouselIdx] = React.useState(0);
  // Image lightbox (click-to-expand fills the panel; scroll-wheel zooms at cursor).
  const [expandedImage, setExpandedImage] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const dragRef = React.useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const draggedRef = React.useRef(false); // true once a press has moved — so drag ≠ click
  const closeLightbox = React.useCallback(() => { setExpandedImage(null); setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  const [locationFocusIdx, setLocationFocusIdx] = React.useState(-1);
  // Roving focus index across panel interactive targets (-1 = none).
  const [panelFocusIdx, setPanelFocusIdx] = React.useState(-1);
  const lastTermRef = React.useRef<string>('');

  const doFetchEntry = React.useCallback(async (title: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/wiki/entry/${encodeURIComponent(title)}`);
      if (res.status === 404) { setPanelState('not-found'); return false; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const e: WikiEntry = json.data;
      setEntry(e);
      const hasFields = e.fields && Object.keys(e.fields).length > 0;
      setPanelState(hasFields ? 'success' : 'no-infobox');
      return true;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Lookup failed');
      setPanelState('error');
      return false;
    }
  }, []);

  const fetchEntry = React.useCallback(async (title: string, pushHistory = false) => {
    setPanelState('loading');
    setErrorMsg('');
    setImgError(false);
    setImgLoaded(false);
    setImgRetry(0);
    setCarouselIdx(0);
    setShareState('idle');
    if (pushHistory) {
      setEntry(prev => {
        if (prev?.wikiTitle) setHistory(h => [...h, prev.wikiTitle].slice(-10));
        return prev;
      });
    }
    setEntry(null);
    await doFetchEntry(title);
  }, [doFetchEntry]);

  const fetchBestMatch = React.useCallback(async (term: string) => {
    lastTermRef.current = term;
    setPanelState('loading');
    setEntry(null);
    setErrorMsg('');
    setImgError(false);
    setImgLoaded(false);
    setImgRetry(0);
    setCarouselIdx(0);
    setShareState('idle');
    try {
      const res = await fetch(`/api/wiki/search?q=${encodeURIComponent(term)}&limit=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const results: WikiSearchResult[] = json.data ?? [];
      if (results.length === 0) { setPanelState('not-found'); return; }
      await doFetchEntry(results[0].wikiTitle);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Lookup failed');
      setPanelState('error');
    }
  }, [doFetchEntry]);

  // Navigate to a new entry, pushing the current entry onto the history stack.
  const navigate = React.useCallback((title: string) => {
    setLocationFocusIdx(-1);
    setPanelFocusIdx(-1);
    fetchEntry(title, true);
  }, [fetchEntry]);

  React.useEffect(() => {
    if (!initialTerm) return;
    lastTermRef.current = initialTerm;
    (async () => {
      // initialTerm is an exact entry name (AC selection) or a typed term.
      // Try a DIRECT entry fetch first (resolves by name, case-insensitive) and
      // only fall back to fuzzy best-match for partial/typo terms. This avoids
      // ever fuzzy-searching a "(Fallout 76)" wiki title (which mis-hits
      // "Fallout 76 railways") and is what makes a repeat /wiki swap to the
      // newly-typed entry instead of a stale fuzzy result.
      //
      // When exactTitle=true (wiki-share embed click), the caller has the canonical
      // stored wikiTitle — never fuzzy-search it, since "(Fallout 76)" in the title
      // would hit the wrong article if doFetchEntry returns 404 for any reason.
      const ok = await doFetchEntry(initialTerm);
      if (!ok && !exactTitle) await fetchBestMatch(initialTerm);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Build the image list for carousel: prefer entry.images; fallback to single-item list from imageUrl.
  // Defined early so focusTargets useMemo can reference carouselImages.length.
  const carouselImages: WikiEntryImage[] = React.useMemo(() => {
    if (!entry) return [];
    if (entry.images && entry.images.length > 0) {
      // For LOCATIONS, always lead with the map image (that's the most useful
      // view of a place). Stable: keeps relative order within maps / non-maps.
      if (entry.kind === 'location' && entry.images.some(i => i.isMap)) {
        return [...entry.images.filter(i => i.isMap), ...entry.images.filter(i => !i.isMap)];
      }
      return entry.images;
    }
    const fb = entry.imageUrl;
    if (fb) return [{ url: fb, aspect: entry.imageAspect, isMap: false, width: null, height: null }];
    return [];
  }, [entry]);

  // ── Roving-focus target list ─────────────────────────────────────────────────
  // Computed from current state. Each entry has a string id and an action fn.
  // The carousel prev/next/dot targets are tagged so Left/Right cycle the carousel
  // instead of moving the focus ring.
  type FocusTarget = {
    id: string;
    isCarousel?: boolean;
    action: () => void;
  };

  // Flatten locations into renderable rows + a flat list of linkable location
  // titles. Only segments with a `title` are links (just the place name).
  const { locationRows, locationLinks } = React.useMemo(() => {
    const links: string[] = [];
    const rows = (entry?.locations ?? []).map((row) => {
      const segs = Array.isArray(row) ? row : [{ text: String(row) } as WikiLocationSegment];
      return segs.map((seg) => {
        const s = (typeof seg === 'string' ? { text: seg } : seg) as WikiLocationSegment;
        const text = String(s?.text ?? '');
        const title = s && typeof s === 'object' && s.title ? String(s.title) : undefined;
        if (title) { const linkIdx = links.length; links.push(title); return { text, title, linkIdx }; }
        return { text, linkIdx: undefined as number | undefined };
      });
    });
    return { locationRows: rows, locationLinks: links };
  }, [entry]);

  const focusTargets: FocusTarget[] = React.useMemo(() => {
    const targets: FocusTarget[] = [];
    // Chrome bar (back button removed — Backspace still navigates back)
    targets.push({ id: 'close', action: () => onClose() });
    // Carousel controls (only when >1 image)
    if (carouselImages.length > 1) {
      targets.push({ id: 'carousel-prev', isCarousel: true, action: () => { setCarouselIdx(i => (i - 1 + carouselImages.length) % carouselImages.length); setImgError(false); setImgLoaded(false); setImgRetry(0); } });
      for (let di = 0; di < carouselImages.length; di++) {
        const dotIdx = di;
        targets.push({ id: `carousel-dot-${dotIdx}`, isCarousel: true, action: () => { setCarouselIdx(dotIdx); setImgError(false); setImgLoaded(false); setImgRetry(0); } });
      }
      targets.push({ id: 'carousel-next', isCarousel: true, action: () => { setCarouselIdx(i => (i + 1) % carouselImages.length); setImgError(false); setImgLoaded(false); setImgRetry(0); } });
    }
    // Action buttons (only when entry loaded)
    if (entry && (panelState === 'success' || panelState === 'no-infobox')) {
      if (!isPublicMode) targets.push({ id: 'share', action: () => handleShare() });
      targets.push({ id: 'view-article', action: () => handleViewArticle() });
      targets.push({ id: 'copy-link', action: () => handleCopyLink() });
    }
    // Location links — one focus target per actual location-name link.
    locationLinks.forEach((title, li) => {
      targets.push({ id: `loc-${li}`, action: () => navigate(title) });
    });
    return targets;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, panelState, history.length, carouselImages.length, isPublicMode, locationLinks]);

  // Keep panelFocusIdx in bounds when targets list changes.
  React.useEffect(() => {
    setPanelFocusIdx(i => (i >= focusTargets.length ? -1 : i));
  }, [focusTargets.length]);

  // Sync locationFocusIdx with panelFocusIdx so location rows show the highlight.
  React.useEffect(() => {
    const target = panelFocusIdx >= 0 ? focusTargets[panelFocusIdx] : null;
    if (target?.id.startsWith('loc-')) {
      const locIdx = parseInt(target.id.slice(4), 10);
      setLocationFocusIdx(locIdx);
    } else {
      setLocationFocusIdx(-1);
    }
  }, [panelFocusIdx, focusTargets]);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // The share modal owns the keyboard while it's open.
      if (shareModalOpen) return;
      // The expanded-image lightbox is modal: Esc/Delete/Backspace close it.
      if (expandedImage) {
        if (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
        return;
      }
      // Are we actively editing text? (don't hijack Backspace/Delete then)
      const ae = document.activeElement as HTMLElement | null;
      const typing = !!ae && (ae.isContentEditable || ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement)
        && (((ae as HTMLInputElement).value ?? ae.textContent ?? '').length > 0);

      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (typing) return;

      // Delete → close the wiki window (intercept the overlay's hide binding).
      if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      // Backspace → go back a page.
      if (e.key === 'Backspace' && history.length > 0) { e.preventDefault(); e.stopPropagation(); goBack(); return; }

      // Tab → move focus ring forward (shift+tab = backward).
      if (e.key === 'Tab' && focusTargets.length > 0) {
        e.preventDefault();
        setPanelFocusIdx(i => {
          if (e.shiftKey) return i <= 0 ? focusTargets.length - 1 : i - 1;
          return i >= focusTargets.length - 1 ? 0 : i + 1;
        });
        return;
      }

      // ArrowDown / ArrowUp → move focus ring through all targets.
      if (e.key === 'ArrowDown' && focusTargets.length > 0) {
        e.preventDefault();
        setPanelFocusIdx(i => i >= focusTargets.length - 1 ? 0 : i + 1);
        return;
      }
      if (e.key === 'ArrowUp' && focusTargets.length > 0) {
        e.preventDefault();
        setPanelFocusIdx(i => i <= 0 ? focusTargets.length - 1 : i - 1);
        return;
      }

      // ArrowLeft / ArrowRight:
      //   • When current focus is on a carousel target → cycle carousel images.
      //   • Otherwise → move focus ring (same as Up/Down but horizontal feel).
      const currentTarget = panelFocusIdx >= 0 ? focusTargets[panelFocusIdx] : null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (currentTarget?.isCarousel && entry) {
          // Cycle the carousel.
          const imgCount = carouselImages.length;
          if (imgCount > 1) {
            e.preventDefault();
            if (e.key === 'ArrowLeft') {
              setCarouselIdx(i => (i - 1 + imgCount) % imgCount);
            } else {
              setCarouselIdx(i => (i + 1) % imgCount);
            }
            setImgError(false); setImgLoaded(false); setImgRetry(0);
          }
        } else if (focusTargets.length > 0) {
          // Move the focus ring left/right.
          e.preventDefault();
          if (e.key === 'ArrowLeft') {
            setPanelFocusIdx(i => i <= 0 ? focusTargets.length - 1 : i - 1);
          } else {
            setPanelFocusIdx(i => i >= focusTargets.length - 1 ? 0 : i + 1);
          }
        }
        return;
      }

      // Enter → activate focused target.
      if (e.key === 'Enter' && panelFocusIdx >= 0 && panelFocusIdx < focusTargets.length) {
        e.preventDefault();
        focusTargets[panelFocusIdx].action();
        return;
      }
    };
    // Capture phase so we intercept Delete/Backspace before the overlay's global keybinds.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose, entry, history, navigate, focusTargets, panelFocusIdx, carouselImages, shareModalOpen, expandedImage, closeLightbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close the lightbox whenever the open entry changes (navigation / Back).
  React.useEffect(() => { closeLightbox(); }, [entry?.id, closeLightbox]);

  function goBack() {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setLocationFocusIdx(-1);
    setPanelFocusIdx(-1);
    fetchEntry(prev);
  }

  function handleShare() {
    if (!entry) return;
    setShareTargetId(WIKI_SHARE_CHANNELS[0].id);
    setShareModalOpen(true);
  }

  async function confirmShare() {
    if (!entry) return;
    setShareModalOpen(false);
    setShareState('sending');
    try {
      await onShareToChat(entry, shareTargetId);
      setShareState('sent');
      setTimeout(() => setShareState('idle'), 3000);
    } catch {
      setShareState('error');
      setTimeout(() => setShareState('idle'), 3000);
    }
  }

  // Flat option list for the share target picker (channels + a separator + parties).
  const shareOptions = React.useMemo(() => {
    const opts: { id: string; label: string; selectable: boolean }[] =
      WIKI_SHARE_CHANNELS.map(ch => ({ id: ch.id, label: ch.label, selectable: true }));
    if (joinedParties.length > 0) {
      opts.push({ id: '__sep__', label: '── Your Parties ──', selectable: false });
      for (const p of joinedParties) opts.push({ id: p.id, label: p.name, selectable: true });
    }
    return opts;
  }, [joinedParties]);

  // Full keyboard control of the share modal: ↑↓ move, Enter share, Esc/Del close.
  React.useEffect(() => {
    if (!shareModalOpen) return;
    const selectable = shareOptions.filter(o => o.selectable);
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const idx = selectable.findIndex(o => o.id === shareTargetId);
        const next = e.key === 'ArrowDown'
          ? selectable[(idx + 1) % selectable.length]
          : selectable[(idx - 1 + selectable.length) % selectable.length];
        if (next) setShareTargetId(next.id);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation(); confirmShare();
      } else if (e.key === 'Escape' || e.key === 'Delete') {
        e.preventDefault(); e.stopPropagation(); setShareModalOpen(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareModalOpen, shareOptions, shareTargetId]);

  // While the Share-to-Chat modal is open, pin the overlay fully interactive so
  // its options are clickable (the modal is a document.body portal, outside the
  // auto-click-through region) — and so the pass-through click that would blur +
  // auto-hide the overlay can't happen. Same mechanism settings/onboarding use.
  React.useEffect(() => {
    const br = (window as any).relayBridge;
    try { br?.setModalInteractive?.(shareModalOpen); } catch { /* web/no-bridge */ }
    return () => { try { br?.setModalInteractive?.(false); } catch { /* noop */ } };
  }, [shareModalOpen]);

  function handleViewArticle() {
    if (!entry) return;
    openUrl(wikiArticleUrl(entry.wikiTitle));
  }

  function handleCopyLink() {
    if (!entry) return;
    const url = wikiArticleUrl(entry.wikiTitle);
    if ((window as any).relayBridge?.writeClipboard) {
      (window as any).relayBridge.writeClipboard(url);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
    setCopyFlashWiki(true);
    setTimeout(() => setCopyFlashWiki(false), 2000);
  }

  const btnStyle: React.CSSProperties = {
    minHeight: 0, boxSizing: 'border-box', padding: '4px 12px',
    fontSize: '10px', fontFamily: ff, background: 'transparent',
    border: `1px solid ${hexAlpha(primaryColor, 0.4)}`,
    color: primaryColor, cursor: 'pointer', letterSpacing: '0.05em',
    textShadow: glowEnabled ? `0 0 4px ${hexAlpha(primaryColor, 0.5)}` : 'none',
  };

  // Returns extra style for a button when it's the roving-focus target.
  const focusedStyle = (targetId: string): React.CSSProperties => {
    const idx = focusTargets.findIndex(t => t.id === targetId);
    if (idx < 0 || panelFocusIdx !== idx) return {};
    return {
      outline: `2px solid ${primaryColor}`,
      outlineOffset: '1px',
      background: hexAlpha(primaryColor, 0.12),
    };
  };

  const safeCarouselIdx = carouselImages.length > 0 ? Math.min(carouselIdx, carouselImages.length - 1) : 0;
  const currentCarouselImage = carouselImages[safeCarouselIdx] ?? null;
  const maxImgH = wikiImageMaxHeight((currentCarouselImage?.aspect as WikiEntry['imageAspect']) ?? entry?.imageAspect ?? null);

  // Fills the chat feed area (the input box stays visible below); not a portal.
  return (
    <>
    <div
      style={{
        flex: 1, minHeight: 0, position: 'relative',
        background: panelBg,
        display: 'flex', flexDirection: 'column', fontFamily: ff,
      }}
    >
        {/* Image lightbox — fills the panel frame; scroll to zoom at cursor, drag to pan. */}
        {expandedImage && (
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.93)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: dragRef.current ? 'grabbing' : 'grab' }}
            onWheel={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const mx = e.clientX - rect.left - rect.width / 2;
              const my = e.clientY - rect.top - rect.height / 2;
              const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
              const nz = Math.min(8, Math.max(1, zoom * factor));
              const ratio = nz / zoom;
              // Zoom toward the cursor; keep the dragged position (no snap-back).
              setPan({ x: mx - (mx - pan.x) * ratio, y: my - (my - pan.y) * ratio });
              setZoom(nz);
            }}
            // Drag to pan at ANY zoom — image can be pulled out of frame and stays put.
            onMouseDown={(e) => { dragRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y }; draggedRef.current = false; }}
            onMouseMove={(e) => {
              const d = dragRef.current; if (!d) return;
              if (Math.abs(e.clientX - d.mx) > 3 || Math.abs(e.clientY - d.my) > 3) draggedRef.current = true;
              setPan({ x: d.px + (e.clientX - d.mx), y: d.py + (e.clientY - d.my) });
            }}
            onMouseUp={() => { dragRef.current = null; }}
            onMouseLeave={() => { dragRef.current = null; }}
            onClick={(e) => { if (e.target === e.currentTarget && !draggedRef.current) closeLightbox(); }}
          >
            <img
              src={resolveMediaUrl(expandedImage)}
              alt={entry?.name || ''}
              draggable={false}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transition: dragRef.current ? 'none' : 'transform 0.08s ease-out', userSelect: 'none' }}
            />
            {/* Close — same top-right position as the panel's chrome ✕ */}
            <button
              onClick={(e) => { e.stopPropagation(); closeLightbox(); }}
              title="Close image"
              style={{ ...btnStyle, position: 'absolute', top: '8px', right: '12px', padding: '3px 8px', fontSize: '12px', zIndex: 61 }}
            >&#10005;</button>
            <div style={{ position: 'absolute', bottom: '6px', left: 0, right: 0, textAlign: 'center', fontSize: '9px', letterSpacing: '0.04em', color: hexAlpha(primaryColor, 0.45), pointerEvents: 'none' }}>
              scroll to zoom · drag to pan · ✕ to close
            </div>
          </div>
        )}
        {/* Chrome bar — compact single row (no back button; Backspace goes back). */}
        <div style={{
          background: chromeBg, borderBottom: `1px solid ${borderCol}`,
          padding: '3px 10px', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
        }}>
          <button
            onClick={() => openUrl('https://fallout.wiki')}
            title="Open the Fallout Wiki home page"
            style={{
              flex: 1, display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: '6px',
              cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: ff, lineHeight: 1, minWidth: 0,
              padding: 0, minHeight: 0, // override the global 44px touch-target min-height
            }}
          >
            <span style={{
              fontSize: '11px', fontWeight: 'bold', color: primaryColor, letterSpacing: '0.1em', whiteSpace: 'nowrap',
              textShadow: glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6)}` : 'none',
            }}>&#9672; FALLOUT WIKI &#8599;</span>
            <span style={{ fontSize: '8px', color: hexAlpha(theme.secondaryColor, 0.45), letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>&middot; CC-BY-SA 3.0</span>
          </button>
          <button onClick={onClose} title="Close" style={{ ...btnStyle, padding: '1px 7px', fontSize: '11px', ...focusedStyle('close') }}>&#10005;</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {panelState === 'loading' && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px', flexDirection: 'column', gap: '12px' }}>
              <div style={{
                width: '24px', height: '24px', border: `2px solid ${hexAlpha(primaryColor, 0.3)}`,
                borderTop: `2px solid ${primaryColor}`, borderRadius: '50%',
                animation: 'fcm-spin 0.8s linear infinite',
              }} />
              <span style={{ fontSize: '11px', color: dimText, letterSpacing: '0.06em' }}>LOOKING UP…</span>
            </div>
          )}
          {panelState === 'not-found' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 20px', gap: '12px' }}>
              <div style={{ fontSize: '28px', opacity: 0.4, color: dimText }}>?</div>
              <div style={{ fontSize: '13px', color: dimText, textAlign: 'center' }}>Entry not found in the catalog.</div>
              <button onClick={onClose} style={btnStyle}>CLOSE</button>
            </div>
          )}
          {panelState === 'error' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 20px', gap: '12px' }}>
              <div style={{ fontSize: '11px', color: '#FF6060', textAlign: 'center' }}>{errorMsg || 'Lookup failed'}</div>
              <button onClick={() => lastTermRef.current ? fetchBestMatch(lastTermRef.current) : (entry ? fetchEntry(entry.wikiTitle) : onClose())} style={btnStyle}>RETRY</button>
            </div>
          )}
          {(panelState === 'success' || panelState === 'no-infobox') && entry && (
            <>
              {/* Header */}
              <div style={{ padding: '12px 14px 8px', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.12)}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '15px', fontWeight: 'bold', color: primaryColor, flex: 1, minWidth: 0,
                    wordBreak: 'break-word',
                    textShadow: glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.5)}` : 'none',
                  }}>{entry.name}</span>
                  {entry.kind && (
                    <span style={{
                      flexShrink: 0, fontSize: '9px', letterSpacing: '0.08em', fontWeight: 'bold',
                      padding: '2px 6px', border: `1px solid ${primaryColor}`,
                      color: primaryColor, background: hexAlpha(primaryColor, 0.1),
                    }}>{wikiKindLabel(entry.kind)}</span>
                  )}
                </div>
              </div>
              {/* Image / Carousel */}
              {carouselImages.length > 0 && currentCarouselImage && (
                <div style={{
                  padding: '10px 14px', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.08)}`,
                  background: 'transparent',
                }}>
                  {/* Image display with MAP badge */}
                  {/* Reserved, stable height so cycling images never resizes/flashes the layout. */}
                  <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', height: `${maxImgH}px`, transition: 'height 0.15s ease' }}>
                    {!imgError && (
                      <img
                        key={currentCarouselImage.url + '#' + imgRetry}
                        src={resolveMediaUrl(currentCarouselImage.url) + (imgRetry ? `?r=${imgRetry}` : '')} alt={entry.name}
                        onLoad={() => setImgLoaded(true)}
                        onError={() => {
                          // Don't latch on the first failure — retry a couple times
                          // (handles transient proxy/cache races) before giving up.
                          if (imgRetry < 2) setTimeout(() => setImgRetry(r => r + 1), 400);
                          else setImgError(true);
                        }}
                        onClick={() => currentCarouselImage && setExpandedImage(currentCarouselImage.url)}
                        title="Click to expand"
                        style={{
                          maxHeight: '100%', maxWidth: '100%',
                          objectFit: 'contain', background: 'transparent', cursor: 'zoom-in',
                          opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.18s ease',
                        }}
                      />
                    )}
                    {!imgLoaded && !imgError && (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                        <div style={{ width: '16px', height: '16px', border: `2px solid ${hexAlpha(primaryColor, 0.3)}`, borderTop: `2px solid ${primaryColor}`, borderRadius: '50%', animation: 'fcm-spin 0.8s linear infinite' }} />
                      </div>
                    )}
                    {imgError && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', opacity: 0.5 }}>
                        <span style={{ fontSize: '20px', color: dimText }}>?</span>
                        <span style={{ fontSize: '9px', color: dimText, letterSpacing: '0.06em' }}>IMAGE UNAVAILABLE</span>
                      </div>
                    )}
                    {/* MAP label — read-only indicator that this image is a map (not a button). */}
                    {currentCarouselImage.isMap && imgLoaded && !imgError && (
                      <div
                        title="This image is a map view of the location"
                        style={{
                          position: 'absolute', top: '4px', right: '4px',
                          fontSize: '8px', fontWeight: 'bold', letterSpacing: '0.08em',
                          padding: '2px 6px', background: hexAlpha(primaryColor, 0.75),
                          color: theme.backgroundColor, pointerEvents: 'none',
                          borderRadius: '3px', cursor: 'default', userSelect: 'none',
                        }}
                      >MAP</div>
                    )}
                  </div>
                  {/* Carousel controls — only when multiple images */}
                  {carouselImages.length > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
                      <button
                        onClick={() => { setCarouselIdx(i => (i - 1 + carouselImages.length) % carouselImages.length); setImgError(false); setImgLoaded(false); setImgRetry(0); }}
                        style={{ ...btnStyle, padding: '2px 7px', fontSize: '12px', lineHeight: 1, ...focusedStyle('carousel-prev') }}
                        aria-label="Previous image"
                      >&#8249;</button>
                      {/* Dot indicators — flexShrink:0 keeps them circular even
                          with many images (they wrap instead of squishing to ovals) */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', justifyContent: 'center', maxWidth: '55%' }}>
                        {carouselImages.map((_, i) => (
                          <button
                            key={i}
                            onClick={() => { setCarouselIdx(i); setImgError(false); setImgLoaded(false); setImgRetry(0); }}
                            style={{
                              width: i === safeCarouselIdx ? '8px' : '6px',
                              height: i === safeCarouselIdx ? '8px' : '6px',
                              minWidth: 0, minHeight: 0, lineHeight: 0,
                              appearance: 'none', WebkitAppearance: 'none', display: 'block',
                              flexShrink: 0, boxSizing: 'border-box', borderRadius: '50%',
                              background: i === safeCarouselIdx ? primaryColor : hexAlpha(primaryColor, 0.3),
                              border: 'none', padding: 0, cursor: 'pointer', transition: 'all 0.15s',
                              ...focusedStyle(`carousel-dot-${i}`),
                            }}
                            aria-label={`Image ${i + 1}`}
                          />
                        ))}
                      </div>
                      <span style={{ fontSize: '9px', color: dimText, letterSpacing: '0.05em', minWidth: '32px', textAlign: 'center' }}>
                        {safeCarouselIdx + 1} / {carouselImages.length}
                      </span>
                      <button
                        onClick={() => { setCarouselIdx(i => (i + 1) % carouselImages.length); setImgError(false); setImgLoaded(false); setImgRetry(0); }}
                        style={{ ...btnStyle, padding: '2px 7px', fontSize: '12px', lineHeight: 1, ...focusedStyle('carousel-next') }}
                        aria-label="Next image"
                      >&#8250;</button>
                    </div>
                  )}
                </div>
              )}
              {/* Stats */}
              {panelState === 'success' && (
                <div style={{ padding: '8px 14px', flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '16px', rowGap: '1px', alignContent: 'start' }}>
                  {wikiStatRows(entry).map(row => (
                    <div key={row.key} style={{ display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.06)}`, minWidth: 0 }}>
                      <span style={{
                        flexShrink: 0, fontSize: '9px', letterSpacing: '0.06em',
                        color: dimText, textTransform: 'uppercase',
                        fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace',
                      }}>{row.label}</span>
                      <span style={{ fontSize: '11px', color: theme.textColor, wordBreak: 'break-word', flex: 1, minWidth: 0, textAlign: 'right' }}>{row.value}</span>
                    </div>
                  ))}
                  {wikiStatRows(entry).length === 0 && (
                    <div style={{ gridColumn: '1 / -1', fontSize: '11px', color: dimText, padding: '8px 0' }}>No stat data available.</div>
                  )}
                </div>
              )}
              {panelState === 'no-infobox' && (
                <div style={{ padding: '14px', color: dimText, fontSize: '11px' }}>No stat data available for this entry.</div>
              )}
              {/* Locations */}
              {locationRows.length > 0 && (
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${hexAlpha(primaryColor, 0.08)}` }}>
                  <div style={{
                    fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.1em',
                    color: dimText, textTransform: 'uppercase', marginBottom: '6px',
                    fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace',
                  }}>LOCATIONS</div>
                  <ul style={{ margin: 0, padding: '0 0 0 14px', listStyle: 'disc' }}>
                    {locationRows.map((segs, i) => (
                      <li key={i} style={{
                        fontSize: '11px', wordBreak: 'break-word', overflowWrap: 'anywhere',
                        paddingBottom: '2px', lineHeight: 1.4, color: theme.textColor,
                      }}>
                        {segs.map((seg, si) => (
                          seg.linkIdx != null ? (
                            <span
                              key={si}
                              role="button"
                              tabIndex={0}
                              title={`Open ${seg.text} in the wiki`}
                              onClick={() => navigate(seg.title!)}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(seg.title!); } }}
                              onMouseEnter={() => setLocationFocusIdx(seg.linkIdx!)}
                              onMouseLeave={() => setLocationFocusIdx(-1)}
                              style={{
                                color: primaryColor, cursor: 'pointer',
                                textDecoration: 'underline', textUnderlineOffset: '2px',
                                background: locationFocusIdx === seg.linkIdx ? hexAlpha(primaryColor, 0.18) : 'transparent',
                                textShadow: locationFocusIdx === seg.linkIdx ? `0 0 6px ${hexAlpha(primaryColor, 0.7)}` : undefined,
                                outline: 'none',
                              }}
                            >{seg.text}</span>
                          ) : (
                            <span key={si}>{seg.text}</span>
                          )
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* C.A.M.P. */}
              {entry && entry.campData && entry.campData.length > 0 && (
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${hexAlpha(primaryColor, 0.08)}` }}>
                  <div style={{
                    fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.1em',
                    color: '#B57BFF', textTransform: 'uppercase', marginBottom: '6px',
                    fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace',
                  }}>C.A.M.P.</div>
                  {entry.campData.map((c, i) => (
                    <div key={c.id} style={{
                      marginBottom: i < entry.campData!.length - 1 ? '8px' : 0,
                      paddingBottom: i < entry.campData!.length - 1 ? '8px' : 0,
                      borderBottom: i < entry.campData!.length - 1 ? `1px solid ${hexAlpha(primaryColor, 0.06)}` : 'none',
                    }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '16px', rowGap: '1px' }}>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.06)}` }}>
                          <span style={{ flexShrink: 0, fontSize: '9px', letterSpacing: '0.06em', color: dimText, textTransform: 'uppercase', fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace' }}>Category</span>
                          <span style={{ fontSize: '11px', color: theme.textColor, wordBreak: 'break-word', flex: 1, minWidth: 0, textAlign: 'right' }}>{c.category} › {c.subCategory}</span>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.06)}` }}>
                          <span style={{ flexShrink: 0, fontSize: '9px', letterSpacing: '0.06em', color: dimText, textTransform: 'uppercase', fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace' }}>Budget</span>
                          <span style={{ fontSize: '11px', color: theme.textColor, flex: 1, minWidth: 0, textAlign: 'right' }}>{c.budgetCost != null ? c.budgetCost : '—'}</span>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.06)}`, gridColumn: '1 / -1' }}>
                          <span style={{ flexShrink: 0, fontSize: '9px', letterSpacing: '0.06em', color: dimText, textTransform: 'uppercase', fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace' }}>Source</span>
                          <span style={{ fontSize: '11px', color: theme.textColor, flex: 1, minWidth: 0, textAlign: 'right' }}>{c.sourceLabel}</span>
                        </div>
                        {c.plan && (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.06)}`, gridColumn: '1 / -1' }}>
                            <span style={{ flexShrink: 0, fontSize: '9px', letterSpacing: '0.06em', color: dimText, textTransform: 'uppercase', fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace' }}>Plan</span>
                            <span style={{ fontSize: '11px', color: theme.textColor, wordBreak: 'break-word', flex: 1, minWidth: 0, textAlign: 'right' }}>{c.plan}</span>
                          </div>
                        )}
                        {c.atomPrice != null && (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.06)}`, gridColumn: '1 / -1' }}>
                            <span style={{ flexShrink: 0, fontSize: '9px', letterSpacing: '0.06em', color: dimText, textTransform: 'uppercase', fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace' }}>Atoms</span>
                            <span style={{ fontSize: '11px', color: theme.textColor, flex: 1, minWidth: 0, textAlign: 'right' }}>{c.atomPrice} · last known</span>
                          </div>
                        )}
                        {c.atomBundle != null && (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline', padding: '2px 0', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.06)}`, gridColumn: '1 / -1' }}>
                            <span style={{ flexShrink: 0, fontSize: '9px', letterSpacing: '0.06em', color: dimText, textTransform: 'uppercase', fontFamily: /courier|mono/i.test(ff) ? ff : '"Courier New", monospace' }}>Bundle</span>
                            <span style={{ fontSize: '11px', color: theme.textColor, wordBreak: 'break-word', flex: 1, minWidth: 0, textAlign: 'right' }}>{c.atomBundle}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions bar */}
        {(panelState === 'success' || panelState === 'no-infobox') && entry && (
          <div style={{
            borderTop: `1px solid ${borderCol}`, padding: '8px 12px',
            display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            background: chromeBg,
          }}>
            {!isPublicMode && (
              <button
                onClick={handleShare}
                disabled={shareState === 'sending' || shareState === 'sent'}
                style={{ ...btnStyle, opacity: (shareState === 'sending' || shareState === 'sent') ? 0.6 : 1, background: shareState === 'sent' ? hexAlpha(primaryColor, 0.12) : 'transparent', ...focusedStyle('share') }}
              >
                {shareState === 'idle' ? 'SHARE TO CHAT' : shareState === 'sending' ? 'SHARING…' : shareState === 'sent' ? 'SHARED ✓' : 'ERROR'}
              </button>
            )}
            <button onClick={handleViewArticle} style={{ ...btnStyle, ...focusedStyle('view-article') }}>VIEW ARTICLE &#8599;</button>
            <button onClick={handleCopyLink} style={{ ...btnStyle, ...focusedStyle('copy-link') }}>{copyFlashWiki ? 'COPIED!' : 'COPY LINK'}</button>
          </div>
        )}

        {/* Keyboard-hint footer */}
        <div style={{
          padding: '4px 10px', flexShrink: 0,
          borderTop: `1px solid ${hexAlpha(primaryColor, 0.1)}`,
          background: hexAlpha(theme.chromeColor, Math.min(1, theme.chromeAlpha * 1.2)),
          display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '0 10px',
        }}>
          {[
            '↑↓ navigate',
            '←→ images / move',
            'Enter select',
            'Backspace back',
            'Del close',
          ].map(hint => (
            <span key={hint} style={{ fontSize: '8px', color: hexAlpha(theme.secondaryColor, 0.45), letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
              {hint}
            </span>
          ))}
        </div>

    </div>

    {/* ── Share-to-Chat modal (portal to body) ─────────────────────────── */}
    {shareModalOpen && entry && createPortal(

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share to Chat"
        style={{
          position: 'fixed', inset: 0, zIndex: 9100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.65)',
        }}
        onClick={e => { if (e.target === e.currentTarget) setShareModalOpen(false); }}
      >
        <div style={{
          background: hexToRgba(theme.chromeColor, Math.min(1, theme.chromeAlpha * 1.6)),
          border: `1px solid ${hexAlpha(primaryColor, 0.5)}`,
          fontFamily: ff, color: theme.secondaryColor,
          padding: '16px 18px', minWidth: '260px', maxWidth: '340px', width: '90%',
          display: 'flex', flexDirection: 'column', gap: '12px',
          boxShadow: `0 0 24px ${hexAlpha(primaryColor, 0.18)}`,
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: primaryColor, fontWeight: 'bold', letterSpacing: '0.08em', fontSize: '13px' }}>
              &#9672; SHARE TO CHAT
            </span>
            <button
              onClick={() => setShareModalOpen(false)}
              style={{
                background: 'transparent', border: 'none', color: hexAlpha(primaryColor, 0.7),
                cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '0 2px',
                fontFamily: ff,
              }}
            >&#x2715;</button>
          </div>
          {/* Entry name preview */}
          <div style={{ fontSize: '12px', color: hexAlpha(theme.secondaryColor, 0.75), borderLeft: `2px solid ${hexAlpha(primaryColor, 0.4)}`, paddingLeft: '8px' }}>
            {entry.name}
          </div>
          {/* Channel selector — themed list (no native white <select>), full keyboard nav */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '10px', letterSpacing: '0.08em', color: hexAlpha(primaryColor, 0.8), fontWeight: 'bold' }}>
              SEND TO
            </label>
            <div role="listbox" aria-label="Send to" style={{
              display: 'flex', flexDirection: 'column',
              border: `1px solid ${hexAlpha(primaryColor, 0.35)}`,
              background: hexAlpha(primaryColor, 0.05),
              maxHeight: '190px', overflowY: 'auto',
            }}>
              {shareOptions.map(opt => (
                !opt.selectable ? (
                  <div key={opt.id} style={{
                    fontSize: '9px', letterSpacing: '0.08em', color: hexAlpha(primaryColor, 0.5),
                    padding: '4px 9px 2px', textTransform: 'uppercase',
                  }}>{opt.label}</div>
                ) : (
                  <div
                    key={opt.id}
                    role="option"
                    aria-selected={shareTargetId === opt.id}
                    onClick={() => setShareTargetId(opt.id)}
                    onDoubleClick={() => { setShareTargetId(opt.id); confirmShare(); }}
                    onMouseEnter={() => setShareTargetId(opt.id)}
                    style={{
                      padding: '5px 9px', cursor: 'pointer', fontSize: '12px',
                      fontFamily: ff, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      color: shareTargetId === opt.id ? primaryColor : theme.secondaryColor,
                      background: shareTargetId === opt.id ? hexAlpha(primaryColor, 0.16) : 'transparent',
                      borderLeft: `2px solid ${shareTargetId === opt.id ? primaryColor : 'transparent'}`,
                    }}
                  >{opt.label}</div>
                )
              ))}
            </div>
            <div style={{ fontSize: '8px', color: hexAlpha(theme.secondaryColor, 0.5), letterSpacing: '0.04em', paddingTop: '1px' }}>
              ↑↓ choose · Enter share · Esc close
            </div>
          </div>
          {/* Actions */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setShareModalOpen(false)}
              style={{ ...btnStyle, border: `1px solid ${hexAlpha(primaryColor, 0.3)}`, color: hexAlpha(theme.secondaryColor, 0.7) }}
            >CANCEL</button>
            <button
              onClick={confirmShare}
              style={{ ...btnStyle, background: hexAlpha(primaryColor, 0.15), border: `1px solid ${hexAlpha(primaryColor, 0.6)}`, color: primaryColor, fontWeight: 'bold' }}
            >SHARE</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChatOverlay() {
  const queryClient = useQueryClient();
  const outletCtx = useOutletContext<{ user?: AuthUser }>() || {};
  const user = outletCtx.user;
  // Public/logged-out mode: no auth, read-only REST polling, no parties/input.
  // ONLY the public website — never the Electron overlay, which has no web `user`
  // but authenticates via its install-token session and must always use the WS.
  // The overlay shell global (__FCM_OVERLAY_SHELL__) distinguishes the two.
  const isPublicMode = !user && !getOverlayShell();
  const userRole = user?.role || '';
  const isMod = MOD_ROLES.includes(userRole);
  const isAdmin = ADMIN_ROLES.includes(userRole);

  // ── Settings + theme ──────────────────────────────────────────────────────
  const [settings, setSettingsRaw] = useState<WebOverlaySettings>(loadSettings);
  const theme = findTheme(settings.themeId);
  const primaryColor = theme.primaryColor;
  const showScanlines = theme.scanlinesEnabled;
  const glowEnabled = theme.glowEnabled;
  // Monospace themes (Courier New) render wider/larger than the default Segoe UI
  // theme at the same px, so scale their font down a touch and tighten the tab
  // letter-spacing (per-theme override wins; else auto from fontFamily). CRITICAL:
  // the message line-height + the inter-element gaps must scale by the SAME factor
  // — otherwise the (fixed-px) gaps stay large while the font shrinks and the
  // whole overlay looks sparse. `lineH` and `scaleGap()` below carry that factor
  // through to every spot that was previously a hardcoded px value.
  const isMonoTheme = /courier|monospace/i.test(theme.fontFamily);
  const fontScale = theme.fontScale ?? (isMonoTheme ? 0.9 : 1);
  const fontSize = Math.round(settings.fontSize * fontScale);
  const lineH = Math.round(18 * fontScale);           // message line-height (px), tracks the scaled font
  const scaleGap = useCallback((px: number) => Math.round(px * fontScale), [fontScale]); // shrink fixed gaps with the font
  const tabLetterSpacing = theme.tabLetterSpacing ?? (isMonoTheme ? '0.01em' : '0.04em');

  // ── Chrome-background alpha multiplier (Fix: opacity slider dims background only) ──
  // The Electron shell sets --fcm-chrome-bg-alpha on document.documentElement
  // (0..1) to represent the desired chrome/background opacity. We read it once
  // via MutationObserver so updates (e.g. user dragging the opacity slider in the
  // shell settings panel) are reflected without a page reload. On the website
  // where the var is never set, this stays 1.0 and behaviour is unchanged.
  const [chromeBgAlpha, setChromeBgAlpha] = useState<number>(() => {
    try {
      const val = getComputedStyle(document.documentElement).getPropertyValue('--fcm-chrome-bg-alpha').trim();
      const n = parseFloat(val);
      return isNaN(n) ? 1.0 : Math.max(0, Math.min(1, n));
    } catch { return 1.0; }
  });
  // Live text-opacity override from the Electron shell's --fcm-text-opacity CSS var.
  // null means "unset" → fall back to settings.textOpacity. On the website this var
  // is never written, so textOpacityOverride stays null and behaviour is unchanged.
  const [textOpacityOverride, setTextOpacityOverride] = useState<number | null>(() => {
    try {
      const val = getComputedStyle(document.documentElement).getPropertyValue('--fcm-text-opacity').trim();
      const n = parseFloat(val);
      return isNaN(n) ? null : Math.max(0.1, Math.min(1, n));
    } catch { return null; }
  });
  useEffect(() => {
    const read = () => {
      try {
        const alphaVal = getComputedStyle(document.documentElement).getPropertyValue('--fcm-chrome-bg-alpha').trim();
        const alphaNum = parseFloat(alphaVal);
        setChromeBgAlpha(isNaN(alphaNum) ? 1.0 : Math.max(0, Math.min(1, alphaNum)));
        const textVal = getComputedStyle(document.documentElement).getPropertyValue('--fcm-text-opacity').trim();
        const textNum = parseFloat(textVal);
        setTextOpacityOverride(isNaN(textNum) ? null : Math.max(0.1, Math.min(1, textNum)));
      } catch { /* ignore */ }
    };
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => obs.disconnect();
  }, []);
  // Electron desktop-shell parity (null on the website → no visual change).
  const overlayShell = getOverlayShell();

  function patchSettings(patch: Partial<WebOverlaySettings>) {
    setSettingsRaw(prev => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }

  // Derived color helpers for current theme.
  // chromeBgAlpha (from --fcm-chrome-bg-alpha, set by Electron shell) multiplies
  // background/chrome/input alpha only — text stays fully opaque.
  // Overlay: full 0→1 range so 100% = solid, 0% = transparent.
  // Website (var unset, chromeBgAlpha === 1): keeps the theme's designed semi-transparent look.
  const bgRgba       = hexToRgba(theme.backgroundColor, overlayShell ? chromeBgAlpha : theme.bgAlpha * settings.windowOpacity * chromeBgAlpha);
  const chromeRgba   = hexToRgba(theme.chromeColor,     overlayShell ? chromeBgAlpha : theme.chromeAlpha * settings.windowOpacity * chromeBgAlpha);
  const inputBgRgba  = hexToRgba(theme.inputBgColor,    overlayShell ? chromeBgAlpha : theme.inputAlpha * settings.windowOpacity * chromeBgAlpha);
  const borderRgba   = hexAlpha(primaryColor, 0.25);
  const borderBright = hexAlpha(primaryColor, 0.35);
  const dimText      = hexAlpha(theme.secondaryColor, 0.85);
  const inactiveTab  = hexAlpha(theme.secondaryColor, 0.5);
  // Live override (--fcm-text-opacity) when present, else the persisted setting.
  // Applied to ALL text so the Text Opacity slider dims every glyph uniformly.
  const textAlpha    = textOpacityOverride ?? settings.textOpacity;
  const textRgba     = hexAlpha(theme.textColor, textAlpha);
  // Colored text at the current text alpha — for glyphs only, not borders/dots/accents.
  const primaryText  = hexAlpha(primaryColor, textAlpha);
  const secondaryText = hexAlpha(theme.secondaryColor, textAlpha);
  // Selected tab: full-bright primary + glow. Inactive tabs: dimmed, no glow.
  // Both scale with textAlpha (uniform fade).
  const inactiveTabText = hexAlpha(primaryColor, 0.72 * textAlpha);
  // Dark text outline — keeps text readable over a transparent background (game
  // shows through). Mirrors the near-black halo Fallout 76 renders behind its HUD
  // glyphs: a tight near-opaque ring (contrast) plus progressively softer wide
  // rings (soft edge). All layers scale with textAlpha so they fade uniformly.
  const textOutlineA = (0.98 * textAlpha).toFixed(3);
  const to = (px: number, mul: number) => `0 0 ${px}px rgba(0,0,0,${(mul * textAlpha).toFixed(3)})`;
  const textOutline  = [
    to(1, 0.98), to(2, 0.95), to(3, 0.85),
    to(5, 0.65), to(8, 0.45), to(12, 0.28), to(16, 0.15),
    `0 1px 2px rgba(0,0,0,${textOutlineA})`,
  ].join(', ');
  const textOutlineB = (0.85 * textAlpha).toFixed(3); // referenced by the header-icon drop-shadow filter

  // ── Chat state ────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [connected, setConnected] = useState(false);
  // Mirror of `connected` for callbacks with empty deps (e.g. the onVisibility
  // subscriber) that must read the live connection state without re-subscribing.
  const connectedRef = useRef(false);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  // Set to true when ≥3 consecutive 401/403 ticket-fetch failures are seen.
  // Stops the auto-retry loop and surfaces an "authentication expired" notice.
  // Reset on manual reconnect trigger (wsGate change or wsReconnectTick bump).
  const [authTerminalState, setAuthTerminalState] = useState(false);
  // Transient "you may have missed messages" banner shown after a silent reconnect.
  const [showMissedMsgNotice, setShowMissedMsgNotice] = useState(false);
  // Electron-only WS lifecycle: true = overlay window is visible, false = hidden
  // to tray. Defaults to true so the web path (overlayShell === null) is never
  // affected. Driven by the overlay:visibility IPC signal from main.js.
  // Electron overlay WS gate (HYBRID): connect when the overlay is VISIBLE on
  // screen OR FO76 is running; disconnect only when hidden-to-tray AND the game
  // is closed. So you can read chat with the overlay open even without the game,
  // hidden-but-in-game stays connected, and truly-idle (hidden + no game)
  // disconnects. Both default appropriately on web (overlayShell null → connects).
  const [wsGameActive, setWsGameActive] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [wsReconnectTick, setWsReconnectTick] = useState(0);
  // Initialize from the module-level last-selected (survives remounts) so a
  // remount doesn't snap back to General. Empty on a genuine first mount → the
  // default-selection effect picks General.
  const [activeMainId, setActiveMainId] = useState(lastSelectedMainId);
  const [activeSubId, setActiveSubId] = useState(lastSelectedSubId);
  const [feedMessages, setFeedMessages] = useState<ServerFeedMessage[]>([]);
  const [reportAlerts, setReportAlerts] = useState<{ id: string; reason: string; createdAt: string }[]>([]);
  const [modModal, setModModal] = useState<ModModalState | null>(null);
  const [modLoading, setModLoading] = useState(false);
  const [modError, setModError] = useState<string | null>(null);
  const [hoveredMsg, setHoveredMsg] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; msg: ChatMessage } | null>(null);
  // Right-click menu for a joined-party sub-tab (Open / Invite / Leave|Delete).
  const [partyTabCtx, setPartyTabCtx] = useState<{ x: number; y: number; partyId: string } | null>(null);
  // Invite modal (in-overlay, opened from the member panel "+ INVITE"). Holds
  // the partyId being invited to.
  const [inviteModalFor, setInviteModalFor] = useState<{ partyId: string } | null>(null);
  // In-overlay delete/leave confirmation (replaces native confirm()).
  const [leaveConfirmFor, setLeaveConfirmFor] = useState<{ partyId: string; isOwner: boolean } | null>(null);
  // Right-click context menu on a member-panel user row (promote/demote/kick).
  const [memberCtx, setMemberCtx] = useState<{ x: number; y: number; partyId: string; member: PartyMember } | null>(null);
  // Block list: set of userIds the caller has blocked (client-side filter
  // backstop; server enforcement is primary). Refreshed on block/unblock.
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  // Standalone Blocked-Users modal — opened from the overlay shell settings panel
  // (via the `fcm-open-block-manager` window event) so the block section is
  // reachable in the overlay, where the gear opens the shell panel (not the
  // React SettingsModal).
  const [blockManagerOpen, setBlockManagerOpen] = useState(false);
  // Left-click "…" overflow menu listing joined parties that didn't fit in the
  // sub-tab row. Opened from the trailing ellipsis button.
  const [partyOverflowCtx, setPartyOverflowCtx] = useState<{ x: number; right: number; y: number } | null>(null);
  // Measurement-based overflow for the joined-party sub-tab row. We measure the
  // available width of the tabs container and each tab's width (refs below),
  // then compute how many tabs fit (reserving room for the "…" button). The
  // active party is always force-included so it can never hide inside "…".
  const partyTabsRowRef = useRef<HTMLDivElement>(null);
  const partyTabRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const partyEllipsisRef = useRef<HTMLSpanElement>(null);
  const [partyVisibleIds, setPartyVisibleIds] = useState<string[]>([]);
  const [partyOverflowIds, setPartyOverflowIds] = useState<string[]>([]);
  // Measured width of the parties-list container (browser view). Drives the
  // responsive column layout — at narrow widths we progressively drop the
  // least-important stat columns (category → max → online). 0 until measured.
  const partyListRef = useRef<HTMLDivElement>(null);
  const [partyListWidth, setPartyListWidth] = useState(0);
  // Desktop-shell parity: measured geometry of the active main tab, used to draw
  // the "cutout" divider (full width except under the active tab). Updated on a
  // RAF while the shell is active so it tracks resize/relayout. (overlayShell only.)
  const activeMainTabRef = useRef<HTMLDivElement>(null);
  const tabRowRef = useRef<HTMLDivElement>(null);
  const [tabCutout, setTabCutout] = useState<{ left: number; right: number } | null>(null);
  const [muteState, setMuteState] = useState<{ until: string | null; reason: string | null; category: string | null } | null>(null);
  const [muteModalFor, setMuteModalFor] = useState<{ userId: string; username: string } | null>(null);
  const [kickModalFor, setKickModalFor] = useState<{ userId: string; username: string } | null>(null);
  const [profileModalFor, setProfileModalFor] = useState<{ userId: string; username: string } | null>(null);
  // Sticky toast shown when the user themselves was kicked or banned —
  // populated from incoming user:kicked / user:banned frames just before the
  // WS closes, so they see why before the connection drops.
  const [lastNotice, setLastNotice] = useState<{ kind: 'kicked' | 'banned'; reason: string | null; category?: string | null; until: string | null; permanent?: boolean; durationSeconds?: number } | null>(null);
  // ── Typing indicator ────────────────────────────────────────────────────────
  // Peers currently typing in the active scope. Keyed by userId; entries auto-clear
  // after 4s. Rendered IN-FLOW above the input (not overlaid) so the bottom-most
  // message stays visible above it.
  const [typingUsers, setTypingUsers] = useState<Record<string, { username: string; scopeKey: string; clearAt: number }>>({});
  const typingLastSentRef = useRef<Record<string, number>>({});
  // ── @mention: unread badges + jump-to-mention ──
  const [unreadMentions, setUnreadMentions] = useState<Record<string, number>>({});
  const myNamesRef  = useRef<string[]>([]);
  const myUserIdRef = useRef<string>('');
  const viewCtxRef  = useRef<{ activeSubId: string; feedId: string | null; feedChildIds: string[]; activePartyId: string | null }>({ activeSubId: '', feedId: null, feedChildIds: [], activePartyId: null });
  const jumpIdxRef  = useRef(0);
  // When a mention badge is clicked we switch channel first, then need to run
  // the scroll AFTER the new channel's messages have rendered. This flag tells
  // the post-render effect to fire jumpToMention once.
  const pendingJumpRef = useRef(false);
  // Track dismissed mentions by message id so each mention's button shows at
  // most once, and tab-in / visibility / channel changes don't resurrect
  // already-seen ones. Persisted in localStorage so it survives reloads.
  const dismissedMentionIdsRef = useRef<Set<string>>(new Set());
  // Bump this to force hasMentionsInView to recompute after dismissals.
  const [dismissedMentionEpoch, setDismissedMentionEpoch] = useState(0);
  // On first mount, hydrate the dismissed set from localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('fcm-dismissed-mentions');
      if (raw) dismissedMentionIdsRef.current = new Set<string>(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ns = [user?.fo76Name, user?.username, user?.discordDisplayName]
      .filter((n): n is string => !!n && n.trim().length > 1 && n !== 'Wanderer')
      .map(n => n.trim());
    myNamesRef.current  = [...new Set(ns)];
    myUserIdRef.current = user?.id || '';
  }, [user]);
  // ── Party state ──────────────────────────────────────────────────────────────
  const [partyView, setPartyView] = useState<'browser' | string>('browser');
  const [partySearch, setPartySearch] = useState('');
  const [partySort, setPartySort] = useState<'online' | 'active'>('online');
  // Multi-select category filter for the browser. Empty = show ALL categories.
  // Applied client-side (filter THEN existing search+sort pipeline) in both
  // authed and public mode.
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  // Filters popover anchor (null = closed). Opens below the FILTERS button; new
  // filter sections slot into the popover over time.
  const [filtersAnchor, setFiltersAnchor] = useState<{ top: number; right: number } | null>(null);
  const [memberPanelOpen, setMemberPanelOpen] = useState(false);
  const [memberPanelWidth, setMemberPanelWidth] = useState<number>(() => {
    try { const s = localStorage.getItem('fcm-member-panel-width'); if (s) return Math.max(80, Math.min(320, Number(s))); } catch { /* ignore */ }
    return 140;
  });
  const memberPanelDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [createPartyOpen, setCreatePartyOpen] = useState(false);
  const [partyInviteToasts, setPartyInviteToasts] = useState<PartyInvite[]>([]);
  // Transient bottom-right toast for one-off action feedback (success/error) —
  // replaces the native alert() so no OS dialog ever steals focus from the game.
  const [actionToast, setActionToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const actionToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showActionToast = useCallback((kind: 'ok' | 'err', text: string) => {
    if (actionToastTimer.current) clearTimeout(actionToastTimer.current);
    setActionToast({ kind, text });
    actionToastTimer.current = setTimeout(() => setActionToast(null), 3500);
  }, []);
  const [partiesAvailable, setPartiesAvailable] = useState<boolean | null>(null); // null = unknown
  // Image upload state (party chat only — shows "Uploading…" in the input area)
  const [imageUploading, setImageUploading] = useState(false);
  const [ctxMenuInviteSubmenu, setCtxMenuInviteSubmenu] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // Inline error banner shown in the Public Parties browser (under FILTERS, above
  // the list) when a JOIN / Accept is rejected — surfaces the backend message
  // verbatim (e.g. "Party is full", the 8-party cap). Cleared on success, on
  // switching view, and after a ~6s timeout.
  const [partyActionError, setPartyActionError] = useState<string | null>(null);
  // Inline "set member limit" editor opened from the party-tab right-click menu.
  const [partyLimitEditor, setPartyLimitEditor] = useState<{ partyId: string; x: number; y: number } | null>(null);
  // Description editor modal (owner/co-mod).
  const [partyDescriptionEditor, setPartyDescriptionEditor] = useState<{ partyId: string } | null>(null);
  // live party:member-update cache
  const [partyMemberCache, setPartyMemberCache] = useState<Record<string, PartyMember[]>>({});
  const [pmView, setPmView] = useState<'inbox' | string>('inbox');
  const [privateConversations, setPrivateConversations] = useState<PrivateConversationSummary[]>([]);
  const [privateMessages, setPrivateMessages] = useState<Record<string, ChatMessage[]>>({});
  const [pmSearch, setPmSearch] = useState('');
  const [pmSearchResults, setPmSearchResults] = useState<PrivateUserSearchResult[]>([]);
  const [pmSearchLoading, setPmSearchLoading] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  useEffect(() => { pmViewRef.current = pmView; }, [pmView]);

  useEffect(() => {
    if (isPublicMode || activeMainId !== PM_MAIN_ID || pmView !== 'inbox') {
      setPmSearchLoading(false);
      setPmSearchResults([]);
      return;
    }
    const term = pmSearch.trim();
    if (term.length < 2) {
      setPmSearchLoading(false);
      setPmSearchResults([]);
      return;
    }
    setPmSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.get<{ results: PrivateUserSearchResult[] }>(`/api/block/search?q=${encodeURIComponent(term)}`);
        setPmSearchResults((res?.results ?? []).filter(result => result.userId !== (user?.id ?? '')));
      } catch {
        setPmSearchResults([]);
      } finally {
        setPmSearchLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [pmSearch, activeMainId, pmView, isPublicMode, user?.id]);

  // Close the floating member panel when the overlay idle-collapses (the shell
  // fires `fcm-overlay-collapsed`). The panel is absolutely positioned, so left
  // open it would hang over the collapsed header strip during auto-hide. It can
  // be reopened after the user expands again. Also close ALL context menus +
  // popovers so none float over the collapsed strip (item 4b).
  useEffect(() => {
    const onCollapsed = () => {
      setMemberPanelOpen(false);
      setCtxMenu(null);
      setPartyTabCtx(null);
      setMemberCtx(null);
      setPartyOverflowCtx(null);
    };
    window.addEventListener('fcm-overlay-collapsed', onCollapsed);
    return () => window.removeEventListener('fcm-overlay-collapsed', onCollapsed);
  }, []);

  // The overlay shell settings panel dispatches `fcm-open-block-manager` when the
  // user clicks its "Blocked Users" row — open the standalone React block modal.
  useEffect(() => {
    const onOpen = () => setBlockManagerOpen(true);
    window.addEventListener('fcm-open-block-manager', onOpen);
    return () => window.removeEventListener('fcm-open-block-manager', onOpen);
  }, []);

  // Expose the computed chrome background as --fcm-chrome-bg so the collapsed-state
  // CSS in index.html can give the main tab row the same background as the sub-tab
  // row, creating a unified dark header strip instead of an inconsistent split.
  useEffect(() => {
    if (!overlayShell) return;
    document.documentElement.style.setProperty('--fcm-chrome-bg', chromeRgba);
  }, [chromeRgba, overlayShell]);

  // ── Block list (client-side filter backstop + Settings management) ──────────
  const refreshBlocked = useCallback(async () => {
    try {
      const res = await api.get<{ blocked: { userId: string }[] }>('/api/block');
      setBlockedIds(new Set((res?.blocked ?? []).map(b => b.userId)));
    } catch { /* leave existing set on failure */ }
  }, []);
  useEffect(() => { refreshBlocked(); }, [refreshBlocked]);
  const blockUser = useCallback(async (userId: string) => {
    try { await api.post('/api/block', { userId }); } catch { /* ignore */ }
    refreshBlocked();
  }, [refreshBlocked]);

  // Open the member panel automatically when the user enters a specific party view.
  useEffect(() => {
    if (!isPublicMode && partyView !== 'browser') {
      setMemberPanelOpen(true);
    }
  }, [partyView, isPublicMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear the party action-error banner when the user navigates away (view/tab
  // change) and auto-dismiss it after ~6s.
  useEffect(() => { setPartyActionError(null); }, [partyView, activeMainId]);
  useEffect(() => {
    if (!partyActionError) return;
    const t = setTimeout(() => setPartyActionError(null), 6000);
    return () => clearTimeout(t);
  }, [partyActionError]);

  // Desktop-shell parity: measure the active main tab vs its row so the divider
  // can be drawn full-width EXCEPT under the active tab (the "cutout" so the tab
  // sits ON the line). Re-measure each frame so it tracks resize. Runs on BOTH
  // the Electron shell and the website (parity) — the website now draws the same
  // bordered active main tab + cutout divider, so it needs the measurement too.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const tab = activeMainTabRef.current;
      const row = tabRowRef.current;
      if (tab && row) {
        // Measure in LAYOUT px via offsetLeft/offsetWidth, NOT getBoundingClientRect.
        // The shell scales #root with CSS `zoom`; on Electron 39 (Chromium 138)
        // getBoundingClientRect returns zoom-SCALED px, but the cutout divider's
        // left/width below are plain CSS (layout) px inside the same zoomed subtree.
        // Using rect deltas therefore over-scaled the cutout by the zoom factor —
        // the left segment bled into the active tab and the right segment left a gap
        // (visible after the 1.3.88 Electron 31->39 bump). offsetLeft/offsetWidth are
        // always layout px relative to the positioned row, matching the divider.
        const { left, right } = computeMainTabCutout(tab.offsetLeft, tab.offsetWidth);
        setTabCutout(prev =>
          prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.right - right) < 0.5
            ? prev : { left, right });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const partyMeasureRowRef = useRef<HTMLDivElement>(null);

  // ── Picker state ──────────────────────────────────────────────────────────
  const [openPicker, setOpenPicker] = useState<'emoji' | 'gif' | null>(null);

  // Hold the idle auto-collapse while ANY modal / popover / context menu is open
  // (item 4a). The shell's tickIdle() checks window.__fcmMenuOpen and resets its
  // idle timer when true, so the overlay never auto-hides while the user is
  // interacting with a modal. This is the SINGLE source of truth for the flag —
  // it enumerates every transient overlay UI surface, so the flag is true
  // whenever ANY of them is open and false only when none are. (Child modal
  // components must NOT also poke the flag, or they'd clobber this on unmount.)
  // Declared after all modal-state hooks so none hit the const TDZ.
  const anyOverlayUiOpen = !!(
    ctxMenu || partyTabCtx || memberCtx || partyOverflowCtx || partyDescriptionEditor ||
    inviteModalFor || muteModalFor || kickModalFor || profileModalFor ||
    modModal || leaveConfirmFor || partyLimitEditor ||
    createPartyOpen || settingsOpen || blockManagerOpen ||
    openPicker || lastNotice
  );
  useEffect(() => {
    try { (window as unknown as { __fcmMenuOpen?: boolean }).__fcmMenuOpen = anyOverlayUiOpen; }
    catch { /* non-fatal */ }
    return () => {
      try { (window as unknown as { __fcmMenuOpen?: boolean }).__fcmMenuOpen = false; } catch { /* non-fatal */ }
    };
  }, [anyOverlayUiOpen]);
  const emojiTriggerRef = useRef<HTMLSpanElement>(null);
  const gifTriggerRef = useRef<HTMLSpanElement>(null);
  // Emoji/GIF pickers are a fixed 340×360. We anchor them by viewport-edge
  // distance (bottom/right) so they grow up-and-left from the trigger, plus a
  // maxHeight so a picker taller than the available space caps and scrolls
  // internally instead of being clipped off the top of the window.
  const [pickerAnchor, setPickerAnchor] = useState<{ bottom: number; right: number; maxHeight: number; maxWidth: number } | null>(null);

  // The picker uses position:fixed (to escape overflow:hidden) anchored to the
  // trigger. Re-measure every frame while open so the picker FOLLOWS the overlay
  // if it moves/resizes/scrolls — otherwise it stays at its open-time coords.
  useEffect(() => {
    if (!openPicker) return;
    const PICKER_W = 340, PICKER_H = 360, GAP = 8;
    let raf = 0;
    const tick = () => {
      // Use whichever trigger is active: emoji or gif.
      const triggerEl = openPicker === 'gif' ? gifTriggerRef.current : emojiTriggerRef.current;
      const rect = triggerEl?.getBoundingClientRect();
      if (rect) {
        const next = computePickerAnchor(rect, PICKER_W, PICKER_H, GAP);
        setPickerAnchor(prev =>
          prev && Math.abs(prev.bottom - next.bottom) < 0.5
            && Math.abs(prev.right - next.right) < 0.5
            && Math.abs(prev.maxHeight - next.maxHeight) < 0.5
            && Math.abs(prev.maxWidth - next.maxWidth) < 0.5
            ? prev : next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [openPicker]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Picker placement (zoom-robust) ─────────────────────────────────────────
  // The fixed-position style applied to the emoji/GIF picker. `pickerAnchor` holds
  // viewport-edge distances measured from the trigger's getBoundingClientRect().
  const pickerStyle: React.CSSProperties | undefined = pickerAnchor ? {
    position: 'fixed',
    bottom: pickerAnchor.bottom,
    right: pickerAnchor.right,
    top: 'auto',
    left: 'auto',
    height: 'auto',
    maxHeight: pickerAnchor.maxHeight,
    // Width cap: shrink below the picker's natural 340 when the window is narrower
    // so it never runs off-screen; contents reflow + scroll internally.
    width: pickerAnchor.maxWidth,
    maxWidth: pickerAnchor.maxWidth,
  } : undefined;

  // In the Electron overlay shell, the whole overlay (#root) is scaled with CSS
  // `zoom` when the user picks a non-default font size (shell.ts applyScale). CSS
  // `zoom` rescales `position: fixed` offsets of DESCENDANT elements in Chromium —
  // so a picker rendered inside the zoomed #root lands in the wrong place (the
  // user's "opens in the middle" report at fontSize 16). Rendering the picker
  // through a portal to <body> (OUTSIDE the zoomed subtree) makes its position:fixed
  // resolve against the true viewport, with NO zoom rescaling — correct at every
  // scale. On the website overlayShell is null, so the picker renders inline exactly
  // as before (no behavioural change).
  // Wrap the portaled picker in a marker element so the shell's auto-click-through
  // handler (shell.ts) recognises hovering it as "over interactive UI" — otherwise
  // the picker, now a child of <body> rather than #shell-overlay-host, would be
  // treated as empty space and clicks would pass through to the game behind.
  const renderPicker = (node: React.ReactNode): React.ReactNode =>
    overlayShell
      ? createPortal(<div id="fcm-picker-portal">{node}</div>, document.body)
      : node;

  // DEV-ONLY (overlayShell only): expose picker openers that drive the REAL React
  // state setters, because a synthetic dispatchEvent(MouseEvent('mousedown')) does
  // NOT reliably trigger React's onMouseDown in this renderer. Used by the
  // screenshot harness to open the picker for visual verification. Never present
  // on the website (overlayShell is null there).
  useEffect(() => {
    if (!overlayShell) return;
    const openWith = (kind: 'emoji' | 'gif') => {
      const triggerEl = kind === 'gif' ? gifTriggerRef.current : emojiTriggerRef.current;
      const rect = triggerEl?.getBoundingClientRect();
      if (rect) setPickerAnchor(computePickerAnchor(rect, 340, 360, 8));
      setOpenPicker(kind);
    };
    (window as unknown as { __ovChatTest?: unknown }).__ovChatTest = {
      openEmoji: () => openWith('emoji'),
      openGif: () => openWith('gif'),
      closePicker: () => setOpenPicker(null),
    };
  }, [overlayShell]);

  const [copyFlash, setCopyFlash] = useState<string | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const copyToClipboard = useCallback((text: string, label: string) => {
    const attempt = navigator.clipboard?.writeText(text);
    if (attempt) {
      attempt.then(() => {
        setCopyFlash(label);
        setTimeout(() => setCopyFlash(null), 1200);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopyFlash(label);
        setTimeout(() => setCopyFlash(null), 1200);
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopyFlash(label);
      setTimeout(() => setCopyFlash(null), 1200);
    }
  }, []);
  const [serverMembers, setServerMembers] = useState<ServerMember[]>([]);
  const [totalChatMod, setTotalChatMod] = useState<number>(0);
  const [allPlayers, setAllPlayers] = useState<string[] | null>(null);

  // ── Slash-command autocomplete state ──────────────────────────────────────
  const [acOpen, setAcOpen] = useState(false);
  const [acIndex, setAcIndex] = useState(0);

  // ── CAMP item autocomplete state ──────────────────────────────────────────
  // Activates when inputText starts with '/camp ' + 2+ chars. Mutually exclusive
  // with wiki and slash-command autocompletes.
  const [campAcItems, setCampAcItems] = useState<{ name: string; category: string; subCategory: string; imageUrl: string | null }[]>([]);
  const [campAcOpen, setCampAcOpen] = useState(false);
  const [campAcLoading, setCampAcLoading] = useState(false);
  const [campAcIndex, setCampAcIndex] = useState(0);
  // campAcAbortRef / campAcDebounceRef removed — managed inside useDebouncedSearch

  // ── Chat lightbox (camp card image zoom) ─────────────────────────────────
  const [chatLightboxSrc, setChatLightboxSrc] = useState<string | null>(null);

  // ── Wiki panel + autocomplete state ──────────────────────────────────────
  // Separate from the slash-command autocomplete — mutually exclusive, never merged.
  const [wikiPanelOpen, setWikiPanelOpen] = useState(false);
  const [wikiPanelTerm, setWikiPanelTerm] = useState('');
  // true when the panel was opened via a wiki-share embed click (exact wikiTitle,
  // no fuzzy-search fallback). Reset to false for /wiki command-driven opens.
  const [wikiPanelExact, setWikiPanelExact] = useState(false);
  const [wikiAcItems, setWikiAcItems] = useState<WikiSearchResult[]>([]);
  const [wikiAcOpen, setWikiAcOpen] = useState(false);
  const [wikiAcLoading, setWikiAcLoading] = useState(false);
  const [wikiAcIndex, setWikiAcIndex] = useState(0);
  // wikiAcAbortRef / wikiAcDebounceRef removed — managed inside useDebouncedSearch

  // ── @ mention autocomplete state ──────────────────────────────────────────
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionSuggestions, setMentionSuggestions] = useState<{ displayName: string; discordId: string | null }[]>([]);
  // {name, discordId} pairs the user picked from autocomplete; shipped with
  // chat:send so the Discord relay can map @name → <@discordId> precisely.
  const pendingMentionsRef = useRef<{ name: string; discordId: string }[]>([]);
  const [mentionMeta, setMentionMeta] = useState<{ query: string; atStart: number } | null>(null);
  const mentionDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Display-name override map: userId → resolved displayName.
  // Populated from user:identity_updated frames (same pattern as desktop
  // _knownDisplayNames dictionary). Used to correct history messages that
  // carried a stale or login-only username (e.g. "devotek" → "Devotek")
  // and to re-resolve names when the backend broadcasts a fresh identity.
  const knownDisplayNames = useRef<Map<string, string>>(new Map());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContRef = useRef<HTMLDivElement>(null);
  // On the WEBSITE (not the Electron overlay) force a single scroll-to-bottom the
  // first time messages populate, so opening the page lands you at the latest
  // message. The in-game overlay (overlayShell) deliberately does NOT auto-jump.
  const didInitialScrollRef = useRef(false);
  // #313: Tracks whether the user is currently pinned to the bottom of the feed,
  // sampled from real scroll events (see isNearBottom). The auto-scroll effect
  // reads THIS — the user's actual intent — instead of re-measuring distance
  // after a (possibly tall) message has already been appended, which corrupts
  // the reading. Defaults true so a fresh feed pins to the latest message.
  const stickToBottomRef = useRef(true);
  // Timer used to debounce the initial cold-start scroll-to-bottom (Fix 2).
  // We reset the timer on each incoming messages batch during the initial-load
  // window and only fire scrollToBottom() once the feed has quieted for ~220ms.
  const initialScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── Lazy-load (top-scroll older history) state ───────────────────────────
  // We keep a generous global message cap so lazy-loaded older batches survive
  // a subsequent live append (the old -500 cap would trim them off the top).
  // Per-channel: how many rows we've loaded (drives the next fetch offset), and
  // which channels have reached the end of history (a batch < INITIAL_LIMIT).
  const lazyLoadedCountRef = useRef<Map<string, number>>(new Map());
  const lazyEndReachedRef = useRef<Set<string>>(new Set());
  // True while a top-scroll fetch is in flight — blocks overlapping fetches AND
  // tells the chat:history handler to PREPEND + preserve scroll instead of the
  // normal "merge + maybe pin to bottom" path.
  const lazyLoadingRef = useRef(false);
  // The channel a lazy fetch is currently in flight for (history frames for the
  // normal UUID path don't echo channelId, so we match on this + the rows).
  const pendingLazyChannelRef = useRef<string | null>(null);
  // scrollHeight captured immediately before a lazy prepend, so we can restore
  // scrollTop afterward and keep the viewport from jumping.
  const lazyScrollAnchorRef = useRef<number>(0);
  // Tracks which channelIds have already received a successful chat:history burst
  // this session. On WS reconnect (hide→show, network blip) we skip re-requesting
  // history for channels that already have data — preventing the visible "reload"
  // flash every time the overlay is toggled. Reset only on genuine identity changes
  // (mountKey bump / component remount) or explicit refresh (header refresh button).
  const historyLoadedChsRef = useRef<Set<string>>(new Set());
  // Mirror of wsGameActive for the visibility handler (reads current value without
  // re-subscribing). Used to decide whether becoming-visible must force a reconnect.
  const wsGameActiveRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Offline outbox: queues chat:send frames while the WS is down, flushed on reconnect.
  // Inert in public mode (sendOrQueueChat gates on isPublicMode before enqueuing).
  const outboxRef = useRef<OutboxQueue>(new OutboxQueue());
  const [outboxCount, setOutboxCount] = useState(0);
  // In-game state from the Electron shell (Fallout 76 process running = true).
  // Undefined on the website (no relayBridge.onGameState) → treated as false.
  const inGameRef = useRef<boolean>(false);
  // Client-side message-ID dedup ring (~1000 entries). Backend may emit the same
  // chat:message more than once when the user has multiple WS sockets. Cap is 1000
  // so a burst on reconnect can't evict an id and allow a duplicate render.
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const seenMessageIdQueueRef = useRef<string[]>([]);
  // Live giveaway state keyed by giveawayId — updated via giveaway:update WS events.
  // useRef avoids re-renders on every entry; card re-renders on setMessages trigger.
  const giveawayLiveStateRef = useRef<Map<string, { entryCount: number; status: string; winnerName?: string | null }>>(new Map());
  // Whether any giveaway is currently active — drives the ★ indicator on the Events tab.
  const [giveawayActive, setGiveawayActive] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Rich (contentEditable) input ref — used only when overlayShell is active.
  const richInputRef = useRef<HTMLDivElement>(null);
  const richSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  // One-shot flag: when an external setInputText should land the caret at the END
  // (slash-command autocomplete) rather than restoring the saved offset. Consumed
  // and cleared by the rich-input sync effect on the next run.
  const caretToEndRef = useRef<boolean>(false);
  // Tracks whether the chat input had focus immediately before a state update
  // (e.g. chat:history repopulation) so we can restore it afterward.
  const inputWasFocusedRef = useRef<boolean>(false);
  const insertAtCaret = usePickerInsert(inputRef, inputText, setInputText);

  // ── Rich-input helpers (overlay-only contentEditable input) ──────────────
  // Serialize a contentEditable div's DOM back to a plain-text string where
  // custom emoji <img data-token="<:name:id>"> nodes become their token and
  // everything else is plain text. Preserves newlines from <br>/<div>.
  const serializeRichInput = useCallback((el: HTMLDivElement): string => {
    return serializeRichContent(el);
  }, []);

  const syncRichSelectionRef = useCallback((el: HTMLDivElement) => {
    const offsets = getRichSelectionOffsets(el);
    if (offsets) {
      richSelectionRef.current = offsets;
      return offsets;
    }
    const end = serializeRichInput(el).length;
    const fallback = { start: end, end };
    richSelectionRef.current = fallback;
    return fallback;
  }, [serializeRichInput]);

  // Stable callback wrapper over the top-level, unit-tested buildRichHtmlImpl
  // (which owns all HTML escaping/sanitization for the rich input). Kept as a
  // useCallback so the effect/handler dependency arrays below stay stable.
  const buildRichHtml = useCallback((text: string): string => buildRichHtmlImpl(text), []);

  // Insert a token (unicode char or <:name:id>) at the current caret position
  // in the contentEditable div, then update inputText state.
  const richInsertAtCaret = useCallback((token: string) => {
    const el = richInputRef.current;
    if (!el) { insertAtCaret(token); return; } // fallback to textarea
    const current = serializeRichInput(el);
    const liveSelection = getRichSelectionOffsets(el);
    const fallbackSelection = richSelectionRef.current;
    const next = insertTokenIntoText(
      current,
      liveSelection?.start ?? fallbackSelection.start,
      liveSelection?.end ?? fallbackSelection.end,
      token,
      255,
    );

    // Rebuild from the canonical plain-text model immediately so rapid picker
    // clicks reuse the advanced caret and the composer keeps emoji inline.
    el.innerHTML = buildRichHtml(next.text);
    el.focus();
    placeRichCaretAtOffset(el, next.caretOffset);
    richSelectionRef.current = { start: next.caretOffset, end: next.caretOffset };
    setInputText(next.text);
  }, [setInputText, buildRichHtml, serializeRichInput, insertAtCaret]);

  // Sync the rich input's HTML to the current inputText whenever it changes
  // from OUTSIDE (e.g. slash-command autocomplete sets inputText directly,
  // emoji insert, clear-on-send). We only overwrite if the serialized content
  // differs to avoid caret jumps.
  //
  // [inputText] dep array is intentional: running on every render caused caret
  // resets mid-keystroke (chars prepended/reordered). The guard (serialize !==
  // inputText) means normal typing — where onInput already called setInputText —
  // produces no DOM rewrite. Only genuine external sets (autocomplete, emoji,
  // clear-on-send) trigger a rewrite. On rewrite, the caret offset is saved and
  // restored (clamped) rather than unconditionally collapsing to end.
  useEffect(() => {
    const el = richInputRef.current;
    if (!el || !overlayShell) return;
    const current = serializeRichInput(el);
    if (current === inputText) return; // DOM already matches — nothing to do

    const savedOffset = getRichSelectionOffsets(el)?.start ?? richSelectionRef.current.start;
    // Consume the one-shot "caret to end" flag (set by slash-command autocomplete).
    const forceToEnd = caretToEndRef.current;
    caretToEndRef.current = false;

    el.innerHTML = buildRichHtml(inputText);

    // Restore caret (or, for command completions, collapse to end) after the
    // programmatic set.
    requestAnimationFrame(() => {
      const target = richInputRef.current;
      if (!target) return;
      const caretOffset = resolveExternalSetCaret(inputText.length, savedOffset, forceToEnd);
      placeRichCaretAtOffset(target, caretOffset);
      richSelectionRef.current = { start: caretOffset, end: caretOffset };
    });
  }, [inputText]); // eslint-disable-line react-hooks/exhaustive-deps
  // ^^ Intentionally omitting buildRichHtml/serializeRichInput/overlayShell —
  // they are stable (useCallback/useMemo or module-level), and including them
  // would widen the dep array without benefit. If they ever become unstable,
  // wrap them with useCallback/useMemo before adding here.

  const activeSubIdRef = useRef(activeSubId);
  const partyViewRef = useRef<string>('browser');
  const pmViewRef = useRef<'inbox' | string>('inbox');
  // Track which party histories have been requested this WS session to avoid duplicate sends.
  const requestedPartyHistoriesRef = useRef<Set<string>>(new Set());
  const allChannelsRef = useRef<Channel[]>([]);
  const refetchChannelsRef = useRef<(() => void) | null>(null);
  const presenceRefetchRef = useRef<(() => void) | null>(null);
  const prevServerTabIdRef = useRef<string | null>(null);
  const channelsHaveLoadedRef = useRef(false);

  // Auto-grow textarea
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = '18px';
    ta.style.height = Math.min(ta.scrollHeight, 90) + 'px';
  }, [inputText]);

  // Fetch hierarchical channels
  const { data: channelsRaw, refetch: refetchChannels } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<Channel[]>('/api/channels').then(d => d ?? []),
  });
  useEffect(() => { refetchChannelsRef.current = () => refetchChannels(); }, [refetchChannels]);

  // Live app version — the LATEST published release from GET /api/version, NOT the
  // build-time __APP_VERSION__ define (which freezes at dev-server start). On the
  // website overlayShell is null → relative '/api/version'; in the Electron overlay
  // a relative fetch won't resolve, so prefix the relay HTTP base (same base used
  // for avatars). Falls back to the build-time constant if the fetch fails.
  const { data: liveVersion } = useQuery({
    queryKey: ['app-version'],
    queryFn: async () => {
      const relayBase = getOverlayShell()?.relayBase;
      const base = relayBase ? relayBase.replace(/\/$/, '') : '';
      const res = await fetch(`${base}/api/version`);
      if (!res.ok) throw new Error(`version ${res.status}`);
      const json = await res.json();
      const v = json?.data?.version;
      // Reject the backend's "no release yet" placeholder (e.g. "—") — anything
      // without a digit isn't a real version, so fall back to the build version.
      if (typeof v !== 'string' || !/\d/.test(v)) throw new Error('no version');
      return v;
    },
    staleTime: 60_000,
  });
  // Electron overlay only: the REAL running app version + relay host, from the
  // shell bridge (getInfo). We prefer the actual running version over the
  // latest-PUBLISHED liveVersion so the footer reflects what the user is running
  // — a dev/QA build shows e.g. "1.3.91-dev", not the newest release on the
  // relay. The website (no shell) keeps liveVersion (the latest available).
  const [shellInfo, setShellInfo] = useState<{ appVersion?: string; relayHost?: string } | null>(null);
  const displayVersion = (overlayShell && shellInfo?.appVersion) || liveVersion || __APP_VERSION__;
  // Mirror displayVersion into a ref so the long-lived WS message handler (whose
  // effect deps are [wsGate, wsReconnectTick]) always compares against the CURRENT
  // installed/displayed version — not the value captured when the socket connected
  // (displayVersion arrives async from the shell bridge / GET /api/version).
  const displayVersionRef = useRef(displayVersion);
  useEffect(() => { displayVersionRef.current = displayVersion; }, [displayVersion]);
  const [updateAvailableVersion, setUpdateAvailableVersion] = useState<string | null>(null);
  // DEV indicator: website dev-server (localhost) OR overlay on a non-prod relay.
  const isDevEnv = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
    || (!!overlayShell && !!shellInfo?.relayHost && !isProdRelayHost(shellInfo.relayHost));

  // ── Live keybinds (Electron overlay only) ─────────────────────────────────
  // The shell registers global hotkeys and pushes the live map here so the footer
  // help text shows the user's ACTUAL bound keys (and updates when they rebind).
  const [shellKeybinds, setShellKeybinds] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!overlayShell) return;
    const bridge = (window as any).relayBridge;
    bridge?.getInfo?.().then((info: any) => {
      if (info?.keybinds) setShellKeybinds(info.keybinds);
      setShellInfo({ appVersion: info?.appVersion, relayHost: info?.relayHost });
    }).catch(() => {});
    return bridge?.onKeybinds?.((kb: Record<string, string>) => setShellKeybinds(kb));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The party that most recently posted into the General/combined feed — target
  // of the /r command and the "recent party" keybind. Scans newest→oldest.
  const recentPartyId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.source === 'party' && m.channelId) return m.channelId;
    }
    return null;
  }, [messages]);
  // Ref mirror so the (once-registered) keybind listener always reads the latest.
  const recentPartyIdRef = useRef<string | null>(null);
  useEffect(() => { recentPartyIdRef.current = recentPartyId; }, [recentPartyId]);
  const jumpToRecentParty = useCallback(() => {
    const pid = recentPartyIdRef.current;
    if (!pid) { showActionToast('err', 'No recent party activity'); return; }
    setActiveMainId(PARTY_MAIN_ID);
    setPartyView(pid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // "Recent party" keybind → main sends 'party:recent' → shell dispatches this.
  useEffect(() => {
    if (!overlayShell) return;
    const h = () => jumpToRecentParty();
    window.addEventListener('fcm-recent-party', h);
    return () => window.removeEventListener('fcm-recent-party', h);
  }, [jumpToRecentParty]);

  // Ref mirrors for values that the once-registered onCommand handler needs to read fresh.
  // joinedParties and fo76Subs change as parties/channels load; storing in refs avoids
  // re-registering the IPC listener on every render.
  // (activeSubIdRef already exists for other purposes and is kept in sync at line ~2672.)
  const joinedPartiesRef = useRef<Party[]>([]);
  const fo76SubsRef     = useRef<SubChannel[]>([]);
  const fo76MainIdRef   = useRef<string | null>(null);
  const activeMainIdRef = useRef<string>('');

  // ── Overlay command handler (Electron shell only) ────────────────────────────
  // Registered once on mount; reads fresh state via refs. Handles:
  //   channel:next / channel:prev  — unified cycle: FO76 subs (General…Raids) then
  //                                   joined parties left-to-right, wrapping both ways.
  //   tab:fo76                     — switch to the FO76 main tab (General sub) + focus input.
  //   party:index:N (1-based)      — switch to the Nth joined party; no-op if < N joined.
  //   party:recent / settings:open — delegated to existing shell.ts handlers via DOM events.
  useEffect(() => {
    if (!overlayShell) return;
    const bridge = (window as any).relayBridge;
    if (!bridge?.onCommand) return;

    return bridge.onCommand((cmd: string) => {
      // tab:fo76 — jump to FO76 main tab, land on General sub. Does NOT focus the
      // input: the `/` keybind only switches tabs and leaves keyboard focus with
      // the game. The user presses Insert (focus-to-chat) when they want to type.
      if (cmd === 'tab:fo76') {
        const fo76 = fo76SubsRef.current;
        const general = fo76.find(s => s.name?.toLowerCase() === 'general') ?? fo76[0];
        const mainId = general?.parentId ?? fo76MainIdRef.current;
        if (mainId) setActiveMainId(mainId);
        if (general) setActiveSubId(general.id);
        return;
      }

      // party:index:N — switch to the Nth joined party (1-based).
      const partyIdxMatch = cmd.match(/^party:index:(\d+)$/);
      if (partyIdxMatch) {
        const idx = parseInt(partyIdxMatch[1], 10) - 1;
        const party = joinedPartiesRef.current[idx];
        if (!party) return; // no-op: fewer than N parties joined
        setActiveMainId(PARTY_MAIN_ID);
        setPartyView(party.id);
        return;
      }

      // channel:next / channel:prev — unified cycle across FO76 subs + joined parties.
      if (cmd === 'channel:next' || cmd === 'channel:prev') {
        const dir = cmd === 'channel:next' ? 1 : -1;
        const fo76Subs    = fo76SubsRef.current;
        const joined      = joinedPartiesRef.current;
        const curMainId   = activeMainIdRef.current;
        const curSubId    = activeSubIdRef.current;
        const curPartyView = partyViewRef.current;

        // Build the unified ordered list: [fo76sub0, fo76sub1, ..., party0, party1, ...]
        // FO76 items: identified by sub-channel id. Party items: identified by party id.
        type NavSlot = { kind: 'sub'; id: string; parentId: string } | { kind: 'party'; id: string };
        const slots: NavSlot[] = [
          ...fo76Subs.map(s => ({ kind: 'sub' as const, id: s.id, parentId: s.parentId ?? '' })),
          ...joined.map(p => ({ kind: 'party' as const, id: p.id })),
        ];
        if (slots.length === 0) return;

        // Find current position.
        let curIdx = -1;
        if (curMainId === PARTY_MAIN_ID && curPartyView !== 'browser') {
          curIdx = slots.findIndex(s => s.kind === 'party' && s.id === curPartyView);
        } else {
          curIdx = slots.findIndex(s => s.kind === 'sub' && s.id === curSubId);
        }
        if (curIdx < 0) curIdx = 0; // fallback: start from first slot

        const nextIdx = (curIdx + dir + slots.length) % slots.length;
        const next = slots[nextIdx];
        if (next.kind === 'party') {
          setActiveMainId(PARTY_MAIN_ID);
          setPartyView(next.id);
        } else {
          setActiveMainId(next.parentId);
          setActiveSubId(next.id);
        }
        // NOTE: shell.ts's navChannel also fires for channel:next/prev and may click a
        // DOM sub-tab span. When navigating into a party slot the shell finds no matching
        // SUBTAB_NAMES span and is a no-op. When navigating within FO76 subs the shell
        // clicks the same sub we just set via setState — harmless redundancy.
        return;
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — registered once on mount; reads via refs

  // Auto-switch on server-tab appear/disappear
  useEffect(() => {
    if (!channelsRaw) return;
    const allSubs = channelsRaw.flatMap(c => c.children || []);
    const serverTab = allSubs.find(c => c.id.startsWith('server:')) ?? null;
    const prevId = prevServerTabIdRef.current;
    const wasLoaded = channelsHaveLoadedRef.current;
    prevServerTabIdRef.current = serverTab?.id ?? null;
    channelsHaveLoadedRef.current = true;

    if (!serverTab && activeSubIdRef.current.startsWith('server:')) {
      // Server tab gone — switch to General sub or first available sub
      const generalSub = allSubs.find(c => c.name?.toLowerCase() === 'general') ?? allSubs[0];
      if (generalSub) {
        setActiveSubId(generalSub.id);
      } else if (channelsRaw[0]) {
        const subs = channelsRaw[0].children || [];
        setActiveSubId(subs[0]?.id ?? channelsRaw[0].id);
      }
    } else if (serverTab && !prevId && activeSubIdRef.current && wasLoaded) {
      // Server tab newly appeared — auto-switch to it.
      // Guard on wasLoaded so cold-open always starts on General even when
      // the user is already in-game at page load.
      const parent = channelsRaw.find(c => (c.children || []).some(s => s.id === serverTab.id));
      if (parent) setActiveMainId(parent.id);
      setActiveSubId(serverTab.id);
    }
  }, [channelsRaw]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOnServerChannel = activeSubId.startsWith('server:');
  const adminFeedActive = isAdmin && isOnServerChannel;

  const { data: feedData } = useQuery({
    queryKey: ['server-feed'],
    queryFn: () => api.get<ServerFeedMessage[]>('/api/presence/server-messages?limit=100'),
    enabled: adminFeedActive,
  });
  useEffect(() => { if (feedData) setFeedMessages(feedData); }, [feedData]);

  const { data: membersData, refetch: refetchMembers } = useQuery({
    queryKey: ['same-server-members'],
    queryFn: () => api.get<{ serverEndpoint: string | null; users: ServerMember[]; totalChatMod: number; allPlayers: string[] | null }>('/api/presence/same-server'),
    enabled: isOnServerChannel,
    refetchInterval: isOnServerChannel ? 10_000 : false,
  });
  useEffect(() => { presenceRefetchRef.current = () => refetchMembers(); }, [refetchMembers]);
  useEffect(() => {
    if (membersData) {
      setServerMembers(membersData.users || []);
      setTotalChatMod(membersData.totalChatMod ?? membersData.users?.length ?? 0);
      setAllPlayers(membersData.allPlayers ?? null);
    } else if (!isOnServerChannel) {
      setServerMembers([]);
      setTotalChatMod(0);
      setAllPlayers(null);
    }
  }, [membersData, isOnServerChannel]);

  // ── Party queries ────────────────────────────────────────────────────────────
  const isOnPartyTab = activeMainId === PARTY_MAIN_ID;
  const [debouncedPartySearch, setDebouncedPartySearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPartySearch(partySearch), 300);
    return () => clearTimeout(t);
  }, [partySearch]);

  const { data: partiesData, refetch: refetchParties } = useQuery({
    queryKey: ['parties', debouncedPartySearch, partySort, isPublicMode],
    queryFn: () => (
      // Public (logged-out) visitors have no auth token — hit the public,
      // read-only endpoint that returns ONLY public parties via a plain fetch
      // (api.get would attach/expect auth). Auth users use the full endpoint.
      isPublicMode
        ? fetch(`/api/parties/public?search=${encodeURIComponent(debouncedPartySearch)}`)
            .then(r => r.json())
            .then(j => (j?.data ?? j) as { parties: Party[] })
        : api.get<{ parties: Party[] }>(
            `/api/parties?search=${encodeURIComponent(debouncedPartySearch)}&sort=${partySort}`
          )
    ).then(d => {
      // Treat ANYTHING that isn't a well-formed { parties: [...] } payload as
      // "parties unavailable". The dev overlay points at the PROD backend,
      // where /api/parties may not exist yet — instead of a clean 404 it can
      // return 401 (requireClientAuth), an HTML error page (non-JSON), or a
      // 200 with the wrong shape. Only a real parties array flips the feature ON.
      if (!d || !Array.isArray((d as any).parties)) {
        setPartiesAvailable(false);
        return null;
      }
      setPartiesAvailable(true);
      return d;
    }).catch(() => {
      // Any failure — 401/403/404/parse error/network — means the feature is
      // not usable against this backend. Hide the tab rather than leave it
      // clickable (and crash-prone) against a backend that lacks the endpoint.
      setPartiesAvailable(false);
      return null;
    }),
    enabled: isOnPartyTab || partiesAvailable === null,
    staleTime: 10_000,
    retry: false,
  });

  const { data: partyInvitesData, refetch: refetchPartyInvites } = useQuery({
    queryKey: ['party-invites'],
    // Swallow any error (401/non-JSON/etc.) — invites are non-critical and the
    // endpoint may not exist against the PROD backend the dev overlay targets.
    queryFn: () => api.get<{ invites: PartyInvite[] }>('/api/parties/invites')
      .then(d => (d && Array.isArray((d as any).invites) ? d : { invites: [] }))
      .catch(() => ({ invites: [] as PartyInvite[] })),
    // Public visitors have no auth token / no invites — never poll this.
    enabled: !isPublicMode && partiesAvailable !== false,
    refetchInterval: 30_000,
    retry: false,
  });

  const activePartyId = isOnPartyTab && partyView !== 'browser' ? partyView : null;
  const { data: partyMembersData } = useQuery({
    queryKey: ['party-members', activePartyId],
    queryFn: () => api.get<{ members: PartyMember[] }>(`/api/parties/${activePartyId}/members`),
    // Member list is membership data — not exposed publicly. Auth only.
    enabled: !isPublicMode && !!activePartyId && memberPanelOpen,
    staleTime: 10_000,
  });

  // Merge HTTP + live-WS member cache; apply the client-side block filter
  // backstop (hide blocked users, but never yourself).
  const activePartyMembers: PartyMember[] = useMemo(() => {
    if (!activePartyId) return [];
    const live = partyMemberCache[activePartyId];
    const base = live ?? partyMembersData?.members ?? [];
    return base.filter(m => m.userId === (user?.id ?? '') || !blockedIds.has(m.userId));
  }, [activePartyId, partyMemberCache, partyMembersData, blockedIds, user?.id]);

  const parties: Party[] = useMemo(() => partiesData?.parties ?? [], [partiesData]);
  // Apply the category filter to the BROWSER list only. Search + sort already
  // run server-side (authed) / search server-side (public); this layers the
  // multi-select category filter on top. Empty selection = show all.
  const displayedParties: Party[] = useMemo(() => {
    if (categoryFilter.length === 0) return parties;
    const set = new Set(categoryFilter);
    return parties.filter(p => set.has(p.category ?? ''));
  }, [parties, categoryFilter]);
  const joinedParties = parties.filter(p => p.isMember);
  const pendingInvites = partyInvitesData?.invites ?? [];
  const pendingInviteCount = pendingInvites.length;

  // Stable, comma-joined list of PUBLIC party IDs — drives the public-mode
  // party-message poll without re-running the effect on every array identity
  // change. (In public mode every listed party is public, but filter anyway.)
  const publicPartyIdKey = useMemo(
    () => parties.filter(p => !p.isPrivate).map(p => p.id).sort().join(','),
    [parties],
  );

  // ── Joined-party sub-tab overflow measurement ──────────────────────────────
  // The joined-party tabs live in a `flex:1, minWidth:0` container that would
  // otherwise just clip extra tabs. We measure the container's available width
  // and each tab's natural width (from a hidden measurement row that always
  // renders ALL tabs), then compute how many fit — reserving room for the "…"
  // overflow button. The ACTIVE party is force-included so it never hides inside
  // "…". Re-runs when the joined set, active party, or container size changes
  // (ResizeObserver), so it tracks overlay resize + CSS-zoom relayout.
  const joinedPartyKey = joinedParties.map(p => p.id).join(',');
  React.useLayoutEffect(() => {
    if (!isOnPartyTab) return;
    const container = partyTabsRowRef.current;
    const measureRow = partyMeasureRowRef.current;
    if (!container || !measureRow) return;

    const recompute = () => {
      const ids = joinedParties.map(p => p.id);
      if (ids.length === 0) { setPartyVisibleIds([]); setPartyOverflowIds([]); return; }

      const containerW = container.getBoundingClientRect().width;
      // Per-tab natural widths, measured from the hidden full-render row.
      const widths = new Map<string, number>();
      for (const id of ids) {
        const el = partyTabRefs.current.get(id);
        if (el) widths.set(id, el.getBoundingClientRect().width);
      }
      const ellipsisW = (partyEllipsisRef.current?.getBoundingClientRect().width ?? 28) + 4;

      // First pass: does everything fit with NO ellipsis?
      const totalW = ids.reduce((s, id) => s + (widths.get(id) ?? 0), 0);
      if (totalW <= containerW + 0.5) {
        setPartyVisibleIds(ids);
        setPartyOverflowIds([]);
        return;
      }

      // Overflow: reserve room for the "…" button. The active party is always
      // visible; reserve its width first, then fill the rest in original order.
      const activeId = (typeof partyView === 'string' && partyView !== 'browser'
        && ids.includes(partyView)) ? partyView : null;
      let budget = containerW - ellipsisW;
      const visible: string[] = [];
      if (activeId) {
        budget -= (widths.get(activeId) ?? 0);
        visible.push(activeId);
      }
      for (const id of ids) {
        if (id === activeId) continue;
        const w = widths.get(id) ?? 0;
        if (w <= budget) { budget -= w; visible.push(id); }
        else break; // stop at first non-fit so order stays contiguous
      }
      // Preserve original tab order for the visible set.
      const visibleSet = new Set(visible);
      const orderedVisible = ids.filter(id => visibleSet.has(id));
      const overflow = ids.filter(id => !visibleSet.has(id));
      setPartyVisibleIds(orderedVisible);
      setPartyOverflowIds(overflow);
    };

    recompute();
    const ro = new ResizeObserver(() => recompute());
    ro.observe(container);
    ro.observe(measureRow);
    return () => ro.disconnect();
    // joinedPartyKey captures membership changes; partyView captures active-tab
    // changes; fontSize/overlayShell affect tab widths.
  }, [isOnPartyTab, joinedPartyKey, partyView, fontSize, overlayShell]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the parties-list container width so the public-parties grid can drop
  // stat columns responsively at narrow overlay widths. Re-attaches when the
  // browser party view mounts/unmounts.
  React.useLayoutEffect(() => {
    const el = partyListRef.current;
    if (!el) return;
    const update = () => setPartyListWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOnPartyTab, partyView]);

  // Fetch slash commands once on mount
  const { data: commandsRaw } = useQuery({
    queryKey: ['commands'],
    queryFn: () => api.get<SlashCommand[]>('/api/commands').then(d => d ?? []),
  });

  const allCommands: SlashCommand[] = useMemo(() => {
    const fetched = (commandsRaw || []).filter(c => c.trigger && c.trigger.startsWith('/'));
    // Exclude any DB command whose trigger is already covered by a hardcoded entry,
    // including the stale seeded '/report' and '/apply' rows.
    const builtinTriggers = new Set([
      '/help',
      '/report', // stale seed — replaced by /report bug + /report player
      ...BUILTIN_RELAYS.map(b => b.cmd.trigger),
      ...BUILTIN_FORMS.map(c => c.trigger),
    ]);
    const dbOnly = fetched.filter(c => !builtinTriggers.has(c.trigger));
    return [SYNTHETIC_HELP, ...BUILTIN_RELAYS.map(b => b.cmd), ...BUILTIN_FORMS, ...dbOnly];
  }, [commandsRaw]);

  // Input text color — tint to channel/party badge color as soon as a relay trigger is recognised
  const inputRelayColor: string | null = useMemo(() => {
    const spaceIdx = inputText.indexOf(' ');
    const typedTrigger = (spaceIdx < 0 ? inputText : inputText.slice(0, spaceIdx)).toLowerCase();
    if (typedTrigger.length < 2) return null;
    // Dynamic party shortcuts: /p1 /p2 /p3 tint to the target party's color
    const partyIdxMatch = typedTrigger.match(/^\/p([123])$/);
    if (partyIdxMatch) {
      const idx = parseInt(partyIdxMatch[1], 10) - 1;
      const party = joinedParties[idx];
      if (party?.color && party.color.trim()) return party.color;
      return primaryColor;
    }
    // /recent tints to primaryColor (recent party — color unknown until resolved)
    if (typedTrigger === '/recent' || typedTrigger === '/rp') return primaryColor;
    const relay = BUILTIN_RELAYS.find(b => b.cmd.trigger === typedTrigger);
    if (!relay) return null;
    if (relay.channelId === null) return relay.fallbackColor || primaryColor;
    const allChs = (channelsRaw || []).flatMap(c => [c, ...(c.children || [])]);
    const ch = allChs.find(c => c.id === relay.channelId);
    // prefer DB color; fall back to hardcoded default so tint always works
    return (ch?.color && ch.color.length > 0) ? ch.color : (relay.fallbackColor || primaryColor);
  }, [inputText, channelsRaw, primaryColor, joinedParties]);

  const acSuggestions: SlashCommand[] = useMemo(() => {
    if (!inputText.startsWith('/')) return [];
    const lower = inputText.toLowerCase();
    return allCommands.filter(c => c.trigger.toLowerCase().startsWith(lower));
  }, [inputText, allCommands]);

  const mainChannels = (channelsRaw || [])
    .filter(c => c.parentId === null)
    .map(c => isPublicMode
      // In public mode strip server: virtual sub-channels from each main channel.
      ? { ...c, children: (c.children || []).filter((s: SubChannel) => !s.id.startsWith('server:')) }
      : c
    );

  // ── Document title sync (Electron overlay window ONLY) ──────────────────────
  // On the website (overlayShell === null) the page/route owns document.title via
  // AdminLayout — do nothing here so we don't fight it or reintroduce the product
  // name into a browser tab. In Electron this sets the native window title.
  useEffect(() => {
    if (!overlayShell) return;
    if (!channelsRaw) return;
    const allChs = (channelsRaw || []).flatMap(c => [c, ...(c.children || [])]);
    const subCh = allChs.find(c => c.id === activeSubId);
    const mainCh = allChs.find(c => c.id === activeMainId);
    const channelName = subCh?.name || mainCh?.name || '';
    document.title = channelName ? `${channelName} · Fallout Chat Mod` : 'Fallout Chat Mod';
  }, [activeMainId, activeSubId, channelsRaw, overlayShell]);

  // Keep allChannelsRef in sync and request history for every sub-channel whenever
  // channels arrive or update (handles WS-already-open case)
  useEffect(() => {
    const all = (channelsRaw || []).flatMap(c => [c, ...(c.children || [])]);
    allChannelsRef.current = all;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && all.length > 0) {
      for (const ch of all) {
        ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: ch.id, limit: 300 } }));
      }
    }
  }, [channelsRaw]);

  // Auto-select first main channel; default sub is "General" if it exists,
  // otherwise stay on the main channel ID so feed view shows all sub-channel messages.
  useEffect(() => {
    if (mainChannels.length > 0 && !activeMainId) {
      const first = mainChannels[0];
      setActiveMainId(first.id);
      const subs = first.children || [];
      // Default to General (never the main channel itself — no chat there).
      const general = subs.find(s => s.name?.toLowerCase() === 'general') ?? subs[0];
      setActiveSubId(general ? general.id : first.id);
    }
  }, [mainChannels, activeMainId]);

  // Electron-only: subscribe to game-running state changes pushed by main.js.
  // Whenever the FO76 process appears or disappears, update inGameRef and
  // immediately send client:status { inGame } over the WS (if connected).
  useEffect(() => {
    const bridge = (window as any).relayBridge;
    if (!bridge?.onGameState) return; // website — no-op
    return bridge.onGameState((inGame: boolean) => {
      inGameRef.current = inGame;
      // Drive the WS gate: game running → connect; game closed → disconnect.
      wsGameActiveRef.current = inGame;
      setWsGameActive(inGame);
      try { bridge.logDiag?.(`[ws-gate] game-state inGame=${inGame}`); } catch { /* noop */ }
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'client:status', payload: { inGame } }));
      }
    });
  }, []);

  // Electron-only: overlay window visibility (hybrid WS gate). main.js pushes
  // visible=true on show (immediate) and visible=false on hide (after a 20s grace).
  useEffect(() => {
    const bridge = (window as any).relayBridge;
    if (!bridge?.onVisibility) return; // website — no-op, overlayVisible stays true
    return bridge.onVisibility((isVisible: boolean) => {
      setOverlayVisible(isVisible);
      try { bridge.logDiag?.(`[ws-gate] visibility visible=${isVisible}`); } catch { /* noop */ }
      // Becoming visible must reconnect promptly ONLY when the gate won't already
      // do it. onVisibility(true) fires on hidden->visible, so overlayVisible was
      // false. If the game was running (wsGameActive), the gate (overlayVisible ||
      // wsGameActive) was ALREADY true, so flipping overlayVisible true won't re-run
      // the WS effect — a socket that dropped mid-backoff needs the manual kick.
      // If the game was NOT running, the gate was false and is now flipping true,
      // which re-runs the WS effect on its own; kicking too would double-fire the
      // effect (the double-teardown seen in logs). So only kick in the game case.
      if (shouldForceReconnectOnVisible({
        isVisible,
        connected: connectedRef.current,
        wsGameActive: wsGameActiveRef.current,
      })) {
        try { bridge.logDiag?.('[ws-gate] visible — forcing reconnect (was disconnected)'); } catch { /* noop */ }
        setWsReconnectTick(n => n + 1);
      }
    });
  }, []);

  // Hybrid WS gate as ONE combined boolean. CRITICAL: the WS effect depends on
  // THIS, not on [overlayVisible, wsGameActive] separately — otherwise a flap in
  // either signal (esp. game-gate flapping) tears down + reconnects the WS even
  // when the connect decision is unchanged, and each reconnect re-fetches
  // chat:history = a visible "chat reload". Web (overlayShell null) is always true.
  // isPublicMode is included so that a session expiry (user -> null) immediately
  // feeds through the gate and triggers teardown rather than leaving the authed
  // WebSocket open until an unrelated wsGate change causes the effect to re-run.
  // See deriveWsShouldConnect (pure, unit-tested) for the gating policy.
  const wsShouldConnect = deriveWsShouldConnect({
    isPublicMode,
    overlayShell: !!overlayShell,
    overlayVisible,
    wsGameActive,
  });

  // Hysteresis gate: connect immediately, disconnect only after a 500 ms grace
  // (200 ms in dev). Prevents the double-teardown race — see useWsGate above.
  const wsGate = useWsGate(wsShouldConnect);

  // Watchdog: if the gate says we should be connected but we're not after 15 s
  // (e.g. a silent retry loop got stuck), bump reconnectTick to force the WS
  // effect to re-run and attempt a fresh connect.
  // wsReconnectTick is in deps so the watchdog restarts its timer after each
  // forced reconnect attempt — without it, the timer fires once and goes dead
  // (connected stays false, wsGate stays true → deps unchanged → no re-run).
  useEffect(() => {
    if (!wsGate || connected) return;
    const t = setTimeout(() => setWsReconnectTick(n => n + 1), import.meta.env.DEV ? 5_000 : 15_000);
    return () => clearTimeout(t);
  }, [wsGate, connected, wsReconnectTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keepalive: send client:status every 45 s while connected so Cloudflare's
  // 100 s idle-WS timeout never fires during quiet gameplay sessions.
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === (ws as any).OPEN) {
        ws.send(JSON.stringify({ type: 'client:status', payload: { inGame: inGameRef.current } }));
      }
    }, 45_000);
    return () => clearInterval(t);
  }, [connected]);

  // WebSocket connection — skipped in public/logged-out mode (uses REST polling instead).
  // In the Electron overlay it connects when visible OR in-game, and only tears
  // down when the combined gate flips false (hidden AND game closed).
  useEffect(() => {
    if (isPublicMode) return;
    // Each time the effect re-runs (gate/tick change = manual retry trigger),
    // clear the terminal state so the user gets a fresh connect attempt.
    setAuthTerminalState(false);
    if (!wsGate) {
      try { (window as any).relayBridge?.logDiag?.('[ws-gate] skip connect — hidden AND game not running'); } catch { /* noop */ }
      return;
    }
    let ws: WebSocket | undefined;
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let fetchAbort: AbortController | undefined;
    // Tracks consecutive 401/403 responses from /auth/ws-ticket.
    // After 3 consecutive auth failures the retry loop stops and the component
    // surfaces a terminal "authentication expired" state. Non-auth failures
    // (network/5xx) reset this counter (they do not count toward the threshold).
    let consecutiveAuthFailures = 0;

    function connect(attempt = 0) {
      if (cancelled) return;
      fetchAbort?.abort();
      const ctrl = new AbortController();
      fetchAbort = ctrl;
      const abortTimer = setTimeout(() => ctrl.abort(), 10_000);
      fetch('/auth/ws-ticket', { credentials: 'include', signal: ctrl.signal })
        .then(r => {
          clearTimeout(abortTimer);
          if (r.status === 401 || r.status === 403) {
            // Auth failure — tag the error so the catch block can classify it.
            const err: Error & { isAuthFailure?: boolean } = new Error('Not authenticated');
            err.isAuthFailure = true;
            throw err;
          }
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(({ data }) => {
          if (cancelled) return;
          // Successful ticket fetch — reset auth-failure counter and clear any
          // terminal state that was set by a previous run of this effect.
          consecutiveAuthFailures = 0;
          setAuthTerminalState(false);
          const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
          ws = new WebSocket(`${protocol}://${window.location.host}/ws?ticket=${data.ticket}`);
          wsRef.current = ws;

          ws.onopen = () => {
            setConnected(true);
            // Flush any chat:send frames that were queued while offline.
            try {
              const r = outboxRef.current.flush((f) => ws!.send(f), Date.now());
              // size(), not 0 — flush retains entries if a send throws mid-drain.
              setOutboxCount(outboxRef.current.size());
              if (r.sent || r.dropped) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                try { (window as any).relayBridge?.logDiag?.(`[outbox] flushed sent=${r.sent} dropped=${r.dropped}`); } catch { /* noop */ }
              }
            } catch {
              // flush threw unexpectedly — keep the remaining queue for the next reconnect
              setOutboxCount(outboxRef.current.size());
            }
            // Reset lazy-load bookkeeping on every (re)connect — the initial
            // history burst will re-establish per-channel baselines.
            lazyLoadedCountRef.current = new Map();
            lazyEndReachedRef.current = new Set();
            lazyLoadingRef.current = false;
            pendingLazyChannelRef.current = null;
            // Reset per-session party-history dedup on every (re)connect.
            requestedPartyHistoriesRef.current = new Set();
            // Request history for channels that haven't loaded yet this session.
            // Channels already in historyLoadedChsRef have existing messages — skip
            // them to avoid the visible "chat reload" flash on hide→show reconnects.
            // Missed live messages during disconnect will arrive as chat:message frames
            // going forward (the same stream continuity guarantee as any live session).
            const known = allChannelsRef.current;
            const alreadyLoaded = historyLoadedChsRef.current;
            const silentReconnect = alreadyLoaded.size > 0;
            if (silentReconnect) {
              try { (window as any).relayBridge?.logDiag?.(`[ws-gate] reconnect — silent (${alreadyLoaded.size} channels already loaded, state preserved)`); } catch { /* noop */ }
              // Show a transient notice so the user knows messages may have been
              // missed during the disconnect. Not shown in public mode (isPublicMode
              // guard is on the outer useEffect) or on first connect.
              setShowMissedMsgNotice(true);
              setTimeout(() => setShowMissedMsgNotice(false), 8_000);
            }
            // Channels to (re)hydrate: first-load channels PLUS the active channel
            // (always — the blank-after-show guard). See reconnectHistoryChannelIds.
            const historyChannelIds = reconnectHistoryChannelIds({
              activeChannelId: activeSubIdRef.current ?? null,
              alreadyLoaded,
              knownChannelIds: known.map(ch => ch.id),
            });
            for (const channelId of historyChannelIds) {
              ws!.send(JSON.stringify({ type: 'chat:history', payload: { channelId, limit: 300 } }));
            }
            // If the user is currently viewing a specific party, also request its
            // history. The party:history effect only fires on partyView CHANGES, so
            // it doesn't re-fire on WS reconnect — making this the only place to
            // hydrate party chat after a reconnect (or initial connect while already
            // on a party tab).
            const pv = partyViewRef.current;
            if (pv && pv !== 'browser') {
              ws!.send(JSON.stringify({ type: 'party:history', payload: { partyId: pv, limit: 200 } }));
            }
            ws!.send(JSON.stringify({ type: 'pm:list', payload: {} }));
            // Refetch channels on every (re)connect so the list is always current
            // even if channels:refresh events were missed during a disconnect.
            refetchChannelsRef.current?.();
            // Hydrate active-giveaway indicator on connect.
            fetch('/api/giveaways', { credentials: 'include' })
              .then(r => r.ok ? r.json() : null)
              .then(d => { if (d?.data?.length > 0) setGiveawayActive(true); })
              .catch(() => {});
            // Report in-game state immediately on connect. The Electron shell
            // populates inGameRef via onGameState; on the website it stays false
            // (web users are not game clients — correct to be OFFLINE for presence).
            ws!.send(JSON.stringify({ type: 'client:status', payload: { inGame: inGameRef.current } }));
          };
          ws.onclose = (ev?: { code?: number; reason?: string }) => {
            setConnected(false);
            // Log the close code + reason. Critical for diagnosing the in-game
            // reconnect storm: a 1006 (abnormal/no close frame) points at a
            // transport/proxy drop (Cloudflare idle, NIC sleep, AV), whereas a
            // 4001/4002/4008 is a backend decision (auth/ban/superseded). Without
            // this, the storm was undiagnosable from the logs.
            const code = ev?.code ?? 0;
            const reason = ev?.reason ? ` reason="${ev.reason}"` : '';
            if (!cancelled) {
              const delay = backoffDelay(attempt);
              try { (window as any).relayBridge?.logDiag?.(`[ws-gate] closed code=${code}${reason} — retry in ${Math.round(delay)}ms (attempt ${attempt + 1})`); } catch { /* noop */ }
              retryTimeout = setTimeout(() => connect(attempt + 1), delay);
            } else {
              try { (window as any).relayBridge?.logDiag?.(`[ws-gate] closed code=${code}${reason} — retry suppressed (cancelled)`); } catch { /* noop */ }
            }
          };

          ws.onmessage = (event) => {
            try {
              const frame = JSON.parse(event.data);
              if (frame.type === 'chat:message') {
                // Client-side dedup: backend may deliver the same frame more than
                // once (multi-tab / reconnect zombie). Skip if id already rendered.
                const incomingId = frame.payload.id;
                if (incomingId && seenMessageIdsRef.current.has(incomingId)) {
                  return;
                }
                if (incomingId) {
                  seenMessageIdsRef.current.add(incomingId);
                  seenMessageIdQueueRef.current.push(incomingId);
                  while (seenMessageIdQueueRef.current.length > 1000) {
                    const evicted = seenMessageIdQueueRef.current.shift();
                    if (evicted) seenMessageIdsRef.current.delete(evicted);
                  }
                }
                if (frame.payload.source === 'server' && frame.payload.serverEndpoint) {
                  setFeedMessages(prev => [{
                    id: frame.payload.id,
                    content: frame.payload.content,
                    username: frame.payload.username,
                    userId: frame.payload.userId || '',
                    serverEndpoint: frame.payload.serverEndpoint,
                    isDeleted: false,
                    createdAt: frame.payload.timestamp || new Date().toISOString(),
                  }, ...prev].slice(0, 500));
                }
                setMessages(prev => [...prev.slice(-(MESSAGE_CAP - 1)), {
                  id: frame.payload.id,
                  content: frame.payload.content,
                  username: frame.payload.username,
                  userId: frame.payload.userId,
                  channelId: frame.payload.channelId,
                  source: frame.payload.source || 'game',
                  timestamp: frame.payload.createdAt || frame.payload.timestamp,
                  responseColor: frame.payload.responseColor ?? null,
                  avatarUrl: frame.payload.avatarUrl ?? null,
                  metadata: frame.payload.metadata ?? null,
                }]);

                // Track active giveaways from broadcast metadata.
                {
                  const metaType = frame.payload.metadata?.type;
                  if (metaType === 'giveaway') setGiveawayActive(true);
                  if (metaType === 'giveaway_winner') {
                    // Check if any other giveaways are still active.
                    const anyStillActive = [...giveawayLiveStateRef.current.values()].some(g => g.status === 'active');
                    if (!anyStillActive) setGiveawayActive(false);
                  }
                }

                // Auto-unhide: if this LIVE message landed in the view the user is
                // CURRENTLY looking at, keep the overlay open / reset its idle-
                // collapse timer — but ONLY for the user's OWN just-sent message.
                // Incoming messages from OTHERS must NOT un-auto-hide the overlay
                // (otherwise a busy channel means it never idle-collapses). Only
                // sent messages keep it open. Match the active view:
                //   • party message (source 'party') → active party id
                //   • channel message → active sub-tab, or active main-feed
                //     parent + its children. History/lazy-load never reach here.
                {
                  const v = viewCtxRef.current;
                  const chId: string = frame.payload.channelId;
                  let inActiveView = false;
                  if (frame.payload.source === 'party') {
                    inActiveView = !!v.activePartyId && chId === v.activePartyId;
                  } else {
                    inActiveView = v.feedId
                      ? (chId === v.feedId || v.feedChildIds.includes(chId))
                      : chId === v.activeSubId;
                  }
                  // Pop the collapsed overlay open for ANY live message in the active
                  // view — not just your own. The old gate also required isOwn, so
                  // incoming messages from others (incl. bridged Discord messages)
                  // never expanded the overlay.
                  if (inActiveView && chId) {
                    window.dispatchEvent(new Event('fcm-active-message'));
                  }
                }

                // @mention: badge the channel if this LIVE message mentions me and
                // I'm not currently viewing it (history messages never badge).
                {
                  const content: string = frame.payload.content || '';
                  const chId: string = frame.payload.channelId;
                  const mentionsMe = frame.payload.userId !== myUserIdRef.current
                    && myNamesRef.current.some(n => contentMentionsName(content, n));
                  if (mentionsMe && chId) {
                    const v = viewCtxRef.current;
                    const inView = v.feedId
                      ? (chId === v.feedId || v.feedChildIds.includes(chId))
                      : chId === v.activeSubId;
                    // Auto-appear for ANY mention of me (active channel OR elsewhere):
                    // if the overlay is collapsed/hidden the user can't see even the
                    // active channel, so a mention there should still pop it out.
                    // shell.ts → markActivity() (un-collapse) + showForMention() (un-hide
                    // from tray). When already visible on the active channel this is a
                    // no-op (idle-timer reset only; no focus steal). The unread badge +
                    // jump button stay gated on !inView below.
                    window.dispatchEvent(new CustomEvent('fcm-mention-appear', { detail: { chId } }));
                    if (!inView) {
                      setUnreadMentions(prev => ({ ...prev, [chId]: (prev[chId] || 0) + 1 }));
                    }
                    // New in-view mention: remove its id from the dismissed set so
                    // the jump button re-appears for this genuinely new message.
                    else {
                      const msgId: string = frame.payload.id;
                      if (msgId) dismissedMentionIdsRef.current.delete(msgId);
                    }
                  }
                }
              } else if (frame.type === 'chat:history') {
                const incoming = (frame.payload.messages || []).map((m: any) => {
                  // History rows are snake_case; the backend adds camelCase `avatarUrl`.
                  const av = m.avatarUrl ?? null;
                  const uid = m.user_id ?? m.userId;
                  return {
                    id: m.id, content: m.content, username: m.username,
                    userId: uid, channelId: m.channel_id ?? m.channelId,
                    source: m.source || 'game', timestamp: m.created_at ?? m.createdAt,
                    avatarUrl: av,
                    metadata: m.metadata ?? null,
                  };
                });
                // ── Lazy-load branch ─────────────────────────────────────────
                // A top-scroll fetch is in flight: PREPEND the older batch,
                // bump the loaded-count offset, detect end-of-history, and
                // preserve scroll position so the viewport doesn't jump.
                if (lazyLoadingRef.current) {
                  const lazyCh = pendingLazyChannelRef.current;
                  // Only rows that belong to the channel we asked for. (Normal
                  // UUID history frames don't echo channelId, so we match on the
                  // rows' own channelId.)
                  const batch = lazyCh
                    ? incoming.filter((m: { channelId: string }) => m.channelId === lazyCh)
                    : incoming;
                  // End of history when the backend returned fewer than a full page.
                  if (lazyCh && (frame.payload.messages || []).length < HISTORY_PAGE) {
                    lazyEndReachedRef.current.add(lazyCh);
                  }
                  if (lazyCh && batch.length > 0) {
                    const newCount = (lazyLoadedCountRef.current.get(lazyCh) || 0) + batch.length;
                    lazyLoadedCountRef.current.set(lazyCh, newCount);
                  }
                  const cont = messagesContRef.current;
                  const oldScrollHeight = cont ? cont.scrollHeight : 0;
                  setMessages(prev => {
                    const seen = new Set(prev.map(m => m.id));
                    const older = batch.filter((m: { id: string }) => !seen.has(m.id));
                    if (older.length === 0) return prev;
                    const merged = [...prev, ...older];
                    merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
                    // Do NOT slice here — trimming would drop the older rows we
                    // just fetched right off the top.
                    return merged;
                  });
                  // Restore scroll AFTER the prepended rows have laid out.
                  requestAnimationFrame(() => {
                    const c = messagesContRef.current;
                    if (c) c.scrollTop += c.scrollHeight - oldScrollHeight;
                    lazyLoadingRef.current = false;
                    pendingLazyChannelRef.current = null;
                  });
                  lazyScrollAnchorRef.current = oldScrollHeight;
                } else {
                  // ── Normal (initial / channel-switch) history ──────────────
                  // Snapshot focus state before the state update triggers re-render.
                  inputWasFocusedRef.current =
                    document.activeElement === richInputRef.current ||
                    document.activeElement === inputRef.current;
                  setMessages(prev => mergeHistoryMessages(prev, incoming, MESSAGE_CAP));
                  // Establish the lazy baseline: record how many rows we hold per
                  // channel (drives the next top-scroll offset) and flag short
                  // batches as end-of-history.
                  const byCh = new Map<string, number>();
                  for (const m of incoming) {
                    if (!m.channelId) continue;
                    byCh.set(m.channelId, (byCh.get(m.channelId) || 0) + 1);
                  }
                  for (const [ch, n] of byCh) {
                    const prevN = lazyLoadedCountRef.current.get(ch) || 0;
                    if (n > prevN) lazyLoadedCountRef.current.set(ch, n);
                    if (n < HISTORY_PAGE) lazyEndReachedRef.current.add(ch);
                    // Mark this channel as loaded so reconnects don't re-request
                    // its history — preventing the visible "chat reload" flash on
                    // hide→show cycles. Reset only on component remount (mountKey).
                    historyLoadedChsRef.current.add(ch);
                  }
                }
                // Re-focus the input after history repopulates if it was focused before.
                if (inputWasFocusedRef.current) {
                  requestAnimationFrame(() => {
                    if (richInputRef.current) richInputRef.current.focus();
                    else inputRef.current?.focus();
                  });
                }
              } else if (frame.type === 'chat:delete') {
                setMessages(prev => prev.filter(m => m.id !== frame.payload.messageId));
                setFeedMessages(prev => prev.filter(m => m.id !== frame.payload.messageId));
              } else if (frame.type === 'mod:report') {
                setReportAlerts(prev => [frame.payload, ...prev].slice(0, 5));
              } else if (frame.type === 'channels:refresh') {
                refetchChannelsRef.current?.();
              } else if (frame.type === 'presence:update') {
                if (activeSubIdRef.current.startsWith('server:')) {
                  presenceRefetchRef.current?.();
                }
              } else if (frame.type === 'commands:updated') {
                // Server pushed a fresh command list — update the autocomplete cache immediately
                if (Array.isArray(frame.payload?.commands)) {
                  queryClient.setQueryData(['commands'], frame.payload.commands);
                }
              } else if (frame.type === 'emojis:updated') {
                // Guild emoji set changed — refetch the picker's custom-emoji list now.
                queryClient.invalidateQueries({ queryKey: ['discord-emojis'] });
              } else if (frame.type === 'user:muted') {
                setMuteState({
                  until: frame.payload?.until ?? null,
                  reason: frame.payload?.reason ?? null,
                  category: frame.payload?.category ?? null,
                });
              } else if (frame.type === 'user:unmuted') {
                setMuteState(null);
              } else if (frame.type === 'user:kicked') {
                setLastNotice({
                  kind: 'kicked',
                  reason: frame.payload?.reason ?? null,
                  until: frame.payload?.until ?? null,
                  durationSeconds: frame.payload?.durationSeconds ?? null,
                });
              } else if (frame.type === 'user:banned') {
                setLastNotice({
                  kind: 'banned',
                  reason: frame.payload?.reason ?? null,
                  category: frame.payload?.category ?? null,
                  until: frame.payload?.until ?? null,
                  permanent: !!frame.payload?.permanent,
                });
              } else if (frame.type === 'party:invite') {
                // Non-focus-stealing invite toast
                const inv: PartyInvite = {
                  id: frame.payload.inviteId,
                  partyId: frame.payload.partyId,
                  partyName: frame.payload.partyName,
                  inviterName: frame.payload.inviterName,
                  createdAt: new Date().toISOString(),
                };
                setPartyInviteToasts(prev => [...prev.slice(-4), inv]);
                // Also invalidate the invites list
                queryClient.invalidateQueries({ queryKey: ['party-invites'] });
                queryClient.invalidateQueries({ queryKey: ['parties'] });
              } else if (frame.type === 'party:member-update') {
                const { partyId, members } = frame.payload as { partyId: string; members: PartyMember[]; memberCount: number; onlineCount: number };
                setPartyMemberCache(prev => ({ ...prev, [partyId]: members }));
                queryClient.invalidateQueries({ queryKey: ['parties'] });
              } else if (frame.type === 'party:deleted') {
                const { partyId } = frame.payload as { partyId: string };
                queryClient.invalidateQueries({ queryKey: ['parties'] });
                queryClient.invalidateQueries({ queryKey: ['party-members', partyId] });
                setPartyMemberCache(prev => { const n = { ...prev }; delete n[partyId]; return n; });
                // If viewing this party, return to browser
                setPartyView(prev => prev === partyId ? 'browser' : prev);
              } else if (frame.type === 'pm:list') {
                const nextConversations = Array.isArray(frame.payload?.conversations)
                  ? frame.payload.conversations as PrivateConversationSummary[]
                  : [];
                setPrivateConversations(nextConversations);
                if (typeof frame.payload?.openedConversationId === 'string') {
                  setActiveMainId(PM_MAIN_ID);
                  setPmView(frame.payload.openedConversationId);
                } else if (pmViewRef.current !== 'inbox' && !nextConversations.some(c => c.conversationId === pmViewRef.current)) {
                  setPmView('inbox');
                }
              } else if (frame.type === 'pm:history') {
                const conversationId = typeof frame.payload?.conversationId === 'string' ? frame.payload.conversationId : '';
                const incoming = Array.isArray(frame.payload?.messages)
                  ? (frame.payload.messages as PrivateMessagePayload[]).map(toPrivateChatMessage)
                  : [];
                if (conversationId) {
                  const latestMessage = incoming.length > 0 ? incoming[incoming.length - 1] : null;
                  setPrivateMessages(prev => ({ ...prev, [conversationId]: incoming }));
                  setPrivateConversations(prev => prev.map(conversation =>
                    conversation.conversationId === conversationId
                      ? {
                        ...conversation,
                        unreadCount: 0,
                        lastMessagePreview: latestMessage?.content ?? conversation.lastMessagePreview,
                        lastMessageSenderId: latestMessage?.userId ?? conversation.lastMessageSenderId,
                        lastMessageAt: latestMessage?.timestamp ?? conversation.lastMessageAt,
                      }
                      : conversation,
                  ));
                }
              } else if (frame.type === 'pm:message') {
                const payload = frame.payload as PrivateMessagePayload;
                if (!payload?.conversationId || !payload?.id) return;
                const mapped = toPrivateChatMessage(payload);
                const senderIsMe = payload.senderId === (user?.id ?? '');
                const conversationActive = activeMainIdRef.current === PM_MAIN_ID && pmViewRef.current === payload.conversationId;
                setPrivateMessages(prev => {
                  const existing = prev[payload.conversationId] ?? [];
                  if (existing.some(message => message.id === payload.id)) return prev;
                  return {
                    ...prev,
                    [payload.conversationId]: [...existing, mapped],
                  };
                });
                setPrivateConversations(prev => {
                  const existing = prev.find(conversation => conversation.conversationId === payload.conversationId);
                  const unreadCount = senderIsMe || conversationActive
                    ? 0
                    : (existing?.unreadCount ?? 0) + 1;
                  const nextConversation: PrivateConversationSummary = {
                    conversationId: payload.conversationId,
                    otherUserId: senderIsMe ? payload.recipientId : payload.senderId,
                    otherDisplayName: senderIsMe
                      ? (existing?.otherDisplayName ?? 'Wanderer')
                      : payload.senderName,
                    lastMessagePreview: payload.content,
                    lastMessageSenderId: payload.senderId,
                    lastMessageAt: payload.createdAt,
                    unreadCount,
                  };
                  const others = prev.filter(conversation => conversation.conversationId !== payload.conversationId);
                  return [nextConversation, ...others];
                });
                if (!senderIsMe && conversationActive && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({
                    type: 'pm:read',
                    payload: { conversationId: payload.conversationId },
                  }));
                }
              } else if (frame.type === 'pm:read') {
                const conversationId = typeof frame.payload?.conversationId === 'string' ? frame.payload.conversationId : '';
                if (conversationId) {
                  setPrivateConversations(prev => prev.map(conversation =>
                    conversation.conversationId === conversationId
                      ? { ...conversation, unreadCount: frame.payload?.unreadCount ?? 0 }
                      : conversation,
                  ));
                }
              } else if (frame.type === 'user:identity_updated') {
                // Backend broadcasts the resolved displayName whenever a user's
                // FO76 name or Discord name is updated. Store it so we can
                // back-apply it to any already-rendered messages and correct
                // history messages that may have carried a stale login-only name
                // (e.g. "devotek" instead of "Devotek"). Parity with the desktop
                // _knownDisplayNames + history correction in ChatOverlayWindow.cs.
                const { userId, displayName } = frame.payload ?? {};
                if (userId && displayName && typeof displayName === 'string') {
                  knownDisplayNames.current.set(userId, displayName);
                  // Back-apply to already-stored messages so they show the
                  // correct name immediately without requiring a reconnect.
                  setMessages(prev => prev.map(m =>
                    m.userId === userId && m.source !== 'bot' && m.username !== '[Vault-Tec]'
                      ? { ...m, username: displayName }
                      : m
                  ));
                }
              } else if (frame.type === 'giveaway:update') {
                const { giveawayId, shortId, entryCount, status, winnerName } = frame.payload ?? {};
                if (giveawayId) {
                  if (status === 'completed' || status === 'cancelled') {
                    // Remove stale entries to prevent unbounded Map growth.
                    giveawayLiveStateRef.current.delete(giveawayId);
                  } else {
                    giveawayLiveStateRef.current.set(giveawayId, { entryCount: entryCount ?? 0, status: status ?? 'active', winnerName });
                  }
                  // Update active-giveaway indicator: true if ANY giveaway is now active
                  const anyActive = [...giveawayLiveStateRef.current.values()].some(g => g.status === 'active');
                  setGiveawayActive(anyActive);
                  // Trigger a re-render only if any visible message references this giveaway.
                  setMessages(prev => {
                    const hasCard = prev.some(m => {
                      const md = m.metadata as any;
                      return md && (md.giveawayId === giveawayId || md.shortId === shortId);
                    });
                    return hasCard ? [...prev] : prev;
                  });
                }
              } else if (frame.type === 'chat:typing') {
                // Ephemeral typing indicator — show for 4s then auto-clear.
                const { userId: tUserId, username: tUsername, channelId: tChannelId, partyId: tPartyId } = frame.payload ?? {};
                if (tUserId && tUsername && (tChannelId || tPartyId)) {
                  const scopeKey = tPartyId ? `party:${tPartyId}` : `ch:${tChannelId}`;
                  setTypingUsers(prev => ({
                    ...prev,
                    [tUserId]: { username: tUsername, scopeKey, clearAt: Date.now() + 4000 },
                  }));
                  setTimeout(() => {
                    setTypingUsers(prev => {
                      const entry = prev[tUserId];
                      if (!entry || entry.clearAt > Date.now()) return prev;
                      const next = { ...prev };
                      delete next[tUserId];
                      return next;
                    });
                  }, 4100);
                }
              } else if (frame.type === 'app:update-available') {
                // The backend broadcasts this to EVERY client whenever it merely has
                // a latest version cached — it does not compare to the client's build.
                // Only light the dot when `v` is STRICTLY newer than what we're running,
                // mirroring the shell's guarded `relay:update-available` path (main.js).
                const v = frame.payload?.latestVersion;
                if (v && typeof v === 'string' && isVersionNewer(v, displayVersionRef.current)) {
                  setUpdateAvailableVersion(v);
                }
              }
            } catch { /* ignore */ }
          };
        })
        .catch((err: unknown) => {
          clearTimeout(abortTimer);
          if (!cancelled) {
            const isAuth = !!(err && typeof err === 'object' && (err as { isAuthFailure?: boolean }).isAuthFailure);
            if (isAuth) {
              consecutiveAuthFailures++;
              if (isAuthTerminal(consecutiveAuthFailures)) {
                // Stop retrying — surface terminal auth-expired state.
                try { (window as any).relayBridge?.logDiag?.(`[ws-gate] ticket fetch: auth terminal after ${consecutiveAuthFailures} consecutive 401/403 — stopping retry loop`); } catch { /* noop */ }
                setAuthTerminalState(true);
                return;
              }
            } else {
              // Network/5xx failure — reset consecutive auth counter.
              consecutiveAuthFailures = 0;
            }
            const delay = nextTicketRetryDelay(attempt);
            try { (window as any).relayBridge?.logDiag?.(`[ws-gate] ticket fetch failed (${isAuth ? 'auth' : 'network'}) — retry in ${Math.round(delay)}ms (attempt ${attempt + 1})`); } catch { /* noop */ }
            retryTimeout = setTimeout(() => connect(attempt + 1), delay);
          }
        });
    }

    connect();
    return () => {
      cancelled = true; clearTimeout(retryTimeout);
      fetchAbort?.abort();
      try { (window as any).relayBridge?.logDiag?.('[ws-gate] teardown — closing WS'); } catch { /* noop */ }
      ws?.close();
    };
  // Depend on wsGate (hysteresis-smoothed) + reconnectTick. wsGate absorbs rapid
  // wsShouldConnect flaps so the WS only tears down after a 500 ms grace — this
  // prevents double-teardown races. The tick is bumped by the watchdog (15 s
  // disconnected while gate=true) as a final safety net for stuck retry loops.
  }, [wsGate, wsReconnectTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Public-mode REST polling (no auth required) ────────────────────────────
  // When rendered without a logged-in user (landing page), skip WS and poll
  // the public REST endpoints every 3 s. Mirrors PublicChatOverlay's approach.
  useEffect(() => {
    if (!isPublicMode || !activeSubId) return;
    const allChs = (channelsRaw || []).flatMap(
      (c: Channel) => [c, ...(c.children || [])]
    );
    const sub_ = allChs.find((c: Channel) => c.id === activeSubId);
    const isGeneral_ = !!sub_ && sub_.parentId != null
      && sub_.name?.toLowerCase() === 'general';
    const isFeed_ = mainChannels.some((m: Channel) => m.id === activeSubId)
      || isGeneral_;
    const feedParent_ = isGeneral_
      ? mainChannels.find((m: Channel) => m.id === sub_?.parentId)
      : mainChannels.find((m: Channel) => m.id === activeSubId);
    const channelIds: string[] = isFeed_ && feedParent_
      ? [feedParent_.id, ...(feedParent_.children || []).map((c: Channel) => c.id)]
      : [activeSubId];

    async function loadPublic() {
      try {
        const results = await Promise.all(
          channelIds.map(id =>
            fetch(`/api/messages/public?channelId=${id}&limit=300`)
              .then(r => r.json())
              .then(j => (j.data || []).map((m: any) => ({
                id: m.id,
                content: m.content,
                username: m.username,
                userId: m.userId ?? m.user_id ?? '',
                channelId: m.channelId ?? m.channel_id ?? id,
                source: m.source || 'game',
                timestamp: m.createdAt ?? m.created_at,
                avatarUrl: m.avatarUrl ?? null,
                metadata: m.metadata ?? null,
              } as ChatMessage)))
          )
        );
        const all = results.flat();
        all.sort((a: ChatMessage, b: ChatMessage) =>
          (a.timestamp ?? '') < (b.timestamp ?? '') ? -1 : 1);
        setMessages(prev => {
          const ids = new Set(all.map((m: ChatMessage) => m.id));
          // Drop ONLY the messages for the channel scope we just refreshed; keep
          // everything else (party messages + other channels) untouched. The old
          // filter required channelIds.includes(channelId), which dropped ALL
          // party messages every 3s — then the 4s party poll re-added them,
          // making the party history flash in and out on the public overlay.
          const kept = prev.filter(
            (m: ChatMessage) => !channelIds.includes(m.channelId) || !ids.has(m.id));
          const merged = [...kept, ...all];
          merged.sort((a: ChatMessage, b: ChatMessage) =>
            (a.timestamp ?? '') < (b.timestamp ?? '') ? -1 : 1);
          return merged.slice(-500);
        });
        if (!connected) setConnected(true);
      } catch { /* ignore poll failure */ }
    }

    loadPublic();
    const t = setInterval(loadPublic, 3000);
    return () => clearInterval(t);
  }, [isPublicMode, activeSubId, channelsRaw]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Public-mode PUBLIC-PARTY message polling (no auth required) ────────────
  // Logged-out visitors have no WS, so poll each public party's read-only
  // messages endpoint. These messages carry source:'party' + channelId=partyId
  // so they (a) render in the read-only party-chat view and (b) feed into the
  // General/Fallout 76 combined feed with a [PartyName] tag, mirroring the auth
  // side. ONLY public parties are ever fetched (the endpoint rejects private).
  useEffect(() => {
    if (!isPublicMode) return;
    const ids = publicPartyIdKey ? publicPartyIdKey.split(',') : [];
    if (ids.length === 0) return;

    async function loadPartyMsgs() {
      try {
        const results = await Promise.all(
          ids.map(id =>
            fetch(`/api/parties/public/${id}/messages?limit=200`)
              .then(r => (r.ok ? r.json() : { data: { messages: [] } }))
              .then(j => ((j?.data?.messages ?? []) as any[]).map((m: any) => ({
                id: m.id,
                content: m.content,
                username: m.username,
                userId: m.userId ?? m.user_id ?? '',
                channelId: m.channelId ?? m.partyId ?? id,
                source: 'party',
                timestamp: m.createdAt ?? m.created_at,
                avatarUrl: null,
                metadata: null,
              } as ChatMessage)))
              .catch(() => [] as ChatMessage[])
          )
        );
        const all = results.flat();
        if (all.length === 0) return;
        setMessages(prev => {
          const incomingIds = new Set(all.map(m => m.id));
          const partyIdSet = new Set(ids);
          // Drop prior party messages for these parties (refresh) but keep
          // everything else (channel messages, other parties).
          const kept = prev.filter(m => !(partyIdSet.has(m.channelId) && incomingIds.has(m.id)) && !(m.source === 'party' && partyIdSet.has(m.channelId)));
          const merged = [...kept, ...all];
          merged.sort((a, b) => ((a.timestamp ?? '') < (b.timestamp ?? '') ? -1 : 1));
          return merged.slice(-800);
        });
      } catch { /* ignore poll failure */ }
    }

    loadPartyMsgs();
    const t = setInterval(loadPartyMsgs, 4000);
    return () => clearInterval(t);
  }, [isPublicMode, publicPartyIdKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { activeSubIdRef.current = activeSubId; }, [activeSubId]);
  // Keep ref mirrors in sync for the once-registered onCommand IPC listener.
  useEffect(() => { activeMainIdRef.current = activeMainId; }, [activeMainId]);
  useEffect(() => { partyViewRef.current = partyView; }, [partyView]);
  useEffect(() => { joinedPartiesRef.current = joinedParties; }, [joinedParties]);
  // fo76SubsRef: the sub-channels of the first non-party main channel (General/Trading/Events/Raids).
  const fo76Main = mainChannels.find(c => c.id !== PARTY_MAIN_ID);
  useEffect(() => {
    fo76SubsRef.current   = fo76Main?.children ?? [];
    fo76MainIdRef.current = fo76Main?.id ?? null;
  }, [fo76Main?.id, channelsRaw]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isPublicMode || activeMainId !== PM_MAIN_ID) return;
    setPmView('inbox');
    if (fo76Main?.id) {
      setActiveMainId(fo76Main.id);
      if (fo76Main.children?.[0]?.id) setActiveSubId(fo76Main.children[0].id);
    }
  }, [isPublicMode, activeMainId, fo76Main]);
  // Persist the selected tab at module level (overlay only) so a remount restores
  // it instead of snapping back to General. Only store real selections.
  useEffect(() => {
    if (!overlayShell) return;
    if (activeMainId) lastSelectedMainId = activeMainId;
    if (activeSubId) lastSelectedSubId = activeSubId;
  }, [activeMainId, activeSubId, overlayShell]);

  // Fetch party history when switching to a party view
  useEffect(() => {
    if (activeMainId !== PARTY_MAIN_ID || partyView === 'browser') return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'party:history',
      payload: { partyId: partyView, limit: 200 },
    }));
    requestedPartyHistoriesRef.current.add(partyView);
  }, [activeMainId, partyView]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeMainId !== PM_MAIN_ID || pmView === 'inbox') return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'pm:history',
      payload: { conversationId: pmView, limit: 100 },
    }));
  }, [activeMainId, pmView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load history for all joined parties so the General feed can show party
  // messages that arrived before this session (not just live messages).
  // Runs when WS connects and whenever the joined-party set changes.
  // Uses requestedPartyHistoriesRef to dedup within the same WS session.
  const connectedState = connected; // boolean from useState — stable value in effect dep
  useEffect(() => {
    if (!connectedState || wsRef.current?.readyState !== WebSocket.OPEN) return;
    for (const party of joinedParties) {
      if (requestedPartyHistoriesRef.current.has(party.id)) continue;
      requestedPartyHistoriesRef.current.add(party.id);
      wsRef.current.send(JSON.stringify({
        type: 'party:history',
        payload: { partyId: party.id, limit: 100 },
      }));
    }
  }, [connectedState, joinedPartyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch history on channel switch
  useEffect(() => {
    if (!activeSubId || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const ws = wsRef.current;
    const activeChannel = [...mainChannels, ...mainChannels.flatMap(m => m.children || [])].find(c => c.id === activeSubId);
    const isMain = mainChannels.some(m => m.id === activeSubId);
    if (isMain && activeChannel) {
      ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: activeSubId, limit: 300 } }));
      for (const sub of (activeChannel as Channel).children || []) {
        ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: sub.id, limit: 300 } }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: activeSubId, limit: 300 } }));
    }
  }, [activeSubId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll: keep the list PINNED to the bottom, but INSTANTLY (no smooth
  // animation) and only when the user is already near the bottom. Smooth-scrolling
  // on every messages change caused a visible "scroll to bottom" jump on click /
  // re-render even when already at the bottom; instant + near-bottom gate means it
  // just stays at the bottom (and never yanks you down while reading history).
  // Deferred scroll-to-bottom of the message container. Used for initial load,
  // channel/sub-tab switch, and the external fcm-scroll-bottom event (overlay
  // un-collapse / focus-to-chat). HARDENED: when the shell un-hides the message
  // body (display toggled) and dispatches this, the container's scrollHeight
  // isn't settled on the first frame — React re-renders and layout reflows over
  // the next several frames. So we pin to bottom across multiple frames: once
  // next rAF, again the frame after, then a couple of timed retries to catch the
  // settled layout. Each pass just sets scrollTop = scrollHeight (idempotent), so
  // repeating is harmless and guarantees we land at the latest message.
  const scrollToBottom = useCallback(() => {
    const pin = () => {
      const cont = messagesContRef.current;
      if (cont) {
        cont.scrollTop = cont.scrollHeight;
      } else {
        const end = messagesEndRef.current;
        if (end) end.scrollIntoView({ behavior: 'auto', block: 'end' });
      }
    };
    requestAnimationFrame(() => {
      pin();
      // A second rAF runs after the browser has applied the first frame's layout.
      requestAnimationFrame(pin);
    });
    // Timed retries catch the post-re-show reflow (body display toggle) once
    // React has re-rendered and the new scrollHeight is real.
    setTimeout(pin, 60);
    setTimeout(pin, 140);
  }, []);

  useEffect(() => {
    // Don't pin to bottom while a top-scroll lazy-load is prepending older
    // history — that path manages its own scroll restoration.
    if (lazyLoadingRef.current) return;
    const end = messagesEndRef.current;
    if (!end) return;

    // History arrives in multiple chat:history batches. Pinning on the first
    // batch caused the "user scrolled up" guard (distanceFromBottom > 80) to
    // misread the still-growing feed as intentional scroll — view opened above
    // the bottom. Fix: debounce the initial pin to fire only after a ~220ms
    // quiet period with no new batches. Resets on each new batch. Runs once
    // per mount; lazy-load top-scroll is guarded by lazyLoadingRef.
    if (!didInitialScrollRef.current && messages.length > 0) {
      // Cancel any previous pending pin and schedule a fresh one.
      if (initialScrollTimerRef.current !== null) {
        clearTimeout(initialScrollTimerRef.current);
      }
      initialScrollTimerRef.current = setTimeout(() => {
        initialScrollTimerRef.current = null;
        // Only pin if the user hasn't manually scrolled up to read history.
        // lazyLoadingRef guards the lazy-load path.
        if (lazyLoadingRef.current) return;
        didInitialScrollRef.current = true;
        scrollToBottom();
      }, 220);
      return;
    }

    // #313: Decide from the user's tracked intent (sampled during real scroll
    // events, see the stick-tracking effect below) — NOT from a distance reading
    // taken after a tall card was already appended, which reads as the card's
    // height and was misfiring the "user scrolled up" guard.
    if (!stickToBottomRef.current) return; // user scrolled up to read — don't yank them
    // Multi-pass pin so a tall card (and its async-loading image) lands fully in
    // view across the reflow frames, not a single-shot scrollIntoView that ends
    // up short.
    scrollToBottom();
  }, [messages, scrollToBottom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up the initial-scroll debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (initialScrollTimerRef.current !== null) {
        clearTimeout(initialScrollTimerRef.current);
      }
    };
  }, []);

  // #313: Track stick-to-bottom INTENT from real scroll events. Reading the
  // distance HERE (as the user scrolls) is what lets the auto-scroll effect
  // distinguish "user scrolled up to read history" from "a tall card was just
  // appended at the bottom" — the latter inflates a post-append distance reading
  // and used to misfire the guard. Always-on and seeded from the actual position
  // (never assumed pinned), independent of the lazy-load top-scroll listener
  // (which is gated off in public mode). The container is display-toggled, not
  // unmounted, so a single mount-time attach stays valid.
  useEffect(() => {
    const cont = messagesContRef.current;
    if (!cont) return;
    const onScroll = () => {
      stickToBottomRef.current = isNearBottom(cont.scrollHeight, cont.scrollTop, cont.clientHeight);
    };
    onScroll(); // seed from the current position
    cont.addEventListener('scroll', onScroll, { passive: true });
    return () => cont.removeEventListener('scroll', onScroll);
  }, []);

  // (a2) Activating the chat by clicking/focusing the input box → land at the
  // bottom (latest message). Covers the "click the chat input to type" path
  // (the Insert hotkey path is handled by the shell dispatching fcm-scroll-bottom
  // via onFocusInput). We listen for focusin on the input elements specifically
  // (NOT the message body) so clicking a message to read older history does NOT
  // yank the view to the bottom — only an explicit input activation does.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (t === richInputRef.current || t === inputRef.current) scrollToBottom();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [scrollToBottom]);

  // (a3) The typing indicator is a flexShrink:0 sibling BELOW the flex:1 message
  // scroll area, so when it appears/disappears the message area resizes. If the
  // user was at the bottom, the last (possibly multi-row wrapped) message gets
  // pushed under the indicator. Re-pin to bottom on each typing-visibility change
  // so the newest message stays fully visible above the indicator.
  const typingVisibleForScope = useMemo(() => {
    if (activeMainId === PM_MAIN_ID) return false;
    const isParty = activeMainId === PARTY_MAIN_ID && partyView !== 'browser';
    const activeScopeKey = isParty ? `party:${partyView}` : `ch:${activeSubId}`;
    const myId = user?.id ?? '';
    const now = Date.now();
    return Object.entries(typingUsers).some(([uid, v]) => uid !== myId && v.scopeKey === activeScopeKey && v.clearAt > now);
  }, [typingUsers, activeMainId, partyView, activeSubId, user?.id]);
  useEffect(() => {
    const cont = messagesContRef.current;
    if (!cont) return;
    // Generous threshold so the indicator's own height (~16px) isn't read as
    // "scrolled up". If the user genuinely scrolled up to read history, leave them.
    if (!isNearBottom(cont.scrollHeight, cont.scrollTop, cont.clientHeight, TYPING_INDICATOR_STICK_THRESHOLD)) return;
    const pin = () => { const c = messagesContRef.current; if (c) c.scrollTop = c.scrollHeight; };
    requestAnimationFrame(() => { pin(); requestAnimationFrame(pin); });
    setTimeout(pin, 50);
  }, [typingVisibleForScope]); // eslint-disable-line react-hooks/exhaustive-deps

  // (b) Channel / sub-tab switch OR main-tab switch → land at the bottom (latest
  // message). HARD RULE: opening a channel (e.g. Fallout 76 → General, including
  // coming back from the Party tab) must ALWAYS show the bottom, never the top.
  // Keyed on activeMainId too because Party → Fallout 76 often keeps the same
  // activeSubId (General), so an activeSubId-only effect wouldn't re-fire. Defers
  // a frame so the newly-filtered message nodes are painted first.
  useEffect(() => {
    if (!activeSubId) return;
    scrollToBottom();
  }, [activeSubId, activeMainId, scrollToBottom]);

  // (b2) Party view switch — scroll to bottom whenever the user opens or
  // switches to a party chat view (partyView changes to a party id).
  useEffect(() => {
    if (!partyView || partyView === 'browser') return;
    scrollToBottom();
  }, [partyView, scrollToBottom]);

  // (c) External request to scroll to bottom — the Electron shell dispatches
  // 'fcm-scroll-bottom' on overlay-expand so the view lands at the latest msg.
  useEffect(() => {
    const onScrollBottom = () => scrollToBottom();
    window.addEventListener('fcm-scroll-bottom', onScrollBottom);
    return () => window.removeEventListener('fcm-scroll-bottom', onScrollBottom);
  }, [scrollToBottom]);

  // (Lazy-load) Top-scroll handler: when the user scrolls near the TOP of the
  // message list, fetch the next older page for the visible channel(s) and
  // prepend it (the chat:history handler preserves scroll position). Guards
  // against overlapping fetches (lazyLoadingRef), end-of-history
  // (lazyEndReachedRef), and only runs on the authed WS path.
  useEffect(() => {
    const cont = messagesContRef.current;
    if (!cont || isPublicMode) return;
    const TOP_THRESHOLD = 60;
    const onScroll = () => {
      if (cont.scrollTop > TOP_THRESHOLD) return;
      if (lazyLoadingRef.current) return;
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      // Resolve which channel(s) the current view shows.
      const isMain = mainChannels.some(m => m.id === activeSubId);
      const activeChannel = [...mainChannels, ...mainChannels.flatMap(m => m.children || [])]
        .find(c => c.id === activeSubId);
      // Skip lazy-load for party views and the virtual server channel (their
      // history uses different paging semantics).
      if (activeMainId === PARTY_MAIN_ID || activeSubId.startsWith('server:')) return;
      const channelIds = isMain && activeChannel
        ? [activeSubId, ...((activeChannel as Channel).children || []).map(c => c.id)]
        : [activeSubId];
      // Pick the first channel that still has older history to fetch.
      const target = channelIds.find(id => !lazyEndReachedRef.current.has(id));
      if (!target) return;
      const offset = lazyLoadedCountRef.current.get(target) || 0;
      lazyLoadingRef.current = true;
      pendingLazyChannelRef.current = target;
      ws.send(JSON.stringify({
        type: 'chat:history',
        payload: { channelId: target, limit: HISTORY_PAGE, offset },
      }));
      // Safety: if no history frame comes back, release the lock after 5s.
      setTimeout(() => {
        if (pendingLazyChannelRef.current === target) {
          lazyLoadingRef.current = false;
          pendingLazyChannelRef.current = null;
        }
      }, 5000);
    };
    cont.addEventListener('scroll', onScroll, { passive: true });
    return () => cont.removeEventListener('scroll', onScroll);
  }, [activeSubId, activeMainId, mainChannels, isPublicMode]);

  // SR-012: cancel mention debounce on unmount
  useEffect(() => () => { if (mentionDebounce.current) clearTimeout(mentionDebounce.current); }, []);

  // Reset invite submenu when ctxMenu closes
  useEffect(() => { if (!ctxMenu) setCtxMenuInviteSubmenu(false); }, [ctxMenu]);

  // Close context menu on any click outside it (document-level, so it doesn't eat the click)
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => { setCtxMenu(null); setCtxMenuInviteSubmenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  // Keep the right-click context menu fully inside the window. After it renders
  // at the cursor position, measure it and shift it back in by however much it
  // overflows the right/bottom edges (flipping above/left of the cursor when
  // there isn't room below/right). Only adjusts on overflow, so when there's
  // room the menu stays exactly at the cursor as before.
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const el = ctxMenuRef.current;
    if (!el) return;
    const GAP = 6;
    const r = el.getBoundingClientRect();
    let left = ctxMenu.x;
    let top = ctxMenu.y;
    if (left + r.width + GAP > window.innerWidth) {
      // flip to the left of the cursor, then clamp so it never goes off-screen.
      left = Math.max(GAP, window.innerWidth - r.width - GAP);
    }
    if (top + r.height + GAP > window.innerHeight) {
      top = Math.max(GAP, window.innerHeight - r.height - GAP);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // If the menu is taller than the viewport, cap it and scroll internally.
    el.style.maxHeight = `${window.innerHeight - GAP * 2}px`;
    el.style.overflowY = 'auto';
  }, [ctxMenu]);

  // "Invite to Party" flyout — a SEPARATE popover anchored to the parent context
  // menu's right edge (flipping to its left edge / clamping vertically when there
  // isn't room). Portaled to <body> like every other menu so it escapes the
  // overlay's overflow:hidden and never clips out of frame.
  const ctxMenuInviteRef = useRef<HTMLDivElement>(null);
  // Ref on the "Invite to Party ▸" menu item so the flyout can align vertically
  // with that specific row rather than the parent menu's top edge.
  const ctxMenuInviteItemRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu || !ctxMenuInviteSubmenu) return;
    const flyout = ctxMenuInviteRef.current;
    const parent = ctxMenuRef.current;
    if (!flyout || !parent) return;
    const GAP = 4;
    const pr = parent.getBoundingClientRect();
    const fr = flyout.getBoundingClientRect();
    // Align flyout's top to the "Invite to Party" row when the ref is available;
    // fall back to the parent menu's top if it isn't yet (first render race).
    const itemRef = ctxMenuInviteItemRef.current;
    const anchorTop = itemRef ? itemRef.getBoundingClientRect().top : pr.top;
    // Default: open to the right of the parent menu, at the item's row.
    let left = pr.right + GAP;
    let top = anchorTop;
    // Flip to the left of the parent if it would overflow the right edge.
    if (left + fr.width + GAP > window.innerWidth) {
      left = pr.left - fr.width - GAP;
    }
    // If still off-screen left (very narrow window), clamp inside.
    if (left < GAP) left = Math.max(GAP, window.innerWidth - fr.width - GAP);
    // Clamp vertically so the bottom/top never leaves the window.
    if (top + fr.height + GAP > window.innerHeight) {
      top = Math.max(GAP, window.innerHeight - fr.height - GAP);
    }
    if (top < GAP) top = GAP;
    flyout.style.left = `${left}px`;
    flyout.style.top = `${top}px`;
    flyout.style.maxHeight = `${window.innerHeight - GAP * 2}px`;
    flyout.style.overflowY = 'auto';
  }, [ctxMenu, ctxMenuInviteSubmenu, parties]);

  // Clamp partyTabCtx menu to window bounds (same logic as ctxMenu above).
  const partyTabCtxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!partyTabCtx) return;
    const el = partyTabCtxRef.current;
    if (!el) return;
    const GAP = 6;
    const r = el.getBoundingClientRect();
    let left = partyTabCtx.x;
    let top = partyTabCtx.y;
    if (left + r.width + GAP > window.innerWidth) left = Math.max(GAP, window.innerWidth - r.width - GAP);
    if (top + r.height + GAP > window.innerHeight) top = Math.max(GAP, window.innerHeight - r.height - GAP);
    if (left < GAP) left = GAP;
    if (top < GAP) top = GAP;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.maxHeight = `${window.innerHeight - GAP * 2}px`;
    el.style.overflowY = 'auto';
  }, [partyTabCtx]);

  // Clamp memberCtx menu to window bounds.
  const memberCtxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!memberCtx) return;
    const el = memberCtxRef.current;
    if (!el) return;
    const GAP = 6;
    const r = el.getBoundingClientRect();
    let left = memberCtx.x;
    let top = memberCtx.y;
    if (left + r.width + GAP > window.innerWidth) left = Math.max(GAP, window.innerWidth - r.width - GAP);
    if (top + r.height + GAP > window.innerHeight) top = Math.max(GAP, window.innerHeight - r.height - GAP);
    if (left < GAP) left = GAP;
    if (top < GAP) top = GAP;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.maxHeight = `${window.innerHeight - GAP * 2}px`;
    el.style.overflowY = 'auto';
  }, [memberCtx]);

  const handleMainClick = useCallback((mainId: string) => {
    setActiveMainId(mainId);
    // Never land on the main "Fallout 76" channel itself — nobody chats in the
    // main channel. Default to its General sub-channel (or the first sub if
    // General is absent). This replaces the old combined-feed-on-main behavior.
    const main = (channelsRaw || []).find(c => c.id === mainId);
    const subs = main?.children || [];
    const general = subs.find(s => s.name?.toLowerCase() === 'general') ?? subs[0];
    setActiveSubId(general ? general.id : mainId);
  }, [channelsRaw]);

  // Sync autocomplete visibility with input changes
  useEffect(() => {
    if (inputText.startsWith('/') && acSuggestions.length > 0) {
      setAcOpen(true);
      setAcIndex(acSuggestions.length - 1); // default: bottom item highlighted (matches desktop)
    } else {
      setAcOpen(false);
    }
  }, [inputText, acSuggestions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectAcSuggestion(cmd: SlashCommand) {
    const nextText = cmd.trigger + ' ';
    // Land the caret at the END of the completed command, not wherever it sat
    // mid-typing (the rich-input sync effect would otherwise restore the saved
    // offset and drop the caret into the middle of the command).
    caretToEndRef.current = true;
    setInputText(nextText);
    setAcOpen(false);
    if (richInputRef.current) {
      richInputRef.current.focus();
    } else if (inputRef.current) {
      // Website plain-textarea path: place caret at end directly (no rich sync effect).
      const ta = inputRef.current;
      ta.focus();
      requestAnimationFrame(() => { ta.setSelectionRange(nextText.length, nextText.length); });
    }
  }

  // ── Wiki autocomplete effect ──────────────────────────────────────────────
  // Activates when inputText starts with '/wiki ' and >=2 chars of term.
  // Mutually exclusive with slash-command autocomplete (ac* state).
  // Uses useDebouncedSearch for debounce, AbortController, and stale-result guard.
  const _wikiAcTerm = inputText.startsWith('/wiki ')
    ? inputText.slice('/wiki '.length).trimStart()
    : null;
  useDebouncedSearch<WikiSearchResult>({
    term: _wikiAcTerm,
    minLength: 2,
    delay: 280,
    onDeactivate: () => { if (wikiAcOpen) { setWikiAcOpen(false); setWikiAcItems([]); } },
    onHint: () => { setWikiAcItems([]); setWikiAcLoading(false); setWikiAcOpen(true); },
    onClearStale: () => { setWikiAcItems([]); setWikiAcIndex(0); },
    onSearch: async (term, signal) => {
      const res = await fetch(`/api/wiki/search?q=${encodeURIComponent(term)}&limit=8`, { signal });
      if (!res.ok) throw new Error('search failed');
      const json = await res.json();
      return json.data ?? [];
    },
    onResults: (items) => { setWikiAcItems(items); setWikiAcOpen(true); setWikiAcIndex(0); },
    onLoading: setWikiAcLoading,
    onError: () => setWikiAcOpen(true), // show "search unavailable" row
  });

  function selectWikiAcItem(item: WikiSearchResult) {
    setInputText('');
    if (richInputRef.current) richInputRef.current.innerHTML = '';
    setWikiAcOpen(false);
    setWikiAcItems([]);
    // Use the clean display NAME (not wikiTitle) — the panel fetches the entry
    // directly by name. NEVER pass the wiki title here: a "(Fallout 76)" suffix
    // gets fuzzy-matched to "Fallout 76 railways"/"roadways" and loads the wrong
    // article. getEntry resolves by name, so item.name → exact hit.
    setWikiPanelTerm(item.name);
    setWikiPanelOpen(true);
    if (richInputRef.current) richInputRef.current.focus();
    else inputRef.current?.focus();
  }

  function openWikiPanel(term: string, exact = false) {
    setInputText('');
    if (richInputRef.current) richInputRef.current.innerHTML = '';
    setWikiAcOpen(false);
    setWikiAcItems([]);
    setWikiPanelTerm(term);
    setWikiPanelExact(exact);
    setWikiPanelOpen(true);
  }

  // ── CAMP autocomplete effect ───────────────────────────────────────────────
  // Activates when inputText starts with '/camp ' and >=2 chars of term.
  // Mutually exclusive with slash-command and wiki autocompletes.
  // Uses useDebouncedSearch for debounce, AbortController, and stale-result guard.
  const _campAcTerm = inputText.startsWith('/camp ')
    ? inputText.slice('/camp '.length).trimStart()
    : null;
  useDebouncedSearch<{ name: string; category: string; subCategory: string; imageUrl: string | null }>({
    term: _campAcTerm,
    minLength: 2,
    delay: 280,
    onDeactivate: () => { if (campAcOpen) { setCampAcOpen(false); setCampAcItems([]); } },
    onHint: () => { setCampAcItems([]); setCampAcLoading(false); setCampAcOpen(true); },
    onClearStale: () => { setCampAcItems([]); setCampAcIndex(0); },
    onSearch: async (term, signal) => {
      const res = await fetch(`/api/camp/search?q=${encodeURIComponent(term)}&limit=8`, { signal });
      if (!res.ok) throw new Error('search failed');
      const json = await res.json();
      return (json.data ?? []).map((r: { name: string; category: string; subCategory: string; imageUrl?: string | null }) => ({ ...r, imageUrl: r.imageUrl ?? null }));
    },
    onResults: (items) => { setCampAcItems(items); setCampAcOpen(true); setCampAcIndex(0); },
    onLoading: setCampAcLoading,
    onError: () => setCampAcOpen(true),
  });

  function selectCampAcItem(item: { name: string; category: string; subCategory: string; imageUrl: string | null }) {
    // Load the highlighted item immediately — send the /camp command for it (the
    // backend replies with an ephemeral card), instead of only filling the input.
    setCampAcOpen(false);
    setCampAcItems([]);
    setInputText('');
    if (richInputRef.current) richInputRef.current.innerHTML = '';
    sendChatMessage(`/camp ${item.name}`, activeSubId);
    if (richInputRef.current) richInputRef.current.focus();
    else inputRef.current?.focus();
  }

  async function handleWikiShareToChat(entry: WikiEntry, channelId: string) {
    // No external URL — the in-feed card is a clickable link that opens the entry
    // in the OVERLAY (via the wiki_share metadata). The plain content is just a
    // fallback label for the Discord bridge / non-card clients.
    const content = `[WIKI] ${entry.name}`;
    sendOrQueueChat({
      type: 'chat:send',
      payload: {
        content,
        channelId,
        clientCreatedAt: new Date().toISOString(),
        metadata: {
          type: 'wiki_share',
          wikiEntryId: entry.id,
          name: entry.name,
          kind: entry.kind,
          wikiTitle: entry.wikiTitle,
        },
      },
    });
  }

  // ── @ mention helpers ──────────────────────────────────────────────────────
  function getMentionAt(text: string, cursor: number): { query: string; atStart: number } | null {
    const before = text.slice(0, cursor);
    const match = before.match(/(?:^|[\s,])@(\w{0,32})$/);
    if (!match) return null;
    return { query: match[1], atStart: before.lastIndexOf('@') };
  }

  function fetchMentionSuggestions(q: string) {
    if (mentionDebounce.current) clearTimeout(mentionDebounce.current);
    if (q.length === 0) { setMentionSuggestions([]); setMentionOpen(false); return; }
    mentionDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/mention-search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const json = await res.json();
        const list = (json.data ?? []).slice(0, 4);
        setMentionSuggestions(list);
        setMentionOpen(list.length > 0);
        setMentionIdx(0);
      } catch { /* non-critical */ }
    }, 180);
  }

  function selectMention(displayName: string, discordId?: string | null) {
    const meta = mentionMeta;
    if (!meta) return;
    const cursor = inputRef.current?.selectionStart ?? inputText.length;
    const live = getMentionAt(inputText, cursor) ?? meta;
    const next = inputText.slice(0, live.atStart) + '@' + displayName + ' ' + inputText.slice(live.atStart + 1 + live.query.length);
    setInputText(next.slice(0, 255));
    setMentionOpen(false);
    setMentionSuggestions([]);
    setMentionMeta(null);
    // Remember the Discord ID so the relay can ping exactly this user.
    if (discordId && !pendingMentionsRef.current.some(p => p.name === displayName && p.discordId === discordId)) {
      pendingMentionsRef.current.push({ name: displayName, discordId });
    }
    if (richInputRef.current) richInputRef.current.focus();
    else inputRef.current?.focus();
  }

  function insertMentionFromClick(displayName: string) {
    const textarea = inputRef.current;
    if (textarea) {
      const start = textarea.selectionStart ?? inputText.length;
      const end = textarea.selectionEnd ?? start;
      const next = buildMentionInsert(inputText, displayName, start, end);
      const afterLen = inputText.slice(end).length;
      const newCaret = Math.max(0, next.length - afterLen);
      setInputText(next);
      requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCaret, newCaret);
      });
      return;
    }
    if (richInputRef.current) {
      const next = buildMentionInsert(inputText, displayName, inputText.length, inputText.length);
      setInputText(next);
      richInputRef.current.innerHTML = buildRichHtml(next);
      requestAnimationFrame(() => {
        if (!richInputRef.current) return;
        richInputRef.current.focus();
        const r = document.createRange();
        r.selectNodeContents(richInputRef.current);
        r.collapse(false);
        const s = window.getSelection();
        if (s) { s.removeAllRanges(); s.addRange(r); }
      });
    }
  }

  // ── Offline outbox helper ─────────────────────────────────────────────────
  // Sends a chat:send frame immediately when the WS is open, or queues it for
  // automatic flush on the next reconnect. Inert in public mode.
  const sendOrQueueChat = useCallback((frame: object) => {
    const ws = wsRef.current;
    const json = JSON.stringify(frame);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else if (!isPublicMode) {
      outboxRef.current.enqueue(json, Date.now());
      setOutboxCount(outboxRef.current.size());
    }
  }, [isPublicMode]);

  // Build + send/queue a plain chat:send frame. Centralizes the payload shape
  // (clientCreatedAt stamping, mentions default) shared by every text send site.
  // Log any emoji (native or custom) in an OUTGOING message into the recent-emoji
  // store, so typing+sending an emoji surfaces it in the picker's Recent row the
  // same as clicking it from the picker. Newest-first, deduped, capped at
  // RECENT_EMOJI_LIMIT — all enforced by recordRecentEmoji/save.
  const recordSentEmojis = useCallback((content: string) => {
    const tokens = extractEmojiTokens(content);
    if (tokens.length === 0) return;
    let next = loadRecentEmojiTokens();
    for (const token of tokens) next = recordRecentEmoji(next, token);
    saveRecentEmojiTokens(next);
  }, []);

  const sendChatMessage = useCallback((content: string, channelId: string, mentions: { name: string; discordId: string }[] = []) => {
    recordSentEmojis(content);
    sendOrQueueChat({
      type: 'chat:send',
      payload: { content, channelId, clientCreatedAt: new Date().toISOString(), mentions },
    });
  }, [sendOrQueueChat, recordSentEmojis]);

  // Send a party:send frame. Unlike chat:send, party messages are NEVER queued
  // (party state may be stale after a reconnect), so this no-ops when the WS is
  // down. Callers still guard their own input/focus flow on wsOpen.
  const sendPartyMessage = useCallback((partyId: string, content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    recordSentEmojis(content);
    ws.send(JSON.stringify({ type: 'party:send', payload: { partyId, content } }));
  }, [recordSentEmojis]);

  const openPrivateConversation = useCallback((targetUserId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'pm:open', payload: { targetUserId } }));
  }, []);

  const sendPrivateMessageFrame = useCallback((conversationId: string, recipientUserId: string, content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    recordSentEmojis(content);
    ws.send(JSON.stringify({
      type: 'pm:send',
      payload: {
        conversationId,
        recipientUserId,
        content,
        clientCreatedAt: new Date().toISOString(),
      },
    }));
  }, [recordSentEmojis]);

  // Send a throttled chat:typing frame (once per 2s per scope).
  const sendTyping = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (activeMainId === PM_MAIN_ID) return;
    const isParty = activeMainId === PARTY_MAIN_ID && partyView !== 'browser';
    const scopeKey = isParty ? `party:${partyView}` : `ch:${activeSubId}`;
    const now = Date.now();
    if ((typingLastSentRef.current[scopeKey] || 0) + 2000 > now) return;
    typingLastSentRef.current[scopeKey] = now;
    ws.send(JSON.stringify({
      type: 'chat:typing',
      payload: isParty ? { partyId: partyView } : { channelId: activeSubId },
    }));
  }, [activeMainId, activeSubId, partyView]);

  // ── Card share helpers ────────────────────────────────────────────────────
  // 1-minute cooldown so the "Send to chat" button can't spam-broadcast cards.
  const [cardShareCooldown, setCardShareCooldown] = useState(false);
  const lastCardShareRef = useRef(0);
  const shareCardToChat = useCallback((opts: { command: string; label: string; accent: string; icon: string }) => {
    if (!activeSubId) return;
    if (Date.now() - lastCardShareRef.current < 60_000) return; // cooldown active — ignore
    // Source attribution link for the shared post (like "Fallout Wiki ↗" on wiki shares).
    const src = opts.command.startsWith('/camp')
      ? { sourceName: '76 CAMP Database', sourceUrl: 'https://mrsblobby.github.io/76-CAMPDatabase/Live/' }
      : opts.command.startsWith('/nukecodes')
        ? { sourceName: 'NukaCrypt', sourceUrl: 'https://nukacrypt.com' }
        : opts.command.startsWith('/serverstatus')
          ? { sourceName: 'Bethesda', sourceUrl: 'https://bethesda.net/en/status' }
          : { sourceName: undefined, sourceUrl: undefined };
    sendOrQueueChat({
      type: 'chat:send',
      payload: {
        // Non-empty content is REQUIRED — the backend drops empty messages. It's
        // the fallback/Discord/history text; the card_share metadata renders the
        // styled inline link in-overlay.
        content: `${opts.icon} ${opts.label} ↗`,
        channelId: activeSubId,
        clientCreatedAt: new Date().toISOString(),
        mentions: [],
        metadata: {
          type: 'card_share',
          command: opts.command,
          label: opts.label,
          accent: opts.accent,
          icon: opts.icon,
          sourceName: src.sourceName,
          sourceUrl: src.sourceUrl,
        } satisfies CardShareMetadata,
      },
    });
    lastCardShareRef.current = Date.now();
    setCardShareCooldown(true);
    setTimeout(() => setCardShareCooldown(false), 60_000);
  }, [activeSubId]);

  /** Re-run a shared card command on the caller's own client (produces an ephemeral card). */
  const openSharedCard = useCallback((command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (!activeSubId) return;
    if (!/^\/(nukecodes|serverstatus|camp|minerva)\b/.test(command)) return;
    wsRef.current.send(JSON.stringify({
      type: 'chat:send',
      payload: {
        content: command,
        channelId: activeSubId,
        clientCreatedAt: new Date().toISOString(),
        mentions: [],
      },
    }));
  }, [activeSubId]);

  const handleSend = useCallback(() => {
    setOpenPicker(null);
    const text = inputText.trim();
    if (!text) return;
    // party:send paths require an active connection (party state may be stale after
    // a reconnect; never queue them). chat:send paths go through sendOrQueueChat which
    // will queue them if the WS is down.
    const wsOpen = wsRef.current?.readyState === WebSocket.OPEN;

    if (activeMainId === PM_MAIN_ID && pmView !== 'inbox') {
      const conversation = privateConversations.find(entry => entry.conversationId === pmView);
      if (!wsOpen || !conversation) return;
      sendPrivateMessageFrame(pmView, conversation.otherUserId, text);
      setInputText('');
      if (richInputRef.current) richInputRef.current.innerHTML = '';
      if (richInputRef.current) richInputRef.current.focus();
      else inputRef.current?.focus();
      return;
    }

    // Client-side relay: intercept /g /t /e /r /i /s so they always go to the
    // correct target channel regardless of which sub-tab is active.
    const spaceIdx = text.indexOf(' ');
    const trigger  = (spaceIdx < 0 ? text : text.slice(0, spaceIdx)).toLowerCase();
    const args     = spaceIdx < 0 ? '' : text.slice(spaceIdx + 1).trim();
    const relay    = BUILTIN_RELAYS.find(b => b.cmd.trigger === trigger);

    // /wiki <term> — open the wiki panel with best-match lookup instead of sending.
    if (trigger === '/wiki') {
      if (args.length >= 1) openWikiPanel(args);
      setInputText('');
      if (richInputRef.current) richInputRef.current.innerHTML = '';
      return;
    }

    // /camp <item> — send to backend; reply is an ephemeral camp_item card.
    if (trigger === '/camp') {
      setInputText('');
      if (richInputRef.current) richInputRef.current.innerHTML = '';
      setCampAcOpen(false);
      setCampAcItems([]);
      if (!args) return;
      const campMentions = pendingMentionsRef.current.slice();
      pendingMentionsRef.current = [];
      sendChatMessage(text, activeSubId, campMentions);
      return;
    }

    // /recent (/rp) — send message to the most-recently-active party,
    // or if no args: jump to that party's tab.
    if (trigger === '/recent' || trigger === '/rp') {
      const pid = recentPartyIdRef.current;
      if (!pid) {
        // No recent party — no-op (clear input silently)
        setInputText('');
        if (richInputRef.current) richInputRef.current.innerHTML = '';
        return;
      }
      if (!args) {
        // No message body → navigate to the party tab (original /recent behaviour).
        setInputText('');
        if (richInputRef.current) richInputRef.current.innerHTML = '';
        jumpToRecentParty();
        return;
      }
      // Message body provided → send to that party (requires live connection).
      if (!wsOpen) return;
      setInputText('');
      if (richInputRef.current) richInputRef.current.innerHTML = '';
      if (richInputRef.current) richInputRef.current.focus();
      else inputRef.current?.focus();
      sendPartyMessage(pid, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).relayBridge?.returnToGame?.();
      return;
    }

    // /p1 /p2 /p3 — send message to the Nth joined party (1-based, left-to-right order).
    const partyIdxMatch = trigger.match(/^\/p([123])$/);
    if (partyIdxMatch) {
      const idx = parseInt(partyIdxMatch[1], 10) - 1;
      const targetParty = joinedParties[idx];
      setInputText('');
      if (richInputRef.current) richInputRef.current.innerHTML = '';
      if (!targetParty || !args) {
        // No such party or no message body — no-op
        if (richInputRef.current) richInputRef.current.focus();
        else inputRef.current?.focus();
        return;
      }
      if (!wsOpen) return; // party:send requires live connection
      sendPartyMessage(targetParty.id, args);
      if (richInputRef.current) richInputRef.current.focus();
      else inputRef.current?.focus();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).relayBridge?.returnToGame?.();
      return;
    }

    const mentions = pendingMentionsRef.current.slice();
    pendingMentionsRef.current = [];

    if (relay) {
      setInputText('');
      inputRef.current?.focus();
      if (!args) return; // no message — ignore silently (autocomplete shows usage)
      if (relay.channelId === null) return; // /s not available from web overlay
      sendChatMessage(args, relay.channelId, mentions);
      // Electron only: signal the shell to return focus to FO76 after send.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).relayBridge?.returnToGame?.();
      return;
    }

    // Party send: when the Party main tab is active and viewing a specific party
    // (requires live connection — party:send is never queued)
    if (activeMainId === PARTY_MAIN_ID && partyView !== 'browser') {
      if (!wsOpen) return;
      sendPartyMessage(partyView, text);
      setInputText('');
      if (richInputRef.current) richInputRef.current.innerHTML = '';
      if (richInputRef.current) richInputRef.current.focus();
      else inputRef.current?.focus();
      // Electron only: signal the shell to return focus to FO76 after send.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).relayBridge?.returnToGame?.();
      return;
    }

    // Never send to the main "Fallout 76" channel — it's a tab/feed only, not a
    // chat room. (handleMainClick already routes main-tab clicks to General; this
    // is defense-in-depth so a stray main-channel id can't post there.)
    if (mainChannels.some(m => m.id === activeSubId)) return;

    sendChatMessage(text, activeSubId, mentions);
    setInputText('');
    if (richInputRef.current) richInputRef.current.innerHTML = '';
    if (richInputRef.current) richInputRef.current.focus();
    else inputRef.current?.focus();
    // Electron only: signal the shell to return focus to FO76 after send.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).relayBridge?.returnToGame?.();
  }, [inputText, activeSubId, mainChannels, joinedParties, sendChatMessage, sendPartyMessage, activeMainId, pmView, privateConversations, sendPrivateMessageFrame]); // eslint-disable-line react-hooks/exhaustive-deps

  // Moderation actions
  async function executeModAction(body: any) {
    if (!modModal) return;
    const { action, target, isServerMsg } = modModal;
    setModLoading(true);
    setModError(null);
    try {
      if (action === 'delete') {
        if (isServerMsg) {
          await api.delete(`/api/presence/server-messages/${target.id}`);
          setFeedMessages(prev => prev.filter(m => m.id !== target.id));
        } else {
          await api.delete(`/api/messages/${target.id}`);
          setMessages(prev => prev.filter(m => m.id !== target.id));
        }
      } else if (action === 'mute') {
        await api.post(`/api/users/${target.userId}/mute`, { duration: body.duration, reason: body.reason });
      } else if (action === 'kick') {
        await api.post(`/api/users/${target.userId}/kick`);
      } else if (action === 'ban') {
        await api.post(`/api/users/${target.userId}/ban`, { reason: body.reason });
      }
      setModModal(null);
    } catch (err: any) {
      setModError(err.message);
    } finally {
      setModLoading(false);
    }
  }

  const activeMain = mainChannels.find(c => c.id === activeMainId);
  const subChannels = activeMain?.children || [];
  const isOnPmTab = activeMainId === PM_MAIN_ID;
  const activePmConversation = privateConversations.find(c => c.conversationId === pmView) ?? null;
  const pmMainUnread = privateConversations.reduce((sum, conversation) => sum + (conversation.unreadCount || 0), 0);
  const flattenedChannels = useMemo(
    () => [...mainChannels, ...mainChannels.flatMap(m => m.children || [])],
    [mainChannels]
  );

  // Channel IDs the viewer has hidden (resolved from the "Hidden channels" name
  // filter). Used to drop their messages from the feed and to hide their sub-tabs.
  const hiddenChannelIds = useMemo(
    () => hiddenChannelIdSet(settings.channelFilters, flattenedChannels),
    [settings.channelFilters, flattenedChannels],
  );

  // If the user hides the channel they're currently viewing directly, its sub-tab
  // vanishes — redirect them to the aggregated feed so the hidden channel doesn't
  // linger in view. (No-op in the common case: hiding from the feed, where
  // activeSubId isn't the hidden channel.)
  useEffect(() => {
    // The `!== activeMainId` guard prevents an effect loop if the redirect target
    // (the main feed) were itself somehow in the hidden set.
    if (activeSubId && activeSubId !== activeMainId && hiddenChannelIds.has(activeSubId)) {
      setActiveSubId(activeMainId);
    }
  }, [hiddenChannelIds, activeSubId, activeMainId]);

  const activeSub = flattenedChannels.find(c => c.id === activeSubId);
  // GIFs default OFF (shown only when explicitly enabled); emojis default ON
  // (hidden only when explicitly disabled) — keeps the emoji picker available
  // even against a backend that predates these per-channel flags.
  const activeChannelAllowsGifs = activeSub?.allowGifs === true;
  const activeChannelAllowsEmojis = activeSub?.allowEmojis !== false;
  const isMainAsFeed = mainChannels.some(m => m.id === activeSubId);
  const isGeneralSubFeed = !!activeSub && activeSub.parentId != null
    && activeSub.name?.toLowerCase() === 'general';
  const isMainFeedView = isMainAsFeed || isGeneralSubFeed;

  const feedParent = isGeneralSubFeed
    ? mainChannels.find(m => m.id === activeSub?.parentId)
    : activeMain;

  // Keep the view context current (for live mention detection) and clear unread
  // badges for whatever channel(s) I'm now looking at.
  useEffect(() => {
    const feedId = isMainFeedView && feedParent ? feedParent.id : null;
    const feedChildIds = isMainFeedView && feedParent ? (feedParent.children || []).map(c => c.id) : [];
    const activePartyId = (activeMainId === PARTY_MAIN_ID && partyView !== 'browser') ? partyView : null;
    viewCtxRef.current = { activeSubId, feedId, feedChildIds, activePartyId };
    jumpIdxRef.current = 0;
    // NOTE: do NOT clear dismissedMentionIdsRef on channel switch — dismissed
    // mentions must stay dismissed across tab changes. A dismissed mention
    // should never re-appear; only genuinely new mentions show the button.
    setUnreadMentions(prev => {
      const clearIds = feedId ? [feedId, ...feedChildIds] : [activeSubId];
      if (!clearIds.some(id => prev[id])) return prev;
      const next = { ...prev };
      for (const id of clearIds) delete next[id];
      return next;
    });
  }, [activeSubId, isMainFeedView, feedParent, activeMainId, partyView]);

  const visibleMessages = useMemo(() => {
    // Client-side block filter backstop (server enforcement is primary): hide
    // messages authored by a blocked user. Never hides your own / system / bot.
    const notBlocked = (m: ChatMessage) =>
      !m.userId || m.userId === (user?.id ?? '') || !blockedIds.has(m.userId);
    if (activeMainId === PM_MAIN_ID && pmView !== 'inbox') {
      return (privateMessages[pmView] ?? []).filter(notBlocked);
    }
    // Party in-chat view: messages keyed by partyId (partyId === channelId in the message)
    if (activeMainId === PARTY_MAIN_ID && partyView !== 'browser') {
      return messages.filter(m => m.channelId === partyView && notBlocked(m));
    }
    if (isMainFeedView && feedParent) {
      const childIds = (feedParent.children || []).map(c => c.id);
      // Auth side: feed messages from the user's JOINED parties. Public side:
      // feed messages from all PUBLIC parties (visitors join nothing). Either
      // way the messages carry source === 'party' and render the [PartyName] tag.
      // Privileged mods (isMod && !isPublicMode) also see foreign-party messages
      // here inline via shouldShowInMainFeed — server-enforced, never in public mode.
      const feedPartyIds = isPublicMode
        ? (publicPartyIdKey ? publicPartyIdKey.split(',') : [])
        : joinedParties.map(p => p.id);
      return messages
        .filter(m =>
          shouldShowInMainFeed(m, {
            feedParentId: feedParent.id,
            childIds,
            feedPartyIds,
            isMod,
            isPublicMode,
          }) &&
          // Drop messages from channels the viewer hid (e.g. Trading) out of the
          // aggregated feed.
          !hiddenChannelIds.has(m.channelId) &&
          notBlocked(m)
        );
    }
    return messages.filter(m => m.channelId === activeSubId && notBlocked(m));
  }, [messages, activeSubId, isMainFeedView, feedParent, activeMainId, partyView, pmView, blockedIds, user?.id, joinedParties, isPublicMode, publicPartyIdKey, isMod, hiddenChannelIds, privateMessages]);

  // After a mention-badge click switched channel, run the scroll once the new
  // channel's messages have rendered into the DOM (this effect re-runs whenever
  // the visible set / active sub changes).
  useEffect(() => {
    if (!pendingJumpRef.current) return;
    pendingJumpRef.current = false;
    // Defer one frame so the message nodes (incl. [data-mention-msg]) are painted.
    const id = requestAnimationFrame(() => { jumpIdxRef.current = 0; jumpToMention(); });
    return () => cancelAnimationFrame(id);
  }, [visibleMessages, activeSubId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which visible messages mention me (for jump-to-mention).
  const msgMentionsMe = useCallback((m: ChatMessage) =>
    m.userId !== myUserIdRef.current && myNamesRef.current.some(n => contentMentionsName(m.content, n)),
  []);
  // Show the jump button only when there is at least one visible mention whose
  // message id has NOT yet been dismissed. dismissedMentionEpoch is bumped each
  // time we add to the dismissed set so this recomputes correctly.
  // NOTE: hasMentionsInView is kept for any internal scroll/dismiss logic but is
  // no longer used to gate the central jump button (see hasCrossChannelMention below).
  const hasMentionsInView = useMemo(
    () => visibleMessages.some(m => msgMentionsMe(m) && !dismissedMentionIdsRef.current.has(m.id)),
    [visibleMessages, dismissedMentionEpoch], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Cross-channel unread mention: any channel OTHER than the one currently in view
  // has an undismissed @mention badge. This drives the central "Jump to mention"
  // button — we suppress the button for the active channel (the user can already
  // see those messages) and show it only for mentions elsewhere.
  const hasCrossChannelMention = useMemo(() => {
    const v = viewCtxRef.current;
    return Object.entries(unreadMentions).some(([chId, n]) => {
      if (n <= 0) return false;
      // Is this channel currently in view?
      const inView = v.feedId
        ? (chId === v.feedId || v.feedChildIds.includes(chId))
        : chId === v.activeSubId;
      return !inView;
    });
  }, [unreadMentions, activeSubId]); // eslint-disable-line react-hooks/exhaustive-deps
  // For the cross-channel jump button: find the channel with the most unread cross-
  // channel mentions so clicking the button navigates to the right place.
  const crossChannelJumpTarget = useMemo((): Channel | null => {
    const v = viewCtxRef.current;
    let bestChannel: Channel | null = null;
    let bestCount = 0;
    for (const ch of mainChannels) {
      const allIds = [ch.id, ...(ch.children || []).map(s => s.id)];
      const total = allIds.reduce((s, id) => {
        const inView = v.feedId
          ? (id === v.feedId || v.feedChildIds.includes(id))
          : id === v.activeSubId;
        return s + (!inView ? (unreadMentions[id] || 0) : 0);
      }, 0);
      if (total > bestCount) { bestCount = total; bestChannel = ch; }
    }
    return bestChannel;
  }, [unreadMentions, activeSubId, mainChannels]); // eslint-disable-line react-hooks/exhaustive-deps
  const persistDismissed = () => {
    try {
      localStorage.setItem('fcm-dismissed-mentions', JSON.stringify([...dismissedMentionIdsRef.current]));
    } catch { /* ignore */ }
  };
  const jumpToMention = () => {
    const cont = messagesContRef.current;
    if (!cont) return;
    const nodes = cont.querySelectorAll('[data-mention-msg="1"]');
    if (nodes.length === 0) {
      // No DOM nodes — dismiss all visible mention ids so the button goes away.
      visibleMessages.filter(msgMentionsMe).forEach(m => dismissedMentionIdsRef.current.add(m.id));
      persistDismissed();
      setDismissedMentionEpoch(e => e + 1);
      return;
    }
    const i = jumpIdxRef.current % nodes.length;
    jumpIdxRef.current = i + 1;
    nodes[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Mark the message at this index as dismissed by its data attribute or id.
    const el = nodes[i] as HTMLElement;
    const msgId = el.dataset.msgId ?? el.id;
    if (msgId) { dismissedMentionIdsRef.current.add(msgId); persistDismissed(); }
    // If no more undismissed mentions remain, bump epoch to hide the button.
    const anyUndismissed = visibleMessages.some(
      m => msgMentionsMe(m) && !dismissedMentionIdsRef.current.has(m.id),
    );
    if (!anyUndismissed) setDismissedMentionEpoch(e => e + 1);
  };

  // Clicking an unread @mention badge: switch to the channel that holds the
  // mention, then scroll the mentioning message into view. The scroll can't run
  // synchronously because the target channel's messages haven't rendered yet —
  // we set pendingJumpRef and a post-render effect (keyed on visibleMessages /
  // activeSubId) fires jumpToMention on the next tick. Works cross-channel:
  //   - MAIN badge: activate the main, then pick the sub with unread mentions
  //     (highest count) — or the main's General feed — as the active sub.
  //   - SUB badge: activate that sub directly.
  const jumpToMainMention = (e: React.MouseEvent, ch: Channel) => {
    e.stopPropagation();
    setActiveMainId(ch.id);
    // Prefer the sub-channel carrying the most unread mentions; fall back to the
    // main's own id (combined feed) if only the main itself is badged.
    const subs = ch.children || [];
    let bestId = (unreadMentions[ch.id] || 0) > 0 ? ch.id : '';
    let bestN = unreadMentions[ch.id] || 0;
    for (const s of subs) {
      const n = unreadMentions[s.id] || 0;
      if (n > bestN) { bestN = n; bestId = s.id; }
    }
    if (!bestId) {
      const general = subs.find(s => s.name?.toLowerCase() === 'general') ?? subs[0];
      bestId = general ? general.id : ch.id;
    }
    setActiveSubId(bestId);
    pendingJumpRef.current = true;
  };
  const jumpToSubMention = (e: React.MouseEvent, subId: string) => {
    e.stopPropagation();
    setActiveSubId(subId);
    pendingJumpRef.current = true;
  };

  // Unread @mention count for a main channel = its own + all its sub-channels'.
  const mainUnread = (ch: Channel) => {
    let t = unreadMentions[ch.id] || 0;
    for (const s of ch.children || []) t += unreadMentions[s.id] || 0;
    return t;
  };

  // Theme-accent unread pill, drawn left of a tab label.
  const UnreadBadge = ({ n, onClick }: { n: number; onClick?: (e: React.MouseEvent) => void }) => (
    <span
      onClick={onClick}
      title={onClick ? 'Jump to mention' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: '14px', height: '14px', padding: '0 4px', marginRight: '4px',
        borderRadius: '7px', background: primaryColor, color: bgRgba,
        fontSize: `${Math.max(7, fontSize - 3)}px`, fontWeight: 'bold', lineHeight: 1,
        verticalAlign: 'middle',
        cursor: onClick ? 'pointer' : 'inherit',
        ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
      }}
    >{n > 9 ? '9+' : n}</span>
  );

  // Render message content with @mention tokens highlighted in the theme accent,
  // and URLs as truncated clickable hyperlinks (full URL is the href).
  // `inPartyView`: true when rendering a message in a party chat view. Inline
  // image/GIF/video rendering is ONLY allowed in party views — in public/channel
  // views any media URL is rendered as a plain link (no inline img/video).
  // Cache rendered content by (scope|text), reset when the styling deps change.
  // Returning the SAME element array for unchanged message text lets React skip
  // reconciling those subtrees on unrelated re-renders (notably every keystroke in
  // the input) — the bulk of the "holding Backspace lags" cost was re-running
  // splitParts + rebuilding content nodes for all ~300 visible messages per key.
  const renderContentCache = useMemo(
    () => new Map<string, React.ReactNode>(),
    [primaryText, glowEnabled, primaryColor, textAlpha],
  );
  const renderContent = useCallback((content: string, inPartyView = false): React.ReactNode => {
    const ck = (inPartyView ? 'p|' : 'c|') + content;
    const cached = renderContentCache.get(ck);
    if (cached !== undefined) return cached;
    const out = splitParts(content).map((p, i) => {
      if (p.kind === 'mention') {
        return (
          <span key={i} style={{
            color: primaryText, fontWeight: 'bold',
            textShadow: glowEnabled ? `0 0 4px ${hexAlpha(primaryColor, 0.5 * textAlpha)}` : 'none',
          }}>{p.text}</span>
        );
      }
      if (p.kind === 'url' && p.url) {
        const media = inPartyView ? classifyMedia(p.url) : null;
        // Renderable image URL — render ONLY in party views. In channel views
        // fall through to the plain hyperlink below (no inline images).
        // Relative party-image URLs (/party-images/…) are resolved via
        // resolveMediaUrl so they load in the Electron overlay too.
        if (media === 'image') {
          const src = resolveMediaUrl(p.url);
          return (
            <span key={i} onClick={e => { e.stopPropagation(); e.preventDefault(); setLightboxUrl(src); }}
              style={{ display: 'block', marginTop: '4px', cursor: 'zoom-in' }}
            >
              <img src={src} alt="" loading="lazy"
                style={{
                  display: 'block',
                  maxWidth: '240px',
                  maxHeight: '180px',
                  objectFit: 'contain',
                  border: `1px solid ${hexAlpha(primaryColor, 0.25)}`,
                  borderRadius: '3px',
                  background: 'rgba(0,0,0,0.3)',
                }}
              />
            </span>
          );
        }
        const link = (
          <a key={`${i}-link`} href={p.url} target="_blank" rel="noopener noreferrer"
            title={p.url}
            onClick={e => e.stopPropagation()}
            style={{
              color: primaryText, fontWeight: 'bold',
              textDecoration: 'underline',
              textShadow: glowEnabled ? `0 0 4px ${hexAlpha(primaryColor, 0.5 * textAlpha)}` : 'none',
            }}
          >{truncateUrl(p.url)}</a>
        );
        if (media === 'video') {
          return (
            <React.Fragment key={i}>
              {link}
              <video src={p.url} autoPlay loop muted playsInline
                onClick={e => e.stopPropagation()}
                style={{
                  display: 'block',
                  maxWidth: '280px',
                  maxHeight: '180px',
                  marginTop: '4px',
                  border: `1px solid ${hexAlpha(primaryColor, 0.25)}`,
                  borderRadius: '3px',
                  background: 'rgba(0,0,0,0.3)',
                }}
              />
            </React.Fragment>
          );
        }
        return link;
      }
      if (p.kind === 'emoji' && p.url) {
        return (
          <img
            key={i}
            src={p.url}
            alt={`:${p.emojiName}:`}
            title={`:${p.emojiName}:`}
            // display:inline overrides Tailwind v4 preflight `img { display:block }` so
            // the emoji stays on the same line as the username (inline flow parity with
            // the desktop C# overlay). verticalAlign:middle centres it with the text cap.
            style={{ display: 'inline', height: 20, verticalAlign: 'middle', marginInline: 1 }}
          />
        );
      }
      return <React.Fragment key={i}>{p.text}</React.Fragment>;
    });
    if (renderContentCache.size > 1000) renderContentCache.clear();
    renderContentCache.set(ck, out);
    return out;
  }, [renderContentCache]);

  // Display-name priority resolution (Bug 2): apply the same FO76 name >
  // discordDisplayName > discordUsername priority as the desktop overlay.
  // The backend already resolves displayName server-side before broadcasting,
  // so msg.username is usually correct. This helper additionally applies any
  // fresh identity from user:identity_updated frames so history messages with
  // stale login-handle usernames get corrected immediately.
  const resolveUsername = useCallback((msg: ChatMessage): string => {
    if (msg.userId && msg.source !== 'bot' && msg.username !== '[Vault-Tec]') {
      const known = knownDisplayNames.current.get(msg.userId);
      if (known) return known;
    }
    return msg.username;
  }, []);

  // Join a party by id (used by the party-invite embed). On success refreshes
  // the parties list and opens that party; on failure surfaces the backend
  // message ("Party is full", per-user cap 409, etc.) in the inline banner.
  const joinPartyById = useCallback(async (partyId: string) => {
    try {
      const res = await api.post<any>(`/api/parties/${partyId}/join`, {});
      const p = res?.party ?? res?.data?.party;
      setPartyActionError(null);
      queryClient.invalidateQueries({ queryKey: ['parties'] });
      setActiveMainId(PARTY_MAIN_ID);
      setPartyView(p?.id ?? partyId);
    } catch (err: any) {
      setActiveMainId(PARTY_MAIN_ID);
      setPartyView('browser');
      // Defer so the view-switch effect (which clears the banner) runs first.
      setTimeout(() => setPartyActionError(err?.message || 'Could not join party'), 0);
    }
  }, [queryClient]);

  // Single source of truth for the party right-click menu. Builds the IDENTICAL
  // option set for a party regardless of WHERE the menu was triggered (joined
  // sub-tab, the active in-party sub-tab, or a Public Parties browser row) —
  // gated ONLY by the party's role/membership, never by trigger location.
  //   • Open                  — always (switches to the party view)
  //   • Join                  — public party you're NOT a member of
  //   • Invite members…       — owner/comod
  //   • Set member limit…     — owner/comod
  //   • Delete party / Leave party — owner / member (only when a member)
  // `menuX/menuY` are the trigger coords (for the inline member-limit editor).
  const buildPartyMenuItems = useCallback((p: Party, menuX: number, menuY: number): { label: string; action: () => void; danger?: boolean }[] => {
    const canInvite = p.role === 'owner' || p.role === 'comod';
    const isOwner = p.role === 'owner';
    const leaveOrDelete = async () => {
      // Route through the in-overlay confirmation modal (no native confirm).
      setLeaveConfirmFor({ partyId: p.id, isOwner });
    };
    return [
      { label: 'Open', action: () => { setActiveMainId(PARTY_MAIN_ID); setPartyView(p.id); } },
      ...(!p.isMember && !p.isPrivate ? [{ label: 'Join party', action: () => joinPartyById(p.id) }] : []),
      ...(canInvite ? [{ label: 'Invite members…', action: () => { setActiveMainId(PARTY_MAIN_ID); setPartyView(p.id); setInviteModalFor({ partyId: p.id }); } }] : []),
      ...(canInvite ? [{ label: 'Set member limit…', action: () => setPartyLimitEditor({ partyId: p.id, x: menuX, y: menuY }) }] : []),
      ...(canInvite ? [{ label: 'Edit description…', action: () => setPartyDescriptionEditor({ partyId: p.id }) }] : []),
      ...(p.isMember ? [{ label: isOwner ? 'Delete party' : 'Leave party', action: leaveOrDelete, danger: true }] : []),
    ];
  }, [joinPartyById]);

  // ── Active tab rendering helpers ──────────────────────────────────────────
  function renderMainTab(ch: Channel) {
    const isActive = ch.id === activeMainId;
    const unread = mainUnread(ch);
    // Desktop-overlay parity (Electron shell only): the active main tab renders
    // as a bordered "cutout" box with a faint fill + theme-color label, exactly
    // like ChatOverlayWindow.cs draws it (top/left/right border, faint inner
    // fill, primary-color text). On the website (overlayShell == null) the tab
    // keeps its original flat text look — no appearance change there.
    if (overlayShell) {
      // Desktop-overlay main-tab parity (authoritative): a SUBTLE BORDERED
      // OUTLINE tab — the Pip-Boy 3-sided border (top + left + right, OPEN at the
      // bottom so it sits on the divider), TRANSPARENT interior, theme-colored
      // text, proper-case ("Fallout 76"). The main-tab font is slightly LARGER
      // than the sub-tab font (main > sub). The active tab is measured (ref) so
      // the divider below can cut out under it.
      return (
        <div key={ch.id} ref={isActive ? activeMainTabRef : undefined} onClick={() => handleMainClick(ch.id)} style={{
          height: '20px',
          // BOTTOM-aligned in the 28px tab row so the tab's open bottom always
          // sits ON the cutout divider (row bottom) — otherwise a shorter tab
          // floats centered and its side borders stop short of the divider,
          // leaving the bottom corners disconnected ("no corners").
          alignSelf: 'flex-end',
          // Left padding is the tab's own text inset; combined with the row's
          // 8px padding it puts the "F" of "Fallout" at x=16 — the SAME x the
          // sub-tab row uses for the "G" of "General" (see the sub-row below).
          padding: '0 9px 0 8px',
          marginRight: '4px',
          marginBottom: '-1px',            // overlap the divider (open bottom sits on it)
          // Main tab font: still a touch BIGGER than the sub-tab font (sub uses
          // fontSize - 1), but trimmed down — it was reading a little too large.
          fontSize: `${fontSize}px`,
          fontWeight: 'bold',
          letterSpacing: tabLetterSpacing,
          cursor: 'pointer',
          color: isActive ? primaryText : inactiveTabText,
          background: 'transparent',       // transparent interior — outline only
          borderTop: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
          borderLeft: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
          borderRight: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
          borderBottom: 'none',            // open bottom — sits on the cutout divider
          textTransform: 'uppercase' as const,
          userSelect: 'none',
          whiteSpace: 'nowrap',           // label NEVER wraps mid-word ("FALLOUT 76" stays one line)
          display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box',
          textShadow: isActive && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
          // Clicking a tab switches channel (not a drag).
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}>
          {unread > 0 && <UnreadBadge n={unread} onClick={e => jumpToMainMention(e, ch)} />}
          {ch.name}
        </div>
      );
    }
    // Website parity (overlayShell == null): the active main tab gets the SAME
    // Pip-Boy 3-sided bordered "cutout" treatment as the Electron shell — top +
    // left + right border (open at the bottom so it sits ON the divider),
    // transparent fill, theme-colored bold label. Measured via activeMainTabRef
    // so the row divider below cuts out under it. (No window-drag region on web.)
    return (
      <div key={ch.id} ref={isActive ? activeMainTabRef : undefined} onClick={() => handleMainClick(ch.id)} style={{
        height: '20px',
        alignSelf: 'flex-end',
        padding: '0 9px 0 8px',
        marginRight: '4px',
        marginBottom: '-1px',            // overlap the divider (open bottom sits on it)
        fontSize: `${fontSize}px`,
        fontWeight: 'bold',
        letterSpacing: tabLetterSpacing,
        cursor: 'pointer',
        color: isActive ? primaryText : inactiveTabText,
        background: 'transparent',
        borderTop: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
        borderLeft: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
        borderRight: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
        borderBottom: 'none',            // open bottom — sits on the cutout divider
        textTransform: 'uppercase' as const,
        userSelect: 'none',
        whiteSpace: 'nowrap',           // label NEVER wraps mid-word
        display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box',
        textShadow: isActive && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
      }}>
        {unread > 0 && <UnreadBadge n={unread} onClick={e => jumpToMainMention(e, ch)} />}
        {ch.name}
      </div>
    );
  }

  // ── Party tab render helpers ─────────────────────────────────────────────
  function renderPartyMainTab() {
    const isActive = activeMainId === PARTY_MAIN_ID;
    // Sum unread @mentions across all joined parties for the main-tab badge.
    const partyMainUnread = joinedParties.reduce((s, p) => s + (unreadMentions[p.id] || 0), 0);
    if (overlayShell) {
      return (
        <div key={PARTY_MAIN_ID} ref={isActive ? activeMainTabRef : undefined} onClick={() => setActiveMainId(PARTY_MAIN_ID)} style={{
          height: '20px', alignSelf: 'flex-end',
          padding: '0 9px 0 8px', marginRight: '4px', marginBottom: '-1px',
          fontSize: `${fontSize}px`, fontWeight: 'bold', letterSpacing: tabLetterSpacing,
          cursor: 'pointer', color: isActive ? primaryText : inactiveTabText,
          background: 'transparent',
          borderTop: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
          borderLeft: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
          borderRight: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
          borderBottom: 'none',
          textTransform: 'uppercase' as const, userSelect: 'none', whiteSpace: 'nowrap',
          display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box',
          textShadow: isActive && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}>
          {partyMainUnread > 0 && <UnreadBadge n={partyMainUnread} />}
          {pendingInviteCount > 0 && <UnreadBadge n={pendingInviteCount} />}
          PARTY
        </div>
      );
    }
    // Website parity: same 3-sided bordered active-tab treatment as the Electron
    // PARTY tab (mirrors renderMainTab's website branch).
    return (
      <div key={PARTY_MAIN_ID} ref={isActive ? activeMainTabRef : undefined} onClick={() => setActiveMainId(PARTY_MAIN_ID)} style={{
        height: '20px', alignSelf: 'flex-end',
        padding: '0 9px 0 8px', marginRight: '4px', marginBottom: '-1px',
        fontSize: `${fontSize}px`, fontWeight: 'bold', letterSpacing: tabLetterSpacing,
        cursor: 'pointer', color: isActive ? primaryText : inactiveTabText,
        background: 'transparent',
        borderTop: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
        borderLeft: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
        borderRight: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
        borderBottom: 'none',
        textTransform: 'uppercase' as const, userSelect: 'none', whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box',
        textShadow: isActive && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
      }}>
        {partyMainUnread > 0 && <UnreadBadge n={partyMainUnread} />}
        {pendingInviteCount > 0 && <UnreadBadge n={pendingInviteCount} />}
        PARTY
      </div>
    );
  }

  function renderPmMainTab() {
    const isActive = activeMainId === PM_MAIN_ID;
    const tabStyle: React.CSSProperties = {
      height: '20px',
      alignSelf: 'flex-end',
      padding: '0 9px 0 8px',
      marginRight: '4px',
      marginBottom: '-1px',
      fontSize: `${fontSize}px`,
      fontWeight: 'bold',
      letterSpacing: tabLetterSpacing,
      cursor: 'pointer',
      color: isActive ? primaryText : inactiveTabText,
      background: 'transparent',
      borderTop: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
      borderLeft: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
      borderRight: isActive ? `1px solid ${hexAlpha(primaryColor, 0.5)}` : '1px solid transparent',
      borderBottom: 'none',
      textTransform: 'uppercase',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      display: 'inline-flex',
      alignItems: 'center',
      boxSizing: 'border-box',
      textShadow: isActive && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
      ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
    };
    return (
      <div key={PM_MAIN_ID} ref={isActive ? activeMainTabRef : undefined} onClick={() => setActiveMainId(PM_MAIN_ID)} style={tabStyle}>
        {pmMainUnread > 0 && <UnreadBadge n={pmMainUnread} />}
        PM
      </div>
    );
  }

  // Shared label/style for a joined-party sub-tab — used by BOTH the visible row
  // and the hidden measurement row so measured widths exactly match what renders.
  // Small inline padlock for private parties (replaces the 🔒 emoji). currentColor
  // so it inherits the surrounding text color; ~10px to match the other header SVGs.
  const LockIcon = ({ size = 10 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none"
      stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, verticalAlign: 'middle', marginRight: '3px' }} aria-hidden>
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
      <path d="M4 5.5 V4 a2 2 0 0 1 4 0 V5.5" />
    </svg>
  );

  const partyTabLabel = (p: Party) => {
    const nm = p.name ?? '';
    // Names are capped at 24 chars (modal maxLength); truncation here is a safety
    // net for long names in narrow tab rows.
    return nm.length > 24 ? nm.slice(0, 23) + '…' : nm;
  };
  const partyTabStyle = (isActive: boolean): React.CSSProperties => ({
    fontSize: overlayShell ? `${Math.max(8, fontSize - 1)}px` : `${fontSize}px`,
    letterSpacing: tabLetterSpacing,
    cursor: 'pointer',
    color: isActive ? primaryText : inactiveTabText,
    fontWeight: 'bold',
    textTransform: 'uppercase' as const,
    marginRight: `${scaleGap(12)}px`,
    // Parity: no underline on either shell or website — active shown via amber/bold text.
    borderBottom: 'none',
    paddingBottom: '1px',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    textShadow: isActive && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
    ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
  });

  function renderPartyContent() {
    if (partyView === 'browser') {
      // Responsive party rows (flat flex layout). Measure the list container
      // width (partyListWidth, via ResizeObserver) and progressively DROP the
      // least-important stat as width shrinks: category → online. The status
      // dot, NAME (flex + ellipsis), member count, and action button are ALWAYS
      // kept. The member cap is folded into the member count ("4 / 8") so there
      // is no awkward floating "max N" / blank cell.
      // 0 (pre-measure) is treated as wide so the first paint shows everything.
      const plw = partyListWidth || 9999;
      // Row line-height/height follow fontSize so large fonts don't clip.
      const partyRowLine = `${Math.max(18, fontSize + 8)}px`;
      const statFontSize = `${Math.max(9, fontSize - 2)}px`;
      // Fixed-width, left-aligned stat cells so member/online/category line up
      // as columns down the list (scales with font so big fonts never clip).
      const memberCellPx = Math.max(46, fontSize * 4);
      const onlineCellPx = Math.max(36, fontSize * 3);
      const categoryCellPx = Math.max(64, fontSize * 5.5);
      const baseActionCellPx = Math.max(46, fontSize * 4);
      const actionCellPx = Math.max(104, fontSize * 8);
      // The original collapse thresholds were tuned for a single action button.
      // Shift them by the extra width introduced by the new OPEN + LEAVE/DELETE
      // action cluster so narrow layouts preserve the previous density balance.
      const actionThresholdDelta = actionCellPx - baseActionCellPx;
      const showCategory = plw >= 320 + actionThresholdDelta;
      const showOnline = plw >= 230 + actionThresholdDelta;
      const memberCellW = `${memberCellPx}px`;
      const onlineCellW = `${onlineCellPx}px`;
      const categoryCellW = `${categoryCellPx}px`;
      const actionCellW = `${actionCellPx}px`;
      // Per-row CSS grid with FIXED tracks so the dot / name / category / member /
      // online / action columns line up at the same x on EVERY row (a flex row
      // let the action-button width shift the stat columns out of alignment).
      const partyGridCols = [
        '7px',            // status dot
        'minmax(0,1fr)',  // name (flexes + ellipsizes)
        showCategory ? categoryCellW : null,
        memberCellW,      // members
        showOnline ? onlineCellW : null,
        actionCellW,      // action button
      ].filter(Boolean).join(' ');
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Search + Sort + New Party bar. Search shrinks first (minWidth:0);
              buttons stay nowrap. Wrap to a 2nd line only if the row truly can't
              fit. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
            padding: '6px 8px',
            borderBottom: `1px solid ${borderRgba}`,
            flexShrink: 0,
          }}>
            {/* All three controls share an explicit 24px box height so the sort
                toggle + "+ NEW" line up flush with the search input. */}
            <input
              value={partySearch}
              onChange={e => setPartySearch(e.target.value)}
              placeholder="Search parties..."
              style={{
                flex: 1, minWidth: '60px', height: '20px', minHeight: 0, boxSizing: 'border-box',
                // Follow the overlay's live opacity (inputBgRgba), not a fixed
                // theme alpha, so the search field fades with everything else.
                background: inputBgRgba,
                border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
                color: theme.textColor, fontFamily: theme.fontFamily,
                fontSize: `${Math.max(9, fontSize - 1)}px`,
                padding: '0 6px', outline: 'none',
              }}
            />
            <button
              onClick={(e) => {
                if (filtersAnchor) { setFiltersAnchor(null); return; }
                const r = e.currentTarget.getBoundingClientRect();
                setFiltersAnchor({ top: r.bottom + 3, right: Math.max(4, window.innerWidth - r.right) });
              }}
              style={{
                height: '20px', minHeight: 0, boxSizing: 'border-box',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                padding: '0 6px', fontSize: '11px', fontFamily: theme.fontFamily,
                background: filtersAnchor ? hexAlpha(primaryColor, 0.2) : hexAlpha(primaryColor, 0.1),
                border: `1px solid ${hexAlpha(primaryColor, 0.4)}`,
                color: primaryColor, cursor: 'pointer', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                lineHeight: '1', paddingBottom: '2px',
              }}
            >
              <span style={{ display: 'block', transform: 'translateY(-1px)' }}>FILTERS{categoryFilter.length > 0 ? ` (${categoryFilter.length})` : ''}</span>
              <span style={{ display: 'block', fontSize: '7px', transform: 'translateY(-1px)' }}>{filtersAnchor ? '▲' : '▼'}</span>
            </button>
            {filtersAnchor && createPortal(
              <>
                <div onMouseDown={() => setFiltersAnchor(null)} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
                <div style={{
                  position: 'fixed', top: filtersAnchor.top, right: filtersAnchor.right, zIndex: 9999,
                  width: '248px', maxWidth: '92vw',
                  background: menuBgColor(theme, chromeBgAlpha, 1.5),
                  border: `1px solid ${borderBright}`, fontFamily: theme.fontFamily,
                  padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: '11px',
                  ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
                }}>
                  {/* SORT BY — segmented toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <span style={{ fontSize: '10px', letterSpacing: '1.5px', color: hexAlpha(primaryColor, 0.6), textAlign: 'center' }}>SORT BY</span>
                    <div style={{ display: 'flex', border: `1px solid ${hexAlpha(primaryColor, 0.3)}` }}>
                      {([['online', 'Online'], ['active', 'Active']] as const).map(([val, label], i) => {
                        const on = partySort === val;
                        return (
                          <button key={val} type="button"
                            onMouseDown={e => { e.stopPropagation(); setPartySort(val); }}
                            style={{
                              flex: 1, minHeight: 0, boxSizing: 'border-box', padding: '6px 0',
                              fontSize: '12px', fontFamily: theme.fontFamily, cursor: 'pointer', textAlign: 'center',
                              background: on ? hexAlpha(primaryColor, 0.22) : 'transparent',
                              color: on ? primaryColor : hexAlpha(primaryColor, 0.55),
                              border: 'none', borderLeft: i === 1 ? `1px solid ${hexAlpha(primaryColor, 0.3)}` : 'none',
                              fontWeight: on ? 'bold' : 'normal', letterSpacing: '0.05em',
                            }}
                          >{label}</button>
                        );
                      })}
                    </div>
                  </div>
                  {/* CATEGORY — 2-col badge grid; none selected = ALL */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '10px', letterSpacing: '1.5px', color: hexAlpha(primaryColor, 0.6) }}>CATEGORY</span>
                      <span
                        onMouseDown={e => { e.stopPropagation(); setCategoryFilter([]); }}
                        style={{ fontSize: '10px', letterSpacing: '0.5px', cursor: 'pointer',
                          color: categoryFilter.length > 0 ? hexAlpha(primaryColor, 0.85) : hexAlpha(primaryColor, 0.35) }}
                      >{categoryFilter.length > 0 ? `CLEAR (${categoryFilter.length})` : 'ALL'}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' }}>
                      {PARTY_CATEGORIES.map(cat => {
                        const on = categoryFilter.includes(cat);
                        const badgeColor = CATEGORY_BADGE_COLORS[cat] ?? primaryColor;
                        return (
                          <button key={cat} type="button"
                            onMouseDown={e => {
                              e.stopPropagation();
                              setCategoryFilter(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
                            }}
                            style={{
                              minHeight: 0, boxSizing: 'border-box',
                              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                              padding: '6px 7px', fontSize: '12px', fontFamily: theme.fontFamily, lineHeight: 1.2,
                              background: on ? hexAlpha(badgeColor, 0.2) : 'transparent',
                              border: `1px solid ${hexAlpha(badgeColor, on ? 0.85 : 0.28)}`,
                              color: on ? badgeColor : hexAlpha(badgeColor, 0.7),
                              cursor: 'pointer', letterSpacing: '0.02em', whiteSpace: 'nowrap',
                              overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'center',
                              fontWeight: on ? 'bold' : 'normal',
                            }}
                          ><span style={{ width: '7px', height: '7px', borderRadius: '50%', background: badgeColor, flexShrink: 0, opacity: on ? 1 : 0.55 }} />{cat}</button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </>,
              document.body,
            )}
            {/* Create is auth-only — public visitors browse read-only. */}
            {!isPublicMode && (
            <button
              onClick={() => setCreatePartyOpen(true)}
              style={{
                height: '20px', minHeight: 0, boxSizing: 'border-box',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 8px', fontSize: '11px', fontFamily: theme.fontFamily,
                background: hexAlpha(primaryColor, 0.15), border: `1px solid ${hexAlpha(primaryColor, 0.5)}`,
                color: primaryColor, cursor: 'pointer', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                lineHeight: '1', paddingBottom: '2px',
              }}
            ><span style={{ display: 'block', transform: 'translateY(-1px)' }}>+ NEW</span></button>
            )}
          </div>
          {/* Inline action-error banner — surfaces backend rejection messages
              (party cap, "Party is full", etc.) directly under FILTERS, above the list. */}
          {partyActionError && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '4px 8px', flexShrink: 0,
              background: 'rgba(255,96,96,0.12)',
              borderBottom: '1px solid rgba(255,96,96,0.4)',
              color: '#FF6060', fontFamily: theme.fontFamily,
              fontSize: `${Math.max(9, fontSize - 1)}px`, letterSpacing: '0.02em',
            }}>
              <span style={{ flexShrink: 0 }}>⚠</span>
              <span style={{ flex: 1, lineHeight: '1.3' }}>{partyActionError}</span>
              <span
                onClick={() => setPartyActionError(null)}
                style={{ cursor: 'pointer', color: 'rgba(255,96,96,0.7)', flexShrink: 0, fontSize: '11px', paddingLeft: '4px' }}
              >✕</span>
            </div>
          )}
          {/* Pending invites */}
          {pendingInvites.length > 0 && (
            <div style={{ padding: '4px 8px', flexShrink: 0, borderBottom: `1px solid ${borderRgba}` }}>
              {pendingInvites.map(inv => (
                <div key={inv.id} style={{
                  display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
                  padding: '3px 0', fontSize: `${Math.max(9, fontSize - 1)}px`,
                }}>
                  <span style={{ color: hexAlpha(primaryColor, 0.6), fontSize: '7px', letterSpacing: '0.08em', lineHeight: 1, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>INVITE</span>
                  <span style={{ color: primaryColor, flex: 1, minWidth: 0, fontWeight: 'bold', lineHeight: 1, display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inv.partyName}</span>
                  <span style={{ color: dimText, fontSize: '8px', lineHeight: 1, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>from {inv.inviterName}</span>
                  <button
                    onClick={async () => {
                      try {
                        const res = await api.post<any>(`/api/parties/invites/${inv.id}/accept`, {});
                        const party = res?.party ?? res?.data?.party;
                        setPartyActionError(null);
                        queryClient.invalidateQueries({ queryKey: ['parties'] });
                        queryClient.invalidateQueries({ queryKey: ['party-invites'] });
                        if (party?.id) { setPartyView(party.id); }
                      } catch (err: any) { setPartyActionError(err?.message || 'Could not accept invite'); }
                    }}
                    style={{
                      height: '20px', minHeight: 0, boxSizing: 'border-box',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0 6px', paddingBottom: '1px', fontSize: '11px', fontFamily: theme.fontFamily,
                      background: hexAlpha(primaryColor, 0.15), border: `1px solid ${hexAlpha(primaryColor, 0.5)}`,
                      color: primaryColor, cursor: 'pointer', lineHeight: '1',
                    }}
                  >ACCEPT</button>
                  <button
                    onClick={async () => {
                      try { await api.post(`/api/parties/invites/${inv.id}/decline`, {}); } catch { /* ignore */ }
                      queryClient.invalidateQueries({ queryKey: ['party-invites'] });
                      queryClient.invalidateQueries({ queryKey: ['parties'] });
                    }}
                    style={{
                      height: '20px', minHeight: 0, boxSizing: 'border-box',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0 4px', paddingBottom: '1px', fontSize: '11px', fontFamily: theme.fontFamily,
                      background: 'transparent', border: `1px solid ${hexAlpha(primaryColor, 0.25)}`,
                      color: hexAlpha(primaryColor, 0.5), cursor: 'pointer', lineHeight: '1',
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          {/* Pip-Boy styled divider between the menu/controls area and the party list */}
          <div style={{
            height: '1px', flexShrink: 0, marginBottom: '0px',
            background: `linear-gradient(to right, transparent, ${hexAlpha(primaryColor, 0.3)} 15%, ${hexAlpha(primaryColor, 0.3)} 85%, transparent)`,
          }} />
          {/* Party list */}
          <div ref={partyListRef} className="fcm-scrollbar" style={{
            flex: 1, overflowY: 'auto', scrollbarWidth: 'thin',
          }}>
            {displayedParties.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: hexAlpha(theme.secondaryColor, 0.4),
                fontSize: `${fontSize}px`, fontFamily: '"Courier New", Courier, monospace',
              }}>
                No parties found...
              </div>
            ) : (
              displayedParties.map(party => (
                <div key={party.id}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!isPublicMode) setPartyTabCtx({ x: e.clientX, y: e.clientY, partyId: party.id }); }}
                  onClick={() => {
                    // Clicking the row opens the party (same as the action button).
                    if (party.isMember) {
                      setActiveMainId(PARTY_MAIN_ID);
                      setPartyView(party.id);
                    } else if (!party.isPrivate) {
                      setPartyView(party.id);
                    }
                  }}
                  style={{
                  // Per-row grid with FIXED tracks (partyGridCols) so every row's
                  // columns line up: dot | name | [category] | members | [online] | action.
                  display: 'grid',
                  gridTemplateColumns: partyGridCols,
                  alignItems: 'center', gap: '8px',
                  padding: '5px 10px',
                  // lineHeight 1.4 ensures descenders (g,y,p,j) never clip vertically.
                  lineHeight: 1.4,
                  minHeight: partyRowLine,
                  borderBottom: `1px solid ${hexAlpha(primaryColor, 0.07)}`,
                  cursor: 'pointer',
                }}>
                  {/* Status dot — lit when anyone is online. marginRight keeps it
                      clear of the name so it never reads as "covered" by text. */}
                  <span style={{
                    width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
                    background: party.onlineCount > 0 ? '#18FF62' : hexAlpha(primaryColor, 0.25),
                    boxShadow: party.onlineCount > 0 ? `0 0 4px #18FF62` : 'none',
                  }} />
                  {/* Name — flexes + ellipsizes; onClick navigates into the party */}
                  <span
                    onClick={e => {
                      e.stopPropagation();
                      if (party.isMember) { setActiveMainId(PARTY_MAIN_ID); setPartyView(party.id); }
                      else if (!party.isPrivate) { setPartyView(party.id); }
                    }}
                    style={{
                    flex: 1, minWidth: 0, fontSize: `${Math.max(9, fontSize - 1)}px`, color: primaryColor,
                    fontWeight: party.isMember ? 'bold' : 'normal',
                    display: 'flex', alignItems: 'center', gap: '4px', lineHeight: 1.4,
                    cursor: 'pointer',
                  }}>
                    {party.isPrivate && <LockIcon />}
                    <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{party.name}</span>
                    {party.pendingInvite && <span style={{ fontSize: '7px', color: hexAlpha(primaryColor, 0.7), letterSpacing: '0.05em', flexShrink: 0, alignSelf: 'center' }}>INVITED</span>}
                  </span>
                  {/* Category badge — fixed-width, left-aligned cell. */}
                  {showCategory && (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', width: categoryCellW, flexShrink: 0, overflow: 'hidden' }}>
                      {party.category ? <CategoryBadge cat={party.category} fontSize={fontSize} /> : null}
                    </span>
                  )}
                  {/* Members (cap folded in as "N/max") — fixed-width left-aligned cell. */}
                  <span title={party.maxMembers != null ? `${party.memberCount} of ${party.maxMembers} members` : `${party.memberCount} members (no limit)`}
                    style={{ width: memberCellW, flexShrink: 0, fontSize: statFontSize, color: dimText, whiteSpace: 'nowrap', lineHeight: 1.4, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: '3px' }}>
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" style={{ flexShrink: 0, opacity: 0.7 }}><circle cx="5" cy="3" r="2.2"/><path d="M1 9.5C1 7 2.8 5.5 5 5.5s4 1.5 4 4"/></svg>
                    {party.maxMembers != null ? `${party.memberCount}/${party.maxMembers}` : `${party.memberCount}`}
                  </span>
                  {/* Online — fixed-width left-aligned cell. */}
                  {showOnline && (
                    <span title={`${party.onlineCount} online`}
                      style={{ width: onlineCellW, flexShrink: 0, fontSize: statFontSize, color: party.onlineCount > 0 ? '#18FF62' : dimText, whiteSpace: 'nowrap', lineHeight: 1.4, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: '3px' }}>
                      <span style={{ width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0, background: party.onlineCount > 0 ? '#18FF62' : hexAlpha(primaryColor, 0.3), boxShadow: party.onlineCount > 0 ? `0 0 3px #18FF62` : 'none' }} />
                      {`${party.onlineCount}`}
                    </span>
                  )}
                  {/* Actions */}
                  {isPublicMode ? (
                    // Public visitors get a read-only VIEW into public party chat.
                    <button
                      onClick={(e) => { e.stopPropagation(); setPartyView(party.id); }}
                      style={{
                        height: '18px', minHeight: 0, boxSizing: 'border-box',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px', fontSize: '11px', fontFamily: theme.fontFamily,
                        background: 'transparent', border: `1px solid ${hexAlpha(primaryColor, 0.4)}`,
                        color: primaryColor, cursor: 'pointer', flexShrink: 0,
                        lineHeight: '1', paddingBottom: '2px',
                      }}
                    ><span style={{ display: 'block', transform: 'translateY(-1px)' }}>VIEW</span></button>
                  ) : party.pendingInvite ? (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const inv = pendingInvites.find(i => i.partyId === party.id);
                        if (!inv) return;
                        try {
                          const res = await api.post<any>(`/api/parties/invites/${inv.id}/accept`, {});
                          const p = res?.party ?? res?.data?.party;
                          setPartyActionError(null);
                          queryClient.invalidateQueries({ queryKey: ['parties'] });
                          queryClient.invalidateQueries({ queryKey: ['party-invites'] });
                          if (p?.id) setPartyView(p.id);
                        } catch (err: any) { setPartyActionError(err?.message || 'Could not accept invite'); }
                      }}
                      style={{
                        height: '18px', minHeight: 0, boxSizing: 'border-box',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px', fontSize: '11px', fontFamily: theme.fontFamily,
                        background: hexAlpha(primaryColor, 0.15), border: `1px solid ${hexAlpha(primaryColor, 0.5)}`,
                        color: primaryColor, cursor: 'pointer', flexShrink: 0,
                        lineHeight: '1', paddingBottom: '2px',
                      }}
                    ><span style={{ display: 'block', transform: 'translateY(-1px)' }}>ACCEPT</span></button>
                  ) : party.isMember ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPartyView(party.id); }}
                        style={{
                          flex: 1, height: '18px', minHeight: 0, minWidth: 0, boxSizing: 'border-box',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          padding: '0 5px', fontSize: '11px', fontFamily: theme.fontFamily,
                          background: hexAlpha(primaryColor, 0.1), border: `1px solid ${hexAlpha(primaryColor, 0.4)}`,
                          color: primaryColor, cursor: 'pointer', lineHeight: '1', paddingBottom: '2px',
                        }}
                      ><span style={{ display: 'block', transform: 'translateY(-1px)' }}>OPEN</span></button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setLeaveConfirmFor({ partyId: party.id, isOwner: party.role === 'owner' });
                        }}
                        style={{
                          flex: 1, height: '18px', minHeight: 0, minWidth: 0, boxSizing: 'border-box',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          padding: '0 5px', fontSize: '11px', fontFamily: theme.fontFamily,
                          background: 'transparent', border: `1px solid ${hexAlpha('#FF4444', 0.4)}`,
                          color: '#FF4444', cursor: 'pointer', lineHeight: '1', paddingBottom: '2px',
                        }}
                      ><span style={{ display: 'block', transform: 'translateY(-1px)' }}>{party.role === 'owner' ? 'DELETE' : 'LEAVE'}</span></button>
                    </div>
                  ) : !party.isPrivate ? (
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          const res = await api.post<any>(`/api/parties/${party.id}/join`, {});
                          const p = res?.party ?? res?.data?.party;
                          setPartyActionError(null);
                          queryClient.invalidateQueries({ queryKey: ['parties'] });
                          if (p?.id) setPartyView(p.id);
                        } catch (err: any) { setPartyActionError(err?.message || 'Could not join party'); }
                      }}
                      style={{
                        height: '18px', minHeight: 0, boxSizing: 'border-box',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 5px', fontSize: '11px', fontFamily: theme.fontFamily,
                        background: 'transparent', border: `1px solid ${hexAlpha(primaryColor, 0.4)}`,
                        color: primaryColor, cursor: 'pointer', flexShrink: 0,
                        lineHeight: '1', paddingBottom: '2px',
                      }}
                    ><span style={{ display: 'block', transform: 'translateY(-1px)' }}>JOIN</span></button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      );
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Memoized normal-feed message rows. Decoupled from inputText so typing
  // (e.g. holding Backspace) no longer re-renders all ~300 rows. Recomputes
  // only when a listed dependency actually changes.
  const filteredPrivateConversations = useMemo(() => {
    const term = pmSearch.trim().toLowerCase();
    if (!term) return privateConversations;
    return privateConversations.filter(conversation => {
      const formattedPreview = formatPrivateConversationPreview(
        conversation,
        privateMessages[conversation.conversationId],
        user?.id ?? '',
      ).toLowerCase();
      return conversation.otherDisplayName.toLowerCase().includes(term)
        || conversation.lastMessagePreview.toLowerCase().includes(term)
        || formattedPreview.includes(term);
    });
  }, [privateConversations, privateMessages, pmSearch, user?.id]);

  const privateSearchResults = useMemo(() => {
    const existingUserIds = new Set(privateConversations.map(conversation => conversation.otherUserId));
    return pmSearchResults.filter(result => !existingUserIds.has(result.userId));
  }, [pmSearchResults, privateConversations]);

  function renderPrivateInboxContent() {
    return (
      <div data-pm-inbox="true" style={{ padding: '6px 8px 8px' }}>
        <input
          value={pmSearch}
          onChange={e => setPmSearch(e.target.value)}
          placeholder="Type to search..."
          style={{
            width: '100%',
            boxSizing: 'border-box',
            marginBottom: '8px',
            background: inputBgRgba,
            border: `1px solid ${hexAlpha(primaryColor, 0.25)}`,
            color: textRgba,
            fontFamily: theme.fontFamily,
            fontSize: `${fontSize}px`,
            lineHeight: '18px',
            padding: '5px 8px',
            outline: 'none',
          }}
        />
        {privateSearchResults.length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <div style={{ color: hexAlpha(dimText, 0.8), fontSize: '10px', letterSpacing: '0.08em', marginBottom: '4px' }}>
              USERS
            </div>
            {privateSearchResults.map(result => (
              <div
                key={`pm-user-${result.userId}`}
                onClick={() => openPrivateConversation(result.userId)}
                style={{
                  padding: '6px 4px',
                  cursor: 'pointer',
                  borderBottom: `1px solid ${hexAlpha(primaryColor, 0.08)}`,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = hexAlpha(primaryColor, 0.08); }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ color: primaryText, fontWeight: 'bold', textShadow: textOutline }}>
                  {result.displayName}
                </div>
              </div>
            ))}
          </div>
        )}
        {pmSearchLoading && (
          <div style={{ color: dimText, fontSize: `${Math.max(10, fontSize - 1)}px`, marginBottom: '6px' }}>
            Searching...
          </div>
        )}
        {filteredPrivateConversations.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '120px',
            color: hexAlpha(theme.secondaryColor, 0.4),
            fontSize: `${fontSize}px`,
            fontFamily: '"Courier New", Courier, monospace',
          }}>
            No Private Messages Yet...
          </div>
        ) : (
          filteredPrivateConversations.map(conversation => (
            <div
              key={conversation.conversationId}
              data-pm-inbox-row="true"
              onClick={() => setPmView(conversation.conversationId)}
              style={{
                padding: '6px 4px',
                cursor: 'pointer',
                borderBottom: `1px solid ${hexAlpha(primaryColor, 0.08)}`,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = hexAlpha(primaryColor, 0.08); }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <span style={{
                  flex: 1,
                  color: primaryText,
                  fontWeight: 'bold',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textShadow: textOutline,
                }}>
                  {conversation.otherDisplayName}
                </span>
                <span style={{
                  color: hexAlpha(dimText, 0.78),
                  fontSize: `${Math.max(9, fontSize - 2)}px`,
                  whiteSpace: 'nowrap',
                  textShadow: textOutline,
                }}>
                  {formatMessageTimestamp(conversation.lastMessageAt, settings.timestampFormat)}
                </span>
                {conversation.unreadCount > 0 && <UnreadBadge n={conversation.unreadCount} />}
              </div>
              <div style={{
                color: textRgba,
                fontSize: `${Math.max(10, fontSize - 1)}px`,
                marginTop: '2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textShadow: textOutline,
              }}>
                {formatPrivateConversationPreview(
                  conversation,
                  privateMessages[conversation.conversationId],
                  user?.id ?? '',
                )}
              </div>
            </div>
          ))
        )}
      </div>
    );
  }

  const inputPlaceholder = 'Type a message...';
  const showComposer = !isPublicMode
    && !adminFeedActive
    && (!isOnPartyTab || partyView !== 'browser')
    && (!isOnPmTab || pmView !== 'inbox');

  const normalFeedRows = useMemo(() =>
              visibleMessages.map(msg => {
                const displayName = isOnPmTab && msg.userId && msg.userId === (user?.id ?? '')
                  ? 'You'
                  : resolveUsername(msg);
                // ── Party-invite embed ──────────────────────────────────────
                // Public-invitation messages carry metadata.type === 'party_invite'.
                // Render a styled embed with a Join button instead of plain text.
                const md = msg.metadata;
                // STATIC broadcast messages (wiki share, party invite) render as
                // INLINE content via the normal message path below — so the channel
                // tag + name match every other message. (Ephemeral/sender-only
                // responses use the boxed ChatEmbedCard instead.)
                let inlineContent: React.ReactNode = null;
                if (md && md.type === 'party_invite' && typeof (md as PartyInviteMetadata).partyId === 'string') {
                  const inv = md as PartyInviteMetadata;
                  const accent = (inv.color && inv.color.trim()) ? inv.color : primaryColor;
                  const joinedParty = parties.find(p => p.id === inv.partyId);
                  const alreadyMember = !!joinedParty?.isMember;
                  const inviteAction = alreadyMember ? (
                    <span style={{
                      fontSize: `${Math.max(8, fontSize - 3)}px`,
                      color: hexAlpha(accent, 0.7), letterSpacing: '0.04em',
                    }}>JOINED</span>
                  ) : (
                    <button
                      onClick={() => joinPartyById(inv.partyId)}
                      style={{
                        minHeight: 0, boxSizing: 'border-box', height: '18px',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 9px', fontSize: `${Math.max(9, fontSize - 2)}px`, fontFamily: theme.fontFamily,
                        background: hexAlpha(accent, 0.18), border: `1px solid ${hexAlpha(accent, 0.6)}`,
                        color: accent, cursor: 'pointer', fontWeight: 'bold', letterSpacing: '0.04em', lineHeight: 1,
                      }}
                    >JOIN</button>
                  );
                  // Inline party invite: ✦ invited everyone to <PartyName> [JOIN]
                  inlineContent = (
                    <ChatInlineEmbed
                      accent={accent}
                      icon="✦"
                      title={inv.partyName}
                      badge="PARTY"
                      action={inviteAction}
                      fontSize={fontSize}
                      dimText={dimText}
                    >{'invited everyone to '}</ChatInlineEmbed>
                  );
                }
                // ── Wiki-share card ──────────────────────────────────────
                if (md && md.type === 'wiki_share') {
                  const ws_md = md as WikiShareMetadata;
                  const wikiName = ws_md.name || 'Wiki Entry';
                  const wikiKind = ws_md.kind || null;
                  const wikiTitle = ws_md.wikiTitle || '';
                  const openArticle = () => {
                    if (!wikiTitle) return;
                    openUrl(wikiArticleUrl(wikiTitle));
                  };
                  // Inline rich link: ◈ Name [KIND] · Fallout Wiki ↗
                  inlineContent = (
                    <ChatInlineEmbed
                      accent={primaryColor}
                      icon="◈"
                      title={wikiName}
                      onTitleClick={wikiTitle ? () => openWikiPanel(wikiTitle, true) : undefined}
                      titleGlow={!!wikiTitle && glowEnabled}
                      badge={wikiKind ? wikiKindLabel(wikiKind) : undefined}
                      meta={{ label: 'Fallout Wiki ↗', onClick: openArticle, title: 'Fallout Wiki (CC-BY-SA)' }}
                      fontSize={fontSize}
                      dimText={dimText}
                    />
                  );
                }
                // ── Card-share inline link ───────────────────────────────
                if (md && md.type === 'card_share') {
                  const cs = md as CardShareMetadata;
                  inlineContent = (
                    <ChatInlineEmbed
                      accent={cs.accent}
                      icon={cs.icon}
                      title={cs.label}
                      onTitleClick={() => openSharedCard(cs.command)}
                      titleGlow={glowEnabled}
                      meta={cs.sourceUrl ? {
                        label: `${cs.sourceName} ↗`,
                        onClick: () => openUrl(cs.sourceUrl!),
                      } : undefined}
                      fontSize={fontSize}
                      dimText={dimText}
                    />
                  );
                }
                // ── Nuke-codes card ──────────────────────────────────────
                if (md && md.type === 'nuke_codes') {
                  const nc = md as NukeCodesMetadata;
                  const nukeAccent = '#FF6B4A';
                  const nukeFields = [
                    { label: 'ALPHA', value: nc.alpha, valueStyle: { fontFamily: '"Courier New", Courier, monospace' } },
                    { label: 'BRAVO', value: nc.bravo, valueStyle: { fontFamily: '"Courier New", Courier, monospace' } },
                    { label: 'CHARLIE', value: nc.charlie, valueStyle: { fontFamily: '"Courier New", Courier, monospace' } },
                    ...(nc.validUntil ? [{ label: 'VALID UNTIL', value: new Date(nc.validUntil).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }] : []),
                  ];
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard
                        accent={nukeAccent}
                        icon="☢"
                        tag="NUKE CODES"
                        title="Active Silo Codes"
                        onShareToChat={() => shareCardToChat({ command: '/nukecodes', label: 'Nuke Codes', accent: nukeAccent, icon: '☢' })}
                        shareDisabled={cardShareCooldown}
                        fields={nukeFields}
                        inlineMeta={
                          <span role="button" tabIndex={0} title="Source: NukaCrypt"
                            onClick={() => openUrl('https://nukacrypt.com')}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openUrl('https://nukacrypt.com'); }}
                            style={{ color: hexAlpha(nukeAccent, 0.85), textDecoration: 'underline', cursor: 'pointer' }}
                          >via NukaCrypt &#8599;</span>
                        }
                        hexAlpha={hexAlpha}
                        fontFamily={theme.fontFamily}
                        fontSize={fontSize}
                        dimText={dimText}
                      />
                    </div>
                  );
                }
                // ── Server-status card ──────────────────────────────────────
                if (md && md.type === 'server_status') {
                  const ss = md as ServerStatusMetadata;
                  const statusLower = ss.status.toLowerCase();
                  const isUp = statusLower.includes('up') || statusLower.includes('ok') || statusLower.includes('online');
                  const ssAccent = isUp ? '#55EFC4' : '#FF6B4A';
                  const ssFields = [
                    { label: 'STATUS', value: ss.status },
                    { label: 'CHECKED', value: new Date(ss.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
                  ];
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard
                        accent={ssAccent}
                        icon="▣"
                        tag="SERVER STATUS"
                        title="Fallout 76 Servers"
                        onShareToChat={() => shareCardToChat({ command: '/serverstatus', label: 'Server Status', accent: ssAccent, icon: '▣' })}
                        shareDisabled={cardShareCooldown}
                        fields={ssFields}
                        inlineMeta={
                          <span role="button" tabIndex={0} title="Source: Bethesda server status"
                            onClick={() => openUrl('https://bethesda.net/en/status')}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openUrl('https://bethesda.net/en/status'); }}
                            style={{ color: hexAlpha(ssAccent, 0.85), textDecoration: 'underline', cursor: 'pointer' }}
                          >via Bethesda &#8599;</span>
                        }
                        hexAlpha={hexAlpha}
                        fontFamily={theme.fontFamily}
                        fontSize={fontSize}
                        dimText={dimText}
                      />
                    </div>
                  );
                }
                // ── CAMP item card ──────────────────────────────────────────
                if (md && md.type === 'camp_item') {
                  const ci = md as CampItemMetadata;
                  const campAccent = '#B57BFF';
                  const campFields: { label: string; value: string }[] = [
                    { label: 'CATEGORY', value: ci.category },
                    { label: 'SUB-CATEGORY', value: ci.subCategory },
                    { label: 'BUDGET', value: ci.budgetCost != null ? String(ci.budgetCost) : '—' },
                    { label: 'PLAN', value: ci.plan ?? 'No plan required' },
                    { label: 'SOURCE', value: ci.sourceLabel ?? '—' },
                    ...(ci.atomPrice != null ? [{ label: 'ATOMS', value: `${ci.atomPrice} · last known` }] : []),
                    ...(ci.atomBundle != null ? [{ label: 'BUNDLE', value: ci.atomBundle }] : []),
                  ];
                  const campImgNode = ci.imageUrl ? (
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '6px' }}>
                      <img
                        src={resolveMediaUrl(ci.imageUrl)}
                        alt={ci.name}
                        title="Click to zoom"
                        style={{ display: 'block', maxWidth: '100%', maxHeight: '80px', objectFit: 'contain', background: 'transparent', cursor: 'zoom-in' }}
                        onClick={() => setChatLightboxSrc(resolveMediaUrl(ci.imageUrl!))}
                        // #313: the image loads async and grows the card AFTER the
                        // append already scrolled — re-pin if the user is still at
                        // the bottom so the (now taller) card lands fully in view.
                        onLoad={() => { if (stickToBottomRef.current) scrollToBottom(); }}
                        onError={e => { (e.currentTarget as HTMLImageElement).parentElement!.style.display = 'none'; }}
                      />
                    </div>
                  ) : null;
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard
                        accent={campAccent}
                        icon="⚒"
                        tag="CAMP ITEM"
                        title={ci.name}
                        onShareToChat={() => shareCardToChat({ command: `/camp ${ci.name}`, label: ci.name, accent: campAccent, icon: '⚒' })}
                        shareDisabled={cardShareCooldown}
                        fields={campFields}
                        footer={campImgNode ?? undefined}
                        inlineMeta={
                          <span role="button" tabIndex={0} title={`Source: ${ci.source}`}
                            onClick={() => openUrl(ci.sourceUrl)}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openUrl(ci.sourceUrl); }}
                            style={{ color: hexAlpha(campAccent, 0.85), textDecoration: 'underline', cursor: 'pointer' }}
                          >via 76 CAMP Database &#8599;</span>
                        }
                        hexAlpha={hexAlpha}
                        fontFamily={theme.fontFamily}
                        fontSize={fontSize}
                        dimText={dimText}
                      />
                    </div>
                  );
                }
                // ── Minerva card ─────────────────────────────────────────────
                if (md && md.type === 'minerva') {
                  const mv = md as unknown as MinervaMetadata;
                  const mvAccent = '#F1C40F';
                  const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                  const fmtDuration = (iso: string) => {
                    const diffMs = new Date(iso).getTime() - Date.now();
                    if (diffMs <= 0) return 'ending soon';
                    const totalMins = Math.floor(diffMs / 60000);
                    const days = Math.floor(totalMins / 1440);
                    const hours = Math.floor((totalMins % 1440) / 60);
                    const mins = totalMins % 60;
                    const parts = [];
                    if (days > 0) parts.push(`${days}d`);
                    if (hours > 0) parts.push(`${hours}h`);
                    if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
                    return parts.join(' ');
                  };
                  const mvFields: { label: string; value: string }[] = [
                    { label: 'STATUS', value: mv.isActive ? 'ACTIVE NOW' : 'UPCOMING' },
                    { label: 'LOCATION', value: mv.location + (mv.isSuperSale ? ' ★' : '') },
                    { label: 'LIST', value: `#${mv.listNumber}${mv.isSuperSale ? ' (Super Sale)' : ''}` },
                    { label: mv.isActive ? 'ENDS' : 'STARTS', value: fmtDate(mv.isActive ? mv.endUtc : mv.startUtc) },
                    { label: mv.isActive ? 'LEAVES IN' : 'ARRIVES IN', value: fmtDuration(mv.isActive ? mv.endUtc : mv.startUtc) },
                    ...(mv.isActive && mv.nextLocation ? [
                      { label: 'NEXT', value: `${mv.nextLocation}${mv.nextIsSuperSale ? ' ★' : ''} — List #${mv.nextListNumber}` },
                      { label: 'NEXT STARTS', value: fmtDate(mv.nextStartUtc!) },
                    ] : []),
                  ];
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard
                        accent={mvAccent}
                        icon="⛟"
                        tag={mv.isSuperSale ? '★ SUPER SALE' : ''}
                        title="Minerva's Big Sale"
                        onShareToChat={() => shareCardToChat({ command: '/minerva', label: "Minerva's Big Sale", accent: mvAccent, icon: '⛟' })}
                        shareDisabled={cardShareCooldown}
                        fields={mvFields}
                        footerLeft={
                          <span role="button" tabIndex={0} title="More info at falloutbuilds.com"
                            onClick={() => openUrl('https://www.falloutbuilds.com/fo76/minerva')}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openUrl('https://www.falloutbuilds.com/fo76/minerva'); }}
                            style={{ color: hexAlpha(mvAccent, 0.85), textDecoration: 'underline', cursor: 'pointer' }}
                          >more info &#8599;</span>
                        }
                        hexAlpha={hexAlpha}
                        fontFamily={theme.fontFamily}
                        fontSize={fontSize}
                        dimText={dimText}
                      />
                    </div>
                  );
                }
                // ── Giveaway helpers (shared by announcement + list cards) ────
                const sendGiveawayCmd = (verb: string, shortId: string) =>
                  sendOrQueueChat({ type: 'chat:send', payload: { content: `/giveaway ${verb} ${shortId}`, channelId: activeSubId, clientCreatedAt: new Date().toISOString() } });
                const giveawayBtnStyle = (color: string): React.CSSProperties => ({
                  padding: '2px 10px', background: hexAlpha(color, 0.18), color, borderRadius: '4px',
                  cursor: 'pointer', fontSize: `${fontSize - 1}px`, fontFamily: theme.fontFamily,
                  border: 'none', flexShrink: 0,
                });

                // ── Giveaway announcement card ──────────────────────────────
                if (md && md.type === 'giveaway') {
                  const gv = md as GiveawayMetadata;
                  const liveState = giveawayLiveStateRef.current.get(gv.giveawayId);
                  const liveEntryCount = liveState?.entryCount ?? gv.entryCount;
                  const liveStatus = liveState?.status ?? 'active';
                  const isActive = liveStatus === 'active';
                  const gvAccent = primaryColor;
                  const secsLeft = Math.max(0, Math.floor((new Date(gv.endsAt).getTime() - Date.now()) / 1000));
                  const timeLeftStr = isActive
                    ? (secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m left` : `${secsLeft}s left`)
                    : liveStatus === 'cancelled' ? 'Cancelled' : 'Ended';
                  const isOwnGiveaway = !!(myUserIdRef.current && gv.createdByUserId && myUserIdRef.current === gv.createdByUserId);
                  const gvFields: { label: string; value: string }[] = [
                    { label: 'PRIZE', value: gv.itemName },
                    { label: 'STARTED BY', value: gv.creatorName },
                    { label: 'ENTRIES', value: String(liveEntryCount) },
                    { label: 'TIME', value: timeLeftStr },
                    { label: 'ID', value: gv.shortId },
                  ];
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard
                        accent={gvAccent}
                        icon="🎁"
                        tag="GIVEAWAY"
                        title={gv.itemName}
                        fields={gvFields}
                        hexAlpha={hexAlpha}
                        fontFamily={theme.fontFamily}
                        fontSize={fontSize}
                        dimText={dimText}
                        footer={isActive ? (
                          <div style={{ display: 'flex', gap: '6px', marginTop: '4px', justifyContent: isOwnGiveaway ? 'center' : 'flex-start' }}>
                            {isOwnGiveaway ? (
                              <span role="button" tabIndex={0}
                                style={giveawayBtnStyle('#FF6B4A')}
                                onClick={() => sendGiveawayCmd('stop', gv.shortId)}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') sendGiveawayCmd('stop', gv.shortId); }}
                              >Cancel</span>
                            ) : (<>
                              <span role="button" tabIndex={0}
                                style={giveawayBtnStyle(gvAccent)}
                                onClick={() => sendGiveawayCmd('join', gv.shortId)}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') sendGiveawayCmd('join', gv.shortId); }}
                              >Join</span>
                              <span role="button" tabIndex={0}
                                style={giveawayBtnStyle('#FF6B4A')}
                                onClick={() => sendGiveawayCmd('leave', gv.shortId)}
                                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') sendGiveawayCmd('leave', gv.shortId); }}
                              >Leave</span>
                            </>)}
                          </div>
                        ) : undefined}
                      />
                    </div>
                  );
                }
                // ── Giveaway winner/cancelled card ──────────────────────────
                if (md && md.type === 'giveaway_winner') {
                  const gw = md as GiveawayWinnerMetadata;
                  const gwAccent = gw.cancelled ? '#888' : gw.winnerName ? '#55EFC4' : '#888';
                  const gwTitle = gw.cancelled
                    ? `Cancelled: ${gw.itemName}`
                    : gw.winnerName
                      ? `Winner: ${gw.winnerName}`
                      : `No entries — ${gw.itemName}`;
                  const gwFields: { label: string; value: string }[] = [
                    { label: 'PRIZE', value: gw.itemName },
                    { label: 'ENTRIES', value: String(gw.entryCount) },
                    { label: 'ID', value: gw.shortId },
                  ];
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard
                        accent={gwAccent}
                        icon={gw.cancelled ? '❌' : gw.winnerName ? '🎉' : '🎁'}
                        tag={gw.cancelled ? 'GIVEAWAY CANCELLED' : 'GIVEAWAY WINNER'}
                        title={gwTitle}
                        fields={gwFields}
                        hexAlpha={hexAlpha}
                        fontFamily={theme.fontFamily}
                        fontSize={fontSize}
                        dimText={dimText}
                      />
                    </div>
                  );
                }
                // ── Giveaway list (active) card ─────────────────────────────
                if (md && md.type === 'giveaway_list') {
                  const gl = md as GiveawayListMetadata;
                  const glAccent = primaryColor;
                  if (gl.giveaways.length === 0) {
                    return (
                      <div key={msg.id} style={{ padding: '2px 8px' }}>
                        <ChatEmbedCard accent={glAccent} icon="🎁" tag="ACTIVE GIVEAWAYS" title="No active giveaways right now"
                          fields={[]} hexAlpha={hexAlpha} fontFamily={theme.fontFamily} fontSize={fontSize} dimText={dimText} />
                      </div>
                    );
                  }
                  const glFields = gl.giveaways.map(g => {
                    const liveState = giveawayLiveStateRef.current.get(g.giveawayId);
                    const entryCount = liveState?.entryCount ?? g.entryCount;
                    const secsLeft = Math.max(0, Math.floor((new Date(g.endsAt).getTime() - Date.now()) / 1000));
                    const timeLeft = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m left` : `${secsLeft}s left`;
                    const isOwnList = !!(myUserIdRef.current && g.createdByUserId && myUserIdRef.current === g.createdByUserId);
                    // Use shared giveawayBtnStyle but slightly smaller for the compact list row.
                    const rowBtnStyle = (color: string): React.CSSProperties => ({
                      ...giveawayBtnStyle(color),
                      padding: '1px 7px',
                      fontSize: `${Math.max(8, fontSize - 2)}px`,
                    });
                    return {
                      label: `[${g.shortId}] ${g.itemName}`,
                      value: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end', width: '100%' }}>
                          <span style={{ color: dimText, fontSize: `${Math.max(8, fontSize - 2)}px`, marginRight: '4px' }}>
                            {entryCount} · {timeLeft} · {g.creatorName}
                          </span>
                          {isOwnList ? (
                            <button style={rowBtnStyle('#FF6B4A')} onClick={() => sendGiveawayCmd('stop', g.shortId)}>
                              Cancel
                            </button>
                          ) : (<>
                            <button style={rowBtnStyle(glAccent)} onClick={() => sendGiveawayCmd('join', g.shortId)}>
                              Join
                            </button>
                            <button style={rowBtnStyle('#FF6B4A')} onClick={() => sendGiveawayCmd('leave', g.shortId)}>
                              Leave
                            </button>
                          </>)}
                        </span>
                      ) as React.ReactNode,
                      valueStyle: { overflow: 'visible' } as React.CSSProperties,
                    };
                  });
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard accent={glAccent} icon="🎁" tag="ACTIVE GIVEAWAYS"
                        title={`${gl.giveaways.length} active`}
                        fields={glFields} hexAlpha={hexAlpha} fontFamily={theme.fontFamily} fontSize={fontSize} dimText={dimText} singleColumn />
                    </div>
                  );
                }
                // ── Giveaway history card ───────────────────────────────────
                if (md && md.type === 'giveaway_history') {
                  const gh = md as GiveawayHistoryMetadata;
                  const ghAccent = hexAlpha(primaryColor, 0.6);
                  if (gh.giveaways.length === 0) {
                    return (
                      <div key={msg.id} style={{ padding: '2px 8px' }}>
                        <ChatEmbedCard accent={ghAccent} icon="📋" tag="GIVEAWAY HISTORY" title="No completed giveaways yet"
                          fields={[]} hexAlpha={hexAlpha} fontFamily={theme.fontFamily} fontSize={fontSize} dimText={dimText} />
                      </div>
                    );
                  }
                  const ghFields = gh.giveaways.map(g => {
                    const icon = g.status === 'cancelled' ? '❌' : g.winnerName ? '🎉' : '🎁';
                    const result = g.winnerName ? `Winner: ${g.winnerName}` : (g.status === 'cancelled' ? 'Cancelled' : 'No entries');
                    return { label: `${icon} ${g.shortId}`, value: `${g.itemName} · ${result} · ${g.entryCount} entries · by ${g.creatorName}` };
                  });
                  return (
                    <div key={msg.id} style={{ padding: '2px 8px' }}>
                      <ChatEmbedCard accent={ghAccent} icon="📋" tag="GIVEAWAY HISTORY"
                        title={`Last ${gh.giveaways.length} giveaway${gh.giveaways.length === 1 ? '' : 's'}`}
                        fields={ghFields} hexAlpha={hexAlpha} fontFamily={theme.fontFamily} fontSize={fontSize} dimText={dimText} singleColumn />
                    </div>
                  );
                }
                // Parity with desktop overlay: Discord-relayed → purple [Discord];
                // server → amber [Server]; party → [PartyName]; otherwise channel
                // name (Trading → "Trade"). System (bot) messages get no tag.
                const { label: tagName, color: tagColor } = channelTag(msg, flattenedChannels, parties, inactiveTab, activeSubId);
                const contentColor = (() => {
                  const rc = msg.responseColor;
                  if (!rc) return textRgba;
                  if (rc === 'channel') return hexAlpha(tagColor, textAlpha);
                  if (rc === 'user') return hexAlpha(primaryColor, textAlpha);
                  return hexAlpha(rc, textAlpha);
                })();
                const mentionsMe = msgMentionsMe(msg);
                return (
                  <div key={msg.id}
                    data-mention-msg={mentionsMe ? '1' : undefined}
                    data-msg-id={msg.id}
                    onMouseEnter={() => setHoveredMsg(msg.id)}
                    onMouseLeave={() => setHoveredMsg(null)}
                    onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, msg }); }}
                    style={{
                      fontSize: `${fontSize}px`, lineHeight: `${lineH}px`,
                      wordBreak: 'break-word', padding: '1px 8px',
                      display: 'flex', alignItems: 'baseline', gap: `${scaleGap(4)}px`,
                      background: mentionsMe
                        ? hexAlpha(primaryColor, 0.07)
                        : (hoveredMsg === msg.id && isMod ? hexAlpha(primaryColor, 0.04) : 'transparent'),
                      borderLeft: mentionsMe ? `2px solid ${primaryColor}` : '2px solid transparent',
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      {tagName && (() => {
                        // ALL feed tags are clickable: click a tag to jump to that
                        // party or channel. NO special "clickable" styling (no dotted
                        // underline/box) — just a pointer cursor.
                        const isParty = msg.source === 'party';
                        const target = isPublicMode ? null
                          : isParty ? msg.channelId
                          : (msg.channelId && msg.channelId !== 'system' && !msg.channelId.startsWith('server:') ? msg.channelId : null);
                        const clickable = isMainFeedView && !!target;
                        return (
                          <span
                            style={{
                              color: hexAlpha(tagColor, textAlpha), marginRight: `${scaleGap(4)}px`, fontWeight: 'normal',
                              borderRadius: '2px', padding: '0 1px',
                              // Base glow (scaled by text opacity) so the tag is as bright
                              // as the other text; the hover brightens it further.
                              textShadow: glowEnabled ? `0 0 3px ${hexAlpha(tagColor, 0.5 * textAlpha)}, ${textOutline}` : undefined,
                              transition: 'background 120ms ease, text-shadow 120ms ease',
                              ...(clickable ? { cursor: 'pointer' } : {}),
                            }}
                            title={clickable ? `Go to ${tagName}` : undefined}
                            // Hover affordance (parity with the .username-chip hover): a
                            // tinted background + glow in the tag's OWN color so it reads
                            // as clickable without losing the channel/party color.
                            onMouseEnter={clickable ? (e) => {
                              e.currentTarget.style.background = hexAlpha(tagColor, 0.16);
                              e.currentTarget.style.textShadow = `0 0 6px ${hexAlpha(tagColor, 0.55)}`;
                            } : undefined}
                            onMouseLeave={clickable ? (e) => {
                              e.currentTarget.style.background = 'transparent';
                              e.currentTarget.style.textShadow = glowEnabled ? `0 0 3px ${hexAlpha(tagColor, 0.5 * textAlpha)}, ${textOutline}` : textOutline;
                            } : undefined}
                            onClick={clickable ? (e) => {
                              e.stopPropagation();
                              if (isParty) { setActiveMainId(PARTY_MAIN_ID); setPartyView(target!); }
                              else { setActiveSubId(target!); }
                            } : undefined}
                          >
                            [{tagName}]
                          </span>
                        );
                      })()}
                      {settings.showTimestamps && (() => {
                        // Optional per-message timestamp, rendered in the viewer's
                        // LOCAL time (right of the channel tag, before the name).
                        const ts = formatMessageTimestamp(msg.timestamp, settings.timestampFormat);
                        if (!ts) return null;
                        return (
                          <span style={{
                            color: hexAlpha(theme.textColor, 0.45 * textAlpha),
                            marginRight: `${scaleGap(4)}px`,
                            // A touch smaller than the message text; `em` keeps it
                            // proportional as the user changes the chat font size.
                            fontSize: '0.82em',
                            fontWeight: 'normal',
                            fontVariantNumeric: 'tabular-nums',
                            textShadow: glowEnabled ? textOutline : undefined,
                          }}>
                            {ts}
                          </span>
                        );
                      })()}
                      {msg.userId && msg.userId !== 'system' ? (
                        isPublicMode ? (
                          <Link to={`/profile/${msg.userId}`} className="username-chip" style={{
                            fontWeight: 'bold', color: primaryText, textShadow: glowEnabled ? `0 0 3px ${hexAlpha(primaryColor, 0.5 * textAlpha)}, ${textOutline}` : textOutline,
                          }}>
                            {displayName}:{' '}
                          </Link>
                        ) : (
                          <span role="button" tabIndex={0} className="username-chip username-chip--mention" style={{
                            fontWeight: 'bold', color: primaryText, textShadow: glowEnabled ? `0 0 3px ${hexAlpha(primaryColor, 0.5 * textAlpha)}, ${textOutline}` : textOutline,
                            cursor: 'pointer',
                          }} onClick={() => insertMentionFromClick(displayName)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') insertMentionFromClick(displayName); }}>
                            {displayName}:{' '}
                          </span>
                        )
                      ) : (
                        <span style={{ fontWeight: 'bold', color: primaryText, textShadow: glowEnabled ? `0 0 3px ${hexAlpha(primaryColor, 0.5 * textAlpha)}, ${textOutline}` : textOutline }}>
                          {displayName}:{' '}
                        </span>
                      )}
                      <span style={{
                        color: contentColor,
                        fontWeight: 600,
                        textShadow: glowEnabled ? `0 0 2px ${hexAlpha(primaryColor, 0.3 * textAlpha)}, ${textOutline}` : textOutline,
                      }}>
                        {inlineContent ?? renderContent(msg.content, activeMainId === PARTY_MAIN_ID && partyView !== 'browser')}
                      </span>
                    </span>
                  </div>
                );
              })
  , [visibleMessages, resolveUsername, renderContent, scaleGap, msgMentionsMe, shareCardToChat, flattenedChannels, parties, inactiveTab, isMainFeedView, isPublicMode, partyView, activeMainId, activeSubId, hoveredMsg, isMod, primaryColor, primaryText, textAlpha, textRgba, glowEnabled, textOutline, theme, fontSize, lineH, settings, cardShareCooldown, dimText]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', alignItems: 'stretch' }}>
      <style style={{ display: 'none' }}>{`
        @keyframes fcm-tip-in { from { opacity: 0; transform: translate(-50%, -2px); } to { opacity: 1; transform: translate(-50%, 0); } }
        .fcm-scrollbar::-webkit-scrollbar { width: 4px; }
        .fcm-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .fcm-scrollbar::-webkit-scrollbar-thumb { background: ${hexAlpha(primaryColor, 0.25)}; }
        .fcm-rich-input::-webkit-scrollbar { width: 4px; }
        .fcm-rich-input::-webkit-scrollbar-track { background: transparent; }
        .fcm-rich-input::-webkit-scrollbar-thumb { background: ${hexAlpha(primaryColor, 0.25)}; }
        /* Rich input placeholder is now a sibling span controlled by React
           (inputText === '') so it never depends on :empty / :has DOM heuristics
           that break when Chromium/Electron inserts stray <div>/<br> nodes
           during multi-line wrapping. No CSS rule needed here. */
      `}</style>

      {/* ── Overlay container ── */}
      <div style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        // Chat-area background fill. Its alpha is driven by Background Opacity
        // (--fcm-chrome-bg-alpha → chromeBgAlpha → bgRgba), so 0 = transparent
        // (game shows through), 1 = opaque — same control as the main/sub tab
        // and input backgrounds.
        background: bgRgba,
        border: `1px solid ${borderRgba}`,
        fontFamily: theme.fontFamily,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        // Game-style soft black halo behind ALL text in the overlay. text-shadow
        // inherits to every descendant text node, so tags, input, char-count,
        // footer hints, version, etc. all get the "pop" without per-element edits.
        // Elements that set their own textShadow (tabs, usernames, message body)
        // override this; ones left undefined inherit it. SVG icons don't honor
        // text-shadow, so the header buttons add a drop-shadow filter separately.
        textShadow: textOutline,
      }}>

        {/* ── Chat lightbox — absolutely fills this position:relative container ── */}
        {chatLightboxSrc && (
          <ImageLightbox
            src={chatLightboxSrc}
            accentColor={primaryColor}
            onClose={() => setChatLightboxSrc(null)}
          />
        )}

        {/* ── Top row: main channel tabs + status dot + buttons ── */}
        <div ref={tabRowRef} data-fcm-main-tab-row="" style={{
          display: 'flex', alignItems: 'center', flexWrap: 'nowrap', overflow: 'hidden',
          // 8px left inset in the shell so the active main tab's text "F" lands
          // at x=16 (8 row + 8 tab) — the SAME x as the sub-tab "G" below.
          padding: overlayShell ? '0 6px 0 8px' : '0 6px',
          // Trimmed in the shell (28→23) so the bottom-aligned main tab sits near
          // the top with only a thin gap above — cuts the dead black space above
          // the tab bar and lifts the tab + its text up a few px.
          height: overlayShell ? '23px' : '28px',
          background: 'transparent',
          flexShrink: 0, gap: '0',
          position: 'relative',
          // Frameless-window drag handle: grabbing EMPTY header space moves the
          // window; interactive children opt out with no-drag (set below).
          ...(overlayShell ? { WebkitAppRegion: 'drag' } as React.CSSProperties : {}),
        }}>
          {/* Main channel tabs. With the live data model there is a SINGLE main
              channel ("Fallout 76"), so this single active tab IS the title — no
              separate title element is added (that would duplicate it). The 4
              sub-channels (General/Trading/Events/Raids) render in the row below. */}
          {mainChannels.map(ch => renderMainTab(ch))}

          {/* Synthetic Party main tab — shown when PARTIES_ENABLED. In public
              (logged-out) mode it lists ONLY public parties and is read-only. */}
          {partiesAvailable !== false && (
            <PartyErrorBoundary fallback={null}>{renderPartyMainTab()}</PartyErrorBoundary>
          )}
          {!isPublicMode && renderPmMainTab()}

          {/* Push buttons to the right */}
          <div style={{ flex: 1 }} />

          {/* Copy flash indicator */}
          {copyFlash && (
            <span style={{
              fontSize: '8px', color: primaryColor, letterSpacing: '1px',
              marginRight: '6px', opacity: 0.9, flexShrink: 0,
            }}>✓ COPIED</span>
          )}

          {/* Offline outbox pending indicator — shown only when disconnected with queued messages */}
          {!connected && !isPublicMode && outboxCount > 0 && (
            <span style={{
              fontSize: '8px', color: '#FFB000', letterSpacing: '1px',
              marginRight: '4px', opacity: 0.9, flexShrink: 0,
            }}>{outboxCount} queued</span>
          )}

          {/* Live status dot */}
          <span style={{
            width: '5px', height: '5px', borderRadius: '50%', marginRight: '4px',
            background: connected ? primaryColor : '#FFB000',
            boxShadow: connected ? `0 0 4px ${primaryColor}` : '0 0 4px #FFB000',
            flexShrink: 0,
          }} />

          {/* Settings / minimize / close. The refresh/minimize/close icons only
              appear in the Electron desktop shell (overlayShell); the website
              shows just the settings cog as before. */}
          {([
            ...(overlayShell?.onRefresh ? [{ key: 'refresh' as const, title: 'Refresh', onClick: () => overlayShell.onRefresh!() }] : []),
            { key: 'cog' as const, title: 'Settings', onClick: () => (overlayShell?.onSettings ? overlayShell.onSettings() : setSettingsOpen(s => !s)) },
            ...(overlayShell?.onMinimize ? [{ key: 'min' as const, title: 'Minimize', onClick: () => overlayShell.onMinimize!() }] : []),
            // Party member-panel toggle sits between minimize and close, only in a party.
            ...((!isPublicMode && isOnPartyTab && partyView !== 'browser') ? [{ key: 'members' as const, title: memberPanelOpen ? 'Hide members' : 'Show members', onClick: () => setMemberPanelOpen(o => !o) }] : []),
            ...(overlayShell?.onClose ? [{ key: 'close' as const, title: 'Close', onClick: () => overlayShell.onClose!() }] : []),
          ]).map(b => (
            <span key={b.key}
              onMouseEnter={() => {
                if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = window.setTimeout(() => setHoveredBtn(b.key), 800);
              }}
              onMouseLeave={() => {
                if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
                setHoveredBtn(null);
              }}
              onClick={b.onClick} style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: '16px', height: '16px', marginLeft: '2px',
              cursor: 'pointer',
              color: b.key === 'close' && hoveredBtn === 'close' ? '#FF6644' : hexAlpha(primaryColor, textAlpha),
              userSelect: 'none',
              position: 'relative', flexShrink: 0,
              // SVG icons ignore text-shadow, so give them a lighter dark backing
              // via drop-shadow filters. Kept softer than the text halo — the small
              // icons looked over-darkened with the full stack.
              filter: `drop-shadow(0 0 1px rgba(0,0,0,${textOutlineA})) drop-shadow(0 1px 1px rgba(0,0,0,${textOutlineB}))`,
              // Header buttons fire their action, not a window drag.
              ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
            }}>
              {hoveredBtn === b.key && (
                <span style={{
                  position: 'absolute', top: '18px', left: '50%', transform: 'translateX(-50%)',
                  padding: '2px 6px', background: bgRgba,
                  border: `1px solid ${hexAlpha(primaryColor, 0.5)}`, color: primaryColor,
                  fontSize: '8px', letterSpacing: '1px', whiteSpace: 'nowrap',
                  animation: 'fcm-tip-in 0.3s ease-out', pointerEvents: 'none', zIndex: 10,
                }}>{b.title.toUpperCase()}</span>
              )}
              {b.key === 'cog' && (
                <svg width="12" height="12" viewBox="-8 -8 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                  <circle cx="0" cy="0" r="4.2" />
                  <circle cx="0" cy="0" r="1.3" fill="currentColor" stroke="none" />
                  {[0,60,120,180,240,300].map(d => {
                    const a = d * Math.PI / 180;
                    const r1 = 4.2, r2 = 6.4;
                    return <line key={d} x1={Math.cos(a)*r1} y1={Math.sin(a)*r1} x2={Math.cos(a)*r2} y2={Math.sin(a)*r2} />;
                  })}
                </svg>
              )}
              {b.key === 'refresh' && (
                <svg width="12" height="12" viewBox="-8 -8 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                  <path d="M5.5 -2.5 A5 5 0 1 0 6 2" />
                  <path d="M5.5 -5 L5.5 -2.5 L3 -2.5" />
                </svg>
              )}
              {b.key === 'min' && (
                <svg width="12" height="12" viewBox="-8 -8 16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <line x1="-5" y1="0" x2="5" y2="0" />
                </svg>
              )}
              {b.key === 'close' && (
                <svg width="12" height="12" viewBox="-8 -8 16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <line x1="-4.5" y1="-4.5" x2="4.5" y2="4.5" />
                  <line x1="4.5" y1="-4.5" x2="-4.5" y2="4.5" />
                </svg>
              )}
              {b.key === 'members' && (
                <svg width="12" height="12" viewBox="-8 -8 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  {memberPanelOpen
                    ? <polyline points="2,-5 -3,0 2,5" />
                    : <polyline points="-2,-5 3,0 -2,5" />}
                </svg>
              )}
            </span>
          ))}

          {/* ── Active-tab "cutout" divider (desktop parity, ChatOverlayWindow.cs) ──
              A horizontal line at the BOTTOM of the main-tab row that spans the
              full width EXCEPT under the active main tab — drawn as two segments:
              [0 → activeTab.left] and [activeTab.right → full width]. The active
              tab's open bottom then "sits" on this line. Both shell + website. */}
          {tabCutout && (subChannels.length > 0 || isOnPartyTab) && (
            <>
              <div style={{
                position: 'absolute', left: 0, bottom: 0, height: '1px',
                width: `${Math.max(0, tabCutout.left)}px`,
                background: hexAlpha(primaryColor, 0.45), pointerEvents: 'none',
              }} />
              <div style={{
                position: 'absolute', right: 0, bottom: 0, height: '1px',
                left: `${tabCutout.right}px`,
                background: hexAlpha(primaryColor, 0.45), pointerEvents: 'none',
              }} />
            </>
          )}
        </div>

        {/* ── Bottom row: sub-channel tabs OR party sub-tabs ── */}
        {isOnPartyTab ? (
          /* Party sub-tab row */
          <PartyErrorBoundary fallback={null}>
          <div data-fcm-subtab-row="party" style={{
            display: 'flex', alignItems: 'center',
            // Match the FO76 sub-tab row: 15px web inset aligns the first label
            // under the main-tab "F". 16px in the shell.
            padding: overlayShell ? '0 6px 0 16px' : '0 6px 0 15px',
            height: '22px',
            boxSizing: 'border-box',
            background: chromeRgba,
            // Full-width divider line UNDER the sub-tab row — identical to the
            // Fallout 76 sub-tab row below. Separates the tabs from the content.
            // Brightened on the website (was the dim borderRgba) to match.
            borderBottom: overlayShell ? `1px solid ${hexAlpha(primaryColor, 0.45)}` : `1px solid ${hexAlpha(primaryColor, 0.45)}`,
            flexShrink: 0,
            ...(overlayShell ? { WebkitAppRegion: 'drag' } as React.CSSProperties : {}),
          }}>
            {/* "Public Parties" pinned left */}
            <span
              onClick={() => setPartyView('browser')}
              style={{
                fontSize: overlayShell ? `${Math.max(8, fontSize - 1)}px` : `${fontSize}px`,
                letterSpacing: tabLetterSpacing,
                cursor: 'pointer',
                color: partyView === 'browser' ? primaryColor : inactiveTab,
                fontWeight: partyView === 'browser' ? 'bold' : 'normal',
                textTransform: 'uppercase' as const,
                marginRight: `${scaleGap(12)}px`,
                // Parity: no underline on either shell or website.
                borderBottom: 'none',
                paddingBottom: '1px',
                userSelect: 'none',
                display: 'inline-flex', alignItems: 'center', flexShrink: 0,
                textShadow: partyView === 'browser' && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
                ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
              }}
            >
              {pendingInviteCount > 0 && <UnreadBadge n={pendingInviteCount} />}
              PARTIES
            </span>
            {/* Joined party sub-tabs — visible row (measurement-based overflow). */}
            <div ref={partyTabsRowRef} style={{ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', overflow: 'hidden', flex: 1, minWidth: 0, position: 'relative' }}>
              {(() => {
                // Public visitors join nothing — show a single sub-tab for the
                // public party currently being viewed (read-only), so they have
                // a tab to read its chat under. No overflow logic needed.
                if (isPublicMode) {
                  if (partyView === 'browser') return null;
                  const p = parties.find(pp => pp.id === partyView);
                  if (!p) return null;
                  return (
                    <span key={p.id} onClick={() => setPartyView(p.id)} style={partyTabStyle(true)}>
                      {partyTabLabel(p)}
                    </span>
                  );
                }
                // Default to all joined parties before the first measurement pass.
                const visibleIds = partyVisibleIds.length > 0 || partyOverflowIds.length > 0
                  ? partyVisibleIds
                  : joinedParties.map(p => p.id);
                const byId = new Map(joinedParties.map(p => [p.id, p] as const));
                return visibleIds.map(id => {
                  const p = byId.get(id);
                  if (!p) return null;
                  const isActive = partyView === p.id;
                  const partyUnread = unreadMentions[p.id] || 0;
                  return (
                    <span
                      key={p.id}
                      onClick={() => setPartyView(p.id)}
                      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setPartyTabCtx({ x: e.clientX, y: e.clientY, partyId: p.id }); }}
                      style={partyTabStyle(isActive)}
                    >
                      {partyUnread > 0 && <UnreadBadge n={partyUnread} onClick={e => { e.stopPropagation(); setActiveMainId(PARTY_MAIN_ID); setPartyView(p.id); pendingJumpRef.current = true; }} />}
                      {p.isPrivate && <LockIcon size={overlayShell ? Math.max(8, fontSize - 2) : fontSize - 1} />}
                      {partyTabLabel(p)}
                    </span>
                  );
                });
              })()}
              {/* Trailing "…" overflow button — only when something overflows. */}
              {partyOverflowIds.length > 0 && (
                <span
                  onClick={e => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPartyOverflowCtx({ x: r.left, right: window.innerWidth - r.right, y: r.bottom }); }}
                  title={`${partyOverflowIds.length} more`}
                  style={{
                    fontSize: overlayShell ? `${Math.max(8, fontSize - 1)}px` : `${fontSize}px`,
                    letterSpacing: '0.04em', cursor: 'pointer',
                    color: partyOverflowCtx ? primaryColor : inactiveTab,
                    fontWeight: 'bold', userSelect: 'none', whiteSpace: 'nowrap',
                    display: 'inline-flex', alignItems: 'center', flexShrink: 0,
                    paddingBottom: '1px', marginLeft: 'auto', paddingLeft: '4px',
                    ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
                  }}
                >▾ ({partyOverflowIds.length})</span>
              )}
            </div>
            {/* Hidden measurement row — always renders ALL joined-party tabs at
                natural width so the overflow calc can read each tab's size even
                while it's hidden inside "…". aria-hidden + pointer-events:none. */}
            <div
              ref={partyMeasureRowRef}
              aria-hidden
              style={{
                position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
                display: 'flex', whiteSpace: 'nowrap', top: 0, left: 0,
              }}
            >
              {joinedParties.map(p => (
                <span
                  key={p.id}
                  ref={el => { if (el) partyTabRefs.current.set(p.id, el); else partyTabRefs.current.delete(p.id); }}
                  style={partyTabStyle(partyView === p.id)}
                >
                  {p.isPrivate && <LockIcon size={overlayShell ? Math.max(8, fontSize - 2) : fontSize - 1} />}
                  {partyTabLabel(p)}
                </span>
              ))}
              <span ref={partyEllipsisRef} style={{
                fontSize: overlayShell ? `${Math.max(8, fontSize - 1)}px` : `${fontSize}px`,
                letterSpacing: '0.04em', fontWeight: 'bold', whiteSpace: 'nowrap',
                display: 'inline-flex', alignItems: 'center', paddingLeft: '4px',
              }}>▾ (9)</span>
            </div>
          </div>
          </PartyErrorBoundary>
        ) : subChannels.length > 0 && (
          <div data-fcm-subtab-row="channels" style={{
            display: 'flex', alignItems: 'center', flexWrap: 'nowrap', overflow: 'hidden',
            // Sub-row inset mirrors the main-row's left inset + the 1px border,
            // so "G" (General) aligns with "F" (Fallout 76) above.
            // Shell: main-row=15px + border=1px → F at 16 → sub-row=16px.
            // Web:   main-row=14px + border=1px → F at 15 → sub-row=15px.
            // Box left is 1px shy of F (border width), which is within spec.
            padding: overlayShell ? '0 6px 0 16px' : '0 6px 0 15px',
            height: '22px',
            boxSizing: 'border-box',
            background: chromeRgba,
            // Full-width divider line UNDER the sub-tab row (both shell + website).
            // The main-tab row above has its own "cutout" divider; this is the
            // second, full line beneath the sub-tabs. The website divider was too
            // dim (borderRgba) — brighten it to a clearly-visible theme line.
            borderBottom: overlayShell ? `1px solid ${hexAlpha(primaryColor, 0.45)}` : `1px solid ${hexAlpha(primaryColor, 0.45)}`,
            flexShrink: 0,
            // The sub-tab row's empty space is also a window-drag handle.
            ...(overlayShell ? { WebkitAppRegion: 'drag' } as React.CSSProperties : {}),
          }}>
            {subChannels.filter(sub => !hiddenChannelIds.has(sub.id)).map(sub => {
              const isActive = sub.id === activeSubId;
              const unread = unreadMentions[sub.id] || 0;
              const label = sub.name; // ALL-CAPS applied via textTransform below
              return (
                <span key={sub.id} onClick={() => setActiveSubId(sub.id)} style={{
                  // Sub-tab font is SMALLER than the main-tab title font
                  // (main = fontSize+1, sub = fontSize-1) in the shell.
                  fontSize: overlayShell ? `${Math.max(8, fontSize - 1)}px` : `${fontSize}px`,
                  letterSpacing: tabLetterSpacing,
                  cursor: 'pointer',
                  // Desktop parity: the ACTIVE sub-tab is full-brightness amber
                  // (#C8A840 = primaryColor) bold text — same amber as the active
                  // main tab; inactive sub-tabs are dimmed amber (inactiveTab).
                  color: isActive ? primaryText : inactiveTabText,
                  fontWeight: 'bold',
                  textTransform: 'uppercase' as const,
                  marginRight: `${scaleGap(12)}px`,
                  textShadow: isActive && glowEnabled ? `0 0 6px ${hexAlpha(primaryColor, 0.6 * textAlpha)}, ${textOutline}` : textOutline,
                  // No underline/box on EITHER shell or website — parity with
                  // ChatOverlayWindow.cs, which draws sub-tabs as text only. The
                  // active sub-tab is shown via brighter/bold amber text instead.
                  borderBottom: 'none',
                  paddingBottom: '1px',
                  userSelect: 'none',
                  whiteSpace: 'nowrap', flexShrink: 0,   // sub-tab label never wraps mid-word
                  display: 'inline-flex', alignItems: 'center',
                  // Clicking a sub-tab switches channel (not a drag).
                  ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
                }}>
                  {unread > 0 && <UnreadBadge n={unread} onClick={e => jumpToSubMention(e, sub.id)} />}
                  {giveawayActive && sub.id === '00000000-0000-0000-0000-000000000003' && (
                    <span title="Giveaway in progress!" style={{
                      fontSize: `${Math.max(7, fontSize - 2)}px`,
                      marginRight: '3px',
                      color: primaryColor,
                      opacity: 0.9,
                      textShadow: glowEnabled ? `0 0 4px ${hexAlpha(primaryColor, 0.7)}` : 'none',
                      lineHeight: 1,
                    }}>★</span>
                  )}
                  {label}
                </span>
              );
            })}
          </div>
        )}

        {/* ── Report alerts (mod only) ── */}
        {isMod && reportAlerts.length > 0 && (
          <div style={{ padding: '2px 8px', flexShrink: 0 }}>
            {reportAlerts.map((r, i) => (
              <div key={`${r.id}-${i}`} style={{
                padding: '2px 6px', fontSize: '8px', color: '#FF4444',
                border: '1px solid rgba(255,68,68,0.3)', marginBottom: '2px',
              }}>
                REPORT: {r.reason}
              </div>
            ))}
          </div>
        )}

        {/* Wiki lookup fills the feed area; the input box stays below it */}
        {wikiPanelOpen && (
          <WikiPanel
            // Remount on every new search term so the panel's mount-time
            // fetchBestMatch(initialTerm) actually re-runs. Without this, opening
            // /wiki <new term> while the panel is already open kept showing the
            // previously-loaded entry (the "loads the wrong/old article" bug).
            key={wikiPanelTerm}
            theme={theme}
            chromeBgAlpha={chromeBgAlpha}
            primaryColor={primaryColor}
            isPublicMode={isPublicMode}
            onClose={() => setWikiPanelOpen(false)}
            initialTerm={wikiPanelTerm}
            exactTitle={wikiPanelExact}
            onShareToChat={handleWikiShareToChat}
            joinedParties={joinedParties}
          />
        )}

        {/* ── Messages area ── */}
        <div ref={messagesContRef} className="fcm-scrollbar" style={{
          flex: 1,
          display: wikiPanelOpen ? 'none' : undefined,
          // minHeight:0 is REQUIRED so this flex child can shrink below its
          // content height — otherwise it pushes the flexShrink:0 input row off
          // the bottom edge (regression seen with the empty contentEditable input,
          // which has no intrinsic min-height the way the old <textarea> did).
          minHeight: 0,
          overflow: 'hidden auto',
          padding: '4px 0',
          scrollbarWidth: 'thin',
          scrollbarColor: `${hexAlpha(primaryColor, 0.25)} transparent`,
        }}>
          {/* Auth-terminal notice — shown when ≥3 consecutive 401/403 ticket fetches
              occurred. Not shown in public mode (effect guard). Reuses the
              existing amber disconnected-indicator colour for consistency. */}
          {authTerminalState && !isPublicMode && (
            <div style={{
              padding: '4px 8px', fontSize: `${Math.max(10, fontSize - 2)}px`,
              color: '#FFB000', background: 'rgba(0,0,0,0.6)',
              borderBottom: '1px solid rgba(255,176,0,0.25)',
              fontFamily: '"Courier New", Courier, monospace',
              flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>Authentication expired — please refresh or sign in again.</span>
            </div>
          )}

          {/* Transient "missed messages" notice after a silent reconnect. */}
          {showMissedMsgNotice && !isPublicMode && (
            <div style={{
              padding: '3px 8px', fontSize: `${Math.max(10, fontSize - 2)}px`,
              color: hexAlpha(primaryColor, 0.8), background: 'rgba(0,0,0,0.5)',
              borderBottom: `1px solid ${hexAlpha(primaryColor, 0.2)}`,
              fontFamily: '"Courier New", Courier, monospace',
              flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>Reconnected — you may have missed messages while offline.</span>
              <span
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer', marginLeft: '8px', opacity: 0.7 }}
                onClick={() => setShowMissedMsgNotice(false)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowMissedMsgNotice(false); }}
                title="Dismiss"
              >✕</span>
            </div>
          )}

          {isOnPartyTab && partyView === 'browser' ? (
            <PartyErrorBoundary>{renderPartyContent()}</PartyErrorBoundary>
          ) : isOnPmTab && pmView === 'inbox' ? (
            renderPrivateInboxContent()
          ) : adminFeedActive ? (
            feedMessages.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: hexAlpha(theme.secondaryColor, 0.4),
                fontSize: `${fontSize}px`, fontFamily: '"Courier New", Courier, monospace',
              }}>
                No Server Transmissions Detected...
              </div>
            ) : (
              feedMessages.map(msg => {
                const feedTarget: ChatMessage = {
                  id: msg.id, content: msg.content, username: msg.username,
                  userId: msg.userId, channelId: `server:${msg.serverEndpoint}`,
                  source: 'server', timestamp: msg.createdAt,
                };
                const feedDisplayName = resolveUsername(feedTarget);
                const myEndpoint = membersData?.serverEndpoint ?? null;
                const isSameServer = myEndpoint && msg.serverEndpoint === myEndpoint;
                const endpointTagColor = isSameServer
                  ? hexAlpha(primaryColor, 0.7)
                  : '#FFB000';
                return (
                  <div key={msg.id}
                    onMouseEnter={() => setHoveredMsg(msg.id)}
                    onMouseLeave={() => setHoveredMsg(null)}
                    onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, msg: feedTarget }); }}
                    style={{
                      fontSize: `${fontSize}px`, lineHeight: `${lineH}px`,
                      wordBreak: 'break-word', padding: '1px 8px',
                      display: 'flex', alignItems: 'baseline', gap: `${scaleGap(4)}px`,
                      background: hoveredMsg === msg.id ? hexAlpha(primaryColor, 0.04) : 'transparent',
                    }}
                  >
                    <span style={{ flex: 1 }}>
                      <span style={{ fontWeight: 'bold', color: endpointTagColor, fontSize: `${Math.max(7, fontSize - 2)}px` }}>
                        [{msg.serverEndpoint}]{' '}
                      </span>
                      {msg.userId && msg.userId !== 'system' ? (
                        isPublicMode ? (
                          <Link to={`/profile/${msg.userId}`} className="username-chip" style={{
                            fontWeight: 'bold', color: primaryText, textShadow: glowEnabled ? `0 0 3px ${hexAlpha(primaryColor, 0.5 * textAlpha)}, ${textOutline}` : textOutline,
                          }}>
                            {feedDisplayName}:{' '}
                          </Link>
                        ) : (
                          <span role="button" tabIndex={0} className="username-chip username-chip--mention" style={{
                            fontWeight: 'bold', color: primaryText, textShadow: glowEnabled ? `0 0 3px ${hexAlpha(primaryColor, 0.5 * textAlpha)}, ${textOutline}` : textOutline,
                            cursor: 'pointer',
                          }} onClick={() => insertMentionFromClick(feedDisplayName)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') insertMentionFromClick(feedDisplayName); }}>
                            {feedDisplayName}:{' '}
                          </span>
                        )
                      ) : (
                        <span style={{ fontWeight: 'bold', color: primaryText, textShadow: glowEnabled ? `0 0 3px ${hexAlpha(primaryColor, 0.5 * textAlpha)}, ${textOutline}` : textOutline }}>
                          {feedDisplayName}:{' '}
                        </span>
                      )}
                      <span style={{
                        color: textRgba,
                        fontWeight: 600,
                        textShadow: glowEnabled ? `0 0 2px ${hexAlpha(primaryColor, 0.3 * textAlpha)}, ${textOutline}` : textOutline,
                      }}>
                        {renderContent(msg.content)}
                      </span>
                    </span>
                  </div>
                );
              })
            )
          ) : (
            <>
              {isOnPmTab && activePmConversation && (
                <div data-pm-conversation="true" style={{
                  padding: '4px 8px 6px',
                  borderBottom: `1px solid ${hexAlpha(primaryColor, 0.15)}`,
                  marginBottom: '4px',
                }}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setPmView('inbox')}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setPmView('inbox'); }}
                    style={{
                      color: primaryColor,
                      cursor: 'pointer',
                      fontSize: `${Math.max(10, fontSize - 1)}px`,
                      fontWeight: 'bold',
                      marginBottom: '4px',
                      textShadow: textOutline,
                    }}
                  >
                    {'< BACK TO INBOX'}
                  </div>
                  <div style={{
                    color: hexAlpha(primaryColor, 0.92),
                    fontSize: `${Math.max(11, fontSize)}px`,
                    fontWeight: 'bold',
                    textShadow: textOutline,
                  }}>
                    {activePmConversation.otherDisplayName}
                  </div>
                </div>
              )}
              {visibleMessages.length === 0 ? (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  height: '100%', color: hexAlpha(theme.secondaryColor, 0.4),
                  fontSize: `${fontSize}px`, fontFamily: '"Courier New", Courier, monospace',
                }}>
                  {isOnPmTab ? 'No Private Messages Yet...' : 'No Radio Signals Detected...'}
                </div>
              ) : (
                normalFeedRows
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* ── "Jump to mention" button — cross-channel only. Shows when an @mention
             arrived in a channel OTHER than the one currently in view. Clicking
             navigates to the most-mentioned channel and scrolls to the mention.
             Never shown for mentions in the active channel (the user can already
             see those). ── */}
        {!adminFeedActive && hasCrossChannelMention && (
          <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
            <button
              onClick={crossChannelJumpTarget
                ? (e => jumpToMainMention(e as React.MouseEvent, crossChannelJumpTarget))
                : jumpToMention}
              style={{
                background: hexToRgba(theme.chromeColor, Math.max(0.9, Math.min(1, 0.95 * chromeBgAlpha))),
                color: primaryColor,
                border: `1px solid ${hexAlpha(primaryColor, 0.8)}`,
                borderRadius: '4px',
                fontFamily: theme.fontFamily,
                fontSize: `${Math.max(8, fontSize - 1)}px`,
                padding: '1px 10px',
                cursor: 'pointer',
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
                lineHeight: '14px',
              }}
            >
              Jump to mention
            </button>
          </div>
        )}

        {/* ── Typing indicator — in-flow flex child between messages and input ── */}
        {showComposer && (() => {
          if (isOnPmTab) return null;
          const isParty = activeMainId === PARTY_MAIN_ID && partyView !== 'browser';
          const activeScopeKey = isParty ? `party:${partyView}` : `ch:${activeSubId}`;
          const myId = user?.id ?? '';
          const now = Date.now();
          const names = Object.entries(typingUsers)
            .filter(([uid, v]) => uid !== myId && v.scopeKey === activeScopeKey && v.clearAt > now)
            .map(([, v]) => v.username);
          if (names.length === 0) return null;
          const label = names.length === 1
            ? `${names[0]} is typing`
            : names.length === 2
              ? `${names[0]} and ${names[1]} are typing`
              : 'Several people are typing';
          return (
            <div style={{
              flexShrink: 0,
              padding: '1px 8px 3px', fontSize: '10px', fontFamily: theme.fontFamily,
              color: hexAlpha(primaryColor, 0.78), letterSpacing: '0.04em',
              userSelect: 'none', display: 'flex', alignItems: 'center', gap: '4px',
              textShadow: textOutline,
            }}>
              <span>{label}</span>
              <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'center' }}>
                <style style={{ display: 'none' }}>{`
                  @keyframes fcm-typing-dot {
                    0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
                    40% { opacity: 1; transform: translateY(-2px); }
                  }
                `}</style>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    display: 'inline-block', width: '3px', height: '3px', borderRadius: '50%',
                    background: primaryColor,
                    animation: `fcm-typing-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
                  }} />
                ))}
              </span>
            </div>
          );
        })()}

        {/* ── Input area ── */}
        <div style={{
          flexShrink: 0,
          position: 'relative',
          display: adminFeedActive ? 'none' : undefined,
        }}>
          {/* @ mention popup — grows upward above the input */}
          {mentionOpen && mentionSuggestions.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              zIndex: 101,
              background: menuBgColor(theme, chromeBgAlpha, 1.3),
              border: `1px solid ${borderBright}`,
              borderBottom: 'none',
              fontFamily: theme.fontFamily,
              // Cap height so a long suggestion list scrolls internally instead
              // of growing off the top of a short window (no effect when short).
              maxHeight: '150px',
              overflowY: 'auto',
            }}>
              {mentionSuggestions.map((s, idx) => (
                <div
                  key={s.displayName}
                  onMouseDown={e => { e.preventDefault(); selectMention(s.displayName, s.discordId); }}
                  onMouseEnter={() => setMentionIdx(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 8px',
                    height: '24px',
                    cursor: 'pointer',
                    background: idx === mentionIdx ? hexAlpha(primaryColor, 0.12) : 'transparent',
                    borderLeft: idx === mentionIdx ? `2px solid ${primaryColor}` : '2px solid transparent',
                    boxSizing: 'border-box',
                  }}
                >
                  <span style={{ color: hexAlpha(primaryColor, 0.55), fontSize: `${fontSize - 1}px` }}>@</span>
                  <span style={{
                    color: primaryColor,
                    fontSize: `${fontSize - 1}px`,
                    fontWeight: 'bold',
                    textShadow: glowEnabled ? `0 0 4px ${hexAlpha(primaryColor, 0.5)}` : 'none',
                  }}>
                    {s.displayName}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Wiki autocomplete — separate from slash-command autocomplete, mutually exclusive */}
          {wikiAcOpen && (() => {
            const wikiTerm = inputText.startsWith('/wiki ') ? inputText.slice('/wiki '.length).trimStart() : '';
            const wikiHint = wikiTerm.length < 2;
            const keyHint = (
              <div style={{ padding: '4px 10px', fontSize: '9px', letterSpacing: '0.03em', color: hexAlpha(dimText, 0.7) }}>
                &#8593;&#8595; select &middot; Enter / Tab to open &middot; or click a result
              </div>
            );
            return (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 101,
              background: menuBgColor(theme, chromeBgAlpha, 1.3),
              border: `1px solid ${borderBright}`, borderBottom: 'none',
              fontFamily: theme.fontFamily, maxHeight: '240px', overflowY: 'auto',
            }}>
              {/* Header: /wiki label + spinner while searching */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.1em', color: hexAlpha(primaryColor, 0.85), borderBottom: `1px solid ${hexAlpha(primaryColor, 0.12)}` }}>
                <span>/WIKI &mdash; FALLOUT 76 WIKI SEARCH</span>
                {wikiAcLoading && <SpinnerDot color={primaryColor} />}
              </div>

              {wikiHint && (
                <>
                  <div style={{ padding: '8px 10px 4px', fontSize: `${fontSize - 1}px`, color: dimText, lineHeight: 1.5 }}>
                    Start typing to search the Fallout&nbsp;76 wiki &mdash; weapons, armor, items, objects, creatures, locations, quest names, and more. The list updates as you type.
                  </div>
                  {keyHint}
                </>
              )}

              {!wikiHint && wikiAcLoading && wikiAcItems.length === 0 && (
                <div style={{ padding: '6px 10px', fontSize: '11px', color: dimText }}>Searching&hellip;</div>
              )}
              {!wikiHint && !wikiAcLoading && wikiAcItems.length === 0 && (
                <div style={{ padding: '6px 10px', fontSize: '11px', color: dimText }}>No results for &ldquo;{wikiTerm}&rdquo; &mdash; try another spelling.</div>
              )}
              {!wikiHint && wikiAcItems.map((item, idx) => (
                <div
                  key={item.id}
                  onMouseDown={e => { e.preventDefault(); selectWikiAcItem(item); }}
                  onMouseEnter={() => setWikiAcIndex(idx)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 8px',
                    cursor: 'pointer', height: '28px',
                    background: idx === wikiAcIndex ? hexAlpha(primaryColor, 0.12) : 'transparent',
                    borderLeft: idx === wikiAcIndex ? `2px solid ${primaryColor}` : '2px solid transparent',
                    boxSizing: 'border-box',
                  }}
                >
                  {/* Thumbnail — image with per-category glyph fallback */}
                  <div style={{ width: '28px', height: '24px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' }}>
                    <WikiAcThumb url={item.thumbnailUrl} kind={item.kind} primaryColor={primaryColor} />
                  </div>
                  <span style={{ flex: 1, minWidth: 0, fontSize: `${fontSize - 1}px`, color: theme.textColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  {item.kind && (
                    <span style={{ flexShrink: 0, fontSize: '8px', letterSpacing: '0.06em', padding: '1px 4px', border: `1px solid ${primaryColor}`, color: primaryColor }}>{wikiKindLabel(item.kind)}</span>
                  )}
                </div>
              ))}
              {!wikiHint && wikiAcItems.length > 0 && keyHint}
            </div>
            );
          })()}

          {/* CAMP autocomplete — separate from wiki/slash-command autocompletes */}
          {campAcOpen && (() => {
            const campTerm = inputText.startsWith('/camp ') ? inputText.slice('/camp '.length).trimStart() : '';
            const campHint = campTerm.length < 2;
            const keyHint = (
              <div style={{ padding: '4px 10px', fontSize: '9px', letterSpacing: '0.03em', color: hexAlpha(dimText, 0.7) }}>
                &#8593;&#8595; select &middot; Enter / Tab to fill &middot; or click a result
              </div>
            );
            return (
            <div style={{
              position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 101,
              background: menuBgColor(theme, chromeBgAlpha, 1.3),
              border: `1px solid ${borderBright}`, borderBottom: 'none',
              fontFamily: theme.fontFamily, maxHeight: '240px', overflowY: 'auto',
            }}>
              {/* Header: /camp label + spinner while searching */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.1em', color: hexAlpha(primaryColor, 0.85), borderBottom: `1px solid ${hexAlpha(primaryColor, 0.12)}` }}>
                <span>/CAMP &mdash; 76 CAMP DATABASE SEARCH</span>
                {campAcLoading && <SpinnerDot color={primaryColor} />}
              </div>

              {campHint && (
                <>
                  <div style={{ padding: '8px 10px 4px', fontSize: `${fontSize - 1}px`, color: dimText, lineHeight: 1.5 }}>
                    Start typing to search CAMP items &mdash; structures, furniture, crafting stations, generators, and more. The list updates as you type.
                  </div>
                  {keyHint}
                </>
              )}

              {!campHint && campAcLoading && campAcItems.length === 0 && (
                <div style={{ padding: '6px 10px', fontSize: '11px', color: dimText }}>Searching&hellip;</div>
              )}
              {!campHint && !campAcLoading && campAcItems.length === 0 && (
                <div style={{ padding: '6px 10px', fontSize: '11px', color: dimText }}>No results for &ldquo;{campTerm}&rdquo; &mdash; try another spelling.</div>
              )}
              {!campHint && campAcItems.map((item, idx) => (
                <div
                  key={`${item.name}-${idx}`}
                  onMouseDown={e => { e.preventDefault(); selectCampAcItem(item); }}
                  onMouseEnter={() => setCampAcIndex(idx)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 8px',
                    cursor: 'pointer', height: '28px',
                    background: idx === campAcIndex ? hexAlpha(primaryColor, 0.12) : 'transparent',
                    borderLeft: idx === campAcIndex ? `2px solid ${primaryColor}` : '2px solid transparent',
                    boxSizing: 'border-box',
                  }}
                >
                  {/* Thumbnail — image with per-category icon fallback */}
                  <div style={{ width: '28px', height: '24px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' }}>
                    <CampAcThumb url={item.imageUrl} category={item.category} primaryColor={primaryColor} />
                  </div>
                  <span style={{ flex: 1, minWidth: 0, fontSize: `${fontSize - 1}px`, color: theme.textColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  <span style={{ flexShrink: 0, fontSize: '9px', color: hexAlpha(dimText, 0.8), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '120px' }}>{item.category} &rsaquo; {item.subCategory}</span>
                </div>
              ))}
              {!campHint && campAcItems.length > 0 && keyHint}
            </div>
            );
          })()}

          {/* Autocomplete popup — grows upward above the input */}
          {acOpen && acSuggestions.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              right: 0,
              zIndex: 100,
              background: menuBgColor(theme, chromeBgAlpha, 1.3),
              border: `1px solid ${borderBright}`,
              borderBottom: 'none',
              fontFamily: theme.fontFamily,
              maxHeight: '150px',
              overflowY: 'auto',
            }}>
              {acSuggestions.map((cmd, idx) => (
                <div
                  key={cmd.trigger}
                  onMouseDown={e => { e.preventDefault(); selectAcSuggestion(cmd); }}
                  onMouseEnter={() => setAcIndex(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '8px',
                    padding: '3px 8px',
                    height: '24px',
                    cursor: 'pointer',
                    background: idx === acIndex ? hexAlpha(primaryColor, 0.12) : 'transparent',
                    borderLeft: idx === acIndex ? `2px solid ${primaryColor}` : '2px solid transparent',
                    boxSizing: 'border-box',
                  }}
                >
                  <span style={{
                    fontWeight: 'bold',
                    color: primaryColor,
                    fontSize: `${fontSize - 1}px`,
                    flexShrink: 0,
                    textShadow: glowEnabled ? `0 0 4px ${hexAlpha(primaryColor, 0.5)}` : 'none',
                  }}>
                    {cmd.trigger}
                  </span>
                  <span style={{
                    color: dimText,
                    fontSize: `${fontSize - 2}px`,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {cmd.description}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Hide input in public/logged-out mode (read-only) and party browser view */}
          {showComposer && <div style={{
            background: inputBgRgba, paddingTop: '6px', paddingBottom: '8px',
            borderTop: `1px solid ${borderRgba}`,
          }}>
          {muteState && (
            <div style={{
              padding: '4px 10px', fontSize: `${fontSize}px`, fontFamily: theme.fontFamily,
              color: hexAlpha('#FFB000', 0.95), background: 'rgba(255,176,0,0.08)',
              borderBottom: `1px solid ${hexAlpha('#FFB000', 0.4)}`,
            }}>
              🔇 You are muted{muteState.until ? ` until ${new Date(muteState.until).toLocaleString()}` : ''}
              {muteState.category || muteState.reason ? ' — ' : ''}
              {muteState.category ? `${muteState.category}: ` : ''}{muteState.reason ?? ''}
            </div>
          )}
          {/* alignItems: 'center' vertically centers emoji/GIF buttons and char counter with the input caret. */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px', opacity: muteState ? 0.4 : 1 }}>
            <span style={{
              color: hexAlpha(primaryColor, 0.85 * textAlpha),
              fontSize: `${fontSize + 2}px`,
              fontFamily: theme.fontFamily,
              fontWeight: 'bold',
              marginRight: '4px',
              lineHeight: '18px',
              alignSelf: 'center',
            }}>
              &gt;
            </span>
            {/* Overlay path: rich contentEditable input with inline custom emoji images.
                Website path: plain textarea. Both paths share the same onKeyDown handler. */}
            {overlayShell ? (
              <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                {/* Placeholder rendered as a positioned overlay, NOT as ::before content.
                    Visibility is driven purely by React state (inputText === '') so it
                    is immune to stray <br>/<div> nodes Chromium inserts during
                    multi-line wrapping. pointer-events:none means it never blocks
                    clicks or the caret. */}
                {inputText === '' && !muteState && (
                  <span style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    color: hexAlpha(primaryColor, 0.78 * textAlpha),
                    opacity: 1,
                    pointerEvents: 'none',
                    userSelect: 'none',
                    fontFamily: theme.fontFamily,
                    fontSize: `${fontSize}px`,
                    lineHeight: '18px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    zIndex: 0,
                  }}>
                    {inputPlaceholder}
                  </span>
                )}
              <div
                ref={richInputRef}
                contentEditable={muteState ? 'false' : 'true'}
                suppressContentEditableWarning
                // data-placeholder removed — placeholder is now a sibling span
                onInput={e => {
                  const el = e.currentTarget as HTMLDivElement;
                  const raw = serializeRichInput(el);
                  const clamped = raw.slice(0, 255);
                  if (raw.length > 255) {
                    // Trim and re-render so the visual matches the clamped value
                    el.innerHTML = buildRichHtml(clamped);
                    // Move caret to end
                    const r = document.createRange();
                    r.selectNodeContents(el);
                    r.collapse(false);
                    const s = window.getSelection();
                    if (s) { s.removeAllRanges(); s.addRange(r); }
                  }
                  // When the field is semantically empty, purge any stray nodes
                  // (lone <br>, empty <div>, etc.) that Chromium/Electron inserts
                  // after multi-line wrapping + backspace. Without this the :empty
                  // CSS selector never fires, the placeholder re-appears as if it
                  // were real content, and backspace can't reach the start of the
                  // field because there are phantom block elements in the way.
                  if (clamped === '' && el.innerHTML !== '') {
                    el.innerHTML = '';
                  }
                  // First-char artifact: typing the FIRST character into an empty
                  // contentEditable can make Chromium/Electron wrap it in stray
                  // empty blocks / <br>s, producing a LEADING or trailing newline
                  // that pushes the text onto a second line. On the empty→non-empty
                  // transition, strip leading/trailing newlines and rebuild the
                  // field as plain text so it sits on line 1. (A leading/trailing
                  // newline is never part of the sent message.)
                  let finalText = clamped;
                  if (inputText === '' && clamped !== '') {
                    const cleaned = clamped.replace(/^\n+/, '').replace(/\n+$/, '');
                    if (cleaned !== clamped || /<div|<br/i.test(el.innerHTML)) {
                      finalText = cleaned;
                      el.innerHTML = buildRichHtml(cleaned);
                      const r = document.createRange();
                      r.selectNodeContents(el);
                      r.collapse(false);
                      const sel = window.getSelection();
                      if (sel) { sel.removeAllRanges(); sel.addRange(r); }
                    }
                  }
                  const selection = getRichSelectionOffsets(el);
                  richSelectionRef.current = selection ?? { start: finalText.length, end: finalText.length };
                  setInputText(finalText);
                  const cursor = finalText.length;
                  const mention = getMentionAt(finalText, cursor);
                  setMentionMeta(mention);
                  if (mention) fetchMentionSuggestions(mention.query);
                  else { setMentionOpen(false); setMentionSuggestions([]); }
                  if (clamped.trim()) sendTyping();
                }}
                onFocus={e => { syncRichSelectionRef(e.currentTarget); }}
                onMouseUp={e => { syncRichSelectionRef(e.currentTarget); }}
                onKeyUp={e => { syncRichSelectionRef(e.currentTarget); }}
                onKeyDown={e => {
                  // Mention popover takes priority over slash-command
                  if (mentionOpen && mentionSuggestions.length > 0) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => (i + 1) % mentionSuggestions.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length); return; }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const s = mentionSuggestions[mentionIdx]; selectMention(s.displayName, s.discordId); return; }
                    if (e.key === 'Tab') { e.preventDefault(); const s = mentionSuggestions[mentionIdx]; selectMention(s.displayName, s.discordId); return; }
                    if (e.key === 'Escape') { e.preventDefault(); setMentionOpen(false); return; }
                  }
                  if (wikiAcOpen && wikiAcItems.length > 0) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setWikiAcIndex(i => (i + 1) % wikiAcItems.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setWikiAcIndex(i => (i - 1 + wikiAcItems.length) % wikiAcItems.length); return; }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectWikiAcItem(wikiAcItems[wikiAcIndex]); return; }
                    if (e.key === 'Tab') { e.preventDefault(); selectWikiAcItem(wikiAcItems[wikiAcIndex]); return; }
                    if (e.key === 'Escape') { e.preventDefault(); setWikiAcOpen(false); return; }
                  }
                  if (campAcOpen && campAcItems.length > 0) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setCampAcIndex(i => (i + 1) % campAcItems.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setCampAcIndex(i => (i - 1 + campAcItems.length) % campAcItems.length); return; }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectCampAcItem(campAcItems[campAcIndex]); return; }
                    if (e.key === 'Tab') { e.preventDefault(); selectCampAcItem(campAcItems[campAcIndex]); return; }
                    if (e.key === 'Escape') { e.preventDefault(); setCampAcOpen(false); return; }
                  }
                  if (acOpen && acSuggestions.length > 0) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex(i => (i + 1) % acSuggestions.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setAcIndex(i => (i - 1 + acSuggestions.length) % acSuggestions.length); return; }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectAcSuggestion(acSuggestions[acIndex]); return; }
                    if (e.key === 'Tab') { e.preventDefault(); selectAcSuggestion(acSuggestions[acIndex]); return; }
                    if (e.key === 'Escape') { e.preventDefault(); setAcOpen(false); return; }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                    // Clear the rich input visually after send, then restore focus so
                    // the user can keep typing without having to click the box again.
                    if (richInputRef.current) richInputRef.current.innerHTML = '';
                    requestAnimationFrame(() => {
                      if (richInputRef.current) richInputRef.current.focus();
                      else inputRef.current?.focus();
                    });
                  }
                  // Clamp paste to 255 chars
                  if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                    // Allow default paste; clamp is done in onInput
                  }
                }}
                onContextMenu={overlayShell ? (e) => {
                  e.preventDefault();
                  (window as any).relayBridge?.showInputContextMenu?.(e.clientX, e.clientY);
                } : undefined}
                onPaste={e => {
                  // Party chat: intercept image pastes and upload them.
                  if (isOnPartyTab && partyView !== 'browser') {
                    const items = Array.from(e.clipboardData.items);
                    const imageItem = items.find(item => item.type.startsWith('image/'));
                    if (imageItem) {
                      e.preventDefault();
                      const file = imageItem.getAsFile();
                      if (!file) return;
                      setImageUploading(true);
                      const formData = new FormData();
                      formData.append('image', file);
                      const relayBase = getOverlayShell()?.relayBase ?? '';
                      fetch(`${relayBase}/api/parties/upload-image`, {
                        method: 'POST',
                        credentials: 'include',
                        body: formData,
                      })
                        .then(r => r.json())
                        .then(json => {
                          const url: string = json?.data?.url ?? json?.url;
                          if (!url) throw new Error('no url in response');
                          const resolvedUrl = resolveMediaUrl(url);
                          const ws = wsRef.current;
                          if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                              type: 'party:send',
                              payload: { partyId: partyView, content: resolvedUrl },
                            }));
                          }
                        })
                        .catch(() => showActionToast('err', 'Image upload failed'))
                        .finally(() => setImageUploading(false));
                      return;
                    }
                  }
                  // Strip HTML from paste — only plain text (with tokens) allowed.
                  e.preventDefault();
                  const text = e.clipboardData.getData('text/plain');
                  const el = e.currentTarget as HTMLDivElement;
                  const curText = serializeRichInput(el);
                  const sel = window.getSelection();
                  let start = curText.length, end = curText.length;
                  if (sel && sel.rangeCount > 0) {
                    // Approximate caret offset (text-node based)
                    const r = sel.getRangeAt(0);
                    const before = document.createRange();
                    before.selectNodeContents(el);
                    before.setEnd(r.startContainer, r.startOffset);
                    start = serializeRichInput({ childNodes: before.cloneContents().childNodes } as unknown as HTMLDivElement).length;
                    end = start;
                  }
                  const next = (curText.slice(0, start) + text + curText.slice(end)).slice(0, 255);
                  el.innerHTML = buildRichHtml(next);
                  setInputText(next);
                  // Move caret to after inserted text
                  requestAnimationFrame(() => {
                    if (!richInputRef.current) return;
                    const r2 = document.createRange();
                    r2.selectNodeContents(richInputRef.current);
                    r2.collapse(false);
                    const s = window.getSelection();
                    if (s) { s.removeAllRanges(); s.addRange(r2); }
                  });
                }}
                className="fcm-rich-input"
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'block',
                  background: 'transparent',
                  border: 'none',
                  color: hexAlpha(inputRelayColor ?? theme.inputTextColor, textAlpha),
                  fontFamily: theme.fontFamily,
                  fontSize: `${fontSize}px`,
                  lineHeight: '18px',
                  outline: 'none',
                  // Guarantee one full line of height even when empty (an empty
                  // contentEditable has no line box and would collapse to 0px).
                  minHeight: '18px',
                  maxHeight: '90px',
                  overflowY: 'auto',
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                  boxSizing: 'border-box',
                  cursor: muteState ? 'not-allowed' : 'text',
                  position: 'relative',
                  zIndex: 1,
                } as React.CSSProperties}
              />
              </div>
            ) : (
            <textarea
              ref={inputRef}
              disabled={!!muteState}
              value={inputText}
              onChange={e => {
                const newVal = e.target.value;
                setInputText(newVal);
                const cursor = e.target.selectionStart ?? newVal.length;
                const mention = getMentionAt(newVal, cursor);
                setMentionMeta(mention);
                if (mention) fetchMentionSuggestions(mention.query);
                else { setMentionOpen(false); setMentionSuggestions([]); }
                if (newVal.trim()) sendTyping();
              }}
              onKeyDown={e => {
                // Mention popover takes priority over slash-command
                if (mentionOpen && mentionSuggestions.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => (i + 1) % mentionSuggestions.length); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length); return; }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const s = mentionSuggestions[mentionIdx]; selectMention(s.displayName, s.discordId); return; }
                  if (e.key === 'Tab') { e.preventDefault(); const s = mentionSuggestions[mentionIdx]; selectMention(s.displayName, s.discordId); return; }
                  if (e.key === 'Escape') { e.preventDefault(); setMentionOpen(false); return; }
                }
                if (wikiAcOpen && wikiAcItems.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setWikiAcIndex(i => (i + 1) % wikiAcItems.length); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setWikiAcIndex(i => (i - 1 + wikiAcItems.length) % wikiAcItems.length); return; }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectWikiAcItem(wikiAcItems[wikiAcIndex]); return; }
                  if (e.key === 'Tab') { e.preventDefault(); selectWikiAcItem(wikiAcItems[wikiAcIndex]); return; }
                  if (e.key === 'Escape') { e.preventDefault(); setWikiAcOpen(false); return; }
                }
                if (campAcOpen && campAcItems.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setCampAcIndex(i => (i + 1) % campAcItems.length); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setCampAcIndex(i => (i - 1 + campAcItems.length) % campAcItems.length); return; }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectCampAcItem(campAcItems[campAcIndex]); return; }
                  if (e.key === 'Tab') { e.preventDefault(); selectCampAcItem(campAcItems[campAcIndex]); return; }
                  if (e.key === 'Escape') { e.preventDefault(); setCampAcOpen(false); return; }
                }
                if (acOpen && acSuggestions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setAcIndex(i => (i + 1) % acSuggestions.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setAcIndex(i => (i - 1 + acSuggestions.length) % acSuggestions.length);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    selectAcSuggestion(acSuggestions[acIndex]);
                    return;
                  }
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    selectAcSuggestion(acSuggestions[acIndex]);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setAcOpen(false);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              maxLength={255}
              rows={1}
              placeholder={inputPlaceholder}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                color: hexAlpha(inputRelayColor ?? theme.inputTextColor, textAlpha),
                fontFamily: theme.fontFamily,
                fontSize: `${fontSize}px`,
                lineHeight: '18px',
                outline: 'none',
                resize: 'none',
                minHeight: '18px',
                maxHeight: '90px',
                padding: 0,
                overflowY: 'hidden',
                wordBreak: 'break-word',
              }}
              onPaste={e => {
                // Party chat: intercept image pastes and upload them.
                if (isOnPartyTab && partyView !== 'browser') {
                  const items = Array.from(e.clipboardData.items);
                  const imageItem = items.find(item => item.type.startsWith('image/'));
                  if (imageItem) {
                    e.preventDefault();
                    const file = imageItem.getAsFile();
                    if (!file) return;
                    setImageUploading(true);
                    const formData = new FormData();
                    formData.append('image', file);
                    const relayBase = getOverlayShell()?.relayBase ?? '';
                    fetch(`${relayBase}/api/parties/upload-image`, {
                      method: 'POST',
                      credentials: 'include',
                      body: formData,
                    })
                      .then(r => r.json())
                      .then(json => {
                        const url: string = json?.data?.url ?? json?.url;
                        if (!url) throw new Error('no url in response');
                        const resolvedUrl = resolveMediaUrl(url);
                        const ws = wsRef.current;
                        if (ws && ws.readyState === WebSocket.OPEN) {
                          ws.send(JSON.stringify({
                            type: 'party:send',
                            payload: { partyId: partyView, content: resolvedUrl },
                          }));
                        }
                      })
                      .catch(() => showActionToast('err', 'Image upload failed'))
                      .finally(() => setImageUploading(false));
                  }
                }
              }}
              onContextMenu={overlayShell ? (e) => {
                e.preventDefault();
                (window as any).relayBridge?.showInputContextMenu?.(e.clientX, e.clientY);
              } : undefined}
            />
            )}
            {/* Emoji + GIF picker buttons — gated by per-channel flags */}
            {activeChannelAllowsEmojis && (
              <span
                ref={emojiTriggerRef}
                title="Emoji picker"
                onMouseDown={e => {
                  e.preventDefault();
                  // Capture viewport-relative position of the trigger so the
                  // picker can use position:fixed, escaping overflow:hidden ancestors.
                  const rect = emojiTriggerRef.current?.getBoundingClientRect();
                  // Initial anchor (zoom-corrected); the RAF clamp loop refines it
                  // next frame so it stays fully inside the window.
                  if (rect) setPickerAnchor(computePickerAnchor(rect, 340, 360, 8));
                  setOpenPicker(p => p === 'emoji' ? null : 'emoji');
                }}
                style={{
                  fontSize: '14px', lineHeight: '18px',
                  marginLeft: '4px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: hexAlpha(primaryColor, openPicker === 'emoji' ? 1.0 : 0.8),
                  opacity: openPicker === 'emoji' ? 1 : 0.8,
                  width: 24, height: 24,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                  // Frameless-window safety: never let this button fall inside a
                  // drag region (a drag region swallows clicks before JS sees them).
                  ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
                }}
              >
                ☢
              </span>
            )}
            {isOnPartyTab && partyView !== 'browser' && (
              <span
                ref={gifTriggerRef}
                title="GIF picker (party chat)"
                onMouseDown={e => {
                  e.preventDefault();
                  // Capture anchor from the GIF trigger (mirrors emoji trigger logic,
                  // zoom-corrected) so the GIF picker opens bottom-right above the
                  // button, not centered.
                  const rect = gifTriggerRef.current?.getBoundingClientRect();
                  if (rect) setPickerAnchor(computePickerAnchor(rect, 340, 360, 8));
                  setOpenPicker(p => p === 'gif' ? null : 'gif');
                }}
                style={{
                  fontSize: '10px', lineHeight: '18px', fontWeight: 'bold',
                  letterSpacing: '0.05em',
                  marginLeft: '2px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: hexAlpha(primaryColor, openPicker === 'gif' ? 1.0 : 0.8),
                  width: 24, height: 24,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                  fontFamily: '"Courier New", monospace',
                  // Frameless-window safety: never let this button fall inside a
                  // drag region (a drag region swallows clicks before JS sees them).
                  ...(overlayShell ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}),
                }}
              >
                GIF
              </span>
            )}
            {imageUploading && (
              <span style={{
                fontSize: '10px',
                fontFamily: '"Courier New", monospace',
                marginLeft: '6px',
                lineHeight: '18px',
                color: hexAlpha(primaryColor, 0.8),
                flexShrink: 0,
              }}>
                uploading…
              </span>
            )}
            {!imageUploading && (
              <span style={{
                fontSize: '10px',
                fontFamily: '"Courier New", monospace',
                marginLeft: '6px',
                // Match the emoji button's centered flex box (height 24 + inline-flex
                // center) so the counter's visual center lines up with the ☢ glyph
                // and the input caret, instead of sitting on a text baseline.
                height: '24px',
                display: 'inline-flex',
                alignItems: 'center',
                lineHeight: 1,
                flexShrink: 0,
                color: inputText.length >= 241 ? '#FF4444' : inputText.length >= 200 ? '#FFB000' : hexAlpha(primaryColor, 0.8),
                textShadow: textOutline,
              }}>
                {inputText.length}/255
              </span>
            )}
          </div>
          {/* Picker popovers — rendered inside the relative-positioned Input area container */}
          {openPicker === 'emoji' && activeChannelAllowsEmojis && renderPicker(
            <EmojiPicker
              primaryColor={primaryColor}
              chromeColor={theme.chromeColor}
              inputBgColor={theme.inputBgColor}
              fontFamily={theme.fontFamily}
              fontSize={fontSize}
              hexAlpha={hexAlpha}
              hexToRgba={hexToRgba}
              glowEnabled={glowEnabled}
              onInsert={token => { overlayShell ? richInsertAtCaret(token) : insertAtCaret(token); }}
              onClose={() => setOpenPicker(null)}
              // position:fixed escapes overflow:hidden on the overlay container so
              // the picker is never clipped regardless of chat window height.
              // maxHeight caps an oversized picker so it scrolls internally
              // rather than running off the top edge of a short window.
              style={pickerStyle}
            />
          )}
          {openPicker === 'gif' && isOnPartyTab && partyView !== 'browser' && renderPicker(
            <GifPicker
              primaryColor={primaryColor}
              chromeColor={theme.chromeColor}
              inputBgColor={theme.inputBgColor}
              fontFamily={theme.fontFamily}
              fontSize={fontSize}
              hexAlpha={hexAlpha}
              hexToRgba={hexToRgba}
              glowEnabled={glowEnabled}
              onInsert={gifUrl => {
                // GIFs in party chat are sent directly as a party:send message
                // (the URL renders inline via classifyMedia). Never insert into
                // the text input — that would require the user to manually send.
                setOpenPicker(null);
                const ws = wsRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'party:send',
                    payload: { partyId: partyView, content: gifUrl },
                  }));
                }
              }}
              onClose={() => setOpenPicker(null)}
              // Same in-frame clamp as the emoji picker (additive, optional prop).
              style={pickerStyle}
            />
          )}
          {/* Footer hint bar */}
          {settings.showHints && (
            <div style={{
              padding: '2px 8px',
              fontFamily: theme.fontFamily,
              fontSize: '10px',
              color: hexAlpha(primaryColor, 0.95),
              letterSpacing: '0.04em',
              userSelect: 'none',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1 }}>{overlayShell && shellKeybinds ? (() => {
                const f = (a?: string) => (a || '')
                  .replace('CommandOrControl', 'Ctrl').replace('CmdOrCtrl', 'Ctrl')
                  .replace('PageUp', 'PgUp').replace('PageDown', 'PgDn')
                  .replace('Insert', 'Ins').replace('Delete', 'Del');
                const k = shellKeybinds as Record<string, string | undefined>;
                const parts: string[] = [];
                if (k['focus'])  parts.push(`${f(k['focus'])} chat`);
                if (k['toggle']) parts.push(`${f(k['toggle'])} hide`);
                const prev = f(k['prevChannel']); const next = f(k['nextChannel']);
                if (prev && next)  parts.push(`${prev}/${next} cycle`);
                else if (prev)     parts.push(`${prev} prev ch`);
                else if (next)     parts.push(`${next} next ch`);
                if (k['settings']) parts.push(`${f(k['settings'])} settings`);
                parts.push('/help');
                return parts.join(' · ');
              })() : 'Enter send · /help'}</span>
              <span style={{ color: hexAlpha(primaryColor, 0.8), textShadow: textOutline, flexShrink: 0, marginLeft: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                {updateAvailableVersion && (
                  <span title={`Update available: v${updateAvailableVersion}`} style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#e74c3c', boxShadow: '0 0 4px rgba(231,76,60,0.8)', flexShrink: 0, display: 'inline-block' }} />
                )}
                v{displayVersion}{isDevEnv ? ' [DEV]' : ''}
              </span>
            </div>
          )}
          </div> /* end input container */}
        </div>


        {/* Scanline effect */}
        {showScanlines && (
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(0,0,0,0.06) 1px, rgba(0,0,0,0.06) 2px)',
          }} />
        )}

        {/* Mute modal — moderator picks duration + reason; ban form is a separate page. */}
        {muteModalFor && createPortal(
          <MuteModal
            target={muteModalFor}
            onClose={() => setMuteModalFor(null)}
            primaryColor={primaryColor}
            chromeColor={theme.chromeColor}
            fontFamily={theme.fontFamily}
          />,
          document.body,
        )}

        {/* Kick modal — requires a non-empty reason (server rejects empty). */}
        {kickModalFor && createPortal(
          <KickModal
            target={kickModalFor}
            onClose={() => setKickModalFor(null)}
            primaryColor={primaryColor}
            chromeColor={theme.chromeColor}
            fontFamily={theme.fontFamily}
          />,
          document.body,
        )}

        {/* Admin-only: user profile card with alias history. */}
        {isAdmin && profileModalFor && createPortal(
          <UserProfileModal
            target={profileModalFor}
            onClose={() => setProfileModalFor(null)}
            primaryColor={primaryColor}
            chromeColor={theme.chromeColor}
            fontFamily={theme.fontFamily}
          />,
          document.body,
        )}

        {/* Self-notice — your own kick/ban arrived just before WS close; toast-style. */}
        {lastNotice && createPortal(
          <div style={{ position: 'fixed', top: '20px', right: '20px', maxWidth: '380px', zIndex: 10001, background: '#2b1212', border: '1px solid #FF6060', color: '#FFB0B0', fontFamily: theme.fontFamily, padding: '14px 18px', boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
            <div style={{ fontWeight: 'bold', fontSize: '14px', marginBottom: '4px' }}>
              {lastNotice.kind === 'kicked'
                ? `You were kicked${lastNotice.durationSeconds ? ` for ${Math.round(lastNotice.durationSeconds / 60)} min` : ''}`
                : lastNotice.permanent
                  ? 'You were permanently banned'
                  : `You were banned${lastNotice.until ? ` until ${new Date(lastNotice.until).toLocaleString()}` : ''}`
              }
            </div>
            <div style={{ fontSize: '12px' }}>
              {lastNotice.category ? `${lastNotice.category}: ` : ''}{lastNotice.reason || '(no reason given)'}
            </div>
            <div style={{ fontSize: '11px', marginTop: '8px', opacity: 0.7 }}>This notice stays until you reload.</div>
          </div>,
          document.body,
        )}

        {/* Context menu — portalled to document.body to escape any overflow/stacking context */}
        {ctxMenu && createPortal(
          <div ref={ctxMenuRef} style={{
            position: 'fixed',
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 9999,
            background: menuBgColor(theme, chromeBgAlpha, 1.4),
            border: `1px solid ${borderBright}`,
            fontFamily: theme.fontFamily,
            fontSize: `${fontSize}px`,
            minWidth: '140px',
            display: 'flex',
            flexDirection: 'column',
          }}>
            {[
              // Reply — auth only (writes to the input; public mode is read-only).
              ...(!isPublicMode && ctxMenu.msg.source !== 'bot' && ctxMenu.msg.source !== 'system' && ctxMenu.msg.username
                ? [{ label: 'Reply', action: () => {
                    const mention = `@${ctxMenu.msg.username} `;
                    setInputText(prev => (prev.startsWith(mention) ? prev : mention + prev));
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}]
                : []),
              ...(!isPublicMode && ctxMenu.msg.userId && ctxMenu.msg.userId !== 'system'
                  && ctxMenu.msg.source !== 'bot' && ctxMenu.msg.source !== 'system'
                  && ctxMenu.msg.userId !== (user?.id ?? '')
                ? [{ label: 'Message', action: () => { openPrivateConversation(ctxMenu.msg.userId!); } }]
                : []),
              // Copy items are harmless and available to everyone (incl. public mode).
              { label: copyFlash === 'msg' ? '✓ COPIED' : 'Copy Message', action: () => copyToClipboard(ctxMenu.msg.content, 'msg') },
              { label: copyFlash === 'usr' ? '✓ COPIED' : 'Copy Username', action: () => copyToClipboard(ctxMenu.msg.username, 'usr') },
              // Report — auth only.
              ...(!isPublicMode && ctxMenu.msg.source !== 'bot' && ctxMenu.msg.source !== 'system'
                ? [{ label: `Report ${ctxMenu.msg.username}`, action: () => {
                    setInputText(`/report player ${ctxMenu.msg.username} `);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}]
                : []),
              // Block — auth only, on a real user message that isn't you.
              ...(!isPublicMode && ctxMenu.msg.userId && ctxMenu.msg.userId !== 'system'
                  && ctxMenu.msg.source !== 'bot' && ctxMenu.msg.source !== 'system'
                  && ctxMenu.msg.userId !== (user?.id ?? '')
                ? [{ label: `Block ${ctxMenu.msg.username}`, action: () => { blockUser(ctxMenu.msg.userId!); } }]
                : []),
              // Mod actions — only for mod/admin viewers, only on a real user message.
              ...(!isPublicMode && isMod && ctxMenu.msg.userId && ctxMenu.msg.userId !== 'system'
                  && ctxMenu.msg.source !== 'bot' && ctxMenu.msg.source !== 'system'
                ? [
                    { label: `Kick ${ctxMenu.msg.username} (5 min)…`, action: () => {
                      setKickModalFor({ userId: ctxMenu.msg.userId!, username: ctxMenu.msg.username });
                    }},
                    { label: `Mute ${ctxMenu.msg.username}…`, action: () => {
                      setMuteModalFor({ userId: ctxMenu.msg.userId!, username: ctxMenu.msg.username });
                    }},
                    { label: `Ban ${ctxMenu.msg.username}…`, action: () => {
                      const u = encodeURIComponent(ctxMenu.msg.userId!);
                      const n = encodeURIComponent(ctxMenu.msg.username);
                      window.open(`/moderation/bans/new?userId=${u}&username=${n}`, '_blank');
                    }},
                    { label: 'Delete message', action: () => {
                      setModModal({ action: 'delete', target: ctxMenu.msg });
                    }},
                  ]
                : []),
              // Admin-only: view user profile with alias history.
              ...(!isPublicMode && isAdmin && ctxMenu.msg.userId && ctxMenu.msg.userId !== 'system'
                  && ctxMenu.msg.source !== 'bot' && ctxMenu.msg.source !== 'system'
                ? [{ label: `View Profile`, action: () => {
                    setProfileModalFor({ userId: ctxMenu.msg.userId!, username: ctxMenu.msg.username });
                  }}]
                : []),
              // Party invite — show if viewer is owner/comod of any party.
              // keepOpen: this item toggles an inline submenu rather than
              // closing the menu, so its onMouseDown must NOT call setCtxMenu(null)
              // (that previously fired in the same batch and instantly closed the
              // whole menu before the submenu could render).
              ...(!isPublicMode && ctxMenu.msg.userId && ctxMenu.msg.userId !== 'system'
                  && ctxMenu.msg.source !== 'bot' && ctxMenu.msg.source !== 'system'
                  && ctxMenu.msg.userId !== (user?.id ?? '')
                  && parties.some(p => p.isMember && (p.role === 'owner' || p.role === 'comod'))
                ? [{ label: 'Invite to Party ▸', keepOpen: true, action: () => setCtxMenuInviteSubmenu(s => !s) }]
                : []),
            ].map((item: { label: string; action: () => void; keepOpen?: boolean }) => (
              <div
                key={item.label}
                ref={item.keepOpen ? ctxMenuInviteItemRef : undefined}
                onMouseDown={e => {
                  e.stopPropagation();
                  item.action();
                  // Items that open the invite flyout keep the context menu open.
                  if (!item.keepOpen) { setCtxMenu(null); setCtxMenuInviteSubmenu(false); }
                }}
                // Expand the invite submenu on hover for nicer UX (in addition to click).
                onMouseEnter={e => {
                  e.currentTarget.style.background = hexAlpha(primaryColor, 0.12);
                  if (item.keepOpen) setCtxMenuInviteSubmenu(true);
                }}
                style={{
                  padding: '5px 10px',
                  cursor: 'pointer',
                  color: primaryColor,
                  letterSpacing: '0.04em',
                }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {item.label}
              </div>
            ))}
          </div>,
          document.body
        )}

        {/* "Invite to Party" flyout — a SEPARATE popover beside the main context
            menu (anchored + clamped by the ctxMenuInviteRef effect above), so the
            party list always renders as a vertical list inside the window instead
            of stacking inline under the menu and clipping out of frame. */}
        {ctxMenu && ctxMenuInviteSubmenu && createPortal(
          <div
            ref={ctxMenuInviteRef}
            onMouseEnter={() => setCtxMenuInviteSubmenu(true)}
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              zIndex: 10000,
              background: menuBgColor(theme, chromeBgAlpha, 1.4),
              border: `1px solid ${borderBright}`,
              fontFamily: theme.fontFamily,
              fontSize: `${fontSize}px`,
              minWidth: '140px',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ padding: '3px 10px', fontSize: '9px', color: dimText, letterSpacing: '0.08em' }}>SELECT PARTY:</div>
            {(() => {
              const invitable = parties.filter(p => p.isMember && (p.role === 'owner' || p.role === 'comod'));
              if (invitable.length === 0) {
                return (
                  <div style={{ padding: '5px 10px', color: hexAlpha(primaryColor, 0.4), letterSpacing: '0.04em', fontSize: `${fontSize}px`, cursor: 'default' }}>
                    No parties to invite to
                  </div>
                );
              }
              return invitable.map(p => (
                <div
                  key={p.id}
                  onMouseDown={async (e) => {
                    e.stopPropagation();
                    setCtxMenu(null);
                    setCtxMenuInviteSubmenu(false);
                    try {
                      await api.post(`/api/parties/${p.id}/invite`, { userId: ctxMenu?.msg.userId });
                      showActionToast('ok', `Invited to ${p.name}`);
                    } catch (err: any) { showActionToast('err', err?.message || 'Invite failed'); }
                  }}
                  style={{ padding: '5px 10px', cursor: 'pointer', color: primaryColor, letterSpacing: '0.04em', fontSize: `${fontSize}px`, whiteSpace: 'nowrap' }}
                  onMouseEnter={e => (e.currentTarget.style.background = hexAlpha(primaryColor, 0.12))}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >{p.name}</div>
              ));
            })()}
          </div>,
          document.body
        )}
      </div>

      {/* ── Right-click menu for a joined-party sub-tab ── */}
      {partyTabCtx && (() => {
        const p = parties.find(x => x.id === partyTabCtx.partyId);
        if (!p) return null;
        const close = () => setPartyTabCtx(null);
        // Identical full menu set everywhere — built by the shared builder so the
        // joined sub-tab, the active in-party tab, AND browser rows all match.
        const items = buildPartyMenuItems(p, partyTabCtx.x, partyTabCtx.y);
        return createPortal(
          <>
            <div onMouseDown={close} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
            <div ref={partyTabCtxRef} style={{
              position: 'fixed', left: partyTabCtx.x, top: partyTabCtx.y, zIndex: 9999,
              background: menuBgColor(theme, chromeBgAlpha, 1.4),
              border: `1px solid ${borderBright}`, fontFamily: theme.fontFamily,
              fontSize: `${fontSize}px`, minWidth: '140px',
              display: 'flex', flexDirection: 'column',
            }}>
              {items.map(item => (
                <div key={item.label}
                  onMouseDown={e => { e.stopPropagation(); item.action(); close(); }}
                  onMouseEnter={e => (e.currentTarget.style.background = hexAlpha(primaryColor, 0.12))}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  style={{ padding: '5px 10px', cursor: 'pointer', letterSpacing: '0.04em', color: item.danger ? '#FF6644' : primaryColor }}
                >{item.label}</div>
              ))}
            </div>
          </>,
          document.body,
        );
      })()}

      {/* ── Inline "set member limit" editor (owner/co-mod) ── */}
      {partyLimitEditor && (() => {
        const p = parties.find(x => x.id === partyLimitEditor.partyId);
        if (!p) return null;
        return createPortal(
          <PartyLimitEditor
            party={p}
            x={partyLimitEditor.x}
            y={partyLimitEditor.y}
            primaryColor={primaryColor}
            theme={theme}
            borderBright={borderBright}
            fontSize={fontSize}
            chromeBgAlpha={chromeBgAlpha}
            onClose={() => setPartyLimitEditor(null)}
            onSaved={() => { queryClient.invalidateQueries({ queryKey: ['parties'] }); setPartyLimitEditor(null); }}
          />,
          document.body,
        );
      })()}

      {/* ── Party description editor (owner/co-mod) ── */}
      {partyDescriptionEditor && (() => {
        const p = parties.find(x => x.id === partyDescriptionEditor.partyId);
        if (!p) return null;
        return createPortal(
          <PartyDescriptionEditor
            party={p}
            primaryColor={primaryColor}
            theme={theme}
            onClose={() => setPartyDescriptionEditor(null)}
            onSaved={() => { queryClient.invalidateQueries({ queryKey: ['parties'] }); setPartyDescriptionEditor(null); }}
          />,
          document.body,
        );
      })()}

      {/* ── Member-panel user right-click menu (promote / demote / kick) ── */}
      {memberCtx && (() => {
        const close = () => setMemberCtx(null);
        const myParty = parties.find(p => p.id === memberCtx.partyId);
        const myRole = myParty?.role;
        const target = memberCtx.member;
        const isOwnerSelf = myRole === 'owner';
        const isComodSelf = myRole === 'comod';
        // Build role-gated actions.
        const items: { label: string; danger?: boolean; run: () => Promise<void> }[] = [];
        const refresh = () => {
          queryClient.invalidateQueries({ queryKey: ['party-members', memberCtx.partyId] });
          queryClient.invalidateQueries({ queryKey: ['parties'] });
        };
        if (isOwnerSelf && target.role === 'member') {
          items.push({ label: 'Promote to co-mod', run: async () => { await api.post(`/api/parties/${memberCtx.partyId}/promote`, { userId: target.userId }); refresh(); } });
        }
        if (isOwnerSelf && target.role === 'comod') {
          items.push({ label: 'Demote to member', run: async () => { await api.post(`/api/parties/${memberCtx.partyId}/demote`, { userId: target.userId }); refresh(); } });
        }
        // Kick: owner OR co-mod; never the owner; a co-mod can't kick another co-mod.
        const canKick = target.role !== 'owner'
          && (isOwnerSelf || (isComodSelf && target.role !== 'comod'));
        if (canKick) {
          items.push({ label: 'Kick from party', danger: true, run: async () => { await api.post(`/api/parties/${memberCtx.partyId}/kick`, { userId: target.userId }); refresh(); } });
        }
        // Admin mod actions (mod/admin viewers): Mute / Kick (5-min) / Ban — reuse
        // the existing chat-menu modals/flow. Distinct from the party "kick".
        if (isMod) {
          items.push({ label: `Mute ${target.username}…`, run: async () => { setMuteModalFor({ userId: target.userId, username: target.username }); } });
          items.push({ label: `Kick ${target.username} (5 min)…`, run: async () => { setKickModalFor({ userId: target.userId, username: target.username }); } });
          items.push({ label: `Ban ${target.username}…`, run: async () => {
            const u = encodeURIComponent(target.userId); const n = encodeURIComponent(target.username);
            window.open(`/moderation/bans/new?userId=${u}&username=${n}`, '_blank');
          } });
        }
        // Admin-only: view user profile with alias history.
        if (isAdmin) {
          items.push({ label: `View Profile`, run: async () => { setProfileModalFor({ userId: target.userId, username: target.username }); } });
        }
        // Block — available to EVERYONE.
        items.push({ label: `Block ${target.username}`, run: async () => { await blockUser(target.userId); } });
        if (items.length === 0) return null;
        return createPortal(
          <>
            <div onMouseDown={close} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
            <div ref={memberCtxRef} style={{
              position: 'fixed', left: memberCtx.x, top: memberCtx.y, zIndex: 9999,
              background: menuBgColor(theme, chromeBgAlpha, 1.4),
              border: `1px solid ${borderBright}`, fontFamily: theme.fontFamily,
              fontSize: `${fontSize}px`, minWidth: '150px',
              display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ padding: '4px 10px', fontSize: `${Math.max(8, fontSize - 3)}px`, color: hexAlpha(primaryColor, 0.55), letterSpacing: '0.06em', borderBottom: `1px solid ${hexAlpha(primaryColor, 0.15)}`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {target.username}
              </div>
              {items.map(item => (
                <div key={item.label}
                  onMouseDown={async e => {
                    e.stopPropagation();
                    close();
                    try { await item.run(); }
                    catch (err: any) { setTimeout(() => setPartyActionError(err?.message || `${item.label} failed`), 0); }
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = hexAlpha(primaryColor, 0.12))}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  style={{ padding: '5px 10px', cursor: 'pointer', letterSpacing: '0.04em', color: item.danger ? '#FF6644' : primaryColor }}
                >{item.label}</div>
              ))}
            </div>
          </>,
          document.body,
        );
      })()}

      {/* ── Invite modal (member panel "+ INVITE") ── */}
      {inviteModalFor && (() => {
        const p = parties.find(x => x.id === inviteModalFor.partyId);
        if (!p) return null;
        return createPortal(
          <PartyInviteModal
            party={p}
            /* Sub-channels of the real (Fallout 76) main channels — General/Trading/
               Events/Raids — never the main tabs themselves or server: virtuals. */
            channels={mainChannels.flatMap(m => (m.children || []).filter((s: SubChannel) => !s.id.startsWith('server:')))}
            primaryColor={primaryColor}
            theme={theme}
            borderBright={borderBright}
            fontSize={fontSize}
            onClose={() => setInviteModalFor(null)}
          />,
          document.body,
        );
      })()}

      {/* ── Delete / Leave confirmation (in-overlay; replaces native confirm) ── */}
      {leaveConfirmFor && (() => {
        const isOwner = leaveConfirmFor.isOwner;
        const partyId = leaveConfirmFor.partyId;
        const close = () => setLeaveConfirmFor(null);
        const confirmAction = async () => {
          try {
            if (isOwner) await api.delete(`/api/parties/${partyId}`);
            else await api.post(`/api/parties/${partyId}/leave`, {});
            setPartyView('browser');
            setMemberPanelOpen(false);
            queryClient.invalidateQueries({ queryKey: ['parties'] });
            close();
          } catch (err: any) {
            close();
            setTimeout(() => setPartyActionError(err?.message || (isOwner ? 'Could not delete party' : 'Could not leave party')), 0);
          }
        };
        const bg = hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.6));
        return createPortal(
          <div onMouseDown={close} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ background: bg, border: `1px solid ${hexAlpha(primaryColor, 0.3)}`, fontFamily: theme.fontFamily, color: primaryColor, padding: '16px', minWidth: '260px', maxWidth: '90vw' }}>
              <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '6px', letterSpacing: '0.08em' }}>
                {isOwner ? 'Delete this party?' : 'Leave this party?'}
              </div>
              <div style={{ fontSize: '11px', opacity: 0.7, marginBottom: '14px' }}>
                {isOwner ? 'This permanently removes the party for everyone.' : 'You can rejoin a public party later.'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button onClick={close} style={{ minHeight: 0, boxSizing: 'border-box', padding: '5px 12px', background: 'transparent', color: primaryColor, border: `1px solid ${hexAlpha(primaryColor, 0.3)}`, fontFamily: theme.fontFamily, cursor: 'pointer' }}>CANCEL</button>
                <button onClick={confirmAction} style={{ minHeight: 0, boxSizing: 'border-box', padding: '5px 14px', background: hexAlpha('#FF4444', 0.18), color: '#FF6060', border: `1px solid ${hexAlpha('#FF4444', 0.55)}`, fontFamily: theme.fontFamily, fontWeight: 'bold', cursor: 'pointer' }}>
                  {isOwner ? 'DELETE' : 'LEAVE'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        );
      })()}

      {/* ── Joined-party "…" overflow menu (left-click affordance) ── */}
      {partyOverflowCtx && (() => {
        const close = () => setPartyOverflowCtx(null);
        const byId = new Map(joinedParties.map(p => [p.id, p] as const));
        const overflowParties = partyOverflowIds.map(id => byId.get(id)).filter((p): p is Party => !!p);
        if (overflowParties.length === 0) return null;
        return createPortal(
          <>
            <div onMouseDown={close} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
            <div style={{
              // Anchor by the RIGHT edge so the menu opens leftward from the "…"
              // button and never spills past the (narrow) overlay window edge.
              position: 'fixed', right: Math.max(2, partyOverflowCtx.right),
              top: Math.min(partyOverflowCtx.y, Math.max(2, window.innerHeight - 200)), zIndex: 9999,
              background: menuBgColor(theme, chromeBgAlpha, 1.4),
              border: `1px solid ${borderBright}`, fontFamily: theme.fontFamily,
              fontSize: `${fontSize}px`, minWidth: '140px', maxWidth: '70vw', maxHeight: '60vh', overflowY: 'auto',
              display: 'flex', flexDirection: 'column',
            }}>
              {overflowParties.map(p => {
                const isActive = partyView === p.id;
                return (
                  <div key={p.id}
                    onMouseDown={e => { e.stopPropagation(); setPartyView(p.id); close(); }}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); close(); setPartyTabCtx({ x: e.clientX, y: e.clientY, partyId: p.id }); }}
                    onMouseEnter={e => (e.currentTarget.style.background = hexAlpha(primaryColor, 0.12))}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    style={{
                      padding: '5px 10px', cursor: 'pointer', letterSpacing: '0.04em',
                      color: isActive ? primaryColor : hexAlpha(primaryColor, 0.8),
                      fontWeight: 'bold',
                      display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ width: '8px', flexShrink: 0 }}>{isActive ? '✓' : ''}</span>
                    {p.name ?? ''}
                  </div>
                );
              })}
            </div>
          </>,
          document.body,
        );
      })()}

      {/* ── Party member panel (slide-in when in a party view) ── */}
      {!isPublicMode && isOnPartyTab && partyView !== 'browser' && memberPanelOpen && (
        <PartyErrorBoundary fallback={null}>
        {/* Drag divider — separates chat from member panel; pointer-drag resizes the panel. */}
        <div
          style={{
            width: '4px', flexShrink: 0, cursor: 'col-resize',
            background: hexAlpha(primaryColor, 0.18),
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = hexAlpha(primaryColor, 0.45); }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = hexAlpha(primaryColor, 0.18); }}
          onMouseDown={e => {
            e.preventDefault();
            memberPanelDragRef.current = { startX: e.clientX, startW: memberPanelWidth };
            const onMove = (ev: MouseEvent) => {
              if (!memberPanelDragRef.current) return;
              const delta = memberPanelDragRef.current.startX - ev.clientX; // dragging left = wider
              const next = Math.max(80, Math.min(320, memberPanelDragRef.current.startW + delta));
              setMemberPanelWidth(next);
              try { localStorage.setItem('fcm-member-panel-width', String(next)); } catch { /* ignore */ }
            };
            const onUp = () => {
              memberPanelDragRef.current = null;
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
          }}
        />
        <div style={{
          width: `${memberPanelWidth}px`, flexShrink: 0, minHeight: 0,
          background: bgRgba,
          border: `1px solid ${borderRgba}`, borderLeft: 'none',
          fontFamily: theme.fontFamily,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          position: 'relative',
          // Same game-style halo as the main overlay so the party-member list text
          // pops over a transparent background (inherits to all descendant text).
          textShadow: textOutline,
        }}>
          {/* Header — two rows: a title row ("PARTY MEMBERS" + category + close)
              and a readable stats row beneath. Text scales with the overlay
              font-scale (parity with the main chat panel). */}
          <div style={{
            background: chromeRgba,
            display: 'flex', flexDirection: 'column', gap: '3px', padding: '4px 6px',
            borderBottom: `1px solid ${borderRgba}`, flexShrink: 0,
            textShadow: textOutline,
          }}>
            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: `${Math.max(8, fontSize - 4)}px`, color: hexAlpha(theme.secondaryColor, textAlpha), fontWeight: 'bold', letterSpacing: '1px', flex: 1, whiteSpace: 'nowrap' }}>
                PARTY MEMBERS
              </span>
              <button
                onClick={() => setMemberPanelOpen(false)}
                style={{ minHeight: 0, boxSizing: 'border-box', background: 'none', border: 'none', color: hexAlpha(primaryColor, 0.6), cursor: 'pointer', fontSize: `${Math.max(10, fontSize - 2)}px`, padding: 0, lineHeight: 1, flexShrink: 0 }}
              >✕</button>
            </div>
            {/* Stats row — spelled-out, readable counts */}
            {(() => {
              const total = activePartyMembers.length;
              const online = activePartyMembers.filter(m => m.online).length;
              if (total === 0) return null;
              const statFont = `${Math.max(9, fontSize - 2)}px`;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: statFont, color: hexAlpha(theme.secondaryColor, textAlpha) }} title={`${total} ${total === 1 ? 'member' : 'members'}`}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ flexShrink: 0 }}><circle cx="5" cy="3" r="2.2"/><path d="M1 9.5C1 7 2.8 5.5 5 5.5s4 1.5 4 4"/></svg>
                    {total}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: statFont, color: '#18FF62' }} title={`${online} online`}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#18FF62', boxShadow: '0 0 3px #18FF62', flexShrink: 0, display: 'inline-block' }} />
                    {online}
                  </span>
                </div>
              );
            })()}
          </div>
          {/* Description blurb — shown above the member list when set */}
          {(() => {
            const dp = parties.find(p => p.id === partyView);
            if (!dp?.description) return null;
            return (
              <div style={{
                padding: '6px 8px',
                borderBottom: `1px solid ${hexAlpha(primaryColor, 0.12)}`,
                flexShrink: 0,
              }}>
                <div style={{
                  fontSize: `${Math.max(8, fontSize - 4)}px`,
                  color: hexAlpha(theme.textColor, 0.75),
                  fontStyle: 'italic',
                  lineHeight: 1.4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>{dp.description}</div>
              </div>
            );
          })()}
          {/* Member list */}
          <div className="fcm-scrollbar" style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin' }}>
            {activePartyMembers.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '8px', color: hexAlpha(theme.secondaryColor, 0.38), fontSize: `${Math.max(8, fontSize - 4)}px`, textAlign: 'center' }}>
                No members
              </div>
            ) : (
              [...activePartyMembers].sort((a, b) => {
                if (a.online !== b.online) return a.online ? -1 : 1;
                const roleOrder: Record<string, number> = { owner: 0, comod: 1, member: 2 };
                return (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99);
              }).map(member => (
                <div key={member.userId}
                  onContextMenu={e => {
                    e.preventDefault(); e.stopPropagation();
                    // No actionable menu on yourself.
                    if (member.userId === (user?.id ?? '')) return;
                    if (typeof partyView !== 'string') return;
                    setMemberCtx({ x: e.clientX, y: e.clientY, partyId: partyView, member });
                  }}
                  style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '4px 6px',
                  borderBottom: `1px solid ${hexAlpha(primaryColor, 0.08)}`,
                  opacity: member.online ? 1 : 0.5,
                  cursor: member.userId !== (user?.id ?? '') ? 'context-menu' : 'default',
                }}>
                  {/* Avatar with an online indicator dot on its bottom-right. */}
                  <div style={{ position: 'relative', flexShrink: 0, display: 'inline-flex' }}>
                    <Avatar
                      avatarUrl={member.avatarUrl}
                      name={member.username}
                      size={Math.max(16, fontSize + 6)}
                      primaryColor={primaryColor}
                    />
                    {member.online && (
                      <span style={{
                        position: 'absolute', right: '-1px', bottom: '-1px',
                        width: '8px', height: '8px', borderRadius: '50%',
                        background: '#18FF62', boxShadow: '0 0 3px #18FF62',
                        border: `1px solid ${hexToRgba(theme.backgroundColor, 0.9)}`,
                      }} />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1, textShadow: textOutline }}>
                    <div style={{ fontSize: `${Math.max(8, fontSize - 4)}px`, color: primaryText, fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {member.role === 'owner' ? '♛ ' : member.role === 'comod' ? '★ ' : ''}{member.username}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          {/* Join button — shown at the bottom of the member list for non-members
              viewing a public party (lets them read description + members before joining). */}
          {(() => {
            const vp = parties.find(p => p.id === partyView);
            if (!vp || vp.isMember || vp.isPrivate || isPublicMode) return null;
            return (
              <div style={{ padding: '4px 6px', borderTop: `1px solid ${borderRgba}`, flexShrink: 0, display: 'flex' }}>
                <button
                  onClick={() => { if (typeof partyView === 'string') joinPartyById(partyView); }}
                  style={{
                    flex: 1, minHeight: 0, boxSizing: 'border-box', height: '22px',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: `${Math.max(8, fontSize - 4)}px`, padding: '0 4px', lineHeight: 1,
                    background: hexAlpha(primaryColor, 0.18), cursor: 'pointer', fontFamily: theme.fontFamily,
                    letterSpacing: '0.04em', whiteSpace: 'nowrap',
                    border: `1px solid ${hexAlpha(primaryColor, 0.55)}`, color: primaryColor, fontWeight: 'bold',
                  }}
                >JOIN PARTY</button>
              </div>
            );
          })()}
          {/* Footer: invite only — leave/delete now live in the Parties browser row
              action area so the main party actions stay grouped together. */}
          {(() => {
            const myParty = parties.find(p => p.id === partyView);
            const myRole = myParty?.role;
            const canInvite = myRole === 'owner' || myRole === 'comod';
            const compactBtn: React.CSSProperties = {
              flex: 1, minHeight: 0, boxSizing: 'border-box', height: '22px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: `${Math.max(8, fontSize - 4)}px`, padding: '0 4px', lineHeight: 1,
              background: 'transparent', cursor: 'pointer', fontFamily: theme.fontFamily,
              letterSpacing: '0.04em', whiteSpace: 'nowrap',
            };
            return (
              <div style={{ padding: '4px 6px', borderTop: `1px solid ${borderRgba}`, flexShrink: 0, display: 'flex', gap: '4px' }}>
                {canInvite && typeof partyView === 'string' && (
                  <button
                    onClick={() => setInviteModalFor({ partyId: partyView })}
                    style={{ ...compactBtn, border: `1px solid ${hexAlpha(primaryColor, 0.4)}`, color: primaryColor }}
                  >+ INVITE</button>
                )}
              </div>
            );
          })()}
        </div>
        </PartyErrorBoundary>
      )}

      {/* ── Server member list panel ── */}
      {isOnServerChannel && !adminFeedActive && (
        <div style={{
          width: '180px',
          flexShrink: 0,
          minHeight: 0,
          background: bgRgba,
          border: `1px solid ${borderRgba}`,
          borderLeft: 'none',
          fontFamily: theme.fontFamily,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
        }}>
          <div style={{
            height: '22px',
            background: chromeRgba,
            display: 'flex', alignItems: 'center', padding: '0 6px',
            borderBottom: `1px solid ${borderRgba}`, flexShrink: 0,
          }}>
            <span style={{ fontSize: '8px', color: hexAlpha(theme.secondaryColor, 0.7), letterSpacing: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {'\u2588'} {allPlayers !== null
                ? `${allPlayers.length}/24 PLAYERS · ${totalChatMod} CHATMOD`
                : `${totalChatMod} CHATMOD ON SERVER`}
            </span>
          </div>

          <div className="fcm-scrollbar" style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'thin' }}>
            {serverMembers.length === 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', padding: '8px',
                color: hexAlpha(theme.secondaryColor, 0.38), fontSize: '8px', textAlign: 'center',
              }}>
                No players detected
              </div>
            ) : (
              serverMembers.map(member => (
                <div key={member.id} style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '4px 6px',
                  borderBottom: `1px solid ${hexAlpha(primaryColor, 0.08)}`,
                }}>
                  <div style={{
                    width: '20px', height: '20px', borderRadius: '50%', flexShrink: 0,
                    background: hexAlpha(primaryColor, 0.1),
                    border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '8px', color: primaryColor, fontWeight: 'bold',
                  }}>
                    {(member.username || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: '8px', color: primaryColor, fontWeight: 'bold',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {member.username}
                    </div>
                    {member.discordUsername && (
                      <div style={{
                        fontSize: '7px', color: dimText,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {member.discordUsername}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div style={{
            height: '16px', padding: '0 6px', display: 'flex', alignItems: 'center',
            borderTop: `1px solid ${borderRgba}`, flexShrink: 0,
            fontSize: '7px', color: hexAlpha(theme.secondaryColor, 0.35), letterSpacing: '0.5px',
          }}>
            updates every 10s
          </div>

          {showScanlines && (
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              background: 'repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(0,0,0,0.06) 1px, rgba(0,0,0,0.06) 2px)',
            }} />
          )}
        </div>
      )}

      {/* ── Transient action toast (non-focus-stealing; replaces native alert) ── */}
      {actionToast && createPortal(
        <PartyErrorBoundary fallback={null}>
          <div style={{
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 10003, pointerEvents: 'none',
            background: menuBgColor(theme, chromeBgAlpha, 1.5),
            border: `1px solid ${actionToast.kind === 'err' ? hexAlpha('#ff5a5a', 0.7) : hexAlpha(primaryColor, 0.5)}`,
            color: actionToast.kind === 'err' ? '#ff8a8a' : primaryColor,
            fontFamily: theme.fontFamily, fontSize: '11px', letterSpacing: '0.04em',
            padding: '8px 14px', maxWidth: '320px', textAlign: 'center',
            boxShadow: `0 0 16px ${hexAlpha(primaryColor, 0.08)}`,
          }}>{actionToast.text}</div>
        </PartyErrorBoundary>,
        document.body
      )}

      {/* ── Party invite toasts (non-focus-stealing) ── */}
      {partyInviteToasts.length > 0 && createPortal(
        <PartyErrorBoundary fallback={null}>
        <div style={{
          position: 'fixed', bottom: '20px', right: '20px',
          display: 'flex', flexDirection: 'column', gap: '8px',
          zIndex: 10002,
          // CRITICAL: container must never capture mouse — only buttons inside do.
          pointerEvents: 'none',
        }}>
          {partyInviteToasts.map(inv => (
            <div key={inv.id} style={{
              background: menuBgColor(theme, chromeBgAlpha, 1.5),
              border: `1px solid ${hexAlpha(primaryColor, 0.5)}`,
              color: primaryColor,
              fontFamily: theme.fontFamily,
              padding: '10px 12px',
              maxWidth: '280px',
              boxShadow: `0 0 16px ${hexAlpha(primaryColor, 0.08)}`,
              pointerEvents: 'none', // container stays click-through
            }}>
              <div style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '4px', letterSpacing: '0.08em' }}>
                PARTY INVITE
              </div>
              <div style={{ fontSize: '10px', marginBottom: '8px', opacity: 0.85 }}>
                <strong>{inv.inviterName}</strong> invited you to <strong>{inv.partyName}</strong>
              </div>
              <div style={{ display: 'flex', gap: '6px', pointerEvents: 'none' }}>
                <button
                  onClick={async () => {
                    try {
                      const res = await api.post<{ data: { party: Party } }>(`/api/parties/invites/${inv.id}/accept`, {});
                      const party = (res as any)?.party ?? (res as any)?.data?.party;
                      setPartyInviteToasts(prev => prev.filter(t => t.id !== inv.id));
                      setPartyActionError(null);
                      queryClient.invalidateQueries({ queryKey: ['parties'] });
                      queryClient.invalidateQueries({ queryKey: ['party-invites'] });
                      setActiveMainId(PARTY_MAIN_ID);
                      if (party?.id) setPartyView(party.id);
                    } catch (err: any) {
                      // Surface the rejection in the Public Parties banner: jump
                      // there (browser view) and set the error AFTER the view
                      // switch (whose effect would otherwise clear it).
                      setPartyInviteToasts(prev => prev.filter(t => t.id !== inv.id));
                      setActiveMainId(PARTY_MAIN_ID);
                      setPartyView('browser');
                      setTimeout(() => setPartyActionError(err?.message || 'Could not accept invite'), 0);
                    }
                  }}
                  style={{
                    pointerEvents: 'auto', // ONLY buttons are interactive
                    padding: '3px 10px', fontSize: '10px', fontWeight: 'bold',
                    background: hexAlpha(primaryColor, 0.2),
                    border: `1px solid ${hexAlpha(primaryColor, 0.6)}`,
                    color: primaryColor, cursor: 'pointer', fontFamily: theme.fontFamily,
                  }}
                >ACCEPT</button>
                <button
                  onClick={async () => {
                    try {
                      await api.post(`/api/parties/invites/${inv.id}/decline`, {});
                    } catch { /* ignore */ }
                    setPartyInviteToasts(prev => prev.filter(t => t.id !== inv.id));
                    queryClient.invalidateQueries({ queryKey: ['party-invites'] });
                  }}
                  style={{
                    pointerEvents: 'auto',
                    padding: '3px 10px', fontSize: '10px',
                    background: 'transparent',
                    border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
                    color: hexAlpha(primaryColor, 0.6), cursor: 'pointer', fontFamily: theme.fontFamily,
                  }}
                >DECLINE</button>
              </div>
            </div>
          ))}
        </div>
        </PartyErrorBoundary>,
        document.body
      )}

      {/* ── Create Party modal ── */}
      {createPartyOpen && createPortal(
        <PartyErrorBoundary fallback={null}>
        <CreatePartyModal
          primaryColor={primaryColor}
          theme={theme}
          onClose={() => setCreatePartyOpen(false)}
          onCreate={async (newParty) => {
            setCreatePartyOpen(false);
            queryClient.invalidateQueries({ queryKey: ['parties'] });
            setPartyView(newParty.id);
          }}
        />
        </PartyErrorBoundary>,
        document.body
      )}

      {/* ── Wiki panel ── */}
      {/* ── Settings modal — portalled to body so position:fixed escapes overflow:hidden ── */}
      {settingsOpen && createPortal(
        <SettingsModal
          settings={settings}
          theme={theme}
          onChange={patchSettings}
          onClose={() => setSettingsOpen(false)}
          selfAvatarUrl={user?.avatarUrl ?? null}
          selfName={user?.fo76Name || user?.discordDisplayName || user?.username}
          onBlockChange={refreshBlocked}
          hideShellSliders={!!overlayShell}
          chromeBgAlpha={chromeBgAlpha}
        />,
        document.body
      )}

      {/* ── Standalone Blocked-Users modal (overlay shell-settings entry) ── */}
      {blockManagerOpen && createPortal(
        <BlockManagerModal
          theme={theme}
          onClose={() => setBlockManagerOpen(false)}
          onBlockChange={refreshBlocked}
          chromeBgAlpha={chromeBgAlpha}
        />,
        document.body
      )}

      {/* ── Moderation modal ── */}
      {modModal && (
        <ModerationModal
          action={modModal.action}
          target={modModal.target}
          onConfirm={executeModAction}
          onCancel={() => { setModModal(null); setModError(null); }}
          loading={modLoading}
          error={modError}
          primaryColor={primaryColor}
          theme={theme}
        />
      )}

      {/* ── In-app image lightbox ── */}
      {lightboxUrl && createPortal(
        <div
          onMouseDown={() => setLightboxUrl(null)}
          onKeyDown={e => { if (e.key === 'Escape') setLightboxUrl(null); }}
          tabIndex={-1}
          style={{
            position: 'fixed', inset: 0, zIndex: 20000,
            background: 'rgba(0,0,0,0.88)',
            // Electron body{display:inline} quirk — need explicit display:flex here.
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={lightboxUrl}
            alt=""
            onMouseDown={e => e.stopPropagation()}
            style={{
              maxWidth: '90vw', maxHeight: '90vh',
              objectFit: 'contain',
              border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
              boxShadow: `0 0 40px rgba(0,0,0,0.8)`,
              cursor: 'default',
              display: 'block',
            }}
          />
          <button
            onMouseDown={e => { e.stopPropagation(); setLightboxUrl(null); }}
            style={{
              position: 'absolute', top: '16px', right: '20px',
              minHeight: 0, boxSizing: 'border-box',
              background: 'rgba(0,0,0,0.6)', border: `1px solid ${hexAlpha(primaryColor, 0.5)}`,
              color: primaryColor, fontSize: '18px', lineHeight: 1,
              width: '32px', height: '32px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', fontFamily: theme.fontFamily,
            }}
          >✕</button>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Tiny inline mod button ──────────────────────────────────────────────────
function ModBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '0 3px', fontSize: '7px', lineHeight: '14px', fontWeight: 'bold',
      background: 'transparent', border: `1px solid ${color}40`, color,
      cursor: 'pointer', fontFamily: '"Courier New", monospace',
    }}>
      {label}
    </button>
  );
}

// ── Moderation modal ────────────────────────────────────────────────────────
function ModerationModal({ action, target, onConfirm, onCancel, loading, error, primaryColor, theme }: {
  action: string; target: ChatMessage;
  onConfirm: (body: any) => void; onCancel: () => void;
  loading: boolean; error: string | null;
  primaryColor: string; theme: WebTheme;
}) {
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState(60);
  const bgRgba = hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.6));
  const border = hexAlpha(primaryColor, 0.3);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        background: bgRgba, border: `1px solid ${border}`,
        padding: '16px', minWidth: '300px', fontFamily: theme.fontFamily,
      }}>
        <div style={{ fontSize: '13px', color: primaryColor, marginBottom: '12px', fontWeight: 'bold' }}>
          {action.toUpperCase()} — {target.username}
        </div>
        <div style={{ fontSize: '10px', color: hexAlpha(theme.secondaryColor, 0.6), marginBottom: '8px' }}>
          "{target.content}"
        </div>

        {action === 'mute' && (
          <div style={{ marginBottom: '8px' }}>
            <label style={{ fontSize: '10px', color: primaryColor, display: 'block', marginBottom: '4px' }}>Duration</label>
            <select value={duration} onChange={e => setDuration(Number(e.target.value))} style={{
              background: hexToRgba(theme.inputBgColor, theme.inputAlpha),
              color: theme.textColor, border: `1px solid ${border}`,
              padding: '4px', fontSize: '10px', width: '100%', fontFamily: theme.fontFamily,
            }}>
              {MUTE_DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
        )}

        {(action === 'mute' || action === 'ban') && (
          <div style={{ marginBottom: '8px' }}>
            <label style={{ fontSize: '10px', color: primaryColor, display: 'block', marginBottom: '4px' }}>Reason</label>
            <input value={reason} onChange={e => setReason(e.target.value)}
              placeholder="Optional reason..."
              style={{
                background: hexToRgba(theme.inputBgColor, theme.inputAlpha),
                color: theme.textColor, border: `1px solid ${border}`,
                padding: '4px 8px', fontSize: '10px', width: '100%',
                fontFamily: theme.fontFamily, outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        )}

        {error && <div style={{ color: '#FF4444', fontSize: '10px', marginBottom: '8px' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            background: 'transparent', border: `1px solid ${border}`,
            color: hexAlpha(theme.secondaryColor, 0.7), padding: '5px 14px',
            fontSize: '10px', cursor: 'pointer', fontFamily: theme.fontFamily,
          }}>CANCEL</button>
          <button
            onClick={() => onConfirm({ reason, duration })}
            disabled={loading}
            style={{
              background: hexAlpha(primaryColor, 0.15), border: `1px solid ${hexAlpha(primaryColor, 0.5)}`,
              color: primaryColor, padding: '5px 14px', fontSize: '10px',
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily: theme.fontFamily,
            }}
          >
            {loading ? '...' : 'CONFIRM'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mute modal — moderator picks duration + category + reason. POSTs
// /api/moderation/mutes. Discord timeout is propagated server-side
// when the target has a linked Discord ID (capped at 28d).
// ─────────────────────────────────────────────────────────────────────────────
const MUTE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '1h',  minutes: 60 },
  { label: '6h',  minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: '3d',  minutes: 4320 },
  { label: '7d',  minutes: 10080 },
  { label: '30d', minutes: 43200 },
];
const MUTE_CATEGORIES = ['Harassment', 'HateSpeech', 'Spam', 'Cheating', 'NSFW', 'Threats', 'Doxxing', 'Other'];
// Party category preset list — shared by the create-party modal and the
// browser FILTERS popover category filter. Keep in sync with backend.
const PARTY_CATEGORIES = ['General', 'Trading', 'Raids', 'Events', 'PvP', 'Casual', 'Help', 'Social'];

// Category color badges — Pip-Boy-friendly distinct hues.
const CATEGORY_BADGE_COLORS: Record<string, string> = {
  General:  '#18FF62', // phosphor green
  Trading:  '#FFB000', // amber
  Raids:    '#FF4444', // red
  Events:   '#5AC8FA', // sky blue
  PvP:      '#FF6FB5', // pink
  Casual:   '#B57AFF', // purple
  Help:     '#62EEFF', // cyan
  Social:   '#FFE566', // yellow
};

function CategoryBadge({ cat, fontSize }: { cat: string; fontSize?: number }) {
  const color = CATEGORY_BADGE_COLORS[cat] ?? '#888888';
  const fs = Math.max(7, (fontSize ?? 11) - 2);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: `0px ${fs < 9 ? 3 : 5}px`,
      background: `${color}22`,
      border: `1px solid ${color}88`,
      color,
      fontSize: `${fs}px`,
      letterSpacing: '0.04em',
      borderRadius: '2px',
      whiteSpace: 'nowrap',
      lineHeight: `${Math.max(12, fs + 4)}px`,
    }}>{cat}</span>
  );
}

function MuteModal({
  target, onClose, primaryColor, chromeColor, fontFamily,
}: {
  target: { userId: string; username: string };
  onClose: () => void;
  primaryColor: string;
  chromeColor: string;
  fontFamily: string;
}) {
  const [minutes, setMinutes] = React.useState<number>(60);
  const [category, setCategory] = React.useState<string>('Spam');
  const [reason, setReason] = React.useState<string>('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) { setErr('Reason required.'); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/moderation/mutes', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: target.userId, durationMinutes: minutes, category, reason }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${res.status}`);
      }
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ background: chromeColor, border: `1px solid ${primaryColor}`, fontFamily, color: primaryColor, padding: '16px', minWidth: '340px', maxWidth: '90vw' }}>
        <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px' }}>Mute {target.username}</div>
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>DURATION</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
            {MUTE_PRESETS.map(p => (
              <button key={p.label} onClick={() => setMinutes(p.minutes)} style={{
                padding: '3px 10px', fontSize: '12px', fontFamily,
                border: `1px solid ${primaryColor}`, background: minutes === p.minutes ? primaryColor : 'transparent', color: minutes === p.minutes ? chromeColor : primaryColor,
                cursor: 'pointer',
              }}>{p.label}</button>
            ))}
          </div>
          <input type="number" min="1" max="43200" value={minutes} onChange={e => setMinutes(parseInt(e.target.value, 10) || 0)} style={{ width: '100px', background: 'transparent', color: primaryColor, border: `1px solid ${primaryColor}`, padding: '2px 4px', fontFamily }} /> <span style={{ fontSize: '11px', opacity: 0.7 }}>minutes (max 43200 = 30 days)</span>
        </div>
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>CATEGORY</div>
          <select value={category} onChange={e => setCategory(e.target.value)} style={{ width: '100%', background: 'transparent', color: primaryColor, border: `1px solid ${primaryColor}`, padding: '2px 4px', fontFamily }}>
            {MUTE_CATEGORIES.map(c => <option key={c} value={c} style={{ background: chromeColor }}>{c}</option>)}
          </select>
        </div>
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>REASON (required, public in #general)</div>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} style={{ width: '100%', background: 'transparent', color: primaryColor, border: `1px solid ${primaryColor}`, padding: '2px 4px', fontFamily, resize: 'vertical' }} maxLength={500} />
        </div>
        {minutes > 28 * 1440 && <div style={{ fontSize: '11px', opacity: 0.7, marginBottom: '8px' }}>Note: Discord timeout caps at 28d. Overlay mute continues for the full duration.</div>}
        {err && <div style={{ color: '#FF6060', fontSize: '12px', marginBottom: '8px' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button onClick={onClose} disabled={busy} style={{ padding: '4px 12px', background: 'transparent', color: primaryColor, border: `1px solid ${primaryColor}`, fontFamily, cursor: 'pointer' }}>CANCEL</button>
          <button onClick={submit} disabled={busy || !reason.trim()} style={{ padding: '4px 12px', background: primaryColor, color: chromeColor, border: `1px solid ${primaryColor}`, fontFamily, cursor: 'pointer', fontWeight: 'bold' }}>{busy ? 'MUTING…' : 'CONFIRM MUTE'}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Kick modal — short required reason. Backend rejects empty reason. Always
// 5-minute cooldown; the bot disconnects the WS and the next reconnect bounces
// for 5 min with KICK_COOLDOWN:<seconds> in the close-reason.
// ─────────────────────────────────────────────────────────────────────────────
function KickModal({
  target, onClose, primaryColor, chromeColor, fontFamily,
}: {
  target: { userId: string; username: string };
  onClose: () => void;
  primaryColor: string;
  chromeColor: string;
  fontFamily: string;
}) {
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) { setErr('Reason required.'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/moderation/kicks', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: target.userId, reason }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${res.status}`);
      }
      onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ background: chromeColor, border: `1px solid ${primaryColor}`, fontFamily, color: primaryColor, padding: '16px', minWidth: '340px', maxWidth: '90vw' }}>
        <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '4px' }}>Kick {target.username}</div>
        <div style={{ fontSize: '11px', opacity: 0.7, marginBottom: '12px' }}>5-minute reconnect cooldown · public in #general</div>
        <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>REASON (required)</div>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={300} autoFocus
          style={{ width: '100%', background: 'transparent', color: primaryColor, border: `1px solid ${primaryColor}`, padding: '2px 4px', fontFamily, resize: 'vertical' }} />
        {err && <div style={{ color: '#FF6060', fontSize: '12px', marginTop: '6px' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
          <button onClick={onClose} disabled={busy} style={{ padding: '4px 12px', background: 'transparent', color: primaryColor, border: `1px solid ${primaryColor}`, fontFamily, cursor: 'pointer' }}>CANCEL</button>
          <button onClick={submit} disabled={busy || !reason.trim()} style={{ padding: '4px 12px', background: primaryColor, color: chromeColor, border: `1px solid ${primaryColor}`, fontFamily, cursor: 'pointer', fontWeight: 'bold' }}>{busy ? 'KICKING…' : 'CONFIRM KICK'}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UserProfileModal — admin-only. Shows a user's current display name and their
// previous aliases fetched from GET /api/users/:userId/aliases.
// ─────────────────────────────────────────────────────────────────────────────
function UserProfileModal({
  target, onClose, primaryColor, chromeColor, fontFamily,
}: {
  target: { userId: string; username: string };
  onClose: () => void;
  primaryColor: string;
  chromeColor: string;
  fontFamily: string;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['user-aliases', target.userId],
    queryFn: () => api.get<{ aliases: { alias: string; createdAt: string }[] }>(
      `/api/users/${encodeURIComponent(target.userId)}/aliases`
    ),
    staleTime: 60_000,
  });

  const aliases = data?.aliases ?? [];

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ background: chromeColor, border: `1px solid ${primaryColor}`, fontFamily, color: primaryColor, padding: '16px', minWidth: '300px', maxWidth: '90vw' }}>
        <div style={{ fontSize: '10px', letterSpacing: '0.12em', opacity: 0.6, marginBottom: '4px' }}>USER PROFILE</div>
        <div style={{ fontSize: '15px', fontWeight: 'bold', marginBottom: '14px', borderBottom: `1px solid ${primaryColor}`, paddingBottom: '8px' }}>
          {target.username}
        </div>
        <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '6px' }}>PREVIOUS ALIASES</div>
        {isLoading && (
          <div style={{ fontSize: '12px', opacity: 0.6, marginBottom: '10px' }}>Loading…</div>
        )}
        {isError && (
          <div style={{ fontSize: '12px', color: '#FF6060', marginBottom: '10px' }}>Failed to load aliases.</div>
        )}
        {!isLoading && !isError && aliases.length === 0 && (
          <div style={{ fontSize: '12px', opacity: 0.6, marginBottom: '10px' }}>No previous aliases.</div>
        )}
        {!isLoading && !isError && aliases.length > 0 && (
          <ul style={{ margin: '0 0 12px 0', padding: '0', listStyle: 'none' }}>
            {aliases.map((a, i) => (
              <li key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '12px', padding: '3px 0', borderBottom: `1px solid ${primaryColor}22` }}>
                <span>{a.alias}</span>
                <span style={{ opacity: 0.5, fontSize: '11px', whiteSpace: 'nowrap' }}>
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '4px 12px', background: 'transparent', color: primaryColor, border: `1px solid ${primaryColor}`, fontFamily, cursor: 'pointer' }}>CLOSE</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CreatePartyModal
// ─────────────────────────────────────────────────────────────────────────────
function CreatePartyModal({
  primaryColor, theme, onClose, onCreate,
}: {
  primaryColor: string;
  theme: WebTheme;
  onClose: () => void;
  onCreate: (party: Party) => void;
}) {
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState(primaryColor);
  const [isPrivate, setIsPrivate] = React.useState(false);
  const [reapPolicy, setReapPolicy] = React.useState<'persistent' | 'ephemeral'>('persistent');
  const [category, setCategory] = React.useState('General');
  // Blank = unlimited; otherwise an integer 2–50.
  const [maxMembers, setMaxMembers] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const bgRgba = hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.6));
  const border = hexAlpha(primaryColor, 0.3);
  const ff = theme.fontFamily;

  async function submit() {
    if (!name.trim()) { setErr('Name required.'); return; }
    // Blank → unlimited (null). Otherwise must be an integer 2–50.
    let maxMembersValue: number | null = null;
    const trimmed = maxMembers.trim();
    if (trimmed !== '') {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 2 || n > 50) { setErr('Max members must be 2–50 (or blank for unlimited).'); return; }
      maxMembersValue = n;
    }
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/parties', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), color, isPrivate, reapPolicy, category, maxMembers: maxMembersValue, description: description.trim() || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${res.status}`);
      }
      const j = await res.json();
      const party = j?.data?.party ?? j?.party;
      if (party) onCreate(party as Party);
      else onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ background: bgRgba, border: `1px solid ${border}`, fontFamily: ff, color: primaryColor, padding: '16px', minWidth: '320px', maxWidth: '90vw' }}>
        <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '14px', letterSpacing: '0.1em' }}>CREATE PARTY</div>

        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7 }}>NAME (required)</span>
            <span style={{ fontSize: '9px', letterSpacing: '0.04em', color: name.length >= 24 ? '#FF6060' : hexAlpha(primaryColor, 0.5) }}>{name.length}/24</span>
          </div>
          <input
            value={name} onChange={e => setName(e.target.value)} maxLength={24} autoFocus
            style={{ width: '100%', background: 'transparent', color: primaryColor, border: `1px solid ${border}`, padding: '4px 8px', fontFamily: ff, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>COLOR</div>
          {/* In-modal swatch picker + hex input. A native <input type="color">
              opens the OS picker dialog, which renders BEHIND the transparent
              always-on-top overlay window and is unusable — so we never use it
              here. Presets are Pip-Boy palette colors. */}
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
            {['#18FF62', '#C8A840', '#FFB000', '#FF6644', '#5AC8FA', '#B57AFF', '#FF6FB5', '#FFFFFF'].map(sw => {
              const selected = color.toUpperCase() === sw.toUpperCase();
              return (
                <button
                  key={sw}
                  type="button"
                  onClick={() => setColor(sw)}
                  title={sw}
                  style={{
                    width: '20px', height: '20px', minHeight: 0, boxSizing: 'border-box',
                    flexShrink: 0, cursor: 'pointer',
                    background: sw, padding: 0,
                    border: selected ? `2px solid ${primaryColor}` : `1px solid ${hexAlpha(primaryColor, 0.4)}`,
                    boxShadow: selected ? `0 0 6px ${hexAlpha(sw, 0.9)}` : 'none',
                    outline: 'none',
                  }}
                />
              );
            })}
            {/* Swatch preview of the current value + hex text input */}
            <span style={{
              width: '20px', height: '20px', boxSizing: 'border-box', flexShrink: 0,
              background: color, border: `1px solid ${hexAlpha(primaryColor, 0.4)}`,
              marginLeft: '4px',
            }} />
            <input
              value={color}
              onChange={e => {
                let v = e.target.value.trim();
                if (v && !v.startsWith('#')) v = '#' + v;
                setColor(v.slice(0, 7));
              }}
              maxLength={7}
              placeholder="#RRGGBB"
              style={{
                width: '78px', background: 'transparent', color: primaryColor,
                border: `1px solid ${border}`, padding: '3px 6px', fontFamily: ff,
                fontSize: '11px', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        <div style={{ marginBottom: '12px', display: 'flex', gap: '12px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '6px' }}>VISIBILITY</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {[{ label: 'Public', v: false }, { label: 'Private', v: true }].map(opt => (
                <button key={opt.label} onClick={() => setIsPrivate(opt.v)} style={{
                  flex: 1, padding: '4px', minHeight: 0, boxSizing: 'border-box', fontSize: '11px', fontFamily: ff,
                  border: `1px solid ${border}`,
                  background: isPrivate === opt.v ? hexAlpha(primaryColor, 0.2) : 'transparent',
                  color: isPrivate === opt.v ? primaryColor : hexAlpha(primaryColor, 0.6),
                  cursor: 'pointer',
                }}>{opt.label}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '6px' }}>LIFECYCLE</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {([['persistent', 'Persistent'], ['ephemeral', 'Temporary']] as const).map(([v, label]) => (
                <button key={v} onClick={() => setReapPolicy(v)} style={{
                  flex: 1, padding: '4px', minHeight: 0, boxSizing: 'border-box', fontSize: '11px', fontFamily: ff,
                  border: `1px solid ${border}`,
                  background: reapPolicy === v ? hexAlpha(primaryColor, 0.2) : 'transparent',
                  color: reapPolicy === v ? primaryColor : hexAlpha(primaryColor, 0.6),
                  cursor: 'pointer',
                }}>{label}</button>
              ))}
            </div>
            <div style={{ fontSize: '8px', opacity: 0.5, marginTop: '4px' }}>
              {reapPolicy === 'persistent' ? 'Stays alive until empty' : 'Deleted when all members go offline'}
            </div>
          </div>
        </div>

        {/* CATEGORY — preset list. Default 'General'. Sent in POST body. */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '6px' }}>CATEGORY</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {PARTY_CATEGORIES.map(cat => {
              const selected = category === cat;
              const badgeColor = CATEGORY_BADGE_COLORS[cat] ?? primaryColor;
              return (
                <button key={cat} type="button" onClick={() => setCategory(cat)} style={{
                  padding: '3px 8px', minHeight: 0, boxSizing: 'border-box', fontSize: '11px', fontFamily: ff,
                  border: `1px solid ${selected ? badgeColor : hexAlpha(badgeColor, 0.4)}`,
                  background: selected ? `${badgeColor}33` : 'transparent',
                  color: selected ? badgeColor : hexAlpha(badgeColor, 0.65),
                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px',
                }}>{cat}</button>
              );
            })}
          </div>
        </div>

        {/* MAX MEMBERS — optional. Blank = unlimited; otherwise 2–50. */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>MAX MEMBERS (optional)</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              value={maxMembers}
              onChange={e => setMaxMembers(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
              inputMode="numeric"
              placeholder="∞"
              style={{
                width: '64px', minHeight: 0, boxSizing: 'border-box',
                background: 'transparent', color: primaryColor, border: `1px solid ${border}`,
                padding: '4px 8px', fontFamily: ff, fontSize: '12px', outline: 'none', textAlign: 'center',
              }}
            />
            <span style={{ fontSize: '9px', opacity: 0.5 }}>
              {maxMembers.trim() === '' ? 'Unlimited' : '2–50'}
            </span>
          </div>
        </div>

        {/* DESCRIPTION — optional short blurb (1–2 sentences). */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7 }}>DESCRIPTION (optional)</span>
            <span style={{ fontSize: '9px', letterSpacing: '0.04em', color: description.length >= 270 ? '#FF6060' : hexAlpha(primaryColor, 0.5) }}>{description.length}/300</span>
          </div>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={300}
            rows={2}
            placeholder="Brief description…"
            style={{
              width: '100%', background: 'transparent', color: primaryColor,
              border: `1px solid ${border}`, padding: '4px 8px',
              fontFamily: ff, fontSize: '12px', outline: 'none',
              boxSizing: 'border-box', resize: 'vertical',
              minHeight: '42px',
            }}
          />
        </div>

        {err && <div style={{ color: '#FF6060', fontSize: '12px', marginBottom: '8px' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
          <button onClick={onClose} disabled={busy} style={{ padding: '4px 12px', minHeight: 0, boxSizing: 'border-box', background: 'transparent', color: primaryColor, border: `1px solid ${border}`, fontFamily: ff, cursor: 'pointer' }}>CANCEL</button>
          <button onClick={submit} disabled={busy || !name.trim()} style={{ padding: '4px 14px', minHeight: 0, boxSizing: 'border-box', background: hexAlpha(primaryColor, 0.2), color: primaryColor, border: `1px solid ${hexAlpha(primaryColor, 0.6)}`, fontFamily: ff, fontWeight: 'bold', cursor: 'pointer' }}>
            {busy ? 'CREATING…' : 'CREATE'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PartyLimitEditor — tiny inline number editor anchored at the right-click menu
// position. Prefilled from the party's current maxMembers (blank = unlimited).
// On submit PATCHes /api/parties/:id with { maxMembers: null | int 2–50 } and
// surfaces backend errors (e.message) inline.
// ─────────────────────────────────────────────────────────────────────────────
function PartyLimitEditor({
  party, x, y, primaryColor, theme, borderBright, fontSize, onClose, onSaved, chromeBgAlpha = 1,
}: {
  party: Party;
  x: number; y: number;
  primaryColor: string;
  theme: WebTheme;
  borderBright: string;
  fontSize: number;
  onClose: () => void;
  onSaved: () => void;
  chromeBgAlpha?: number;
}) {
  const [val, setVal] = React.useState(party.maxMembers != null ? String(party.maxMembers) : '');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const ff = theme.fontFamily;
  const bg = menuBgColor(theme, chromeBgAlpha, 1.4);

  async function save() {
    let maxMembers: number | null = null;
    const trimmed = val.trim();
    if (trimmed !== '') {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 2 || n > 50) { setErr('maxMembers must be 2–50'); return; }
      maxMembers = n;
    }
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/parties/${party.id}`, { maxMembers });
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Failed to set limit');
    } finally { setBusy(false); }
  }

  // Clamp roughly within the viewport so the popover never opens off-screen.
  const left = Math.min(x, window.innerWidth - 180);
  const top = Math.min(y, window.innerHeight - 110);

  return (
    <>
      <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 10000 }} />
      <div onMouseDown={e => e.stopPropagation()} style={{
        position: 'fixed', left: Math.max(4, left), top: Math.max(4, top), zIndex: 10001,
        background: bg, border: `1px solid ${borderBright}`, fontFamily: ff,
        color: primaryColor, padding: '8px 10px', minWidth: '168px',
      }}>
        <div style={{ fontSize: '9px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '6px' }}>
          MEMBER LIMIT — {party.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            value={val} autoFocus
            onChange={e => setVal(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose(); }}
            inputMode="numeric"
            placeholder="∞"
            style={{
              width: '54px', minHeight: 0, boxSizing: 'border-box', textAlign: 'center',
              background: 'transparent', color: primaryColor, border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
              padding: '3px 6px', fontFamily: ff, fontSize: '12px', outline: 'none',
            }}
          />
          <button onClick={save} disabled={busy} style={{
            minHeight: 0, boxSizing: 'border-box', padding: '4px 8px', fontSize: '10px', fontFamily: ff,
            background: hexAlpha(primaryColor, 0.2), border: `1px solid ${hexAlpha(primaryColor, 0.6)}`,
            color: primaryColor, cursor: 'pointer', fontWeight: 'bold',
          }}>{busy ? '…' : 'SET'}</button>
          <button onClick={() => setVal('')} title="Unlimited" style={{
            minHeight: 0, boxSizing: 'border-box', padding: '4px 6px', fontSize: '10px', fontFamily: ff,
            background: 'transparent', border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
            color: hexAlpha(primaryColor, 0.7), cursor: 'pointer',
          }}>∞</button>
        </div>
        <div style={{ fontSize: '8px', opacity: 0.5, marginTop: '5px' }}>
          {val.trim() === '' ? 'Blank = unlimited' : '2–50'}
        </div>
        {err && <div style={{ color: '#FF6060', fontSize: '10px', marginTop: '5px' }}>{err}</div>}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PartyDescriptionEditor — small modal for owner/co-mod to edit a party description.
// PATCHes /api/parties/:id with { description } and calls onSaved on success.
// ─────────────────────────────────────────────────────────────────────────────
function PartyDescriptionEditor({
  party, primaryColor, theme, onClose, onSaved,
}: {
  party: Party;
  primaryColor: string;
  theme: WebTheme;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [val, setVal] = React.useState(party.description ?? '');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const ff = theme.fontFamily;
  const bg = hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.6));
  const border = hexAlpha(primaryColor, 0.3);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/parties/${party.id}`, { description: val.trim() || null });
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save description');
    } finally { setBusy(false); }
  }

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        background: bg, border: `1px solid ${border}`, fontFamily: ff, color: primaryColor,
        padding: '16px', minWidth: '300px', maxWidth: '90vw',
      }}>
        <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '12px', letterSpacing: '0.1em' }}>
          EDIT DESCRIPTION — {party.name}
        </div>
        <div style={{ marginBottom: '6px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7 }}>DESCRIPTION (optional)</span>
          <span style={{ fontSize: '9px', color: val.length >= 270 ? '#FF6060' : hexAlpha(primaryColor, 0.5) }}>{val.length}/300</span>
        </div>
        <textarea
          value={val}
          onChange={e => setVal(e.target.value)}
          maxLength={300}
          rows={3}
          autoFocus
          placeholder="Brief description…"
          onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
          style={{
            width: '100%', background: 'transparent', color: primaryColor,
            border: `1px solid ${border}`, padding: '4px 8px',
            fontFamily: ff, fontSize: '12px', outline: 'none',
            boxSizing: 'border-box', resize: 'vertical', minHeight: '54px',
          }}
        />
        {err && <div style={{ color: '#FF6060', fontSize: '11px', margin: '6px 0 0' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
          <button onClick={onClose} disabled={busy} style={{ padding: '4px 12px', minHeight: 0, boxSizing: 'border-box', background: 'transparent', color: primaryColor, border: `1px solid ${border}`, fontFamily: ff, cursor: 'pointer' }}>CANCEL</button>
          <button onClick={save} disabled={busy} style={{ padding: '4px 14px', minHeight: 0, boxSizing: 'border-box', background: hexAlpha(primaryColor, 0.2), color: primaryColor, border: `1px solid ${hexAlpha(primaryColor, 0.6)}`, fontFamily: ff, fontWeight: 'bold', cursor: 'pointer' }}>
            {busy ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PartyInviteModal — in-overlay invite dialog (replaces the dead prompt()-based
// invite button). Two modes:
//   • Invite directly: debounced autocomplete → POST /invite { userId }.
//   • Post a public invitation (PUBLIC parties only): channel picker → POST
//     /invite-public { channelId }.
// ─────────────────────────────────────────────────────────────────────────────
interface InviteSearchResult { userId: string; displayName: string; avatarUrl: string | null }

function PartyInviteModal({
  party, channels, primaryColor, theme, borderBright, fontSize, onClose,
}: {
  party: Party;
  // The postable sub-channels (General/Trading/Events/Raids), NOT the main tabs.
  channels: { id: string; name: string }[];
  primaryColor: string;
  theme: WebTheme;
  borderBright: string;
  fontSize: number;
  onClose: () => void;
}) {
  const ff = theme.fontFamily;
  const bg = hexToRgba(theme.backgroundColor, Math.min(1, theme.bgAlpha * 1.6));
  const border = hexAlpha(primaryColor, 0.3);
  // FULLY OPAQUE input/popover backgrounds. A semi-transparent input bg
  // (theme.inputAlpha can be ~0.53) lets the global body::after scanline gradient
  // show through the field, which reads as a horizontal "line through" the
  // text. Forcing alpha=1 on the modal's own inputs kills that artifact
  // without touching any other dashboard input.
  const opaqueInputBg = hexToRgba(theme.inputBgColor, 1);
  const opaquePopBg = hexToRgba(theme.backgroundColor, 1);
  const isPublic = !party.isPrivate;

  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<InviteSearchResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [notice, setNotice] = React.useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Selected user for the explicit SEND INVITATION button (top section).
  const [selectedUser, setSelectedUser] = React.useState<InviteSearchResult | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  // Public-invitation channel — SINGLE select (one channel per post). The cooldown
  // is global (applies across ALL channels), so only one target at a time.
  const [selectedChannelId, setSelectedChannelId] = React.useState<string>(
    channels[0]?.id ?? '',
  );
  const [channelMenuOpen, setChannelMenuOpen] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  // Cooldown countdown (ms remaining) — set when the server returns 429 with
  // retryAfterMs, ticks down to zero, then re-enables POST INVITATION.
  const [cooldownMs, setCooldownMs] = React.useState(0);

  React.useEffect(() => {
    if (cooldownMs <= 0) return;
    const t = setInterval(() => {
      setCooldownMs((ms) => Math.max(0, ms - 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [cooldownMs > 0]);

  // (idle auto-hide hold for this modal is handled centrally by the parent's
  // `anyOverlayUiOpen` effect via `inviteModalFor` — do NOT poke __fcmMenuOpen
  // here, or unmounting this child would clobber the flag while another modal
  // is still open.)

  // Debounced autocomplete against the backend.
  React.useEffect(() => {
    const term = q.trim();
    if (term.length === 0) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ results: InviteSearchResult[] }>(
          `/api/parties/${party.id}/invite-search?q=${encodeURIComponent(term)}`,
        );
        setResults(res?.results ?? []);
      } catch {
        setResults([]);
      } finally { setSearching(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [q, party.id]);

  // Pick a user from the autocomplete (selects; the send happens via the button).
  const selectUser = (r: InviteSearchResult) => {
    setSelectedUser(r);
    setQ(r.displayName);
    setResults([]);
    setNotice(null);
    // Keep focus in the search input while results show / after selection.
    searchInputRef.current?.focus();
  };

  const sendInvite = async () => {
    if (!selectedUser) return;
    setInviting(true); setNotice(null);
    try {
      await api.post(`/api/parties/${party.id}/invite`, { userId: selectedUser.userId });
      setNotice({ kind: 'ok', text: `Invited ${selectedUser.displayName}` });
      setSelectedUser(null);
      setQ('');
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message || 'Invite failed' });
    } finally { setInviting(false); }
  };

  const selectChannel = (id: string) => {
    setSelectedChannelId(id);
    setChannelMenuOpen(false);
  };

  const postPublic = async () => {
    if (!selectedChannelId) return;
    // Global cooldown: block (and explain) if they try to post to ANY channel
    // while the cooldown is active.
    if (cooldownMs > 0) {
      setNotice({ kind: 'err', text: `Cooldown active — you can post another invitation in ${cooldownLabel}.` });
      return;
    }
    setPosting(true); setNotice(null);
    try {
      await api.post(`/api/parties/${party.id}/invite-public`, { channelIds: [selectedChannelId] });
      setNotice({ kind: 'ok', text: 'Invitation posted' });
      // Optimistically start the 5-minute cooldown locally.
      setCooldownMs(5 * 60 * 1000);
    } catch (e: any) {
      // Surface the server 429 cooldown message and start the countdown from
      // the server-provided retryAfterMs when present.
      const retry = e?.data?.retryAfterMs;
      if (typeof retry === 'number' && retry > 0) setCooldownMs(retry);
      setNotice({ kind: 'err', text: e?.message || 'Could not post invitation' });
    } finally { setPosting(false); }
  };

  const cooldownLabel = (() => {
    if (cooldownMs <= 0) return '';
    const totalSec = Math.ceil(cooldownMs / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
  })();

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ background: bg, border: `1px solid ${border}`, fontFamily: ff, color: primaryColor, padding: '16px', width: '340px', maxWidth: '92vw' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ fontSize: '14px', fontWeight: 'bold', letterSpacing: '0.08em' }}>INVITE TO {(party.name || '').toUpperCase()}</div>
          <button onClick={onClose} style={{ minHeight: 0, boxSizing: 'border-box', background: 'none', border: 'none', color: hexAlpha(primaryColor, 0.6), cursor: 'pointer', fontSize: '14px', padding: 0, lineHeight: 1 }}>✕</button>
        </div>

        {/* Direct invite */}
        <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>INVITE A USER</div>
        {/* Anchor so the autocomplete popover sits directly under the input.
            NOTE: this Electron Chromium build computes `body { display: inline }`,
            so the popover + its rows need explicit display/flexDirection or they
            collapse inline/horizontal. */}
        <div style={{ position: 'relative', display: 'block' }}>
          <input
            ref={searchInputRef}
            value={q}
            onChange={e => { setQ(e.target.value); setSelectedUser(null); }}
            placeholder="Search by name…"
            autoFocus
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', background: opaqueInputBg, color: theme.textColor, border: `1px solid ${border}`, padding: '5px 8px', fontFamily: ff, fontSize: '12px', outline: 'none', textDecoration: 'none', backgroundImage: 'none', appearance: 'none' }}
          />
          {(searching || results.length > 0 || (q.trim().length > 0 && !selectedUser)) && (
            <div
              className="fcm-scrollbar"
              style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, display: 'flex', flexDirection: 'column', maxHeight: '180px', overflowY: 'auto', marginTop: '2px', background: opaquePopBg, border: `1px solid ${hexAlpha(primaryColor, 0.3)}` }}
            >
              {searching && results.length === 0 && (
                <div style={{ display: 'block', padding: '6px 8px', fontSize: '11px', opacity: 0.5 }}>Searching…</div>
              )}
              {!searching && q.trim().length > 0 && results.length === 0 && (
                <div style={{ display: 'block', padding: '6px 8px', fontSize: '11px', opacity: 0.5 }}>No users found.</div>
              )}
              {results.map(r => (
                <div key={r.userId}
                  onClick={() => selectUser(r)}
                  onMouseEnter={e => (e.currentTarget.style.background = hexAlpha(primaryColor, 0.1))}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', cursor: 'pointer' }}
                >
                  <Avatar avatarUrl={r.avatarUrl} name={r.displayName} size={Math.max(18, fontSize + 6)} primaryColor={primaryColor} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: primaryColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.displayName}</span>
                  <span style={{ fontSize: '10px', color: hexAlpha(primaryColor, 0.5) }}>select</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {selectedUser && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', fontSize: '11px', opacity: 0.85 }}>
            <span style={{ opacity: 0.6 }}>Selected:</span>
            <span style={{ color: primaryColor, fontWeight: 'bold' }}>{selectedUser.displayName}</span>
          </div>
        )}
        <button
          onClick={sendInvite}
          disabled={inviting || !selectedUser}
          style={{ minHeight: 0, boxSizing: 'border-box', width: '100%', height: '30px', marginTop: '8px', padding: '0 12px', fontSize: '11px', fontFamily: ff, fontWeight: 'bold', letterSpacing: '0.04em', background: !selectedUser ? hexAlpha(primaryColor, 0.06) : hexAlpha(primaryColor, 0.18), color: !selectedUser ? hexAlpha(primaryColor, 0.4) : primaryColor, border: `1px solid ${hexAlpha(primaryColor, !selectedUser ? 0.25 : 0.6)}`, cursor: (inviting || !selectedUser) ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
        >{inviting ? 'SENDING…' : 'SEND INVITATION'}</button>

        {/* Public invitation — public parties only. */}
        {isPublic ? (
          <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${hexAlpha(primaryColor, 0.15)}` }}>
            <div style={{ fontSize: '10px', letterSpacing: '0.08em', opacity: 0.7, marginBottom: '4px' }}>POST A PUBLIC INVITATION</div>
            {/* Single-select channel dropdown (Pip-Boy) — one channel per post. */}
            <div style={{ position: 'relative', display: 'block' }}>
              <button
                onClick={() => setChannelMenuOpen(o => !o)}
                style={{ minHeight: 0, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: '30px', padding: '0 8px', background: opaqueInputBg, color: theme.textColor, border: `1px solid ${border}`, fontFamily: ff, fontSize: '12px', cursor: 'pointer', textAlign: 'left' }}
              >
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {channels.find(c => c.id === selectedChannelId)?.name ?? 'Select a channel…'}
                </span>
                <span style={{ marginLeft: '6px', opacity: 0.6 }}>{channelMenuOpen ? '▲' : '▼'}</span>
              </button>
              {channelMenuOpen && (
                <div
                  className="fcm-scrollbar"
                  style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, display: 'flex', flexDirection: 'column', maxHeight: '180px', overflowY: 'auto', marginTop: '2px', background: opaquePopBg, border: `1px solid ${hexAlpha(primaryColor, 0.3)}` }}
                >
                  {channels.map(c => {
                    const selected = c.id === selectedChannelId;
                    return (
                      <div key={c.id}
                        onClick={() => selectChannel(c.id)}
                        onMouseEnter={e => (e.currentTarget.style.background = hexAlpha(primaryColor, 0.1))}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', cursor: 'pointer', fontSize: '12px' }}
                      >
                        {/* Radio dot — single selection. */}
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '14px', height: '14px', flex: '0 0 auto', borderRadius: '50%', border: `1px solid ${hexAlpha(primaryColor, 0.6)}`, background: 'transparent' }}>
                          {selected && <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: hexAlpha(primaryColor, 0.9) }} />}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, color: primaryColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              onClick={postPublic}
              disabled={posting || !selectedChannelId || cooldownMs > 0}
              style={{ minHeight: 0, boxSizing: 'border-box', width: '100%', height: '30px', marginTop: '8px', padding: '0 12px', fontSize: '11px', fontFamily: ff, fontWeight: 'bold', letterSpacing: '0.04em', background: (!selectedChannelId || cooldownMs > 0) ? hexAlpha(primaryColor, 0.06) : hexAlpha(primaryColor, 0.18), color: (!selectedChannelId || cooldownMs > 0) ? hexAlpha(primaryColor, 0.4) : primaryColor, border: `1px solid ${hexAlpha(primaryColor, (!selectedChannelId || cooldownMs > 0) ? 0.25 : 0.6)}`, cursor: (posting || !selectedChannelId || cooldownMs > 0) ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
            >{posting ? 'POSTING…' : cooldownMs > 0 ? `WAIT ${cooldownLabel}` : 'POST INVITATION'}</button>
            <div style={{ fontSize: '9px', opacity: 0.5, marginTop: '4px' }}>
              {cooldownMs > 0
                ? `Cooldown active — you can post another invitation (to any channel) in ${cooldownLabel}.`
                : 'Drops a joinable invite embed into the chosen channel. 5-minute cooldown between posts, across all channels.'}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${hexAlpha(primaryColor, 0.15)}`, fontSize: '10px', opacity: 0.5 }}>
            Private party — invite users directly above. Public invitations are disabled.
          </div>
        )}

        {notice && (
          <div style={{ marginTop: '12px', fontSize: '11px', color: notice.kind === 'ok' ? primaryColor : '#FF6060' }}>
            {notice.kind === 'ok' ? '✓ ' : '⚠ '}{notice.text}
          </div>
        )}
      </div>
    </div>
  );
}
