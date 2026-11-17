import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
let outletRole = 'admin';

vi.mock('../../../services/api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('react-router', () => ({
  useOutletContext: () => ({ user: { role: outletRole } }),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import Users, { userActionPermissions } from '../Users';

const base = {
  steamId: null, discordId: null, discordUsername: null, discordAvatar: null,
  isMuted: false, muteExpiresAt: null, banReason: null, createdAt: '2026-01-01T00:00:00.000Z',
};

function renderUsers(role: string) {
  outletRole = role;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Users /></QueryClientProvider>);
}

describe('Users page action gating', () => {
  beforeEach(() => {
    apiGet.mockResolvedValue([
      { ...base, id: 'u-ok', username: 'Okay', isBanned: false },
      { ...base, id: 'u-banned', username: 'Banned', isBanned: true },
    ]);
  });
  afterEach(() => cleanup());

  it('mirrors the backend route roles', () => {
    expect(userActionPermissions('owner')).toEqual({ canBan: true, canUnban: true, canWipe: true, canDelete: true });
    expect(userActionPermissions('admin')).toEqual({ canBan: true, canUnban: false, canWipe: false, canDelete: false });
    expect(userActionPermissions('moderator')).toEqual({ canBan: false, canUnban: false, canWipe: false, canDelete: false });
  });

  it('hides owner-only Unban, Wipe and Delete from admins but keeps Ban', async () => {
    renderUsers('admin');
    expect(await screen.findAllByTestId('user-row')).toHaveLength(2);
    expect(screen.getAllByTestId('ban-btn')).toHaveLength(1);
    expect(screen.queryByTestId('unban-btn')).toBeNull();
    expect(screen.queryByTestId('wipe-btn')).toBeNull();
    expect(screen.queryByTestId('delete-btn')).toBeNull();
  });

  it('shows every action to the owner', async () => {
    renderUsers('owner');
    expect(await screen.findAllByTestId('user-row')).toHaveLength(2);
    expect(screen.getAllByTestId('unban-btn')).toHaveLength(1);
    expect(screen.getAllByTestId('wipe-btn')).toHaveLength(2);
    expect(screen.getAllByTestId('delete-btn')).toHaveLength(2);
  });
});
