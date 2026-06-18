import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AuthProvider, useAuth } from '../AuthContext';

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

  it('aborts the in-flight /auth/me request on unmount', async () => {
    // Spy on the real AbortController so we observe the exact signal the effect
    // creates AND the abort() call it makes on cleanup. This fails (no abort
    // recorded for the right signal) if the AbortController is removed from the
    // effect — i.e. it genuinely exercises the security fix, not a reimplementation.
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

    // A fetch that never resolves on its own — the request is "in flight" until
    // the effect's cleanup aborts it.
    let resolveFetch!: (v: unknown) => void;
    const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingFetch);

    const { result, unmount } = renderHook(() => useAuth(), { wrapper });

    // The effect must have created a request carrying a not-yet-aborted signal.
    const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const signal = options?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(abortSpy).not.toHaveBeenCalled();

    // Unmount before the fetch resolves — cleanup must abort the request.
    unmount();
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);

    // Even if the (now-cancelled) fetch resolves late, no state update happens
    // because the cancelled guard fired alongside the abort.
    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ data: { id: 'u1', username: 'Late', role: 'user' } }) });
      await pendingFetch;
    });
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
