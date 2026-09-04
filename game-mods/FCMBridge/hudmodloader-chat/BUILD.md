# FCMChatWidget build, install, and verification

> **Widget version:** 2.10.46. This is the optional in-game HUD-mod track. It is
> never installed or modified by the desktop overlay.

## What it does

`FCMChatWidget.ba2` contains `interface/FCMChatWidget.swf`, a HUDModLoader child
widget. It calls the active script extender's sanctioned chat API for authenticated community
chat: ZFE's `chat.v1` dispatcher or xScal's `chatInterface` under `__SFECodeObj` or
`__SFCodeObj`. Current xScal builds may also expose a generic call-only
`__SFCodeObj.call` callback object on the movie root; it is not the chat surface and must not
be classified as ZFE.
It only uses HUD UI data that Fallout 76 already exposes to its HUD; it does not
read game memory, inject code, alter game state, or scan local ports/networks.
Message timestamps are not displayed in the in-game feed; legacy timestamp settings are ignored.

The widget's community tabs are deliberately a **single static text strip**. They
are navigated with the configured control-map actions and slash commands; do not
add HUDButton instances over that strip. Doing so creates the overlapping labels
that v2.9.2 removed.

The `SERVER` room uses an authenticated relay session. The widget sends a bounded
nearby-player roster control from HUD UI data; the backend derives a short-lived
room from it. New controls use printable `FCMCTL/1/*` framing; the relay retains
legacy NUL framing for deployed widgets. There is no client-side relay-control HMAC
or shared secret in the distributed SWF. `worldId` controls are a guarded
compatibility fallback.

On every widget initialization, v2.10.1 sends the authenticated `FCMCTL/1/RESYNC`
control. This restores static-feed history even if HUDModLoader recreated the SWF while
ZFE kept its native subscriber alive. Server-room history waits for the next confirmed
roster/world bind, so history from the previous world cannot leak into the new one.

Since v2.10.46, the widget explicitly pulls the cached values for `PlayerListData`,
`TeamMarkers`, `PartyMenuList`, and `VoiceChatAreaData` after subscribing. The upstream
`BSUIDataManager.Subscribe()` call installs a change listener but does not replay the current
provider value, so relying on the callback alone can leave a newly joined world without a
`SERVER` tab or its history. Each provider is stored as a replaceable snapshot. An empty or
completely disjoint snapshot marks a world-session boundary; the widget clears only local
ephemeral `SERVER` rows, sends `FCMCTL/1/LEAVE`, and submits a fresh roster on the next poll.
The relay's accepted fresh bind then backfills the current room's recent Redis history. Static
channel history remains durable; `SERVER` history is intentionally bounded/ephemeral.

The widget resolves the sender identity from HUD-published `AccountInfoData.name`, which is the
public Fallout/Bethesda account handle other players see. Punctuation is preserved.
`PlayerListData` and `CharacterInfoData` expose character labels and cannot satisfy the relay
identity gate. Because account data may be populated late, the widget waits and retries before its
first relay handshake rather than connecting with `Wanderer` or a character-name substitute. Once
connected, later HUD reads update local identity state only; they never issue a second native
`chat.v1.connect`, and empty reads do not erase a known name.

The HUD renders the server-validated channel and identity tags plus an optional supporter marker.
The marker is a five-point vector `Shape` in the same row `Sprite` as two text fields: one for the
channel tag and one for the hanging message content. The row measures the channel field, reserves
the marker slot, and places the marker 5px after the complete channel tag, vertically centered
with a 2px visual down-nudge in the first message line. It never uses `getCharBoundaries()`, document indices, or
global/local transforms. This avoids the Scaleform mixed-font coordinate drift that previously put
stars over the channel tag or in the top-left corner. It uses the validated `starColor` and never
renders a Unicode glyph, bitmap, HTML image, or substitution token. Feed paragraph leading is zero,
and the feed keeps only a 4px safety gap above the top-level HUDTools input so rows stay compact
while new content remains above the input field.
Before entering the synchronous native send RPC, the widget creates exactly one local send
transaction row (even during the short interval before `getAuthState` supplies the relay user id).
The current relay returns the server-resolved tag/star and message ID in the successful ACK, so
the widget decorates that exact row as soon as the send response arrives. The live event may race
the ACK; a stable-ID event can complete the same row first, never a second row. The later event is
reconciled by the stable relay message ID when `FCMHUD/1` is available, then by a proven local
identity. For an older Dev bridge, the widget seeds a bounded local cosmetic snapshot only from
one unambiguous historical sender identity, keeps it on a cosmetics-free ACK, and finally uses a
unique, ACK-accepted, 15-second display-name/channel/body fallback. A matched event updates the
existing row in place; it never appends a second row. Ambiguous or stale legacy candidates remain
separate rather than being guessed. One deferred poll remains as a compatibility drain; ordinary
background polling remains controlled by `pollMs`.

The backend sends a newly finalized static-channel message directly to native relay subscribers
on the same process, then publishes it to Redis for other backend instances. The Redis listener
skips the shared local instance ID, so the direct event is not delivered twice. This is the
latency-critical path for all already-connected HUDs; a Dev deployment must run the matching
backend source for it to take effect.

The relay auth-state response exposes both the relay-text `userId` and the linked account
`linkedUserId`. HUD chat events use the linked account UUID as `senderUserId`, so the widget keeps
both aliases locally when matching its own authoritative echo; the linked ID is never sent back
as a client-supplied identity. An old Dev native bridge can preserve neither the matching alias nor
the `FCMHUD/1` message-id carrier, so the bounded fallback is deliberately accepted only after the
same send receives a successful ACK and only when exactly one candidate matches.

ZFE's native `chat.v1` bridge filters unknown JSON members before the SWF receives an event. The
v2.10.46 widget therefore reads the stable message ID, validated `tag`, and cosmetic transport from an
`FCMHUD/1;...` envelope carried in the existing known `targetUserId` field. For ordinary channel
chat this field is an empty transport slot, not a real recipient. The relay only emits the
envelope to v2.10.16+ clients; older BA2 files receive no transport data. Raw relay consumers
still receive the additive fields described in the protocol spec.

## Requirements

| Component | Requirement |
| --- | --- |
| Haxe | 4.3+ |
| Python | 3 (stdlib only) |
| HUDModLoader | installed by the user |
| ZFE | 0.9.9+ with `zfe-chat-online-v1` capability |
| xScal | `[Chat] enabled=true` and `chatInterface` under `__SFECodeObj` or `__SFCodeObj`, with `connect`, `pollEvents`, and `sendMessage` |
| Fallout 76 | native Windows or Proton/Wine installation with the current ZFE chat.v1 support; do not treat this as a requirement for the desktop overlay |

## Configuration and install layout

Install the opt-in mod assets into the Fallout 76 `Data` directory. The recommended
distribution is the target-specific ZIP produced by `package.py`; it includes the
BA2, both configuration files, an append-only HUDModLoader snippet, `INSTALL.txt`,
and `HUDMODLOADER-MENU.txt`.
It deliberately does not include a replacement `Data/hudmodloader.ini`.

```text
Data/FCMChatWidget.ba2
Data/FCMChat.ini
Data/ZFE/TextChat/fragments/FCMChatWidget.ini
FCMChatWidget.hudmodloader.ini       # root-level append snippet, not Data/hudmodloader.ini
Documents/My Games/Fallout 76/Fallout76Custom.ini
```

After extracting the package, append `FCMChatWidget` exactly once to the user's
existing `Data/hudmodloader.ini`. Preserve all other widget entries. Append
`FCMChatWidget.ba2` to the existing `sResourceArchive2List` value in
`Fallout76Custom.ini`; do not replace the user's BA2 list.

`Fallout76Custom.ini` needs the archive listed with HUDModLoader, for example:

```ini
[Archive]
sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2
```

The shipped fragment uses `OpenChatKey=INSERT` and the production endpoint by
default. The endpoint is **always** `/relay`,
not `/zfe-relay`. Local and hosted-dev users override the exact endpoint key in
`Data/configuration/zfe.ini`:

```ini
[TextChat]
Endpoint=wss://dev.falloutchatmod.com/relay
```

The included `FCMChat.ini` controls position, colors, size, polling cadence and
key bindings. Its open-key setting is separate from ZFE's authoritative
`OpenChatKey`; keep both settings aligned. ZFE reads Text Chat fragments at game
startup, so restart Fallout 76 after replacing the BA2 or fragment; hot-reloading
the widget cannot reload native relay configuration.

HUDModLoader's F11 menu exposes **FCM → Customize → Reset all settings**. The action
restores the `FcmConfig` defaults live, saves them in vendor-scoped ZFE storage
(`FCMChatWidget/settings.ini`), and retains the environment-owned link URL. The generated ZIP
includes `HUDMODLOADER-MENU.txt` with the same menu and input steps. Press **F11** to open the
menu, use **FCM → Customize...** for appearance/settings, and **FCM → Scroll to newest** for the
feed. The loader reload control applies live widget changes; replacing the BA2 or ZFE fragment
requires exiting and restarting Fallout 76.

### Target-specific packages

Do not assemble a DEV package by copying the production INIs. The package helper
stamps both environment-owned values together: the relay endpoint and the account
link host. Run it from this directory after building `FCMChatWidget.ba2`:

```bash
python3 package.py --target dev --output /tmp/FCMChatWidget-dev.zip
python3 test_package.py
```

Use `--target prod` for production. The helper refuses to package a stale BA2
whose embedded version does not match `FCMChatWidget.hx`. Each generated archive contains only its
target's endpoint and account-link details. Never copy a configuration file
between targets. `INSTALL.txt` in the generated archive repeats the matching
URL and installation steps, and `FCMChatWidget.version.txt` records the embedded
widget version. The output can be regenerated at any time from the current
`FCMChatWidget.hx` version:

```bash
python3 package.py --print-version
python3 package.py --target prod --output "/tmp/ZFE FCM HUD Mod-$(python3 package.py --print-version) (PROD).zip"
```

## Input-path acceptance

The current package uses HUDModLoader's SharedHUDTools editor first when Insert opens the editor.
That host-domain path owns the balanced `ControlMap::StartEditText` / `EndEditText` lifecycle, so
game movement/actions remain locked while the player types and are restored on Enter/Escape or a
named modal handoff. v2.10.45 incorrectly reintroduced a dynamically resolved child-SWF dispatch
of the same ControlMap events; in-game this emitted repeated `FCMChatWidget: [UncaughtErrorEvent
... Error #1014]` lines and left the player unable to control the character. v2.10.46 removes
that child dispatch. If SharedHUDTools is unavailable or its editor cannot open, ZFE native input
is an emergency no-lock fallback; it never attempts to synthesize the ControlMap lock.

The ZFE fallback clears and verifies its native buffer immediately after
`setChatInputActive("true")`; the startup activation probe is intentionally absent because some
supported Windows/ZFE builds expose that bare payload as literal text. A package is not acceptable
unless the normal SharedHUDTools path opens one editable field, typing `hello` visibly becomes
`hello` (including repeated letters), Escape cancels, Enter sends the complete text, gameplay is
restored after editing, and named Quick Actions/Friends focus transitions do not leave the editor
stuck.
Page Up/Page Down must switch channels both while idle and while preserving an open draft; the
widget accepts either the first key-down or a key-up-only loader event without double-switching.

On supported ZFE builds, a bare boolean from `readChatInput` immediately after a successful
`clearChatInput` is an empty/status response, not a one-character draft; the native fallback remains
available. If the clear is not confirmed, the widget closes the partial native session and uses the
single SharedHUDTools editor. One-character native observations are
accumulated, including repeated characters, so a draft such as `hello` is not reduced to its last
letter.

### Relinking a Discord account

Type `/relink` as a standalone HUD command, or choose **F11 -> FCM -> Relink account...**. The
widget requests ZFE's top-level `clearChatAuth` command, which is the only supported owner of the
DPAPI/local relay token at `Data/ZFE/chat-auth.bin`. When ZFE confirms the clear, the widget
reconnects and displays a newly issued link code. The command does not accept arguments, and the
widget never tries to write the auth file through `writeStorage`.

`clearChatAuth` is an optional ZFE-side extension. If the installed ZFE returns an unsupported
command or otherwise rejects it, the widget leaves the saved token untouched and displays:
"Exit Fallout 76, delete Data/ZFE/chat-auth.bin, then restart." This fallback is intentional: a
HUD SWF cannot safely delete an arbitrary local file, and it must not report a successful relink
when the old token remains. The current ZFE build must implement this command before the automatic
part of `/relink` is available to players.

## Build the archive

Run from this directory.

```bash
haxe test-config.hxml
haxe test-command.hxml
haxe build.hxml
python3 normalize_swf.py FCMChatWidget.swf
python3 ../hudmenu-chat/ba2tool.py create FCMChatWidget.ba2 \
  interface/FCMChatWidget.swf=FCMChatWidget.swf
```

The Scaleform artifact must have `FWS` bytes and SWF version 32. Verify the BA2
contains the same SWF before distributing it.

## Required checks

```bash
haxe test-config.hxml
haxe test-identity.hxml
python3 ../hudmenu-chat/test_anchors.py
cd ../../../cross-platform-overlay
npm run test:unit -- --run __tests__/fcm-chat-widget-logic.test.js
cd ../backend
npm run build
npm test -- --runTestsByPath tests/relayHandler.test.js
```

The source-level anchor test prevents the tab-renderer regression, rejects a
compiled relay-control HMAC, and ensures release diagnostics do not log chat text
or relay identities. The JavaScript test covers JSON event boundaries,
including braces and escaped quotes in message bodies. Backend tests cover relay
availability, authenticated controls, validation, and roster membership.

## Production rollout

The backend refuses `/relay` in production unless
`RELAY_PRODUCTION_ENABLED=true`. It defaults to `false`; setting the value is an
explicit deployment action, not part of building this BA2. Before enabling it,
deploy the matching backend, run its relay tests, and perform an authenticated
WebSocket handshake against the production endpoint. If that handshake fails,
leave the flag off and do not distribute a production-configured build.

## Hosted-dev tester handoff (verified 2026-07-19)

The hosted-dev stack tracks `dev` at `dev.falloutchatmod.com` and its direct
relay endpoint. The relay accepts both control formats during the transition.
Current widgets emit printable `FCMCTL/1/*` frames; legacy NUL-framed controls
remain accepted for older installations. A player with an older build can obtain
the `SERVER` tab after reconnecting and the next roster update.

The relay must acknowledge every accepted control with a non-empty synthetic
`messageId`; an empty ID violates ZFE's send-response contract and is surfaced to
the widget as `relay_rejected`, leaving `SERVER` hidden even though membership was
updated successfully.

Copy the matching BA2 into `Fallout 76/Data` only after Fallout 76 has fully
exited, then restart the game so ZFE reloads the archive and fragment. Never
overwrite an in-use BA2.

HUDModLoader's upstream menu hotkey is **F11**, outside the Pip-Boy. F12 is the
game's `DiagnosticSnapshot` action and is not a reliable route to the loader menu.

### Staff moderation commands

The HUD derives moderation availability from `chat.v1.getAuthState`; only a linked Discord
`moderator`, `admin`, or `owner` sees a `[#XXXXXXXX]` reference beside visible messages and the
**FCM → Moderation commands** F11 menu item. Enter an exact visible player name for a quick action,
or quote a multi-word name. The HUD resolves that local display-name match to the immutable relay
message and account IDs. If two visible accounts have the same name, it refuses the action and you
must use the `[#XXXXXXXX]` reference instead.

Open chat and enter one of the following, supplying a non-empty reason for every action:

```text
/mod Alice mute <minutes> <reason>
/mod "Alice Smith" kick <reason>
/mod #XXXXXXXX delete <reason>
/mod #XXXXXXXX kick <reason>
/mod #XXXXXXXX mute <minutes> <reason>
/mod #XXXXXXXX unmute <reason>
/mod #XXXXXXXX ban <minutes|permanent> <reason>
/mod #XXXXXXXX unban <reason>
```

`mute` and temporary `ban` accept 1–43,200 minutes (30 days). `ban` requires an explicit duration
or `permanent`, preventing an accidental permanent ban. Slow mode deliberately has no HUD command:
FCM has no per-channel slow-mode primitive. The relay repeats role, target, reason, and protected-
staff validation on every request; the HUD permission is only a visibility hint.

## In-game acceptance checklist

1. With HUDModLoader and ZFE or xScal loaded, the startup log identifies `chatv1-widget-v2.10.46`. If
   `AccountInfoData` is late, the widget waits and retries. The sender label and a newly sent
   message use the exact public Fallout 76 account handle, including punctuation; neither
   `Wanderer` nor the local character name is used for the relay handshake.
2. The tab row contains one label for each visible channel—no boxed duplicate labels.
3. Switch channels, join/leave a world, and switch again; the tab row remains single-rendered.
4. Send a body containing `{`, `}`, quotes, and backslashes; later events still render.
5. On DEV, use a linked supporter account and confirm each supporter message has exactly one
   colored vector star 5px after the complete channel tag and before the message content.
   It must be centered on the author's first message line with the 2px visual down-nudge, including when a moderation or
   custom identity tag is present. The marker must move with its row while scrolling and never
   appear in the header/top-left corner.
   Confirm non-supporter
   messages have no marker, and that neither `FCMHUD/1;`, `FCMSTAR`, `★`, nor tofu blocks appear.
6. Temporarily disconnect the relay. After three failed polls the widget shows reconnecting,
   then reconnects once the relay returns.
7. Confirm `SERVER` remains hidden until the relay acknowledges the printable roster/world control,
   then remains isolated to its derived room while static channels still work. Change worlds and confirm
   the log shows a roster-session boundary, `LEAVE`, and a fresh roster acknowledgement; the
   `SERVER` sub-tab returns and only the newly bound server-room history appears. Static history
   returns independently. An empty roster is valid for a solo world.
8. While typing, confirm the SharedHUDTools editor has only one visible text renderer; type
   `hello` and confirm the complete buffer remains visible, including repeated letters; game
   movement/actions are locked and restored after Enter/Escape;
   Page Down/Page Up switch channels on both key-down and key-up-only loader builds. A successful
   send should show the tag/star from the ACK or direct live event without waiting for the next
   regular poll, then reconcile to one authoritative row. All connected widgets should receive the
   same event through direct local fan-out or the Redis cross-instance path. For a one-message test,
   the `recv` log must keep `recordsBefore` equal to `recordsAfter`, with `ownEchoId=1` on a new
   relay or `ownEchoFallback=1` on the old Dev bridge. `ownEchoAmbiguous=1` is a failure for a
   single send. After Insert opens the typing
   session, Arrow Up/Down scroll
   the feed and Home/End return to newest without closing the input or losing its draft; before
   Insert they remain game controls. Enter/Esc
   restore game input. While a draft is active, press Ctrl+Tab and confirm the social menu opens
   normally and Escape can close it: the `OpenSocial` handoff must deactivate the no-lock native
   fallback or call `SharedHUDTools.EndTextEdit()` before the game processes the social action. The canceled
   draft must not be sent or reappear as a duplicate.
9. Outside the Pip-Boy, press F11 and confirm the HUDModLoader menu opens and lists FCMChatWidget.
10. Open **FCM → Customize → Reset all settings**; confirm the default size, position, opacity,
   amber theme, and auto-hide behavior return immediately and remain after restarting the game.
11. Use **F11 → FCM → Relink account...** and type `/relink` once each. On a ZFE build with
    `clearChatAuth`, confirm the local token is cleared, the relay reconnects, and a new link code
    appears. On an older ZFE build, confirm the widget shows the manual reset instruction and does
    not reconnect or claim that the token was cleared.
12. On the DEV relay, sign in with a linked moderator account. Confirm staff references and
    **FCM → Moderation commands** appear; submit actions against disposable test accounts by exact
    visible name (including a quoted multi-word name). Verify a duplicate visible name is rejected
    until its `[#XXXXXXXX]` reference is used. Submit delete, kick, mute, unmute, temporary ban,
    permanent ban, and unban. Confirm each action creates an audit entry and has the same Discord
    timeout/lockdown/role restoration outcome as the dashboard.

Do not copy the new BA2 into a live game installation or publish it until these
checks have passed on the intended environment.
