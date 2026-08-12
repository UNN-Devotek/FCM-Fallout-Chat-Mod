# Reconnect History Recovery — Specification

**Status:** Corrected — hosted validation pending
**Version:** 0.1
**Date:** 2026-08-10

## Why

After a player leaves and rejoins a world, the in-game chat can appear empty until someone sends a
new message. This breaks the expectation that the permanent community feeds retain their recent
context across a reconnect. The fix must restore that context promptly while keeping the temporary
world feed isolated to the player’s current world.

## Capabilities

**CAP-001 — Restore static-feed context after reconnect.** A player who reconnects sees the recent
history for every static community feed without waiting for a new message.

Test: Seed messages in General, Trading, Events, Raids, and Infests; reconnect; open each feed
before sending another message and verify its seeded messages are present.

**CAP-002 — Resume without replaying prior messages.** A player returning with an established
position sees only messages that arrived after that position, with no duplicate visible records.

Test: Record the last visible message, add two later messages, reconnect, and verify that exactly
those two new messages are added once.

**CAP-003 — Keep static history through a world transition.** Leaving one world and joining another
does not empty General, Trading, Events, Raids, or Infests; only the current-world feed may begin
empty when there is no history for the new world.

Test: Seed each static feed, change worlds, and verify all five static feeds retain their seeded
history while the world feed contains only messages belonging to the new world.

**CAP-004 — Remain correct across repeated reconnects.** Repeating the reconnect or world-change
sequence does not progressively lose history, duplicate visible records, or mix records between
worlds.

Test: Perform three consecutive reconnects and two world changes; verify each static feed has one
copy of each expected record and each world feed contains only its own records.

## Constraints

- The long-lived subscription enqueues bounded static-feed and current-world history after its
  supplied cursor. ZFE's `pollEvents` drains that native queue rather than issuing a separate
  relay poll request at HUD startup.
- History retrieval with an initial cursor returns the bounded recent history for static feeds;
  a later cursor returns only records newer than that cursor.
- Cursors must move forward monotonically and a record must never be displayed more than once for a
  given feed.
- World-feed history remains scoped to the active derived world room; no record from a prior world
  may appear after a transition.
- Existing authentication, authorization, rate limits, payload limits, and opt-in HUD-mod
  boundaries remain unchanged.
- The change includes automated regression coverage for initial-history recovery, resumed history,
  and world-transition isolation.

## Non-goals

- Changing how a player is assigned to a world.
- Preserving a temporary world feed after the player moves to a different world.
- Changing moderation, permissions, or the set of available chat feeds.
- Resolving the separate issue in which locally typed chat text can appear in diagnostic logs.

## Success Signal

- In a controlled reconnect test with seeded messages, all 5 of 5 static feeds show their expected
  history before any new message is sent.
- In a resume test, 100% of records newer than the recorded position appear exactly once, and 0
  earlier records are replayed.
- In a two-world transition test, 0 records from the old world appear in the new world feed, while
  all expected static-feed records remain visible.
- The automated checks covering those three scenarios pass on every change to the affected behavior.
