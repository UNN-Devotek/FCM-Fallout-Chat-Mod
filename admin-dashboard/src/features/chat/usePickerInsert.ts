import { useCallback } from 'react';

/**
 * Shared hook -- inserts a token at the textarea's caret,
 * clamps to 255 chars, then restores the cursor position.
 */
export function usePickerInsert(
  inputRef: React.RefObject<HTMLTextAreaElement | null>,
  _inputText: string,
  setInputText: (v: string) => void,
) {
  return useCallback(
    (token: string) => {
      const el = inputRef.current;
      if (!el) return;
      // Read and update el.value directly -- React state (inputText) may be
      // stale if the user picks another emoji before the first state update
      // flushes. Advancing the DOM value/caret synchronously prevents the next
      // insert from reusing the old caret and placing emojis in reverse order.
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const next = el.value.slice(0, start) + token + el.value.slice(end);
      const clamped = next.slice(0, 255);
      const pos = Math.min(clamped.length, start + token.length);

      el.value = clamped;
      el.setSelectionRange(pos, pos);
      setInputText(clamped);

      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [inputRef, setInputText],
  );
}
