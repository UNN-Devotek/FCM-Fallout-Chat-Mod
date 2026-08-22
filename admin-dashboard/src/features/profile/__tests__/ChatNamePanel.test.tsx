/** The free Chat name profile setting must never depend on supporter cosmetics. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiPatch = vi.fn();

vi.mock('../../../services/api', () => ({
  api: { patch: (...args: unknown[]) => apiPatch(...args) },
}));

import ChatNamePanel from '../ChatNamePanel';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('ChatNamePanel', () => {
  beforeEach(() => apiPatch.mockResolvedValue({ chatName: 'Vault Dweller', changed: true }));
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('is explicitly free and saves through the dedicated account endpoint', async () => {
    wrap(<ChatNamePanel userId="user-1" chatName={null} />);

    expect(screen.getByText(/free for everyone/i)).toBeTruthy();
    expect(screen.getByText(/no supporter tier requirement/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Chat name'), { target: { value: 'Vault Dweller' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => {
      expect(apiPatch).toHaveBeenCalledWith('/api/users/user-1/chat-name', { chatName: 'Vault Dweller' });
    });
  });

  it('clears to the normal Fallout 76 / Discord-derived identity', async () => {
    wrap(<ChatNamePanel userId="user-1" chatName="Old Name" />);
    fireEvent.change(screen.getByLabelText('Chat name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => {
      expect(apiPatch).toHaveBeenCalledWith('/api/users/user-1/chat-name', { chatName: null });
    });
  });
});
