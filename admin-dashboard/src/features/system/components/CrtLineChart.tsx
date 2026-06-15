/**
 * CRT-themed SVG line chart with phosphor glow, oscilloscope grid, and
 * sweep-in reveal animation. Supports 1–3 data series.
 *
 * Optional dual-axis mode: pass `rightAxisSeries` to plot a second group of
 * series against an independent right-hand Y axis (e.g. cumulative users on the
 * left axis, daily-peak online on the right). When omitted the chart behaves
 * exactly as the original single-axis chart (used by ServerHealth).
 */

import React, { useMemo, useId, useState, useRef, useEffect } from 'react';

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  unit?: string;
  buckets: string[];    // ISO bucket timestamps
  series: LineSeries[];
  bucketSize?: 'hour' | 'day';
  /** Render the bottom legend row. Default true (System page). LandingPage sets
   *  false to give the plotted area maximum room. */
  showLegend?: boolean;
  /** Opt-in dual-axis: series plotted against an independent RIGHT Y axis.
   *  Default undefined = original single-axis behaviour (ServerHealth). */
  rightAxisSeries?: LineSeries[];
  /** Color for the right-axis ticks/title (defaults to the first right series). */
  rightAxisColor?: string;
  /** Color for the left-axis ticks (defaults to --text-muted). */
  leftAxisColor?: string;
  /** Enlarge the hover tooltip (bigger fonts/padding) — for big hero charts. */
  largeTooltip?: boolean;
  /** Full-bleed hero mode: minimal card padding + a taller viewBox so the chart
   *  spans the card edge-to-edge and fills tall containers vertically. Default
   *  off = original geometry (ServerHealth). */
  fullBleed?: boolean;
}

const W = 400;

function formatLabel(iso: string, bucketSize: 'hour' | 'day'): string {
  try {
    const d = new Date(iso);
    if (bucketSize === 'hour') {
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function formatTooltipLabel(iso: string, bucketSize: 'hour' | 'day'): string {
  try {
    const d = new Date(iso);
    if (bucketSize === 'hour') {
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function fmtNum(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

function fmtTick(val: number): string {
  return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val >= 100 ? String(Math.round(val)) : val.toFixed(0);
}

function rangeFor(series: LineSeries[]): { yMin: number; yMax: number } {
  const all = series.flatMap(s => s.values).filter((v): v is number => v != null);
  if (!all.length) return { yMin: 0, yMax: 10 };
  return {
    yMin: Math.max(0, Math.min(...all) * 0.9),
    yMax: Math.max(...all) * 1.1 || 1,
  };
}

// ── CRT glitch animation library ────────────────────────────────────────────
// Each plotted line (fullBleed/landing only) independently picks one of these
// variants when it fires its (own, unsynced) glitch timer. Pure SVG/CSS.
type GlitchVariant = 'rgb' | 'jitter' | 'flicker' | 'wave' | 'dropout';
const GLITCH_VARIANTS: GlitchVariant[] = ['rgb', 'jitter', 'flicker', 'wave', 'dropout'];

/**
 * GlitchLine — renders ONE series' path with its own glitch state, timer and
 * filter ids. Two+ instances never collide because every id is suffixed with
 * `uid` (series key). When `enabled` is false (System page) it renders a plain
 * static line with no timers, no filters — identical to the original output.
 */
function GlitchLine({
  uid, d, color, glowFilter, enabled,
}: {
  uid: string;
  d: string;
  color: string;
  glowFilter: string;   // shared phosphor-glow filter id ref, e.g. url(#glow-..)
  enabled: boolean;
}) {
  const [state, setState] = useState<{ on: boolean; variant: GlitchVariant }>({ on: false, variant: 'rgb' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let onTimer: ReturnType<typeof setTimeout>;
    let offTimer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // Independent 4–8s cadence per line (random offset keeps them unsynced).
      const wait = 4000 + Math.random() * 4000;
      onTimer = setTimeout(() => {
        if (cancelled) return;
        const variant = GLITCH_VARIANTS[Math.floor(Math.random() * GLITCH_VARIANTS.length)];
        setState({ on: true, variant });
        // Duration: ~150–300ms.
        offTimer = setTimeout(() => {
          if (cancelled) return;
          setState(s => ({ ...s, on: false }));
          schedule();
        }, 150 + Math.random() * 150);
      }, wait);
    };
    schedule();
    return () => { cancelled = true; clearTimeout(onTimer); clearTimeout(offTimer); };
  }, [enabled]);

  const dispId = `disp-${uid}`;
  const waveId = `wave-${uid}`;
  const on = enabled && state.on;
  const v = state.variant;

  // Per-variant visual params.
  const useDisplace = on && v === 'jitter';
  const useWave = on && v === 'wave';
  const showRgb = on && v === 'rgb';
  // flicker: brief brightness dropout on the main line.
  const flickerOpacity = on && v === 'flicker' ? 0.28 : 0.9;
  // dropout: thin the line + drop opacity to mimic a signal/scanline dropout.
  const dropout = on && v === 'dropout';
  const mainOpacity = dropout ? 0.35 : flickerOpacity;
  const mainWidth = dropout ? 0.7 : 1.5;

  return (
    <g>
      <defs>
        {/* jitter — turbulence-driven horizontal displacement */}
        <filter id={dispId} x="-12%" y="-12%" width="124%" height="124%">
          <feTurbulence type="turbulence" baseFrequency="0.0002 0.22" numOctaves={1} seed={3} result="n">
            {useDisplace && <animate attributeName="seed" values="1;8;3;10" dur="0.18s" repeatCount="indefinite" />}
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="n" scale={useDisplace ? 7 : 0} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* wave — low-freq vertical wobble (wavy signal distortion) */}
        <filter id={waveId} x="-12%" y="-12%" width="124%" height="124%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.04" numOctaves={2} seed={5} result="n">
            {useWave && <animate attributeName="baseFrequency" values="0.012 0.03;0.02 0.06;0.012 0.03" dur="0.3s" repeatCount="indefinite" />}
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="n" scale={useWave ? 5 : 0} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>

      <g filter={useDisplace ? `url(#${dispId})` : useWave ? `url(#${waveId})` : glowFilter}>
        {/* RGB chromatic split — red/cyan ghosts offset horizontally */}
        {showRgb && (
          <>
            <path d={d} fill="none" stroke="#ff2d55" strokeWidth={1.5} strokeOpacity={0.55} transform="translate(-2.4,0)" />
            <path d={d} fill="none" stroke="#19f0ff" strokeWidth={1.5} strokeOpacity={0.55} transform="translate(2.4,0)" />
          </>
        )}
        {/* Phosphor ghost/glow underlay */}
        <path d={d} fill="none" stroke={color} strokeWidth={3} strokeOpacity={dropout ? 0.08 : 0.2} />
        {/* Main line */}
        <path d={d} fill="none" stroke={color} strokeWidth={mainWidth} strokeOpacity={mainOpacity}>
          <animate attributeName="stroke-dashoffset" from={W * 3} to={0} dur="0.8s" fill="freeze" />
          <animate attributeName="stroke-dasharray" from={`0 ${W * 3}`} to={`${W * 3} 0`} dur="0.8s" fill="freeze" />
        </path>
      </g>
    </g>
  );
}

export default function CrtLineChart({
  title, unit, buckets, series, bucketSize = 'day', showLegend = true,
  rightAxisSeries, rightAxisColor, leftAxisColor, largeTooltip = false,
  fullBleed = false,
}: Props) {
  const filterId = useId().replace(/:/g, '_');
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Index of the data point currently hovered (null = no hover).
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const dualAxis = !!(rightAxisSeries && rightAxisSeries.length > 0);

  // Full-bleed hero charts use a taller viewBox so the meet-scaled SVG fills a
  // tall card vertically (default keeps the original 130 aspect for ServerHealth).
  const H = fullBleed ? 230 : 130;

  // Geometry — widen the right padding when a right axis is present.
  const PAD = useMemo(() => ({
    top: 10,
    right: dualAxis ? 46 : 10,
    bottom: 30,
    left: 46,
  }), [dualAxis]);
  const CHART_W = W - PAD.left - PAD.right;
  const CHART_H = H - PAD.top - PAD.bottom;

  const scaleX = useMemo(() => (i: number, n: number): number => {
    if (n <= 1) return PAD.left + CHART_W / 2;
    return PAD.left + (i / (n - 1)) * CHART_W;
  }, [PAD.left, CHART_W]);

  const scaleY = useMemo(() => (v: number, yMin: number, yMax: number): number => {
    const range = yMax - yMin || 1;
    return PAD.top + (1 - (v - yMin) / range) * CHART_H;
  }, [PAD.top, CHART_H]);

  function buildPath(values: (number | null)[], yMin: number, yMax: number, n: number): string {
    let path = '';
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      const x = scaleX(i, n).toFixed(1);
      const y = scaleY(v, yMin, yMax).toFixed(1);
      path += path === '' ? `M${x},${y}` : ` L${x},${y}`;
    }
    return path;
  }

  const leftRange = useMemo(() => rangeFor(series), [series]);
  const rightRange = useMemo(() => rangeFor(rightAxisSeries ?? []), [rightAxisSeries]);

  const n = buckets.length;

  // X-axis label indices — at most 6
  const labelIndices = useMemo(() => {
    if (!n) return [];
    const step = Math.max(1, Math.ceil(n / 6));
    const idxs: number[] = [];
    for (let i = 0; i < n; i += step) idxs.push(i);
    if (n > 0 && idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1);
    return idxs;
  }, [n]);

  const leftTicks = [0, 0.25, 0.5, 0.75, 1].map(pct => leftRange.yMin + pct * (leftRange.yMax - leftRange.yMin));
  const rightTicks = [0, 0.25, 0.5, 0.75, 1].map(pct => rightRange.yMin + pct * (rightRange.yMax - rightRange.yMin));

  const cardStyle: React.CSSProperties = {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-color)',
    // Full-bleed: minimal padding so the plot spans the card edge-to-edge
    // (the SVG's own PAD.left/right reserve space for axis labels).
    padding: fullBleed ? '8px 2px 2px' : '12px',
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  };

  const emptyStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: `${H}px`, fontSize: '11px', color: 'var(--text-muted)',
    letterSpacing: '2px', fontFamily: 'var(--font-mono)',
  };

  const allSeries = dualAxis ? [...series, ...rightAxisSeries!] : series;
  const hasData = allSeries.some(s => s.values.some(v => v != null));

  const rAxisColor = rightAxisColor ?? rightAxisSeries?.[0]?.color ?? '#18c96a';

  // Map a pointer event to the nearest data-point index (in viewBox space).
  function snapToNearest(clientX: number): number {
    const svg = svgRef.current;
    if (!svg || n === 0) return 0;
    const rect = svg.getBoundingClientRect();
    const vbX = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const dist = Math.abs(scaleX(i, n) - vbX);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }

  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    setHoverIdx(snapToNearest(e.clientX));
  }

  function handleDown(e: React.PointerEvent<SVGSVGElement>) {
    // On touch, a tap (no drag) doesn't fire pointerMove — handle it here.
    setHoverIdx(snapToNearest(e.clientX));
  }

  const hoverX = hoverIdx != null ? scaleX(hoverIdx, n) : 0;

  // Tooltip entries pair each series with the axis range it is drawn against,
  // so the hover marker sits on the correct line.
  type HoverEntry = { s: LineSeries; v: number; range: { yMin: number; yMax: number } };
  const hoverEntries: HoverEntry[] = hoverIdx != null
    ? [
        ...series.map(s => ({ s, v: s.values[hoverIdx], range: leftRange })),
        ...(dualAxis ? rightAxisSeries!.map(s => ({ s, v: s.values[hoverIdx], range: rightRange })) : []),
      ].filter((e): e is HoverEntry => e.v != null)
    : [];

  return (
    <div style={cardStyle}>
      {/* Per-chart scanline overlay */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,0,0,0.07) 3px, rgba(0,0,0,0.07) 4px)',
        zIndex: 1,
      }} />

      <div style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', textAlign: fullBleed ? 'center' : 'left' }}>
        {title}
        {unit && <span style={{ marginLeft: '6px', opacity: 0.6 }}>({unit})</span>}
      </div>

      {!hasData ? (
        <div style={emptyStyle}>NO DATA</div>
      ) : (
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: 'block', overflow: 'visible', flex: 1, minHeight: 0 }}
          onPointerMove={handleMove}
          onPointerDown={handleDown}
          onPointerLeave={(e) => { if (e.pointerType !== 'touch') setHoverIdx(null); }}
        >
          <defs>
            {/* Phosphor glow filter */}
            <filter id={`glow-${filterId}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            {/* Clip path to keep lines inside chart area */}
            <clipPath id={`clip-${filterId}`}>
              <rect x={PAD.left} y={PAD.top} width={CHART_W} height={CHART_H} />
            </clipPath>
          </defs>

          {/* Dotted grid + LEFT axis labels */}
          {leftTicks.map((val, ti) => {
            const y = scaleY(val, leftRange.yMin, leftRange.yMax);
            return (
              <g key={ti}>
                {Array.from({ length: Math.floor(CHART_W / 6) }).map((_, xi) => (
                  <circle
                    key={xi}
                    cx={PAD.left + xi * 6 + 3}
                    cy={y}
                    r={0.6}
                    fill="rgba(212,176,64,0.15)"
                  />
                ))}
                <text
                  x={PAD.left - 4}
                  y={y + 4}
                  fill={leftAxisColor ?? 'var(--text-muted)'}
                  fontSize={8}
                  textAnchor="end"
                  fontFamily="var(--font-mono)"
                >
                  {fmtTick(val)}
                </text>
              </g>
            );
          })}

          {/* RIGHT axis labels (dual-axis only) */}
          {dualAxis && rightTicks.map((val, ti) => {
            const y = scaleY(val, rightRange.yMin, rightRange.yMax);
            return (
              <text
                key={`r-${ti}`}
                x={PAD.left + CHART_W + 4}
                y={y + 4}
                fill={rAxisColor}
                fontSize={8}
                textAnchor="start"
                fontFamily="var(--font-mono)"
              >
                {fmtTick(val)}
              </text>
            );
          })}

          {/* X-axis labels */}
          {labelIndices.map(i => (
            <text
              key={i}
              x={scaleX(i, n)}
              y={H - 4}
              fill="var(--text-muted)"
              fontSize={8}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
            >
              {formatLabel(buckets[i], bucketSize)}
            </text>
          ))}

          {/* Series lines — each line owns its independent glitch (fullBleed). */}
          <g clipPath={`url(#clip-${filterId})`}>
            {[
              ...series.map(s => ({ s, range: leftRange })),
              ...(dualAxis ? rightAxisSeries!.map(s => ({ s, range: rightRange })) : []),
            ].map(({ s, range }) => {
              const d = buildPath(s.values, range.yMin, range.yMax, n);
              if (!d) return null;
              return (
                <GlitchLine
                  key={s.key}
                  uid={`${filterId}-${s.key}`}
                  d={d}
                  color={s.color}
                  glowFilter={`url(#glow-${filterId})`}
                  enabled={fullBleed}
                />
              );
            })}
          </g>

          {/* Hover crosshair + point markers */}
          {hoverIdx != null && hoverEntries.length > 0 && (
            <g pointerEvents="none">
              <line
                x1={hoverX} y1={PAD.top} x2={hoverX} y2={PAD.top + CHART_H}
                stroke="var(--phosphor-color, #C8A840)" strokeOpacity={0.35} strokeWidth={1}
                strokeDasharray="2 2"
              />
              {hoverEntries.map(({ s, v, range }) => (
                <circle
                  key={s.key}
                  cx={hoverX}
                  cy={scaleY(v, range.yMin, range.yMax)}
                  r={3}
                  fill={s.color}
                  stroke="var(--bg-panel, #1e1908)"
                  strokeWidth={1}
                  filter={`url(#glow-${filterId})`}
                />
              ))}
            </g>
          )}

          {/* Tooltip box */}
          {hoverIdx != null && hoverEntries.length > 0 && (() => {
            // Larger tooltip geometry for big hero charts.
            const dateFs = largeTooltip ? 12 : 7;
            const valFs = largeTooltip ? 14 : 8;
            const padX = largeTooltip ? 12 : 5;
            const padY = largeTooltip ? 8 : 4;
            const lineH = largeTooltip ? 20 : 11;
            const headH = largeTooltip ? 22 : 10;
            const boxW = largeTooltip ? 200 : 92;
            const boxH = headH + padY + hoverEntries.length * lineH + padY;
            // Flip the box to the left of the crosshair when near the right edge.
            const flip = hoverX + boxW + 8 > W;
            const bx = flip ? hoverX - boxW - 6 : hoverX + 6;
            const by = PAD.top + 2;
            return (
              <g pointerEvents="none">
                <rect
                  x={bx} y={by} width={boxW} height={boxH} rx={3}
                  fill="rgba(15,13,4,0.94)"
                  stroke="var(--phosphor-color, #C8A840)" strokeOpacity={0.55} strokeWidth={0.9}
                />
                <text
                  x={bx + padX} y={by + headH}
                  fill="var(--text-muted, rgba(200,168,64,0.7))" fontSize={dateFs} fontFamily="var(--font-mono)"
                  letterSpacing="0.5" fontWeight="bold"
                >
                  {formatTooltipLabel(buckets[hoverIdx], bucketSize)}
                </text>
                {hoverEntries.map(({ s, v }, ei) => (
                  <text
                    key={s.key}
                    x={bx + padX} y={by + headH + padY + (ei + 1) * lineH - lineH * 0.25}
                    fill={s.color} fontSize={valFs} fontFamily="var(--font-mono)" fontWeight="bold"
                  >
                    {s.label.toUpperCase()}: {fmtNum(v)}
                  </text>
                ))}
              </g>
            );
          })()}
        </svg>
      )}

      {/* Legend */}
      {hasData && showLegend && (
        <div style={{ display: 'flex', gap: '12px', marginTop: '4px', flexWrap: 'wrap' }}>
          {allSeries.map(s => (
            <span
              key={s.key}
              style={{
                fontSize: '9px', letterSpacing: '1px',
                color: s.color, opacity: 0.9,
                fontFamily: 'var(--font-mono)',
              }}
            >
              — {s.label.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
