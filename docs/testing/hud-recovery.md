# HUD wrapping and connection recovery checks

These checks apply to the optional in-game HUD widget, separately from the desktop overlay.

For local candidate 2.10.78, verify the combined General feed on each extender:

- Receive one message from General, Server, Trading, Events, Infests, and Raids. General must
  show each once with its source label. Each other tab must show only its own rows. Sending
  from General must still target General.
- Send identical text twice, then replay the first event while the second send awaits its
  echo. The two real messages must remain two rows; no replay may replace the second send's ID.
  Repeat after reconnect and after enough history to evict old cached IDs.
- Change worlds with General open. Only the old Server rows disappear. Early Server events
  must remain deferred until a matching room confirmation; other-world rows must never appear.
- With more than 32 retained messages, switch tabs and reload while rows are rendering. Old
  slices must not reappear. A failed delayed row must fall back without an uncaught callback.
- Test reversed `scrollUpKey=Down` / `scrollDownKey=Up`, then a configured `scrollBottomKey`.
  Physical and forwarded aliases must agree; feed actions remain gated by an open editor. Also
  deliver the named and physical alias for the same press: existing latches key on normalized
  action names, so cross-alias one-press behavior needs explicit per-loader verification.

Run the outage scenarios against a disposable local or Dev backend; do not interrupt Prod to
test recovery. Repeat with xScal and ZFE individually, recording the widget build and provider
from fresh logs. Automated tests do not establish native GFx or extender behavior.

## Rendering

- Send a long message with a chosen name color that differs from the HUD text color.
  Only the author name should use that color. The colon and message body use the HUD text color;
  the channel retains its channel color.
- Resize the widget narrower and wider. Continuation lines begin at the left feed edge, beneath
  the channel tag, and fill the current feed width. No line should disappear at the right edge.
- Repeat with a supporter star, a custom tag, a long author name, an explicit line break, a long
  unbroken word, and HTML-like text such as `<font>`. Scroll up and resize again. Stars must not
  overlap text or move onto another message. Check for missing-glyph squares in the marker space.

## Recovery and sends

- With a linked account, interrupt the test relay for at least five minutes. Submit several
  different messages while disconnected, restore the relay, and verify automatic authentication
  and delivery without reopening the widget. Each accepted message must appear once.
- Interrupt the connection between submission and acknowledgment. Restore it and verify that the
  retry reuses the same send identifier and receives the original acknowledgment, rather than
  creating a second persisted message or Discord bridge event.
- Verify that an old backend without the retry capability does not trigger blind retransmission
  after an ambiguous timeout. Deterministic rejections (mute, filter, invalid channel) must be
  reported rather than repeatedly sent.
- Queue a SERVER message, then change worlds before reconnecting. It must never appear in the
  new world's chat. Repeat with an account relink; queued text from the previous identity must
  never be sent by the new identity.
- Check the queue capacity and expiration notice. The queue is held in the current widget's
  memory; exiting the game or unloading the widget does not preserve unsent drafts.
- Leave an xScal handshake pending and return malformed poll responses in the test harness.
  Recovery must continue after its timeout rather than remaining permanently connected/stuck.

Keep logs to build/provider, status codes, queue counts and timings. Do not collect tokens,
message bodies, player names, or private channel membership for routine diagnostics.
