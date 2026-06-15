// ApiTokensPanel — unit tests (Vitest + RTL)
//
// Covers three invariants:
//   1. Lists existing tokens from GET /api/me/mcp-tokens
//   2. Minting shows the plaintext token exactly once in a copyable input
//   3. Revoke calls DELETE /api/me/mcp-tokens/:id (with confirmation step)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// ── Mock seams ─────────────────────────────────────────────────────────────────

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();

vi.mock('../../../services/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    delete: (...a: unknown[]) => apiDelete(...a),
  },
}));

import ApiTokensPanel from '../ApiTokensPanel';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TOKEN_LIST = [
  {
    id: 'tok-1',
    label: 'My MCP token',
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: '2026-06-01T12:00:00Z',
    expiresAt: '2026-10-01T00:00:00Z',
  },
  {
    id: 'tok-2',
    label: null,
    createdAt: '2026-02-15T00:00:00Z',
    lastUsedAt: null,
    expiresAt: '2026-11-15T00:00:00Z',
  },
];

const MINT_RESULT = {
  id: 'tok-new',
  token: 'fcm_mcp_abcdef1234567890abcdef1234567890',
  expiresAt: '2026-12-31T00:00:00Z',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ApiTokensPanel', () => {
  beforeEach(() => {
    apiGet.mockResolvedValue(TOKEN_LIST);
    apiPost.mockResolvedValue(MINT_RESULT);
    apiDelete.mockResolvedValue({ revoked: true });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the list of existing tokens', async () => {
    wrap(<ApiTokensPanel />);
    // Wait for the query to resolve and the list to appear.
    await waitFor(() => {
      expect(screen.getByText('My MCP token')).toBeTruthy();
    });
    // Second token has no label — shows "unlabelled".
    expect(screen.getByText('unlabelled')).toBeTruthy();
    // Header columns
    expect(screen.getAllByText('LABEL').length).toBeGreaterThan(0);
    // GET was called with the correct path.
    expect(apiGet).toHaveBeenCalledWith('/api/me/mcp-tokens');
  });

  it('mints a token and shows it once in a copyable input', async () => {
    wrap(<ApiTokensPanel />);
    await waitFor(() => screen.getByText('My MCP token'));

    // Click "GENERATE TOKEN".
    fireEvent.click(screen.getByText('GENERATE TOKEN'));
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith('/api/me/mcp-tokens', {});
    });

    // The plaintext token must appear in a read-only input.
    const tokenInput = screen.getByDisplayValue(MINT_RESULT.token) as HTMLInputElement;
    expect(tokenInput.readOnly).toBe(true);

    // The "you won't see this again" warning must be present.
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy();

    // Dismiss and confirm the token box is gone.
    fireEvent.click(screen.getByText('DONE'));
    await waitFor(() => {
      expect(screen.queryByDisplayValue(MINT_RESULT.token)).toBeNull();
    });
  });

  it('mints a token with a label when one is provided', async () => {
    wrap(<ApiTokensPanel />);
    await waitFor(() => screen.getByText('My MCP token'));

    const labelInput = screen.getByPlaceholderText('Label (optional)');
    fireEvent.change(labelInput, { target: { value: 'CI runner' } });
    fireEvent.click(screen.getByText('GENERATE TOKEN'));

    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith('/api/me/mcp-tokens', { label: 'CI runner' });
    });
  });

  it('shows a confirm step before revoking and then calls DELETE', async () => {
    wrap(<ApiTokensPanel />);
    await waitFor(() => screen.getByText('My MCP token'));

    // Click the first REVOKE button (tok-1).
    const revokeButtons = screen.getAllByText('REVOKE');
    fireEvent.click(revokeButtons[0]);

    // Confirm button appears; DELETE has not been called yet.
    expect(screen.getByText('CONFIRM')).toBeTruthy();
    expect(apiDelete).not.toHaveBeenCalled();

    // Confirm the revocation.
    fireEvent.click(screen.getByText('CONFIRM'));
    await waitFor(() => {
      expect(apiDelete).toHaveBeenCalledWith('/api/me/mcp-tokens/tok-1');
    });
  });

  it('shows CANCEL on the confirm step and aborts revoke', async () => {
    wrap(<ApiTokensPanel />);
    await waitFor(() => screen.getByText('My MCP token'));

    const revokeButtons = screen.getAllByText('REVOKE');
    fireEvent.click(revokeButtons[0]);
    expect(screen.getByText('CANCEL')).toBeTruthy();

    fireEvent.click(screen.getByText('CANCEL'));
    await waitFor(() => {
      expect(screen.queryByText('CONFIRM')).toBeNull();
    });
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('renders empty state when no tokens exist', async () => {
    apiGet.mockResolvedValue([]);
    wrap(<ApiTokensPanel />);
    await waitFor(() => {
      expect(screen.getByText(/no active tokens/i)).toBeTruthy();
    });
  });
});
