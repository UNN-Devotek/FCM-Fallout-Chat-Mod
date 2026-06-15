import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Channel {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  sortOrder: number;
  discordRelay: boolean;
  discordChannelId: string | null;
  allowGifs: boolean;
  allowEmojis: boolean;
  children: Channel[];
}

interface ChannelFormValues {
  name: string;
  color: string;
  parentId: string;
  sortOrder: number;
  discordRelay: boolean;
  discordChannelId: string;
  allowGifs: boolean;
  allowEmojis: boolean;
}

// ─── Shared input/label styles ────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '11px',
  color: 'var(--text-secondary)',
  marginBottom: '4px',
  letterSpacing: '0.08em',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-dark)',
  border: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '13px',
  padding: '6px 10px',
  outline: 'none',
};

// ─── Modal ────────────────────────────────────────────────────────────────────

interface ModalProps {
  mode: 'create' | 'edit';
  initial: ChannelFormValues;
  topLevelChannels: Channel[];
  /** If non-null, the channel being edited (used to decide parent-field visibility). */
  editingChannel: Channel | null;
  onSave: (values: ChannelFormValues) => Promise<void>;
  onClose: () => void;
}

function ChannelModal({ mode, initial, topLevelChannels, editingChannel, onSave, onClose }: ModalProps) {
  const [form, setForm] = useState<ChannelFormValues>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hide parent selector when editing a top-level channel that has children
  const hideParent =
    mode === 'edit' &&
    editingChannel !== null &&
    editingChannel.parentId === null &&
    (editingChannel.children?.length ?? 0) > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  function set<K extends keyof ChannelFormValues>(key: K, value: ChannelFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-color)',
          width: '460px',
          maxWidth: '95vw',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          boxShadow: 'var(--glow-md)',
        }}
      >
        {/* Header */}
        <div
          style={{
            borderBottom: '1px solid var(--border-color)',
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '13px', letterSpacing: '0.12em' }}>
            ◈ {mode === 'create' ? 'CREATE CHANNEL' : 'EDIT CHANNEL'}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '16px',
              padding: '0 4px',
              fontFamily: 'var(--font-mono)',
              lineHeight: 1,
            }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

            {/* Name */}
            <div>
              <label style={labelStyle}>CHANNEL NAME *</label>
              <input
                data-testid="channel-name-input"
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Trading-Post-76"
                style={inputStyle}
              />
            </div>

            {/* Color + Sort Order — side by side */}
            <div style={{ display: 'flex', gap: '12px' }}>
              <div style={{ flex: '0 0 auto' }}>
                <label style={labelStyle}>COLOR</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="color"
                    value={form.color}
                    onChange={(e) => set('color', e.target.value)}
                    style={{ width: '44px', height: '34px', padding: '2px', border: '1px solid var(--border-color)', background: 'var(--bg-dark)', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{form.color}</span>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>SORT ORDER</label>
                <input
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => set('sortOrder', parseInt(e.target.value, 10) || 0)}
                  min={0}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
            </div>

            {/* Parent Channel — hidden when editing a top-level with children */}
            {!hideParent && (
              <div>
                <label style={labelStyle}>PARENT CHANNEL</label>
                <select
                  value={form.parentId}
                  onChange={(e) => set('parentId', e.target.value)}
                  style={{
                    ...inputStyle,
                    appearance: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <option value="">— None (top-level) —</option>
                  {topLevelChannels
                    .filter((ch) => editingChannel === null || ch.id !== editingChannel.id)
                    .map((ch) => (
                      <option key={ch.id} value={ch.id}>{ch.name}</option>
                    ))}
                </select>
              </div>
            )}

            {/* Discord Relay */}
            <div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  letterSpacing: '0.06em',
                }}
              >
                <input
                  type="checkbox"
                  checked={form.discordRelay}
                  onChange={(e) => set('discordRelay', e.target.checked)}
                  style={{ accentColor: 'var(--phosphor-color)', width: '14px', height: '14px' }}
                />
                DISCORD RELAY
              </label>
            </div>

            {/* Discord Channel ID — shown only when relay is on */}
            {form.discordRelay && (
              <div>
                <label style={labelStyle}>DISCORD CHANNEL, THREAD, OR FORUM POST ID</label>
                <input
                  value={form.discordChannelId}
                  onChange={(e) => set('discordChannelId', e.target.value)}
                  placeholder="e.g. 1234567890123456789"
                  style={inputStyle}
                />
              </div>
            )}

            {/* Allow GIFs */}
            <div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  letterSpacing: '0.06em',
                }}
              >
                <input
                  type="checkbox"
                  checked={form.allowGifs}
                  onChange={(e) => set('allowGifs', e.target.checked)}
                  style={{ accentColor: 'var(--phosphor-color)', width: '14px', height: '14px' }}
                />
                ALLOW GIFS
              </label>
            </div>

            {/* Allow Emojis */}
            <div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  letterSpacing: '0.06em',
                }}
              >
                <input
                  type="checkbox"
                  checked={form.allowEmojis}
                  onChange={(e) => set('allowEmojis', e.target.checked)}
                  style={{ accentColor: 'var(--phosphor-color)', width: '14px', height: '14px' }}
                />
                ALLOW EMOJIS
              </label>
            </div>

            {error && (
              <div style={{ color: 'var(--danger)', fontSize: '12px' }}>{error}</div>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              borderTop: '1px solid var(--border-color)',
              padding: '12px 16px',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid var(--border-color)',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                letterSpacing: '0.08em',
                padding: '7px 18px',
                cursor: 'pointer',
              }}
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={saving}
              data-testid="create-channel-btn"
            >
              {saving ? 'SAVING…' : 'SAVE'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Empty form factory ───────────────────────────────────────────────────────

function emptyForm(overrides?: Partial<ChannelFormValues>): ChannelFormValues {
  return {
    name: '',
    color: '#C8A840',
    parentId: '',
    sortOrder: 0,
    discordRelay: false,
    discordChannelId: '',
    allowGifs: false,
    allowEmojis: true,
    ...overrides,
  };
}

function channelToForm(ch: Channel): ChannelFormValues {
  return {
    name: ch.name,
    color: ch.color,
    parentId: ch.parentId ?? '',
    sortOrder: ch.sortOrder,
    discordRelay: ch.discordRelay,
    discordChannelId: ch.discordChannelId ?? '',
    allowGifs: ch.allowGifs,
    allowEmojis: ch.allowEmojis,
  };
}

// ─── Channel row ──────────────────────────────────────────────────────────────

interface ChannelRowProps {
  channel: Channel;
  depth: number;
  topLevelChannels: Channel[];
  onEdit: (ch: Channel) => void;
  onAddSub: (parentId: string) => void;
  onArchive: (ch: Channel) => void;
  onDelete: (ch: Channel) => void;
}

function ChannelRow({ channel, depth, topLevelChannels, onEdit, onAddSub, onArchive, onDelete }: ChannelRowProps) {
  const isSubChannel = depth > 0;

  return (
    <>
      <tr data-testid="channel-row">
        <td style={{ paddingLeft: `${8 + depth * 24}px` }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {isSubChannel && (
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '13px', userSelect: 'none' }}>
                └
              </span>
            )}
            <span
              style={{
                display: 'inline-block',
                width: '10px',
                height: '10px',
                borderRadius: '2px',
                background: channel.color,
                flexShrink: 0,
                boxShadow: `0 0 4px ${channel.color}66`,
              }}
            />
            {channel.name}
          </span>
        </td>
        <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
          {channel.color}
        </td>
        <td style={{ textAlign: 'center' }}>
          {channel.discordRelay ? (
            <span style={{ color: 'var(--phosphor-color)', fontSize: '12px' }}>
              ✓{channel.discordChannelId ? <span style={{ color: 'var(--text-secondary)', marginLeft: '6px' }}>{channel.discordChannelId}</span> : null}
            </span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>–</span>
          )}
        </td>
        <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
          {channel.sortOrder}
        </td>
        <td>
          <div style={{ display: 'flex', gap: '5px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => onEdit(channel)}
              style={{ padding: '3px 10px', fontSize: '11px', minHeight: '28px' }}
              title="Edit channel"
            >
              EDIT
            </button>
            {depth === 0 && (
              <button
                onClick={() => onAddSub(channel.id)}
                style={{ padding: '3px 10px', fontSize: '11px', minHeight: '28px' }}
                title="Add sub-channel"
              >
                + SUB
              </button>
            )}
            <button
              className="danger"
              onClick={() => onArchive(channel)}
              style={{ padding: '3px 10px', fontSize: '11px', minHeight: '28px' }}
            >
              ARCHIVE
            </button>
            <button
              className="danger"
              onClick={() => onDelete(channel)}
              style={{ padding: '3px 10px', fontSize: '11px', minHeight: '28px', opacity: 0.8 }}
              title="Permanently delete channel and all its messages"
            >
              DELETE
            </button>
          </div>
        </td>
      </tr>

      {(channel.children ?? []).map((child) => (
        <ChannelRow
          key={child.id}
          channel={child}
          depth={depth + 1}
          topLevelChannels={topLevelChannels}
          onEdit={onEdit}
          onAddSub={onAddSub}
          onArchive={onArchive}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ModalState {
  open: boolean;
  mode: 'create' | 'edit';
  initial: ChannelFormValues;
  editingChannel: Channel | null;
}

export default function Channels() {
  const queryClient = useQueryClient();

  const { data: channelsRaw, isLoading, error: queryError } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<Channel[]>('/api/channels'),
  });

  const channels: Channel[] = channelsRaw ?? [];
  // Top-level channels only (for parent dropdown)
  const topLevelChannels = channels.filter((ch) => ch.parentId === null);

  const [modal, setModal] = useState<ModalState>({
    open: false,
    mode: 'create',
    initial: emptyForm(),
    editingChannel: null,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['channels'] });
  }

  function openCreate(overrides?: Partial<ChannelFormValues>) {
    setModal({ open: true, mode: 'create', initial: emptyForm(overrides), editingChannel: null });
  }

  function openEdit(ch: Channel) {
    setModal({ open: true, mode: 'edit', initial: channelToForm(ch), editingChannel: ch });
  }

  function openAddSub(parentId: string) {
    openCreate({ parentId });
  }

  function closeModal() {
    setModal((prev) => ({ ...prev, open: false }));
  }

  async function handleSave(values: ChannelFormValues) {
    const body = {
      name: values.name.trim(),
      color: values.color,
      parentId: values.parentId || null,
      sortOrder: values.sortOrder,
      discordRelay: values.discordRelay,
      discordChannelId: values.discordRelay && values.discordChannelId.trim() ? values.discordChannelId.trim() : null,
      allowGifs: values.allowGifs,
      allowEmojis: values.allowEmojis,
    };

    if (modal.mode === 'create') {
      await api.post('/api/channels', body);
    } else if (modal.editingChannel) {
      await api.patch(`/api/channels/${modal.editingChannel.id}`, body);
    }

    closeModal();
    refresh();
  }

  async function handleArchive(ch: Channel) {
    const label = ch.children.length > 0
      ? `Archive "${ch.name}" and its ${ch.children.length} sub-channel(s)?`
      : `Archive "${ch.name}"?`;
    if (!confirm(`${label} History will be preserved but it will stop accepting messages.`)) return;
    try {
      await api.delete(`/api/channels/${ch.id}`);
      refresh();
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to archive channel');
    }
  }

  async function handleDelete(ch: Channel) {
    const childCount = ch.children?.length ?? 0;
    const label = childCount > 0
      ? `Permanently delete "${ch.name}" and its ${childCount} sub-channel(s) AND ALL their messages?`
      : `Permanently delete "${ch.name}" and ALL its messages?`;
    if (!confirm(`⚠ ${label}\n\nThis cannot be undone.`)) return;
    try {
      await api.delete(`/api/channels/${ch.id}/permanent`);
      refresh();
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to delete channel');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h1 style={{ fontSize: '18px', margin: 0 }}>◈ CHANNELS</h1>
        <button
          data-testid="create-channel-btn"
          onClick={() => openCreate()}
          style={{ fontSize: '12px', letterSpacing: '0.08em' }}
        >
          + CREATE CHANNEL
        </button>
      </div>

      {queryError && (
        <div className="error-message" style={{ marginBottom: '12px' }}>
          {(queryError as Error).message}
        </div>
      )}

      {isLoading ? (
        <div className="loading">Loading channels…</div>
      ) : (
        <div className="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Color</th>
                <th>Discord Relay</th>
                <th style={{ textAlign: 'center' }}>Order</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {channels.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ color: 'var(--text-muted)' }}>No channels found.</td>
                </tr>
              )}
              {topLevelChannels.map((ch) => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  depth={0}
                  topLevelChannels={topLevelChannels}
                  onEdit={openEdit}
                  onAddSub={openAddSub}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal.open && (
        <ChannelModal
          mode={modal.mode}
          initial={modal.initial}
          topLevelChannels={topLevelChannels}
          editingChannel={modal.editingChannel}
          onSave={handleSave}
          onClose={closeModal}
        />
      )}
    </div>
  );
}
