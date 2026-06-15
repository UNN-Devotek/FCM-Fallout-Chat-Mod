import React, { useCallback, useEffect, useRef, useState } from 'react';

interface GifResult {
  id: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

interface GifPickerProps {
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
  /** Optional style override (e.g. position:fixed anchor for in-frame clamping).
   *  Omitted on the website → the default above-right placement is unchanged. */
  style?: React.CSSProperties;
}

export default function GifPicker({
  primaryColor,
  chromeColor,
  inputBgColor,
  fontFamily,
  fontSize,
  hexAlpha,
  hexToRgba,
  onInsert,
  onClose,
  style: styleOverride,
}: GifPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef('');

  // Close on click-outside. Registered on the next tick so the opening mousedown
  // (the trigger uses onMouseDown) isn't caught here and doesn't instantly close
  // the picker — see the matching note in EmojiPicker.tsx.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [onClose]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const fetchGifs = useCallback(async (q: string, pos = '', append = false) => {
    if (!q.trim()) {
      setResults([]);
      setNextCursor('');
      setError(null);
      setNotConfigured(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (pos) params.set('pos', pos);
      const res = await fetch(`/api/tenor-search?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        if (json.error === 'tenor_not_configured') {
          setNotConfigured(true);
          setResults([]);
        } else {
          setError(json.message || 'Failed to load GIFs');
          setResults([]);
        }
        setLoading(false);
        return;
      }
      setNotConfigured(false);
      setError(null);
      setResults(prev => append ? [...prev, ...(json.data ?? [])] : (json.data ?? []));
      setNextCursor(json.next ?? '');
    } catch {
      setError('Failed to load GIFs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queryRef.current = query;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchGifs(query);
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, fetchGifs]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el || loading || !nextCursor) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      fetchGifs(queryRef.current, nextCursor, true);
    }
  }

  const panelBg     = hexToRgba(chromeColor, 0.96);
  const panelBorder = hexAlpha(primaryColor, 0.7);
  const scrollStyle = hexAlpha(primaryColor, 0.25);
  const dimColor    = hexAlpha(primaryColor, 0.45);

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
        animation: 'fcm-gp-pop 130ms cubic-bezier(0.16, 1, 0.3, 1)',
        transformOrigin: 'bottom right',
        willChange: 'transform, opacity',
        ...styleOverride,
      }}
    >
      <style style={{ display: 'none' }}>{`@keyframes fcm-gp-pop {
        from { opacity: 0; transform: translateY(6px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }`}</style>
      <div style={{ padding: '6px 8px', flexShrink: 0, borderBottom: `1px solid ${hexAlpha(primaryColor, 0.15)}` }}>
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search GIFs…"
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

      <style style={{ display: 'none' }}>{`
        .fcm-gp-scroll::-webkit-scrollbar { width: 4px; }
        .fcm-gp-scroll::-webkit-scrollbar-track { background: transparent; }
        .fcm-gp-scroll::-webkit-scrollbar-thumb { background: ${scrollStyle}; }
      `}</style>

      <div
        ref={scrollRef}
        className="fcm-gp-scroll"
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '4px' }}
      >
        {notConfigured && (
          <div style={{
            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: dimColor, fontSize: `${fontSize - 1}px`, textAlign: 'center', padding: '16px',
          }}>
            GIF search isn't configured yet.
          </div>
        )}
        {!notConfigured && error && (
          <div style={{
            padding: '16px', color: hexAlpha('#FF4444', 0.8),
            fontSize: `${fontSize - 2}px`, textAlign: 'center',
          }}>
            {error}
          </div>
        )}
        {!notConfigured && !error && results.length === 0 && !loading && query.trim() && (
          <div style={{
            padding: '16px', color: dimColor,
            fontSize: `${fontSize - 1}px`, textAlign: 'center',
          }}>
            No GIFs found.
          </div>
        )}
        {!notConfigured && !error && results.length === 0 && !loading && !query.trim() && (
          <div style={{
            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: dimColor, fontSize: `${fontSize - 1}px`, textAlign: 'center', padding: '16px',
          }}>
            Type to search for GIFs
          </div>
        )}
        {results.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {results.map(gif => (
              <div
                key={gif.id}
                onMouseDown={e => { e.preventDefault(); onInsert(gif.url); onClose(); }}
                style={{ cursor: 'pointer', overflow: 'hidden', borderRadius: 3, background: 'rgba(0,0,0,0.3)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.outline = `2px solid ${hexAlpha(primaryColor, 0.7)}`; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.outline = 'none'; }}
              >
                <img
                  src={gif.preview}
                  alt="gif"
                  loading="lazy"
                  style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
                />
              </div>
            ))}
          </div>
        )}
        {loading && (
          <div style={{ padding: '8px', color: dimColor, fontSize: `${fontSize - 2}px`, textAlign: 'center' }}>
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
