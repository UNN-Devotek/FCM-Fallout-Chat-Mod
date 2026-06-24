# FCM-standalone.ba2 -- Build and Packaging Guide

This guide builds the **all-in-one standalone** archive: the patched
`HUDMenu.swf` (chat **input** + self-loader) **and** `FCMBridge.swf` (the chat
**feed** renderer + chat.v1 ZFE client), packed into a single `FCM-standalone.ba2`
that users install with one ini line. **No HUDModLoader required.**

Transport: **ZFE chat.v1** (ZFE 0.9.8+). The legacy FCMHUD/1 socket layer
(`__SFCodeObj`, `writeUTFBytes`/`readUTFBytes`, `HELLO/SEND/CHAN` verbs) is
fully removed from both SWFs. FCMBridge now calls `__ZFE.call("chat.v1.*")`
directly; the patched HUDMenu delegates sends to FCMBridge via
`fcmBridge.fcmSendMessage()`.

> Naming: this archive is `FCM-standalone.ba2`. Earlier drafts called it
> `FCMChat.ba2` — same thing; "standalone" is the accurate name because the one
> archive carries both SWFs and needs no other mod framework.

DO NOT redistribute Bethesda's decompiled HUDMenu source/SWF. Only our additions
(`fcm-inject.as`) belong in this repo.

---

## Architecture — two SWFs in one archive

| SWF (inside the .ba2) | Built from | Role |
|-----------------------|-----------|------|
| `interface/HUDMenu.swf`   | vanilla HUDMenu + `apply-patch.py` (injects `fcm-inject.as`) | Chat **input** (focus a TextField, suspend WASD, delegate send to FCMBridge), and — when HUDModLoader is absent — **self-loads** `FCMBridge.swf` |
| `interface/FCMBridge.swf` | `../FCMBridge.hx` (Haxe) | Chat **feed** render (`renderRecords`) + chat.v1 ZFE client (`chat.v1.connect`, `pollEvents`, `sendMessage`, `getAuthState`), worldId self-read + HMAC control message |

The patched HUDMenu's `fcmInit()` calls `fcmSelfLoadBridge()`, which is
**conditional**: if FCMBridge is already on the stage (HUDModLoader loaded it)
it skips; otherwise — the standalone case — it does
`Loader.load(new URLRequest("FCMBridge.swf"))` and `addChild`s it.
So the **same** `HUDMenu.swf` works both standalone and alongside HUDModLoader.

---

## Also ship the TextChat fragment

ZFE 0.9.8+ reads the TextChat fragment alongside the SWF to configure the
chat.v1 endpoint and channel list. Ship:

```
Data/ZFE/TextChat/fragments/FCM.ini
```

Contents: `AllowedChannels=global,trade,server,events,raids,infests`,
`DefaultChannel=global`, `OpenChatKey=PAGE_DOWN`, `EnableTimestamps=true`,
and the `Endpoint` URL. **Update `Endpoint` before each release:**

```ini
; dev
Endpoint=wss://dev.falloutchatmod.com/relay

; prod
Endpoint=wss://falloutchatmod.com/relay
```

Users can override any key per-key in `Data/configuration/zfe.ini` — the
fragment is only the default.

---

## Prerequisites

| Tool | Where to get | Used for |
|------|-------------|----------|
| Bethesda Archive Extractor (BAE) or Archive2 | Nexus -- "Bethesda Archive Extractor" | Extract vanilla `HUDMenu.swf` |
| JPEXS Free Flash Decompiler (ffdec) 21+ | github.com/jindrapetrik/jpexs-decompiler | Decompile **and** recompile HUDMenu (`-replace`) |
| JRE 11+ | adoptium.net | Required by ffdec |
| Haxe 4.3+ | haxe.org / `scoop install haxe` | Build `FCMBridge.swf` |
| Python 3 | python.org | `apply-patch.py`, `test_anchors.py`, SWF version-byte patch |
| Archive2.exe (ships with CK) **or** any BA2 GNRL v1 packer | Bethesda Creation Kit / BSArch | Pack the `.ba2` |

> Adobe Animate / the Flex SDK are **not** needed — `ffdec -replace` recompiles
> the patched AS3 directly.

---

## Step 0 -- Verify anchors (run once on a fresh ffdec export)

Before patching a new or updated `HUDMenu.as`, run the anchor test to confirm
all 6 injection points are intact:

```bash
cd game-mods/FCMBridge/hudmenu-chat
python3 test_anchors.py        # tests fcm-inject.as, FCMBridge.hx, FCM.ini
python3 test_anchors.py "<work>/HUDMenu.as"  # also checks all HUDMenu anchors
```

If any anchor check fails, the anchor moved in a Bethesda patch — fix it in
`apply-patch.py` and re-run before proceeding.

---

## Step 1 -- Extract vanilla HUDMenu.swf

Fallout 76 stores its UI SWFs inside `SeventySix - Interface.ba2`:

```
Archive2.exe "<FO76>\Data\SeventySix - Interface.ba2" -extract="interface\HUDMenu.swf" -outdir="<work>"
```

Result: `<work>\interface\HUDMenu.swf`.

**Always extract from the CURRENT live game files.** Every Bethesda patch may
change HUDMenu.swf, so the merge base must be fresh — a stale copy will break on
the next game update.

---

## Step 2 -- Decompile with ffdec

```
ffdec -export script <work>\src "<work>\interface\HUDMenu.swf"
```

(Or open in the ffdec GUI: `DefineSprite > HUDMenu.as` > Export selected >
ActionScript 3 source.) The main file is `<work>\src\...\HUDMenu.as`.

---

## Step 3 -- Patch HUDMenu.as with apply-patch.py

The patch is **automated** — do not hand-paste blocks. Run:

```
python3 apply-patch.py "<work>\src\...\HUDMenu.as"
```

`apply-patch.py` injects, against six asserted anchors (it auto-detects the
vanilla vs. HUDModLoader function-signature style, so the same script works on
either base):

1. The extra imports (`flash.display.Loader`, `flash.net.URLRequest`,
   `flash.system.ApplicationDomain`/`LoaderContext`, `flash.text.TextFormat`).
2. The `_fcm*` state fields (after `HUDChatBase_mc`) — including `_fcmBridge`
   (the FCMBridge instance reference) and `_fcmChannelSlug` (active channel slug).
3. `this.fcmInit();` (after the `CharacterInfoData` Subscribe).
4. **All FCM methods from `fcm-inject.as`** (before `enterChatMode`) — including
   the self-loader, channel slug table, and the `fcmForward` delegation to
   `FCMBridge.fcmSendMessage`.
5. `this.fcmForward(...)` on the outbound `ChatMessage` dispatch.
6. `this.fcmEvent(...)` in `ProcessUserEvent` + key probes in `chatEntryKeyUp`.

If any anchor is missing, the script exits with `ERROR: Anchor N ... not found` —
fix the anchor and re-run.

> `fcm-inject.as` is the **source of truth** for the injected AS3. It no longer
> contains `writeUTFBytes`, `HELLO~`, `SEND~`, `CHAN~`, or any `__SFCodeObj`
> bridge lookup — those belonged to the FCMHUD/1 era. Send now delegates to
> `FCMBridge.fcmSendMessage(body, channelSlug)`.

---

## Step 4 -- Recompile HUDMenu.swf with ffdec, patch version byte

```
ffdec -replace "<work>\interface\HUDMenu.swf" "<work>\HUDMenu.swf" HUDMenu "<work>\src\...\HUDMenu.as"
```

Scaleform in Fallout 76 requires **SWF version byte 32**. If ffdec writes a
different value, patch it:

```python
with open('HUDMenu.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
```

Verify: `python3 -c "print(open('HUDMenu.swf','rb').read(4)[3])"` -> `32`.

---

## Step 5 -- Build FCMBridge.swf (the chat.v1 ZFE client + feed renderer)

From `game-mods/FCMBridge/`:

```bash
haxe --main FCMBridge --swf FCMBridge.swf --swf-version 32
python3 -c "
with open('FCMBridge.swf','r+b') as f:
    d=bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)"
```

Verify the version byte: `python3 -c "print(open('FCMBridge.swf','rb').read(4)[3])"` -> `32`.

FCMBridge.hx requires **ZFE 0.9.8+** (needs the `zfe-chat-online-v1` capability).
At startup FCMBridge calls `getRuntimeInfo` and refuses to connect if the capability
is missing, logging a clear error to `zfe.log`.

---

## Step 6 -- Pack FCM-standalone.ba2

Stage both SWFs **and** the TextChat fragment under the correct paths:

```
<stage>\
  interface\
    HUDMenu.swf      <- patched (Step 4)
    FCMBridge.swf    <- chat.v1 feed renderer (Step 5)
  Data\
    ZFE\
      TextChat\
        fragments\
          FCM.ini    <- TextChat fragment (from game-mods/FCMBridge/Data/...)
```

Create the BTDX/GNRL archive:

```
Archive2.exe <stage> -create=FCM-standalone.ba2 -root=<stage> -format=GNRL
```

(On Linux, any BA2 **GNRL v1** packer works.)

---

## Step 7 -- Register in Fallout76Custom.ini

```
%USERPROFILE%\Documents\My Games\Fallout 76\Fallout76Custom.ini
```

```ini
[Archive]
sResourceArchive2List = FCM-standalone.ba2
```

---

## Step 8 -- Verify ZFE 0.9.8+ is installed

Two-way chat requires ZFE 0.9.8+ (which ships `zfe-chat-online-v1`). No env vars
are needed for the live backend path — ZFE reads the `Endpoint` from the TextChat
fragment. For local relay development override in `Data/configuration/zfe.ini`:

```ini
[TextChat]
Endpoint=ws://127.0.0.1:8788/
```

See [docs/overlay/zfe/env-vars.md](../../../docs/overlay/zfe/env-vars.md) for
all ZFE env vars.

---

## Step 9 -- Smoke test

1. Launch the game. `zfe.log` shows `FCMBridge loaded`, `BUILD=chatv1`, and
   `zfe-chat-online-v1 OK`. The feed panel renders community chat.
2. Press the chat key (PAGE_DOWN by default). The input box appears; WASD is
   suspended.
3. Type + ENTER -> the relay logs a `send` op; the message echoes back into the
   feed within ~2 s (next poll cycle).
4. ESC (or PAGE_DOWN again) closes input; movement resumes.
5. Verify the worldId control message appears in relay logs (server-channel room
   binding) on first connect and again on world transitions.

---

## Re-merging after a Bethesda patch

1. Extract the new vanilla HUDMenu.swf (Step 1) and decompile (Step 2).
2. Run `python3 test_anchors.py "<work>/HUDMenu.as"` (Step 0). The anchor
   asserts tell you immediately if Bethesda moved an injection point.
3. Run `python3 apply-patch.py` on the fresh `HUDMenu.as` (Step 3).
4. Recompile + repack (Steps 4-6).

`FCMBridge.swf` only needs rebuilding when `FCMBridge.hx` changes, not on a
Bethesda HUDMenu patch.

---

## File layout inside this folder

```
game-mods/FCMBridge/hudmenu-chat/
  apply-patch.py    -- the build tool (injects fcm-inject.as into HUDMenu.as)
  fcm-inject.as     -- the actual injected AS3 (input + self-loader + chat.v1 delegation)
  test_anchors.py   -- anchor assertions (run before patching / in CI)
  FCMChatPatch.as   -- older hand-annotated reference (not used by the build)
  fcmchat.ini       -- reference defaults only (not packed; ZFE reads the fragment INI)
  BUILD.md          -- this guide

game-mods/FCMBridge/Data/ZFE/TextChat/fragments/
  FCM.ini           -- TextChat fragment (pack into FCM-standalone.ba2 alongside SWFs)
```
