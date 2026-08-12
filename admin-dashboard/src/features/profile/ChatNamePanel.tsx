/** Free account chat-name editor. Deliberately independent from supporter cosmetics. */
import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

const CHAT_NAME_MAX_LENGTH = 32;

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: '6px', padding: '20px', marginBottom: '20px',
};

const input: React.CSSProperties = {
  width: '100%', maxWidth: '340px', padding: '8px 10px',
  background: 'var(--bg-dark)', border: '1px solid var(--border-color)',
  borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)',
};

const button: React.CSSProperties = {
  padding: '7px 14px', borderRadius: '4px', cursor: 'pointer',
  border: '1px solid var(--phosphor-color)', background: 'rgba(212,176,64,0.08)',
  color: 'var(--phosphor-color)', fontFamily: 'var(--font-mono)', fontSize: '13px',
};

export default function ChatNamePanel({ userId, chatName }: { userId: string; chatName: string | null }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(chatName ?? '');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setDraft(chatName ?? ''), [chatName]);
  const tooLong = draft.length > CHAT_NAME_MAX_LENGTH;

  const save = useMutation({
    mutationFn: () => api.patch<{ chatName: string | null }>(`/api/users/${userId}/chat-name`, {
      chatName: draft.trim() || null,
    }),
    onSuccess: () => {
      setNotice('Saved.');
      void queryClient.invalidateQueries({ queryKey: ['profile', userId] });
      window.setTimeout(() => setNotice(null), 1800);
    },
    onError: (error: unknown) => setNotice(error instanceof Error ? error.message : 'Could not save your chat name.'),
  });

  return (
    <section style={card}>
      <h2 style={{ fontSize: '16px', margin: '0 0 4px', color: 'var(--phosphor-color)' }}>Chat name</h2>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 14px' }}>
        This is free for everyone and appears across FCM. Leave it blank to use your
        Fallout 76 or Discord name instead. You can also change it with <code>/name</code> in Discord.
      </p>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={draft}
          maxLength={CHAT_NAME_MAX_LENGTH + 8}
          onChange={event => setDraft(event.target.value)}
          placeholder="Use your Fallout 76 / Discord name"
          aria-label="Chat name"
          style={{ ...input, borderColor: tooLong ? 'var(--danger)' : 'var(--border-color)' }}
        />
        <span style={{ fontSize: '12px', color: tooLong ? 'var(--danger)' : 'var(--text-muted)' }}>
          {draft.length}/{CHAT_NAME_MAX_LENGTH}
        </span>
        <button type="button" disabled={tooLong || save.isPending} style={{ ...button, opacity: tooLong || save.isPending ? 0.5 : 1 }} onClick={() => save.mutate()}>
          Save name
        </button>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '7px 0 0' }}>
        There is no supporter tier requirement or name-change cooldown.
      </p>
      {notice && <p style={{ color: notice === 'Saved.' ? 'var(--phosphor-color)' : 'var(--danger)', fontSize: '13px', margin: '10px 0 0' }}>{notice}</p>}
    </section>
  );
}
