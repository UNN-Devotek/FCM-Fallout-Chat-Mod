import { describe, expect, it } from 'vitest';
import {
  RECENT_EMOJI_LIMIT,
  RECENT_EMOJI_STORAGE_KEY,
  normalizeRecentEmojiTokens,
  recordRecentEmoji,
  loadRecentEmojiTokens,
  saveRecentEmojiTokens,
  extractEmojiTokens,
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

describe('extractEmojiTokens', () => {
  // A controlled "known native" set so the test is independent of emoji-mart data.
  const known = new Set(['😀', '😂', '🎉', '👍', '👨‍👩‍👧']);
  const isKnown = (s: string) => known.has(s);

  it('returns nothing for plain text', () => {
    expect(extractEmojiTokens('hello world', isKnown)).toEqual([]);
    expect(extractEmojiTokens('', isKnown)).toEqual([]);
  });

  it('extracts native emoji in first-appearance order', () => {
    expect(extractEmojiTokens('gg 😀 nice 😂 yes 😀', isKnown)).toEqual(['😀', '😂']);
  });

  it('extracts custom emoji tokens', () => {
    expect(extractEmojiTokens('hi <:vault:1234567890123456> there', isKnown)).toEqual([
      '<:vault:1234567890123456>',
    ]);
    expect(extractEmojiTokens('<a:spin:9876543210987654>', isKnown)).toEqual([
      '<a:spin:9876543210987654>',
    ]);
  });

  it('extracts mixed native + custom in order, deduped', () => {
    expect(
      extractEmojiTokens('😀 <:vault:1234567890123456> 😀 🎉', isKnown),
    ).toEqual(['😀', '<:vault:1234567890123456>', '🎉']);
  });

  it('keeps ZWJ sequences as a single token', () => {
    expect(extractEmojiTokens('family 👨‍👩‍👧 here', isKnown)).toEqual(['👨‍👩‍👧']);
  });

  it('strips a VS16 variation selector to match the known canonical form', () => {
    // '👍️' should be recorded as the known '👍'.
    expect(extractEmojiTokens('nice 👍️', isKnown)).toEqual(['👍']);
  });

  it('ignores pictographic glyphs not recognized as known emoji', () => {
    expect(extractEmojiTokens('weird 🭀 glyph', isKnown)).toEqual([]);
  });

  it('uses the emoji-mart map by default (no predicate injected)', () => {
    expect(extractEmojiTokens('party 🎉 time')).toEqual(['🎉']);
  });
});
