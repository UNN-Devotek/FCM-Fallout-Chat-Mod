import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

interface VoiceSettings {
  enabled: boolean;
  lobbyChannelId: string;
  categoryId: string;
  nameTemplate: string;
}

const EMPTY: VoiceSettings = { enabled: false, lobbyChannelId: '', categoryId: '', nameTemplate: "{user}'s Channel" };

export default function Voice() {
  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['voice-settings'],
    queryFn: () => api.get<VoiceSettings>('/api/moderation/voice-settings'),
  });

  const [draft, setDraft] = useState<VoiceSettings>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  async function handleSave() {
    setSaving(true);
    setFeedback(null);
    try {
      await api.put('/api/moderation/voice-settings', draft);
      setFeedback('Settings saved.');
    } catch (err: any) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' };
  const fieldStyle: React.CSSProperties = { marginBottom: '16px', maxWidth: '420px' };

  return (
    <div>
      <h1 style={{ fontSize: '18px', marginBottom: '16px' }}>◈ VOICE CHANNELS</h1>

      <section style={{ padding: '16px', background: 'var(--bg-panel)', border: '1px solid var(--border-color)', maxWidth: '560px', margin: '0 auto' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: 0, marginBottom: '16px' }}>
          "Join-to-Create" voice channels. When a member joins the lobby voice channel below, the bot
          creates a personal voice channel, moves them in, and posts a button control panel
          (lock, limit, rename, hide, kick, permit/reject, transfer, claim, region/bitrate). The
          channel is deleted automatically when it empties.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '11px', marginBottom: '16px' }}>
          The bot needs <strong>Manage Channels, Move Members, Manage Roles, View Channel, Connect</strong>{' '}
          in the Discord server. Get IDs by right-clicking a channel/category with Developer Mode on.
        </p>

        {queryError && <div className="error-message" style={{ marginBottom: '12px' }}>{(queryError as Error).message}</div>}
        {isLoading ? (
          <div className="loading">Loading...</div>
        ) : (
          <>
            <div style={fieldStyle}>
              <label style={labelStyle}>LOBBY VOICE CHANNEL ID {draft.enabled && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
              <input
                value={draft.lobbyChannelId}
                onChange={(e) => setDraft({ ...draft, lobbyChannelId: e.target.value })}
                placeholder="e.g. 123456789012345678"
                style={{ width: '100%' }}
              />
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle}>CATEGORY ID (optional)</label>
              <input
                value={draft.categoryId}
                onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
                placeholder="Where temp channels are created (defaults to lobby's category)"
                style={{ width: '100%' }}
              />
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle}>NAME TEMPLATE</label>
              <input
                value={draft.nameTemplate}
                onChange={(e) => setDraft({ ...draft, nameTemplate: e.target.value })}
                placeholder="{user}'s Channel"
                maxLength={100}
                style={{ width: '100%' }}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{'{user}'} is replaced with the creator's display name.</span>
            </div>

            {/* Bottom row: enabled checkbox (left) + Save button (right) */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px', gap: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  style={{ width: 'auto' }}
                />
                Enable voice channels
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                {feedback && (
                  <span style={{ fontSize: '12px', color: feedback.startsWith('Error') ? 'var(--danger)' : 'var(--phosphor-color)' }}>
                    {feedback}
                  </span>
                )}
                <button onClick={handleSave} disabled={saving}>{saving ? 'SAVING...' : 'SAVE'}</button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
