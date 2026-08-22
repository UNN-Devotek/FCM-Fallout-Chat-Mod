/**
 * Unit tests for buildOverLengthDm (issue #384).
 *
 * When a Discord message exceeds MAX_RELAY_CHARS the bot deletes it and DMs the
 * author. The DM now echoes the original text back so the author can copy-paste
 * and trim instead of retyping. These cover the three things that can go wrong:
 * blowing Discord's 2000-char message cap, breaking out of the code fence, and
 * silently losing content.
 *
 * Runner: node:test via src/testRunner.ts (no DB, no Discord client).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildOverLengthDm } from '../../utils/overLengthDm';

const DISCORD_LIMIT = 2000;
const MAX_RELAY = 255;

describe('buildOverLengthDm', () => {
  test('echoes the original content back', () => {
    const content = 'x'.repeat(300) + ' WTS fixer';
    const dm = buildOverLengthDm(content, MAX_RELAY);
    assert.ok(dm.includes('WTS fixer'), 'the original text must appear in the DM');
  });

  test('still states the limit and the actual length', () => {
    const content = 'y'.repeat(400);
    const dm = buildOverLengthDm(content, MAX_RELAY);
    assert.ok(dm.includes(String(MAX_RELAY)), 'must state the allowed limit');
    assert.ok(dm.includes('400'), 'must state the actual length');
  });

  test('wraps content in a fence so mentions cannot re-ping', () => {
    const content = '@everyone <@123456789012345678> ' + 'z'.repeat(300);
    const dm = buildOverLengthDm(content, MAX_RELAY);
    const fenceIdx = dm.indexOf('```');
    assert.ok(fenceIdx >= 0, 'must contain a code fence');
    assert.ok(dm.indexOf('@everyone') > fenceIdx, 'the mention must sit INSIDE the fence');
  });

  test('never exceeds Discord\'s 2000-character message limit', () => {
    for (const len of [256, 500, 1500, 1999, 2000, 4000, 10000]) {
      const dm = buildOverLengthDm('a'.repeat(len), MAX_RELAY);
      assert.ok(
        dm.length <= DISCORD_LIMIT,
        `content length ${len} produced a ${dm.length}-char DM (limit ${DISCORD_LIMIT})`,
      );
    }
  });

  test('signposts truncation rather than silently dropping text', () => {
    const dm = buildOverLengthDm('b'.repeat(6000), MAX_RELAY);
    assert.ok(dm.includes('truncated'), 'truncation must be explicit');
    assert.ok(dm.includes('6000'), 'must say how long the original actually was');
  });

  test('does NOT claim truncation when the whole message fits', () => {
    const dm = buildOverLengthDm('c'.repeat(300), MAX_RELAY);
    assert.ok(!dm.includes('truncated'), 'a message that fits must not be labelled truncated');
  });

  // A message containing ``` would close the fence early and let the rest of the
  // text render as markdown — including any mentions after it.
  test('escapes content that itself contains a triple backtick', () => {
    const content = 'look: ```js\nalert(1)\n``` ' + 'd'.repeat(300);
    const dm = buildOverLengthDm(content, MAX_RELAY);
    const fenceMatch = dm.match(/^`{3,}$/m);
    assert.ok(fenceMatch, 'must open a fence on its own line');
    const fence = fenceMatch![0];
    assert.ok(fence.length > 3, `fence must be longer than the content's backtick run, got ${fence.length}`);
    // The chosen fence must not appear inside the echoed content.
    const inner = dm.slice(dm.indexOf(fence) + fence.length, dm.lastIndexOf(fence));
    assert.ok(!inner.includes(fence), 'content must not contain the fence delimiter');
  });

  test('handles a longer backtick run than three', () => {
    const content = 'a' + '`'.repeat(7) + 'b'.repeat(300);
    const dm = buildOverLengthDm(content, MAX_RELAY);
    const fence = dm.match(/^`{3,}$/m)![0];
    assert.ok(fence.length >= 8, `expected a fence of 8+ backticks, got ${fence.length}`);
  });

  test('falls back to the bare notice when there is no room for content', () => {
    // A pathological maxRelayChars whose notice alone eats the budget.
    const dm = buildOverLengthDm('e'.repeat(100), Number.MAX_SAFE_INTEGER);
    assert.ok(dm.length <= DISCORD_LIMIT);
    assert.ok(dm.length > 0);
  });
});
