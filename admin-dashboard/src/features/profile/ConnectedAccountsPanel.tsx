import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../../services/api';

interface LinkState { providers: { provider: string; username?: string | null }[] }

export default function ConnectedAccountsPanel({ userId }: { userId: string }) {
  const [params] = useSearchParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['my-connected-accounts', userId],
    queryFn: () => api.get<LinkState>('/api/link/game'),
  });
  const discord = data?.providers.find(p => p.provider === 'discord');
  return <section style={{ marginTop: 16, padding: 18, border: '1px solid var(--border-color)' }}>
    <h2 style={{ fontSize: 14 }}>Connected accounts</h2>
    <p>Discord is optional. Link it here whenever you wish.</p>
    {params.get('linked') === 'discord' && <p role="status">Discord linked successfully.</p>}
    {params.has('linkError') && <p role="alert">Discord could not be linked. Your account was kept unchanged. If Discord belongs to another FCM account, contact support.</p>}
    {isLoading ? <p>Loading accounts…</p> : error ? <p role="alert">Unable to load connected accounts. Refresh to try again.</p> : <>
      <p>Steam: {data?.providers.some(p => p.provider === 'steam') ? 'Connected' : 'Not connected'}</p>
      {discord ? <p>Discord: {discord.username || 'Connected'}</p> : <a href="/auth/discord/profile">Link Discord</a>}
    </>}
  </section>;
}
