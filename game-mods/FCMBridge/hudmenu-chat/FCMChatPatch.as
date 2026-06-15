// =============================================================================
// FCMChatPatch.as -- ActionScript 3 additions to vanilla HUDMenu.swf
//
// PURPOSE
//   These snippets implement two-way in-game chat for Fallout Chat Mod (M7).
//   They follow the exact mechanism documented in the Text Chat mod decompile
//   (textchat-blueprint.md).  Copy each block into the correct location inside
//   HUDMenu.as after decompiling the vanilla SWF with JPEXS/ffdec.
//
// AUTHORSHIP
//   This file contains ONLY our additions -- not Bethesda's HUDMenu source.
//   We re-use Bethesda's exported class name (HUDMenu) and method signatures
//   (ProcessUserEvent) because we ARE replacing that file; all other content
//   in HUDMenu.as is the decompiled vanilla code we do not reproduce here.
//
// BLUEPRINT REFERENCES
//   Sections cited below match textchat-blueprint.md section numbers.
//   e.g. "BP-2" = textchat-blueprint.md section 2.
// =============================================================================


// =============================================================================
// BLOCK 1 -- Class-level field declarations
//
//   ADD these fields to the HUDMenu class body alongside the existing fields.
//   They must be at class scope (not inside any function).
// =============================================================================

// --- FCM chat input state (BP-3, BP-4) ---
import flash.display.Shape;
import flash.events.KeyboardEvent;
import flash.events.FocusEvent;
import flash.text.TextField;
import flash.text.TextFieldType;
import flash.text.TextFormat;
import flash.ui.Keyboard;

// The INPUT TextField that receives keystrokes when chat is open.
var _fcmInputTf:TextField;

// True while chat mode is active (input focused, game input suspended).
var _fcmChatOpen:Boolean = false;

// The legacy __SFCodeObj reference (same bridge FCMBridge.hx discovers; BP-4).
// Populated in fcmInitSocket().
var _fcmSock:Object = null;

// Socket registration target: anonymous object (sealed class crashes -- BP-4).
var _fcmSockState:Object = null;

// Whether HELLO has been sent on this connection.
var _fcmHelloSent:Boolean = false;

// INI-configured open key name (default "INSERT").  Compared against the
// name param of ProcessUserEvent (BP-1).
var _fcmOpenChatKey:String = "INSERT";

// INI-configured channel id sent in SEND lines.
var _fcmChannelId:String = "";  // filled from fcmchat.ini [chat] defaultChannelId

// Character name and account name, read from BSUIDataManager (BP-5).
var _fcmAccountName:String  = "";
var _fcmCharacterName:String = "";


// =============================================================================
// BLOCK 2 -- fcmBuildInputField()
//
//   Call this once from the HUDMenu constructor (or frame-1 init) AFTER the
//   existing HUD chrome has been built.  Adds the input TextField to the
//   display list and wires keyboard/focus listeners.
//
//   (BP-3: listeners wired onto ChatEntryText_tf after load)
// =============================================================================

function fcmBuildInputField():void {
    // Input box geometry -- matches the FCMBridge panel chrome.
    // Adjust x/y/width to match your HUDMenu layout.
    var BOX_X:int    = 5;
    var BOX_Y:int    = 210;   // near bottom of the FCMBridge panel area
    var BOX_W:int    = 360;
    var BOX_H:int    = 26;

    // Subtle background so the field is visible against the HUD.
    var bg:Shape = new Shape();
    bg.graphics.beginFill(0x0C0A08, 0.92);
    bg.graphics.lineStyle(1, 0xF5CB5B, 0.6);
    bg.graphics.drawRect(BOX_X, BOX_Y, BOX_W, BOX_H);
    bg.graphics.endFill();
    bg.name = "_fcmInputBg";
    bg.visible = false;
    addChild(bg);

    _fcmInputTf = new TextField();
    _fcmInputTf.x = BOX_X + 6;
    _fcmInputTf.y = BOX_Y + 4;
    _fcmInputTf.width  = BOX_W - 12;
    _fcmInputTf.height = BOX_H - 6;
    _fcmInputTf.type         = TextFieldType.INPUT;
    _fcmInputTf.multiline    = false;
    _fcmInputTf.wordWrap     = false;
    _fcmInputTf.embedFonts   = true;
    _fcmInputTf.maxChars     = 300;   // Global/Trade/Event cap (BP-3)
    _fcmInputTf.visible      = false;
    _fcmInputTf.name         = "_fcmInputTf";

    var fmt:TextFormat = new TextFormat();
    fmt.font  = "$$MAIN_Font";
    fmt.size  = 14;
    fmt.color = 0xFAF4DA;
    _fcmInputTf.defaultTextFormat = fmt;

    // KEY_UP: ENTER -> send, ESC -> cancel (BP-3, chatEntryKeyUp ~1996)
    _fcmInputTf.addEventListener(KeyboardEvent.KEY_UP,   fcmKeyUp);
    // KEY_DOWN: future tab/history hooks (BP-3, chatEntryKeyDown ~2225)
    _fcmInputTf.addEventListener(KeyboardEvent.KEY_DOWN, fcmKeyDown);
    // FOCUS_OUT: safety net reset (BP-3, chatEntryFocusOut ~2460)
    _fcmInputTf.addEventListener(FocusEvent.FOCUS_OUT,   fcmFocusOut);

    addChild(_fcmInputTf);
}


// =============================================================================
// BLOCK 3 -- ProcessUserEvent(name:String, isDown:Boolean) addition
//
//   The engine calls this on the real HUDMenu for every mapped UI action.
//   Find the EXISTING ProcessUserEvent method in HUDMenu.as and INSERT the
//   fcmHandleUserEvent() call at the very TOP of that function body, before
//   any existing logic.
//
//   (BP-1: ProcessUserEvent INSERT hook, key-up when name == hotKey)
// =============================================================================

// >>> INSIDE EXISTING ProcessUserEvent(name:String, isDown:Boolean) <<<
// Insert as the first line of the function:
//
//   fcmHandleUserEvent(name, isDown);
//
// The function continues with its original Bethesda logic below that line.

function fcmHandleUserEvent(name:String, isDown:Boolean):void {
    // Only react on key-UP (same as Text Chat; BP-1 "Fires enterChatMode() on key-up")
    if (isDown) return;

    // Open on the configured hot key.
    if (name == _fcmOpenChatKey && !_fcmChatOpen) {
        fcmEnterChatMode();
        return;
    }

    // Emergency close via the INSERT key while already open.
    if (name == _fcmOpenChatKey && _fcmChatOpen) {
        fcmResetChatMode();
    }
}


// =============================================================================
// BLOCK 4 -- fcmEnterChatMode() / fcmResetChatMode()
//
//   The focus + game-input suppression pair (BP-2).
//   enterChatMode: stage.focus = input field + dispatch StartEditText.
//   resetChatMode: stage.focus = stage   + dispatch EndEditText + clear.
// =============================================================================

function fcmEnterChatMode():void {
    if (_fcmChatOpen) return;
    _fcmChatOpen = true;

    // Make the input field and its background visible.
    _fcmInputTf.visible = true;
    var bg:* = getChildByName("_fcmInputBg");
    if (bg) bg.visible = true;

    // Route keystrokes to the input field (BP-2).
    stage.focus = _fcmInputTf;

    // Suspend game input (WASD-safe) -- the key mechanism (BP-2, ~1935).
    BSUIDataManager.dispatchEvent(
        new CustomEvent("ControlMap::StartEditText", {tag:"Chat"})
    );

    // Read identity from BSUIDataManager on every open so name changes are
    // picked up automatically.  (BP-5; Phase 3 plan)
    fcmReadIdentity();

    // Ensure socket is alive and HELLO was sent.
    fcmEnsureConnected();
}

function fcmResetChatMode():void {
    if (!_fcmChatOpen) return;
    _fcmChatOpen = false;

    // Return focus to stage (BP-2, ~1945).
    stage.focus = stage;

    // Resume game input (BP-2, ~1945).
    BSUIDataManager.dispatchEvent(
        new CustomEvent("ControlMap::EndEditText", {tag:"Chat"})
    );

    // Clear the input field.
    if (_fcmInputTf) {
        _fcmInputTf.text    = "";
        _fcmInputTf.visible = false;
    }
    var bg:* = getChildByName("_fcmInputBg");
    if (bg) bg.visible = false;
}


// =============================================================================
// BLOCK 5 -- Keyboard listeners (BP-3)
// =============================================================================

function fcmKeyUp(e:KeyboardEvent):void {
    switch (e.keyCode) {
        case Keyboard.ENTER:
            var text:String = _fcmInputTf.text;
            if (text.length > 0) {
                fcmSendMessage(text);
            }
            fcmResetChatMode();
            break;

        case Keyboard.ESCAPE:
            fcmResetChatMode();
            break;
    }
}

function fcmKeyDown(e:KeyboardEvent):void {
    // Reserved for future: TAB = switch channel, UP/DOWN = scroll history.
    // Do NOT consume ENTER here (TEXT CHAT uses KEY_UP for send; BP-3).
}

function fcmFocusOut(e:FocusEvent):void {
    // Safety net: if focus leaves the field (alt-tab, menu open), close chat.
    // BP-3: chatEntryFocusOut ~2460
    if (_fcmChatOpen) {
        fcmResetChatMode();
    }
}


// =============================================================================
// BLOCK 6 -- fcmSendMessage(text:String)
//
//   Sanitizes text and writes a SEND line over __SFCodeObj (BP-4).
//   Wire format: "SEND~<channelId>~<text>\n" (FCMHUD/1 -- our protocol,
//   not Text Chat's brace-JSON; backend already speaks it).
// =============================================================================

function fcmSendMessage(text:String):void {
    if (_fcmSock == null) return;

    // Sanitize: strip tildes and newlines (mirrors backend zfeSafe; BP-4 note).
    var safe:String = text.split("~").join("").split("\n").join("").split("\r").join("");
    if (safe.length == 0) return;

    // Cap at maxChars for the channel (300 for General; BP-3).
    if (safe.length > 300) safe = safe.substr(0, 300);

    var line:String = "SEND~" + _fcmChannelId + "~" + safe + "\n";

    try {
        _fcmSock.call("writeUTFBytes", line);
    } catch (e:*) {
        // writeUTFBytes throws IOError on a dead socket (BP-4).
        _fcmHelloSent = false;
        fcmEnsureConnected();
    }
}


// =============================================================================
// BLOCK 7 -- Identity read from BSUIDataManager (BP-5)
//
//   Reads the isLocal player entry from FO76's data bus.
//   accountName  = stable Bethesda handle (identity key, never changes).
//   characterName = in-game display name (can change; reconciled on HELLO).
// =============================================================================

function fcmReadIdentity():void {
    try {
        // AccountInfoData is the same surface the Text Chat mod uses (BP-5, ~99).
        var info:* = BSUIDataManager.GetDataFromClient("AccountInfoData");
        if (info && info.data && info.data.account) {
            var acct:* = info.data.account;
            if (acct.name && String(acct.name).length > 0) {
                _fcmAccountName = String(acct.name);
            }
        }
    } catch (e:*) {}

    // Character name from the player list: entry where isLocal === true.
    try {
        var pl:* = BSUIDataManager.GetDataFromClient("PlayerListData");
        if (pl && pl.data) {
            var list:Array = pl.data as Array;
            for each (var entry:* in list) {
                if (entry.isLocal === true) {
                    if (entry.characterName && String(entry.characterName).length > 0) {
                        _fcmCharacterName = String(entry.characterName);
                    }
                    break;
                }
            }
        }
    } catch (e:*) {}
}


// =============================================================================
// BLOCK 8 -- Socket management: fcmInitSocket() + fcmEnsureConnected()
//
//   Discovers the legacy __SFCodeObj bridge (same walk as FCMBridge.hx),
//   registers an anonymous socket object, and calls connect().
//   HELLO line is sent once per connection immediately after connect.
//   (BP-4; FCMBridge.hx findLegacyBridge / socketConnect logic)
// =============================================================================

function fcmInitSocket():void {
    // Walk the parent chain looking for a legacy __SFCodeObj.
    // The legacy bridge returns plain Boolean false from call("__zfe_probe");
    // modern decoys return a string containing "unsupported_command".
    var found:Object = null;
    var node:* = this;
    for (var d:int = 0; d < 12 && node != null; d++) {
        var candidate:* = fcmGetSFCodeObj(node);
        if (candidate != null && fcmIsLegacyBridge(candidate)) {
            found = candidate;
            break;
        }
        try { node = node.parent; } catch (e:*) { break; }
    }

    // Also scan stage children (FCMBridge.hx does the same as a fallback).
    if (found == null) {
        try {
            var n:int = stage.numChildren;
            for (var i:int = 0; i < n && found == null; i++) {
                var child:* = stage.getChildAt(i);
                var c:* = fcmGetSFCodeObj(child);
                if (c != null && fcmIsLegacyBridge(c)) { found = c; break; }
                var m:int = 0;
                try { m = child.numChildren; } catch (e2:*) {}
                for (var j:int = 0; j < m; j++) {
                    try {
                        var gc:* = child.getChildAt(j);
                        var c2:* = fcmGetSFCodeObj(gc);
                        if (c2 != null && fcmIsLegacyBridge(c2)) { found = c2; break; }
                    } catch (e3:*) {}
                }
            }
        } catch (e:*) {}
    }

    if (found == null) return; // ZFE not present; no socket

    _fcmSock = found;

    // Register: anonymous object ONLY (sealed class -> ReferenceError #1056; FCMBridge.hx ln 262)
    _fcmSockState = {connected: false, bytesAvailable: 0};
    try {
        _fcmSock.call("register", _fcmSockState);
    } catch (e:*) {
        _fcmSock = null;
        return;
    }
}

function fcmEnsureConnected():void {
    if (_fcmSock == null) fcmInitSocket();
    if (_fcmSock == null) return;

    var connected:Boolean = false;
    try { connected = (_fcmSockState.connected === true); } catch (e:*) {}

    if (!connected) {
        _fcmHelloSent = false;
        try {
            _fcmSock.call("connect");
        } catch (e:*) {}
        // HELLO will be sent on next tick once connected flag is true.
        // A 100 ms poll (fcmCheckConnection) handles that.
        fcmStartConnectionPoller();
        return;
    }

    fcmMaybeSendHello();
}

// Light one-shot timer to send HELLO once connected flag flips.
var _fcmConnTimer:Timer = null;
function fcmStartConnectionPoller():void {
    if (_fcmConnTimer != null) return;
    _fcmConnTimer = new Timer(100, 0);  // repeating 100 ms
    _fcmConnTimer.addEventListener(TimerEvent.TIMER, function(ev:TimerEvent):void {
        var connected:Boolean = false;
        try { connected = (_fcmSockState.connected === true); } catch (e:*) {}
        if (connected) {
            fcmMaybeSendHello();
            _fcmConnTimer.stop();
            _fcmConnTimer = null;
        }
    });
    _fcmConnTimer.start();
}

function fcmMaybeSendHello():void {
    if (_fcmHelloSent) return;
    if (_fcmAccountName.length == 0) fcmReadIdentity();
    if (_fcmAccountName.length == 0) return; // identity not available yet

    var line:String = "HELLO~" + _fcmAccountName + "~" + _fcmCharacterName + "\n";
    try {
        _fcmSock.call("writeUTFBytes", line);
        _fcmHelloSent = true;
    } catch (e:*) {}
}

// Utility: get __SFCodeObj from a display object
function fcmGetSFCodeObj(node:*):* {
    try {
        var v:* = node["__SFCodeObj"];
        if (v != null) return v;
    } catch (e:*) {}
    return null;
}

// Utility: discriminate legacy bridge from modern decoy (mirrors FCMBridge.hx isLegacyBridge)
function fcmIsLegacyBridge(obj:*):Boolean {
    var callFn:* = null;
    try { callFn = obj["call"]; } catch (e:*) {}
    if (callFn == null || typeof callFn != "function") return false;
    try {
        var ret:* = obj.call("__zfe_probe");
        if (ret == null) return false;
        if (typeof ret == "boolean") return ret === false;
        var rs:String = String(ret);
        if (rs.indexOf("unsupported_command") >= 0) return false;
        return true;
    } catch (e:*) {}
    return false;
}


// =============================================================================
// BLOCK 9 -- INI config loader (optional / Phase 2 polish)
//
//   Text Chat loads chatmod.ini via URLLoader from "../configuration/chatmod.ini"
//   relative to the SWF (BP-7).  Our equivalent is fcmchat.ini.
//   For a minimal v1 slice this can be skipped -- hard-code _fcmOpenChatKey
//   and _fcmChannelId in fcmBuildInputField() instead.
//
//   If you want INI loading, add this URLLoader block to the constructor
//   (or frame-1 init) BEFORE fcmBuildInputField():
// =============================================================================

/*
import flash.net.URLLoader;
import flash.net.URLRequest;
import flash.events.Event;
import flash.events.IOErrorEvent;

var _fcmIniLoader:URLLoader = new URLLoader();
_fcmIniLoader.addEventListener(Event.COMPLETE,          fcmIniLoaded);
_fcmIniLoader.addEventListener(IOErrorEvent.IO_ERROR,   fcmIniError);
// Path is relative to the SWF in Data/interface/; config lives in Data/configuration/
_fcmIniLoader.load(new URLRequest("../configuration/fcmchat.ini"));

function fcmIniLoaded(e:Event):void {
    var raw:String = String(_fcmIniLoader.data);
    var lines:Array = raw.split("\n");
    for each (var line:String in lines) {
        line = StringUtils.trim(line);
        if (line.length == 0 || line.charAt(0) == ";") continue;
        var eq:int = line.indexOf("=");
        if (eq < 0) continue;
        var key:String   = StringUtils.trim(line.substr(0, eq)).toLowerCase();
        var value:String = StringUtils.trim(line.substr(eq + 1));
        switch (key) {
            case "openchatkey":    _fcmOpenChatKey = value; break;
            case "defaultchannelid": _fcmChannelId = value; break;
        }
    }
    fcmBuildInputField();
}

function fcmIniError(e:IOErrorEvent):void {
    // Fall back to built-in defaults and proceed.
    fcmBuildInputField();
}
*/


// =============================================================================
// WIRING SUMMARY
//
//   In HUDMenu's constructor (or frame-1 init), after existing init code, add:
//
//     fcmBuildInputField();   // or wrap in INI loader as shown in BLOCK 9
//     fcmInitSocket();
//
//   In the EXISTING ProcessUserEvent method, insert as the first line:
//
//     fcmHandleUserEvent(name, isDown);
//
//   That is the complete set of changes.  All other code in HUDMenu.as is
//   Bethesda's vanilla logic and must not be reproduced in this repo.
// =============================================================================
