import { useCallback } from 'react';

/**
 * Shared hook — inserts a token at the textarea's caret,
 * clamps to 255 chars, then restores the cursor position.
 */
export function usePickerInsert(
  inputRef: React.RefObject<HTMLTextAreaElement | null>,
  inputText: string,
  setInputText: (v: string) => void,
) {
  return useCallback(
    (token: string) => {
      const el = inputRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      const next = inputText.slice(0, start) + token + inputText.slice(end);
      setInputText(next.slice(0, 255));
      requestAnimationFrame(() => {
        el.focus();
        const pos = Math.min(255, start + token.length);
        el.setSelectionRange(pos, pos);
      });
    },
    [inputRef, inputText, setInputText],
  );
}
