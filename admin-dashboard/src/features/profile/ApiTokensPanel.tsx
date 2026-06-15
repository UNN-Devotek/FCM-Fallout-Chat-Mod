import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface McpToken {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

interface MintResult {
  id: string;
  token: string;
  expiresAt: string;
}

// ── Styles (matching Profile.tsx conventions) ─────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  padding: '16px 18px',
  marginTop: '16px',
};

const kvLabel: React.CSSProperties = {
  fontSize: '10px',
  letterSpacing: '0.8px',
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  marginBottom: '2px',
};

const kvValue: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-primary)',
  wordBreak: 'break-all',
};

const dangerBtn: React.CSSProperties = {
  fontSize: '10px',
  padding: '2px 8px',
  letterSpacing: '1px',
  border: '1px solid rgba(255,68,68,0.5)',
  background: 'transparent',
  color: 'rgba(255,68,68,0.85)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  minHeight: 'unset',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TokenRow({
  token,
  onRevoke,
}: {
  token: McpToken;
  onRevoke: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 100px 100px 100px auto',
      gap: '12px',
      alignItems: 'center',
      padding: '8px 0',
      borderBottom: '1px dotted var(--border-color)',
      fontSize: '12px',
    }}>
      <div style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
        {token.label || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>unlabelled</span>}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{fmtDate(token.createdAt)}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{fmtDate(token.lastUsedAt)}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{fmtDate(token.expiresAt)}</div>
      <div>
        {confirming ? (
          <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              style={{ ...dangerBtn, borderColor: 'rgba(255,68,68,0.9)', color: 'rgba(255,68,68,1)' }}
              onClick={() => { onRevoke(token.id); setConfirming(false); }}
            >
              CONFIRM
            </button>
            <button
              style={{ fontSize: '10px', padding: '2px 6px', letterSpacing: '1px', minHeight: 'unset' }}
              onClick={() => setConfirming(false)}
            >
              CANCEL
            </button>
          </span>
        ) : (
          <button style={dangerBtn} onClick={() => setConfirming(true)}>
            REVOKE
          </button>
        )}
      </div>
    </div>
  );
}

function NewTokenBox({ token, onDismiss }: { token: MintResult; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleCopy() {
    navigator.clipboard.writeText(token.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div style={{
      background: 'rgba(212,176,64,0.06)',
      border: '1px solid rgba(212,176,64,0.5)',
      padding: '14px 16px',
      marginBottom: '14px',
    }}>
      <div style={{ fontSize: '11px', color: 'var(--phosphor-color)', letterSpacing: '1px', marginBottom: '8px', fontWeight: 'bold' }}>
        ◈ TOKEN GENERATED — COPY NOW
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
        This token will not be shown again. Paste it into your MCP client config as the{' '}
        <code style={{ color: 'var(--phosphor-color)', fontSize: '11px' }}>FCM_MCP_TOKEN</code> value.
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
        <input
          ref={inputRef}
          readOnly
          value={token.token}
          onClick={() => inputRef.current?.select()}
          style={{
            flex: 1,
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            background: 'var(--bg-dark)',
            border: '1px solid var(--border-color)',
            color: 'var(--phosphor-color)',
            padding: '6px 10px',
            letterSpacing: '0.5px',
          }}
        />
        <button onClick={handleCopy} style={{ fontSize: '11px', padding: '6px 14px', letterSpacing: '1px' }}>
          {copied ? 'COPIED!' : 'COPY'}
        </button>
      </div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
        Expires: {fmtDate(token.expiresAt)}
      </div>
      <div style={{ marginTop: '10px', textAlign: 'right' }}>
        <button onClick={onDismiss} style={{ fontSize: '10px', padding: '2px 8px', letterSpacing: '1px', minHeight: 'unset' }}>
          DONE
        </button>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function ApiTokensPanel() {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [mintResult, setMintResult] = useState<MintResult | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);

  const { data: tokens, isLoading, error } = useQuery({
    queryKey: ['mcp-tokens'],
    queryFn: () => api.get<McpToken[]>('/api/me/mcp-tokens'),
  });

  const mint = useMutation({
    mutationFn: () => api.post<MintResult>('/api/me/mcp-tokens', label.trim() ? { label: label.trim() } : {}),
    onSuccess: (result) => {
      setMintResult(result);
      setLabel('');
      setMintError(null);
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
    },
    onError: (e: Error) => {
      setMintError(e.message);
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/me/mcp-tokens/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
    },
  });

  return (
    <section style={card}>
      <header style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '10px',
        paddingBottom: '10px',
        marginBottom: '10px',
        borderBottom: '1px solid var(--border-color)',
      }}>
        <h2 style={{ margin: 0, fontSize: '13px', color: 'var(--phosphor-color)', letterSpacing: '1px' }}>
          ◈ API TOKENS
        </h2>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          (MCP / personal access · 90-day expiry)
        </span>
      </header>

      {/* Newly minted token — show-once box */}
      {mintResult && (
        <NewTokenBox token={mintResult} onDismiss={() => setMintResult(null)} />
      )}

      {/* Generate token form */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Label (optional)"
          maxLength={64}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            background: 'var(--bg-dark)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            padding: '5px 10px',
            width: '220px',
          }}
        />
        <button
          onClick={() => mint.mutate()}
          disabled={mint.isPending}
          style={{ fontSize: '11px', padding: '5px 14px', letterSpacing: '1px' }}
        >
          {mint.isPending ? 'GENERATING…' : 'GENERATE TOKEN'}
        </button>
      </div>

      {mintError && (
        <div style={{ color: 'var(--danger)', fontSize: '12px', marginBottom: '10px' }}>
          {mintError}
        </div>
      )}

      {/* Token list */}
      {isLoading ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Loading tokens…</div>
      ) : error ? (
        <div style={{ color: 'var(--danger)', fontSize: '12px' }}>
          {(error as Error).message}
        </div>
      ) : !tokens || tokens.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>
          No active tokens. Generate one above to use the MCP server.
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 100px 100px 100px auto',
            gap: '12px',
            paddingBottom: '6px',
            borderBottom: '1px solid var(--border-color)',
            marginBottom: '4px',
          }}>
            {['LABEL', 'CREATED', 'LAST USED', 'EXPIRES', ''].map((h, i) => (
              <div key={i} style={kvLabel}>{h}</div>
            ))}
          </div>

          {tokens.map(t => (
            <TokenRow key={t.id} token={t} onRevoke={(id) => revoke.mutate(id)} />
          ))}
        </>
      )}

      {revoke.isError && (
        <div style={{ color: 'var(--danger)', fontSize: '12px', marginTop: '8px' }}>
          Revoke failed: {(revoke.error as Error).message}
        </div>
      )}
    </section>
  );
}
