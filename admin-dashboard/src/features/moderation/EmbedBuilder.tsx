import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import EmojiPicker from '../chat/EmojiPicker';

// Resolve a CSS custom property at runtime so the emoji picker chrome
// matches the active dashboard theme instead of a hardcoded colour.
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// EmojiPicker theme props require hex strings, not CSS variables.
function hexAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const aa = Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${h}${aa}`;
}
function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Mirrors backend EmbedData (discordService.ts) — keep in sync.
interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}
interface EmbedData {
  title?: string;
  description?: string;
  url?: string;
  color?: string;
  authorName?: string;
  authorIconUrl?: string;
  authorUrl?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  footerText?: string;
  footerIconUrl?: string;
  timestamp?: boolean;
  fields?: EmbedField[];
  content?: string;
}
interface SavedEmbed {
  id: number;
  name: string;
  data: EmbedData;
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
interface ReactionRoleRow {
  /** Unicode char or <:name:id> / <a:name:id> display string for custom emojis.
   *  When the user picks from the server custom-emoji section of the picker
   *  this holds the full Discord tag; customEmojiId is also set in that case. */
  emoji: string;
  roleId: string;
  /** Discord snowflake for a custom server emoji — set when the user picks a
   *  server emoji from the picker. Undefined for unicode emojis. */
  customEmojiId?: string;
  /** True when the custom emoji is animated (gif). */
  animated?: boolean;
}
interface ReactionRolePanel {
  messageId: string;
  channelId: string;
  guildId: string;
  mappings: Array<{ emoji: string; roleId: string; roleName?: string }>;
  createdAt: string;
}

const DEFAULT_COLOR = '#18FF62';
const emptyEmbed: EmbedData = { color: DEFAULT_COLOR, fields: [] };

export default function EmbedBuilder() {
  const queryClient = useQueryClient();

  const { data: saved } = useQuery({
    queryKey: ['discord-embeds'],
    queryFn: () => api.get<SavedEmbed[]>('/api/moderation/discord-embeds'),
  });
  const { data: channels } = useQuery({
    queryKey: ['discord-channels'],
    queryFn: () => api.get<DiscordChannel[]>('/api/moderation/discord-channels'),
  });
  const { data: roles } = useQuery({
    queryKey: ['discord-roles'],
    queryFn: () => api.get<DiscordRole[]>('/api/moderation/discord-roles'),
  });
  const { data: panels } = useQuery({
    queryKey: ['reaction-role-panels'],
    queryFn: () => api.get<ReactionRolePanel[]>('/api/moderation/reaction-role-panels'),
  });

  const [embed, setEmbed] = useState<EmbedData>(emptyEmbed);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [channelId, setChannelId] = useState('');
  const [reactionRoles, setReactionRoles] = useState<ReactionRoleRow[]>([]);
  const [pickerOpenForRow, setPickerOpenForRow] = useState<number | null>(null);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  // Recompute picker position on open, scroll, and resize so it stays
  // attached to its trigger regardless of column widths or overflow.
  useEffect(() => {
    if (pickerOpenForRow === null) { setPickerPos(null); return; }
    const reposition = () => {
      const btn = triggerRefs.current[pickerOpenForRow];
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const PICKER_H = 360, PICKER_W = 340, GAP = 4;
      const spaceBelow = window.innerHeight - r.bottom;
      const top = spaceBelow >= PICKER_H + GAP
        ? r.bottom + GAP
        : Math.max(8, r.top - PICKER_H - GAP);
      // Prefer aligning left-edge of picker with left-edge of button; clamp to viewport.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - PICKER_W - 8));
      setPickerPos({ top, left });
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [pickerOpenForRow]);

  // Snapshot theme colours at mount (empty dep array — sufficient for now).
  const pickerTheme = useMemo(() => ({
    primaryColor: cssVar('--phosphor-color', '#d4b040'),
    chromeColor: cssVar('--bg-panel', '#28200e'),
    inputBgColor: cssVar('--bg-card', '#322814'),
    fontFamily: 'Courier New, monospace',
  }), []);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  useEffect(() => {
    if (channels && channels.length > 0 && !channelId) setChannelId(channels[0].id);
  }, [channels]);

  function set<K extends keyof EmbedData>(key: K, val: EmbedData[K]) {
    setEmbed((e) => ({ ...e, [key]: val }));
  }

  function loadTemplate(t: SavedEmbed) {
    setEmbed({ ...emptyEmbed, ...t.data, fields: t.data.fields ?? [] });
    setName(t.name);
    setEditingId(t.id);
    setFeedback(null);
  }

  function resetForm() {
    setEmbed(emptyEmbed);
    setName('');
    setEditingId(null);
    setFeedback(null);
  }

  // ── Field rows ────────────────────────────────────────────────────────────
  function addField() {
    setEmbed((e) => ({ ...e, fields: [...(e.fields ?? []), { name: '', value: '', inline: false }] }));
  }
  function updateField(i: number, patch: Partial<EmbedField>) {
    setEmbed((e) => ({ ...e, fields: (e.fields ?? []).map((f, idx) => (idx === i ? { ...f, ...patch } : f)) }));
  }
  function removeField(i: number) {
    setEmbed((e) => ({ ...e, fields: (e.fields ?? []).filter((_, idx) => idx !== i) }));
  }

  // ── Reaction-role rows ────────────────────────────────────────────────────
  function addReactionRole() {
    setReactionRoles((rr) => [...rr, { emoji: '', roleId: roles?.[0]?.id ?? '' }]);
  }
  function updateReactionRole(i: number, patch: Partial<ReactionRoleRow>) {
    setReactionRoles((rr) => rr.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function removeReactionRole(i: number) {
    setReactionRoles((rr) => rr.filter((_, idx) => idx !== i));
  }

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['discord-embeds'] });
  }

  async function handleSaveTemplate() {
    if (!name.trim()) {
      setFeedback({ kind: 'err', msg: 'Give the template a name first.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const body = { name: name.trim(), data: embed };
      if (editingId) await api.put(`/api/moderation/discord-embeds/${editingId}`, body);
      else {
        const created = await api.post<SavedEmbed>('/api/moderation/discord-embeds', body);
        setEditingId(created.id);
      }
      setFeedback({ kind: 'ok', msg: 'Template saved.' });
      refresh();
    } catch (err: any) {
      setFeedback({ kind: 'err', msg: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteTemplate(id: number) {
    if (!confirm('Delete this saved embed?')) return;
    try {
      await api.delete(`/api/moderation/discord-embeds/${id}`);
      if (editingId === id) resetForm();
      refresh();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleSend() {
    if (!channelId) {
      setFeedback({ kind: 'err', msg: 'Pick a channel to send to.' });
      return;
    }
    // A row is valid when it has a non-empty emoji string or customEmojiId, plus a roleId.
    const validRR = reactionRoles.filter((m) => (m.emoji.trim() || m.customEmojiId) && m.roleId);
    if (reactionRoles.length > 0 && validRR.length !== reactionRoles.length) {
      setFeedback({ kind: 'err', msg: 'Every reaction role needs both an emoji (or server emoji) and a role.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      // Pass customEmojiId and animated so the backend builds unambiguous matchKey/reactValue.
      const rrPayload = validRR.map((m) => ({
        emoji: m.emoji,
        roleId: m.roleId,
        ...(m.customEmojiId ? { customEmojiId: m.customEmojiId, animated: m.animated ?? false } : {}),
      }));
      const res = await api.post<{ reactionRoles: number }>('/api/moderation/discord-embeds/send', {
        channelId,
        embed,
        reactionRoles: rrPayload,
      });
      setFeedback({
        kind: 'ok',
        msg: res?.reactionRoles ? `Embed sent with ${res.reactionRoles} reaction role(s).` : 'Embed sent to Discord.',
      });
      queryClient.invalidateQueries({ queryKey: ['reaction-role-panels'] });
    } catch (err: any) {
      setFeedback({ kind: 'err', msg: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePanel(messageId: string) {
    if (!confirm('Stop this message from granting roles? (Existing roles already given are kept.)')) return;
    try {
      await api.delete(`/api/moderation/reaction-role-panels/${messageId}`);
      queryClient.invalidateQueries({ queryKey: ['reaction-role-panels'] });
    } catch (err: any) {
      alert(err.message);
    }
  }

  const roleName = (id: string) => roles?.find((r) => r.id === id)?.name ?? id;
  const channelName = (id: string) => channels?.find((c) => c.id === id)?.name ?? id;

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' };
  const fieldWrap: React.CSSProperties = { marginBottom: '12px' };
  const accent = /^#?[0-9a-fA-F]{6}$/.test(embed.color || '') ? (embed.color!.startsWith('#') ? embed.color! : `#${embed.color}`) : '#4f545c';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h1 style={{ fontSize: '18px', margin: 0 }}>◈ DISCORD EMBEDS</h1>
        <button onClick={resetForm} style={{ fontSize: '12px', letterSpacing: '0.08em' }}>+ NEW EMBED</button>
      </div>

      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ─── Editor ─── */}
        <div style={{ flex: '1 1 380px', minWidth: '320px' }}>
          <div style={fieldWrap}>
            <label style={labelStyle}>TEMPLATE NAME</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Server Rules" style={{ width: '100%' }} maxLength={100} />
          </div>

          <div style={fieldWrap}>
            <label style={labelStyle}>MESSAGE TEXT (optional, sent above the embed)</label>
            <input value={embed.content || ''} onChange={(e) => set('content', e.target.value)} placeholder="@everyone ..." style={{ width: '100%' }} maxLength={2000} />
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ ...fieldWrap, flex: 1 }}>
              <label style={labelStyle}>TITLE</label>
              <input value={embed.title || ''} onChange={(e) => set('title', e.target.value)} style={{ width: '100%' }} maxLength={256} />
            </div>
            <div style={{ ...fieldWrap, width: '110px' }}>
              <label style={labelStyle}>COLOR</label>
              <input type="color" value={accent} onChange={(e) => set('color', e.target.value)} style={{ width: '100%', height: '34px', padding: '2px' }} />
            </div>
          </div>

          <div style={fieldWrap}>
            <label style={labelStyle}>TITLE URL (optional)</label>
            <input value={embed.url || ''} onChange={(e) => set('url', e.target.value)} placeholder="https://..." style={{ width: '100%' }} />
          </div>

          <div style={fieldWrap}>
            <label style={labelStyle}>DESCRIPTION (Markdown supported)</label>
            <textarea value={embed.description || ''} onChange={(e) => set('description', e.target.value)} rows={4} style={{ width: '100%', resize: 'vertical' }} maxLength={4096} />
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ ...fieldWrap, flex: 1 }}>
              <label style={labelStyle}>AUTHOR NAME</label>
              <input value={embed.authorName || ''} onChange={(e) => set('authorName', e.target.value)} style={{ width: '100%' }} maxLength={256} />
            </div>
            <div style={{ ...fieldWrap, flex: 1 }}>
              <label style={labelStyle}>AUTHOR ICON URL</label>
              <input value={embed.authorIconUrl || ''} onChange={(e) => set('authorIconUrl', e.target.value)} placeholder="https://..." style={{ width: '100%' }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ ...fieldWrap, flex: 1 }}>
              <label style={labelStyle}>THUMBNAIL URL</label>
              <input value={embed.thumbnailUrl || ''} onChange={(e) => set('thumbnailUrl', e.target.value)} placeholder="https://..." style={{ width: '100%' }} />
            </div>
            <div style={{ ...fieldWrap, flex: 1 }}>
              <label style={labelStyle}>IMAGE URL</label>
              <input value={embed.imageUrl || ''} onChange={(e) => set('imageUrl', e.target.value)} placeholder="https://..." style={{ width: '100%' }} />
            </div>
          </div>

          {/* Fields */}
          <div style={fieldWrap}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>FIELDS ({(embed.fields ?? []).length}/25)</label>
              <button onClick={addField} disabled={(embed.fields ?? []).length >= 25} style={{ padding: '2px 10px', fontSize: '11px', minHeight: '28px' }}>+ ADD FIELD</button>
            </div>
            {(embed.fields ?? []).map((f, i) => (
              <div key={i} style={{ border: '1px solid var(--border-color)', padding: '8px', marginBottom: '8px' }}>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                  <input value={f.name} onChange={(e) => updateField(i, { name: e.target.value })} placeholder="Field name" style={{ flex: 1 }} maxLength={256} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={!!f.inline} onChange={(e) => updateField(i, { inline: e.target.checked })} /> Inline
                  </label>
                  <button className="danger" onClick={() => removeField(i)} style={{ padding: '2px 8px', fontSize: '11px', minHeight: '28px' }}>✕</button>
                </div>
                <textarea value={f.value} onChange={(e) => updateField(i, { value: e.target.value })} placeholder="Field value" rows={2} style={{ width: '100%', resize: 'vertical' }} maxLength={1024} />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ ...fieldWrap, flex: 1 }}>
              <label style={labelStyle}>FOOTER TEXT</label>
              <input value={embed.footerText || ''} onChange={(e) => set('footerText', e.target.value)} style={{ width: '100%' }} maxLength={2048} />
            </div>
            <div style={{ ...fieldWrap, flex: 1 }}>
              <label style={labelStyle}>FOOTER ICON URL</label>
              <input value={embed.footerIconUrl || ''} onChange={(e) => set('footerIconUrl', e.target.value)} placeholder="https://..." style={{ width: '100%' }} />
            </div>
          </div>

          {/* Reaction roles */}
          <div style={{ ...fieldWrap, border: '1px solid var(--border-color)', padding: '12px', background: 'var(--bg-panel)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>REACTION ROLES ({reactionRoles.length})</label>
              <button onClick={addReactionRole} disabled={!roles || roles.length === 0 || reactionRoles.length >= 20} style={{ padding: '2px 10px', fontSize: '11px', minHeight: '28px' }}>+ ADD</button>
            </div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 8px' }}>
              When sent, the bot adds these reactions to the message. Reacting grants the role; removing the reaction removes it.
              Click the smiley to pick from the full emoji set (including this server's custom emojis).
            </p>
            {(!roles || roles.length === 0) && (
              <div style={{ fontSize: '11px', color: 'var(--error)' }}>
                No assignable roles found — the bot must be online, have Manage Roles, and sit above the roles in the hierarchy.
              </div>
            )}
            {reactionRoles.map((m, i) => {
              // Render custom emoji as its CDN image; fall back to the unicode glyph.
              const custom = m.emoji.match(/^<a?:(\w+):(\d+)>$/);
              const previewNode = custom
                ? <img src={m.emoji.startsWith('<a:')
                    ? `https://cdn.discordapp.com/emojis/${custom[2]}.webp?size=24&animated=true`
                    : `https://cdn.discordapp.com/emojis/${custom[2]}.png?size=24`} alt={custom[1]} style={{ width: '20px', height: '20px', verticalAlign: 'middle' }} />
                : <span style={{ fontSize: '18px', lineHeight: 1 }}>{m.emoji || '🙂'}</span>;
              return (
                <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '6px', alignItems: 'center' }}>
                  <button
                    type="button"
                    ref={(el) => { triggerRefs.current[i] = el; }}
                    onClick={() => setPickerOpenForRow(pickerOpenForRow === i ? null : i)}
                    title="Pick an emoji"
                    style={{ width: '44px', height: '32px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0 }}
                  >
                    {previewNode}
                  </button>
                  <input
                    value={m.emoji}
                    onChange={(e) => {
                      // Manual input: clear custom emoji identity so backend uses raw string.
                      updateReactionRole(i, { emoji: e.target.value, customEmojiId: undefined, animated: undefined });
                    }}
                    placeholder="🎮 or <:name:id>"
                    style={{ width: '140px' }}
                  />
                  <select value={m.roleId} onChange={(e) => updateReactionRole(i, { roleId: e.target.value })} style={{ flex: 1 }}>
                    {(roles ?? []).map((r) => <option key={r.id} value={r.id}>@{r.name}</option>)}
                  </select>
                  <button className="danger" onClick={() => { removeReactionRole(i); if (pickerOpenForRow === i) setPickerOpenForRow(null); }} style={{ padding: '2px 8px', fontSize: '11px', minHeight: '28px' }}>✕</button>
                </div>
              );
            })}
          </div>

          {/* Actions — timestamp checkbox lives here, inline with SEND/SAVE */}
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)} style={{ minWidth: '180px' }}>
              {(!channels || channels.length === 0) && <option value="">No channels (bot offline?)</option>}
              {(channels ?? []).map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
            <button onClick={handleSend} disabled={busy}>SEND TO DISCORD</button>
            <button onClick={handleSaveTemplate} disabled={busy}>{editingId ? 'UPDATE TEMPLATE' : 'SAVE TEMPLATE'}</button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={!!embed.timestamp} onChange={(e) => set('timestamp', e.target.checked)} />
              Include current timestamp
            </label>
            {feedback && (
              <span style={{ fontSize: '12px', color: feedback.kind === 'err' ? 'var(--error)' : 'var(--success)' }}>{feedback.msg}</span>
            )}
          </div>
        </div>

        {/* ─── Live preview + saved templates ─── */}
        <div style={{ flex: '1 1 320px', minWidth: '300px' }}>
          <label style={labelStyle}>LIVE PREVIEW</label>
          <DiscordEmbedPreview embed={embed} accent={accent} />

          <div style={{ marginTop: '24px' }}>
            <label style={labelStyle}>SAVED TEMPLATES</label>
            {(saved ?? []).length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No saved embeds yet.</div>}
            {(saved ?? []).map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', border: '1px solid var(--border-color)', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px' }}>{t.name}</span>
                <span style={{ display: 'flex', gap: '6px' }}>
                  <button onClick={() => loadTemplate(t)} style={{ padding: '2px 10px', fontSize: '11px', minHeight: '28px' }}>LOAD</button>
                  <button className="danger" onClick={() => handleDeleteTemplate(t.id)} style={{ padding: '2px 10px', fontSize: '11px', minHeight: '28px' }}>DELETE</button>
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '24px' }}>
            <label style={labelStyle}>ACTIVE REACTION-ROLE PANELS</label>
            {(panels ?? []).length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No reaction-role panels yet. Add reaction roles above, then send an embed.</div>}
            {(panels ?? []).map((p) => (
              <div key={p.messageId} style={{ padding: '8px 10px', border: '1px solid var(--border-color)', marginBottom: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>#{channelName(p.channelId)}</span>
                  <button className="danger" onClick={() => handleDeletePanel(p.messageId)} style={{ padding: '2px 10px', fontSize: '11px', minHeight: '28px' }}>DELETE</button>
                </div>
                <div style={{ fontSize: '12px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {p.mappings.map((m, idx) => (
                    <span key={idx} style={{ padding: '1px 6px', border: '1px solid var(--border-color)', borderRadius: '3px' }}>
                      {m.emoji} → @{m.roleName ?? roleName(m.roleId)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Portal-rendered: escapes column overflow/clipping; lands at computed viewport coords. */}
      {pickerOpenForRow !== null && pickerPos !== null && createPortal(
        <EmojiPicker
          primaryColor={pickerTheme.primaryColor}
          chromeColor={pickerTheme.chromeColor}
          inputBgColor={pickerTheme.inputBgColor}
          fontFamily={pickerTheme.fontFamily}
          fontSize={13}
          hexAlpha={hexAlpha}
          hexToRgba={hexToRgba}
          glowEnabled={false}
          onInsert={(token) => {
            const customMatch = token.match(/^<(a?):(\w+):(\d+)>$/); // <:name:id> or <a:name:id>
            if (customMatch) {
              const animated = customMatch[1] === 'a';
              const customEmojiId = customMatch[3];
              updateReactionRole(pickerOpenForRow, { emoji: token, customEmojiId, animated });
            } else {
              // Unicode emoji — clear any prior custom emoji fields.
              updateReactionRole(pickerOpenForRow, { emoji: token, customEmojiId: undefined, animated: undefined });
            }
            setPickerOpenForRow(null);
          }}
          onClose={() => setPickerOpenForRow(null)}
          style={{ position: 'fixed', top: pickerPos.top, left: pickerPos.left, right: 'auto', bottom: 'auto', marginBottom: 0, zIndex: 9999 }}
        />,
        document.body,
      )}
    </div>
  );
}

// ── Discord-flavoured Markdown renderer (preview-only) ─────────────────────
// Block: ``` code ```, # headings, > blockquote, - /* unordered, 1. ordered.
// Inline: **bold**, */_italic_, __underline__, ~~strike~~, ||spoiler||,
//   `code`, [text](url), bare URLs, <:name:id> custom emojis (CDN image),
//   <@id> / <@&id> / <#id> mentions (generic pill — no name lookup).
// Nested inline is recursive.

type InlinePattern = { re: RegExp; el: (m: RegExpExecArray) => React.ReactNode };

const INLINE_PATTERNS: InlinePattern[] = [
  // Custom emoji — render as CDN image
  {
    re: /<(a?):(\w+):(\d+)>/,
    el: (m) => (
      <img
        src={m[1]
          ? `https://cdn.discordapp.com/emojis/${m[3]}.webp?size=24&animated=true`
          : `https://cdn.discordapp.com/emojis/${m[3]}.png?size=24`}
        alt={m[2]}
        style={{ width: '20px', height: '20px', verticalAlign: '-4px', display: 'inline-block' }}
      />
    ),
  },
  { re: /<@&(\d+)>/, el: () => <span style={{ background: '#3c4270', color: '#dee0fc', padding: '0 4px', borderRadius: '3px' }}>@role</span> },
  { re: /<@!?(\d+)>/, el: () => <span style={{ background: '#3c4270', color: '#dee0fc', padding: '0 4px', borderRadius: '3px' }}>@user</span> },
  { re: /<#(\d+)>/, el: () => <span style={{ background: '#3c4270', color: '#dee0fc', padding: '0 4px', borderRadius: '3px' }}>#channel</span> },
  // Inline code — no recursion into content
  {
    re: /`([^`\n]+)`/,
    el: (m) => (
      <code style={{ background: '#1e1f22', padding: '0 4px', borderRadius: '3px', fontFamily: 'Consolas, "Courier New", monospace', fontSize: '12px' }}>
        {m[1]}
      </code>
    ),
  },
  // Spoiler
  {
    re: /\|\|([\s\S]+?)\|\|/,
    el: (m) => (
      <span style={{ background: '#1e1f22', color: '#1e1f22', borderRadius: '3px', padding: '0 4px' }} title="(spoiler)">
        {parseInline(m[1])}
      </span>
    ),
  },
  // ** before * (longer wins); __ before _ (same reason)
  { re: /\*\*([\s\S]+?)\*\*/, el: (m) => <strong>{parseInline(m[1])}</strong> },
  { re: /__([\s\S]+?)__/, el: (m) => <span style={{ textDecoration: 'underline' }}>{parseInline(m[1])}</span> },
  { re: /~~([\s\S]+?)~~/, el: (m) => <span style={{ textDecoration: 'line-through' }}>{parseInline(m[1])}</span> },
  // * italic — disallow leading/trailing whitespace to avoid matching `* *`
  { re: /\*([^\s*][\s\S]*?[^\s*]|\S)\*/, el: (m) => <em>{parseInline(m[1])}</em> },
  // _ italic — word-boundary guard so snake_case doesn't render
  { re: /(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/, el: (m) => <em>{parseInline(m[1])}</em> },
  {
    re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    el: (m) => (
      <a href={m[2]} target="_blank" rel="noopener noreferrer" style={{ color: '#00a8fc', textDecoration: 'none' }}>
        {parseInline(m[1])}
      </a>
    ),
  },
  // Bare http(s) URL
  {
    re: /https?:\/\/[^\s<>"')]+/,
    el: (m) => (
      <a href={m[0]} target="_blank" rel="noopener noreferrer" style={{ color: '#00a8fc', textDecoration: 'none' }}>
        {m[0]}
      </a>
    ),
  },
];

function parseInline(text: string): React.ReactNode {
  if (!text) return text;
  let earliest: { idx: number; len: number; el: React.ReactNode } | null = null;
  for (const p of INLINE_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    const m = re.exec(text);
    if (m && m.index !== undefined && (earliest === null || m.index < earliest.idx)) {
      earliest = { idx: m.index, len: m[0].length, el: p.el(m) };
    }
  }
  if (!earliest) return text;
  return (
    <>
      {text.slice(0, earliest.idx)}
      {earliest.el}
      {parseInline(text.slice(earliest.idx + earliest.len))}
    </>
  );
}

function renderDiscordMarkdown(text: string | undefined): React.ReactNode {
  if (!text) return null;

  // Extract fenced code blocks first so their contents aren't inline-parsed.
  const segments: Array<{ kind: 'code'; content: string; lang?: string } | { kind: 'text'; content: string }> = [];
  const fenceRe = /```(\w+)?\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text)) !== null) {
    if (fm.index > lastIdx) segments.push({ kind: 'text', content: text.slice(lastIdx, fm.index) });
    segments.push({ kind: 'code', content: fm[2].replace(/\n$/, ''), lang: fm[1] });
    lastIdx = fm.index + fm[0].length;
  }
  if (lastIdx < text.length) segments.push({ kind: 'text', content: text.slice(lastIdx) });

  const out: React.ReactNode[] = [];

  for (const seg of segments) {
    if (seg.kind === 'code') {
      out.push(
        <pre
          key={`c${out.length}`}
          style={{ background: '#1e1f22', padding: '8px 12px', borderRadius: '4px', fontSize: '12px', overflowX: 'auto', margin: '4px 0', fontFamily: 'Consolas, "Courier New", monospace', whiteSpace: 'pre' }}
        >
          {seg.content}
        </pre>,
      );
      continue;
    }
    const lines = seg.content.split('\n');
    let paraBuf: string[] = [];
    let listItems: React.ReactNode[] | null = null;
    let listType: 'ul' | 'ol' | null = null;

    const flushPara = () => {
      if (paraBuf.length === 0) return;
      out.push(
        <div key={`p${out.length}`} style={{ marginBottom: '4px' }}>
          {paraBuf.map((l, i) => (
            <React.Fragment key={i}>
              {i > 0 && <br />}
              {parseInline(l)}
            </React.Fragment>
          ))}
        </div>,
      );
      paraBuf = [];
    };
    const flushList = () => {
      if (!listItems) return;
      const items = listItems;
      const Tag: 'ol' | 'ul' = listType === 'ol' ? 'ol' : 'ul';
      out.push(
        <Tag key={`l${out.length}`} style={{ margin: '4px 0', paddingLeft: '24px' }}>{items}</Tag>,
      );
      listItems = null;
      listType = null;
    };

    for (const line of lines) {
      if (line.trim() === '') {
        flushPara();
        flushList();
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        flushPara();
        flushList();
        const level = h[1].length;
        const fontSize = level === 1 ? '20px' : level === 2 ? '16px' : '14px';
        const Tag = (`h${level}`) as 'h1' | 'h2' | 'h3';
        out.push(
          React.createElement(
            Tag,
            { key: `h${out.length}`, style: { fontSize, fontWeight: 700, color: '#f2f3f5', margin: '8px 0 4px' } },
            parseInline(h[2]),
          ),
        );
        continue;
      }
      if (line.startsWith('> ')) {
        flushPara();
        flushList();
        out.push(
          <div key={`q${out.length}`} style={{ borderLeft: '4px solid #4e5058', paddingLeft: '8px', color: '#dbdee1', margin: '4px 0' }}>
            {parseInline(line.slice(2))}
          </div>,
        );
        continue;
      }
      const ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listType !== 'ul') { flushList(); listItems = []; listType = 'ul'; }
        listItems!.push(<li key={listItems!.length}>{parseInline(ul[1])}</li>);
        continue;
      }
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ol) {
        flushPara();
        if (listType !== 'ol') { flushList(); listItems = []; listType = 'ol'; }
        listItems!.push(<li key={listItems!.length}>{parseInline(ol[1])}</li>);
        continue;
      }
      flushList();
      paraBuf.push(line);
    }
    flushPara();
    flushList();
  }

  return <>{out}</>;
}

/** Discord-style embed card preview (left color bar, title, fields grid, image, footer). */
function DiscordEmbedPreview({ embed, accent }: { embed: EmbedData; accent: string }) {
  const has = embed.title || embed.description || (embed.fields ?? []).some((f) => f.name || f.value) || embed.imageUrl || embed.authorName || embed.footerText;
  return (
    <div style={{ background: '#313338', borderRadius: '4px', padding: '2px', maxWidth: '440px' }}>
      {/* Content sent above the embed — Discord renders it as a normal message. */}
      {embed.content && (
        <div style={{ padding: '4px 12px 6px', color: '#dbdee1', fontSize: '14px', lineHeight: 1.4 }}>
          {renderDiscordMarkdown(embed.content)}
        </div>
      )}
      <div style={{ borderLeft: `4px solid ${accent}`, borderRadius: '4px', background: '#2b2d31', padding: '12px 16px', color: '#dbdee1', fontSize: '14px', lineHeight: 1.4 }}>
        {!has && <span style={{ color: '#949ba4', fontSize: '12px' }}>Start typing to preview your embed…</span>}

        {embed.authorName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '13px', fontWeight: 600 }}>
            {embed.authorIconUrl && <img src={embed.authorIconUrl} alt="" style={{ width: '24px', height: '24px', borderRadius: '50%' }} />}
            <span>{embed.authorName}</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {embed.title && (
              <div style={{ color: embed.url ? '#00a8fc' : '#f2f3f5', fontWeight: 600, marginBottom: '6px' }}>{embed.title}</div>
            )}
            {embed.description && (
              <div style={{ marginBottom: '8px' }}>{renderDiscordMarkdown(embed.description)}</div>
            )}

            {(embed.fields ?? []).filter((f) => f.name || f.value).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                {(embed.fields ?? []).filter((f) => f.name || f.value).map((f, i) => (
                  <div key={i} style={{ flex: f.inline ? '1 1 30%' : '1 1 100%', minWidth: f.inline ? '120px' : '100%' }}>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: '#f2f3f5' }}>{parseInline(f.name || '​')}</div>
                    <div style={{ fontSize: '13px' }}>{f.value ? renderDiscordMarkdown(f.value) : '​'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {embed.thumbnailUrl && (
            <img src={embed.thumbnailUrl} alt="" style={{ width: '64px', height: '64px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }} />
          )}
        </div>

        {embed.imageUrl && (
          <img src={embed.imageUrl} alt="" style={{ width: '100%', borderRadius: '4px', marginTop: '10px', display: 'block' }} />
        )}

        {(embed.footerText || embed.timestamp) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '12px', color: '#949ba4' }}>
            {embed.footerIconUrl && <img src={embed.footerIconUrl} alt="" style={{ width: '20px', height: '20px', borderRadius: '50%' }} />}
            <span>
              {embed.footerText}
              {embed.footerText && embed.timestamp ? ' • ' : ''}
              {embed.timestamp ? new Date().toLocaleString() : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
