import { useEffect, useRef } from 'react';

/**
 * useDebouncedSearch — reusable debounced autocomplete search hook.
 *
 * Fires `onSearch(term)` after `delay` ms of no input changes when
 * `term.length >= minLength`. Clears results immediately on each
 * keystroke (stale-index guard). Cancels in-flight requests via
 * AbortController on cleanup.
 *
 * Callers are responsible for all state (items, open, loading, index).
 * This hook only drives when to fire the fetch and when to clear stale state.
 *
 * IMPORTANT: The wiki autocomplete must preserve the "clear-on-keystroke"
 * guard (setItems([]) before debounce fires) so Enter can't pick a stale item.
 */
export interface UseDebouncedSearchOptions<T> {
  /** The raw search term (already sliced from the input prefix), or `null` when
   *  the prefix is NOT present in the input (→ triggers onDeactivate/close). */
  term: string | null;
  /** Minimum length to trigger a search (default 2). */
  minLength?: number;
  /** Debounce delay in ms (default 280). */
  delay?: number;
  /**
   * Called when the term transitions from below minLength to exactly minLength —
   * used to set open=true in "hint" mode before any results are available.
   */
  onHint?: () => void;
  /**
   * Called when the prefix is no longer present in the input — used to close
   * the dropdown and clear items.
   */
  onDeactivate?: () => void;
  /**
   * Called immediately on every keystroke when term.length >= minLength,
   * BEFORE the debounce timer fires. Use this to clear stale results so that
   * a pending Enter cannot pick from a prior query.
   */
  onClearStale?: () => void;
  /** Async fetch — receives a signal for abort. Must throw on non-abort errors. */
  onSearch: (term: string, signal: AbortSignal) => Promise<T[]>;
  onResults: (items: T[]) => void;
  onLoading: (loading: boolean) => void;
  /** Called on fetch error (non-AbortError). */
  onError?: (err: unknown) => void;
}

export function useDebouncedSearch<T>({
  term,
  minLength = 2,
  delay = 280,
  onHint,
  onDeactivate,
  onClearStale,
  onSearch,
  onResults,
  onLoading,
  onError,
}: UseDebouncedSearchOptions<T>): void {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Use a ref for onSearch/onResults/onLoading/onError so the effect only
  // re-runs when `term` changes, not when callbacks change identity.
  const cbRef = useRef({ onSearch, onResults, onLoading, onError, onHint, onDeactivate, onClearStale });
  cbRef.current = { onSearch, onResults, onLoading, onError, onHint, onDeactivate, onClearStale };

  useEffect(() => {
    const { onSearch, onResults, onLoading, onError, onHint, onDeactivate, onClearStale } = cbRef.current;

    if (term === null || term === undefined) {
      // Prefix no longer active
      onDeactivate?.();
      return;
    }

    if (term.length < minLength) {
      onHint?.();
      return;
    }

    // Clear stale results immediately (before debounce fires) — stale-index guard
    onClearStale?.();
    const q = term; // narrowed to a non-empty string past the guards above

    // Cancel previous debounce + in-flight request
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    debounceRef.current = setTimeout(async () => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      onLoading(true);
      try {
        const items = await onSearch(q, ctrl.signal);
        onResults(items);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        onResults([]);
        onError?.(err);
      } finally {
        onLoading(false);
      }
    }, delay);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [term, minLength, delay]); // eslint-disable-line react-hooks/exhaustive-deps
}
