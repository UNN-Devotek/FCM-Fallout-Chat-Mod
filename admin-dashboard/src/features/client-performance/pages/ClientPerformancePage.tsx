import React, { useState } from 'react';
import { useClientMetrics, MetricsWindow, MetricsSource } from '../hooks/useClientMetrics';
import MetricLineChart from '../components/MetricLineChart';
import OutliersTable from '../components/OutliersTable';
import type { TimeBucket } from '../hooks/useClientMetrics';

const WINDOWS: { label: string; value: MetricsWindow }[] = [
  { label: '1H',  value: '1h'  },
  { label: '24H', value: '24h' },
  { label: '7D',  value: '7d'  },
  { label: '30D', value: '30d' },
];

const SOURCES: { label: string; value: MetricsSource }[] = [
  { label: 'ALL',     value: 'all'     },
  { label: 'OVERLAY', value: 'overlay' },
  { label: 'MONITOR', value: 'monitor' },
];

export default function ClientPerformancePage() {
  const [window, setWindow] = useState<MetricsWindow>('24h');
  const [source, setSource] = useState<MetricsSource>('all');

  const { data, isLoading, error } = useClientMetrics(window, source);

  const containerStyle: React.CSSProperties = {
    padding: '24px',
    color: 'var(--phosphor-color)',
    fontFamily: 'monospace',
    maxWidth: '1200px',
  };

  const btnBase: React.CSSProperties = {
    padding: '3px 12px',
    fontSize: '11px',
    letterSpacing: '1px',
    cursor: 'pointer',
    border: '1px solid rgba(212,176,64,0.4)',
    background: 'transparent',
    color: 'rgba(212,176,64,0.6)',
    fontFamily: 'monospace',
    transition: 'all 0.1s',
  };

  const btnActive: React.CSSProperties = {
    ...btnBase,
    background: 'rgba(212,176,64,0.12)',
    color: 'var(--phosphor-color)',
    borderColor: 'rgba(212,176,64,0.7)',
    textShadow: '0 0 6px rgba(212,176,64,0.6)',
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: '12px',
    letterSpacing: '2px',
    color: 'rgba(255,255,255,0.5)',
    textTransform: 'uppercase',
    marginBottom: '12px',
    marginTop: '28px',
  };

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    gap: '12px',
    marginBottom: '28px',
  };

  const buckets: TimeBucket[] = data?.timeBuckets ?? [];

  return (
    <div style={containerStyle}>
      <h2 style={{ fontSize: '14px', letterSpacing: '3px', marginBottom: '20px', textTransform: 'uppercase' }}>
        Client Performance
      </h2>

      {/* Window + Source selectors */}
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '4px' }}>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span style={{ fontSize: '10px', letterSpacing: '1px', color: 'rgba(255,255,255,0.3)', marginRight: '4px' }}>WINDOW</span>
          {WINDOWS.map(w => (
            <button key={w.value} style={window === w.value ? btnActive : btnBase} onClick={() => setWindow(w.value)}>
              {w.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <span style={{ fontSize: '10px', letterSpacing: '1px', color: 'rgba(255,255,255,0.3)', marginRight: '4px' }}>SOURCE</span>
          {SOURCES.map(s => (
            <button key={s.value} style={source === s.value ? btnActive : btnBase} onClick={() => setSource(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', padding: '24px 0' }}>
          Loading performance data...
        </div>
      )}

      {error && (
        <div style={{ fontSize: '12px', color: '#ff4444', padding: '12px 0' }}>
          Error: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && (
        <>
          <div style={sectionLabel}>Aggregate Metrics</div>
          <div style={gridStyle}>
            <MetricLineChart
              title="Working Set"
              unit="MB"
              buckets={buckets}
              accessor={b => b.workingSetMb}
              window={window}
            />
            <MetricLineChart
              title="CPU Usage"
              unit="%"
              buckets={buckets}
              accessor={b => b.cpuPct}
              window={window}
            />
            <MetricLineChart
              title="GIF Cache"
              unit="MB"
              buckets={buckets}
              accessor={b => b.gifCacheMb}
              window={window}
            />
            <MetricLineChart
              title="FPS (Overlay)"
              unit="fps"
              buckets={buckets}
              accessor={b => b.fps}
              window={window}
            />
          </div>

          {buckets.length > 0 && (
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', marginBottom: '20px' }}>
              {buckets.reduce((s, b) => s + b.sampleCount, 0).toLocaleString()} samples in window
            </div>
          )}

          <div style={sectionLabel}>Top Outliers (by Working Set)</div>
          <div style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '4px',
            padding: '12px',
          }}>
            <OutliersTable outliers={data?.outliers ?? []} />
          </div>
        </>
      )}
    </div>
  );
}
