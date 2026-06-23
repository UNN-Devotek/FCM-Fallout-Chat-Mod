# FCM-standalone.ba2 -- Build and Packaging Guide

This guide builds the **all-in-one standalone** archive: the patched
`HUDMenu.swf` (chat **input** + self-loader) **and** `FCMBridge.swf` (the chat
**feed** renderer + socket bridge), packed into a single `FCM-standalone.ba2`
that users install with one ini line. **No HUDModLoader required.**

> Naming: this archive is `FCM-standalone.ba2`. Earlier drafts called it
> `FCMChat.ba2` — same thing; "standalone" is the accurate name because the one
> archive carries both SWFs and needs no other mod framework.

DO NOT redistribute Bethesda's decompiled HUDMenu source/SWF. Only our additions
(`fcm-inject.as`) belong in this repo.

---

## Architecture — two SWFs in one archive

| SWF (inside the .ba2) | Built from | Role |
|-----------------------|-----------|------|
| `interface/HUDMenu.swf`   | vanilla HUDMenu + `apply-patch.py` (injects `fcm-inject.as`) | Chat **input** (focus a TextField, suspend WASD, `SEND~…`), and — when HUDModLoader is absent — **self-loads** `FCMBridge.swf` |
| `interface/FCMBridge.swf` | `../FCMBridge.hx` (Haxe) | Chat **feed** render (`renderRecords`) + the `__SFCodeObj` socket/polling bridge |

The patched HUDMenu's `fcmInit()` calls `fcmSelfLoadBridge()`, which is
**conditional**: if the bridge is already present (HUDModLoader loaded it) it
skips; otherwise — the standalone case — it does
`Loader.load(new URLRequest("FCMBridge.swf"))` (a SWF loader, which works in GFx;
`URLLoader` is sandbox-blocked) and `addChild`s it into the display tree. So the
**same** `HUDMenu.swf` works both standalone and alongside HUDModLoader. See
`fcm-inject.as` (`fcmSelfLoadBridge` / `fcmOnBridgeLoaded`).

---

## Prerequisites

| Tool | Where to get | Used for |
|------|-------------|----------|
| Bethesda Archive Extractor (BAE) or Archive2 | Nexus -- "Bethesda Archive Extractor" | Extract vanilla `HUDMenu.swf` |
| JPEXS Free Flash Decompiler (ffdec) 21+ | github.com/jindrapetrik/jpexs-decompiler | Decompile **and** recompile HUDMenu (`-replace`) |
| JRE 11+ | adoptium.net | Required by ffdec |
| Haxe 4.3+ | haxe.org / `scoop install haxe` | Build `FCMBridge.swf` |
| Python 3 | python.org | `apply-patch.py`, SWF version-byte patch |
| Archive2.exe (ships with CK) **or** any BA2 GNRL v1 packer | Bethesda Creation Kit / BSArch | Pack the `.ba2` |

> Adobe Animate / the Flex SDK are **not** needed — `ffdec -replace` recompiles
> the patched AS3 directly.

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
ActionScript 3 source.) The main file is `<work>\src\…\HUDMenu.as`.

---

## Step 3 -- Patch HUDMenu.as with apply-patch.py

The patch is **automated** — do not hand-paste blocks. Run:

```
python3 apply-patch.py "<work>\src\…\HUDMenu.as"
```

`apply-patch.py` injects, against six asserted anchors (it auto-detects the
vanilla vs. HUDModLoader function-signature style, so the same script works on
either base):

1. The extra imports (`flash.display.Loader`, `flash.net.URLRequest`,
   `flash.system.ApplicationDomain`/`LoaderContext`, `flash.text.TextFormat`).
2. The `_fcm*` state fields (after `HUDChatBase_mc`).
3. `this.fcmInit();` (after the `CharacterInfoData` Subscribe).
4. **All FCM methods from `fcm-inject.as`** (before `enterChatMode`).
5. `this.fcmForward(...)` on the outbound `ChatMessage` dispatch.
6. `this.fcmEvent(...)` in `ProcessUserEvent` + key probes in `chatEntryKeyUp`.

If any anchor is missing (e.g. Bethesda renamed something), the script exits with
`ERROR: Anchor N … not found` — fix the anchor and re-run.

> `fcm-inject.as` is the **source of truth** for the injected AS3 (the actual
> 900+ line patch, incl. the self-loader and INI defaults). `FCMChatPatch.as` is
> an older hand-annotated reference of the same additions (BLOCKS 1-9) kept for
> reading — `apply-patch.py` does **not** use it.

---

## Step 4 -- Recompile HUDMenu.swf with ffdec, patch version byte

```
ffdec -replace "<work>\interface\HUDMenu.swf" "<work>\HUDMenu.swf" HUDMenu "<work>\src\…\HUDMenu.as"
```

Scaleform in Fallout 76 requires **SWF version byte 32**. If ffdec writes a
different value, patch it:

```python
with open('HUDMenu.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
```

Verify: `python3 -c "print(open('HUDMenu.swf','rb').read(4)[3])"` → `32`.

---

## Step 5 -- Build FCMBridge.swf (the feed renderer)

The standalone HUDMenu self-loads `FCMBridge.swf`, so it must be built and packed
alongside it. From `game-mods/FCMBridge/`:

```bash
haxe --main FCMBridge --swf FCMBridge.swf --swf-version 32
python3 -c "
with open('FCMBridge.swf','r+b') as f:
    d=bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)"
```

Full FCMBridge build/iteration loop: **[../README.md](../README.md)** and
[docs/overlay/zfe/fcmbridge-data-pattern.md](../../../docs/overlay/zfe/fcmbridge-data-pattern.md).

---

## Step 6 -- Pack FCM-standalone.ba2

Stage **both** SWFs under `interface/`:

```
<stage>\
  interface\
    HUDMenu.swf      <- patched (Step 4)
    FCMBridge.swf    <- feed renderer (Step 5)
```

Create the BTDX/GNRL archive:

```
Archive2.exe <stage> -create=FCM-standalone.ba2 -root=<stage> -format=GNRL
```

(On Linux, any BA2 **GNRL v1** packer works — the archive is just the two files
above at `interface/…`, uncompressed, BTDX/GNRL.)

> `fcmchat.ini` is **NOT** packed and is not functionally loaded: GFx blocks file
> reads, so `fcm-inject.as`'s `fcmApplyIniDefaults()` hard-codes the position/size
> defaults at runtime. The `.ini` is kept in this folder for reference / future
> tooling only.

---

## Step 7 -- Register in Fallout76Custom.ini

```
%USERPROFILE%\Documents\My Games\Fallout 76\Fallout76Custom.ini
```

```ini
[Archive]
sResourceArchive2List = FCM-standalone.ba2
```

(Append with a comma if the line already exists.) Copy `FCM-standalone.ba2` to
`<FO76>\Data\`. No `sResourceDataDirsFinal` / `bInvalidateOlderFiles` loose-file
lines are needed — the standalone ships everything inside the one archive.

---

## Step 8 -- Configure ZFE for the live socket

Two-way chat requires ZFE's Text Chat bridge. Set these Windows User env vars
(then fully exit and relaunch Steam):

```powershell
[Environment]::SetEnvironmentVariable('ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND','1','User')
# Dev: local backend
[Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT','127.0.0.1:4001','User')
# Prod: the FCM TCP endpoint
# [Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT','dev-hud.falloutchatmod.com:4001','User')
```

The backend must have `HUD_PUSH_TCP_ENABLED=true`. See
[docs/realtime/hud-push.md](../../../docs/realtime/hud-push.md) and
[docs/overlay/zfe/realtime-socket.md](../../../docs/overlay/zfe/realtime-socket.md).

---

## Step 9 -- Smoke test

1. Launch the game. The FCMBridge feed panel should render community chat (the
   `zfe.log` shows `FCMBridge loaded` + socket `HELLO`/drain lines).
2. Press the chat key (default INSERT). The input box appears; WASD is suspended.
3. Type + ENTER → the backend logs a `SEND`; the message echoes into the feed
   within ~1 s.
4. ESC (or the chat key) closes input; movement resumes.

`zfe.log` (game root) confirms both directions: `selfload … FCMBridge.swf load
complete — re-scanning for bridge` (standalone load OK) and socket SEND/HELLO.

---

## Re-merging after a Bethesda patch

Every FO76 update that changes HUDMenu.swf requires a re-merge:

1. Extract the new vanilla HUDMenu.swf (Step 1) and decompile (Step 2).
2. Run `apply-patch.py` on the fresh `HUDMenu.as` (Step 3). The anchor asserts
   tell you immediately if Bethesda moved an injection point.
3. Recompile + repack (Steps 4-6).

`FCMBridge.swf` only needs rebuilding when `FCMBridge.hx` changes, not on a
Bethesda HUDMenu patch.

---

## File layout inside this folder

```
game-mods/FCMBridge/hudmenu-chat/
  apply-patch.py    -- the build tool (injects fcm-inject.as into HUDMenu.as)
  fcm-inject.as     -- the actual injected AS3 (input + self-loader + defaults)
  FCMChatPatch.as   -- older hand-annotated reference of the additions (not used by the build)
  fcmchat.ini       -- reference defaults only (NOT packed; GFx can't read it)
  BUILD.md          -- this guide
```
