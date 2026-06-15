import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWsGate, reconnectHistoryChannelIds } from '../ChatOverlay';

describe('useWsGate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Grace period passed to the hook so tests are deterministic regardless of
  // DEV/prod env. All cases use 500 ms explicitly.
  const GRACE = 500;

  it('initialises true when input starts true', () => {
    const { result } = renderHook(() => useWsGate(true, GRACE));
    expect(result.current).toBe(true);
  });

  it('initialises false when input starts false', () => {
    const { result } = renderHook(() => useWsGate(false, GRACE));
    expect(result.current).toBe(false);
  });

  it('propagates true immediately — no timer delay on connect', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useWsGate(v, GRACE),
      { initialProps: { v: false } },
    );
    act(() => { rerender({ v: true }); });
    expect(result.current).toBe(true);
  });

  it('keeps gate true during grace window after input flips false', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useWsGate(v, GRACE),
      { initialProps: { v: true } },
    );
    act(() => { rerender({ v: false }); });
    expect(result.current).toBe(true); // still in grace window

    act(() => { vi.advanceTimersByTime(GRACE - 1); });
    expect(result.current).toBe(true); // one ms before expiry
  });

  it('sets gate false once grace period expires', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useWsGate(v, GRACE),
      { initialProps: { v: true } },
    );
    act(() => { rerender({ v: false }); });
    act(() => { vi.advanceTimersByTime(GRACE + 1); });
    expect(result.current).toBe(false);
  });

  it('prevents double-teardown: false→true within grace never drops gate', () => {
    // Reproduces the Nick log scenario: wsShouldConnect flips false then back
    // to true within 374 ms. wsGate must never become false, so the WS effect
    // never runs its cleanup and no teardown occurs.
    const { result, rerender } = renderHook(
      ({ v }) => useWsGate(v, GRACE),
      { initialProps: { v: true } },
    );

    // overlay collapses → wsShouldConnect = false
    act(() => { rerender({ v: false }); });
    expect(result.current).toBe(true); // grace window active

    // overlay expands 374 ms later → wsShouldConnect = true
    act(() => {
      vi.advanceTimersByTime(374);
      rerender({ v: true });
    });
    expect(result.current).toBe(true); // gate stayed true throughout

    // grace period fully expires — gate is still true (re-connected)
    act(() => { vi.advanceTimersByTime(GRACE * 2); });
    expect(result.current).toBe(true);
  });

  it('disconnects after grace when input stays false, reconnects immediately on true', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useWsGate(v, GRACE),
      { initialProps: { v: true } },
    );

    act(() => { rerender({ v: false }); });
    act(() => { vi.advanceTimersByTime(GRACE + 1); });
    expect(result.current).toBe(false);

    act(() => { rerender({ v: true }); });
    expect(result.current).toBe(true); // immediate reconnect
  });

  it('cancels pending disconnect timer when input goes true before expiry', () => {
    // After reconnecting within grace, advancing well past GRACE must NOT
    // fire a stale timer that sets gate back to false.
    const { result, rerender } = renderHook(
      ({ v }) => useWsGate(v, GRACE),
      { initialProps: { v: true } },
    );

    act(() => { rerender({ v: false }); });
    act(() => { vi.advanceTimersByTime(200); });
    act(() => { rerender({ v: true }); }); // reconnect before expiry
    act(() => { vi.advanceTimersByTime(GRACE * 3); }); // run all timers
    expect(result.current).toBe(true); // stale timer must not have fired
  });

  it('handles multiple rapid false flaps without ever dropping gate', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useWsGate(v, GRACE),
      { initialProps: { v: true } },
    );

    for (let i = 0; i < 5; i++) {
      act(() => { rerender({ v: false }); });
      act(() => { vi.advanceTimersByTime(100); });
      act(() => { rerender({ v: true }); });
      expect(result.current).toBe(true);
    }
  });
});

describe('reconnectHistoryChannelIds', () => {
  it('first-load: requests every known channel not already loaded', () => {
    const ids = reconnectHistoryChannelIds({
      activeChannelId: 'a',
      alreadyLoaded: new Set(),
      knownChannelIds: ['a', 'b', 'c'],
    });
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('silent reconnect: still always re-requests the active channel (blank-after-show guard)', () => {
    const ids = reconnectHistoryChannelIds({
      activeChannelId: 'b',
      alreadyLoaded: new Set(['a', 'b', 'c']),
      knownChannelIds: ['a', 'b', 'c'],
    });
    // All others are already loaded and skipped; the visible channel is refreshed.
    expect(ids).toEqual(['b']);
  });

  it('active channel is requested exactly once even when also a first-load channel', () => {
    const ids = reconnectHistoryChannelIds({
      activeChannelId: 'a',
      alreadyLoaded: new Set(),
      knownChannelIds: ['a', 'b'],
    });
    expect(ids.filter(id => id === 'a')).toHaveLength(1);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('no known channels yet: falls back to the active channel', () => {
    expect(reconnectHistoryChannelIds({
      activeChannelId: 'x',
      alreadyLoaded: new Set(),
      knownChannelIds: [],
    })).toEqual(['x']);
  });

  it('no active channel and no known channels: requests nothing', () => {
    expect(reconnectHistoryChannelIds({
      activeChannelId: null,
      alreadyLoaded: new Set(),
      knownChannelIds: [],
    })).toEqual([]);
  });

  it('no active channel: still hydrates first-load known channels', () => {
    const ids = reconnectHistoryChannelIds({
      activeChannelId: null,
      alreadyLoaded: new Set(['a']),
      knownChannelIds: ['a', 'b'],
    });
    expect(ids).toEqual(['b']);
  });
});
