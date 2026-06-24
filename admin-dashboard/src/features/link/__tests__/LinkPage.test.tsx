import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import LinkPage from '../LinkPage';

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/link${search}`]}>
      <LinkPage />
    </MemoryRouter>,
  );
}

describe('LinkPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/AUTHENTICATING/i)).toBeInTheDocument();
  });

  it('shows sign-in buttons when unauthenticated (401)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
    } as Response);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByText(/SIGN IN WITH DISCORD/i).length).toBeGreaterThan(0);
    });
  });

  it('shows code entry form when authenticated', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        data: {
          hasLinkedProvider: true,
          fo76AccountName: null,
          providers: [{ provider: 'discord', username: 'Devotek' }],
        },
      }),
    } as Response);
    renderPage();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/XXXX-XXXX/i)).toBeInTheDocument();
    });
  });

  it('shows success state after valid code submission', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            data: { hasLinkedProvider: true, fo76AccountName: null, providers: [] },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: { success: true, message: 'In-game chat activated.' },
        }),
      });
    });

    renderPage();
    await waitFor(() => screen.getByPlaceholderText(/XXXX-XXXX/i));

    fireEvent.change(screen.getByPlaceholderText(/XXXX-XXXX/i), {
      target: { value: 'ABCDEFGH' },
    });
    fireEvent.click(screen.getByRole('button', { name: /ACTIVATE CHAT/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/CHAT ACTIVATED/i).length).toBeGreaterThan(0);
    });
  });

  it('shows expired error for 410 response', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            data: { hasLinkedProvider: true, fo76AccountName: null, providers: [] },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 410,
        json: async () => ({ detail: 'expired' }),
      });
    });

    renderPage();
    await waitFor(() => screen.getByPlaceholderText(/XXXX-XXXX/i));
    fireEvent.change(screen.getByPlaceholderText(/XXXX-XXXX/i), {
      target: { value: 'ABCDEFGH' },
    });
    fireEvent.click(screen.getByRole('button', { name: /ACTIVATE CHAT/i }));

    await waitFor(() => {
      expect(screen.getByText(/expired/i)).toBeInTheDocument();
      expect(screen.getByText(/ACTIVATION FAILED/i)).toBeInTheDocument();
    });
  });

  it('shows rate-limited error for 429 response', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            data: { hasLinkedProvider: true, fo76AccountName: null, providers: [] },
          }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 429,
        json: async () => ({ detail: 'rate limited' }),
      });
    });

    renderPage();
    await waitFor(() => screen.getByPlaceholderText(/XXXX-XXXX/i));
    fireEvent.change(screen.getByPlaceholderText(/XXXX-XXXX/i), {
      target: { value: 'ABCDEFGH' },
    });
    fireEvent.click(screen.getByRole('button', { name: /ACTIVATE CHAT/i }));

    await waitFor(() => {
      expect(screen.getByText(/Too many attempts/i)).toBeInTheDocument();
    });
  });

  it('shows error banner when ?error=nexus_denied', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 401, ok: false } as Response);
    renderPage('?error=nexus_denied');
    await waitFor(() => {
      expect(screen.getByText(/AUTH ERROR/i)).toBeInTheDocument();
      expect(screen.getByText(/denied/i)).toBeInTheDocument();
    });
  });

  it('shows account banned error for ?error=account_banned', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 401, ok: false } as Response);
    renderPage('?error=account_banned');
    await waitFor(() => {
      expect(screen.getByText(/not permitted/i)).toBeInTheDocument();
    });
  });
});
