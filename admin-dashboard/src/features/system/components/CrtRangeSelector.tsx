/**
 * CRT / Pip-Boy themed segmented range toggle.
 * Renders as a horizontal row of monospace buttons in phosphor amber.
 */
import React from 'react';

export type StatsRange = 'all' | '90d' | '60d' | '30d' | '7d' | '1d';

const RANGE_OPTIONS: { value: StatsRange; label: string }[] = [
  { value: '1d',  label: '1D'  },
  { value: '7d',  label: '7D'  },
  { value: '30d', label: '30D' },
  { value: '60d', label: '60D' },
  { value: '90d', label: '90D' },
  { value: 'all', label: 'ALL' },
];

interface Props {
  value: StatsRange;
  onChange: (range: StatsRange) => void;
}

export default function CrtRangeSelector({ value, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Time range filter"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border-color)',
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {RANGE_OPTIONS.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            aria-label={`Range: ${opt.label}`}
            style={{
              padding: '4px 10px',
              fontSize: '10px',
              letterSpacing: '1px',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              border: 'none',
              borderLeft: i > 0 ? '1px solid var(--border-color)' : 'none',
              background: active ? 'var(--phosphor-dim)' : 'var(--bg-panel)',
              color: active ? 'var(--bg-dark)' : 'var(--text-muted)',
              fontWeight: active ? 'bold' : 'normal',
              boxShadow: active ? 'var(--glow-sm)' : 'none',
              transition: 'background 0.1s, color 0.1s',
              minHeight: '28px',
              outline: 'none',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
