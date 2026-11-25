import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../../services/api';
import Users from '../Users';

const user = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'pending-install',
  displayName: 'Appalachian',
  fo76Name: 'Wastelander',
  isBanned: false,
  isMuted: true,
  createdAt: '2026-09-01T00:00:00Z',
};

const globalMutePath = '/api/moderation/hud-auto-event-mute';

function renderUsers(role: 'admin' | 'moderator' = 'moderator') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={{ user: { role } }} />}>
            <Route index element={<Users />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

it('mutes and unmutes HUD auto-events for the selected account independently of a chat mute', async () => {
  let hudAutoEventsMuted = false;
  vi.spyOn(api, 'get').mockImplementation(async (path) =>
    path === globalMutePath ? { muted: false } : [{ ...user, hudAutoEventsMuted }]);
  const put = vi.spyOn(api, 'put').mockImplementation(async (_path, { muted }) => {
    hudAutoEventsMuted = muted;
    return { hudAutoEventsMuted };
  });
  renderUsers();

  fireEvent.click(await screen.findByRole('button', { name: 'Mute HUD auto-events for Appalachian' }));
  expect(await screen.findByText('HUD AUTO-EVENTS MUTED')).toBeInTheDocument();
  expect(put).toHaveBeenNthCalledWith(1, `/api/moderation/users/${user.id}/hud-auto-event-mute`, { muted: true });

  const unmute = screen.getByRole('button', { name: 'Unmute HUD auto-events for Appalachian' });
  await waitFor(() => expect(unmute).toBeEnabled());
  fireEvent.click(unmute);
  await screen.findByRole('button', { name: 'Mute HUD auto-events for Appalachian' });
  expect(put).toHaveBeenNthCalledWith(2, `/api/moderation/users/${user.id}/hud-auto-event-mute`, { muted: false });
  expect(screen.queryByText('HUD AUTO-EVENTS MUTED')).toBeNull();
  expect(screen.getByText('MUTED')).toBeInTheDocument();
});

it('shows a rejected action and leaves the displayed mute state intact', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (path) =>
    path === globalMutePath ? { muted: false } : [{ ...user, hudAutoEventsMuted: false }]);
  vi.spyOn(api, 'put').mockRejectedValue(new Error('Target holds a protected role.'));
  renderUsers();

  const mute = await screen.findByRole('button', { name: 'Mute HUD auto-events for Appalachian' });
  fireEvent.click(mute);

  expect(await screen.findByRole('alert')).toHaveTextContent('Target holds a protected role.');
  expect(mute).toBeEnabled();
  expect(screen.queryByText('HUD AUTO-EVENTS MUTED')).toBeNull();
});

it('lets admins pause and resume automatic announcements for everyone while showing individual mutes', async () => {
  let globalMuted = false;
  vi.spyOn(api, 'get').mockImplementation(async (path) =>
    path === globalMutePath ? { muted: globalMuted } : [{ ...user, hudAutoEventsMuted: true }]);
  const put = vi.spyOn(api, 'put').mockImplementation(async (_path, { muted }) => {
    globalMuted = muted;
    return { muted };
  });
  renderUsers('admin');

  fireEvent.click(await screen.findByRole('button', { name: 'Mute HUD auto-events for everyone' }));
  expect(await screen.findByText('HUD auto-events are muted for everyone.')).toBeInTheDocument();
  expect(put).toHaveBeenNthCalledWith(1, globalMutePath, { muted: true });

  const unmute = screen.getByRole('button', { name: 'Unmute HUD auto-events for everyone' });
  await waitFor(() => expect(unmute).toBeEnabled());
  fireEvent.click(unmute);
  expect(await screen.findByText('Server-wide HUD auto-event mute is off.')).toBeInTheDocument();
  expect(put).toHaveBeenNthCalledWith(2, globalMutePath, { muted: false });
  expect(screen.getByText('HUD AUTO-EVENTS MUTED')).toBeInTheDocument();
});

it('shows moderators the global mute status and lets them mute individual accounts', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (path) =>
    path === globalMutePath ? { muted: true } : [{ ...user, hudAutoEventsMuted: false }]);
  renderUsers();

  expect(await screen.findByText('HUD auto-events are muted for everyone.')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Mute HUD auto-events for Appalachian' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Unmute HUD auto-events for everyone' })).toBeNull();
});
