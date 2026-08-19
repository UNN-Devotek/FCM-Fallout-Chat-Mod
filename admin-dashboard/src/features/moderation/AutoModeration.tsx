import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WordFilter {
  id: string;
  phrase: string;
  is_regex: boolean;
  test_mode: boolean;
}

interface SpamSetting {
  key: string;
  value: string;
}

interface DiscordChannel {
  id: string;
  name: string;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
}

interface Channel {
  id: string;
  name: string;
}

type TriggerType = 'AI_MODERATION' | 'KEYWORD' | 'SPAM' | 'KEYWORD_PRESET' | 'MENTION_SPAM' | 'LINK';
type ActionType = 'BLOCK' | 'ALERT' | 'TIMEOUT' | 'MUTE_OVERLAY';

interface AutoModAction {
  type: ActionType;
  metadata?: { customMessage?: string; durationSeconds?: number };
}

interface TriggerMetadata {
  // KEYWORD
  keyword_filter?: string[];
  regex_patterns?: string[];
  allow_list?: string[];
  // KEYWORD_PRESET
  presets?: ('PROFANITY' | 'SEXUAL_CONTENT' | 'SLURS')[];
  // MENTION_SPAM
  mention_total_limit?: number;
  // SPAM
  dupe_limit?: number;
  dupe_window_ms?: number;
  rate_limit?: number;
  rate_window_ms?: number;
  // AI_MODERATION
  thresholds?: Record<string, number>;
  // Targeted-attack policy for preset slur rules
  require_target?: boolean;
}

function splitLines(s: string): string[] {
  return s.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Build the metadata payload without dropping server-owned policy fields.
 * In particular, require_target is what keeps the default slur rule scoped
 * to targeted attacks instead of ordinary game profanity.
 */
export function buildTriggerMetadata(
  triggerType: TriggerType,
  current: TriggerMetadata,
  fields: {
    keywords?: string;
    regexPatterns?: string;
    allowList?: string;
    linkAllowList?: string;
  },
): TriggerMetadata {
  if (triggerType === 'KEYWORD') {
    const meta: TriggerMetadata = {};
    const keywords = splitLines(fields.keywords ?? '');
    const regexPatterns = splitLines(fields.regexPatterns ?? '');
    const allowList = splitLines(fields.allowList ?? '');
    if (keywords.length) meta.keyword_filter = keywords;
    if (regexPatterns.length) meta.regex_patterns = regexPatterns;
    if (allowList.length) meta.allow_list = allowList;
    return meta;
  }

  if (triggerType === 'KEYWORD_PRESET') {
    const allowList = splitLines(fields.allowList ?? '');
    return {
      ...current,
      presets: current.presets ?? [],
      allow_list: allowList.length ? allowList : undefined,
    };
  }

  if (triggerType === 'LINK') {
    return { allow_list: splitLines(fields.linkAllowList ?? '') };
  }

  return { ...current };
}

interface AutoModRule {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: TriggerType;
  triggerMetadata: TriggerMetadata;
  actions: AutoModAction[];
  exemptChannelIds: string[];
  exemptRoles: string[];
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Tab type ─────────────────────────────────────────────────────────────────
type Tab = 'rules' | 'word-filter' | 'spam' | 'settings';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function actionsSummary(actions: AutoModAction[]): string {
  return actions.map((a) => a.type).join(', ') || '—';
}

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  AI_MODERATION: 'AI Moderation',
  KEYWORD: 'Keyword',
  SPAM: 'Spam (global)',
  KEYWORD_PRESET: 'Keyword Preset',
  MENTION_SPAM: 'Mention Spam',
  LINK: 'Link',
};

const ACTION_OPTS: ActionType[] = ['BLOCK', 'ALERT', 'TIMEOUT', 'MUTE_OVERLAY'];
export const TRIGGER_OPTS: TriggerType[] = ['AI_MODERATION', 'KEYWORD', 'KEYWORD_PRESET', 'MENTION_SPAM', 'LINK', 'SPAM'];
const PRESET_OPTS: ('PROFANITY' | 'SEXUAL_CONTENT' | 'SLURS')[] = ['PROFANITY', 'SEXUAL_CONTENT', 'SLURS'];

// ─── Empty rule form state ─────────────────────────────────────────────────────

function emptyRule(): Omit<AutoModRule, 'id' | 'createdAt' | 'updatedAt' | 'createdById'> {
  return {
    name: '',
    enabled: false,
    triggerType: 'KEYWORD',
    triggerMetadata: {},
    actions: [{ type: 'BLOCK' }],
    exemptChannelIds: [],
    exemptRoles: [],
  };
}

// ─── Rule Modal ───────────────────────────────────────────────────────────────

interface RuleModalProps {
  rule: AutoModRule | null;
  channels: Channel[];
  discordRoles: DiscordRole[];
  onClose: () => void;
  onSaved: () => void;
}

function RuleModal({ rule, channels, discordRoles, onClose, onSaved }: RuleModalProps) {
  const isEdit = !!rule;
  const [form, setForm] = useState<Omit<AutoModRule, 'id' | 'createdAt' | 'updatedAt' | 'createdById'>>(
    rule ? { name: rule.name, enabled: rule.enabled, triggerType: rule.triggerType, triggerMetadata: { ...rule.triggerMetadata }, actions: rule.actions.map(a => ({ ...a, metadata: a.metadata ? { ...a.metadata } : undefined })), exemptChannelIds: [...rule.exemptChannelIds], exemptRoles: [...rule.exemptRoles] }
         : emptyRule()
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keyword scratch values
  const [kwKeywords, setKwKeywords] = useState(form.triggerMetadata.keyword_filter?.join('\n') ?? '');
  const [kwRegex, setKwRegex] = useState(form.triggerMetadata.regex_patterns?.join('\n') ?? '');
  const [kwAllowList, setKwAllowList] = useState(form.triggerMetadata.allow_list?.join('\n') ?? '');
  const [linkAllowList, setLinkAllowList] = useState(form.triggerMetadata.allow_list?.join('\n') ?? '');
  const [timeoutDuration, setTimeoutDuration] = useState<string>(
    form.actions.find(a => a.type === 'TIMEOUT')?.metadata?.durationSeconds?.toString() ?? '60'
  );

  function setTriggerType(t: TriggerType) {
    setForm(f => ({ ...f, triggerType: t, triggerMetadata: {} }));
    setKwKeywords('');
    setKwRegex('');
    setKwAllowList('');
    setLinkAllowList('');
  }

  function toggleAction(type: ActionType) {
    setForm(f => {
      const has = f.actions.some(a => a.type === type);
      const actions = has ? f.actions.filter(a => a.type !== type) : [...f.actions, { type }];
      return { ...f, actions };
    });
  }

  function togglePreset(p: 'PROFANITY' | 'SEXUAL_CONTENT' | 'SLURS') {
    setForm(f => {
      const cur = f.triggerMetadata.presets ?? [];
      const next = cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p];
      return { ...f, triggerMetadata: { ...f.triggerMetadata, presets: next } };
    });
  }

  function toggleExemptChannel(id: string) {
    setForm(f => {
      const cur = f.exemptChannelIds;
      const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
      return { ...f, exemptChannelIds: next };
    });
  }

  function toggleExemptRole(id: string) {
    setForm(f => {
      const cur = f.exemptRoles;
      const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
      return { ...f, exemptRoles: next };
    });
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Name is required.'); return; }
    if (!form.actions.length) { setError('At least one action is required.'); return; }
    setSaving(true);
    setError(null);

    const meta = buildTriggerMetadata(form.triggerType, form.triggerMetadata, {
      keywords: kwKeywords,
      regexPatterns: kwRegex,
      allowList: kwAllowList,
      linkAllowList,
    });

    // Inject TIMEOUT duration
    const actions = form.actions.map(a => {
      if (a.type === 'TIMEOUT') {
        const secs = parseInt(timeoutDuration, 10);
        return { ...a, metadata: { durationSeconds: isNaN(secs) ? 60 : secs } };
      }
      return a;
    });

    const payload = { ...form, triggerMetadata: meta, actions };

    try {
      if (isEdit && rule) {
        await api.put(`/api/moderation/automod-rules/${rule.id}`, payload);
      } else {
        await api.post('/api/moderation/automod-rules', payload);
      }
      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const hasTimeout = form.actions.some(a => a.type === 'TIMEOUT');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg-dark)', border: '1px solid var(--border-color)', padding: '24px', width: '580px', maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
        <h2 style={{ fontSize: '14px', marginTop: 0, marginBottom: '20px', letterSpacing: '2px' }}>
          {isEdit ? '◈ EDIT RULE' : '◈ CREATE RULE'}
        </h2>

        {/* Name */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>RULE NAME</label>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ width: '100%' }} placeholder="e.g. Block Slurs" />
        </div>

        {/* Enabled */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
            Enabled (preset rules ship disabled — enable when ready)
          </label>
        </div>

        {/* Trigger Type */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>TRIGGER TYPE</label>
          <select value={form.triggerType} onChange={e => setTriggerType(e.target.value as TriggerType)} style={{ width: '100%' }}>
            {TRIGGER_OPTS.map(t => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
          </select>
        </div>

        {/* Trigger-specific config */}
        {form.triggerType === 'KEYWORD' && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>KEYWORDS (one per line)</label>
              <textarea value={kwKeywords} onChange={e => setKwKeywords(e.target.value)} rows={3} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} placeholder="badword&#10;anotherbadword" />
            </div>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>REGEX PATTERNS (one per line)</label>
              <textarea value={kwRegex} onChange={e => setKwRegex(e.target.value)} rows={2} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} placeholder="\\bword\\b" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>ALLOW LIST (one per line — exempts exact matches)</label>
              <textarea value={kwAllowList} onChange={e => setKwAllowList(e.target.value)} rows={2} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} placeholder="allowedword" />
            </div>
          </div>
        )}

        {form.triggerType === 'KEYWORD_PRESET' && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>PRESETS</label>
              {PRESET_OPTS.map(p => (
                <label key={p} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', marginBottom: '4px' }}>
                  <input type="checkbox" checked={(form.triggerMetadata.presets ?? []).includes(p)} onChange={() => togglePreset(p)} />
                  {p.replace(/_/g, ' ')}
                </label>
              ))}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>ALLOW LIST (overrides preset — one per line)</label>
              <textarea value={kwAllowList} onChange={e => setKwAllowList(e.target.value)} rows={2} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} placeholder="allowedword" />
            </div>
          </div>
        )}

        {form.triggerType === 'MENTION_SPAM' && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>MENTION LIMIT (per message)</label>
            <input type="number" min="1" value={form.triggerMetadata.mention_total_limit ?? 5}
              onChange={e => setForm(f => ({ ...f, triggerMetadata: { ...f.triggerMetadata, mention_total_limit: parseInt(e.target.value, 10) } }))}
              style={{ width: '120px' }} />
          </div>
        )}

        {form.triggerType === 'LINK' && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>DOMAIN ALLOW LIST (one per line — permitted domains)</label>
            <textarea value={linkAllowList} onChange={e => setLinkAllowList(e.target.value)} rows={3} style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }} placeholder="youtube.com&#10;twitch.tv" />
          </div>
        )}

        {form.triggerType === 'SPAM' && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', fontSize: '12px', color: 'var(--text-muted)' }}>
            This rule type reuses the global spam threshold settings configured in the <strong style={{ color: 'var(--text-secondary)' }}>SPAM</strong> tab.
          </div>
        )}

        {form.triggerType === 'AI_MODERATION' && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', fontSize: '12px', color: 'var(--text-muted)' }}>
            This rule consumes the shared OpenAI moderation verdict. Enable the global AI moderation kill switch and configure thresholds in the SETTINGS tab before enabling this rule.
          </div>
        )}

        {/* Actions */}
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>ACTIONS (select all that apply)</label>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {ACTION_OPTS.map(type => (
              <label key={type} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.actions.some(a => a.type === type)} onChange={() => toggleAction(type)} />
                {type}
              </label>
            ))}
          </div>
          {hasTimeout && (
            <div style={{ marginTop: '10px' }}>
              <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>TIMEOUT DURATION (seconds)</label>
              <input type="number" min="1" value={timeoutDuration} onChange={e => setTimeoutDuration(e.target.value)} style={{ width: '120px' }} />
            </div>
          )}
        </div>

        {/* Exempt Channels */}
        {channels.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>EXEMPT CHANNELS</label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {channels.map(ch => (
                <label key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.exemptChannelIds.includes(ch.id)} onChange={() => toggleExemptChannel(ch.id)} />
                  {ch.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Exempt Roles */}
        {discordRoles.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>EXEMPT ROLES</label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {discordRoles.map(r => (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.exemptRoles.includes(r.id)} onChange={() => toggleExemptRole(r.id)} />
                  {r.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <div className="error-message" style={{ marginBottom: '12px' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ color: 'var(--text-muted)', borderColor: 'var(--text-muted)' }}>CANCEL</button>
          <button type="button" onClick={handleSave} disabled={saving}>{saving ? 'SAVING...' : 'SAVE RULE'}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Rules Tab ────────────────────────────────────────────────────────────────

function RulesTab() {
  const queryClient = useQueryClient();
  const [modalRule, setModalRule] = useState<AutoModRule | null | 'new'>('new' as any);
  const [showModal, setShowModal] = useState(false);
  const [editRule, setEditRule] = useState<AutoModRule | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const { data: rules, isLoading, error: queryError } = useQuery({
    queryKey: ['automod-rules'],
    queryFn: () => api.get<AutoModRule[]>('/api/moderation/automod-rules'),
  });

  const { data: channels } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<Channel[]>('/api/channels'),
  });

  const { data: discordRoles } = useQuery({
    queryKey: ['discord-roles'],
    queryFn: () => api.get<DiscordRole[]>('/api/moderation/discord-roles'),
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['automod-rules'] });
  }

  async function handleToggle(rule: AutoModRule) {
    setToggling(rule.id);
    try {
      await api.patch(`/api/moderation/automod-rules/${rule.id}/toggle`, { enabled: !rule.enabled });
      refresh();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setToggling(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this rule?')) return;
    setDeleting(id);
    try {
      await api.delete(`/api/moderation/automod-rules/${id}`);
      refresh();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDeleting(null);
    }
  }

  const error = queryError ? (queryError as Error).message : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: 0 }}>
          Rule engine processes messages through all enabled rules in order. Preset rules ship <strong style={{ color: 'var(--warning)' }}>DISABLED</strong> — enable when ready.
        </p>
        <button onClick={() => { setEditRule(null); setShowModal(true); }} style={{ whiteSpace: 'nowrap', flexShrink: 0, marginLeft: '16px' }}>+ CREATE RULE</button>
      </div>

      {error && <div className="error-message">{error}</div>}
      {isLoading ? (
        <div className="loading">Loading rules...</div>
      ) : (
        <div className="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Trigger</th>
                <th>Actions</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(rules || []).map(rule => (
                <tr key={rule.id} data-testid="rule-row">
                  <td style={{ fontWeight: 'bold', fontSize: '13px' }}>{rule.name}</td>
                  <td style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{TRIGGER_LABELS[rule.triggerType]}</td>
                  <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{actionsSummary(rule.actions)}</td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '2px 8px', fontSize: '10px', fontWeight: 'bold', borderRadius: '3px',
                      background: rule.enabled ? 'rgba(24,255,98,0.12)' : 'rgba(255,255,255,0.06)',
                      color: rule.enabled ? 'var(--success)' : 'var(--text-muted)',
                      border: `1px solid ${rule.enabled ? 'rgba(24,255,98,0.3)' : 'rgba(255,255,255,0.1)'}`,
                    }}>
                      {rule.enabled ? 'ENABLED' : 'DISABLED'}
                    </span>
                  </td>
                  <td style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => handleToggle(rule)}
                      disabled={toggling === rule.id}
                      style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px', color: rule.enabled ? 'var(--warning)' : 'var(--success)' }}
                    >
                      {rule.enabled ? 'DISABLE' : 'ENABLE'}
                    </button>
                    <button
                      onClick={() => { setEditRule(rule); setShowModal(true); }}
                      style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                    >
                      EDIT
                    </button>
                    <button
                      className="danger"
                      onClick={() => handleDelete(rule.id)}
                      disabled={deleting === rule.id}
                      style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                    >
                      {deleting === rule.id ? '...' : 'DELETE'}
                    </button>
                  </td>
                </tr>
              ))}
              {(rules || []).length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--text-muted)' }}>No rules configured. Create your first rule above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <RuleModal
          rule={editRule}
          channels={channels || []}
          discordRoles={discordRoles || []}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Word Filter Tab ──────────────────────────────────────────────────────────

function WordFilterTab() {
  const queryClient = useQueryClient();

  const { data: filters, isLoading: loading, error: queryError } = useQuery({
    queryKey: ['word-filters'],
    queryFn: () => api.get<WordFilter[]>('/api/moderation/word-filter'),
  });
  const error = queryError ? (queryError as Error).message : null;

  const [newPhrase, setNewPhrase] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPhrase, setEditPhrase] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [bulkFeedback, setBulkFeedback] = useState<string | null>(null);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['word-filters'] });
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newPhrase.trim()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await api.post('/api/moderation/word-filter', { phrase: newPhrase.trim(), isRegex });
      setNewPhrase('');
      setIsRegex(false);
      refresh();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(`/api/moderation/word-filter/${id}`);
      refresh();
    } catch (err: any) {
      alert(err.message);
    }
  }

  function startEdit(f: WordFilter) {
    setEditingId(f.id);
    setEditPhrase(f.phrase);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditPhrase('');
    setEditError(null);
  }

  async function saveEdit(id: string) {
    if (!editPhrase.trim()) return;
    setEditError(null);
    try {
      await api.patch(`/api/moderation/word-filters/${id}`, { phrase: editPhrase.trim() });
      setEditingId(null);
      refresh();
    } catch (err: any) {
      setEditError(err.message);
    }
  }

  async function toggleTestMode(filter: WordFilter) {
    try {
      await api.patch(`/api/moderation/word-filters/${filter.id}`, { testMode: !filter.test_mode });
      refresh();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleBulkImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkFeedback(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await api.post('/api/moderation/word-filters/bulk', formData);
      const d = res || {};
      setBulkFeedback(`${d.imported} phrases imported, ${d.skipped} skipped.`);
      refresh();
    } catch (err: any) {
      setBulkFeedback(`Error: ${err.message}`);
    }
    e.target.value = '';
  }

  return (
    <div>
      <form onSubmit={handleAdd} style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>PHRASE / PATTERN</label>
          <input
            data-testid="word-filter-input"
            value={newPhrase}
            onChange={(e) => setNewPhrase(e.target.value)}
            placeholder="Phrase or regex..."
            style={{ width: '240px' }}
            required
          />
        </div>
        <div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} />
            Regex
          </label>
        </div>
        <button type="submit" disabled={submitting} data-testid="add-filter-btn">ADD</button>
        <label style={{ cursor: 'pointer' }}>
          <button type="button" onClick={() => document.getElementById('bulk-import-input')?.click()}>BULK IMPORT</button>
          <input id="bulk-import-input" type="file" accept=".csv,.txt" onChange={handleBulkImport} style={{ display: 'none' }} />
        </label>
        {formError && <span className="error-message">{formError}</span>}
      </form>
      {bulkFeedback && <div style={{ marginBottom: '12px', fontSize: '12px', color: bulkFeedback.startsWith('Error') ? 'var(--error)' : 'var(--success)' }}>{bulkFeedback}</div>}

      {error && <div className="error-message">{error}</div>}
      {loading ? <div className="loading">Loading...</div> : (
        <div className="table-responsive"><table>
          <thead>
            <tr><th>Phrase</th><th>Type</th><th>Mode</th><th></th></tr>
          </thead>
          <tbody>
            {(filters || []).map((f) => (
              <tr key={f.id} data-testid="filter-row">
                <td style={{ fontFamily: 'monospace' }}>
                  {editingId === f.id ? (
                    <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input value={editPhrase} onChange={(e) => setEditPhrase(e.target.value)} style={{ width: '200px' }} />
                      <button onClick={() => saveEdit(f.id)} style={{ padding: '2px 8px', fontSize: '11px', minHeight: '28px' }}>SAVE</button>
                      <button onClick={cancelEdit} style={{ padding: '2px 8px', fontSize: '11px', minHeight: '28px' }}>CANCEL</button>
                      {editError && <span className="error-message" style={{ fontSize: '11px' }}>{editError}</span>}
                    </span>
                  ) : f.phrase}
                </td>
                <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.is_regex ? 'REGEX' : 'PHRASE'}</td>
                <td>
                  {f.test_mode ? (
                    <span style={{ display: 'inline-block', padding: '2px 8px', fontSize: '10px', fontWeight: 'bold', borderRadius: '3px', background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' }}>TEST</span>
                  ) : (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>ACTIVE</span>
                  )}
                </td>
                <td style={{ display: 'flex', gap: '6px' }}>
                  {editingId !== f.id && (
                    <button onClick={() => startEdit(f)} style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}>EDIT</button>
                  )}
                  <button onClick={() => toggleTestMode(f)} style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px', color: f.test_mode ? 'var(--success)' : '#f59e0b' }}>
                    {f.test_mode ? 'ACTIVATE' : 'TEST'}
                  </button>
                  <button className="danger" onClick={() => handleDelete(f.id)} style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}>REMOVE</button>
                </td>
              </tr>
            ))}
            {(filters || []).length === 0 && (
              <tr><td colSpan={4} style={{ color: 'var(--text-muted)' }}>No filters configured.</td></tr>
            )}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

// ─── Spam Tab ─────────────────────────────────────────────────────────────────

function SpamTab() {
  const [spamSettings, setSpamSettings] = useState<SpamSetting[]>([]);
  const [spamDraft, setSpamDraft] = useState<Record<string, string>>({});
  const [spamSaving, setSpamSaving] = useState(false);
  const [spamFeedback, setSpamFeedback] = useState<string | null>(null);

  useEffect(() => {
    fetchSpamSettings();
  }, []);

  async function fetchSpamSettings() {
    try {
      const res = await api.get<SpamSetting[]>('/api/moderation/settings');
      const rows = res || [];
      setSpamSettings(rows);
      const draft: Record<string, string> = {};
      for (const r of rows) draft[r.key] = r.value;
      setSpamDraft(draft);
    } catch { /* show defaults */ }
  }

  async function handleSaveSpamSettings() {
    setSpamSaving(true);
    setSpamFeedback(null);
    try {
      for (const row of spamSettings) {
        if (spamDraft[row.key] !== row.value) {
          await api.patch('/api/moderation/settings', { key: row.key, value: spamDraft[row.key] });
        }
      }
      setSpamFeedback('Settings saved.');
      fetchSpamSettings();
    } catch (err: any) {
      setSpamFeedback(`Error: ${err.message}`);
    } finally {
      setSpamSaving(false);
    }
  }

  const settingLabels: Record<string, string> = { spam_message_limit: 'Message Limit', spam_window_ms: 'Window (ms)' };

  return (
    <div style={{ padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)' }}>
      <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: 0, marginBottom: '12px' }}>
        Automatic shadow-mute triggers when a user exceeds the message limit within the time window. Mute duration: 1 hour.
        Accounts are added to the review queue — moderators resolve via the Reports tab.
        SPAM-type automod rules also reference these thresholds.
      </p>

      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '8px' }}>
        {spamSettings.map((s) => (
          <div key={s.key}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{settingLabels[s.key] || s.key}</label>
            <input
              type="number"
              min="1"
              value={spamDraft[s.key] || ''}
              onChange={(e) => setSpamDraft({ ...spamDraft, [s.key]: e.target.value })}
              style={{ width: '120px' }}
            />
          </div>
        ))}
        <button onClick={handleSaveSpamSettings} disabled={spamSaving}>
          {spamSaving ? 'SAVING...' : 'SAVE'}
        </button>
      </div>
      {spamFeedback && <div style={{ fontSize: '12px', color: spamFeedback.startsWith('Error') ? 'var(--error)' : 'var(--success)' }}>{spamFeedback}</div>}
    </div>
  );
}

// ─── AI Moderation Settings ───────────────────────────────────────────────────

const AI_KEYS = {
  enabled: 'ai_moderation_enabled',
  mode: 'ai_moderation_mode',
  thresholds: 'ai_moderation_thresholds',
  identifierThresholds: 'ai_moderation_identifier_thresholds',
} as const;

/**
 * Kill switch + rollout controls for the OpenAI Moderation API integration.
 *
 * While enabled AND healthy, the classifier supersedes the keyword layers (the
 * WORD FILTER tab and any KEYWORD_PRESET rule). Turning this off — or the API
 * going down — hands enforcement straight back to them.
 */
function AiModerationSettings({ settings, isLoading }: { settings: SpamSetting[] | undefined; isLoading: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'shadow' | 'enforce'>('shadow');
  const [thresholds, setThresholds] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    const get = (key: string) => settings.find((s) => s.key === key)?.value;
    setEnabled(get(AI_KEYS.enabled) === 'true');
    setMode(get(AI_KEYS.mode) === 'enforce' ? 'enforce' : 'shadow');
    setThresholds(get(AI_KEYS.thresholds) ?? '');
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    setFeedback(null);
    try {
      // Validate locally before the round-trip so a typo doesn't 422.
      if (thresholds.trim()) {
        const parsed = JSON.parse(thresholds);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Thresholds must be a JSON object of category -> score');
        }
      }
      await api.patch('/api/moderation/settings', { key: AI_KEYS.enabled, value: enabled ? 'true' : 'false' });
      await api.patch('/api/moderation/settings', { key: AI_KEYS.mode, value: mode });
      if (thresholds.trim()) {
        await api.patch('/api/moderation/settings', { key: AI_KEYS.thresholds, value: thresholds.trim() });
      }
      setFeedback('AI moderation settings saved.');
    } catch (err: any) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', maxWidth: '520px', marginTop: '20px' }}>
      <h3 style={{ fontSize: '13px', marginTop: 0, color: 'var(--text-secondary)' }}>AI CONTENT MODERATION</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '16px' }}>
        Classifies chat, usernames, and party names with the OpenAI Moderation API.
        While enabled and reachable it <strong>replaces</strong> the keyword presets and the
        WORD FILTER tab; those return automatically if the API is unreachable.
        Message text is sent to OpenAI &mdash; no username, user ID, or channel.
      </p>

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', marginBottom: '12px' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled (kill switch)</span>
          </label>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>MODE</label>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'shadow' | 'enforce')} style={{ width: '100%' }}>
              <option value="shadow">Shadow &mdash; log only, never blocks</option>
              <option value="enforce">Enforce &mdash; block at or above threshold</option>
            </select>
            <p style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
              Run in shadow first and review the scores in VIOLATIONS before enforcing.
            </p>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
              THRESHOLD OVERRIDES (JSON, optional)
            </label>
            <textarea
              value={thresholds}
              onChange={(e) => setThresholds(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder={'{\n  "sexual/minors": 0.5,\n  "hate/threatening": 0.7\n}'}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: '11px' }}
            />
            <p style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
              Leave blank for the defaults. A category listed here blocks at or above its score;
              any category <em>not</em> listed is alert-only. Violence and illicit are deliberately
              omitted by default &mdash; normal Fallout chat scores high on both.
            </p>
          </div>

          <button onClick={handleSave} disabled={saving}>
            {saving ? 'SAVING...' : 'SAVE'}
          </button>
        </>
      )}

      {feedback && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: feedback.startsWith('Error') ? 'var(--error)' : 'var(--success)' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

function SettingsTab() {
  const { data: discordChannels, isLoading: channelsLoading } = useQuery({
    queryKey: ['discord-channels'],
    queryFn: () => api.get<DiscordChannel[]>('/api/moderation/discord-channels'),
  });

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['moderation-settings-all'],
    queryFn: () => api.get<SpamSetting[]>('/api/moderation/settings'),
  });

  const [selectedChannel, setSelectedChannel] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Sync selected channel once settings load
  useEffect(() => {
    if (settings) {
      const row = (settings as SpamSetting[]).find((s: SpamSetting) => s.key === 'mod_log_channel_id');
      if (row) setSelectedChannel(row.value ?? '');
    }
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    setFeedback(null);
    try {
      await api.patch('/api/moderation/settings', { key: 'mod_log_channel_id', value: selectedChannel });
      setFeedback('Mod log channel saved.');
    } catch (err: any) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const isLoading = channelsLoading || settingsLoading;

  return (
    <>
    <div style={{ padding: '12px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', maxWidth: '520px' }}>
      <h3 style={{ fontSize: '13px', marginTop: 0, color: 'var(--text-secondary)' }}>MOD LOG CHANNEL</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '16px' }}>
        Bans, kicks, mutes, player reports, and automod violations all post an audit embed to this Discord channel.
        Default is <strong>#vault-security</strong>.
      </p>

      {isLoading ? (
        <div className="loading">Loading...</div>
      ) : (
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>DISCORD CHANNEL</label>
            <select value={selectedChannel} onChange={e => setSelectedChannel(e.target.value)} style={{ width: '100%' }}>
              <option value="">(none)</option>
              {(discordChannels || []).map(ch => (
                <option key={ch.id} value={ch.id}>#{ch.name}</option>
              ))}
            </select>
          </div>
          <button onClick={handleSave} disabled={saving}>
            {saving ? 'SAVING...' : 'SAVE'}
          </button>
        </div>
      )}
      {feedback && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: feedback.startsWith('Error') ? 'var(--error)' : 'var(--success)' }}>
          {feedback}
        </div>
      )}
    </div>

    <AiModerationSettings settings={settings as SpamSetting[] | undefined} isLoading={settingsLoading} />
    </>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

const TAB_LABELS: { id: Tab; label: string }[] = [
  { id: 'rules', label: 'RULES' },
  { id: 'word-filter', label: 'WORD FILTER' },
  { id: 'spam', label: 'SPAM' },
  { id: 'settings', label: 'SETTINGS' },
];

export default function AutoModeration() {
  const [activeTab, setActiveTab] = useState<Tab>('rules');

  return (
    <div>
      <h1 style={{ fontSize: '18px', marginBottom: '16px' }}>◈ AUTO-MODERATION</h1>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--border-color)', marginBottom: '20px' }}>
        {TAB_LABELS.map(({ id, label }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              style={{
                padding: '6px 18px',
                fontSize: '12px',
                letterSpacing: '1px',
                border: 'none',
                borderBottom: active ? '2px solid var(--phosphor-color)' : '2px solid transparent',
                background: 'transparent',
                color: active ? 'var(--phosphor-color)' : 'var(--text-muted)',
                fontWeight: active ? 'bold' : 'normal',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                transition: 'color 0.1s',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {activeTab === 'rules' && <RulesTab />}
      {activeTab === 'word-filter' && <WordFilterTab />}
      {activeTab === 'spam' && <SpamTab />}
      {activeTab === 'settings' && <SettingsTab />}
    </div>
  );
}
