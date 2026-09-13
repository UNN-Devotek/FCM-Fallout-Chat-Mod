# FCMChatWidget

FCMChatWidget is the optional HUDModLoader chat widget for Fallout 76. It uses ZFE or xScal's
native chat bridge and FCM's `/relay`. It is independent of the desktop overlay.

**Local candidate: 2.10.78 (2026-09-12).** Source, SWF, and BA2 were reviewed and rebuilt locally.
This is not a claim of publication, installation, hosted CI success, or in-game verification.
See [BUILD.md](BUILD.md) for reproducible checks and installation, and the
[HUD documentation index](../../../docs/overlay/zfe/README.md) for owning guides.

## Feed and sends

General combines General, current-room Server, Trading, Events, Infests, and Raids. Each message
retains its original channel tag and canonical identity. Other tabs filter the same bounded
history. Sending from General targets `global`; no messages are copied or rebroadcast. Unknown,
private, and system channels are excluded. Leaving a room clears its SERVER records and
identities without clearing static history.

Replay rejection runs before pending-send matching. Retained canonical rows remain a duplicate
guard after cache eviction. A known ACK ID cannot match a different event through a same-body
fallback. Missing-ID compatibility matching is bounded and unique-only; ambiguous repeated sends
are not guessed together. Read-back mode preserves scroll position and counts new visible rows.

A pending own row is painted before a deferred native send call. Authoritative ACK/event data
reconciles that row once, including server-provided cosmetics. With negotiated retry support,
transient failures keep a bounded queued row; terminal failures remove it. The same local request
ID is reused for retries, with SERVER room pinning. See
[retry safety](../../../docs/overlay/zfe/hud-send-retries.md).

Initial history contains up to 15 messages per static channel and 50 from the current SERVER
room. The widget drains the up-to-125-event snapshot over multiple native polls. Empty/lost
queues trigger bounded authenticated recovery; SERVER history waits for a fresh room bind.
Account identity comes from the public HUD account handle, not a local character label or the
`Wanderer` placeholder. Limited identities see a pinned link code and cannot send.

## Provider and input contracts

`../FcmNativeApi.hx` discovers already-exposed objects, preferring a validated xScal
`chatInterface` when both providers are present. ZFE requires a positive chat capability response.
xScal requires chat methods and checks its optional runtime response when present. ZFE gets JSON
strings; xScal gets ActionScript objects or no arguments according to the selected method. Its
generic callback is separate from chat transport.

SharedHUDTools owns the main text editor and balances its game-control lock. A legacy ZFE input
fallback is retained; the widget does not dispatch ControlMap lock events itself. The public ZFE
`input.v1.*` text-session and `hotkeys.v1.*` APIs are different contracts and are not implemented
by renaming FCM's compatibility calls. See the [provider guide](../../../docs/overlay/zfe/modder-guide.md).

The shipped key map is `openKey=INSERT`, `channelNextKey=NextPage`, `channelPrevKey=PrevPage`,
`scrollUpKey=Up`, `scrollDownKey=Down`, `scrollBottomKey=` and `hideKey=`. Insert opens chat;
Enter sends; Escape cancels. Page Up/Down switch channels while idle or editing. Up/Down scroll
only while chat owns the visible editor. The blank newest and hide values are intentional: Home/End
remain game controls, while `/hide` and the F11 menu hide the feed. `KEYBINDS.txt` covers aliases,
rebinding, physical polling, and ZFE config precedence.
xScal's numeric `Input.*` operations require Boolean results; ZFE's compatibility decoder also
handles its legacy envelopes. Registration does not promise gameplay suppression.

Slash shortcuts include `/g`, `/t`, `/e`, `/i`, `/r`, and `/s`; `/clear` clears the local feed,
`/hide` hides it, and `/relink` requests the provider's supported credential reset. Reset failure
must not claim a new identity. `/emoji` searches/sends bundled emoji. Staff-only `/mod` commands
resolve visible targets to immutable IDs and repeat permission checks on the backend. See
[staff commands](BUILD.md#staff-moderation-commands).

## Rendering and customization

Each row has a full-width native multiline plain-text field with `TextFormat` ranges for channel,
name, body, and staff reference. A supporter star and bundled emoji sprites share the row's
coordinate basis. Placement measures layout bounds and reserved slots after wrapping; it does
not require global transforms when the fields and decorations already share a parent.

The styled baseline survives optional emoji failures. Known Unicode/custom emoji use bundled
static vector sprites; unsupported custom emoji fall back to readable names. No remote emoji
images or GIF playback are loaded. Delayed row slices check their generation and catch their own
failures; fallback invalidates pending work. Flash/JavaScript tests do not establish GFx behavior.

F11 → FCM → Customize changes position, independent panel dimensions, feed/input text size, input
height, backgrounds, text colors, opacity, and auto-hide. Input width/alignment follow the panel.
Server-resolved user colors override the default local sender color. Timestamps are not shown;
channel colors/tags, badges, emoji, and available/default channels are not appearance controls.
See [CUSTOMIZATION.txt](CUSTOMIZATION.txt) for active/retired INI keys and saved-setting precedence.

ZFE stores F11 settings in vendor-scoped storage. xScal uses per-linked-device relay persistence
only when the backend advertises the capability and supports the settings payload. Missing
persistence leaves changes session-local. A code checkout does not establish backend deployment.

## Files

| File(s) | Purpose |
| --- | --- |
| `FCMChatWidget.hx` | Widget lifecycle, input, native relay integration, rendering |
| `FcmCommand.hx`, `FcmHistory.hx`, `FcmEcho.hx`, `FcmOutbox.hx` | Channel/command, replay, echo, retry guards |
| `FcmConfig.hx`, `FcmHudLayout.hx` | INI settings and optional per-device persistence |
| `FcmRenderGeneration.hx`, `FcmFeedText.hx`, `FcmEmoji*.hx` | Delayed rendering, styled text, bundled emoji |
| `FCMChat.ini`, `FCMChatWidget.ini`, `hudmodloader.ini` | Package configuration templates and loader line |
| `build.hxml`, `normalize_swf.py`, `emoji/` | Haxe build, FWS normalization, bundled sprite data/licenses |
| `package.py`, `test_package.py`, `test-*.hxml` | Target/provider/distribution packaging and checks |
| `FCMChatWidget.swf`, `FCMChatWidget.ba2` | Generated local artifacts; verify decoded payload equality |
| `BUILD-HISTORY.md` | Dated investigations and superseded build notes |
