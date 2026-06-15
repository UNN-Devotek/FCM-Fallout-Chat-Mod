// node-emoji v1 ships no type declarations; annotate the CommonJS require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeEmoji: { emojify: (text: string) => string } = require('node-emoji');

/**
 * Convert Discord-style :shortcode: tokens in a message to their Unicode emoji
 * (e.g. ":fire:" -> "🔥"). Unknown shortcodes are left intact. This runs on the
 * authoritative inbound path so the Unicode emoji propagate to every client
 * (web + desktop overlays) and to Discord, which all render Unicode natively.
 */
export function emojifyShortcodes(text: string): string {
  if (!text || text.indexOf(':') === -1) return text;
  try {
    return nodeEmoji.emojify(text);
  } catch {
    return text;
  }
}
