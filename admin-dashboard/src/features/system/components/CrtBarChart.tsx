/**
 * CRT-themed SVG bar chart with Pip-Boy style LED-segment bars.
 * Each bar is rendered as stacked rectangles separated by thin dark gaps,
 * giving the classic phosphor dot-matrix / LED block appearance.
 */

import React, { useMemo, useId } from 'react';

export interface BarDataPoint {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  title: string;
  unit?: string;
  data: BarDataPoint[];
  /** Maximum bars visible before horizontal scroll */
  maxVisible?: number;
  /** Default bar color (uses phosphor amber) */
  defaultColor?: string;
  horizontal?: boolean;
}

const SEGMENT_H = 4;    // height of each LED segment block
const SEGMENT_GAP = 1;  // gap between segments
const SEGMENT_UNIT = SEGMENT_H + SEGMENT_GAP;

const W_VERT = 400;
const H_VERT = 140;
const PAD_VERT = { top: 10, right: 10, bottom: 36, left: 46 };

export default function CrtBarChart({
  title,
  unit,
  data,
  maxVisible = 20,
  defaultColor = 'var(--phosphor-color)',
  horizontal = false,
}: Props) {
  const filterId = useId().replace(/:/g, '_');
  const visible = data.slice(0, maxVisible);
  const maxVal = useMemo(() => Math.max(...visible.map(d => d.value), 1), [visible]);

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-color)',
    padding: '12px',
    position: 'relative',
    overflow: 'hidden',
  };

  const emptyStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '80px', fontSize: '11px', color: 'var(--text-muted)',
    letterSpacing: '2px', fontFamily: 'var(--font-mono)',
  };

  if (horizontal) {
    // Horizontal bar chart — each bar is a row
    const barH = 16;
    const gap = 4;
    const labelW = 90;
    const chartW = 260;
    const valColW = 50;
    const totalW = labelW + chartW + valColW;
    const totalH = Math.max(40, visible.length * (barH + gap) + 10);

    return (
      <div style={cardStyle}>
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,0,0,0.07) 3px, rgba(0,0,0,0.07) 4px)', zIndex: 1 }} />
        <div style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
          {title}
        </div>
        {!visible.length ? (
          <div style={emptyStyle}>NO DATA</div>
        ) : (
          <svg width="100%" height={totalH} viewBox={`0 0 ${totalW} ${totalH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
            <defs>
              <filter id={`glow-h-${filterId}`} x="-5%" y="-40%" width="110%" height="180%">
                <feGaussianBlur stdDeviation="1.5" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            {visible.map((d, i) => {
              const y = i * (barH + gap) + 4;
              const barW = (d.value / maxVal) * chartW;
              const segCount = Math.max(1, Math.floor(barW / (SEGMENT_H + SEGMENT_GAP)));
              const color = d.color ?? defaultColor;
              const segments = Array.from({ length: segCount });
              return (
                <g key={d.label}>
                  {/* Label */}
                  <text x={labelW - 6} y={y + barH / 2 + 4} fill="var(--text-secondary)" fontSize={9} textAnchor="end" fontFamily="var(--font-mono)">
                    {d.label.length > 10 ? d.label.slice(0, 9) + '…' : d.label}
                  </text>
                  {/* LED segments */}
                  <g filter={`url(#glow-h-${filterId})`}>
                    {segments.map((_, si) => (
                      <rect
                        key={si}
                        x={labelW + si * SEGMENT_UNIT}
                        y={y}
                        width={SEGMENT_H}
                        height={barH}
                        fill={color}
                        opacity={0.85 - si * (0.1 / Math.max(segCount, 1))}
                        rx={1}
                      />
                    ))}
                  </g>
                  {/* Value label */}
                  <text x={labelW + (d.value / maxVal) * chartW + 6} y={y + barH / 2 + 4} fill="var(--text-secondary)" fontSize={9} fontFamily="var(--font-mono)">
                    {d.value >= 1000 ? `${(d.value / 1000).toFixed(1)}k` : d.value}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    );
  }

  // Vertical bar chart
  const chartH = H_VERT - PAD_VERT.top - PAD_VERT.bottom;
  const chartW = W_VERT - PAD_VERT.left - PAD_VERT.right;
  const barW = Math.max(4, Math.floor(chartW / Math.max(visible.length, 1)) - 2);

  return (
    <div style={cardStyle}>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,0,0,0.07) 3px, rgba(0,0,0,0.07) 4px)', zIndex: 1 }} />
      <div style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
        {title}
        {unit && <span style={{ marginLeft: '6px', opacity: 0.6 }}>({unit})</span>}
      </div>
      {!visible.length ? (
        <div style={emptyStyle}>NO DATA</div>
      ) : (
        <svg width="100%" height={H_VERT} viewBox={`0 0 ${W_VERT} ${H_VERT}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <filter id={`glow-v-${filterId}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1.5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <clipPath id={`clip-v-${filterId}`}>
              <rect x={PAD_VERT.left} y={PAD_VERT.top} width={chartW} height={chartH} />
            </clipPath>
          </defs>

          {/* Y-axis grid + labels */}
          {[0, 0.25, 0.5, 0.75, 1].map((pct, ti) => {
            const val = pct * maxVal;
            const y = PAD_VERT.top + (1 - pct) * chartH;
            return (
              <g key={ti}>
                {Array.from({ length: Math.floor(chartW / 6) }).map((_, xi) => (
                  <circle key={xi} cx={PAD_VERT.left + xi * 6 + 3} cy={y} r={0.6} fill="rgba(212,176,64,0.12)" />
                ))}
                <text x={PAD_VERT.left - 4} y={y + 4} fill="var(--text-muted)" fontSize={8} textAnchor="end" fontFamily="var(--font-mono)">
                  {val >= 1000 ? `${(val / 1000).toFixed(1)}k` : Math.round(val)}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          <g clipPath={`url(#clip-v-${filterId})`} filter={`url(#glow-v-${filterId})`}>
            {visible.map((d, i) => {
              const barPxH = (d.value / maxVal) * chartH;
              const segCount = Math.max(1, Math.floor(barPxH / SEGMENT_UNIT));
              const color = d.color ?? defaultColor;
              const barX = PAD_VERT.left + i * (chartW / visible.length) + 1;
              const barY = PAD_VERT.top + chartH;
              return (
                <g key={d.label}>
                  {Array.from({ length: segCount }).map((_, si) => (
                    <rect
                      key={si}
                      x={barX}
                      y={barY - (si + 1) * SEGMENT_UNIT + SEGMENT_GAP}
                      width={barW}
                      height={SEGMENT_H}
                      fill={color}
                      opacity={0.85}
                      rx={1}
                    />
                  ))}
                </g>
              );
            })}
          </g>

          {/* X-axis labels */}
          {visible.map((d, i) => (
            <text
              key={d.label}
              x={PAD_VERT.left + i * (chartW / visible.length) + barW / 2 + 1}
              y={H_VERT - 4}
              fill="var(--text-muted)"
              fontSize={8}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              transform={visible.length > 8 ? `rotate(-35, ${PAD_VERT.left + i * (chartW / visible.length) + barW / 2 + 1}, ${H_VERT - 4})` : undefined}
            >
              {d.label.length > 8 ? d.label.slice(0, 7) + '…' : d.label}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}
