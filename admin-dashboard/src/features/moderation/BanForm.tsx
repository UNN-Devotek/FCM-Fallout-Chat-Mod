import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../../services/api';

const CATEGORIES = ['Harassment', 'HateSpeech', 'Spam', 'Cheating', 'NSFW', 'Threats', 'Doxxing', 'Other'] as const;
type Category = typeof CATEGORIES[number];

interface UserLookupResult {
  id: string; username: string;
  discordId: string | null; discordUsername: string | null; discordDisplayName: string | null; discordAvatar: string | null;
  isBanned: boolean; isMuted: boolean;
}

function name(u: { username: string; discordDisplayName: string | null; discordUsername: string | null } | null): string {
  if (!u) return '—';
  if (u.username && u.username !== 'Wanderer' && !u.username.startsWith('pending-') && !u.username.startsWith('admin-discord-')) return u.username;
  return u.discordDisplayName || u.discordUsername || u.username || '—';
}

// discordAvatar is the raw Discord avatar HASH (not a URL) — build the CDN URL
// from it + discordId (matches Users.tsx / Profile.tsx). Returns null if we
// can't form a valid URL, so the caller renders no broken <img>.
function avatarUrl(u: { discordId: string | null; discordAvatar: string | null }, size = 32): string | null {
  if (!u.discordAvatar) return null;
  if (u.discordAvatar.startsWith('http')) return u.discordAvatar;
  if (!u.discordId) return null;
  return `https://cdn.discordapp.com/avatars/${u.discordId}/${u.discordAvatar}.png?size=${size}`;
}

export default function BanForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const presetUserId = params.get('userId') ?? '';
  const presetUsername = params.get('username') ?? '';

  const [userId, setUserId] = useState(presetUserId);
  const [userPreview, setUserPreview] = useState<UserLookupResult | null>(null);
  const [searchQuery, setSearchQuery] = useState(presetUsername);
  const [searchResults, setSearchResults] = useState<UserLookupResult[]>([]);
  const [category, setCategory] = useState<Category>('Spam');
  const [reasonText, setReasonText] = useState('');
  const [durationDays, setDurationDays] = useState<string>('7');
  const [permanent, setPermanent] = useState(false);
  const [evidenceText, setEvidenceText] = useState('');
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Resolve preset userId → preview
  useEffect(() => {
    if (!presetUserId) return;
    api.get<UserLookupResult[]>(`/api/moderation/users/lookup?q=${encodeURIComponent(presetUserId)}`)
      .then(rs => { if (rs && rs[0]) setUserPreview(rs[0]); })
      .catch(() => { /* leave preview empty */ });
  }, [presetUserId]);

  // Search-as-you-type when there's no preset userId
  useEffect(() => {
    if (presetUserId || !searchQuery.trim()) { setSearchResults([]); return; }
    const t = setTimeout(() => {
      api.get<UserLookupResult[]>(`/api/moderation/users/lookup?q=${encodeURIComponent(searchQuery.trim())}`)
        .then(setSearchResults)
        .catch(() => setSearchResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [searchQuery, presetUserId]);

  function pickUser(u: UserLookupResult) {
    setUserId(u.id);
    setUserPreview(u);
    setSearchQuery(name(u));
    setSearchResults([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) { setFeedback({ kind: 'err', msg: 'Pick a user first.' }); return; }
    if (!reasonText.trim()) { setFeedback({ kind: 'err', msg: 'Reason is required.' }); return; }
    if (!evidenceText.trim() && evidenceFiles.length === 0) { setFeedback({ kind: 'err', msg: 'At least one piece of evidence (image or text) is required.' }); return; }

    const fd = new FormData();
    fd.append('userId', userId);
    fd.append('category', category);
    fd.append('reasonText', reasonText);
    if (!permanent && durationDays) fd.append('durationDays', durationDays);
    if (evidenceText.trim()) fd.append('evidenceText', evidenceText);
    for (const f of evidenceFiles) fd.append('evidenceFiles', f);

    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.post<{
        banId: string;
        discordLockdown?: { warnings?: string[]; guildBanApplied?: boolean | null; rolesStripped?: number };
      }>('/api/moderation/bans', fd);
      // If Discord propagation surfaced warnings (missing perm, role above bot,
      // user not in guild, etc.), show them and pause longer so the mod can read.
      const warnings = res.discordLockdown?.warnings ?? [];
      if (warnings.length > 0) {
        setFeedback({ kind: 'err', msg: `Ban applied. Discord propagation issues: ${warnings.join(' · ')}` });
        setTimeout(() => navigate(`/moderation/bans/${res.banId}`), 4000);
      } else {
        setFeedback({ kind: 'ok', msg: 'Ban applied.' });
        setTimeout(() => navigate(`/moderation/bans/${res.banId}`), 600);
      }
    } catch (err: any) {
      setFeedback({ kind: 'err', msg: err.message });
    } finally {
      setBusy(false);
    }
  }

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', letterSpacing: '0.08em' };
  const fieldWrap: React.CSSProperties = { marginBottom: '14px' };

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '18px', marginBottom: '16px' }}>◈ NEW BAN</h1>

      <form onSubmit={handleSubmit}>
        <div style={fieldWrap}>
          <label style={labelStyle}>USER</label>
          {userPreview ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
              {avatarUrl(userPreview, 32) && <img src={avatarUrl(userPreview, 32)!} alt="" style={{ width: '32px', height: '32px', borderRadius: '50%' }} />}
              <div style={{ flex: 1 }}>
                <div style={{ color: 'var(--phosphor-color)' }}>{name(userPreview)}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{userPreview.id}</div>
              </div>
              {userPreview.isBanned && <span style={{ fontSize: '10px', color: 'var(--error)', border: '1px solid var(--error)', padding: '1px 5px' }}>ALREADY BANNED</span>}
              <button type="button" onClick={() => { setUserPreview(null); setUserId(''); setSearchQuery(''); }} style={{ padding: '2px 8px', fontSize: '11px' }}>CHANGE</button>
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search username, FO76 name, or Discord name..." style={{ width: '100%' }} />
              {searchResults.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg-panel)', border: '1px solid var(--border-color)', maxHeight: '240px', overflowY: 'auto' }}>
                  {searchResults.map(r => (
                    <div key={r.id} onClick={() => pickUser(r)} style={{ padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border-color)' }}>
                      {avatarUrl(r, 32) && <img src={avatarUrl(r, 32)!} alt="" style={{ width: '20px', height: '20px', borderRadius: '50%' }} />}
                      <span style={{ flex: 1, fontSize: '13px' }}>{name(r)}</span>
                      {r.isBanned && <span style={{ fontSize: '10px', color: 'var(--error)' }}>BANNED</span>}
                      {r.isMuted && <span style={{ fontSize: '10px', color: 'var(--warning)' }}>MUTED</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <div style={{ ...fieldWrap, flex: 1 }}>
            <label style={labelStyle}>CATEGORY</label>
            <select value={category} onChange={e => setCategory(e.target.value as Category)} style={{ width: '100%' }}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ ...fieldWrap, flex: 1 }}>
            <label style={labelStyle}>DURATION</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input type="number" min="1" max="3650" value={durationDays} onChange={e => setDurationDays(e.target.value)} disabled={permanent} style={{ width: '90px' }} />
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>days</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', marginLeft: '8px' }}>
                <input type="checkbox" checked={permanent} onChange={e => setPermanent(e.target.checked)} />
                Permanent
              </label>
            </div>
          </div>
        </div>

        <div style={fieldWrap}>
          <label style={labelStyle}>REASON (required, audited, visible in #general)</label>
          <textarea value={reasonText} onChange={e => setReasonText(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} maxLength={4000} required />
        </div>

        <div style={{ border: '1px solid var(--border-color)', padding: '12px', background: 'var(--bg-panel)', marginBottom: '14px' }}>
          <label style={{ ...labelStyle, marginBottom: '8px' }}>EVIDENCE (at least one of text or image required)</label>

          <div style={fieldWrap}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Pasted text / chat log</label>
            <textarea value={evidenceText} onChange={e => setEvidenceText(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} maxLength={8000} placeholder="Paste the offending messages or context here..." />
          </div>

          <div style={fieldWrap}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Screenshots (PNG/JPG/GIF/WebP, max 5 files / 10MB each)</label>
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={e => setEvidenceFiles(Array.from(e.target.files ?? []).slice(0, 5))} />
            {evidenceFiles.length > 0 && (
              <ul style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0', paddingLeft: '20px' }}>
                {evidenceFiles.map((f, i) => <li key={i}>{f.name} ({Math.round(f.size / 1024)} KB)</li>)}
              </ul>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
          <button type="submit" disabled={busy} className="danger">{busy ? 'BANNING...' : 'BAN USER'}</button>
          <button type="button" onClick={() => navigate('/moderation/bans')} disabled={busy}>CANCEL</button>
          {feedback && <span style={{ fontSize: '12px', color: feedback.kind === 'err' ? 'var(--error)' : 'var(--success)' }}>{feedback.msg}</span>}
        </div>
      </form>
    </div>
  );
}
