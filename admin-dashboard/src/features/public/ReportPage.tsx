import React, { useEffect, useState } from 'react';
import MentionInput from './MentionInput';

interface PublicUser {
  discordId: string;
  username: string;
  discordDisplayName?: string;
  fo76Name?: string | null;
  avatar: string | null;
  intent: string;
}

function getDisplayName(user: PublicUser): string {
  return user.fo76Name ?? user.discordDisplayName ?? user.username;
}

const gold = '#C8A840';
const goldDim = 'rgba(200,168,64,0.5)';
const goldFaint = 'rgba(200,168,64,0.12)';
const bg = '#0f0d04';
const cardBg = '#1e1908';

type ReportType = 'player' | 'bug';

const REPORT_CONFIG: Record<ReportType, { label: string; description: string; placeholder: string; submitLabel: string }> = {
  player: {
    label: 'PLAYER REPORT',
    description: 'Report a player for harassment, cheating, or conduct violations.',
    placeholder: 'Describe what happened. Include the player\'s name, what they did, and approximately when it occurred.',
    submitLabel: 'SUBMIT PLAYER REPORT',
  },
  bug: {
    label: 'BUG REPORT',
    description: 'Report a bug or technical issue with the chat mod.',
    placeholder: 'Describe the bug. What were you doing when it happened? What did you expect to happen vs. what actually happened? Include any error messages if visible.',
    submitLabel: 'SUBMIT BUG REPORT',
  },
};

export default function ReportPage() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [reportType, setReportType] = useState<ReportType>('player');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(30);
  const [involvedPlayers, setInvolvedPlayers] = useState('');
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/auth/me/public')
      .then(r => r.json())
      .then(j => { if (j.authenticated) setUser(j.user); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!submitted) return;
    if (countdown <= 0) {
      let safe = '/';
      try { if (document.referrer && new URL(document.referrer).origin === window.location.origin) safe = document.referrer; } catch { /* malformed referrer */ }
      window.location.href = safe;
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [submitted, countdown]);

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
    setSubmitting(true);
    setError(null);
    try {
      let imageUrls: string[] = [];
      if (imageFiles.length > 0) {
        setUploading(true);
        const fd = new FormData();
        imageFiles.forEach(f => fd.append('images', f));
        const upRes = await fetch('/api/player-reports/upload-image', { method: 'POST', body: fd });
        setUploading(false);
        if (!upRes.ok) {
          const j = await upRes.json().catch(() => ({}));
          throw new Error(j.detail ?? 'Image upload failed.');
        }
        const upJson = await upRes.json();
        imageUrls = upJson.data?.urls ?? [];
      }

      const res = await fetch('/api/player-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportType,
          content: content.trim(),
          involvedPlayers: reportType === 'player' ? (involvedPlayers.trim() || undefined) : undefined,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? 'Submission failed.');
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong.');
    } finally {
      setSubmitting(false);
      setUploading(false);
    }
  }

  const config = REPORT_CONFIG[reportType];

  return (
    <div style={{
      minHeight: '100vh',
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'clamp(12px, 4vw, 32px)',
      fontFamily: 'Courier New, monospace',
      color: gold,
    }}>
      <div style={{
        width: '100%',
        maxWidth: '600px',
        border: `1px solid ${gold}`,
        background: cardBg,
        boxShadow: `0 0 40px rgba(200,168,64,0.1)`,
        padding: 'clamp(20px, 5vw, 40px)',
      }}>
        <div style={{ fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px', marginBottom: '8px', textShadow: '0 0 10px rgba(200,168,64,0.4)' }}>
          SUBMIT A REPORT
        </div>
        <div style={{ fontSize: '12px', color: goldDim, letterSpacing: '2px', marginBottom: '32px' }}>
          FALLOUT CHAT MOD — MODERATION
        </div>

        {checking && (
          <div style={{ color: goldDim, letterSpacing: '2px', fontSize: '13px' }}>LOADING...</div>
        )}

        {!checking && !user && (
          <div>
            <p style={{ fontSize: '14px', color: 'rgba(200,168,64,0.8)', lineHeight: '1.7', marginBottom: '24px' }}>
              You must sign in with Discord before submitting a report. Only registered community members can file reports.
            </p>
            <a
              href="/auth/discord?intent=report"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '14px 0',
                background: 'rgba(88,101,242,0.15)',
                border: '1px solid #5865F2',
                color: gold,
                fontSize: '13px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                textDecoration: 'none',
                boxShadow: '0 0 16px rgba(88,101,242,0.2)',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(88,101,242,0.28)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(88,101,242,0.15)'; }}
            >
              <svg width="18" height="18" viewBox="0 0 127.14 96.36" fill="#5865F2">
                <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/>
              </svg>
              SIGN IN WITH DISCORD
            </a>
            {import.meta.env.VITE_DEV_PERSONAS === 'true' && (
              <a
                href="/auth/dev-public/report"
                style={{
                  display: 'block',
                  marginTop: '10px',
                  padding: '10px 0',
                  textAlign: 'center',
                  background: 'rgba(24,255,98,0.06)',
                  border: '1px solid rgba(24,255,98,0.25)',
                  color: 'rgba(24,255,98,0.7)',
                  textDecoration: 'none',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  letterSpacing: '1px',
                  fontFamily: 'Courier New, monospace',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(24,255,98,0.14)'; e.currentTarget.style.color = '#18FF62'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(24,255,98,0.06)'; e.currentTarget.style.color = 'rgba(24,255,98,0.7)'; }}
              >
                DEV: SKIP DISCORD AUTH
              </a>
            )}
          </div>
        )}

        {!checking && user && submitted && (
          <div>
            <div style={{ color: '#18c96a', fontSize: '20px', fontWeight: 'bold', letterSpacing: '2px', marginBottom: '12px' }}>
              REPORT SUBMITTED
            </div>
            <p style={{ fontSize: '14px', color: 'rgba(200,168,64,0.8)', lineHeight: '1.7', marginBottom: '20px' }}>
              {reportType === 'bug'
                ? 'Thank you for reporting this bug. Our team will investigate.'
                : 'Thank you. The moderation team will review your report within 24 hours.'}
            </p>
            <div style={{ fontSize: '12px', color: 'rgba(200,168,64,0.5)', letterSpacing: '2px' }}>
              REDIRECTING IN {countdown}s...
            </div>
            <div style={{ marginTop: '8px', height: '2px', background: 'rgba(200,168,64,0.15)', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(countdown / 30) * 100}%`, background: 'rgba(200,168,64,0.5)', transition: 'width 1s linear' }} />
            </div>
          </div>
        )}

        {!checking && user && !submitted && (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '20px', fontSize: '13px', color: goldDim }}>
              Signed in as <span style={{ color: gold, fontWeight: 'bold' }}>{getDisplayName(user)}</span>
            </div>

            {/* Report type selector */}
            <div style={{ marginBottom: '28px' }}>
              <label style={{ display: 'block', fontSize: '12px', color: goldDim, letterSpacing: '2px', marginBottom: '10px' }}>
                REPORT TYPE
              </label>
              <div style={{ display: 'flex', gap: '0' }}>
                {(['player', 'bug'] as ReportType[]).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setReportType(t); setError(null); }}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      background: reportType === t ? 'rgba(200,168,64,0.18)' : 'transparent',
                      border: `1px solid ${reportType === t ? gold : 'rgba(200,168,64,0.3)'}`,
                      color: reportType === t ? gold : goldDim,
                      fontSize: '12px',
                      fontWeight: reportType === t ? 'bold' : 'normal',
                      letterSpacing: '2px',
                      fontFamily: 'Courier New, monospace',
                      cursor: 'pointer',
                      textShadow: reportType === t ? '0 0 8px rgba(200,168,64,0.5)' : 'none',
                      transition: 'all 0.15s',
                    }}
                  >
                    {t === 'player' ? 'PLAYER REPORT' : 'BUG REPORT'}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: goldDim, marginTop: '8px', letterSpacing: '1px' }}>
                {config.description}
              </div>
            </div>

            {/* Report content */}
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '12px', color: goldDim, letterSpacing: '2px', marginBottom: '8px' }}>
                {reportType === 'player' ? 'DESCRIBE THE INCIDENT' : 'DESCRIBE THE BUG'}
              </label>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value.slice(0, 2000))}
                rows={6}
                placeholder={config.placeholder}
                style={{
                  width: '100%',
                  background: goldFaint,
                  border: `1px solid rgba(200,168,64,0.35)`,
                  color: gold,
                  padding: '10px 12px',
                  fontSize: '13px',
                  fontFamily: 'Courier New, monospace',
                  resize: 'vertical',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                required
              />
              <div style={{ fontSize: '11px', color: goldDim, textAlign: 'right', marginTop: '4px' }}>
                {content.length}/2000
              </div>
            </div>

            {/* Involved players — only for player reports */}
            {reportType === 'player' && (
              <div style={{ marginBottom: '24px' }}>
                <label style={{ display: 'block', fontSize: '12px', color: goldDim, letterSpacing: '2px', marginBottom: '8px' }}>
                  INVOLVED PLAYERS <span style={{ fontWeight: 'normal', opacity: 0.7 }}>(optional — type @ to search)</span>
                </label>
                <MentionInput
                  value={involvedPlayers}
                  onChange={setInvolvedPlayers}
                  placeholder="@PlayerName, @AnotherPlayer..."
                  maxLength={500}
                />
                <div style={{ fontSize: '11px', color: goldDim, textAlign: 'right', marginTop: '4px' }}>
                  {involvedPlayers.length}/500
                </div>
              </div>
            )}

            {/* Evidence screenshots */}
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '12px', color: goldDim, letterSpacing: '2px', marginBottom: '8px' }}>
                {reportType === 'player' ? 'EVIDENCE SCREENSHOTS' : 'SCREENSHOTS'}{' '}
                <span style={{ fontWeight: 'normal', opacity: 0.7 }}>(optional — max 3, 5 MB each)</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                style={{ display: 'none' }}
                onChange={handleImageSelect}
              />
              {imagePreviews.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'row', gap: '8px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'flex-start' }}>
                  {imagePreviews.map((src, idx) => (
                    <div key={idx} style={{ position: 'relative', flexShrink: 0, width: '80px', height: '80px' }}>
                      <img
                        src={src}
                        alt=""
                        style={{ width: '80px', height: '80px', objectFit: 'cover', border: `1px solid rgba(200,168,64,0.4)`, display: 'block' }}
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(idx)}
                        style={{
                          position: 'absolute', top: 0, right: 0,
                          background: 'rgba(0,0,0,0.7)', border: 'none', color: '#ff4444',
                          cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '2px 4px',
                          fontFamily: 'Courier New, monospace',
                        }}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              {imagePreviews.length < 3 && (
                <div style={{ textAlign: 'center' }}>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      background: 'transparent',
                      border: `1px dashed rgba(200,168,64,0.4)`,
                      color: goldDim,
                      padding: '8px 24px',
                      fontSize: '12px',
                      fontFamily: 'Courier New, monospace',
                      cursor: 'pointer',
                      letterSpacing: '1px',
                    }}
                  >
                    + ADD SCREENSHOT
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div style={{ color: '#ff4444', fontSize: '13px', marginBottom: '16px', letterSpacing: '1px' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !content.trim()}
              style={{
                width: '100%',
                padding: '14px 0',
                background: 'transparent',
                border: `1px solid ${gold}`,
                color: gold,
                fontSize: '14px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                fontFamily: 'Courier New, monospace',
                cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting ? 0.5 : 1,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { if (!submitting) e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              {uploading ? 'UPLOADING IMAGES...' : submitting ? 'SUBMITTING...' : config.submitLabel}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
