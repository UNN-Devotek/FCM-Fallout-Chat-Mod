import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import emojiData from '@emoji-mart/data';
import { api } from '../../services/api';

// ── Emoji-mart data types (subset we use) ────────────────────────────────────

interface EmojiMartSkin { unified: string; native: string }
interface EmojiMartEntry {
  id: string;
  name: string;
  keywords: string[];
  skins: EmojiMartSkin[];
}
interface EmojiMartCategory { id: string; emojis: string[] }
interface EmojiMartData {
  emojis: Record<string, EmojiMartEntry>;
  categories: EmojiMartCategory[];
}

const DATA = emojiData as EmojiMartData;
const CUSTOM_EMOJI_TOKEN_RE = /^<(a?):([A-Za-z0-9_]+):(\d{16,22})>$/;
export const RECENT_EMOJI_STORAGE_KEY = 'fcm-recent-emojis';
export const RECENT_EMOJI_LIMIT = 16;

const NATIVE_TO_ENTRY = new Map<string, EmojiMartEntry>();
for (const entry of Object.values(DATA.emojis)) {
  const native = entry.skins[0]?.native;
  if (native) NATIVE_TO_ENTRY.set(native, entry);
}

export function normalizeRecentEmojiTokens(value: unknown, maxCount = RECENT_EMOJI_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const token = raw.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxCount) break;
  }
  return out;
}

export function recordRecentEmoji(tokens: string[], token: string, maxCount = RECENT_EMOJI_LIMIT): string[] {
  const trimmed = token.trim();
  if (!trimmed) return normalizeRecentEmojiTokens(tokens, maxCount);
  return normalizeRecentEmojiTokens([trimmed, ...tokens.filter((t) => t !== trimmed)], maxCount);
}

// Matches a custom emoji token (<:name:id> / <a:name:id>) OR a native unicode
// emoji grapheme (a pictographic base + optional VS16, ZWJ-joined sequences,
// and a skin-tone modifier). Single combined pattern so we collect tokens in
// first-appearance order.
const EMOJI_OR_CUSTOM_GLOBAL_RE =
  /<a?:[A-Za-z0-9_]+:\d{16,22}>|\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*/gu;

/**
 * Extract emoji tokens (native unicode + custom <:name:id>) from a message in
 * first-appearance order, deduplicated. Native graphemes are only kept when
 * recognized by `isKnownNative` so we never record arbitrary pictographic glyphs
 * the picker can't render in its Recent row; the recorded token is the canonical
 * native string the picker stores (VS16 stripped when that is the known form).
 *
 * `isKnownNative` is injectable for testing; it defaults to the emoji-mart map.
 */
export function extractEmojiTokens(
  text: string,
  isKnownNative: (native: string) => boolean = (native) => NATIVE_TO_ENTRY.has(native),
): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (tok: string) => {
    if (tok && !seen.has(tok)) { seen.add(tok); out.push(tok); }
  };
  for (const match of text.matchAll(EMOJI_OR_CUSTOM_GLOBAL_RE)) {
    const raw = match[0];
    if (raw.startsWith('<')) { push(raw); continue; }
    if (isKnownNative(raw)) { push(raw); continue; }
    const stripped = raw.replace(/\uFE0F/g, '');
    if (stripped !== raw && isKnownNative(stripped)) push(stripped);
  }
  return out;
}

export function loadRecentEmojiTokens(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): string[] {
  if (!storage) return [];
  try {
    return normalizeRecentEmojiTokens(JSON.parse(storage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function saveRecentEmojiTokens(
  tokens: string[],
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(normalizeRecentEmojiTokens(tokens)));
  } catch {
    // Ignore storage failures; picker should still work in-memory.
  }
}

function parseCustomEmojiToken(token: string): { name: string; url: string } | null {
  const match = CUSTOM_EMOJI_TOKEN_RE.exec(token);
  if (!match) return null;
  const animated = match[1] === 'a';
  const name = match[2];
  const id = match[3];
  return {
    name,
    url: animated
      ? `https://cdn.discordapp.com/emojis/${id}.webp?animated=true`
      : `https://cdn.discordapp.com/emojis/${id}.png`,
  };
}

function recentEmojiMatchesQuery(token: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const custom = parseCustomEmojiToken(token);
  if (custom) return custom.name.toLowerCase().includes(q);

  const unicode = NATIVE_TO_ENTRY.get(token);
  if (!unicode) return token.toLowerCase().includes(q);
  return (
    unicode.name.toLowerCase().includes(q) ||
    unicode.id.toLowerCase().includes(q) ||
    unicode.keywords.some((k) => k.toLowerCase().includes(q))
  );
}

// Human-friendly category labels (Discord ordering)
const CAT_LABELS: Record<string, string> = {
  people:      'Smileys & People',
  nature:      'Animals & Nature',
  foods:       'Food & Drink',
  activity:    'Activities',
  places:      'Travel & Places',
  objects:     'Objects',
  symbols:     'Symbols',
  flags:       'Flags',
};

// ── Discord custom emoji type ─────────────────────────────────────────────────

interface DiscordEmoji {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface EmojiPickerProps {
  primaryColor: string;
  chromeColor: string;
  inputBgColor: string;
  fontFamily: string;
  fontSize: number;
  hexAlpha: (hex: string, alpha: number) => string;
  hexToRgba: (hex: string, alpha: number) => string;
  glowEnabled: boolean;
  onInsert: (token: string) => void;
  onClose: () => void;
  /** Optional style override. Default opens above-right of the trigger
   *  (chat overlay use case). Pass e.g. `{ position: 'fixed', top, left,
   *  bottom: 'auto', right: 'auto' }` to render via portal with explicit
   *  viewport coordinates. */
  style?: React.CSSProperties;
}

export default function EmojiPicker({
  primaryColor,
  chromeColor,
  inputBgColor,
  fontFamily,
  fontSize,
  hexAlpha,
  hexToRgba,
  glowEnabled,
  onInsert,
  onClose,
  style: styleOverride,
}: EmojiPickerProps) {
  const [query, setQuery] = useState('');
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => loadRecentEmojiTokens());
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on click-outside. Registered on the next tick so the mousedown that
  // opened the picker (trigger uses onMouseDown) doesn't immediately close it
  // as it bubbles — a real risk in the Electron renderer's event-dispatch order.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [onClose]);

  // Escape closes
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Auto-focus search
  useEffect(() => { searchRef.current?.focus(); }, []);

  // The grid is ~1500 cells — mounting it synchronously on open blocks the first
  // paint, so the picker appears to "lag" before showing. Defer it past first
  // paint (double rAF): the panel + search + pop-in animation render instantly,
  // then the grid fills in a frame later. Feels immediate.
  const [showGrid, setShowGrid] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setShowGrid(true)); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, []);

  // Fetch custom Discord emojis (5-min stale)
  const { data: discordEmojis } = useQuery<DiscordEmoji[]>({
    queryKey: ['discord-emojis'],
    queryFn: () => api.get<DiscordEmoji[]>('/api/discord-emojis'),
    staleTime: 5 * 60 * 1000,
  });

  // Build filtered Unicode sections
  const unicodeSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return DATA.categories.map(cat => {
      const entries = cat.emojis
        .map(id => DATA.emojis[id])
        .filter(Boolean)
        .filter(e => {
          if (!q) return true;
          return (
            e.name.toLowerCase().includes(q) ||
            e.id.toLowerCase().includes(q) ||
            e.keywords.some(k => k.toLowerCase().includes(q))
          );
        });
      return { id: cat.id, label: CAT_LABELS[cat.id] || cat.id, entries };
    }).filter(s => s.entries.length > 0);
  }, [query]);

  // Filtered Discord emojis
  const filteredDiscord = useMemo(() => {
    const all = discordEmojis ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(e => e.name.toLowerCase().includes(q));
  }, [discordEmojis, query]);

  const filteredRecent = useMemo(
    () => recentEmojis.filter((token) => recentEmojiMatchesQuery(token, query)),
    [recentEmojis, query],
  );

  // ── Theme helpers ─────────────────────────────────────────────────────────
  const panelBg      = hexToRgba(chromeColor, 0.96);
  const panelBorder  = hexAlpha(primaryColor, 0.7);
  const sectionHead  = hexAlpha(primaryColor, 0.55);
  const hoverBg      = hexAlpha(primaryColor, 0.15);
  const activeBg     = hexAlpha(primaryColor, 0.25);
  const scrollStyle  = hexAlpha(primaryColor, 0.25);

  const handleInsert = React.useCallback((token: string) => {
    setRecentEmojis(prev => {
      const next = recordRecentEmoji(prev, token);
      saveRecentEmojiTokens(next);
      return next;
    });
    onInsert(token);
    onClose();
  }, [onInsert, onClose]);

  // Pure-CSS hover/active so the ~1500-emoji grid does NOT re-render on every
  // mouse move (the prior hovered/pressed useState made every hover trigger a
  // full-grid re-render, which locked up the browser).
  const SectionHeading = React.useCallback(({ label, preserveCase = false }: { label: string; preserveCase?: boolean }) => (
    <div style={{
      padding: '6px 8px 2px',
      fontSize: '9px',
      fontFamily,
      color: sectionHead,
      letterSpacing: '0.1em',
      textTransform: preserveCase ? 'none' : 'uppercase',
      userSelect: 'none',
      fontWeight: 'bold',
    }}>
      {label}
    </div>
  ), [sectionHead, fontFamily]);

  const EmojiCell = React.useCallback(
    ({ id, title, onClick, children }: { id: string; title: string; onClick: () => void; children: React.ReactNode }) => (
      <div
        className="fcm-ep-cell"
        title={title}
        onMouseDown={e => { e.preventDefault(); onClick(); }}
        style={{
          width: 32, height: 32,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
          borderRadius: 3,
          background: 'transparent',
          flexShrink: 0,
        }}
      >
        {children}
      </div>
    ),
    [],
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        bottom: '100%',
        right: 0,
        width: 340,
        height: 360,
        zIndex: 200,
        background: panelBg,
        border: `1px solid ${panelBorder}`,
        display: 'flex',
        flexDirection: 'column',
        fontFamily,
        overflow: 'hidden',
        marginBottom: 4,
        // Smooth pop-in: scale + fade from the bottom-right (where it anchors).
        animation: 'fcm-ep-pop 130ms cubic-bezier(0.16, 1, 0.3, 1)',
        transformOrigin: 'bottom right',
        willChange: 'transform, opacity',
        ...styleOverride,
      }}
    >
      <style style={{ display: 'none' }}>{`@keyframes fcm-ep-pop {
        from { opacity: 0; transform: translateY(6px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }`}</style>
      {/* Search bar */}
      <div style={{ padding: '6px 8px', flexShrink: 0, borderBottom: `1px solid ${hexAlpha(primaryColor, 0.15)}` }}>
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search emoji…"
          style={{
            width: '100%',
            background: inputBgColor,
            border: `1px solid ${hexAlpha(primaryColor, 0.3)}`,
            color: primaryColor,
            fontFamily,
            fontSize: `${fontSize - 1}px`,
            padding: '3px 6px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Scrollable body */}
      <style style={{ display: 'none' }}>{`
        .fcm-ep-scroll::-webkit-scrollbar { width: 4px; }
        .fcm-ep-scroll::-webkit-scrollbar-track { background: transparent; }
        .fcm-ep-scroll::-webkit-scrollbar-thumb { background: ${scrollStyle}; }
        .fcm-ep-cell:hover  { background: ${hoverBg} !important; }
        .fcm-ep-cell:active { background: ${activeBg} !important; }
      `}</style>
      <div className="fcm-ep-scroll" style={{ flex: 1, overflowY: 'auto' }}>

        {/* The grid is deferred past first paint so the panel opens instantly. */}
        {!showGrid ? (
          <div style={{ padding: '10px 8px', fontSize: `${fontSize - 2}px`, color: hexAlpha(primaryColor, 0.4), fontFamily }}>
            Loading emoji…
          </div>
        ) : (
        <>
        {/* RECENT section */}
        {filteredRecent.length > 0 && (
          <>
            <SectionHeading label="Recent" preserveCase />
            <div style={{ display: 'flex', flexWrap: 'wrap', padding: '0 4px 4px' }}>
              {filteredRecent.map(token => {
                const custom = parseCustomEmojiToken(token);
                return (
                  <EmojiCell
                    key={`recent-${token}`}
                    id={`recent-${token}`}
                    title={custom ? `:${custom.name}:` : token}
                    onClick={() => { handleInsert(token); }}
                  >
                    {custom ? (
                      <img src={custom.url} alt={`:${custom.name}:`} loading="lazy"
                        style={{ width: 24, height: 24, objectFit: 'contain' }} />
                    ) : (
                      <span style={{ fontSize: 20, lineHeight: '32px', userSelect: 'none' }}>{token}</span>
                    )}
                  </EmojiCell>
                );
              })}
            </div>
          </>
        )}
        {/* YOUR SERVER section */}
        <SectionHeading label="Your Server" />
        {filteredDiscord.length === 0 ? (
          <div style={{ padding: '4px 8px 8px', fontSize: `${fontSize - 2}px`, color: hexAlpha(primaryColor, 0.4), fontFamily }}>
            No custom emojis
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', padding: '0 4px 4px' }}>
            {filteredDiscord
              .sort((a, b) => Number(b.animated) - Number(a.animated) || a.name.localeCompare(b.name))
              .map(e => (
                <EmojiCell
                  key={e.id}
                  id={`d-${e.id}`}
                  title={`:${e.name}:`}
                  onClick={() => { handleInsert(e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`); }}
                >
                  <img src={e.url} alt={`:${e.name}:`} loading="lazy"
                    style={{ width: 24, height: 24, objectFit: 'contain' }} />
                </EmojiCell>
              ))}
          </div>
        )}

        {/* Unicode sections */}
        {unicodeSections.map(sec => (
          <React.Fragment key={sec.id}>
            <SectionHeading label={sec.label} />
            <div style={{ display: 'flex', flexWrap: 'wrap', padding: '0 4px 4px' }}>
              {sec.entries.map(e => {
                const native = e.skins[0]?.native ?? '';
                return (
                  <EmojiCell
                    key={e.id}
                    id={`u-${e.id}`}
                    title={`:${e.id}:`}
                    onClick={() => { handleInsert(native); }}
                  >
                    <span style={{ fontSize: 20, lineHeight: '32px', userSelect: 'none' }}>{native}</span>
                  </EmojiCell>
                );
              })}
            </div>
          </React.Fragment>
        ))}
        </>
        )}
      </div>
    </div>
  );
}
