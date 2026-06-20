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
      // Read el.value directly -- React state (inputText) may be stale if
      // the user picks a second emoji before the first state update flushes,
      // which caused emojis to insert in reverse order (issue #97).
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      const next = el.value.slice(0, start) + token + el.value.slice(end);
      setInputText(next.slice(0, 255));
      requestAnimationFrame(() => {
        el.focus();
        const pos = Math.min(255, start + token.length);
        el.setSelectionRange(pos, pos);
      });
    },
    [inputRef, setInputText],
  );
}
