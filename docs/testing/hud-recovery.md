# HUD wrapping and connection recovery checks

These checks apply to the optional in-game HUD widget, separately from the desktop overlay.

## Quoted-message native regression

For the locally installed 2.10.121 candidate, confirm the widget appears in the F11 menu and
check its build/provider in fresh provider logs. In General, send three different messages
containing double quotes, then have another player send several messages. Repeat in Server after
the room is confirmed. Each sent message should appear once, with ordinary quotes and in its
original chronological position;
none should reappear beneath later messages. Also send a literal backslash and punctuation next
to a quote. Return to Main Menu, rejoin, and confirm the history remains free of duplicate copies.
Record the build/provider, pending-versus-final row counts and any failure codes without copying
message bodies into routine logs. Passing Ruffle checks and an installed BA2 do not establish this
native result.

For current production HUD 2.10.110, verify the combined General feed on each extender:

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

- Start the game with an already-linked provider token. Arrange for history and a populated roster
  to arrive while provider auth still reports `connecting`, then let only the normal event/auth
  timers run. The HUD must restore the authenticated identity, submit one current roster, receive
  matching `SERVER-READY`, and show Server without sending a General or Server message. Repeat with
  ZFE and xScal. Static chat being visible is not sufficient proof that this sequence completed.
- Complete a fresh web link while the HUD stays loaded. The link/auth refresh must re-arm bounded
  history and roster recovery; Server still waits for the current room confirmation. Reload with
  the saved credential and repeat to prove provider-owned auth persistence is restored rather than
  inferred from cached rows.

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
- Fill xScal's bounded native queue past its retention boundary. A contiguous or stale retirement
  marker for already-consumed events must not trigger `RESYNC`. Then inject a forward marker and a
  marker without a usable sequence; each must retain fail-closed history recovery. Run the native
  soak beyond the former approximately six-minute loop onset and require zero repeated resyncs.
- After an authoritative local ACK/self-echo adds supporter cosmetics, inspect older retained rows
  from the same authenticated sender IDs. They should repaint with the current projection. A row
  with the same display name but a different sender ID must remain unchanged.

Keep logs to build/provider, status codes, queue counts and timings. Do not collect tokens,
message bodies, player names, or private channel membership for routine diagnostics.
