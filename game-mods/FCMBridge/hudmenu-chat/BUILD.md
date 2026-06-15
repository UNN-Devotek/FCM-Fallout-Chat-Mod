# FCMChat.ba2 -- Build and Packaging Guide

This guide walks through extracting the vanilla HUDMenu.swf, applying the
FCMChatPatch.as additions, recompiling, and packaging everything into a
single FCMChat.ba2 that users install with one ini-line.

DO NOT redistribute Bethesda's decompiled HUDMenu source.  Only our
additions (FCMChatPatch.as) belong in this repo.

---

## Prerequisites

| Tool | Where to get |
|------|-------------|
| Bethesda Archive Extractor (BAE) or Archive2 | Nexus Mods -- "Bethesda Archive Extractor" |
| JPEXS Free Flash Decompiler (ffdec) 21+ | github.com/jindrapetrik/jpexs-decompiler |
| JRE 11+ (required by ffdec) | adoptium.net |
| Adobe Animate 2019+ OR Apache Flex SDK 4.16+ | For recompiling the patched AS3 |
| Archive2.exe (ships with CK for Fallout 76) | Bethesda Creation Kit |
| Python 3 | python.org (only needed if patching the SWF version byte) |

---

## Step 1 -- Extract vanilla HUDMenu.swf

Fallout 76 stores its UI SWFs inside `SeventySix - Interface.ba2`.

```
<FO76 game dir>\Data\SeventySix - Interface.ba2
```

Extract using BAE (GUI) or Archive2 (CLI):

```
Archive2.exe "C:\...\Data\SeventySix - Interface.ba2" -extract="interface\HUDMenu.swf" -outdir="C:\fcmchat-work"
```

Result: `C:\fcmchat-work\interface\HUDMenu.swf`

**Always extract from the current live game files.**  Every Bethesda patch may
change HUDMenu.swf, so this merge base must be fresh.  Using a stale copy
(e.g., the one inside the original Text Chat mod) will break on the next
game update.

---

## Step 2 -- Decompile with JPEXS/ffdec

1. Open ffdec.
2. File > Open > select `HUDMenu.swf`.
3. In the Scripts tree, expand to `DefineSprite > HUDMenu.as` (the main class).
4. Right-click the HUDMenu package > Export selected > ActionScript 3 source.
5. Choose an output directory, e.g. `C:\fcmchat-work\src\`.

ffdec will write one `.as` file per class.  The main file is:
```
C:\fcmchat-work\src\HUDMenu.as
```

---

## Step 3 -- Apply the FCMChatPatch.as additions

Open `HUDMenu.as` in your editor.  You need to make five targeted changes.
All blocks are documented with comments in `FCMChatPatch.as` -- read that
file alongside this guide.

### 3a. Add import statements

At the top of `HUDMenu.as`, after the existing `import` lines, add:

```actionscript
import flash.display.Shape;
import flash.events.KeyboardEvent;
import flash.events.FocusEvent;
import flash.text.TextField;
import flash.text.TextFieldType;
import flash.text.TextFormat;
import flash.ui.Keyboard;
import flash.utils.Timer;
import flash.events.TimerEvent;
```

(Skip any imports that are already present.)

### 3b. Add class-level field declarations (FCMChatPatch.as BLOCK 1)

Inside the `HUDMenu` class body, after the last existing field declaration,
paste the entire BLOCK 1 section from FCMChatPatch.as.

### 3c. Add all FCM methods (FCMChatPatch.as BLOCKS 2-8)

Paste BLOCKS 2-8 as new methods inside the `HUDMenu` class, after the
existing methods.  Each block is a self-contained function -- order does not
matter as long as they are all inside the class braces.

### 3d. Wire up in the constructor

Find the HUDMenu constructor function.  At the end of the constructor body
(after existing init code), add:

```actionscript
fcmInitSocket();
fcmBuildInputField();
```

For INI-driven configuration instead of hard-coded defaults, use the URLLoader
pattern shown in BLOCK 9 of FCMChatPatch.as -- it calls fcmBuildInputField()
in the load-complete callback.

### 3e. Hook ProcessUserEvent

Find the existing `ProcessUserEvent(name:String, isDown:Boolean)` method.
Insert this as the very FIRST line of that function body:

```actionscript
fcmHandleUserEvent(name, isDown);
```

The rest of the method's original logic follows unchanged.

---

## Step 4 -- Recompile HUDMenu.swf

Use Adobe Animate (File > Publish) or the Apache Flex/AIR SDK mxmlc:

```
mxmlc -source-path C:\fcmchat-work\src -output C:\fcmchat-work\HUDMenu.swf C:\fcmchat-work\src\HUDMenu.as
```

Or re-import the modified AS3 back into ffdec (Script > Import > AS3 source)
and use ffdec's built-in recompiler.

### SWF version byte check

Scaleform in Fallout 76 requires SWF version byte 32.  If your compiler writes
a different value, patch it:

```python
# Run from C:\fcmchat-work\
with open('HUDMenu.swf','r+b') as f:
    d = bytearray(f.read()); d[3]=32; f.seek(0); f.write(d)
```

Verify: `python -c "f=open('HUDMenu.swf','rb'); d=f.read(4); print(d[3])"`
Should print `32`.

---

## Step 5 -- Pack FCMChat.ba2

Assemble the archive contents in a staging folder:

```
C:\fcmchat-stage\
  interface\
    HUDMenu.swf          <- the recompiled patched SWF (Step 4)
  configuration\
    fcmchat.ini          <- the default config (from this folder)
```

Create the BTDX/GNRL archive with Archive2:

```
Archive2.exe C:\fcmchat-stage -create=FCMChat.ba2 -root=C:\fcmchat-stage -format=GNRL
```

This produces `FCMChat.ba2` in the current directory.

---

## Step 6 -- Register the archive in Fallout76Custom.ini

The user's custom ini lives at:
```
%USERPROFILE%\Documents\My Games\Fallout 76\Fallout76Custom.ini
```

Under the `[Archive]` section, append `FCMChat.ba2` to `sResourceArchive2List`:

```ini
[Archive]
sResourceArchive2List = FCMChat.ba2
```

If `sResourceArchive2List` already exists, append with a comma:

```ini
sResourceArchive2List = SomeOtherMod.ba2, FCMChat.ba2
```

Copy `FCMChat.ba2` to the game's `Data\` folder:
```
C:\...\SteamLibrary\steamapps\common\Fallout76\Data\FCMChat.ba2
```

---

## Step 7 -- Configure ZFE for the live socket

Two-way chat requires ZFE's Text Chat bridge.  Set these Windows User env
vars (then fully exit and relaunch Steam):

```powershell
[Environment]::SetEnvironmentVariable('ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND','1','User')
# Dev: point at local backend
[Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT','127.0.0.1:4001','User')
# Prod: use the FCM TCP endpoint
# [Environment]::SetEnvironmentVariable('ZFE_TEXT_CHAT_ENDPOINT','tcp.falloutchatmod.com:4001','User')
```

The backend must have `HUD_PUSH_TCP_ENABLED=true` (and `NODE_ENV` != `production`
while still behind the dev-only guard -- see docs/realtime/hud-push.md).

---

## Step 8 -- Smoke test

1. Launch the game.
2. Press INSERT.  The input box should appear at the bottom of the FCM widget.
   The player character should NOT move (WASD suspended).
3. Type a message and press ENTER.
   - The backend log should show a SEND line processed.
   - The message should appear in the chat feed within ~1 second (echo-back).
4. Press ESC (or INSERT again).  Input box should disappear; movement resumes.

Check `zfe.log` (in the game root) for FCMBridge socket lines confirming
HELLO was sent and the connection is alive.

---

## Re-merging after a Bethesda patch

Every Fallout 76 update that changes HUDMenu.swf requires a re-merge:

1. Extract the new vanilla HUDMenu.swf (Step 1).
2. Decompile both the new vanilla SWF and the previous patched SWF.
3. Diff the two vanilla versions to see what Bethesda changed.
4. Re-apply only our additions (FCMChatPatch.as blocks) onto the new base.
5. Recompile and repack (Steps 4-5).

This is the same maintenance burden as the original Text Chat mod.  There is
no way around it with Path A (HUDMenu replacement) -- it is the trade-off
for having ProcessUserEvent input delivery.

---

## File layout inside this folder

```
game-mods/FCMBridge/hudmenu-chat/
  FCMChatPatch.as   -- AS3 source additions (BLOCKS 1-9, commented)
  fcmchat.ini       -- default config file (packed into ba2 at Data/configuration/)
  BUILD.md          -- this guide
```
