# FCMChatWidget build, install, and verification

> **Widget version:** 2.10.8. This is the optional in-game HUD-mod track. It is
> never installed or modified by the desktop overlay.

## What it does

`FCMChatWidget.ba2` contains `interface/FCMChatWidget.swf`, a HUDModLoader child
widget. It calls ZFE's sanctioned `chat.v1` API for authenticated community chat.
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

The widget resolves the sender identity from HUD-published `AccountInfoData.name`, which is the
public Fallout/Bethesda account handle other players see. Punctuation is preserved.
`PlayerListData` and `CharacterInfoData` expose character labels and cannot satisfy the relay
identity gate. Because account data may be populated late, the widget waits and retries before its
first relay handshake rather than connecting with `Wanderer` or a character-name substitute. Once
connected, later HUD reads update local identity state only; they never issue a second native
`chat.v1.connect`, and empty reads do not erase a known name.

## Requirements

| Component | Requirement |
| --- | --- |
| Haxe | 4.3+ |
| Python | 3 (stdlib only) |
| HUDModLoader | installed by the user |
| ZFE | 0.9.9+ with `zfe-chat-online-v1` capability |
| Fallout 76 | native Windows or Proton/Wine installation with the current ZFE chat.v1 support; do not treat this as a requirement for the desktop overlay |

## Configuration and install layout

Install the opt-in mod assets into the Fallout 76 `Data` directory. The recommended
distribution is the target-specific ZIP produced by `package.py`; it includes the
BA2, both configuration files, an append-only HUDModLoader snippet, and `INSTALL.txt`.
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
(`FCMChatWidget/settings.ini`), and retains the environment-owned link URL.

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

The current Windows package tries ZFE native input lazily when Insert opens the editor. It clears
and verifies the native buffer immediately after `setChatInputActive("true")`; the startup
activation probe is intentionally absent because some supported Windows/ZFE builds expose that
bare payload as literal text. If activation, cleanup, or the engine edit lock is unsupported, the
widget disables native input for the session and uses `SharedHUDTools.TextEdit`. A package is not
acceptable unless Insert opens an editable field, typing `hello` visibly becomes `hello`, Escape
cancels, and Enter sends the complete text.

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

1. With HUDModLoader and ZFE loaded, the startup log identifies `chatv1-widget-v2.10.8`. If
   `AccountInfoData` is late, the widget waits and retries. The sender label and a newly sent
   message use the exact public Fallout 76 account handle, including punctuation; neither
   `Wanderer` nor the local character name is used for the relay handshake.
2. The tab row contains one label for each visible channel—no boxed duplicate labels.
3. Switch channels, join/leave a world, and switch again; the tab row remains single-rendered.
4. Send a body containing `{`, `}`, quotes, and backslashes; later events still render.
5. Temporarily disconnect the relay. After three failed polls the widget shows reconnecting,
   then reconnects once the relay returns.
6. Confirm `SERVER` remains hidden until the relay acknowledges the printable roster/world control,
   then remains isolated to its derived room while static channels still work. Change worlds and confirm
   static history returns while only the newly bound server-room history appears.
7. While typing, confirm the native or fallback editor has only one visible text renderer; type
   `hello` and confirm the complete buffer remains visible; game movement/actions are locked;
   Page Down/Page Up switch channels without closing the input or losing its draft; Enter/Esc
   restore game input.
8. Outside the Pip-Boy, press F11 and confirm the HUDModLoader menu opens and lists FCMChatWidget.
9. Open **FCM → Customize → Reset all settings**; confirm the default size, position, opacity,
   amber theme, and auto-hide behavior return immediately and remain after restarting the game.
10. On the DEV relay, sign in with a linked moderator account. Confirm staff references and
    **FCM → Moderation commands** appear; submit actions against disposable test accounts by exact
    visible name (including a quoted multi-word name). Verify a duplicate visible name is rejected
    until its `[#XXXXXXXX]` reference is used. Submit delete, kick, mute, unmute, temporary ban,
    permanent ban, and unban. Confirm each action creates an audit entry and has the same Discord
    timeout/lockdown/role restoration outcome as the dashboard.

Do not copy the new BA2 into a live game installation or publish it until these
checks have passed on the intended environment.
