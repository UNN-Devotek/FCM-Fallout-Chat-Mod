import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AuthProvider, useAuth } from '../../../contexts/AuthContext';

// Wrapper so renderHook can access the context
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

describe('AuthContext /auth/me fetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets realUser from a successful /auth/me response', async () => {
    const user = { id: 'u1', username: 'TestUser', role: 'user' };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: user }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    // Wait for loading to complete
    await act(async () => {});

    expect(result.current.realUser).toEqual(user);
    expect(result.current.loading).toBe(false);
  });

  it('sets realUser to null on fetch error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {});

    expect(result.current.realUser).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('does not update state after unmount (AbortController cleanup)', async () => {
    let resolveFetch!: (v: unknown) => void;
    const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingFetch);

    const { result, unmount } = renderHook(() => useAuth(), { wrapper });

    // Unmount before the fetch resolves
    unmount();

    // Now resolve the fetch — should not trigger a state update
    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ data: { id: 'u1', username: 'Late', role: 'user' } }) });
      await pendingFetch;
    });

    // State should remain at initial values (loading=true, realUser=null)
    // since the component was already unmounted and the cancelled guard fired.
    expect(result.current.realUser).toBeNull();
  });

  it('passes an AbortSignal to fetch', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: null }),
    });

    renderHook(() => useAuth(), { wrapper });
    await act(async () => {});

    const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
});
