/**
 * Shared chat-name normalization and validation.
 *
 * A chat name is an account identity setting, not a supporter cosmetic.  The
 * website and Discord bot use this exact pure contract; moderation and storage
 * happen in chatNameService.
 */

export const CHAT_NAME_MIN_LENGTH = 2;
export const CHAT_NAME_MAX_LENGTH = 32;

// `~` and `|` are reserved by the HUD transport. Markup / escape characters and
// controls must never reach Scaleform's htmlText path. Bidi/invisible characters
// are handled separately so a name cannot visually spoof another member.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[~|"\\<>&\u0000-\u001F\u007F]/g;
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export type ChatNameValidation =
  | { ok: true; value: string }
  | { ok: false; code: 'too_short' | 'too_long' | 'empty_after_sanitize' };

export function sanitizeChatName(raw: string): string {
  return raw
    .replace(UNSAFE_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateChatName(raw: string): ChatNameValidation {
  const value = sanitizeChatName(raw);
  if (value.length === 0) return { ok: false, code: 'empty_after_sanitize' };
  if (value.length < CHAT_NAME_MIN_LENGTH) return { ok: false, code: 'too_short' };
  if (value.length > CHAT_NAME_MAX_LENGTH) return { ok: false, code: 'too_long' };
  return { ok: true, value };
}

export default { CHAT_NAME_MIN_LENGTH, CHAT_NAME_MAX_LENGTH, sanitizeChatName, validateChatName };
module.exports = { CHAT_NAME_MIN_LENGTH, CHAT_NAME_MAX_LENGTH, sanitizeChatName, validateChatName };
module.exports.default = module.exports;
