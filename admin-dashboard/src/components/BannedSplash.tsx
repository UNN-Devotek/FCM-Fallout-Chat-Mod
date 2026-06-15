import React, { useEffect, useState } from 'react';

/**
 * Full-viewport splash shown when ANY API call returns a structured 403
 * { type: 'banned' }. The api service raises a `fcm:banned` window event on
 * those responses; we listen here and render. Re-checks once a minute by
 * pinging /auth/me — when the call succeeds the splash drops automatically
 * (covers the moderator-just-unbanned-them case in near-real-time).
 */
interface BannedDetail {
  until: string | null;
  permanent: boolean;
  reason: string | null;
  category: string | null;
}

export default function BannedSplash() {
  const [detail, setDetail] = useState<BannedDetail | null>(null);

  useEffect(() => {
    function onBan(ev: Event) {
      const ce = ev as CustomEvent<BannedDetail>;
      setDetail(ce.detail);
    }
    window.addEventListener('fcm:banned', onBan);
    return () => window.removeEventListener('fcm:banned', onBan);
  }, []);

  // Poll for unban every 60s while the splash is up.
  useEffect(() => {
    if (!detail) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch('/auth/me', { credentials: 'include' });
        if (r.ok) setDetail(null); // unbanned — splash drops, page resumes normal flow
      } catch { /* still banned / network blip */ }
    }, 60_000);
    return () => clearInterval(t);
  }, [detail]);

  if (!detail) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100000,
      background: 'rgba(10, 9, 7, 0.97)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Courier New', monospace", color: 'var(--phosphor-color)',
    }}>
      <div style={{
        maxWidth: '520px', padding: '32px 36px', textAlign: 'center',
        border: '2px solid #FF6060', background: 'rgba(40, 14, 14, 0.85)',
      }}>
        <div style={{ fontSize: '14px', letterSpacing: '0.2em', color: '#FF6060', marginBottom: '8px' }}>◈ ACCESS REVOKED ◈</div>
        <h1 style={{ fontSize: '22px', margin: '0 0 16px', color: '#FFB0B0' }}>
          {detail.permanent ? 'You have been permanently banned' : 'You are temporarily banned'}
        </h1>
        {detail.until && !detail.permanent && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
            Access restored: <strong style={{ color: '#FFB0B0' }}>{new Date(detail.until).toLocaleString()}</strong>
          </div>
        )}
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', letterSpacing: '0.05em', marginBottom: '6px' }}>
          {detail.category ? `CATEGORY: ${detail.category}` : ''}
        </div>
        <div style={{ fontSize: '14px', color: '#f0e8cc', whiteSpace: 'pre-wrap', marginBottom: '24px' }}>
          {detail.reason || '(no reason provided)'}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', borderTop: '1px solid rgba(255,96,96,0.3)', paddingTop: '14px' }}>
          You're locked out of the chat overlay, the dashboard, and your Discord roles<br />
          have been temporarily removed. You can appeal in DMs to a moderator.<br />
          <span style={{ opacity: 0.7 }}>(This page re-checks for an unban every minute.)</span>
        </div>
      </div>
    </div>
  );
}
