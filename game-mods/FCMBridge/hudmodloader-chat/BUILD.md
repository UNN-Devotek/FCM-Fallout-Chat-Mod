# FCMChatWidget build, install, and verification

> **Widget version:** 2.9.4. This is the optional in-game HUD-mod track. It is
> never installed or modified by the desktop overlay.

## What it does

`FCMChatWidget.ba2` contains `interface/FCMChatWidget.swf`, a HUDModLoader child
widget. It calls ZFE's sanctioned `chat.v1` API for authenticated community chat.
It only uses HUD UI data that Fallout 76 already exposes to its HUD; it does not
read game memory, inject code, alter game state, or scan local ports/networks.

The widget's community tabs are deliberately a **single static text strip**. They
are navigated with the configured control-map actions and slash commands; do not
add HUDButton instances over that strip. Doing so creates the overlapping labels
that v2.9.2 removed.

The `SERVER` room uses an authenticated relay session. The widget sends a bounded
nearby-player roster control from HUD UI data; the backend derives a short-lived
room from it. The control uses the relay's legacy NUL framing, but JSON-escapes
each NUL/unit-separator byte before it crosses ZFE, so ZFE never receives a raw
control byte or rejects the message as empty. There is no client-side relay-control
HMAC or shared secret in the distributed SWF. `worldId` controls are a guarded
compatibility fallback.

## Requirements

| Component | Requirement |
| --- | --- |
| Haxe | 4.3+ |
| Python | 3 (stdlib only) |
| HUDModLoader | installed by the user |
| ZFE | 0.9.9+ with `zfe-chat-online-v1` capability |
| Fallout 76 | native Windows installation validated; do not treat this as a requirement for the desktop overlay |

## Configuration and install layout

Install the opt-in mod assets into the Fallout 76 `Data` directory:

```text
Data/FCMChatWidget.ba2
Data/FCMChat.ini
Data/hudmodloader.ini                 # contains FCMChatWidget
Data/ZFE/TextChat/fragments/FCMChatWidget.ini
Documents/My Games/Fallout 76/Fallout76Custom.ini
```

`Fallout76Custom.ini` needs the archive listed with HUDModLoader, for example:

```ini
[Archive]
sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2
```

The shipped fragment uses `OpenChatKey=INSERT` and
`Endpoint=wss://falloutchatmod.com/relay`. The endpoint is **always** `/relay`,
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

## Build the archive

Run from this directory.

```bash
haxe test-config.hxml
haxe build.hxml
python3 - <<'PY'
import struct, zlib
path = 'FCMChatWidget.swf'
raw = open(path, 'rb').read()
if raw[:3] == b'CWS':
    body = zlib.decompress(raw[8:])
    raw = bytearray(b'FWS' + raw[3:4] + struct.pack('<I', 8 + len(body)) + body)
else:
    raw = bytearray(raw)
raw[3] = 32
open(path, 'wb').write(raw)
PY
python3 ../hudmenu-chat/ba2tool.py create FCMChatWidget.ba2 \
  interface/FCMChatWidget.swf=FCMChatWidget.swf
```

The Scaleform artifact must have `FWS` bytes and SWF version 32. Verify the BA2
contains the same SWF before distributing it.

## Required checks

```bash
python3 ../hudmenu-chat/test_anchors.py
cd ../../../cross-platform-overlay
npm run test:unit -- --run __tests__/fcm-chat-widget-logic.test.js
cd ../backend
npm run build
npm test -- --runTestsByPath tests/relayHandler.test.js
```

The source-level anchor test prevents the tab-renderer regression and rejects a
compiled relay-control HMAC. The JavaScript test covers JSON event boundaries,
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
relay endpoint. The relay accepts both control formats during the
transition: the printable `FCMCTL/1/*` frame emitted by v2.9.3 and the legacy
frame emitted by v2.9.4 after JSON decoding. This means a player already running
v2.9.3 can obtain the `SERVER` tab after the relay reconnects and the next roster
update; they do not need to replace game files to test the backend deployment.

The relay must acknowledge every accepted control with a non-empty synthetic
`messageId`; an empty ID violates ZFE's send-response contract and is surfaced to
the widget as `relay_rejected`, leaving `SERVER` hidden even though membership was
updated successfully.

The v2.9.4 BA2 is required for the client-side JSON-escaped legacy framing. Copy
it into `Fallout 76/Data` only after Fallout 76 has fully exited, then restart the
game so ZFE reloads the archive and fragment. Never overwrite an in-use BA2.

HUDModLoader's upstream menu hotkey is **F11**, outside the Pip-Boy. F12 is the
game's `DiagnosticSnapshot` action and is not a reliable route to the loader menu.

## In-game acceptance checklist

1. With HUDModLoader and ZFE loaded, the startup log identifies `chatv1-widget-v2.9.4`.
2. The tab row contains one label for each visible channel—no boxed duplicate labels.
3. Switch channels, join/leave a world, and switch again; the tab row remains single-rendered.
4. Send a body containing `{`, `}`, quotes, and backslashes; later events still render.
5. Temporarily disconnect the relay. After three failed polls the widget shows reconnecting,
   then reconnects once the relay returns.
6. Confirm `SERVER` remains hidden until the relay acknowledges the JSON-escaped legacy roster/world control,
   then remains isolated to its derived room while static channels still work.
7. While typing, confirm the fallback has only one visible text renderer; game movement/actions
   are locked; Page Down/Page Up switch channels without closing the input or losing its draft;
   Enter/Esc restore game input.
8. Outside the Pip-Boy, press F11 and confirm the HUDModLoader menu lists FCMChatWidget.

Do not copy the new BA2 into a live game installation or publish it until these
checks have passed on the intended environment.
