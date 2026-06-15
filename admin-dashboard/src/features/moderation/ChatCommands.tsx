import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

// ── Types ────────────────────────────────────────────────────────────────────

interface FormField {
  key: string;
  label: string;
  type: 'text' | 'textarea';
  required: boolean;
  placeholder: string;
}

interface ChatCommand {
  id: number;
  trigger: string;
  alias: string | null;
  description: string;
  response: string;
  actionType: string;
  targetChannelId: string | null;
  allowedChannelId: string | null;
  responseColor: string | null;
  cooldownSec: number;
  enabled: boolean;
  requiresArgs: boolean;
  relayToDiscord: boolean;
  formFields: string | null;
}

interface ChannelInfo {
  id: string;
  name: string;
  color?: string;
  children?: ChannelInfo[];
}

type DraftCommand = Omit<ChatCommand, 'id' | 'formFields'> & { id?: number };

const EMPTY_DRAFT: DraftCommand = {
  trigger: '',
  alias: null,
  description: '',
  response: '',
  actionType: 'message',
  targetChannelId: null,
  allowedChannelId: null,
  responseColor: null,
  cooldownSec: 0,
  enabled: true,
  requiresArgs: false,
  relayToDiscord: false,
};

const ACTION_TYPES: { value: string; label: string; badge: string; color: string }[] = [
  { value: 'message',          label: 'Broadcast message',                badge: 'BROADCAST',     color: 'var(--phosphor-color)' },
  { value: 'private',          label: 'Private (sender only)',            badge: 'PRIVATE',       color: 'var(--phosphor-dim)' },
  { value: 'relay',            label: 'Relay to another channel',         badge: 'RELAY',         color: 'var(--info)' },
  { value: 'announce',         label: 'Announce to Events channel',       badge: 'ANNOUNCE',      color: 'var(--warning)' },
  { value: 'server-broadcast', label: 'Server broadcast (same-server)',   badge: 'SRV-BROADCAST', color: 'var(--warning)' },
];

const DYNAMIC_VARS   = ['[Server Count]', '[Server Max]', '[Server Users]', '[Mod Users]', '[Player Count]', '[Channel Name]'];
const TEMPLATE_VARS  = ['{user}', '{args}', '{channel}'];

const RESPONSE_COLOR_OPTIONS = [
  { value: '',        label: 'Default (body text)' },
  { value: 'channel', label: 'Channel tag color' },
  { value: 'user',    label: 'User theme primary' },
  { value: 'custom',  label: 'Custom hex' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function flattenChannels(list: ChannelInfo[]): ChannelInfo[] {
  const out: ChannelInfo[] = [];
  for (const c of list) {
    out.push(c);
    if (c.children) out.push(...flattenChannels(c.children));
  }
  return out;
}

function actionBadge(actionType: string) {
  return ACTION_TYPES.find(a => a.value === actionType) ?? { badge: actionType.toUpperCase(), color: 'var(--text-muted)', value: actionType, label: actionType };
}

// ── Styles (shared, keep in one place) ───────────────────────────────────────

const btn: React.CSSProperties = {
  fontSize: '11px', padding: '4px 10px', minHeight: '26px',
  letterSpacing: '0.5px', textTransform: 'uppercase',
};

const btnPrimary: React.CSSProperties = {
  ...btn, background: 'var(--phosphor-color)', color: 'var(--bg-dark)',
  border: '1px solid var(--phosphor-color)', fontWeight: 'bold',
};

const btnDanger: React.CSSProperties = {
  ...btn, color: 'var(--danger)', borderColor: 'var(--danger)',
};

const badge = (color: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 7px', fontSize: '9px', fontWeight: 'bold',
  color, border: `1px solid ${color}`, letterSpacing: '0.8px', lineHeight: 1.3,
  background: 'transparent', whiteSpace: 'nowrap',
});

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px',
};

const label: React.CSSProperties = {
  display: 'block', fontSize: '10px', letterSpacing: '0.8px',
  color: 'var(--text-secondary)', marginBottom: '3px', textTransform: 'uppercase',
};

// ── Response Color Picker ────────────────────────────────────────────────────

function ResponseColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCustom = value.startsWith('#');
  const selectValue = isCustom ? 'custom' : (value || '');
  const hexValue = isCustom ? value : '#d4b040';

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      <select value={selectValue} onChange={e => onChange(e.target.value === 'custom' ? hexValue : e.target.value)} style={{ width: '160px', fontSize: '11px' }}>
        {RESPONSE_COLOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {isCustom && (
        <>
          <input type="color" value={hexValue} onChange={e => onChange(e.target.value)}
            style={{ width: '28px', height: '24px', padding: '1px', border: '1px solid var(--border-color)', cursor: 'pointer', background: 'transparent' }} />
          <input type="text" value={hexValue} onChange={e => onChange(e.target.value)} maxLength={7}
            style={{ width: '70px', fontSize: '11px' }} />
        </>
      )}
      {value && !isCustom && (
        <span style={{
          width: '14px', height: '14px', borderRadius: '2px', flexShrink: 0,
          background: value === 'channel' ? '#50C878' : value === 'user' ? 'var(--phosphor-color)' : value,
          border: '1px solid var(--border-color)',
        }} />
      )}
    </div>
  );
}

// ── Command Card ─────────────────────────────────────────────────────────────

function CommandCard({
  cmd, channelNameFor, onEdit, onDelete, onToggle,
}: {
  cmd: ChatCommand;
  channelNameFor: (id: string | null) => string;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const b = actionBadge(cmd.actionType);
  const targetName = cmd.targetChannelId ? channelNameFor(cmd.targetChannelId) : null;
  const allowedName = cmd.allowedChannelId ? channelNameFor(cmd.allowedChannelId) : null;

  return (
    <article style={{ ...card, opacity: cmd.enabled ? 1 : 0.5 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--phosphor-color)' }}>{cmd.trigger}</span>
        {cmd.alias && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>({cmd.alias})</span>}
        <span style={badge(b.color)}>{b.badge}</span>
        {cmd.relayToDiscord && <span style={badge('var(--info)')}>DISCORD</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onToggle} style={{ ...btn, fontSize: '10px', minHeight: '22px', color: cmd.enabled ? 'var(--phosphor-color)' : 'var(--text-muted)' }}>
          {cmd.enabled ? '● ON' : '○ OFF'}
        </button>
      </header>

      <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-primary)', lineHeight: 1.35 }}>
        {cmd.description || <em style={{ color: 'var(--text-muted)' }}>No description</em>}
      </p>

      {/* Response / target summary */}
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        {cmd.actionType === 'relay' ? (
          <div>→ <strong style={{ color: 'var(--info)' }}>{targetName ?? 'same channel'}</strong></div>
        ) : cmd.response ? (
          <div style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            padding: '3px 6px', background: 'var(--bg-dark)', border: '1px solid var(--border-color)',
            fontFamily: 'var(--font-mono)',
          }} title={cmd.response}>{cmd.response}</div>
        ) : null}
      </div>

      {/* Meta footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '10px', color: 'var(--text-muted)', marginTop: 'auto', paddingTop: '4px', borderTop: '1px solid var(--border-color)' }}>
        <span>⏱ {cmd.cooldownSec > 0 ? `${cmd.cooldownSec}s` : 'no cooldown'}</span>
        <span>📍 {allowedName ?? 'anywhere'}</span>
        {cmd.requiresArgs && <span>◆ args required</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onEdit} style={{ ...btn, fontSize: '10px', minHeight: '22px' }}>EDIT</button>
        <button onClick={onDelete} style={{ ...btnDanger, fontSize: '10px', minHeight: '22px' }}>DEL</button>
      </div>
    </article>
  );
}

// ── Edit/Create Drawer ───────────────────────────────────────────────────────

function CommandDrawer({
  open, initial, channels, onClose, onSave,
}: {
  open: boolean;
  initial: DraftCommand | null;
  channels: ChannelInfo[];
  onClose: () => void;
  onSave: (draft: DraftCommand) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftCommand>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && initial) { setDraft(initial); setErr(null); }
  }, [open, initial]);

  const isEdit = !!initial?.id;
  const actionType = draft.actionType;

  async function handleSave() {
    setSaving(true); setErr(null);
    try {
      await onSave(draft);
      onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  }

  if (!open) return null;

  const flat = flattenChannels(channels);

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 999,
      }} />
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(460px, 92vw)',
        background: 'var(--bg-panel)', borderLeft: '1px solid var(--phosphor-color)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.6)', zIndex: 1000,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <header style={{
          padding: '14px 16px', borderBottom: '1px solid var(--border-color)',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <h2 style={{ margin: 0, fontSize: '14px', color: 'var(--phosphor-color)' }}>
            {isEdit ? `◈ EDIT ${initial!.trigger}` : '◈ NEW COMMAND'}
          </h2>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btn}>CLOSE</button>
        </header>

        <div style={{ padding: '16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Identity */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={label}>Trigger</label>
              <input value={draft.trigger} onChange={e => setDraft(d => ({ ...d, trigger: e.target.value }))}
                placeholder="/hello" style={{ width: '100%' }} />
            </div>
            <div>
              <label style={label}>Alias (optional)</label>
              <input value={draft.alias ?? ''} onChange={e => setDraft(d => ({ ...d, alias: e.target.value || null }))}
                placeholder="/h" style={{ width: '100%' }} />
            </div>
          </div>

          <div>
            <label style={label}>Type</label>
            <select value={draft.actionType} onChange={e => setDraft(d => ({ ...d, actionType: e.target.value }))}
              style={{ width: '100%' }}>
              {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div>
            <label style={label}>Description (shown in /help)</label>
            <input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
              style={{ width: '100%' }} />
          </div>

          {/* Response block — message / private / announce */}
          {(actionType === 'message' || actionType === 'private' || actionType === 'announce' || actionType === 'server-broadcast') && (
            <fieldset style={{ border: '1px solid var(--border-color)', padding: '10px 12px' }}>
              <legend style={{ fontSize: '10px', padding: '0 6px', color: 'var(--text-secondary)' }}>RESPONSE</legend>
              <textarea value={draft.response}
                onChange={e => setDraft(d => ({ ...d, response: e.target.value }))}
                placeholder="Welcome {user}! There are [Server Count]/[Server Max] online."
                rows={3}
                style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
              <div style={{ marginTop: '8px' }}>
                <label style={label}>Response text color</label>
                <ResponseColorPicker value={draft.responseColor ?? ''} onChange={v => setDraft(d => ({ ...d, responseColor: v || null }))} />
              </div>
            </fieldset>
          )}

          {/* Relay block */}
          {actionType === 'relay' && (
            <fieldset style={{ border: '1px solid var(--border-color)', padding: '10px 12px' }}>
              <legend style={{ fontSize: '10px', padding: '0 6px', color: 'var(--text-secondary)' }}>RELAY TARGET</legend>
              <p style={{ margin: '0 0 8px', fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                User's typed argument is forwarded as their own message to the target channel.
              </p>
              <select value={draft.targetChannelId ?? ''} onChange={e => setDraft(d => ({ ...d, targetChannelId: e.target.value || null }))}
                style={{ width: '100%' }}>
                <option value="">(same channel)</option>
                {flat.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            </fieldset>
          )}

          {/* Restrictions */}
          <fieldset style={{ border: '1px solid var(--border-color)', padding: '10px 12px' }}>
            <legend style={{ fontSize: '10px', padding: '0 6px', color: 'var(--text-secondary)' }}>RESTRICTIONS</legend>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: '10px', marginBottom: '8px' }}>
              <div>
                <label style={label}>Allowed in channel</label>
                <select value={draft.allowedChannelId ?? ''} onChange={e => setDraft(d => ({ ...d, allowedChannelId: e.target.value || null }))}
                  style={{ width: '100%' }}>
                  <option value="">Any channel</option>
                  {flat.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={label}>Cooldown (s)</label>
                <input type="number" min={0} max={86400} value={draft.cooldownSec}
                  onChange={e => setDraft(d => ({ ...d, cooldownSec: parseInt(e.target.value) || 0 }))}
                  style={{ width: '100%' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} />
                Enabled
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={draft.requiresArgs} onChange={e => setDraft(d => ({ ...d, requiresArgs: e.target.checked }))} />
                Requires args
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={draft.relayToDiscord} onChange={e => setDraft(d => ({ ...d, relayToDiscord: e.target.checked }))} />
                Relay to Discord
              </label>
            </div>
          </fieldset>

          {err && <div style={{ color: 'var(--danger)', fontSize: '12px', padding: '6px 10px', border: '1px solid var(--danger)', background: 'rgba(255,85,85,0.08)' }}>{err}</div>}
        </div>

        <footer style={{ padding: '12px 16px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '8px' }}>
          <button onClick={onClose} style={btn} disabled={saving}>CANCEL</button>
          <span style={{ flex: 1 }} />
          <button onClick={handleSave} style={btnPrimary} disabled={saving || !draft.trigger || !draft.description}>
            {saving ? 'SAVING…' : isEdit ? 'SAVE CHANGES' : 'CREATE COMMAND'}
          </button>
        </footer>
      </aside>
    </>
  );
}

// ── Form Fields Editor (for /apply + /report) ───────────────────────────────

function FormFieldsEditor({ cmd, onClose, onSaved }: {
  cmd: ChatCommand; onClose: () => void; onSaved: () => void;
}) {
  const parsed = useMemo<FormField[]>(() => {
    try { return cmd.formFields ? JSON.parse(cmd.formFields) : []; } catch { return []; }
  }, [cmd.formFields]);

  const [draft, setDraft] = useState<FormField[]>(parsed);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function update(idx: number, patch: Partial<FormField>) {
    setDraft(p => p.map((f, i) => i === idx ? { ...f, ...patch } : f));
  }
  function move(idx: number, dir: -1 | 1) {
    setDraft(p => {
      const n = [...p]; const swap = idx + dir;
      if (swap < 0 || swap >= n.length) return p;
      [n[idx], n[swap]] = [n[swap], n[idx]];
      return n;
    });
  }

  async function save() {
    setSaving(true); setErr(null);
    try {
      await api.patch(`/api/commands/${cmd.id}`, { formFields: JSON.stringify(draft) });
      onSaved(); onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ background: 'var(--bg-dark)', padding: '12px', border: '1px solid var(--border-color)', marginTop: '8px' }}>
      {draft.map((f, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: 'auto 110px 1fr 80px 1fr 50px auto',
          gap: '6px', alignItems: 'end', marginBottom: '8px',
          padding: '8px', background: 'var(--bg-card)', border: '1px solid var(--border-color)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <button onClick={() => move(i, -1)} disabled={i === 0} style={{ ...btn, fontSize: '10px', padding: '1px 5px', minHeight: 'auto' }}>▲</button>
            <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} style={{ ...btn, fontSize: '10px', padding: '1px 5px', minHeight: 'auto' }}>▼</button>
          </div>
          <div>
            <label style={label}>Key</label>
            <input value={f.key} readOnly style={{ width: '100%', opacity: 0.5, fontSize: '11px' }} />
          </div>
          <div>
            <label style={label}>Label</label>
            <input value={f.label} onChange={e => update(i, { label: e.target.value })} style={{ width: '100%', fontSize: '11px' }} />
          </div>
          <div>
            <label style={label}>Type</label>
            <select value={f.type} onChange={e => update(i, { type: e.target.value as 'text' | 'textarea' })} style={{ width: '100%', fontSize: '11px' }}>
              <option value="text">text</option>
              <option value="textarea">textarea</option>
            </select>
          </div>
          <div>
            <label style={label}>Placeholder</label>
            <input value={f.placeholder} onChange={e => update(i, { placeholder: e.target.value })} style={{ width: '100%', fontSize: '11px' }} />
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', fontSize: '9px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <span>REQ</span>
            <input type="checkbox" checked={f.required} onChange={e => update(i, { required: e.target.checked })} />
          </label>
          <button onClick={() => setDraft(p => p.filter((_, j) => j !== i))} style={{ ...btnDanger, fontSize: '10px', padding: '2px 6px', minHeight: 'auto' }}>✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button onClick={() => setDraft(p => [...p, { key: `field${p.length + 1}`, label: 'NEW FIELD', type: 'text', required: false, placeholder: '' }])} style={btn}>+ FIELD</button>
        <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'SAVING…' : 'SAVE FIELDS'}</button>
        <button onClick={onClose} style={btn} disabled={saving}>CANCEL</button>
        {err && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{err}</span>}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ChatCommands() {
  const queryClient = useQueryClient();

  const { data: commands, isLoading, error: queryError } = useQuery({
    queryKey: ['commands'],
    queryFn: () => api.get<ChatCommand[]>('/api/commands'),
  });

  const { data: channels } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<ChannelInfo[]>('/api/channels'),
  });

  const channelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of flattenChannels(channels ?? [])) m.set(c.id, c.name);
    return m;
  }, [channels]);

  const channelNameFor = (id: string | null) => id ? (channelMap.get(id) ?? id.slice(-8)) : '';

  const [typeFilter, setTypeFilter]   = useState<string>('all');
  const [search, setSearch]           = useState('');
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [drawerInitial, setDrawerInitial] = useState<DraftCommand | null>(null);
  const [varsOpen, setVarsOpen]       = useState(false);
  const [fieldEditId, setFieldEditId] = useState<number | null>(null);
  const [deleteId, setDeleteId]       = useState<number | null>(null);

  function refresh() { queryClient.invalidateQueries({ queryKey: ['commands'] }); }

  function openNew() { setDrawerInitial({ ...EMPTY_DRAFT }); setDrawerOpen(true); }
  function openEdit(cmd: ChatCommand) {
    const { formFields: _ignored, id, ...rest } = cmd;
    setDrawerInitial({ ...rest, id });
    setDrawerOpen(true);
  }

  async function saveDraft(d: DraftCommand) {
    const payload = {
      trigger: d.trigger, alias: d.alias || null, description: d.description,
      response: d.response, actionType: d.actionType,
      targetChannelId: d.targetChannelId || null, allowedChannelId: d.allowedChannelId || null,
      responseColor: d.responseColor || null, cooldownSec: d.cooldownSec,
      enabled: d.enabled, requiresArgs: d.requiresArgs, relayToDiscord: d.relayToDiscord,
    };
    if (d.id) await api.patch(`/api/commands/${d.id}`, payload);
    else await api.post('/api/commands', payload);
    refresh();
  }

  async function toggleEnabled(cmd: ChatCommand) {
    try { await api.patch(`/api/commands/${cmd.id}`, { enabled: !cmd.enabled }); refresh(); }
    catch (e: any) { alert(e.message); }
  }

  async function confirmDelete(id: number) {
    try { await api.delete(`/api/commands/${id}`); setDeleteId(null); refresh(); }
    catch (e: any) { alert(e.message); }
  }

  const all       = commands ?? [];
  const systemCmds = all.filter(c => c.actionType === 'form');
  const customAll  = all.filter(c => c.actionType !== 'form');

  const filtered = customAll.filter(c => {
    if (typeFilter !== 'all' && c.actionType !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return c.trigger.toLowerCase().includes(q)
          || (c.alias?.toLowerCase().includes(q) ?? false)
          || c.description.toLowerCase().includes(q);
    }
    return true;
  });

  const error = queryError ? (queryError as Error).message : null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '4px', gap: '12px' }}>
        <h1 style={{ fontSize: '18px', margin: 0 }}>◈ CHAT COMMANDS</h1>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
          Configure /slash commands users type in chat
        </span>
      </div>

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        margin: '16px 0', padding: '10px 12px',
        background: 'var(--bg-card)', border: '1px solid var(--border-color)',
      }}>
        <button onClick={openNew} style={btnPrimary}>+ NEW COMMAND</button>

        <label style={{ ...label, marginBottom: 0, marginLeft: '12px' }}>Type:</label>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ fontSize: '11px' }}>
          <option value="all">All types</option>
          {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.badge}</option>)}
        </select>

        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search triggers / description…"
          style={{ flex: 1, minWidth: '200px', fontSize: '12px' }} />

        <button onClick={() => setVarsOpen(v => !v)} style={{ ...btn, color: 'var(--text-secondary)' }}>
          {varsOpen ? '▾' : '▸'} VARIABLES
        </button>
      </div>

      {/* Variable reference */}
      {varsOpen && (
        <section style={{ marginBottom: '20px', padding: '12px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', fontSize: '11px' }}>
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ color: 'var(--text-secondary)', marginBottom: '6px', fontSize: '10px', letterSpacing: '0.8px' }}>TEMPLATE — substituted at send</div>
              {TEMPLATE_VARS.map(v => (
                <code key={v} style={{ marginRight: '6px', padding: '2px 6px', background: 'var(--bg-dark)', border: '1px solid var(--border-color)', color: 'var(--phosphor-color)' }}>{v}</code>
              ))}
            </div>
            <div>
              <div style={{ color: 'var(--text-secondary)', marginBottom: '6px', fontSize: '10px', letterSpacing: '0.8px' }}>DYNAMIC — resolved at send</div>
              {DYNAMIC_VARS.map(v => (
                <code key={v} style={{ marginRight: '6px', padding: '2px 6px', background: 'var(--bg-dark)', border: '1px solid var(--border-color)', color: 'var(--info)' }}>{v}</code>
              ))}
            </div>
          </div>
        </section>
      )}

      {error && (
        <div style={{ color: 'var(--danger)', padding: '10px 12px', border: '1px solid var(--danger)', background: 'rgba(255,85,85,0.08)', marginBottom: '16px', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {/* System commands */}
      <section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '12px', letterSpacing: '1px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>SYSTEM COMMANDS</h2>
        <div style={card}>
          {/* /help always-on */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' }}>
            <span style={{ fontWeight: 'bold', color: 'var(--phosphor-color)', minWidth: '80px' }}>/help</span>
            <span style={badge('var(--text-muted)')}>BUILT-IN</span>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', flex: 1 }}>
              Lists all available commands
            </span>
            <span style={{ fontSize: '10px', color: 'var(--phosphor-color)' }}>● ALWAYS ON</span>
          </div>

          {/* form commands */}
          {systemCmds.map(cmd => {
            let fields: FormField[] = [];
            try { fields = cmd.formFields ? JSON.parse(cmd.formFields) : []; } catch { /* empty */ }
            return (
              <div key={cmd.id} style={{ paddingTop: '8px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' }}>
                  <span style={{ fontWeight: 'bold', color: 'var(--phosphor-color)', minWidth: '80px' }}>{cmd.trigger}</span>
                  <span style={badge('var(--warning)')}>FORM</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', flex: 1 }}>
                    {cmd.description} · {fields.length} field{fields.length === 1 ? '' : 's'}
                  </span>
                  <button onClick={() => setFieldEditId(fieldEditId === cmd.id ? null : cmd.id)} style={btn}>
                    {fieldEditId === cmd.id ? 'CLOSE' : 'EDIT FIELDS'}
                  </button>
                </div>
                {fieldEditId !== cmd.id && fields.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', paddingLeft: '90px' }}>
                    {fields.map((f, i) => (
                      <span key={i} style={{ fontSize: '10px', padding: '1px 7px', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                        {f.label}{f.required ? ' *' : ''} <span style={{ opacity: 0.5 }}>({f.type})</span>
                      </span>
                    ))}
                  </div>
                )}
                {fieldEditId === cmd.id && (
                  <FormFieldsEditor cmd={cmd} onClose={() => setFieldEditId(null)} onSaved={refresh} />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Custom commands grid */}
      <section>
        <h2 style={{ fontSize: '12px', letterSpacing: '1px', color: 'var(--text-secondary)', margin: '0 0 8px' }}>
          CUSTOM COMMANDS <span style={{ opacity: 0.5 }}>({filtered.length}{filtered.length !== customAll.length ? ` of ${customAll.length}` : ''})</span>
        </h2>

        {isLoading ? (
          <div style={{ color: 'var(--text-secondary)', padding: '20px' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ ...card, alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontStyle: 'italic', padding: '32px' }}>
            {customAll.length === 0 ? 'No commands configured. Click + NEW COMMAND to add one.' : 'No commands match the current filter.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '12px' }}>
            {filtered.map(cmd => (
              <CommandCard key={cmd.id}
                cmd={cmd}
                channelNameFor={channelNameFor}
                onEdit={() => openEdit(cmd)}
                onDelete={() => setDeleteId(cmd.id)}
                onToggle={() => toggleEnabled(cmd)} />
            ))}
          </div>
        )}
      </section>

      {/* Delete confirmation overlay */}
      {deleteId !== null && (() => {
        const cmd = customAll.find(c => c.id === deleteId);
        if (!cmd) return null;
        return (
          <div onClick={() => setDeleteId(null)} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1001,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              background: 'var(--bg-panel)', border: '1px solid var(--danger)', padding: '20px',
              minWidth: '320px', maxWidth: '420px',
            }}>
              <h3 style={{ margin: '0 0 10px', fontSize: '14px', color: 'var(--danger)' }}>Delete command?</h3>
              <p style={{ margin: '0 0 16px', fontSize: '12px', color: 'var(--text-primary)' }}>
                <strong style={{ color: 'var(--phosphor-color)' }}>{cmd.trigger}</strong>
                {cmd.alias && <> (<span>{cmd.alias}</span>)</>} will be permanently removed.
                This cannot be undone.
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setDeleteId(null)} style={btn}>CANCEL</button>
                <button onClick={() => confirmDelete(deleteId)} style={btnDanger}>DELETE</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Drawer */}
      <CommandDrawer
        open={drawerOpen}
        initial={drawerInitial}
        channels={channels ?? []}
        onClose={() => setDrawerOpen(false)}
        onSave={saveDraft} />
    </div>
  );
}
