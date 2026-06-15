import React, { useState } from 'react';
import type { Outlier } from '../hooks/useClientMetrics';

type SortKey = keyof Outlier;

interface Props {
  outliers: Outlier[];
}

export default function OutliersTable({ outliers }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('workingSetMb');
  const [sortAsc, setSortAsc] = useState(false);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  }

  const sorted = [...outliers].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    if (typeof av === 'string' && typeof bv === 'string')
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortAsc ? Number(av) - Number(bv) : Number(bv) - Number(av);
  });

  const th = (label: string, key: SortKey): React.ReactNode => (
    <th
      key={key}
      onClick={() => handleSort(key)}
      style={{
        cursor: 'pointer',
        padding: '6px 10px',
        textAlign: 'left',
        fontSize: '10px',
        letterSpacing: '1px',
        color: sortKey === key ? 'var(--phosphor-color)' : 'rgba(255,255,255,0.4)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {label}{sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const tdStyle: React.CSSProperties = {
    padding: '5px 10px',
    fontSize: '11px',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontFamily: 'monospace',
    color: 'rgba(255,255,255,0.75)',
    whiteSpace: 'nowrap',
  };

  if (outliers.length === 0) {
    return (
      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', padding: '12px 0' }}>
        No outlier data in this window.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
        <thead>
          <tr>
            {th('TOKEN', 'tokenPrefix')}
            {th('WORKING SET (MB)', 'workingSetMb')}
            {th('CPU %', 'cpuPct')}
            {th('GIF CACHE (MB)', 'gifCacheMb')}
            {th('FPS', 'fps')}
            {th('VERSION', 'appVersion')}
            {th('SAMPLED AT', 'sampledAt')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
              <td style={{ ...tdStyle, color: 'rgba(212,176,64,0.8)', fontFamily: 'monospace' }}>{o.tokenPrefix}…</td>
              <td style={tdStyle}>{o.workingSetMb}</td>
              <td style={tdStyle}>{o.cpuPct.toFixed(1)}</td>
              <td style={tdStyle}>{o.gifCacheMb != null ? o.gifCacheMb : '—'}</td>
              <td style={tdStyle}>{o.fps != null ? o.fps.toFixed(1) : '—'}</td>
              <td style={tdStyle}>{o.appVersion}</td>
              <td style={{ ...tdStyle, color: 'rgba(255,255,255,0.4)' }}>
                {new Date(o.sampledAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
