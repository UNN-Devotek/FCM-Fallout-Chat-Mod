import React, { useEffect, useRef, useState } from 'react';

function useTypewriter(text: string, speed = 7) {
  const [displayed, setDisplayed] = useState('');
  useEffect(() => {
    setDisplayed('');
    let i = 0;
    const t = setInterval(() => {
      setDisplayed(text.slice(0, ++i));
      if (i >= text.length) clearInterval(t);
    }, speed);
    return () => clearInterval(t);
  }, [text, speed]);
  return displayed;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModerationEntry {
  id: string;
  action: string;
  actor: string | null;
  target: string | null;
  reason: string | null;
  channelId: string | null;
  channelName: string | null;
  duration: string | null;
  created_at: string;
}

interface Channel {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  children?: Channel[];
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const GOLD = '#C8A840';
const GOLD_DIM = 'rgba(200,168,64,0.4)';
const GOLD_FAINT = 'rgba(200,168,64,0.12)';
const BG = '#1e1908';

const ACTION_META: Record<string, { label: string; color: string }> = {
  ban:            { label: 'BAN',     color: '#ff4444' },
  unban:          { label: 'UNBAN',   color: '#18c96a' },
  warn:           { label: 'WARN',    color: '#FFB000' },
  mute:           { label: 'MUTE',    color: '#ff8800' },
  unmute:         { label: 'UNMUTE',  color: '#18c96a' },
  kick:           { label: 'KICK',    color: '#ff6600' },
  message_deleted:{ label: 'DELETE',  color: GOLD_DIM  },
};

function ActionBadge({ action }: { action: string }) {
  const meta = ACTION_META[action] ?? { label: action.toUpperCase(), color: GOLD_DIM };
  return (
    <span style={{
      fontSize: '11px',
      fontWeight: 'bold',
      letterSpacing: '1.5px',
      color: meta.color,
      border: `1px solid ${meta.color}`,
      padding: '2px 7px',
      flexShrink: 0,
    }}>
      {meta.label}
    </span>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function inputStyle(focused: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${focused ? GOLD : 'rgba(200,168,64,0.25)'}`,
    color: GOLD,
    padding: '6px 12px',
    fontSize: '13px',
    letterSpacing: '1px',
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s',
  };
}

// ── Detail Modal ──────────────────────────────────────────────────────────────

function ModerationModal({ entry, onClose }: { entry: ModerationEntry; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const meta = ACTION_META[entry.action] ?? { label: entry.action.toUpperCase(), color: GOLD_DIM };

  const Row = ({ label, value }: { label: string; value: string | null }) => value ? (
    <div style={{ display: 'flex', gap: '16px', marginBottom: '14px', alignItems: 'flex-start' }}>
      <span style={{ width: '110px', flexShrink: 0, color: GOLD_DIM, fontSize: '12px', letterSpacing: '2px', paddingTop: '1px' }}>{label}</span>
      <span style={{ color: GOLD, fontSize: '14px', lineHeight: '1.5' }}>{value}</span>
    </div>
  ) : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.8)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: BG,
          border: `1px solid ${GOLD}`,
          boxShadow: `0 0 40px rgba(200,168,64,0.2)`,
          padding: '36px 40px',
          width: '520px',
          maxWidth: '90vw',
          position: 'relative',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' }}>
          <span style={{ fontSize: '22px', fontWeight: 'bold', letterSpacing: '3px', color: meta.color }}>
            {meta.label}
          </span>
          <span style={{ fontSize: '13px', color: GOLD_DIM, letterSpacing: '1px' }}>
            {new Date(entry.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: GOLD_DIM, fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}
          >
            ✕
          </button>
        </div>

        <Row label="MODERATOR"  value={entry.actor ?? 'System'} />
        <Row label="TARGET"     value={entry.target ?? '—'} />
        <Row label="REASON"     value={entry.reason ?? 'No reason provided'} />
        <Row label="CHANNEL"    value={entry.channelName ?? null} />
        <Row label="DURATION"   value={entry.duration ?? null} />
        <Row label="TIMESTAMP"  value={new Date(entry.created_at).toLocaleString()} />

        <div style={{ borderTop: `1px solid ${GOLD_FAINT}`, marginTop: '24px', paddingTop: '16px' }}>
          <p style={{ fontSize: '12px', color: GOLD_DIM, letterSpacing: '1px', lineHeight: '1.6', margin: 0 }}>
            This action was taken by a community moderator in accordance with our community guidelines.
            If you believe this action was taken in error, please contact a moderator via Discord.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Feed panel ────────────────────────────────────────────────────────────────

function ModerationFeedPanel() {
  const [entries, setEntries] = useState<ModerationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [channelId, setChannelId] = useState('');
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<ModerationEntry | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/channels').then(r => r.json()).then(j => {
      const flat: { id: string; name: string }[] = [];
      for (const ch of j.data ?? []) {
        flat.push({ id: ch.id, name: ch.name });
        for (const sub of ch.children ?? []) flat.push({ id: sub.id, name: `  ${sub.name}` });
      }
      setChannels(flat);
    }).catch(() => {});
  }, []);

  function fetchLog(q: string, ch: string) {
    setLoading(true);
    const params = new URLSearchParams({ limit: '50' });
    if (q) params.set('search', q);
    if (ch) params.set('channelId', ch);
    fetch(`/api/public/moderation-log?${params}`)
      .then(r => r.json())
      .then(j => { setEntries(j.data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }

  // Initial load + 30s refresh
  useEffect(() => { fetchLog(search, channelId); }, []);
  useEffect(() => {
    const t = setInterval(() => fetchLog(search, channelId), 30_000);
    return () => clearInterval(t);
  }, [search, channelId]);

  function onSearchChange(val: string) {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchLog(val, channelId), 400);
  }

  function onChannelChange(val: string) {
    setChannelId(val);
    fetchLog(search, val);
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#1e1908' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '12px', padding: '16px 28px', borderBottom: `1px solid ${GOLD_FAINT}`, alignItems: 'center' }}>
        <input
          placeholder="SEARCH BY NAME..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          style={{ ...inputStyle(searchFocused), flex: 1 }}
        />
        <select
          value={channelId}
          onChange={e => onChannelChange(e.target.value)}
          style={{
            ...inputStyle(false),
            background: BG,
            cursor: 'pointer',
            minWidth: '160px',
          }}
        >
          <option value="">ALL CHANNELS</option>
          {channels.map(c => (
            <option key={c.id} value={c.id}>{c.name.trim().toUpperCase()}</option>
          ))}
        </select>
        <span style={{ fontSize: '12px', color: GOLD_DIM, letterSpacing: '1px', flexShrink: 0 }}>
          AUTO-REFRESH 30S
        </span>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 28px' }}>
        {loading && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: GOLD_DIM, letterSpacing: '2px', fontSize: '13px' }}>
            LOADING...
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: GOLD_DIM, letterSpacing: '2px', fontSize: '13px' }}>
            NO MODERATION ACTIONS FOUND
          </div>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            onClick={() => setSelected(e)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '12px 0',
              borderBottom: `1px solid ${GOLD_FAINT}`,
              cursor: 'pointer',
              transition: 'background 0.1s',
            }}
            onMouseEnter={el => el.currentTarget.style.background = GOLD_FAINT}
            onMouseLeave={el => el.currentTarget.style.background = 'transparent'}
          >
            <ActionBadge action={e.action} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ color: GOLD, fontSize: '14px', fontWeight: 'bold' }}>
                {e.target ?? 'Unknown'}
              </span>
              {e.reason && (
                <span style={{ color: GOLD_DIM, fontSize: '13px', marginLeft: '10px' }}>
                  — {e.reason.length > 60 ? e.reason.slice(0, 60) + '…' : e.reason}
                </span>
              )}
            </div>
            {e.channelName && (
              <span style={{ fontSize: '12px', color: GOLD_DIM, letterSpacing: '1px', flexShrink: 0 }}>
                #{e.channelName}
              </span>
            )}
            <span style={{ fontSize: '12px', color: GOLD_DIM, letterSpacing: '1px', flexShrink: 0, minWidth: '60px', textAlign: 'right' }}>
              {timeAgo(e.created_at)}
            </span>
            <span style={{ fontSize: '14px', color: GOLD_DIM }}>›</span>
          </div>
        ))}
      </div>

      {selected && <ModerationModal entry={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ── Report panel ──────────────────────────────────────────────────────────────

const REPORT_INTRO = 'Reports are reviewed by our moderation team within 24 hours. Please only report content that clearly violates the guidelines below. Abuse of the report system is itself a violation.';

const REPORT_GUIDELINES = [
  { title: 'HARASSMENT & THREATS', body: 'Any messages targeting another player personally — insults, threats, intimidation, or sustained negative attention directed at an individual.' },
  { title: 'HATE SPEECH', body: 'Content that demeans people based on race, ethnicity, gender, sexuality, religion, or other protected characteristics.' },
  { title: 'SPAM & FLOODING', body: 'Repeated messages, character spam, or any content that disrupts the readability of chat for other players.' },
  { title: 'CHEATING & EXPLOITS', body: 'Advertising, promoting, or discussing the use of cheats, duplication exploits, or third-party tools that violate the game ToS.' },
  { title: 'ADVERTISING', body: 'Unsolicited promotion of external services, communities, or products not related to this community.' },
];
const REPORT_BULLETS_TEXT = REPORT_GUIDELINES.map(g => `${g.title}\n${g.body}`).join('\0');

function ReportPanel() {
  const typedIntro = useTypewriter(REPORT_INTRO);
  const introDone = typedIntro.length >= REPORT_INTRO.length;
  const typedBullets = useTypewriter(introDone ? REPORT_BULLETS_TEXT : '');
  const bulletsDone = typedBullets.length >= REPORT_BULLETS_TEXT.length;
  const parts = typedBullets.split('\0');

  return (
    <div className="mod-panel-outer" style={{ flex: 1, display: 'flex', gap: '40px', padding: '28px', overflow: 'hidden', background: '#1e1908' }}>
      {/* Guidelines */}
      <div className="mod-panel-body" style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ fontSize: '13px', color: GOLD_DIM, letterSpacing: '3px', marginBottom: '20px' }}>
          REPORTING GUIDELINES
        </div>
        <p style={{ fontSize: '14px', color: `rgba(200,168,64,0.7)`, lineHeight: '1.7', marginBottom: '24px', minHeight: '72px' }}>
          {typedIntro}{!introDone && <span style={{ color: '#FFE44D' }}>█</span>}
        </p>
        {parts.map((part, i) => {
          const nl = part.indexOf('\n');
          const title = nl >= 0 ? part.slice(0, nl) : part;
          const body  = nl >= 0 ? part.slice(nl + 1) : '';
          const isLast = i === parts.length - 1 && !bulletsDone;
          if (!title) return null;
          return (
            <div key={i} style={{ marginBottom: '18px', display: 'flex', gap: '14px' }}>
              <span style={{ color: GOLD, flexShrink: 0, fontSize: '10px', paddingTop: '4px' }}>■</span>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '1.5px', color: GOLD, marginBottom: '4px' }}>
                  {title}
                </div>
                {body && (
                  <div style={{ fontSize: '13px', color: `rgba(200,168,64,0.65)`, lineHeight: '1.6' }}>
                    {body}{isLast && <span style={{ color: '#FFE44D' }}>█</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* CTA */}
      <div className="mod-panel-cta" style={{ width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '20px' }}>
        <img src="/fcm-icon.svg" alt="" style={{ width: '100%', maxHeight: '90px', objectFit: 'contain', filter: 'drop-shadow(0 0 10px rgba(200,168,64,0.5))' }} />
        <div style={{ fontSize: '13px', color: GOLD_DIM, letterSpacing: '3px', textAlign: 'center' }}>
          SUBMIT A REPORT
        </div>
        <p style={{ fontSize: '13px', color: `rgba(200,168,64,0.6)`, textAlign: 'center', lineHeight: '1.7', margin: 0 }}>
          Log in with Discord to access the report form. Only registered community members can submit reports.
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
            color: GOLD,
            fontSize: '13px',
            fontWeight: 'bold',
            letterSpacing: '2px',
            textDecoration: 'none',
            boxShadow: '0 0 16px rgba(88,101,242,0.2)',
            transition: 'background 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(88,101,242,0.28)'; e.currentTarget.style.boxShadow = '0 0 24px rgba(88,101,242,0.35)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(88,101,242,0.15)'; e.currentTarget.style.boxShadow = '0 0 16px rgba(88,101,242,0.2)'; }}
        >
          <svg width="18" height="18" viewBox="0 0 127.14 96.36" fill="#5865F2">
            <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/>
          </svg>
          SIGN IN WITH DISCORD
        </a>
        <div style={{ fontSize: '11px', color: GOLD_DIM, textAlign: 'center', letterSpacing: '1px', lineHeight: '1.6' }}>
          In-game reports can also be submitted directly from the chat overlay.
        </div>
      </div>
    </div>
  );
}

// ── Apply panel ───────────────────────────────────────────────────────────────

const APPLY_INTRO = "We're always looking for dedicated community members to help keep Fallout Chat Mod a welcoming place. Staff members have access to the moderation dashboard, audit tools, and direct communication with the admin team.";

const APPLY_REQUIREMENTS = [
  'Active member of the Fallout Chat Mod community',
  'Member of the community Discord server',
  'Clean moderation history — no active bans or warnings',
  'Available for at least 5 hours of moderation per week',
  'Familiar with Fallout 76 and community norms',
  'Able to remain impartial when moderating disputes',
];
const APPLY_BULLETS_TEXT = APPLY_REQUIREMENTS.join('\0');

function ApplyPanel() {
  const typedIntro = useTypewriter(APPLY_INTRO);
  const introDone = typedIntro.length >= APPLY_INTRO.length;
  const typedBullets = useTypewriter(introDone ? APPLY_BULLETS_TEXT : '');
  const bulletsDone = typedBullets.length >= APPLY_BULLETS_TEXT.length;
  const parts = typedBullets.split('\0');

  return (
    <div className="mod-panel-outer" style={{ flex: 1, display: 'flex', gap: '40px', padding: '28px', overflow: 'hidden', background: '#1e1908' }}>
      {/* Requirements */}
      <div className="mod-panel-body" style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ fontSize: '13px', color: GOLD_DIM, letterSpacing: '3px', marginBottom: '20px' }}>
          STAFF REQUIREMENTS
        </div>
        <p style={{ fontSize: '14px', color: `rgba(200,168,64,0.7)`, lineHeight: '1.7', marginBottom: '24px', minHeight: '72px' }}>
          {typedIntro}{!introDone && <span style={{ color: '#FFE44D' }}>█</span>}
        </p>
        {parts.map((text, i) => {
          const isLast = i === parts.length - 1 && !bulletsDone;
          if (!text) return null;
          return (
            <div key={i} style={{ display: 'flex', gap: '14px', marginBottom: '14px', alignItems: 'flex-start' }}>
              <span style={{ color: '#18c96a', flexShrink: 0, fontSize: '14px', paddingTop: '1px' }}>✓</span>
              <span style={{ fontSize: '14px', color: `rgba(200,168,64,0.8)`, lineHeight: '1.5' }}>
                {text}{isLast && <span style={{ color: '#FFE44D' }}>█</span>}
              </span>
            </div>
          );
        })}
        {bulletsDone && (
          <div style={{ marginTop: '24px', padding: '16px', border: `1px solid ${GOLD_FAINT}` }}>
            <p style={{ fontSize: '13px', color: GOLD_DIM, lineHeight: '1.6', margin: 0 }}>
              Applications are reviewed by the admin team. You will be contacted via Discord if your application is successful.
              Do not ask admins about the status of your application — you will be notified when a decision is made.
            </p>
          </div>
        )}
      </div>

      {/* CTA */}
      <div className="mod-panel-cta" style={{ width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '20px' }}>
        <img src="/fcm-icon.svg" alt="" style={{ width: '100%', maxHeight: '90px', objectFit: 'contain', filter: 'drop-shadow(0 0 10px rgba(200,168,64,0.5))' }} />
        <div style={{ fontSize: '13px', color: GOLD_DIM, letterSpacing: '3px', textAlign: 'center' }}>
          APPLY FOR STAFF
        </div>
        <p style={{ fontSize: '13px', color: `rgba(200,168,64,0.6)`, textAlign: 'center', lineHeight: '1.7', margin: 0 }}>
          Sign in with Discord to submit a staff application. Your Discord profile and community standing will be reviewed.
        </p>
        <a
          href="/auth/discord?intent=apply"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            padding: '14px 0',
            background: 'rgba(88,101,242,0.15)',
            border: '1px solid #5865F2',
            color: GOLD,
            fontSize: '13px',
            fontWeight: 'bold',
            letterSpacing: '2px',
            textDecoration: 'none',
            boxShadow: '0 0 16px rgba(88,101,242,0.2)',
            transition: 'background 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(88,101,242,0.28)'; e.currentTarget.style.boxShadow = '0 0 24px rgba(88,101,242,0.35)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(88,101,242,0.15)'; e.currentTarget.style.boxShadow = '0 0 16px rgba(88,101,242,0.2)'; }}
        >
          <svg width="18" height="18" viewBox="0 0 127.14 96.36" fill="#5865F2">
            <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/>
          </svg>
          SIGN IN WITH DISCORD
        </a>
        <div style={{ fontSize: '11px', color: GOLD_DIM, textAlign: 'center', letterSpacing: '1px', lineHeight: '1.6' }}>
          Staff positions are voluntary. No compensation is provided.
        </div>
      </div>
    </div>
  );
}

// ── Root export ───────────────────────────────────────────────────────────────

type ModerationSubTab = 'FEED' | 'REPORT' | 'APPLY';

export const MODERATION_SUBTABS: ModerationSubTab[] = ['FEED', 'REPORT', 'APPLY'];

export function ModerationTab({ subTab }: { subTab: string }) {
  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .mod-panel-outer {
            flex-direction: column !important;
            overflow-y: auto !important;
            overflow-x: hidden !important;
            gap: 0 !important;
            padding: 16px !important;
          }
          .mod-panel-cta {
            width: 100% !important;
            flex-direction: row !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 12px !important;
            padding-bottom: 16px !important;
            border-bottom: 1px solid rgba(200,168,64,0.15);
            order: -1;
          }
          .mod-panel-cta img { width: 56px !important; max-height: 56px !important; flex-shrink: 0; }
          .mod-panel-body { overflow: visible !important; }
        }
      `}</style>
      {subTab === 'REPORT' && <ReportPanel />}
      {subTab === 'APPLY'  && <ApplyPanel />}
      {subTab !== 'REPORT' && subTab !== 'APPLY' && <ModerationFeedPanel />}
    </>
  );
}
