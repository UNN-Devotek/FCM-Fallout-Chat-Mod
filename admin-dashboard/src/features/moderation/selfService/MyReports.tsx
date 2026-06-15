import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../services/api';
import MentionInput from '../../public/MentionInput';

/**
 * Dweller self-service view for player/bug reports. Renders ONLY the current
 * user's own submissions (GET /api/player-reports/mine?type=...), a "+ New"
 * centered form mirroring the public ReportPage field layout, and a read-only
 * detail modal for a clicked row. Used by both PlayerReports.tsx (type=player)
 * and BugReports.tsx (type=bug) when the viewer is a non-staff dweller.
 */

export type ReportType = 'player' | 'bug';

interface MyReport {
  id: string;
  content: string;
  involvedPlayers: string | null;
  imageUrls: string | null; // JSON: string[]
  status: string;
  reportType: string;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--warning)',
  reviewed: 'var(--info)',
  closed: 'var(--phosphor-color)',
};

const dim = 'var(--text-secondary)';
const border = 'var(--border-color)';

const CONFIG: Record<ReportType, { heading: string; subtitle: string; newLabel: string; contentLabel: string; placeholder: string; submitLabel: string }> = {
  player: {
    heading: '◈ MY PLAYER REPORTS',
    subtitle: 'Reports you have submitted about other players',
    newLabel: '＋ NEW PLAYER REPORT',
    contentLabel: 'DESCRIBE THE INCIDENT',
    placeholder: "Describe what happened. Include the player's name, what they did, and approximately when it occurred.",
    submitLabel: 'SUBMIT PLAYER REPORT',
  },
  bug: {
    heading: '◈ MY BUG REPORTS',
    subtitle: 'Technical issues and bugs you have reported',
    newLabel: '＋ NEW BUG REPORT',
    contentLabel: 'DESCRIBE THE BUG',
    placeholder: 'Describe the bug. What were you doing when it happened? What did you expect vs. what actually happened? Include any error messages.',
    submitLabel: 'SUBMIT BUG REPORT',
  },
};

function parseImageUrls(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-panel)',
  border: `1px solid ${border}`,
  color: 'var(--text-primary)',
  padding: '10px 12px',
  fontSize: '13px',
  fontFamily: 'var(--font-mono)',
  resize: 'vertical',
  outline: 'none',
  boxSizing: 'border-box',
};

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
      <img src={url} alt="Screenshot" onClick={e => e.stopPropagation()} style={{ maxWidth: '90vw', maxHeight: '88vh', objectFit: 'contain', border: `1px solid ${border}`, cursor: 'default' }} />
    </div>
  );
}

export default function MyReports({ type }: { type: ReportType }) {
  const queryClient = useQueryClient();
  const cfg = CONFIG[type];

  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<MyReport | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const [content, setContent] = useState('');
  const [involvedPlayers, setInvolvedPlayers] = useState('');
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const { data: reports, isLoading } = useQuery({
    queryKey: ['my-reports', type],
    queryFn: () => api.get<MyReport[]>(`/api/player-reports/mine?type=${type}`),
  });

  function resetForm() {
    setContent(''); setInvolvedPlayers('');
    imagePreviews.forEach(p => URL.revokeObjectURL(p));
    setImageFiles([]); setImagePreviews([]); setError(null);
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []).slice(0, 3);
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const valid = selected.filter(f => allowed.includes(f.type) && f.size <= 5 * 1024 * 1024);
    if (valid.length < selected.length) setError('Only JPEG, PNG, WebP, GIF under 5 MB are accepted.');
    setImageFiles(valid);
    setImagePreviews(valid.map(f => URL.createObjectURL(f)));
  }

  function removeImage(idx: number) {
    setImageFiles(prev => prev.filter((_, i) => i !== idx));
    setImagePreviews(prev => { URL.revokeObjectURL(prev[idx]); return prev.filter((_, i) => i !== idx); });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) { setError('Report content is required.'); return; }
    setSubmitting(true); setError(null);
    try {
      let imageUrls: string[] = [];
      if (imageFiles.length > 0) {
        setUploading(true);
        const fd = new FormData();
        imageFiles.forEach(f => fd.append('images', f));
        const up = await api.post<{ urls: string[] }>('/api/player-reports/upload-image', fd);
        setUploading(false);
        imageUrls = up?.urls ?? [];
      }
      await api.post('/api/player-reports', {
        reportType: type,
        content: content.trim(),
        involvedPlayers: type === 'player' ? (involvedPlayers.trim() || undefined) : undefined,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      });
      resetForm();
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ['my-reports', type] });
    } catch (err: any) {
      setError(err?.message ?? 'Submission failed.');
    } finally {
      setSubmitting(false); setUploading(false);
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}

      <div style={{ padding: '16px 0 12px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '18px', margin: 0, letterSpacing: '4px' }}>{cfg.heading}</h1>
          <div style={{ fontSize: '11px', color: dim, marginTop: '4px', letterSpacing: '1px' }}>{cfg.subtitle}</div>
        </div>
        {!showForm && (
          <button onClick={() => setShowForm(true)} style={{ flexShrink: 0 }}>{cfg.newLabel}</button>
        )}
      </div>

      {/* New submission form (centered) */}
      {showForm && (
        <div style={{ flex: 1, overflow: 'auto', marginTop: '12px' }}>
          <form onSubmit={handleSubmit} style={{ maxWidth: '560px', margin: '0 auto', border: `1px solid ${border}`, background: 'var(--bg-card)', padding: '28px 28px 24px' }}>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '8px' }}>{cfg.contentLabel}</label>
              <textarea value={content} onChange={e => setContent(e.target.value.slice(0, 2000))} rows={6} placeholder={cfg.placeholder} style={inputStyle} required />
              <div style={{ fontSize: '11px', color: dim, textAlign: 'right', marginTop: '4px' }}>{content.length}/2000</div>
            </div>

            {type === 'player' && (
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '8px' }}>
                  INVOLVED PLAYERS <span style={{ opacity: 0.7 }}>(optional — type @ to search)</span>
                </label>
                <MentionInput value={involvedPlayers} onChange={setInvolvedPlayers} placeholder="@PlayerName, @AnotherPlayer..." maxLength={500} />
                <div style={{ fontSize: '11px', color: dim, textAlign: 'right', marginTop: '4px' }}>{involvedPlayers.length}/500</div>
              </div>
            )}

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '8px' }}>
                {type === 'player' ? 'EVIDENCE SCREENSHOTS' : 'SCREENSHOTS'} <span style={{ opacity: 0.7 }}>(optional — max 3, 5 MB each)</span>
              </label>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple style={{ display: 'none' }} onChange={handleImageSelect} />
              {imagePreviews.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  {imagePreviews.map((src, idx) => (
                    <div key={idx} style={{ position: 'relative', width: '80px', height: '80px' }}>
                      <img src={src} alt="" style={{ width: '80px', height: '80px', objectFit: 'cover', border: `1px solid ${border}`, display: 'block' }} />
                      <button type="button" onClick={() => removeImage(idx)} style={{ position: 'absolute', top: 0, right: 0, background: 'rgba(0,0,0,0.7)', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '2px 4px' }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              {imagePreviews.length < 3 && (
                <button type="button" onClick={() => fileInputRef.current?.click()} style={{ background: 'transparent', border: `1px dashed ${border}`, color: dim, padding: '8px 24px', fontSize: '12px', cursor: 'pointer', letterSpacing: '1px' }}>+ ADD SCREENSHOT</button>
              )}
            </div>

            {error && <div style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '16px', letterSpacing: '1px' }}>{error}</div>}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="submit" disabled={submitting || !content.trim()} style={{ flex: 1 }}>
                {uploading ? 'UPLOADING...' : submitting ? 'SUBMITTING...' : cfg.submitLabel}
              </button>
              <button type="button" onClick={() => { resetForm(); setShowForm(false); }} style={{ flexShrink: 0 }}>CANCEL</button>
            </div>
          </form>
        </div>
      )}

      {/* My submissions table */}
      {!showForm && (
        <div style={{ flex: 1, overflow: 'auto', marginTop: '8px' }}>
          {isLoading && <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>LOADING...</div>}
          {!isLoading && (!reports || reports.length === 0) && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>You haven't submitted any yet.</div>
          )}
          {!isLoading && reports && reports.length > 0 && (
            <div className="table-responsive">
              <table>
                <thead>
                  <tr>
                    {[...['REPORT'], ...(type === 'player' ? ['INVOLVED'] : []), 'IMGS', 'STATUS', 'DATE'].map(h => <th key={h} style={{ whiteSpace: 'nowrap' }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {reports.map(r => {
                    const imgs = parseImageUrls(r.imageUrls);
                    const statusColor = STATUS_COLORS[r.status] ?? dim;
                    return (
                      <tr key={r.id} style={{ borderBottom: `1px solid ${border}`, cursor: 'pointer' }}
                          onClick={() => setDetail(r)}
                          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(212,176,64,0.08)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                        <td style={{ maxWidth: '360px' }}>
                          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }}>{r.content}</span>
                        </td>
                        {type === 'player' && (
                          <td style={{ maxWidth: '180px' }}>
                            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: dim }}>{r.involvedPlayers || '—'}</span>
                          </td>
                        )}
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {imgs.length > 0 ? <span className="badge" style={{ color: 'var(--phosphor-color)' }}>◼ {imgs.length}</span> : <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>—</span>}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}><span className="badge" style={{ color: statusColor }}>{r.status}</span></td>
                        <td style={{ color: dim, whiteSpace: 'nowrap', fontSize: '11px' }}>{new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Read-only detail modal */}
      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '560px', maxHeight: '85vh', overflow: 'auto', border: `1px solid var(--phosphor-color)`, background: 'var(--bg-card)', padding: '28px', boxShadow: '0 0 40px rgba(212,176,64,0.12)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <h2 style={{ fontSize: '16px', margin: 0, letterSpacing: '3px' }}>{type === 'player' ? 'PLAYER REPORT' : 'BUG REPORT'}</h2>
              <span className="badge" style={{ color: STATUS_COLORS[detail.status] ?? dim }}>{detail.status}</span>
            </div>
            <div style={{ fontSize: '11px', color: dim, letterSpacing: '1px', marginBottom: '18px' }}>
              Submitted {new Date(detail.createdAt).toLocaleString('en-US')}
            </div>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>{type === 'player' ? 'REPORT CONTENT' : 'BUG DESCRIPTION'}</div>
              <div style={{ background: 'var(--bg-panel)', border: `1px solid ${border}`, padding: '10px 14px', fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{detail.content}</div>
            </div>
            {type === 'player' && detail.involvedPlayers && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>INVOLVED PLAYERS</div>
                <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{detail.involvedPlayers}</div>
              </div>
            )}
            {parseImageUrls(detail.imageUrls).length > 0 && (
              <div style={{ marginBottom: '8px' }}>
                <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '8px' }}>SCREENSHOTS</div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {parseImageUrls(detail.imageUrls).map((url, i) => (
                    <img key={i} src={url} alt={`Screenshot ${i + 1}`} onClick={() => setLightboxUrl(url)} style={{ width: '110px', height: '82px', objectFit: 'cover', border: `1px solid ${border}`, cursor: 'zoom-in' }} />
                  ))}
                </div>
              </div>
            )}
            <button onClick={() => setDetail(null)} style={{ marginTop: '12px' }}>CLOSE</button>
          </div>
        </div>
      )}
    </div>
  );
}
