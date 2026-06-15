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

  // ── Theme helpers ─────────────────────────────────────────────────────────
  const panelBg      = hexToRgba(chromeColor, 0.96);
  const panelBorder  = hexAlpha(primaryColor, 0.7);
  const sectionHead  = hexAlpha(primaryColor, 0.55);
  const hoverBg      = hexAlpha(primaryColor, 0.15);
  const activeBg     = hexAlpha(primaryColor, 0.25);
  const scrollStyle  = hexAlpha(primaryColor, 0.25);

  // Pure-CSS hover/active so the ~1500-emoji grid does NOT re-render on every
  // mouse move (the prior hovered/pressed useState made every hover trigger a
  // full-grid re-render, which locked up the browser).
  const SectionHeading = React.useCallback(({ label }: { label: string }) => (
    <div style={{
      padding: '6px 8px 2px',
      fontSize: '9px',
      fontFamily,
      color: sectionHead,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
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
                  onClick={() => { onInsert(e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`); onClose(); }}
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
                    onClick={() => { onInsert(native); onClose(); }}
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
