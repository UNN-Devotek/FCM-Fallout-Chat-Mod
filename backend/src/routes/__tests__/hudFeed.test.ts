import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zfeSafe, buildFeedLines } from '../hudFeed';

// Unit tests for the hud-feed ZFE-safe rendering logic.
// The /api/game/hud-feed payload passes through ZFE's readRemoteData envelope,
// which corrupts `"` and `\` via a one-level escape round-trip.
// These tests pin the invariants the FCMBridge SWF depends on.
// Full pattern: docs/overlay/zfe/fcmbridge-data-pattern.md

// ── zfeSafe ───────────────────────────────────────────────────────────────────

test('zfeSafe: double quotes → typographic quotes', () => {
  // zfeSafe maps " → U+2018 LEFT SINGLE QUOTATION MARK (not U+2019 right-single — see hudFeedService.ts)
  // \u2018 escapes below so file-encoding drift can never silently break this assertion.
  assert.equal(zfeSafe('join "TestingParty" now'), 'join \u2018TestingParty\u2018 now');
});

test('zfeSafe: backslashes → forward slashes', () => {
  assert.equal(zfeSafe('C:\\Users\\me'), 'C:/Users/me');
});

test('zfeSafe: pipes → broken bar (| is the record separator)', () => {
  assert.equal(zfeSafe('a|b|c'), 'a¦b¦c');
});

test('zfeSafe: newlines collapse to spaces', () => {
  assert.equal(zfeSafe('line1\nline2\r\nline3'), 'line1 line2 line3');
});

test('zfeSafe: tildes → ∼ (~ is the field separator)', () => {
  assert.equal(zfeSafe('a~b'), 'a∼b');
});

test('zfeSafe: html chars are neutralized for SWF htmlText', () => {
  assert.equal(zfeSafe('<b>bold</b> & more'), '‹b›bold‹/b› + more');
});

test('zfeSafe: plain text and emoji pass through unchanged', () => {
  assert.equal(zfeSafe('📣 hello world'), '📣 hello world');
});

test('zfeSafe: output never contains envelope/format-breaking characters', () => {
  const out = zfeSafe('"quote" \\back\\ |pipe| ~tilde~ <tag> & \r\n end');
  assert.doesNotMatch(out, /["\\|~<>&\r\n]/);
});

// ── buildFeedLines ────────────────────────────────────────────────────────────

const row = (over: Record<string, unknown> = {}) => ({
  username: 'Devotek',
  discord_display_name: null,
  discord_username: null,
  content: 'hello',
  channel_name: 'General',
  channel_color: '#ecbb51',
  created_at: new Date('2026-06-10T00:00:00Z'),
  ...over,
});

test('buildFeedLines: renders color~channel~user~content records', () => {
  assert.deepEqual(buildFeedLines([row()]), ['#ecbb51~General~Devotek~hello']);
});

test('buildFeedLines: invalid channel color falls back to default', () => {
  assert.deepEqual(
    buildFeedLines([row({ channel_color: 'not-a-color' })]),
    ['#C8A840~General~Devotek~hello'],
  );
  assert.deepEqual(
    buildFeedLines([row({ channel_color: null })]),
    ['#C8A840~General~Devotek~hello'],
  );
});

test('buildFeedLines: Trading channel is renamed Trade (matches ChatOverlay)', () => {
  assert.deepEqual(
    buildFeedLines([row({ channel_name: 'Trading', channel_color: '#4A9FE0' })]),
    ['#4A9FE0~Trade~Devotek~hello'],
  );
});

test('buildFeedLines: placeholder usernames fall back to discord names', () => {
  assert.deepEqual(
    buildFeedLines([row({ username: 'Wanderer', discord_display_name: 'DiscordDev' })]),
    ['#ecbb51~General~DiscordDev~hello'],
  );
  assert.deepEqual(
    buildFeedLines([row({ username: 'pending-abc', discord_username: 'rawname' })]),
    ['#ecbb51~General~rawname~hello'],
  );
  assert.deepEqual(
    buildFeedLines([row({ username: 'overlay42' })]),
    ['#ecbb51~General~Wanderer~hello'],
  );
});

test('buildFeedLines: content over 70 chars is truncated with ellipsis', () => {
  const [line] = buildFeedLines([row({ content: 'x'.repeat(100) })]);
  assert.equal(line, `#ecbb51~General~Devotek~${'x'.repeat(67)}...`);
});

test('buildFeedLines: hostile characters sanitized in every user field', () => {
  const [line] = buildFeedLines([row({
    username: 'Eva "L"',
    content: 'sell|buy ~half~ <b>"cheap"</b> C:\\loot',
    channel_name: 'Tra|ding',
  })]);
  // " maps to U+2018 LEFT single quotation mark (not U+2019 right) — see hudFeedService.ts zfeSafe.
  // \u escapes so file-encoding drift can never silently break this assertion.
  assert.equal(line, '#ecbb51~Tra\u00a6ding~Eva \u2018L\u2018~sell\u00a6buy \u223chalf\u223c \u2039b\u203a\u2018cheap\u2018\u2039/b\u203a C:/loot');
});

test('buildFeedLines: joined payload serializes with zero escape sequences', () => {
  const lines = buildFeedLines([row(), row({ content: 'second "msg"' })]);
  const payload = JSON.stringify({ t: lines.join('|') });
  // No backslash anywhere in the serialized body — the invariant the SWF's
  // escape-aware extraction relies on.
  assert.ok(!payload.includes('\\'));
});
