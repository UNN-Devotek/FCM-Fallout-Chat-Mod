/** Free chat-name validation — shared by the website and Discord `/name` modal. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_NAME_MAX_LENGTH,
  CHAT_NAME_MIN_LENGTH,
  sanitizeChatName,
  validateChatName,
} from '../chatName';

describe('chat-name validation', () => {
  test('normalizes whitespace and strips HUD/HTML-unsafe characters', () => {
    assert.equal(sanitizeChatName('  Va<ult>|  Dweller  '), 'Vault Dweller');
    assert.equal(sanitizeChatName('Vault\u200b Dweller'), 'Vault Dweller');
  });

  test('accepts a normal name after normalization', () => {
    assert.deepEqual(validateChatName('  Vault Dweller  '), { ok: true, value: 'Vault Dweller' });
  });

  test('rejects a value made empty by sanitization', () => {
    assert.deepEqual(validateChatName(' ~|<> '), { ok: false, code: 'empty_after_sanitize' });
  });

  test('enforces the 2–32 character storage contract after normalization', () => {
    assert.equal(CHAT_NAME_MIN_LENGTH, 2);
    assert.equal(CHAT_NAME_MAX_LENGTH, 32);
    assert.deepEqual(validateChatName('x'), { ok: false, code: 'too_short' });
    assert.deepEqual(validateChatName('x'.repeat(CHAT_NAME_MAX_LENGTH + 1)), { ok: false, code: 'too_long' });
    assert.deepEqual(validateChatName('x'.repeat(CHAT_NAME_MAX_LENGTH)), {
      ok: true,
      value: 'x'.repeat(CHAT_NAME_MAX_LENGTH),
    });
  });
});
