import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';

type PageState =
  | { kind: 'loading' }
  | { kind: 'need_auth'; nexusEnabled: boolean }
  | {
      kind: 'ready';
      fo76AccountName: string | null;
      providers: Array<{ provider: string; username: string | null }>;
    }
  | { kind: 'submitting' }
  | { kind: 'result'; success: boolean; message: string };

const DISCORD_INVITE = 'https://discord.gg/NJBJqyvRJC';

export default function LinkPage() {
  const [searchParams] = useSearchParams();
  const errorParam = searchParams.get('error');
  const linkedParam = searchParams.get('linked');
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [code, setCode] = useState('');

  useEffect(() => {
    const prev = document.title;
    document.title = 'Link Account - FCM';
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    fetch('/api/link/game', {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(async (r) => {
        if (r.status === 401) {
          const nexusCheck = await fetch('/auth/nexus', {
            method: 'HEAD',
            redirect: 'manual',
          }).catch(() => null);
          const nexusEnabled = nexusCheck ? nexusCheck.status !== 503 : false;
          setState({ kind: 'need_auth', nexusEnabled });
          return;
        }
        const json = await r.json();
        if (json.data) {
          setState({
            kind: 'ready',
            fo76AccountName: json.data.fo76AccountName,
            providers: json.data.providers ?? [],
          });
        }
      })
      .catch(() => setState({ kind: 'need_auth', nexusEnabled: false }));
  }, [linkedParam]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setState({ kind: 'submitting' });

    try {
      const r = await fetch('/api/link/redeem', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });

      if (r.ok) {
        setState({
          kind: 'result',
          success: true,
          message: 'In-game chat activated. You can now send messages.',
        });
        return;
      }

      const body = await r.json().catch(() => ({}));
      const status = r.status;
      let message = body.detail || 'An error occurred. Please try again.';
      if (status === 410) message = 'Link code has expired. Request a new one in-game.';
      if (status === 409) message = 'Link code has already been used. Request a new one in-game.';
      if (status === 404) message = 'Link code not found. Check the code and try again.';
      if (status === 429) message = 'Too many attempts. Wait a moment before trying again.';
      if (status === 403)
        message = 'You must sign in with Discord or Nexus before activating chat.';

      setState({ kind: 'result', success: false, message });
    } catch {
      setState({ kind: 'result', success: false, message: 'Network error. Please try again.' });
    }
  }

  const baseStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#0f0d04',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    fontFamily: 'Courier New, monospace',
    position: 'relative',
  };

  const cardStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '520px',
    border: '1px solid #C8A840',
    boxShadow: '0 0 40px rgba(200,168,64,0.12), inset 0 0 60px rgba(0,0,0,0.4)',
    background: '#1e1908',
    position: 'relative',
    zIndex: 1,
  };

  const innerStyle: React.CSSProperties = { padding: '32px 36px 28px' };

  const headerStyle: React.CSSProperties = {
    fontSize: '18px',
    fontWeight: 'bold',
    letterSpacing: '4px',
    color: '#C8A840',
    textShadow: '0 0 12px rgba(200,168,64,0.7)',
    marginBottom: '4px',
  };

  const subStyle: React.CSSProperties = {
    fontSize: '11px',
    letterSpacing: '3px',
    color: 'rgba(200,168,64,0.45)',
    marginBottom: '16px',
  };

  const divider: React.CSSProperties = {
    borderBottom: '1px solid rgba(200,168,64,0.3)',
    marginBottom: '24px',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '11px',
    letterSpacing: '2px',
    color: 'rgba(200,168,64,0.6)',
    marginBottom: '8px',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid rgba(200,168,64,0.4)',
    color: '#C8A840',
    fontFamily: 'Courier New, monospace',
    fontSize: '20px',
    letterSpacing: '6px',
    textAlign: 'center',
    padding: '12px 16px',
    textTransform: 'uppercase',
    marginBottom: '16px',
  };

  const btnStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '12px',
    background: 'rgba(200,168,64,0.15)',
    border: '1px solid #C8A840',
    color: '#C8A840',
    fontFamily: 'Courier New, monospace',
    fontSize: '12px',
    fontWeight: 'bold',
    letterSpacing: '2px',
    cursor: 'pointer',
    marginBottom: '10px',
  };

  const discordBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: 'rgba(88,101,242,0.15)',
    border: '1px solid #5865F2',
    textDecoration: 'none',
    textAlign: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
  };

  const nexusBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: 'rgba(218,160,40,0.10)',
    border: '1px solid #DA9F21',
    textDecoration: 'none',
    textAlign: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
  };

  const errorColor = 'rgba(255,68,68,0.9)';
  const successColor = '#18FF62';

  return (
    <div style={baseStyle}>
      {/* Scanlines */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundImage:
            'repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,0,0,0.18) 3px, rgba(0,0,0,0.18) 4px)',
          pointerEvents: 'none',
          zIndex: 100,
        }}
      />

      <div style={cardStyle}>
        <div style={innerStyle}>
          <div style={headerStyle}>FALLOUT CHAT MOD</div>
          <div style={subStyle}>IN-GAME CHAT ACTIVATION</div>
          <div style={divider} />

          {errorParam && (
            <div
              style={{
                background: 'rgba(255,68,68,0.08)',
                border: '1px solid rgba(255,68,68,0.3)',
                padding: '12px 14px',
                marginBottom: '20px',
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  letterSpacing: '2px',
                  color: errorColor,
                  fontWeight: 'bold',
                  marginBottom: '4px',
                }}
              >
                AUTH ERROR
              </div>
              <div style={{ fontSize: '11px', color: 'rgba(255,68,68,0.7)' }}>
                {errorParam === 'nexus_denied' && 'Nexus authorization was denied. Try again.'}
                {errorParam === 'account_banned' &&
                  'This account is not permitted to use FCM Chat.'}
                {errorParam === 'nexus_token' &&
                  'Failed to exchange Nexus authorization code. Try again.'}
                {!['nexus_denied', 'account_banned', 'nexus_token'].includes(errorParam) &&
                  'Authentication error. Please try again.'}
              </div>
            </div>
          )}

          {linkedParam === 'nexus' && (
            <div
              style={{
                background: 'rgba(24,255,98,0.06)',
                border: '1px solid rgba(24,255,98,0.3)',
                padding: '12px 14px',
                marginBottom: '20px',
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  letterSpacing: '2px',
                  color: successColor,
                  fontWeight: 'bold',
                }}
              >
                NEXUS ACCOUNT LINKED
              </div>
              <div
                style={{ fontSize: '11px', color: 'rgba(24,255,98,0.7)', marginTop: '4px' }}
              >
                Your Nexus identity has been linked. Enter your in-game code below.
              </div>
            </div>
          )}

          {state.kind === 'loading' && (
            <div style={{ color: 'rgba(200,168,64,0.55)', fontSize: '12px', letterSpacing: '1px' }}>
              &gt; AUTHENTICATING...
              <span style={{ color: '#FFE44D' }}>_</span>
            </div>
          )}

          {state.kind === 'need_auth' && (
            <>
              <div
                style={{
                  fontSize: '12px',
                  color: 'rgba(200,168,64,0.7)',
                  marginBottom: '20px',
                  lineHeight: '1.7',
                }}
              >
                To activate in-game chat, sign in with Discord or Nexus Mods first. Then enter
                the 8-character code shown in-game.
              </div>

              <a href="/auth/discord?intent=link" style={discordBtnStyle}>
                <svg width="18" height="18" viewBox="0 0 127.14 96.36" fill="#5865F2">
                  <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z" />
                </svg>
                SIGN IN WITH DISCORD
              </a>

              {state.nexusEnabled && (
                <a href="/auth/nexus" style={nexusBtnStyle}>
                  SIGN IN WITH NEXUS MODS
                </a>
              )}

              <div style={{ textAlign: 'center', marginTop: '16px' }}>
                <a
                  href={DISCORD_INVITE}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: 'rgba(200,168,64,0.4)',
                    fontSize: '11px',
                    letterSpacing: '1px',
                    textDecoration: 'none',
                  }}
                >
                  Don&apos;t have an account? Join our Discord &rarr;
                </a>
              </div>
            </>
          )}

          {(state.kind === 'ready' || state.kind === 'submitting') && (
            <>
              {state.kind === 'ready' && state.providers.length > 0 && (
                <div
                  style={{
                    fontSize: '11px',
                    color: 'rgba(200,168,64,0.55)',
                    marginBottom: '16px',
                  }}
                >
                  {state.providers.map((p) => (
                    <span key={p.provider} style={{ marginRight: '12px' }}>
                      {p.provider.toUpperCase()}: {p.username || 'linked'}
                    </span>
                  ))}
                </div>
              )}

              <div
                style={{
                  fontSize: '12px',
                  color: 'rgba(200,168,64,0.7)',
                  marginBottom: '20px',
                  lineHeight: '1.7',
                }}
              >
                Enter the 8-character code shown in your in-game chat window to activate chat.
              </div>

              <form onSubmit={handleSubmit}>
                <label style={labelStyle}>ACTIVATION CODE</label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 9))}
                  placeholder="XXXX-XXXX"
                  style={inputStyle}
                  maxLength={9}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={state.kind === 'submitting'}
                />
                <button
                  type="submit"
                  style={{ ...btnStyle, opacity: state.kind === 'submitting' ? 0.5 : 1 }}
                  disabled={
                    state.kind === 'submitting' || code.replace('-', '').length < 8
                  }
                >
                  {state.kind === 'submitting' ? 'VERIFYING...' : 'ACTIVATE CHAT'}
                </button>
              </form>
            </>
          )}

          {state.kind === 'result' && (
            <div
              style={{
                background: state.success ? 'rgba(24,255,98,0.06)' : 'rgba(255,68,68,0.06)',
                border: `1px solid ${state.success ? 'rgba(24,255,98,0.3)' : 'rgba(255,68,68,0.3)'}`,
                padding: '20px',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 'bold',
                  letterSpacing: '2px',
                  color: state.success ? successColor : errorColor,
                  marginBottom: '8px',
                }}
              >
                {state.success ? 'CHAT ACTIVATED' : 'ACTIVATION FAILED'}
              </div>
              <div
                style={{
                  fontSize: '12px',
                  color: state.success ? 'rgba(24,255,98,0.7)' : 'rgba(255,68,68,0.7)',
                  lineHeight: '1.7',
                }}
              >
                {state.message}
              </div>
              {!state.success && (
                <button
                  onClick={() => setState({ kind: 'need_auth', nexusEnabled: false })}
                  style={{ ...btnStyle, marginTop: '16px', marginBottom: 0 }}
                >
                  TRY AGAIN
                </button>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            borderTop: '1px solid #C8A840',
            padding: '5px 14px',
            display: 'flex',
            justifyContent: 'space-between',
            background: '#1e1908',
            fontSize: '11px',
            letterSpacing: '1px',
            color: 'rgba(200,168,64,0.6)',
          }}
        >
          <span>FCM // IN-GAME LINK</span>
          <span>falloutchatmod.com</span>
        </div>
      </div>
    </div>
  );
}
