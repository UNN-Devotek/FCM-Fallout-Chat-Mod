import React, { useEffect, useState } from 'react';

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

const gold = '#C8A840';
const goldDim = 'rgba(200,168,64,0.5)';
const goldFaint = 'rgba(200,168,64,0.12)';
const bg = '#0f0d04';
const cardBg = '#1e1908';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '18px' }}>
      <label style={{ display: 'block', fontSize: '11px', color: goldDim, letterSpacing: '2px', marginBottom: '6px' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: goldFaint,
  border: `1px solid rgba(200,168,64,0.35)`,
  color: gold,
  padding: '8px 12px',
  fontSize: '13px',
  fontFamily: 'Courier New, monospace',
  outline: 'none',
  boxSizing: 'border-box',
};

export default function ApplyPage() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FormField[]>(DEFAULT_FIELDS);
  const [values, setValues] = useState<Record<string, string>>({});
  const [countdown, setCountdown] = useState(30);

  useEffect(() => {
    fetch('/auth/me/public')
      .then(r => r.json())
      .then(j => { if (j.authenticated) setUser(j.user); })
      .catch(() => {})
      .finally(() => setChecking(false));

    fetch('/api/commands')
      .then(r => r.json())
      .then(j => {
        const cmd = (j.data ?? []).find((c: any) => c.trigger === '/apply');
        if (cmd?.formFields) {
          try {
            const parsed: FormField[] = JSON.parse(cmd.formFields);
            if (parsed.length > 0) {
              setFields(parsed);
              setValues(Object.fromEntries(parsed.map(f => [f.key, ''])));
            }
          } catch { /* use defaults */ }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setValues(Object.fromEntries(fields.map(f => [f.key, ''])));
  }, [fields]);

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    const missing = fields.filter(f => f.required && !values[f.key]?.trim());
    if (missing.length > 0) { setError('All required fields must be filled.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, string> = { discordTag: getDisplayName(user) };
      for (const f of fields) body[f.key] = (values[f.key] ?? '').trim();
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    }
  }

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
        maxWidth: '680px',
        border: `1px solid ${gold}`,
        background: cardBg,
        boxShadow: `0 0 40px rgba(200,168,64,0.1)`,
        padding: 'clamp(20px, 5vw, 40px)',
      }}>
        <div style={{ fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px', marginBottom: '8px', textShadow: '0 0 10px rgba(200,168,64,0.4)' }}>
          STAFF APPLICATION
        </div>
        <div style={{ fontSize: '12px', color: goldDim, letterSpacing: '2px', marginBottom: '32px' }}>
          FALLOUT CHAT MOD — MODERATION TEAM
        </div>

        {checking && (
          <div style={{ color: goldDim, letterSpacing: '2px', fontSize: '13px' }}>LOADING...</div>
        )}

        {!checking && !user && (
          <div>
            <p style={{ fontSize: '14px', color: 'rgba(200,168,64,0.8)', lineHeight: '1.7', marginBottom: '24px' }}>
              You must sign in with Discord before submitting a staff application.
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
                href="/auth/dev-public/apply"
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
              APPLICATION SUBMITTED
            </div>
            <p style={{ fontSize: '14px', color: 'rgba(200,168,64,0.8)', lineHeight: '1.7', marginBottom: '20px' }}>
              Application submitted! We will review it and reach out via Discord if your application is successful.
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
              Applying as <span style={{ color: gold, fontWeight: 'bold' }}>{getDisplayName(user)}</span>
            </div>

            <Field label="DISCORD TAG">
              <input
                type="text"
                value={getDisplayName(user)}
                readOnly
                style={{ ...inputStyle, opacity: 0.7, cursor: 'default' }}
              />
            </Field>

            {fields.map(f => (
              <Field key={f.key} label={f.label + (f.required ? '' : ' (optional)')}>
                {f.type === 'textarea' ? (
                  <textarea
                    value={values[f.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                    rows={3}
                    placeholder={f.placeholder}
                    style={{ ...inputStyle, resize: 'vertical' }}
                    required={f.required}
                  />
                ) : (
                  <input
                    type="text"
                    value={values[f.key] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    style={inputStyle}
                    required={f.required}
                  />
                )}
              </Field>
            ))}

            {error && (
              <div style={{ color: '#ff4444', fontSize: '13px', marginBottom: '16px', letterSpacing: '1px' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
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
                marginTop: '8px',
              }}
              onMouseEnter={e => { if (!submitting) e.currentTarget.style.background = 'rgba(200,168,64,0.12)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              {submitting ? 'SUBMITTING...' : 'SUBMIT APPLICATION'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
