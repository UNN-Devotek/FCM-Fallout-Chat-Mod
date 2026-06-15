import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import MyApplications from './selfService/MyApplications';

const STAFF_ROLES = ['owner', 'admin', 'moderator'];

interface Application {
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

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--warning)',
  approved: 'var(--phosphor-color)',
  rejected: 'var(--danger)',
};

const phosphor = 'var(--text-primary)';
const dim = 'var(--text-secondary)';
const faint = 'rgba(212,176,64,0.08)';
const border = 'var(--border-color)';

export default function Applications() {
  const { user } = useAuth();
  const isStaff = !!user && STAFF_ROLES.includes(user.role);
  if (!isStaff) return <MyApplications />;
  return <ApplicationsAdmin />;
}

function ApplicationsAdmin() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: () => api.get<Application[]>('/api/applications'),
  });

  async function handleStatusChange(id: string, status: string) {
    try {
      await api.patch(`/api/applications/${id}`, { status });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    } catch { /* ignored */ }
  }

  async function handleSaveNotes(id: string) {
    setSavingId(id);
    try {
      await api.patch(`/api/applications/${id}`, { adminNotes: noteDrafts[id] ?? '' });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    } catch {
      //
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '16px 0 12px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '18px', margin: 0, letterSpacing: '4px' }}>
            ◈ STAFF APPLICATIONS
          </h1>
          <div style={{ fontSize: '11px', color: dim, marginTop: '4px', letterSpacing: '1px' }}>
            Applications submitted via the public apply page
          </div>
        </div>
        <a href="/apply" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
          <button style={{ flexShrink: 0 }}>APPLY PAGE ↗</button>
        </a>
      </div>

      <div style={{ flex: 1, overflow: 'auto', marginTop: '8px' }}>
        {isLoading && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>
            LOADING...
          </div>
        )}

        {!isLoading && (!applications || applications.length === 0) && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>
            NO APPLICATIONS FOUND
          </div>
        )}

        {!isLoading && applications && applications.length > 0 && applications.map((app) => {
          const isExpanded = expandedId === app.id;
          const statusColor = STATUS_COLORS[app.status] ?? dim;
          const noteValue = noteDrafts[app.id] !== undefined ? noteDrafts[app.id] : (app.adminNotes ?? '');

          return (
            <div
              key={app.id}
              style={{ borderBottom: `1px solid ${border}` }}
            >
              {/* Summary row */}
              <div
                onClick={() => setExpandedId(isExpanded ? null : app.id)}
                style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = faint; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ color: dim, fontSize: '12px', width: '14px', flexShrink: 0 }}>
                  {isExpanded ? '▼' : '▶'}
                </span>
                <span style={{ fontWeight: 'bold', minWidth: '140px', color: 'var(--phosphor-color)', fontSize: '13px' }}>
                  {app.inGameName}
                </span>
                <span style={{ color: dim, fontSize: '12px', minWidth: '160px' }}>
                  {app.discordTag}
                </span>
                <span style={{ color: dim, fontSize: '12px', minWidth: '60px' }}>
                  {app.age}
                </span>
                <span style={{ color: dim, fontSize: '12px', minWidth: '80px' }}>
                  {app.timezone}
                </span>
                <span className="badge" style={{ color: statusColor, marginLeft: 'auto', flexShrink: 0 }}>
                  {app.status}
                </span>
                <span style={{ color: dim, fontSize: '11px', letterSpacing: '1px', flexShrink: 0, minWidth: '80px', textAlign: 'right' }}>
                  {new Date(app.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{ padding: '16px 40px 20px', background: 'var(--bg-card)', borderTop: `1px solid ${border}` }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 32px', marginBottom: '20px' }}>
                    <DetailField label="EXPERIENCE" value={app.experience} />
                    <DetailField label="MOTIVATION" value={app.motivation} />
                    <DetailField label="AVAILABILITY" value={app.availability} />
                  </div>

                  <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', marginTop: '8px' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>ADMIN NOTES</div>
                      <textarea
                        value={noteValue}
                        onChange={e => setNoteDrafts(prev => ({ ...prev, [app.id]: e.target.value }))}
                        rows={3}
                        style={{ width: '100%', resize: 'vertical' }}
                      />
                      <button
                        onClick={() => handleSaveNotes(app.id)}
                        disabled={savingId === app.id}
                        style={{ marginTop: '6px' }}
                      >
                        {savingId === app.id ? 'SAVING...' : 'SAVE NOTES'}
                      </button>
                    </div>

                    <div style={{ flexShrink: 0 }}>
                      <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>STATUS</div>
                      <select
                        value={app.status}
                        onChange={e => handleStatusChange(app.id, e.target.value)}
                        style={{ width: 'auto' }}
                      >
                        <option value="pending">PENDING</option>
                        <option value="approved">APPROVED</option>
                        <option value="rejected">REJECTED</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', letterSpacing: '2px', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: '1.5' }}>{value}</div>
    </div>
  );
}
