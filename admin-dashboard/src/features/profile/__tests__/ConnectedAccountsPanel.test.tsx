import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import ConnectedAccountsPanel from '../ConnectedAccountsPanel';
const get = vi.hoisted(() => vi.fn());
vi.mock('../../../services/api', () => ({ api: { get } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function show(path = '/') {
  render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ConnectedAccountsPanel userId="account-a" /></QueryClientProvider></MemoryRouter>);
}
it('Steam-only account can optionally link Discord', async () => {
  get.mockResolvedValue({ providers: [{ provider: 'steam' }] });
  show();
  expect((await screen.findByRole('link', { name: 'Link Discord' })).getAttribute('href')).toBe('/auth/discord/profile');
  expect(screen.getByText('Steam: Connected')).toBeTruthy();
});
it('existing Discord link displays status instead of starting replacement', async () => {
  get.mockResolvedValue({ providers: [{ provider: 'discord', username: 'Dweller' }] });
  show('/?linked=discord');
  expect(await screen.findByText('Discord: Dweller')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Link Discord' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('successfully');
});
it('failed lookup does not present a misleading link action', async () => {
  get.mockRejectedValue(new Error('offline'));
  show();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
