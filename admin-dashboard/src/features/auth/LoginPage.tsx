import React, { useEffect, useState } from 'react';

function useTypewriter(text: string, speed = 28) {
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
import { Link, useSearchParams } from 'react-router-dom';

function PipboyNav() {
  const tabs = ['CHAT', 'MODERATION', 'SYSTEM'];
  return (
    <div style={{ userSelect: 'none' }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', padding: '8px 20px 0', gap: '0' }}>
        {tabs.map((tab) => {
          const isActive = tab === 'SYSTEM';
          return (
            <div key={tab} style={{
              padding: '4px 18px 6px',
              fontSize: '14px',
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
            }}>
              {tab}
            </div>
          );
        })}
        <div style={{ position: 'absolute', bottom: 0, left: 20, right: 20, height: '1px', background: 'rgba(200,168,64,0.3)', zIndex: 1 }} />
      </div>
      <div style={{ display: 'flex', gap: '24px', padding: '4px 46px', background: 'transparent' }}>
        <span style={{ fontSize: '12px', letterSpacing: '2px', color: '#C8A840', fontWeight: 'bold', textShadow: '0 0 6px rgba(200,168,64,0.6)' }}>
          AUTHENTICATION
        </span>
      </div>
    </div>
  );
}

function TerminalLine({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const [visible, setVisible] = useState(delay === 0);
  useEffect(() => {
    if (delay > 0) {
      const t = setTimeout(() => setVisible(true), delay);
      return () => clearTimeout(t);
    }
  }, [delay]);
  if (!visible) return null;
  return (
    <div style={{ color: 'rgba(200,168,64,0.55)', fontSize: '12px', letterSpacing: '1px', marginBottom: '4px' }}>
      {children}
    </div>
  );
}

const DISCORD_INVITE = 'https://discord.gg/NJBJqyvRJC';

const ERROR_MESSAGES: Record<string, { title: string; body: string }> = {
  not_in_discord: {
    title: '◈ DISCORD MEMBERSHIP REQUIRED',
    body: 'You must join the Fallout Chat Mod Discord server before you can log in. Join using the link below, then try signing in again.',
  },
  no_role: {
    title: '◈ ACCESS DENIED',
    body: 'Your Discord account does not hold a required server role to access the admin dashboard. Contact a server administrator.',
  },
};

function ErrorModal({ error, onClose }: { error: string; onClose: () => void }) {
  const msg = ERROR_MESSAGES[error];
  if (!msg) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: '420px', width: '100%',
          background: '#1e1908',
          border: '1px solid rgba(200,168,64,0.6)',
          boxShadow: '0 0 40px rgba(200,168,64,0.15)',
          padding: '28px 32px',
          fontFamily: 'Courier New, monospace',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '2px', color: '#C8A840', marginBottom: '14px' }}>
          {msg.title}
        </div>
        <div style={{ fontSize: '12px', color: 'rgba(200,168,64,0.75)', lineHeight: '1.8', marginBottom: '22px' }}>
          {msg.body}
        </div>
        {error === 'not_in_discord' && (
          <a
            href={DISCORD_INVITE}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block', width: '100%', boxSizing: 'border-box',
              padding: '12px', textAlign: 'center',
              background: 'rgba(88,101,242,0.15)',
              border: '1px solid #5865F2',
              color: '#C8A840',
              textDecoration: 'none',
              fontSize: '12px', fontWeight: 'bold', letterSpacing: '2px',
              marginBottom: '10px',
            }}
          >
            JOIN DISCORD SERVER →
          </a>
        )}
        <button
          onClick={onClose}
          style={{
            display: 'block', width: '100%',
            padding: '10px',
            background: 'transparent',
            border: '1px solid rgba(200,168,64,0.3)',
            color: 'rgba(200,168,64,0.55)',
            fontFamily: 'Courier New, monospace',
            fontSize: '11px', letterSpacing: '2px',
            cursor: 'pointer',
          }}
        >
          CLOSE
        </button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const errorParam = searchParams.get('error');
  const [errorModal, setErrorModal] = useState<string | null>(errorParam && ERROR_MESSAGES[errorParam] ? errorParam : null);

  useEffect(() => {
    if (errorParam && ERROR_MESSAGES[errorParam]) {
      setErrorModal(errorParam);
      setSearchParams({}, { replace: true }); // strip ?error from URL
    }
  }, [errorParam, setSearchParams]);

  useEffect(() => {
    const prev = document.title;
    document.title = 'Login - FCM';
    return () => { document.title = prev; };
  }, []);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 1200);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f0d04',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Scanlines */}
      <div style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,0,0,0.18) 3px, rgba(0,0,0,0.18) 4px)',
        pointerEvents: 'none',
        zIndex: 100,
      }} />
      {/* Vignette */}
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.7) 100%)',
        pointerEvents: 'none',
        zIndex: 99,
      }} />

      {/* Terminal frame */}
      <div style={{
        width: '100%',
        maxWidth: '540px',
        border: '1px solid #C8A840',
        boxShadow: '0 0 40px rgba(200,168,64,0.12), inset 0 0 60px rgba(0,0,0,0.4)',
        background: '#1e1908',
        position: 'relative',
        zIndex: 1,
      }}>
        <div className="login-card-inner" style={{ padding: '32px 36px 28px', background: '#1e1908' }}>
          {/* Header */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{
              fontSize: '20px',
              fontWeight: 'bold',
              letterSpacing: '4px',
              color: '#C8A840',
              textShadow: '0 0 12px rgba(200,168,64,0.7), 0 0 24px rgba(200,168,64,0.3)',
              marginBottom: '4px',
              fontFamily: 'Courier New, monospace',
            }}>
              FALLOUT CHAT MOD
            </div>
            <div style={{
              fontSize: '11px',
              letterSpacing: '3px',
              color: 'rgba(200,168,64,0.45)',
              marginBottom: '8px',
            }}>
              AUTHENTICATION TERMINAL
            </div>
            <div style={{ borderBottom: '1px solid rgba(200,168,64,0.3)' }} />
          </div>

          {/* Boot sequence lines */}
          <div style={{ marginBottom: '28px', fontFamily: 'Courier New, monospace' }}>
            <TerminalLine delay={0}>  &gt; INITIALIZING SECURE CHANNEL...</TerminalLine>
            <TerminalLine delay={300}>  &gt; VAULT-TEC NETWORK: ONLINE</TerminalLine>
            <TerminalLine delay={700}>  &gt; IDENTITY VERIFICATION REQUIRED</TerminalLine>
            <TerminalLine delay={1100}>  &gt; AWAITING CREDENTIALS...<span style={{ animation: 'pip-blink 1s step-end infinite', color: '#FFE44D' }}>█</span></TerminalLine>
          </div>

          {/* Discord sign-in button */}
          {ready && (
            <a
              href="/auth/discord"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                padding: '14px 24px',
                background: 'rgba(88,101,242,0.15)',
                border: '1px solid #5865F2',
                color: '#C8A840',
                textDecoration: 'none',
                fontSize: '13px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                fontFamily: 'Courier New, monospace',
                boxShadow: '0 0 16px rgba(88,101,242,0.2)',
                transition: 'background 0.15s, box-shadow 0.15s',
                marginBottom: '16px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(88,101,242,0.28)';
                e.currentTarget.style.boxShadow = '0 0 24px rgba(88,101,242,0.35)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(88,101,242,0.15)';
                e.currentTarget.style.boxShadow = '0 0 16px rgba(88,101,242,0.2)';
              }}
            >
              <svg width="20" height="20" viewBox="0 0 127.14 96.36" fill="#5865F2">
                <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/>
              </svg>
              SIGN IN WITH DISCORD
            </a>
          )}

          {/* Join-our-Discord button — dark green, styled like the sign-in button above */}
          {ready && (
            <a
              href={DISCORD_INVITE}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                padding: '14px 24px',
                background: 'rgba(20,90,50,0.18)',
                border: '1px solid #1B7D3A',
                color: '#C8A840',
                textDecoration: 'none',
                fontSize: '13px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                fontFamily: 'Courier New, monospace',
                boxShadow: '0 0 16px rgba(27,125,58,0.22)',
                transition: 'background 0.15s, box-shadow 0.15s',
                marginBottom: '16px',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(27,125,58,0.32)';
                e.currentTarget.style.boxShadow = '0 0 24px rgba(27,125,58,0.4)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(20,90,50,0.18)';
                e.currentTarget.style.boxShadow = '0 0 16px rgba(27,125,58,0.22)';
              }}
            >
              <svg width="20" height="20" viewBox="0 0 127.14 96.36" fill="#1B7D3A">
                <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/>
              </svg>
              SIGN UP WITH DISCORD
            </a>
          )}

          {import.meta.env.DEV && import.meta.env.VITE_DEV_PERSONAS === 'true' && ready && (
            <div style={{ marginTop: '20px', borderTop: '1px solid rgba(200,168,64,0.2)', paddingTop: '16px' }}>
              <div style={{ fontSize: '10px', letterSpacing: '2px', color: 'rgba(200,168,64,0.35)', marginBottom: '10px', textAlign: 'center' }}>
                ── DEV ACCESS ──
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {[
                  { persona: 'admin',     label: 'SYSTEM ADMIN'     },
                  { persona: 'mod',       label: 'SYSTEM MOD'       },
                  { persona: 'supporter', label: 'SYSTEM SUPPORTER' },
                  { persona: 'user',      label: 'SYSTEM USER'      },
                ].map(({ persona, label }) => (
                  <a
                    key={persona}
                    href={`/auth/dev-login/${persona}`}
                    style={{
                      display: 'block',
                      padding: '9px 0',
                      textAlign: 'center',
                      background: 'rgba(24,255,98,0.06)',
                      border: '1px solid rgba(24,255,98,0.25)',
                      color: 'rgba(24,255,98,0.7)',
                      textDecoration: 'none',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      letterSpacing: '1px',
                      fontFamily: 'Courier New, monospace',
                      transition: 'background 0.1s, color 0.1s',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = 'rgba(24,255,98,0.14)';
                      e.currentTarget.style.color = '#18FF62';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = 'rgba(24,255,98,0.06)';
                      e.currentTarget.style.color = 'rgba(24,255,98,0.7)';
                    }}
                  >
                    {label}
                  </a>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                {[
                  { href: '/apply',  label: 'APPLY PAGE'  },
                  { href: '/report', label: 'REPORT PAGE' },
                ].map(({ href, label }) => (
                  <a
                    key={href}
                    href={href}
                    style={{
                      display: 'block',
                      padding: '9px 0',
                      textAlign: 'center',
                      background: 'rgba(24,255,98,0.06)',
                      border: '1px solid rgba(24,255,98,0.25)',
                      color: 'rgba(24,255,98,0.7)',
                      textDecoration: 'none',
                      fontSize: '11px',
                      fontWeight: 'bold',
                      letterSpacing: '1px',
                      fontFamily: 'Courier New, monospace',
                      transition: 'background 0.1s, color 0.1s',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = 'rgba(24,255,98,0.14)';
                      e.currentTarget.style.color = '#18FF62';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = 'rgba(24,255,98,0.06)';
                      e.currentTarget.style.color = 'rgba(24,255,98,0.7)';
                    }}
                  >
                    {label}
                  </a>
                ))}
              </div>
            </div>
          )}

          <div style={{ textAlign: 'center', marginTop: '16px' }}>
            <Link to="/" style={{
              color: 'rgba(200,168,64,0.4)',
              fontSize: '11px',
              letterSpacing: '1px',
              textDecoration: 'none',
            }}
              onMouseEnter={(e) => e.currentTarget.style.color = '#C8A840'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(200,168,64,0.4)'}
            >
              ← RETURN TO MAINFRAME
            </Link>
          </div>
        </div>

        <div style={{
          borderTop: '1px solid #C8A840',
          padding: '5px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          background: '#1e1908',
          fontSize: '11px',
          letterSpacing: '1px',
          color: 'rgba(200,168,64,0.6)',
        }}>
          <span>AUTH LEVEL: RESTRICTED</span>
          <span>ENCRYPTION: ACTIVE</span>
        </div>
      </div>

      <style>{`
        @keyframes pip-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @media (max-width: 480px) {
          .login-card-inner { padding: 20px 16px 18px !important; }
        }
      `}</style>

      {errorModal && <ErrorModal error={errorModal} onClose={() => setErrorModal(null)} />}
    </div>
  );
}
