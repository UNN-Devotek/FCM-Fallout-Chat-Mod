import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../services/api';
import { useAuth } from '../../../contexts/AuthContext';

/**
 * Dweller self-service view for staff applications. Renders ONLY the current
 * user's own applications (GET /api/applications/mine), a "+ New" centered form
 * mirroring the public ApplyPage field layout (dynamic fields from /api/commands
 * fall back to defaults), and a read-only detail modal for a clicked row.
 */

interface MyApplication {
  id: string;
  inGameName: string;
  discordTag: string;
  age: string;
  timezone: string;
  experience: string;
  motivation: string;
  availability: string;
  status: string;
  adminNotes: string | null;
  createdAt: string;
}

interface FormField {
  key: string;
  label: string;
  type: 'text' | 'textarea';
  required: boolean;
  placeholder: string;
}

const DEFAULT_FIELDS: FormField[] = [
  { key: 'inGameName',   label: 'IN-GAME NAME (FO76)',            type: 'text',     required: true,  placeholder: 'Your Fallout 76 character name' },
  { key: 'age',          label: 'AGE',                            type: 'text',     required: true,  placeholder: 'e.g. 22' },
  { key: 'timezone',     label: 'TIMEZONE',                       type: 'text',     required: true,  placeholder: 'e.g. EST, GMT+2' },
  { key: 'availability', label: 'AVAILABILITY (HRS/WEEK, TIMES)', type: 'text',     required: true,  placeholder: 'e.g. 20hrs/week, evenings EST' },
  { key: 'experience',   label: 'RELEVANT EXPERIENCE',            type: 'textarea', required: true,  placeholder: 'Prior moderation, community management, or relevant experience' },
  { key: 'motivation',   label: 'WHY DO YOU WANT TO JOIN?',       type: 'textarea', required: true,  placeholder: 'Tell us why you want to be part of the moderation team' },
];

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--warning)',
  approved: 'var(--phosphor-color)',
  rejected: 'var(--danger)',
};

const dim = 'var(--text-secondary)';
const border = 'var(--border-color)';

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-panel)',
  border: `1px solid ${border}`,
  color: 'var(--text-primary)',
  padding: '8px 12px',
  fontSize: '13px',
  fontFamily: 'var(--font-mono)',
  outline: 'none',
  boxSizing: 'border-box',
};

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value || '—'}</div>
    </div>
  );
}

export default function MyApplications() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const displayName = user ? (user.fo76Name || user.discordDisplayName || user.username) : '';

  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<MyApplication | null>(null);
  const [fields, setFields] = useState<FormField[]>(DEFAULT_FIELDS);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: applications, isLoading } = useQuery({
    queryKey: ['my-applications'],
    queryFn: () => api.get<MyApplication[]>('/api/applications/mine'),
  });

  // Load dynamic apply-form fields (admin-configurable), fall back to defaults.
  useEffect(() => {
    fetch('/api/commands', { credentials: 'include' })
      .then(r => r.json())
      .then(j => {
        const cmd = (j.data ?? []).find((c: any) => c.trigger === '/apply');
        if (cmd?.formFields) {
          try {
            const parsed: FormField[] = JSON.parse(cmd.formFields);
            if (parsed.length > 0) setFields(parsed);
          } catch { /* use defaults */ }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setValues(Object.fromEntries(fields.map(f => [f.key, ''])));
  }, [fields]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const missing = fields.filter(f => f.required && !values[f.key]?.trim());
    if (missing.length > 0) { setError('All required fields must be filled.'); return; }
    setSubmitting(true); setError(null);
    try {
      const body: Record<string, string> = { discordTag: displayName };
      for (const f of fields) body[f.key] = (values[f.key] ?? '').trim();
      await api.post('/api/applications', body);
      setShowForm(false);
      setValues(Object.fromEntries(fields.map(f => [f.key, ''])));
      queryClient.invalidateQueries({ queryKey: ['my-applications'] });
    } catch (err: any) {
      setError(err?.message ?? 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '16px 0 12px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '18px', margin: 0, letterSpacing: '4px' }}>◈ MY APPLICATIONS</h1>
          <div style={{ fontSize: '11px', color: dim, marginTop: '4px', letterSpacing: '1px' }}>Staff applications you have submitted</div>
        </div>
        {!showForm && <button onClick={() => setShowForm(true)} style={{ flexShrink: 0 }}>＋ NEW APPLICATION</button>}
      </div>

      {/* New application form (centered) */}
      {showForm && (
        <div style={{ flex: 1, overflow: 'auto', marginTop: '12px' }}>
          <form onSubmit={handleSubmit} style={{ maxWidth: '560px', margin: '0 auto', border: `1px solid ${border}`, background: 'var(--bg-card)', padding: '28px 28px 24px' }}>
            <div style={{ marginBottom: '18px', fontSize: '13px', color: dim }}>
              Applying as <span style={{ color: 'var(--phosphor-color)', fontWeight: 'bold' }}>{displayName}</span>
            </div>
            <div style={{ marginBottom: '18px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>DISCORD TAG</label>
              <input type="text" value={displayName} readOnly style={{ ...inputStyle, opacity: 0.7, cursor: 'default' }} />
            </div>

            {fields.map(f => (
              <div key={f.key} style={{ marginBottom: '18px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>
                  {f.label}{f.required ? '' : ' (optional)'}
                </label>
                {f.type === 'textarea' ? (
                  <textarea value={values[f.key] ?? ''} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} rows={3} placeholder={f.placeholder} style={{ ...inputStyle, resize: 'vertical' }} required={f.required} />
                ) : (
                  <input type="text" value={values[f.key] ?? ''} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} placeholder={f.placeholder} style={inputStyle} required={f.required} />
                )}
              </div>
            ))}

            {error && <div style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '16px', letterSpacing: '1px' }}>{error}</div>}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="submit" disabled={submitting} style={{ flex: 1 }}>{submitting ? 'SUBMITTING...' : 'SUBMIT APPLICATION'}</button>
              <button type="button" onClick={() => { setShowForm(false); setError(null); }} style={{ flexShrink: 0 }}>CANCEL</button>
            </div>
          </form>
        </div>
      )}

      {/* My applications table */}
      {!showForm && (
        <div style={{ flex: 1, overflow: 'auto', marginTop: '8px' }}>
          {isLoading && <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>LOADING...</div>}
          {!isLoading && (!applications || applications.length === 0) && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>You haven't submitted any yet.</div>
          )}
          {!isLoading && applications && applications.length > 0 && (
            <div className="table-responsive">
              <table>
                <thead>
                  <tr>{['IN-GAME NAME', 'TIMEZONE', 'STATUS', 'DATE'].map(h => <th key={h} style={{ whiteSpace: 'nowrap' }}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {applications.map(app => (
                    <tr key={app.id} style={{ borderBottom: `1px solid ${border}`, cursor: 'pointer' }}
                        onClick={() => setDetail(app)}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(212,176,64,0.08)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      <td style={{ color: 'var(--phosphor-color)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{app.inGameName}</td>
                      <td style={{ color: dim, fontSize: '12px', whiteSpace: 'nowrap' }}>{app.timezone}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><span className="badge" style={{ color: STATUS_COLORS[app.status] ?? dim }}>{app.status}</span></td>
                      <td style={{ color: dim, whiteSpace: 'nowrap', fontSize: '11px' }}>{new Date(app.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Read-only detail modal */}
      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '560px', maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--phosphor-color)', background: 'var(--bg-card)', padding: '28px', boxShadow: '0 0 40px rgba(212,176,64,0.12)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <h2 style={{ fontSize: '16px', margin: 0, letterSpacing: '3px' }}>STAFF APPLICATION</h2>
              <span className="badge" style={{ color: STATUS_COLORS[detail.status] ?? dim }}>{detail.status}</span>
            </div>
            <div style={{ fontSize: '11px', color: dim, letterSpacing: '1px', marginBottom: '18px' }}>Submitted {new Date(detail.createdAt).toLocaleString('en-US')}</div>
            <DetailField label="IN-GAME NAME" value={detail.inGameName} />
            <DetailField label="DISCORD TAG" value={detail.discordTag} />
            <DetailField label="AGE" value={detail.age} />
            <DetailField label="TIMEZONE" value={detail.timezone} />
            <DetailField label="AVAILABILITY" value={detail.availability} />
            <DetailField label="RELEVANT EXPERIENCE" value={detail.experience} />
            <DetailField label="MOTIVATION" value={detail.motivation} />
            <button onClick={() => setDetail(null)} style={{ marginTop: '8px' }}>CLOSE</button>
          </div>
        </div>
      )}
    </div>
  );
}
