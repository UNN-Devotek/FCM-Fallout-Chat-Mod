import { describe, expect, it } from 'vitest';
import {
  RECENT_EMOJI_LIMIT,
  RECENT_EMOJI_STORAGE_KEY,
  normalizeRecentEmojiTokens,
  recordRecentEmoji,
  loadRecentEmojiTokens,
  saveRecentEmojiTokens,
} from '../EmojiPicker';

function makeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe('emoji picker recent helpers', () => {
  it('normalizes persisted recent emoji tokens by removing invalid entries and duplicates', () => {
    expect(
      normalizeRecentEmojiTokens(['😀', '😂', '', '😀', 123, null, '  😎  '] as unknown[]),
    ).toEqual(['😀', '😂', '😎']);
  });

  it('limits recent emojis to the configured max count', () => {
    const tokens = Array.from({ length: RECENT_EMOJI_LIMIT + 4 }, (_, i) => `${i}`);
    expect(normalizeRecentEmojiTokens(tokens)).toHaveLength(RECENT_EMOJI_LIMIT);
  });

  it('moves the latest selection to the front without duplicates', () => {
    expect(recordRecentEmoji(['😀', '😂', '😎'], '😂')).toEqual(['😂', '😀', '😎']);
    expect(recordRecentEmoji(['😀', '😂'], '🥳')).toEqual(['🥳', '😀', '😂']);
  });

  it('loads and saves recent emojis through storage', () => {
    const storage = makeStorage();
    saveRecentEmojiTokens(['😀', '😂'], storage);

    expect(storage.getItem(RECENT_EMOJI_STORAGE_KEY)).toBe(JSON.stringify(['😀', '😂']));
    expect(loadRecentEmojiTokens(storage)).toEqual(['😀', '😂']);
  });

  it('returns an empty list when persisted JSON is malformed', () => {
    const storage = makeStorage({
      [RECENT_EMOJI_STORAGE_KEY]: '{bad json',
    });

    expect(loadRecentEmojiTokens(storage)).toEqual([]);
  });
});
