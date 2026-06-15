import React, { useCallback, useEffect, useRef, useState } from 'react';

interface MentionSuggestion { displayName: string; }

interface Props {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  maxLength?: number;
  rows?: number;
  multiLine?: boolean;
}

const gold = '#C8A840';
const goldDim = 'rgba(200,168,64,0.5)';
const goldFaint = 'rgba(200,168,64,0.12)';
const bg = '#1e1908';

// Detect @word at the cursor position (the word being typed after @)
function getMentionAt(text: string, cursor: number): { query: string; atStart: number } | null {
  const before = text.slice(0, cursor);
  const match = before.match(/(?:^|[\s,])@(\w{0,32})$/);
  if (!match) return null;
  const atStart = before.lastIndexOf('@');
  return { query: match[1], atStart };
}

// Replace the @query at atStart with @displayName + space
function applyMention(text: string, atStart: number, query: string, displayName: string): string {
  return text.slice(0, atStart) + '@' + displayName + ' ' + text.slice(atStart + 1 + query.length);
}

export default function MentionInput({ value, onChange, placeholder, style, maxLength = 500, rows = 1, multiLine = false }: Props) {
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [currentMention, setCurrentMention] = useState<{ query: string; atStart: number } | null>(null);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // SR-006: per-instance timer ref — avoids clobbering sibling components
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length === 0) { setSuggestions([]); setPopoverOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/mention-search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const json = await res.json();
        const list: MentionSuggestion[] = (json.data ?? []).slice(0, 4);
        setSuggestions(list);
        setPopoverOpen(list.length > 0);
        setSelectedIdx(0);
      } catch { /* non-critical */ }
    }, 180);
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const newVal = e.target.value;
    const cursor = e.target.selectionStart ?? newVal.length;
    onChange(newVal.slice(0, maxLength));
    const mention = getMentionAt(newVal, cursor);
    setCurrentMention(mention);
    if (mention) fetchSuggestions(mention.query);
    else { setSuggestions([]); setPopoverOpen(false); }
  }

  function selectSuggestion(s: MentionSuggestion) {
    if (!currentMention) return;
    const cursor = inputRef.current?.selectionStart ?? value.length;
    // Recompute from current cursor in case value changed since popover opened
    const mention = getMentionAt(value, cursor) ?? currentMention;
    const next = applyMention(value, mention.atStart, mention.query, s.displayName);
    onChange(next.slice(0, maxLength));
    setPopoverOpen(false);
    setSuggestions([]);
    setCurrentMention(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!popoverOpen || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => (i + 1) % suggestions.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => (i - 1 + suggestions.length) % suggestions.length); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectSuggestion(suggestions[selectedIdx]); return; }
    if (e.key === 'Escape') { e.preventDefault(); setPopoverOpen(false); return; }
  }

  // SR-010: cancel debounce on unmount to prevent setState on unmounted component
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setPopoverOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const baseStyle: React.CSSProperties = {
    width: '100%',
    background: goldFaint,
    border: `1px solid rgba(200,168,64,0.35)`,
    color: gold,
    padding: '8px 12px',
    fontSize: '13px',
    fontFamily: 'Courier New, monospace',
    outline: 'none',
    boxSizing: 'border-box',
    ...style,
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {multiLine ? (
        <textarea
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={rows}
          maxLength={maxLength}
          style={{ ...baseStyle, resize: 'vertical' }}
        />
      ) : (
        <input
          ref={inputRef as React.Ref<HTMLInputElement>}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          maxLength={maxLength}
          style={baseStyle}
        />
      )}

      {popoverOpen && suggestions.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: 0,
          right: 0,
          zIndex: 200,
          background: bg,
          border: `1px solid ${gold}`,
          borderBottom: 'none',
          fontFamily: 'Courier New, monospace',
        }}>
          {suggestions.map((s, idx) => (
            <div
              key={s.displayName}
              onMouseDown={e => { e.preventDefault(); selectSuggestion(s); }}
              onMouseEnter={() => setSelectedIdx(idx)}
              style={{
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: '12px',
                color: idx === selectedIdx ? gold : goldDim,
                background: idx === selectedIdx ? 'rgba(200,168,64,0.12)' : 'transparent',
                borderLeft: idx === selectedIdx ? `2px solid ${gold}` : '2px solid transparent',
                boxSizing: 'border-box',
                letterSpacing: '1px',
              }}
            >
              @{s.displayName}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
