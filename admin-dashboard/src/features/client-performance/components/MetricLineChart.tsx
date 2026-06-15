/**
 * Lightweight SVG line chart for p50/p90/p99 metric timeseries.
 * Avoids pulling a new charting library — uses inline SVG polyline.
 */

import React, { useMemo } from 'react';
import type { TimeBucket, Percentiles } from '../hooks/useClientMetrics';

interface Props {
  title: string;
  unit: string;
  buckets: TimeBucket[];
  accessor: (b: TimeBucket) => Percentiles;
  /** Friendly label for the X axis time. */
  window: string;
}

const W = 340;
const H = 120;
const PAD = { top: 8, right: 8, bottom: 28, left: 44 };

const COLORS = {
  p50: '#18FF62',
  p90: '#d4b040',
  p99: '#ff6644',
};

function scaleX(i: number, n: number) {
  if (n <= 1) return PAD.left + (W - PAD.left - PAD.right) / 2;
  return PAD.left + ((i / (n - 1)) * (W - PAD.left - PAD.right));
}

function scaleY(v: number, min: number, max: number) {
  const range = max - min || 1;
  const pct = (v - min) / range;
  return PAD.top + (1 - pct) * (H - PAD.top - PAD.bottom);
}

function buildPoints(
  values: (number | null)[],
  min: number,
  max: number,
): string {
  return values
    .map((v, i) =>
      v != null
        ? `${scaleX(i, values.length).toFixed(1)},${scaleY(v, min, max).toFixed(1)}`
        : null,
    )
    .filter(Boolean)
    .join(' ');
}

function formatLabel(iso: string, window: string): string {
  try {
    const d = new Date(iso);
    if (window === '1h' || window === '24h') {
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function MetricLineChart({ title, unit, buckets, accessor, window }: Props) {
  const { p50s, p90s, p99s, yMin, yMax } = useMemo(() => {
    const p50s = buckets.map(b => accessor(b).p50);
    const p90s = buckets.map(b => accessor(b).p90);
    const p99s = buckets.map(b => accessor(b).p99);
    const all = [...p50s, ...p90s, ...p99s].filter((v): v is number => v != null);
    const yMin = all.length ? Math.max(0, Math.min(...all) * 0.9) : 0;
    const yMax = all.length ? Math.max(...all) * 1.1 : 10;
    return { p50s, p90s, p99s, yMin, yMax };
  }, [buckets, accessor]);

  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '4px',
    padding: '12px',
  };

  const emptyStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: `${H}px`,
    fontSize: '11px',
    color: 'rgba(255,255,255,0.25)',
    letterSpacing: '1px',
  };

  // X-axis label indices (at most 6 labels to avoid crowding)
  const labelIndices = useMemo(() => {
    if (!buckets.length) return [];
    const step = Math.max(1, Math.ceil(buckets.length / 6));
    const idxs: number[] = [];
    for (let i = 0; i < buckets.length; i += step) idxs.push(i);
    if (idxs[idxs.length - 1] !== buckets.length - 1) idxs.push(buckets.length - 1);
    return idxs;
  }, [buckets]);

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: '11px', letterSpacing: '2px', color: 'rgba(255,255,255,0.5)', marginBottom: '6px', textTransform: 'uppercase' }}>
        {title}
      </div>

      {buckets.length === 0 ? (
        <div style={emptyStyle}>NO DATA</div>
      ) : (
        <>
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            style={{ display: 'block', maxWidth: '100%' }}
          >
            {/* Y-axis labels */}
            {[0, 0.5, 1].map(pct => {
              const val = yMin + pct * (yMax - yMin);
              const y = scaleY(val, yMin, yMax);
              return (
                <g key={pct}>
                  <line
                    x1={PAD.left}
                    y1={y}
                    x2={W - PAD.right}
                    y2={y}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth={1}
                  />
                  <text
                    x={PAD.left - 4}
                    y={y + 4}
                    fill="rgba(255,255,255,0.3)"
                    fontSize={9}
                    textAnchor="end"
                    fontFamily="monospace"
                  >
                    {val >= 100 ? Math.round(val) : val.toFixed(1)}
                  </text>
                </g>
              );
            })}

            {/* X-axis labels */}
            {labelIndices.map(i => (
              <text
                key={i}
                x={scaleX(i, buckets.length)}
                y={H - 4}
                fill="rgba(255,255,255,0.3)"
                fontSize={8}
                textAnchor="middle"
                fontFamily="monospace"
              >
                {formatLabel(buckets[i].tStart, window)}
              </text>
            ))}

            {/* p99 line */}
            <polyline
              points={buildPoints(p99s, yMin, yMax)}
              fill="none"
              stroke={COLORS.p99}
              strokeWidth={1.5}
              strokeOpacity={0.6}
              strokeDasharray="4 2"
            />
            {/* p90 line */}
            <polyline
              points={buildPoints(p90s, yMin, yMax)}
              fill="none"
              stroke={COLORS.p90}
              strokeWidth={1.5}
              strokeOpacity={0.75}
            />
            {/* p50 line */}
            <polyline
              points={buildPoints(p50s, yMin, yMax)}
              fill="none"
              stroke={COLORS.p50}
              strokeWidth={2}
              strokeOpacity={0.9}
            />
          </svg>

          {/* Legend */}
          <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
            {(['p50', 'p90', 'p99'] as const).map(k => (
              <span
                key={k}
                style={{
                  fontSize: '9px',
                  letterSpacing: '1px',
                  color: COLORS[k],
                  opacity: 0.85,
                  fontFamily: 'monospace',
                }}
              >
                — {k.toUpperCase()}
              </span>
            ))}
            <span style={{ fontSize: '9px', letterSpacing: '1px', color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', marginLeft: 'auto' }}>
              {unit}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
