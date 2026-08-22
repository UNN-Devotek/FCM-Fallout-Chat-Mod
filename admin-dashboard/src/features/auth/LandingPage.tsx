import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Player } from '@remotion/player';
import { ChatFeedGif } from '@promo/ChatFeedGif';
import { WikiFlowGif } from '@promo/WikiFlowVideo';
import { CommandsGif } from '@promo/CommandsGif';
import { PartyGif } from '@promo/PartyGif';
import { InfestGif } from '@promo/InfestGif';
import ChatOverlay from '../chat/ChatOverlay';
import { ModerationTab, MODERATION_SUBTABS } from './ModerationTab';
import CrtLineChart from '../system/components/CrtLineChart';
import PublicCommandsKeybindsPage from './PublicCommandsKeybindsPage';
import CosmeticsGuide from '../system/CosmeticsGuide';

// ── Pip-Boy nav bar (matches authed AdminLayout style) ───────────────────────
function PipboyNav({ activeTab = 'SYSTEM', subTabs = ['HOME'], activeSubTab = 'HOME', onTabClick, onSubTabClick }: {
  activeTab?: string; subTabs?: string[]; activeSubTab?: string;
  onTabClick?: (tab: string) => void; onSubTabClick?: (tab: string) => void;
}) {
  const tabs = ['CHAT', 'ABOUT', 'MODERATION', 'SYSTEM'];

  return (
    <div style={{ userSelect: 'none' }}>
      <div className="pipboy-tabs-row" style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', padding: '24px 36px 0', gap: '0' }}>
        {tabs.map((tab) => {
          const isActive = tab === activeTab;
          const isClickable = tab === 'CHAT' || tab === 'SYSTEM' || tab === 'MODERATION' || tab === 'ABOUT';
          return (
            <div key={tab}
              className="pipboy-tab"
              onClick={() => isClickable && onTabClick?.(tab)}
              style={{
                padding: '10px 32px 5px',
                fontSize: '26px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                color: isActive ? '#C8A840' : 'rgba(200,168,64,0.35)',
                borderTop: isActive ? '1px solid rgba(200,168,64,0.3)' : '1px solid transparent',
                borderLeft: isActive ? '1px solid rgba(200,168,64,0.3)' : '1px solid transparent',
                borderRight: isActive ? '1px solid rgba(200,168,64,0.3)' : '1px solid transparent',
                borderBottom: 'none',
                marginBottom: '-1px',
                background: isActive ? '#1e1908' : 'transparent',
                position: 'relative',
                zIndex: isActive ? 2 : 0,
                textShadow: isActive ? '0 0 8px rgba(200,168,64,0.4)' : 'none',
                minHeight: '32px',
                display: 'flex',
                alignItems: 'center',
                cursor: isClickable ? 'pointer' : 'default',
              }}>
              {tab}
            </div>
          );
        })}
        <div className="pipboy-tabs-separator" style={{ position: 'absolute', bottom: 0, left: 20, right: 20, height: '1px', background: 'rgba(200,168,64,0.3)', zIndex: 1 }} />
      </div>
      {subTabs.length > 0 && <div className="pipboy-subtabs" style={{ display: 'flex', gap: '28px', padding: '12px 36px 4px 74px', background: 'transparent', minHeight: '38px' }}>
          {subTabs.map((sub) => {
            const isSubActive = sub === activeSubTab;
            return (
              <span
                key={sub}
                className="pipboy-subtab"
                onClick={() => onSubTabClick?.(sub)}
                style={{
                  fontSize: '22px',
                  letterSpacing: '2px',
                  color: isSubActive ? '#C8A840' : 'rgba(200,168,64,0.35)',
                  fontWeight: isSubActive ? 'bold' : 'normal',
                  textShadow: isSubActive ? '0 0 6px rgba(200,168,64,0.6)' : 'none',
                  cursor: onSubTabClick ? 'pointer' : 'default',
                  transition: 'color 0.15s',
                }}
                onMouseEnter={(e) => { if (!isSubActive && onSubTabClick) e.currentTarget.style.color = 'rgba(200,168,64,0.65)'; }}
                onMouseLeave={(e) => { if (!isSubActive) e.currentTarget.style.color = 'rgba(200,168,64,0.35)'; }}
              >
                {sub}
              </span>
            );
          })}
      </div>}
    </div>
  );
}

// ── Bottom status bar ─────────────────────────────────────────────────────────
const BLOCKS = 20;

function ChargeBar() {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    let current = 0;
    let timer: ReturnType<typeof setTimeout>;

    function step() {
      current += 1;
      setLevel(current);
      if (current < BLOCKS) {
        timer = setTimeout(step, 1500);
      } else {
        // Hold full, then reset
        timer = setTimeout(() => {
          current = 0;
          setLevel(0);
          timer = setTimeout(step, 80);
        }, 700);
      }
    }

    timer = setTimeout(step, 80);
    return () => clearTimeout(timer);
  }, []);

  return (
    <span className="status-charge-bar" style={{ fontSize: '10px', letterSpacing: '1px' }}>
      <span style={{ color: 'rgba(200,168,64,0.85)' }}>{'█'.repeat(level)}</span>
      <span style={{ color: 'rgba(200,168,64,0.15)' }}>{'█'.repeat(BLOCKS - level)}</span>
    </span>
  );
}

function PipboyStatusBar({ version }: { version: string }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="landing-status-bar" style={{
      borderTop: '1px solid #C8A840',
      padding: '5px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: '24px',
      background: '#1e1908',
      fontSize: '14px',
      letterSpacing: '1px',
    }}>
      <span>VER <strong>{version}</strong></span>
      <ChargeBar />
      <span>LEVEL <strong>76</strong></span>
      <span style={{ marginLeft: 'auto', color: 'rgba(200,168,64,0.6)' }}>
        {time.toLocaleTimeString('en-US', { hour12: false })}
      </span>
    </div>
  );
}

// ── Typewriter hook ───────────────────────────────────────────────────────────
function useTypewriter(text: string, speed = 40) {
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

// ── Feature list items ────────────────────────────────────────────────────────
const FEATURES = [
  {
    id: 1,
    title: 'EULA-SAFE · PATCH-DAY PROOF',
    body: 'No game-file modification, no Script Extender, no reading of game memory — fully EULA-compliant. The external architecture means Bethesda can patch freely and chat never breaks; the client only detects whether Fallout 76 is running to show or hide the overlay.',
  },
  {
    id: 2,
    title: 'DISCORD BRIDGE & COMMUNITY INTEGRATIONS',
    body: 'In-game chat is mirrored to a Discord channel so the community stays in the loop even when they\'re not playing. Deep Discord integration ties it together — the live chat bridge, temporary voice channels, reaction roles, and rich embeds all run from the same governed platform.',
  },
  {
    id: 3,
    title: 'COMMUNITY GOVERNED · OPEN MODERATION',
    body: 'Admins moderate via a browser-based terminal — no client needed. Every message, channel, and report is visible and actionable, with audit logs, auto-mod filters, and role-based access built in. To catch hate speech and harassment that word lists miss, message text is screened by OpenAI\'s content-moderation service — the text only, never your username, account, or which channel you posted in.',
  },
  {
    id: 5,
    title: 'UPDATE NOTIFICATIONS · CUSTOMIZABLE OVERLAY',
    body: 'When a new version is available, the overlay shows a system notification — click it to open the Nexus Mods page and download the latest release. It\'s also fully customizable: theme colors, opacity, position, and rebindable hotkeys, all persisted across reinstalls.',
  },
];

// ── CRT icon logo ─────────────────────────────────────────────────────────────
function CrtLogo() {
  return (
    // Small top padding still gives the drop-shadow glow room so it is not
    // clipped by the parent's overflow:hidden, while sitting high in the panel.
    <div style={{ width: '100%', padding: '4px 0 4px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
      <img
        src="/fcm-icon.svg"
        alt="Fallout Chat Mod"
        style={{
          height: '108px',
          width: 'auto',
          maxWidth: '100%',
          display: 'block',
          filter: 'drop-shadow(0 0 12px rgba(200,168,64,0.6))',
          animation: 'fcm-glitch 15s infinite',
        }}
      />
    </div>
  );
}

// ── Public community stats ────────────────────────────────────────────────────
// Polls GET /api/public/stats (unauthenticated).
// Response: { data: { onlineNow, totalUsers, totalMessages,
//   usersOverTime: [{ bucket: ISO, total }], onlineOverTime: [{ bucket: ISO, online }] } }
interface PublicStats {
  onlineNow: number | null;
  totalUsers: number | null;
  totalMessages: number | null;
  usersOverTime: { bucket: string; total: number }[];
  onlineOverTime: { bucket: string; online: number }[];
}

const EMPTY_STATS: PublicStats = {
  onlineNow: null, totalUsers: null, totalMessages: null,
  usersOverTime: [], onlineOverTime: [],
};

function usePublicStats() {
  const [stats, setStats] = useState<PublicStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetch_() {
      try {
        const r = await fetch('/api/public/stats');
        if (!r.ok) return;
        const json = await r.json();
        const d = json?.data;
        if (!d || cancelled) return;
        setStats({
          onlineNow: typeof d.onlineNow === 'number' ? d.onlineNow : null,
          totalUsers: typeof d.totalUsers === 'number' ? d.totalUsers : null,
          totalMessages: typeof d.totalMessages === 'number' ? d.totalMessages : null,
          usersOverTime: Array.isArray(d.usersOverTime) ? d.usersOverTime : [],
          onlineOverTime: Array.isArray(d.onlineOverTime) ? d.onlineOverTime : [],
        });
      } catch {
        /* endpoint unreachable / not yet deployed — keep prior/empty state */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch_();
    const t = setInterval(fetch_, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return { stats, loading };
}

// Compact big-number formatter: 1234 → "1.2k", 1_500_000 → "1.5M".
function formatCount(n: number | null): string {
  if (n == null) return '--';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const v = n / 1_000_000;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}M`;
}

// ── Shared release data hook ──────────────────────────────────────────────────
interface ReleaseEntry {
  version: string;
  downloadUrl: string;
  releaseNotes: string;
  publishedAt: string;
}

// ── CLI install commands ──────────────────────────────────────────────────────
const WINDOWS_CLI = 'irm https://falloutchatmod.com/install.ps1 | iex';
const LINUX_CLI   = 'curl -fsSL https://falloutchatmod.com/install.sh | bash';

// ── Download URLs ─────────────────────────────────────────────────────────────
// Windows uses the server-authoritative `latest.downloadUrl`. Linux builds its
// ZIP URL from the version string. NOTE: `productName` is "Fallout Chat Mod"
// WITH spaces — a no-space name 404s (see CLAUDE.md).
const ELECTRON_BASE = 'https://falloutchatmod.com/downloads/electron';
function electronLinuxUrl(version: string): string {
  return `${ELECTRON_BASE}/${encodeURIComponent(`Fallout Chat Mod-${version}.AppImage (Linux).zip`)}`;
}

// Permanent VirusTotal link. The backend's GET /virustotal 302-redirects to the
// current scan permalink, so this URL never changes between releases.
const VIRUSTOTAL_URL = 'https://falloutchatmod.com/virustotal';

// Community Discord invite (shared with LoginPage, backend, overlay onboarding).
const DISCORD_INVITE = 'https://discord.gg/NJBJqyvRJC';


function useReleases() {
  const [latest, setLatest] = useState<ReleaseEntry | null>(null);
  const [history, setHistory] = useState<ReleaseEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/version').then(r => r.json()).catch(() => null),
      fetch('/api/releases').then(r => r.json()).catch(() => null),
    ]).then(([ver, rel]) => {
      if (ver?.data?.version) setLatest(ver.data);
      if (Array.isArray(rel?.data)) setHistory(rel.data);
      setLoading(false);
    });
  }, []);

  return { latest, history, loading };
}

// ── Patch Notes panel ─────────────────────────────────────────────────────────
function PatchNotesPanel() {
  const { history, loading } = useReleases();
  const typedLatest = useTypewriter(history[0]?.releaseNotes ?? '', 4);

  return (
    <div style={{ flex: 1, padding: '40px 36px', overflow: 'auto', background: '#1e1908' }}>
      <div style={{ fontSize: '13px', color: 'rgba(200,168,64,0.4)', letterSpacing: '3px', marginBottom: '28px' }}>
        RELEASE HISTORY
      </div>
      {loading && <div style={{ color: 'rgba(200,168,64,0.4)', letterSpacing: '2px' }}>LOADING...</div>}
      {!loading && history.length === 0 && (
        <div style={{ color: 'rgba(200,168,64,0.4)', letterSpacing: '2px' }}>NO RELEASES PUBLISHED</div>
      )}
      {history.map((r, i) => (
        <div key={r.version} style={{ marginBottom: '36px', paddingBottom: '36px', borderBottom: i < history.length - 1 ? '1px solid rgba(200,168,64,0.1)' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '20px', marginBottom: '12px' }}>
            <span style={{ fontSize: '20px', fontWeight: 'bold', letterSpacing: '2px', color: '#C8A840' }}>v{r.version}</span>
            <span style={{ fontSize: '13px', color: 'rgba(200,168,64,0.4)', letterSpacing: '1px' }}>
              {new Date(r.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
            </span>
            {i === 0 && (
              <span style={{ fontSize: '11px', letterSpacing: '2px', color: '#18c96a', border: '1px solid #18c96a', padding: '1px 8px' }}>LATEST</span>
            )}
          </div>
          <div style={{ fontSize: '15px', lineHeight: '1.8', color: 'rgba(200,168,64,0.8)', whiteSpace: 'pre-line' }}>
            {i === 0 ? typedLatest : r.releaseNotes}
            {i === 0 && typedLatest.length < r.releaseNotes.length && <span style={{ animation: 'pip-blink 1s step-end infinite', color: '#FFE44D' }}>█</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const LINUX_UNINSTALL_CLI = 'curl -fsSL https://falloutchatmod.com/uninstall.sh | bash';
const LINUX_PROTON_LAUNCH = 'PROTON_NO_WM_DECORATION=1 %command%';
const LINUX_KWIN_RECONFIGURE = 'qdbus org.kde.KWin /KWin reconfigure';
const LINUX_KDOTOOL_INSTALL = 'sudo pacman -S xdotool';

// ── Install panel ─────────────────────────────────────────────────────────────
function InstallPanel() {
  type CopyKey = 'win-cli' | 'lin-cli' | 'lin-uninstall' | 'lin-proton' | 'lin-kwin' | 'lin-kdotool';
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const { latest } = useReleases();
  const winUrl = latest?.downloadUrl ?? null;            // server-authoritative
  const linUrl = latest?.version ? electronLinuxUrl(latest.version) : null;
  const verTag = latest?.version ? `v${latest.version}` : '';

  function copy(text: string, key: CopyKey) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    }).catch(() => {});
  }

  // Primary download button — translucent amber fill with subtle glow.
  const downloadBtnStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    flexShrink: 0,
    padding: '11px 28px',
    border: '1px solid #C8A840',
    background: 'rgba(200,168,64,0.16)',
    color: '#E6C45A',
    fontSize: '14px',
    fontWeight: 'bold',
    letterSpacing: '1.8px',
    textDecoration: 'none',
    textAlign: 'center',
    textShadow: '0 0 8px rgba(200,168,64,0.55)',
    boxShadow: '0 0 14px rgba(200,168,64,0.25), inset 0 0 10px rgba(200,168,64,0.08)',
    transition: 'background 0.15s, box-shadow 0.15s',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  const dlHoverIn = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.currentTarget.style.background = 'rgba(200,168,64,0.28)';
    e.currentTarget.style.boxShadow = '0 0 22px rgba(200,168,64,0.4), inset 0 0 10px rgba(200,168,64,0.12)';
  };
  const dlHoverOut = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.currentTarget.style.background = 'rgba(200,168,64,0.16)';
    e.currentTarget.style.boxShadow = '0 0 14px rgba(200,168,64,0.25), inset 0 0 10px rgba(200,168,64,0.08)';
  };

  const downloadRowStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'center', marginTop: '12px',
  };

  const cmdCenterRowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'stretch', justifyContent: 'center',
    gap: '8px', marginTop: '12px',
  };


  const stepStyle: React.CSSProperties = {
    fontSize: '11px', letterSpacing: '2px', color: 'rgba(200,168,64,0.55)',
    marginTop: '16px', marginBottom: '8px', fontWeight: 'bold',
  };

  const panelStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '28px 36px',
    color: '#C8A840',
    fontFamily: 'inherit',
  };

  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: '11px',
    letterSpacing: '3px',
    color: '#C8A840',
    borderBottom: '1px solid rgba(200,168,64,0.25)',
    paddingBottom: '6px',
    marginBottom: '14px',
    marginTop: '28px',
  };

  const firstSectionHeaderStyle: React.CSSProperties = {
    ...sectionHeaderStyle,
    marginTop: 0,
  };

  const subHeaderStyle: React.CSSProperties = {
    fontSize: '10px',
    letterSpacing: '2px',
    color: 'rgba(200,168,64,0.6)',
    marginTop: '16px',
    marginBottom: '8px',
  };

  const bodyStyle: React.CSSProperties = {
    fontSize: '13px',
    lineHeight: '1.7',
    color: 'rgba(200,168,64,0.8)',
  };

  const noteStyle: React.CSSProperties = {
    fontSize: '12px',
    lineHeight: '1.6',
    color: 'rgba(200,168,64,0.55)',
    marginTop: '6px',
  };

  // Sized to content so the box + copy button sit centered together.
  const codeStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    fontFamily: 'monospace',
    fontSize: '12px',
    color: 'rgba(200,168,64,0.9)',
    background: 'rgba(200,168,64,0.06)',
    border: '1px solid rgba(200,168,64,0.18)',
    padding: '8px 12px',
    maxWidth: '440px',
    overflowX: 'auto',
    whiteSpace: 'nowrap',
    lineHeight: '1.4',
  };

  // Stretches to full height of the code box (alignItems:stretch on the row).
  const copyBtnStyle: React.CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    letterSpacing: '1px',
    fontWeight: 'bold',
    color: 'rgba(200,168,64,0.8)',
    background: 'rgba(200,168,64,0.06)',
    border: '1px solid rgba(200,168,64,0.22)',
    padding: '0 16px',
    minWidth: '74px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'color 0.1s, border-color 0.1s, background 0.1s',
  };

  const bulletStyle: React.CSSProperties = {
    fontSize: '13px',
    lineHeight: '1.7',
    color: 'rgba(200,168,64,0.8)',
    paddingLeft: '16px',
    marginTop: '4px',
  };

  const warningBoxStyle: React.CSSProperties = {
    marginTop: '10px',
    padding: '10px 14px',
    border: '1px solid rgba(200,168,64,0.2)',
    background: 'rgba(200,168,64,0.04)',
    fontSize: '12px',
    lineHeight: '1.6',
    color: 'rgba(200,168,64,0.6)',
  };

  return (
    <div style={panelStyle}>

      {/* ── VirusTotal scan — permanent public link at the very top ─────── */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
        <a
          href={VIRUSTOTAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '10px',
            padding: '9px 20px',
            border: '1px solid rgba(200,168,64,0.45)',
            background: 'rgba(200,168,64,0.06)',
            color: '#C8A840',
            fontSize: '12px', fontWeight: 'bold', letterSpacing: '1.5px',
            textDecoration: 'none', fontFamily: 'inherit',
            textShadow: '0 0 6px rgba(200,168,64,0.4)',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(200,168,64,0.14)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.7)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(200,168,64,0.06)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.45)'; }}
        >
          <span aria-hidden="true">🛡</span> VERIFY THIS RELEASE ON VIRUSTOTAL →
        </a>
      </div>

      {/* ── Windows ─────────────────────────────────────────────────── */}
      <div style={firstSectionHeaderStyle}>WINDOWS</div>

      <div style={subHeaderStyle}>STEP 1 — DOWNLOAD</div>
      <div style={bodyStyle}>
        Grab the installer ZIP, then unzip it and run
        &ldquo;Fallout Chat Mod Setup &hellip;.exe&rdquo;. It&apos;s a per-user install
        (no admin prompt). When a new version is released, you&apos;ll get a notification — click it to download from Nexus Mods.
      </div>
      <div className="install-dl-row" style={downloadRowStyle}>
        {winUrl ? (
          <a
            href={winUrl}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="install-dl-btn"
            style={downloadBtnStyle}
            onMouseEnter={dlHoverIn}
            onMouseLeave={dlHoverOut}
          >
            ↓ DOWNLOAD FOR WINDOWS {verTag}
          </a>
        ) : (
          <span className="install-dl-btn" style={{ ...downloadBtnStyle, opacity: 0.5, cursor: 'default' }}>↓ WINDOWS — UNAVAILABLE</span>
        )}
      </div>
      <div style={stepStyle}>STEP 2 (ALTERNATIVE) — ONE-LINE INSTALL</div>
      <div style={bodyStyle}>
        Prefer the terminal? Paste this into <strong style={{ color: '#C8A840' }}>PowerShell</strong> to
        download &amp; install in one step — no manual unzip needed.
      </div>
      <div className="install-cmd-row" style={cmdCenterRowStyle}>
        <code style={codeStyle}>{WINDOWS_CLI}</code>
        <button
          type="button"
          style={copyBtnStyle}
          onClick={() => copy(WINDOWS_CLI, 'win-cli')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#C8A840'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.5)'; e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(200,168,64,0.8)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.22)'; e.currentTarget.style.background = 'rgba(200,168,64,0.06)'; }}
        >
          {copied === 'win-cli' ? 'COPIED!' : 'COPY'}
        </button>
      </div>

      {/* ── Linux ───────────────────────────────────────────────────── */}
      <div style={sectionHeaderStyle}>LINUX</div>

      <div style={subHeaderStyle}>STEP 1 — DOWNLOAD</div>
      <div style={bodyStyle}>
        Download the AppImage ZIP and unzip it. See &ldquo;Run the AppImage&rdquo; below for the
        commands to make it executable and launch it.
      </div>
      <div className="install-dl-row" style={downloadRowStyle}>
        {linUrl ? (
          <a
            href={linUrl}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="install-dl-btn"
            style={downloadBtnStyle}
            onMouseEnter={dlHoverIn}
            onMouseLeave={dlHoverOut}
          >
            ↓ DOWNLOAD FOR LINUX {verTag}
          </a>
        ) : (
          <span className="install-dl-btn" style={{ ...downloadBtnStyle, opacity: 0.5, cursor: 'default' }}>↓ LINUX — UNAVAILABLE</span>
        )}
      </div>

      <div style={stepStyle}>STEP 2 (RECOMMENDED) — ONE-LINE INSTALL</div>
      <div style={bodyStyle}>
        The easiest path: paste this into a terminal. It downloads the AppImage, adds an
        app-menu launcher, and registers the overlay as a startup application.
      </div>
      <div className="install-cmd-row" style={cmdCenterRowStyle}>
        <code style={codeStyle}>{LINUX_CLI}</code>
        <button
          type="button"
          style={copyBtnStyle}
          onClick={() => copy(LINUX_CLI, 'lin-cli')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#C8A840'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.5)'; e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(200,168,64,0.8)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.22)'; e.currentTarget.style.background = 'rgba(200,168,64,0.06)'; }}
        >
          {copied === 'lin-cli' ? 'COPIED!' : 'COPY'}
        </button>
      </div>

      <div style={subHeaderStyle}>RUN THE APPIMAGE (MANUAL)</div>
      <div style={bodyStyle}>
        If you downloaded the ZIP above, extract it, then:
      </div>
      <div style={{ marginTop: '8px', padding: '10px 14px', border: '1px solid rgba(200,168,64,0.18)', background: 'rgba(200,168,64,0.04)' }}>
        <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)', display: 'block', lineHeight: '1.8' }}>
          chmod +x &quot;Fallout Chat Mod-&lt;version&gt;.AppImage&quot;<br />
          ./&quot;Fallout Chat Mod-&lt;version&gt;.AppImage&quot;
        </code>
      </div>
      <div style={warningBoxStyle}>
        If the AppImage won&apos;t launch, you may be missing <strong style={{ color: 'rgba(200,168,64,0.85)' }}>libfuse2</strong>.
        Run it with:{' '}
        <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>
          ./&quot;Fallout Chat Mod-&lt;version&gt;.AppImage&quot; --appimage-extract-and-run
        </code>
      </div>

      <div style={subHeaderStyle}>UNINSTALL</div>
      <div className="install-cmd-row" style={cmdCenterRowStyle}>
        <code style={codeStyle}>{LINUX_UNINSTALL_CLI}</code>
        <button
          type="button"
          style={copyBtnStyle}
          onClick={() => copy(LINUX_UNINSTALL_CLI, 'lin-uninstall')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#C8A840'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.5)'; e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(200,168,64,0.8)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.22)'; e.currentTarget.style.background = 'rgba(200,168,64,0.06)'; }}
        >
          {copied === 'lin-uninstall' ? 'COPIED!' : 'COPY'}
        </button>
      </div>

      {/* ── KDE Plasma (Wayland) — automatic z-order setup ──────────── */}
      <div style={sectionHeaderStyle}>KDE PLASMA (WAYLAND) — AUTOMATIC</div>

      <div style={bodyStyle}>
        On KDE Plasma (Wayland) the overlay configures itself on first launch — <strong style={{ color: '#C8A840' }}>nothing
        to do</strong>. It runs under XWayland and installs two <strong style={{ color: '#C8A840' }}>KWin rules</strong> so
        it stays above Fallout 76 even while the game is focused: one keeps the overlay above other
        windows, and one stops KWin promoting the game to the active-fullscreen layer (which would
        otherwise cover the overlay — borderless games still report themselves as fullscreen). Just run
        Fallout 76 in <strong style={{ color: '#C8A840' }}>Borderless Windowed</strong>. The game still fills the
        screen; loading screens and the in-game menus are unaffected.
      </div>

      <div style={{ ...subHeaderStyle, marginTop: '14px' }}>IF IT EVER SHOWS BEHIND THE GAME</div>
      <div style={bodyStyle}>
        Rare — only if the automatic setup couldn&apos;t run. Right-click the tray icon and choose{' '}
        <strong style={{ color: '#C8A840' }}>KDE: keep overlay above game</strong> (it re-applies the rules and
        reloads KWin), or import the bundled rule by hand: System Settings → Window Management → Window
        Rules → Import →{' '}
        <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>~/.config/Fallout Chat Mod/fallout-chatmod-keepabove.kwinrule</code>{' '}
        → Apply, then run (or log out / in):
      </div>
      <div className="install-cmd-row" style={cmdCenterRowStyle}>
        <code style={codeStyle}>{LINUX_KWIN_RECONFIGURE}</code>
        <button
          type="button"
          style={copyBtnStyle}
          onClick={() => copy(LINUX_KWIN_RECONFIGURE, 'lin-kwin')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#C8A840'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.5)'; e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(200,168,64,0.8)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.22)'; e.currentTarget.style.background = 'rgba(200,168,64,0.06)'; }}
        >
          {copied === 'lin-kwin' ? 'COPIED!' : 'COPY'}
        </button>
      </div>

      <div style={{ ...bodyStyle, marginTop: '8px' }}>
        Uninstalling removes these KWin rules and restores Fallout 76&apos;s fullscreen stacking.
      </div>

      {/* ── Wayland — in-game cursor lock ───────────────────────────── */}
      <div style={{ ...subHeaderStyle, marginTop: '18px' }}>IN-GAME CURSOR LOCK (WAYLAND)</div>
      <div style={bodyStyle}>
        On Wayland the compositor drops Fallout 76&apos;s mouse-lock while the overlay sits on top, so the
        cursor could drift off the game. <strong style={{ color: '#C8A840' }}>The installer enables it for
        you via protontricks</strong> — the <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>grabfullscreen</code> winetricks
        verb (Fullscreen) plus a <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>GrabPointer</code> setting
        (Borderless-Windowed), so the cursor stays locked in either display mode. No Wine config is
        hand-edited, and protontricks is auto-installed if missing. X11 sessions don&apos;t need this.
      </div>
      <div style={{ ...bodyStyle, marginTop: '8px' }}>
        It can only do this if you&apos;ve <strong style={{ color: '#C8A840' }}>launched Fallout 76
        at least once</strong> (so its Proton prefix exists) and the game is closed. If not, run the game
        once, then re-run the installer — or right-click the tray icon and choose{' '}
        <strong style={{ color: '#C8A840' }}>Fix in-game cursor lock (Wayland)</strong>.
      </div>
      <div style={{ ...bodyStyle, marginTop: '8px' }}>
        Manual method:{' '}
        <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>protontricks 1151340 grabfullscreen=y</code>{' '}
        (GUI equivalent: <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>protontricks 1151340 winecfg</code>{' '}
        → <strong style={{ color: '#C8A840' }}>Input</strong> tab → tick &ldquo;Automatically capture the
        mouse in full-screen windows&rdquo;). For Borderless too, also add{' '}
        <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>GrabPointer=Y</code>{' '}
        under the same <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'rgba(200,168,64,0.85)' }}>X11 Driver</code> key. Then run Fallout 76.
      </div>

      <div style={{ ...warningBoxStyle, marginTop: '14px' }}>
        ⚠ <strong style={{ color: 'rgba(200,168,64,0.85)' }}>Do NOT</strong> run the game inside{' '}
        <strong style={{ color: 'rgba(200,168,64,0.85)' }}>gamescope</strong> — its nested compositor
        isolates the game window and the overlay cannot render over it.
      </div>

      {/* ── KDE Plasma (Wayland) — hotkey release in other apps ─────── */}
      <div style={sectionHeaderStyle}>KDE PLASMA (WAYLAND) — HOTKEYS IN OTHER APPS</div>

      <div style={bodyStyle}>
        By default the overlay&apos;s hotkeys (<strong style={{ color: '#C8A840' }}>Insert / Delete / Home</strong>, etc.)
        stay registered the whole time Fallout 76 is running — so they get intercepted even when
        you tab away to Konsole, Discord, or a browser. Wayland hides the active window from apps,
        so the overlay needs <strong style={{ color: '#C8A840' }}>xdotool</strong> to detect when
        you&apos;re <em>not</em> in the game/overlay and release the keys.
        (<code style={{ fontFamily: 'monospace', fontSize: '12px' }}>kdotool</code> also works as a fallback.)
      </div>
      <div style={{ ...subHeaderStyle, marginTop: '12px' }}>INSTALL XDOTOOL, THEN RELAUNCH THE OVERLAY</div>
      <div className="install-cmd-row" style={cmdCenterRowStyle}>
        <code style={codeStyle}>{LINUX_KDOTOOL_INSTALL}</code>
        <button
          type="button"
          style={copyBtnStyle}
          onClick={() => copy(LINUX_KDOTOOL_INSTALL, 'lin-kdotool')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#C8A840'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.5)'; e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(200,168,64,0.8)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.22)'; e.currentTarget.style.background = 'rgba(200,168,64,0.06)'; }}
        >
          {copied === 'lin-kdotool' ? 'COPIED!' : 'COPY'}
        </button>
      </div>
      <div style={{ ...bodyStyle, marginTop: '8px' }}>
        Arch / CachyOS shown above. Debian/Ubuntu: <code style={{ fontFamily: 'monospace', fontSize: '12px' }}>sudo apt install xdotool</code>.
        Fedora: <code style={{ fontFamily: 'monospace', fontSize: '12px' }}>sudo dnf install xdotool</code>.
        Without xdotool (or kdotool) everything still works <strong style={{ color: 'rgba(200,168,64,0.85)' }}>except</strong> this
        key-release behavior — the overlay falls back to holding the hotkeys while the game runs (no crash, no other change).
      </div>

      {/* ── Non-KDE compositors (GNOME, wlroots) — conditional ──────── */}
      <div style={sectionHeaderStyle}>GNOME / NON-KDE COMPOSITORS — CONDITIONAL STEAM LAUNCH OPTION</div>

      <div style={bodyStyle}>
        <strong style={{ color: '#C8A840' }}>Only if you are on GNOME or another non-KDE compositor</strong> and
        the overlay won&apos;t stay on top: set this Steam Launch Option for Fallout 76.
      </div>
      <div style={{ ...subHeaderStyle, marginTop: '12px' }}>
        Steam → Fallout 76 → Properties → General → Launch Options
      </div>
      <div className="install-cmd-row" style={cmdCenterRowStyle}>
        <code style={codeStyle}>{LINUX_PROTON_LAUNCH}</code>
        <button
          type="button"
          style={copyBtnStyle}
          onClick={() => copy(LINUX_PROTON_LAUNCH, 'lin-proton')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#C8A840'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.5)'; e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(200,168,64,0.8)'; e.currentTarget.style.borderColor = 'rgba(200,168,64,0.22)'; e.currentTarget.style.background = 'rgba(200,168,64,0.06)'; }}
        >
          {copied === 'lin-proton' ? 'COPIED!' : 'COPY'}
        </button>
      </div>
      <div style={{ ...warningBoxStyle, border: '1px solid rgba(255,80,80,0.35)', background: 'rgba(255,80,80,0.05)' }}>
        ⚠ <strong style={{ color: 'rgba(255,160,100,0.95)' }}>KDE Plasma users: do NOT set this.</strong>{' '}
        On KDE, <code style={{ fontFamily: 'monospace', fontSize: '12px' }}>PROTON_NO_WM_DECORATION=1</code> is
        not needed and has been confirmed to push the overlay <em>behind</em> the game window.
        Use the KWin rule (above) instead.
      </div>

      {/* ── General notes ───────────────────────────────────────────── */}
      <div style={sectionHeaderStyle}>GENERAL NOTES</div>
      <div style={bulletStyle}>• Run Fallout 76 in <strong style={{ color: '#C8A840' }}>Borderless Windowed</strong> or <strong style={{ color: '#C8A840' }}>Windowed</strong> mode. <strong style={{ color: 'rgba(200,168,64,0.85)' }}>Exclusive Fullscreen</strong> gives the game exclusive GPU output — nothing can draw over it (OS/GPU limitation).</div>
      <div style={bulletStyle}>• The overlay is only visible while Fallout 76 is running. It hides automatically when the game closes.</div>
      <div style={bulletStyle}>• When a new version is published, the overlay shows a system notification on next launch. Click it to open the Nexus Mods download page. The overlay does not download or install updates itself.</div>

    </div>
  );
}

// Pip-Boy link/button used by ABOUT, CONTACT, and WIKI panels.
const pipLinkBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '10px',
  padding: '12px 26px',
  border: '1px solid #C8A840',
  background: 'rgba(200,168,64,0.1)',
  color: '#C8A840',
  fontSize: '15px', fontWeight: 'bold', letterSpacing: '2px',
  textDecoration: 'none', fontFamily: 'inherit',
  textShadow: '0 0 8px rgba(200,168,64,0.6)',
  boxShadow: '0 0 12px rgba(200,168,64,0.15)',
  transition: 'background 0.15s',
};
const pipLinkHoverIn = (e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.background = 'rgba(200,168,64,0.22)'; };
const pipLinkHoverOut = (e: React.MouseEvent<HTMLAnchorElement>) => { e.currentTarget.style.background = 'rgba(200,168,64,0.1)'; };

function ContactUsPanel() {
  return (
    <div style={{ flex: 1, padding: '48px 36px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px', background: '#1e1908' }}>
      <div style={{ fontSize: '13px', color: 'rgba(200,168,64,0.4)', letterSpacing: '3px' }}>CONTACT US</div>
      <div style={{ fontSize: '15px', color: 'rgba(200,168,64,0.8)', letterSpacing: '1px', textAlign: 'center', maxWidth: '520px', lineHeight: 1.7 }}>
        Questions, bug reports, or want to join the community? The fastest way to reach us is on Discord.
      </div>
      <a href={DISCORD_INVITE} target="_blank" rel="noopener noreferrer" style={pipLinkBtnStyle} onMouseEnter={pipLinkHoverIn} onMouseLeave={pipLinkHoverOut}>
        💬 JOIN OUR DISCORD →
      </a>
    </div>
  );
}

// ── ABOUT → FEATURES compositions ────────────────────────────────────────────
const PROMO_FEATURES = [
  {
    id: 'chat',
    title: 'LIVE CROSS-CHANNEL CHAT',
    Component: ChatFeedGif,
    durationInFrames: 270,
    fps: 30,
    compositionWidth: 480,
    compositionHeight: 490,
    body: 'Messages from General, Trading, Events, Raids, and Discord all arrive in a single unified feed in real time. Switch channels with a tab tap — everything is instantly bridged across platforms so nobody misses a beat.',
  },
  {
    id: 'wiki',
    title: 'WIKI & CAMP SEARCH',
    Component: WikiFlowGif,
    durationInFrames: 430,
    fps: 30,
    compositionWidth: 480,
    compositionHeight: 610,
    body: 'Type /wiki to search the full Fallout 76 wiki without leaving the game. /camp pulls up crafting info with a thumbnail. Results render as an inline panel inside the overlay — scroll, share, or post to chat with one click.',
  },
  {
    id: 'commands',
    title: 'SLASH COMMANDS',
    Component: CommandsGif,
    durationInFrames: 1080,
    fps: 30,
    compositionWidth: 480,
    compositionHeight: 490,
    body: 'The full command suite lives at your fingertips: /nukecodes pulls active silo codes, /serverstatus checks if FO76 is online, /g /t /e /r /i route your message to any channel. New commands ship with every update.',
  },
  {
    id: 'party',
    title: 'PARTY SYSTEM',
    Component: PartyGif,
    durationInFrames: 240,
    fps: 30,
    compositionWidth: 480,
    compositionHeight: 490,
    body: 'Create a party, invite members by username, and manage your squad without tabbing out. The party panel shows who\'s in, who\'s online, and lets you promote or remove members — all from inside the overlay.',
  },
  {
    id: 'infest',
    title: 'INFESTATION ALERTS',
    Component: InfestGif,
    durationInFrames: 270,
    fps: 30,
    compositionWidth: 480,
    compositionHeight: 430,
    body: 'The /i channel is built for coordinated infestation hunts. Report a spawn with /i <location>, get Discord-bridged replies, and coordinate in real time with players across sessions — without leaving Appalachia.',
  },
];

function AboutFeaturesPanel() {
  const [activeId, setActiveId] = React.useState(PROMO_FEATURES[0].id);
  const active = PROMO_FEATURES.find(f => f.id === activeId)!;
  const rightColRef = React.useRef<HTMLDivElement>(null);
  const [playerW, setPlayerW] = React.useState(360);
  const cycleRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    function update() {
      if (rightColRef.current) {
        const available = rightColRef.current.offsetWidth - 80;
        setPlayerW(Math.max(180, Math.min(360, available)));
      }
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Auto-cycle every 5.5 s. Manual selection cancels the pending timer
  // so the chosen feature dwells fully before auto-advancing.
  React.useEffect(() => {
    cycleRef.current = setTimeout(() => {
      setActiveId(prev => {
        const idx = PROMO_FEATURES.findIndex(f => f.id === prev);
        return PROMO_FEATURES[(idx + 1) % PROMO_FEATURES.length].id;
      });
    }, 5500);
    return () => { if (cycleRef.current) clearTimeout(cycleRef.current); };
  }, [activeId]);

  return (
    <div className="about-features-outer" style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden', background: '#1e1908' }}>

      {/* ── Left column — feature list ── */}
      <div className="about-features-list" style={{
        width: 260, flexShrink: 0,
        borderRight: '1px solid rgba(200,168,64,0.2)',
        display: 'flex', flexDirection: 'column',
        padding: '24px 0',
        overflowY: 'auto',
      }}>
        <div className="about-features-hdr" style={{ fontSize: '11px', letterSpacing: '3px', color: 'rgba(200,168,64,0.4)', padding: '0 24px', marginBottom: '16px' }}>
          FEATURES
        </div>
        {PROMO_FEATURES.map(f => {
          const isActive = activeId === f.id;
          return (
            <div
              key={f.id}
              className="about-features-item"
              onClick={() => { if (cycleRef.current) { clearTimeout(cycleRef.current); cycleRef.current = null; } setActiveId(f.id); }}
              style={{
                padding: '14px 24px',
                cursor: 'pointer',
                background: isActive ? '#C8A840' : 'transparent',
                color: isActive ? '#1e1908' : '#C8A840',
                fontSize: '13px', fontWeight: 'bold', letterSpacing: '1.5px',
                display: 'flex', alignItems: 'center', gap: '12px',
                transition: 'background 0.1s',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(200,168,64,0.08)'; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontSize: '10px', opacity: isActive ? 1 : 0.4, flexShrink: 0 }}>■</span>
              {f.title}
            </div>
          );
        })}
      </div>

      {/* ── Right column — Player + description side by side ── */}
      <div ref={rightColRef} className="about-features-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '36px 40px', display: 'flex', gap: '40px', alignItems: 'flex-start' }}>

        {/* Remotion Player — renders the composition live in-browser */}
        <div className="about-player-wrap" style={{
          flexShrink: 0,
          border: '1px solid rgba(200,168,64,0.25)',
          boxShadow: '0 0 30px rgba(200,168,64,0.1), 0 0 0 1px rgba(200,168,64,0.1)',
        }}>
          <Player
            key={active.id}
            component={active.Component}
            inputProps={{}}
            durationInFrames={active.durationInFrames}
            fps={active.fps}
            compositionWidth={active.compositionWidth}
            compositionHeight={active.compositionHeight}
            style={{
              width: playerW,
              height: Math.round(playerW * active.compositionHeight / active.compositionWidth),
              display: 'block',
            }}
            autoPlay
            loop
          />
        </div>

        {/* Text */}
        <div className="about-features-text-col" style={{ paddingTop: '8px', flex: 1, minWidth: 0 }}>
          <div className="about-features-text-title" style={{
            fontSize: '22px', fontWeight: 'bold', letterSpacing: '2px',
            color: '#C8A840', textShadow: '0 0 12px rgba(200,168,64,0.5)',
            marginBottom: '16px',
          }}>
            {active.title}
          </div>
          <div style={{ fontSize: '15px', color: 'rgba(200,168,64,0.8)', lineHeight: 1.8 }}>
            {active.body}
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Main landing page ─────────────────────────────────────────────────────────
export default function LandingPage() {
  const [mainTab, setMainTab] = useState<'SYSTEM' | 'CHAT' | 'MODERATION' | 'ABOUT'>('SYSTEM');
  const [subTab, setSubTab] = useState<'HOME' | 'INSTALL' | 'PATCH NOTES' | 'CONTACT US' | 'FEATURES' | 'KEYBINDS' | 'APPEARANCE'>('HOME');
  const [moderationSubTab, setModerationSubTab] = useState<string>(MODERATION_SUBTABS[0]);
  const [activeFeature, setActiveFeature] = useState(FEATURES[0].id);
  const [liveVersion, setLiveVersion] = useState<string>('—');
  const headline = useTypewriter('FALLOUT CHAT MOD', 60);
  const { stats: liveStats, loading: statsLoading } = usePublicStats();

  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(j => {
      if (j?.data?.version) setLiveVersion(j.data.version);
    }).catch(() => {});
  }, []);

  const activeBody = FEATURES.find(f => f.id === activeFeature)?.body ?? '';
  const typedBody = useTypewriter(activeBody, 28);

  useEffect(() => { // sync browser tab title
    const raw =
      mainTab === 'CHAT' ? 'CHAT' :
      mainTab === 'MODERATION' ? moderationSubTab :
      subTab;
    const label = raw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    document.title = `${label} - Fallout Chat Mod`;
  }, [mainTab, subTab, moderationSubTab]);

  // Auto-cycle: after the typewriter finishes, dwell then advance to the next feature.
  const FEATURE_DWELL_MS = 5500;
  const cycleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function advanceFeature() {
    setActiveFeature(prev => {
      const idx = FEATURES.findIndex(f => f.id === prev);
      return FEATURES[(idx + 1) % FEATURES.length].id;
    });
  }

  // Cancel any pending dwell timer; the effect below re-arms it.
  function startCycle() {
    if (cycleRef.current) { clearTimeout(cycleRef.current); cycleRef.current = null; }
  }

  // Re-arm once typing finishes; while still typing no timer is pending.
  const typingDone = typedBody.length >= activeBody.length && activeBody.length > 0;
  useEffect(() => {
    if (!typingDone) return;
    cycleRef.current = setTimeout(advanceFeature, FEATURE_DWELL_MS);
    return () => { if (cycleRef.current) { clearTimeout(cycleRef.current); cycleRef.current = null; } };
  }, [typingDone, activeFeature]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="landing-root" style={{
      minHeight: '100vh',
      background: '#0f0d04',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Scanline and vignette handled globally in index.css */}

      {/* Pip-Boy terminal frame */}
      <div className="landing-frame" style={{
        width: '100%',
        maxWidth: '1400px',
        height: '720px',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid #C8A840',
        boxShadow: '0 0 40px rgba(200,168,64,0.12), inset 0 0 60px rgba(0,0,0,0.4)',
        background: '#1e1908',
        position: 'relative',
        zIndex: 1,
      }}>
        <PipboyNav
          activeTab={mainTab}
          subTabs={
            mainTab === 'SYSTEM' ? ['HOME', 'INSTALL', 'PATCH NOTES', 'CONTACT US', 'KEYBINDS', 'APPEARANCE'] :
            mainTab === 'ABOUT' ? ['FEATURES'] :
            mainTab === 'MODERATION' ? MODERATION_SUBTABS :
            []
          }
          activeSubTab={mainTab === 'MODERATION' ? moderationSubTab : subTab}
          onTabClick={(t) => {
            setMainTab(t as 'SYSTEM' | 'CHAT' | 'MODERATION' | 'ABOUT');
            if (t === 'SYSTEM') setSubTab('HOME');
            if (t === 'ABOUT') setSubTab('FEATURES');
            if (t === 'MODERATION') setModerationSubTab(MODERATION_SUBTABS[0]);
          }}
          onSubTabClick={(s) => {
            if (mainTab === 'MODERATION') setModerationSubTab(s);
            else setSubTab(s as 'HOME' | 'INSTALL' | 'PATCH NOTES' | 'CONTACT US' | 'FEATURES' | 'KEYBINDS' | 'APPEARANCE');
          }}
        />

        {/* Main content area — fills remaining frame height */}
        <div className="landing-home-content" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

          {mainTab === 'CHAT' && <ChatOverlay />}

          {mainTab === 'MODERATION' && <ModerationTab subTab={moderationSubTab} />}

          {mainTab === 'ABOUT' && subTab === 'FEATURES' && <AboutFeaturesPanel />}

          {mainTab === 'SYSTEM' && subTab === 'INSTALL' && <InstallPanel />}
          {mainTab === 'SYSTEM' && subTab === 'PATCH NOTES' && <PatchNotesPanel />}
          {mainTab === 'SYSTEM' && subTab === 'CONTACT US' && <ContactUsPanel />}
          {mainTab === 'SYSTEM' && subTab === 'KEYBINDS' && <PublicCommandsKeybindsPage />}
          {mainTab === 'SYSTEM' && subTab === 'APPEARANCE' && <CosmeticsGuide variant="public" />}

          {mainTab === 'SYSTEM' && subTab === 'HOME' && <>
          {/* ── Left panel: title + features ─────────────────────────────────── */}
          <div className="landing-home-left" style={{
            flex: 1,
            padding: '8px 36px 40px',
            overflowY: 'auto',
          }}>
            <div style={{ marginBottom: '36px' }}>
              <div className="landing-headline" style={{
                fontSize: '48px',
                fontWeight: 'bold',
                letterSpacing: '6px',
                color: '#C8A840',
                textShadow: '0 0 16px rgba(200,168,64,0.6), 0 0 32px rgba(200,168,64,0.2)',
                minHeight: '58px',
              }}>
                {headline}<span style={{ animation: 'pip-blink 1s step-end infinite', color: '#FFE44D' }}>█</span>
              </div>
              <div style={{ fontSize: '16px', color: 'rgba(200,168,64,0.75)', letterSpacing: '4px', marginTop: '8px' }}>
                Real-Time Community Chat for Fallout
              </div>
              {/* Official non-affiliation disclaimer (Bethesda/ZeniMax trademark). */}
              <div style={{ fontSize: '12px', color: 'rgba(200,168,64,0.7)', letterSpacing: '0.7px', marginTop: '12px', lineHeight: 1.7, maxWidth: '540px', fontWeight: 'bold', fontStyle: 'italic' }}>
                Unofficial fan project — not affiliated with, endorsed, or sponsored by Bethesda Softworks or ZeniMax Media. Fallout® is a trademark of ZeniMax Media, Inc.
              </div>
            </div>
            {/* Feature list */}
            {FEATURES.map((f) => (
              <div
                key={f.id}
                className="landing-feature-item"
                onClick={() => { setActiveFeature(f.id); startCycle(); }}
                onMouseEnter={() => { setActiveFeature(f.id); startCycle(); }}
                style={{
                  padding: '12px 16px',
                  marginBottom: '8px',
                  cursor: 'pointer',
                  background: activeFeature === f.id ? '#C8A840' : 'transparent',
                  color: activeFeature === f.id ? '#1e1908' : '#C8A840',
                  display: 'flex',
                  gap: '14px',
                  transition: 'background 0.1s',
                }}
              >
                <span className="landing-feature-icon" style={{ flexShrink: 0, opacity: activeFeature === f.id ? 1 : 0.5, fontSize: '18px' }}>■</span>
                <div>
                  <div className="landing-feature-title" style={{ fontWeight: 'bold', fontSize: '18px', letterSpacing: '1.5px' }}>
                    {f.title}
                  </div>
                  {activeFeature === f.id && (
                    <div className="landing-feature-body" style={{ fontSize: '15px', marginTop: '6px', color: '#1e1908', lineHeight: '1.6', minHeight: '46px' }}>
                      {typedBody}{typedBody.length < activeBody.length && <span style={{ animation: 'pip-blink 1s step-end infinite', color: '#FFE44D' }}>█</span>}
                    </div>
                  )}
                </div>
              </div>
            ))}

          </div>

          {/* ── Right panel: FCM logo + stats + CTA ─────────────────── */}
          <div className="landing-home-right" style={{
            width: '340px',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: '6px 28px 24px',
            boxSizing: 'border-box',
          }}>
            {/* Compact, non-scrolling content — everything fits under the logo */}
            <div className="landing-stats-inner" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
              <CrtLogo />

              {/* Community totals — big-number tiles (3-up grid) */}
              <div className="landing-stats-grid-wrap" style={{ width: '100%' }}>
                <div className="landing-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  {[
                    { label: 'ONLINE', value: formatCount(liveStats.onlineNow), accent: liveStats.onlineNow !== null && liveStats.onlineNow > 0 },
                    { label: 'USERS', value: formatCount(liveStats.totalUsers), accent: false },
                    { label: 'MESSAGES', value: formatCount(liveStats.totalMessages), accent: false },
                  ].map(({ label, value, accent }) => (
                    <div key={label} className="landing-stat-tile" style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                      padding: '8px 4px', border: '1px solid rgba(200,168,64,0.18)', background: 'rgba(200,168,64,0.04)',
                    }}>
                      <span className="landing-stat-value" style={{ fontWeight: 'bold', fontSize: '20px', lineHeight: 1, color: accent ? '#18c96a' : '#C8A840', textShadow: '0 0 8px rgba(200,168,64,0.4)' }}>
                        {value}
                      </span>
                      <span className="landing-stat-label" style={{ fontSize: '9px', letterSpacing: '1px', color: 'rgba(200,168,64,0.5)' }}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* One big dual-axis trend chart: cumulative users (left/gold) +
                  daily-peak online (right/green) over the shared 7-day axis.
                  Takes up most of the panel's remaining vertical space. */}
              <div style={{ width: '100%', flex: 1, minHeight: 0, borderTop: '1px solid rgba(200,168,64,0.2)', paddingTop: '8px', display: 'flex', flexDirection: 'column' }}>
                {(() => {
                  const placeholderCard = (msg: string): React.ReactNode => (
                    <div style={{
                      flex: 1, minHeight: 0,
                      border: '1px solid rgba(200,168,64,0.18)', background: 'rgba(200,168,64,0.04)',
                      padding: '8px 10px', display: 'flex', flexDirection: 'column',
                    }}>
                      <div style={{ fontSize: '10px', letterSpacing: '2px', color: 'rgba(200,168,64,0.4)' }}>COMMUNITY TREND · 7 DAYS</div>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: '10px', color: 'rgba(200,168,64,0.45)', letterSpacing: '2px' }}>{msg}</span>
                      </div>
                    </div>
                  );

                  if (statsLoading) return placeholderCard('LOADING...');

                  const hasData = liveStats.usersOverTime.length > 0 || liveStats.onlineOverTime.length > 0;
                  if (!hasData) return placeholderCard('NO DATA YET');

                  // The two series are aligned daily buckets of equal length/order.
                  // Use users' buckets as the shared X axis (fall back to online's).
                  const buckets = (liveStats.usersOverTime.length > 0 ? liveStats.usersOverTime : liveStats.onlineOverTime).map(p => p.bucket);

                  return (
                    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                      <CrtLineChart
                        title="COMMUNITY TREND · 7 DAYS"
                        bucketSize="day"
                        largeTooltip
                        fullBleed
                        showLegend={false}
                        buckets={buckets}
                        leftAxisColor="#C8A840"
                        rightAxisColor="#18c96a"
                        series={[{ key: 'users', label: 'Users', color: '#C8A840', values: liveStats.usersOverTime.map(p => p.total) }]}
                        rightAxisSeries={[{ key: 'online', label: 'Peak Online', color: '#18c96a', values: liveStats.onlineOverTime.map(p => p.online) }]}
                      />
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* CTA — outside the scrollable group, always pinned at bottom */}
            <div style={{ paddingTop: '12px', width: '100%', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <Link
                to="/login"
                style={{
                  display: 'block',
                  padding: '14px 0',
                  border: '1px solid #C8A840',
                  background: 'rgba(200,168,64,0.1)',
                  color: '#C8A840',
                  fontSize: '17px',
                  fontWeight: 'bold',
                  letterSpacing: '2px',
                  textDecoration: 'none',
                  textAlign: 'center',
                  textShadow: '0 0 8px rgba(200,168,64,0.6)',
                  boxShadow: '0 0 12px rgba(200,168,64,0.15)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(200,168,64,0.22)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(200,168,64,0.1)'; }}
              >
                ACCESS TERMINAL →
              </Link>
            </div>
          </div>
          </>}
        </div>

        <PipboyStatusBar version={liveVersion} />
      </div>

      <style>{`
        @keyframes pip-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes fcm-glitch {
          0%    { transform: translateX(0);     animation-timing-function: steps(1, end); }
          0.2%  { transform: translateX(-18px); animation-timing-function: steps(1, end); }
          0.35% { transform: translateX(14px);  animation-timing-function: steps(1, end); }
          0.5%  { transform: translateX(-10px); animation-timing-function: steps(1, end); }
          0.65% { transform: translateX(16px);  animation-timing-function: steps(1, end); }
          0.8%  { transform: translateX(-8px);  animation-timing-function: steps(1, end); }
          0.95% { transform: translateX(6px);   animation-timing-function: steps(1, end); }
          1.1%  { transform: translateX(0);     animation-timing-function: linear; }
          100%  { transform: translateX(0); }
        }

        /* ── Responsive: public landing ─────────────────────────────── */
        @media (max-width: 1024px) {
          .landing-root { padding: 16px !important; }
          .pipboy-tab { font-size: 20px !important; padding: 8px 20px 4px !important; }
          .pipboy-subtab { font-size: 17px !important; }
          .pipboy-subtabs { padding: 10px 24px 4px 40px !important; gap: 20px !important; }
        }

        @media (max-width: 768px) {
          /* Outer container + frame — safe-area insets keep content clear of
             notch / dynamic island (top) and home bar / gesture zone (bottom).
             Falls back to 24px on devices without insets. */
          .landing-root {
            padding: max(24px, env(safe-area-inset-top)) 0 max(24px, env(safe-area-inset-bottom)) !important;
            align-items: stretch !important;
            background: #000 !important;
          }
          .landing-frame {
            height: calc(100dvh - max(24px, env(safe-area-inset-top)) - max(24px, env(safe-area-inset-bottom))) !important;
            border-left: none !important;
            border-right: none !important;
          }

          /* Nav tabs — horizontal scroll, compact */
          .pipboy-tabs-row { padding: 8px 8px 0 !important; overflow-x: auto !important; scrollbar-width: none !important; -webkit-overflow-scrolling: touch; flex-wrap: nowrap !important; }
          .pipboy-tabs-row::-webkit-scrollbar { display: none; }
          .pipboy-tabs-separator { left: 8px !important; right: 8px !important; }
          .pipboy-tab { font-size: 14px !important; padding: 6px 14px 4px !important; letter-spacing: 1px !important; min-height: 26px !important; white-space: nowrap; }
          .pipboy-subtabs { padding: 6px 12px 4px 12px !important; gap: 14px !important; overflow-x: auto !important; scrollbar-width: none !important; flex-wrap: nowrap !important; min-height: 30px !important; }
          .pipboy-subtabs::-webkit-scrollbar { display: none; }
          .pipboy-subtab { font-size: 14px !important; white-space: nowrap; }

          /* Status bar — single row, charge bar hidden on mobile to save space */
          .landing-status-bar { gap: 12px !important; font-size: 12px !important; padding: 4px 10px !important; flex-wrap: nowrap !important; overflow: hidden; }
          .status-charge-bar { display: none !important; }

          /* HOME — stack panels vertically, content area scrolls */
          .landing-home-content { flex-direction: column !important; overflow-y: auto !important; overflow-x: hidden !important; -webkit-overflow-scrolling: touch; }
          .landing-home-left { padding: 12px 16px 16px !important; overflow-y: visible !important; flex: none !important; }
          .landing-headline { font-size: 26px !important; letter-spacing: 3px !important; min-height: 32px !important; }
          /* Feature cycling cards — tighter on mobile */
          .landing-feature-item { padding: 8px 10px !important; margin-bottom: 4px !important; gap: 8px !important; }
          .landing-feature-icon { font-size: 12px !important; }
          .landing-feature-title { font-size: 12px !important; letter-spacing: 0.5px !important; }
          .landing-feature-body { font-size: 11px !important; margin-top: 4px !important; min-height: 28px !important; }
          .landing-home-right {
            width: 100% !important;
            flex-shrink: 0 !important;
            flex: none !important;
            height: 480px !important;
            border-left: none !important;
            border-top: 1px solid rgba(200,168,64,0.2) !important;
            padding: 10px 16px 14px !important;
          }
          .landing-stats-inner { overflow: hidden !important; }
          /* Stat tiles — compact on mobile so the chart gets the space */
          .landing-stats-grid { gap: 4px !important; }
          .landing-stat-tile { padding: 4px 2px !important; }
          .landing-stat-value { font-size: 13px !important; }
          .landing-stat-label { font-size: 7px !important; letter-spacing: 0 !important; }

          /* ABOUT FEATURES — list becomes horizontal scroll bar, stacks vertically */
          .about-features-outer { flex-direction: column !important; }
          .about-features-list {
            width: 100% !important;
            flex-direction: row !important;
            overflow-x: auto !important;
            overflow-y: visible !important;
            border-right: none !important;
            border-bottom: 1px solid rgba(200,168,64,0.2) !important;
            padding: 0 !important;
            flex-shrink: 0 !important;
            scrollbar-width: none !important;
            max-height: none !important;
          }
          .about-features-list::-webkit-scrollbar { display: none; }
          .about-features-hdr { display: none !important; }
          .about-features-item { padding: 8px 12px !important; white-space: nowrap; flex-shrink: 0 !important; font-size: 11px !important; letter-spacing: 1px !important; gap: 6px !important; }
          .about-features-main { flex-direction: column !important; padding: 16px !important; gap: 16px !important; align-items: center !important; }
          .about-player-wrap { flex-shrink: 0; max-width: 100%; overflow: hidden; margin: 0 auto !important; }
          .about-features-text-title { display: none !important; }

          /* Install panel — buttons and command rows fit the content width */
          .install-cmd-row { justify-content: flex-start !important; flex-wrap: nowrap !important; }
          .install-cmd-row code { flex: 1 !important; min-width: 0 !important; max-width: none !important; overflow-x: auto !important; }
          .install-dl-row { display: block !important; }
          .install-dl-btn { display: block !important; width: 100% !important; box-sizing: border-box !important; white-space: normal !important; text-align: center !important; }
        }

        @media (max-width: 480px) {
          .landing-headline { font-size: 22px !important; letter-spacing: 2px !important; }
          .pipboy-tab { font-size: 12px !important; padding: 5px 10px 3px !important; }
          .landing-status-bar { font-size: 11px !important; }
        }
      `}</style>
    </div>
  );
}
