import flash.display.MovieClip;
import flash.display.Shape;
import flash.events.Event;
import flash.events.TimerEvent;
import flash.utils.Timer;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.net.URLLoader;
import flash.net.URLRequest;
import flash.events.IOErrorEvent;

private typedef ChatRecord = {
    var color:String;
    var channel:String;
    var user:String;
    var tag:String;
    var supporterStar:Bool;
    var starColor:String;
    var body:String;
    var messageId:String;
    var senderUserId:String;
}

private typedef ModerationTargetResolution = {
    var target:Null<ChatRecord>;
    var ambiguous:Bool;
}

/**
 * FCMChatWidget — HUDModLoader widget for Fallout Chat Mod.
 *
 * Transport: ZFE chat.v1 native API (ZFE 0.9.8+).
 *   __ZFE.call("chat.v1.connect",    payload)   — register + connect
 *   __ZFE.call("chat.v1.pollEvents", payload)   — cursor-based event poll
 *   __ZFE.call("chat.v1.sendMessage",payload)   — send a message
 *   __ZFE.call("chat.v1.getAuthState","{}") — connection/auth health
 *
 * Font: GFx engine-registered HUDModLoader aliases — NO embed.
 *   `$MAIN_Font_Light` (body) and `$MAIN_Font_Bold` (bold/headers/tab labels) are
 *   font aliases registered by HUDModLoader at the GFx engine level (see HUDTools.as
 *   entry_tf / HUDButton.as label TextFields). Unlike HUDMenu.swf's per-movie symbol
 *   `$$MAIN_Font` (NOT resolvable in a child widget SWF), and unlike a Flash-@:font
 *   embedded TTF (GFx IGNORES child-SWF embedded TTFs — this is why the v2.3.0
 *   DejaVuSans embed still rendered tofu), these aliases DO resolve inside any child
 *   widget SWF loaded into ApplicationDomain.currentDomain — proven by HUDButton /
 *   HUDTools / HUDKeyboard, which render with them. embedFonts=true is kept on every
 *   TextField (the HUDTools entry_tf precedent); the aliases resolve fine with it.
 *   FONT_BODY is also passed to FormatTextEdit (matches HUDTools' entry_tf default).
 *
 * Input path (v2.5.3): DECODED native chat-input API. The verbs are TOP-LEVEL ZFE
 *   commands that take BARE-VALUE payloads (not JSON) and return bare booleans/strings:
 *     setChatInputActive payload "true" -> true (ACTIVATES); "false" deactivates.
 *       (JSON {} / {"active":true} return false / do nothing — use bare "true"/"false".)
 *     consumeChatInputSubmitted -> bare BOOLEAN (true = Enter pressed since last check);
 *       the MESSAGE TEXT comes from readChatInput, NOT from the consume result.
 *     readChatInput -> the in-progress text buffer (bare string).
 *     isChatInputActive -> true/false ; isChatKeyPressed -> true when OpenChatKey
 *       (INSERT by default) pressed ; clearChatInput -> true.
 *   nativeTruthy(raw): trimmed/lowercased == "true" OR == "1" OR contains "success":true.
 *   FLOW (openInputNative): setChatInputActive("true") -> _inputTimer (~100 ms)
 *     pollNativeInput(): readChatInput (show in-progress) ; if consume truthy => SUBMIT
 *       (final text = readChatInput, run through shared handleSubmittedText -> direct
 *       chat.v1.sendMessage, log full raw) ; else if !isChatInputActive => cancel (Esc).
 *     closeInputNative(): clearChatInput + setChatInputActive("false").
 *   OPEN triggers: HUDMod::UserEvent open key, AND a low-rate (~150 ms) pollOpenKey()
 *     that opens on an isChatKeyPressed false->true edge (so the configured key opens chat).
 *   HUDModLoader menu: the F11 HUDMod::UserEvent explicitly calls SharedHUDTools.ShowMenu();
 *     RegisterMenu() only registers FCM's entries and does not open the menu by itself.
 *   Native input is tried only when a user opens the editor. The first activation is
 *     immediately cleared and verified because some Windows/ZFE builds expose the bare
 *     activation payload as literal text. If activation, cleanup, or the engine edit lock
 *     fails, this session permanently falls back to SharedHUDTools. NEVER run both.
 *     sendMessage stays chat.v1.sendMessage ONLY.
 *
 * Input path (FALLBACK): SharedHUDTools.FormatTextEdit + FormatOnScreenKeyboard + TextEdit.
 *   HUDModLoader's HUDTools handles StartEditText/EndEditText and gamepad OSK.
 *   ALL THREE must be called in order:
 *     1. FormatTextEdit(x,y,w,h,font,size,hexColor,bgHexColor,bgAlpha)
 *     2. FormatOnScreenKeyboard(oskX,oskY) — REQUIRED even on KB/mouse
 *     3. TextEdit(callback, startText)
 *   Without FormatOnScreenKeyboard, HUDTools sends ERROR|TXT → callback(null)
 *   immediately (the v2.0.3 "immediately released" bug).
 *
 * ZFE API discovery: widget runs in HUDModLoader's ApplicationDomain (shared with
 * HUDMenu). ZFE attaches __ZFE to the HUDMenu top-level frame — findZfeApi()
 * walks parent/root/stage to find it.
 *
 * Channel slugs (AllowedChannels in Data/ZFE/TextChat/fragments/FCMChatWidget.ini):
 *   global, trade, events, infests, raids, server
 * DefaultChannel: global
 *
 * Server-room membership (EULA §4(F)-safe — HUD UI data only, no memory reads):
 * the widget sends an observed roster from BSUIDataManager on the reserved
 * "server" channel. The authenticated relay derives a shared ephemeral room
 * from that roster. Legacy worldId data is only a best-effort fallback.
 *
 * Auth state:
 *   "authenticated" — player may send.
 *   "limited"       — account not yet linked; receive only; pinned link-code notice shown.
 *
 * Link gate (_needsLink) — STICKY across reconnects (v2.9.7):
 *   The relay pushes the link-code notice as a ONE-SHOT frame on register/hello/subscribe
 *   (relayHandler.pushLinkNotice) — it is not replayable, so a notice missed on a reconnect
 *   is gone for good. v2.9.6 and earlier cleared _needsLink on every (re)connect and waited
 *   for a fresh notice to re-raise it; when none arrived the widget silently fell through to
 *   the chat feed and the player could never reach the link screen again without deleting
 *   Data/ZFE/chat-auth.bin. The gate now persists until something PROVES the account is
 *   linked — a "LINK COMPLETE" notice or a successful send — and a pinned code older than
 *   LINK_CODE_REFRESH_MS forces a reconnect so the relay issues a fresh one.
 *
 * SWF CRASH HARD RULES (violations crashed the game in production):
 *   1. NO GlowFilter / DropShadow or any .filters assignment on MovieClip/Sprite.
 *   2. NO raw HTML entities (&amp; etc.) in htmlText — use numeric refs only.
 *   3. Live content is zfeSafe()d server-side; renderRecords() trusts that.
 *   4. Debug text: tf.text (plain), NEVER tf.htmlText.
 *   5. Extensions.enabled = true before ANY scaleform.gfx.* call.
 *   6. embedFonts = true + a real embedded/known font; text goes blank otherwise.
 *   7. No fl.motion.*, shaders, gradient masks, networking classes.
 *   8. No TextField update per-frame; event-driven only.
 *   9. NO getChildAt/numChildren on arbitrary native Scaleform objects (VM crash).
 *  10. NO hard casts (MovieClip(...)) — dynamic untyped access only in findZfeApi.
 *
 * Docs:
 *   docs/overlay/zfe/native-chat-relay/protocol-spec.md  — chat.v1 call surface
 *   docs/overlay/zfe/native-chat-relay/fcm-integration.md — FCM relay adapter + worldId
 *   docs/overlay/zfe/scaleform-ui-guide.md §3,§9 — font embedding, HUDModLoader API
 *   docs/overlay/zfe/textchat-blueprint.md  — Text Chat mod decompile reference
 */

class FCMChatWidget extends MovieClip {

    // ── Widget identity ────────────────────────────────────────────────────────
    static inline var VENDOR:String   = "FCMChatWidget";
    // 2.10.0 is the first build that reports clientVersion to the relay. The relay
    // treats "no version reported" as "oldest possible client" and gates any new wire
    // field on this, so the version bump IS the capability signal.
    static inline var VERSION:String  = "2.10.28"; // tag-only HUD feed + compact spacing
    static inline var SETTINGS_PATH:String = "settings.ini";
    // Expose for HUDModLoader hot-reload
    public var isReloadable:Bool      = true;

    // ── Font aliases — HUDModLoader engine-registered GFx fonts (NO embed) ────
    // These are GFx aliases registered by HUDModLoader (HUDTools.as entry_tf uses
    // "$MAIN_Font_Light"; HUDButton.as label TextFields use "$MAIN_Font_Bold").
    // They resolve in child widget SWFs (ApplicationDomain.currentDomain) with
    // embedFonts=true — no @:font embed needed (GFx ignores child-SWF embedded TTFs).
    static inline var FONT_BODY:String = "$MAIN_Font_Light";  // body / feed / messages / prompts / notices
    static inline var FONT_BOLD:String = "$MAIN_Font_Bold";   // tab labels / headers / sender names / active-tab
    // FALLBACK (do NOT ship unless aliases tofu in-game): re-add the @:font embed and
    // set TextFormat.font / the FormatTextEdit font arg to the TTF's DefineFont FAMILY
    // name "DejaVu Sans" (with the space) — NOT the postscript "DejaVuSans". GFx matches
    // the DefineFont family name; the v2.3.0 build used the postscript name, which is the
    // only reason its embed also rendered tofu as a fallback.

    // ── chat.v1 poll / connect timing ─────────────────────────────────────────
    // Event-poll interval moved to FcmConfig.pollMs (tunable via FCMChat.ini `pollMs`,
    // default 5000) — each poll is a fresh wss/TLS handshake under Wine, so the rate is the
    // game-lag knob. See FcmConfig.pollMs.
    // A successful send schedules one additional next-tick poll so the sender does not wait for
    // the next background interval to receive the authoritative cosmetics-bearing echo.
    static inline var SEND_ECHO_POLL_DELAY_MS:Int = 1;
    static inline var CONNECT_RETRY_MS:Int = 3000;
    static inline var CONNECT_MAX_MS:Int   = 30000;
    // worldId re-read interval (ms)
    static inline var WORLD_POLL_MS:Int    = 5000;
    // Link codes expire 10 min after the relay issues them (pushLinkNotice: "expires 10m").
    // Refresh a minute early so the code on screen is always redeemable.
    static inline var LINK_CODE_REFRESH_MS:Float = 540000;

    // ── Chat UX ───────────────────────────────────────────────────────────────
    // ring-buffer cap + send-length cap now live in FcmConfig (_cfg.maxMessages/maxSendLen)

    // ── Channel tables ────────────────────────────────────────────────────────
    // Slugs match AllowedChannels in Data/ZFE/TextChat/fragments/FCMChatWidget.ini.
    // "server" (index 5) is the world-session channel — not directly selectable.
    static var CHAN_SLUGS:Array<String> = ["global", "trade", "events", "infests", "raids", "server"];
    static var CHAN_NAMES:Array<String> = ["GENERAL", "TRADING", "EVENTS", "INFESTS", "RAIDS", "SERVER"];

    // ── Layout (row heights fixed; user-config deferred to v2 per spec D-04) ───
    // Row order from top: TAB_H (main tab) | SUB_H (channel tabs) | log | INPUT_H
    static inline var INPUT_H:Int           = 28;
    // Keep the feed's clipped bottom clear of the top-level HUDTools entry field.
    static inline var LOG_INPUT_GAP:Int     = 4;
    static inline var TAB_H:Int             = 22;
    static inline var SUB_H:Int             = 20;

    // Colors / geometry / limits / keybinds now live in FcmConfig (`_cfg`), parsed
    // from Data/FCMChat.ini. Derive "#RRGGBB" / "RRGGBB" strings from the Int colors
    // via hx() / nh(). Defaults in FcmConfig reproduce the amber Pip-Boy theme.

    // ── Authenticated relay control messages ───────────────────────────────────
    // The relay authenticates every frame with the ZFE-held relay token. Do NOT put
    // a shared secret in this distributable SWF: it cannot authenticate a client
    // and creates a production configuration foot-gun. These printable controls are
    // bounded, untrusted HUD metadata and are consumed by the authenticated relay.
    // ZFE's chat bridge treats leading NUL/control bytes as an empty message, and the
    // NUL-delimited legacy framing introduced in v2.9.4 corrupted every string crossing
    // the ZFE boundary on native Windows (v2.9.5 shipped NUL-bearing string constants;
    // logs rendered as "Bu0000Uu0000Iu0000..."). The relay accepts BOTH frames, so the
    // printable form is the safe one — keep control bytes out of this SWF entirely.
    // Control bytes are built at RUNTIME and never appear as string literals. A NUL-bearing
    // string constant anywhere in this SWF poisons EVERY string crossing the ZFE boundary on
    // native Windows — each character comes out NUL-padded. v2.9.6 removed the NUL control
    // prefixes but left "\x00"/"\x1F" literals in jsonEscape/fcmClean/bareName, so the poison
    // survived: the relay received the channel slug as "g\0l\0o\0b\0a\0l", failed its
    // ALL_SLUGS check and rejected every send with invalid_channel, and the world/roster
    // controls (slug "server") never matched either — so SERVER chat could never bind.
    // Observed 2026-08-05: fo76_name stored on the relay as 337 chars of NUL-escaped garbage.
    // These MUST go through the non-inline ctrlChar() below: a direct
    // `String.fromCharCode(0)` is constant-folded by Haxe straight back into a NUL literal
    // (verified — the compiled SWF then contains no `fromCharCode` at all). Routing the
    // codepoint through a function parameter is what actually keeps the byte out of the
    // string pool. Do not "simplify" this, and do not mark it `inline`.
    static var NUL:String      = ctrlChar(0);
    static var UNIT_SEP:String = ctrlChar(31);

    static function ctrlChar(code:Int):String {
        return String.fromCharCode(code);
    }

    /**
     * Replace `needle` with `rep`, but NEVER split on an empty needle.
     *
     * THE BUG THIS EXISTS FOR (root cause of "That channel is not available", 2026-08-06):
     * Scaleform GFx returns "" from String.fromCharCode(0), and a NUL escape literal in the SWF
     * string pool collapses to "" as well. `"test".split("").join("\\u0000")` does not strip
     * anything — it EXPLODES the string, inserting the escape between every character. That is
     * how a clean slug became `g\\0l\\0o\\0b\\0a\\0l` on the wire and how a clean
     * body became `t\\0e\\0s\\0t`, with ZFE then correctly rejecting the malformed
     * channel as `invalid_channel`. It also explains the log mangling seen since 2026-07-20.
     * Every split on a control-byte constant MUST go through here.
     */
    static function replaceIfPresent(s:String, needle:String, rep:String):String {
        if (s == null) return "";
        if (needle == null || needle.length == 0) return s;
        // A control-character needle is ALSO unusable: GFx's split() is C-string based, so a NUL
        // separator reads as an empty one and explodes the string exactly as "" does. The length
        // guard above cannot see that. Confirmed in-game 2026-08-07 — v2.9.11 added the length
        // guard and the payload came back byte-identical. Use stripControlChars() instead.
        if (needle.charCodeAt(0) < 32) return s;
        return s.split(needle).join(rep);
    }

    /**
     * Remove control characters WITHOUT calling split() — the only way to strip a NUL on GFx.
     * Keeps CR/LF/TAB so jsonEscape can still escape them properly.
     */
    static function stripControlChars(s:String):String {
        if (s == null) return "";
        var out:StringBuf = new StringBuf();
        for (i in 0...s.length) {
            var c:Null<Int> = s.charCodeAt(i);
            if (c == null) continue;
            if (c >= 32 || c == 9 || c == 10 || c == 13) out.add(s.charAt(i));
        }
        return out.toString();
    }

    static inline var WORLD_CTRL_PREFIX:String  = "FCMCTL/1/WORLD:";
    // LEAVE control: sent when the player leaves a world (worldId cleared).
    static inline var WORLD_LEAVE_PREFIX:String = "FCMCTL/1/LEAVE";
    // ROSTER control: observed nearby character names (no worldId exists in the UI
    // layer — the relay derives world rooms from sightings). Body is the bounded
    // pipe-separated name list; actor identity comes only from the authenticated frame.
    static inline var WORLD_ROSTER_PREFIX:String = "FCMCTL/1/ROSTER:";
    // Replays static history after a HUD reload. Server history stays deferred until
    // the next authenticated roster/world bind confirms the new room.
    static inline var HISTORY_RESYNC_PREFIX:String = "FCMCTL/1/RESYNC";
    static inline var ROSTER_FRESH_MS:Float = 60000;   // observation freshness window
    static inline var ROSTER_SEND_MS:Float  = 30000;   // periodic roster resend

    // ── Config (FcmConfig — parsed from Data/FCMChat.ini; see FcmConfig.hx) ─────
    var _cfg:FcmConfig = new FcmConfig();

    // Hex-string helpers for htmlText / setColors / FormatTextEdit (derive from _cfg Ints).
    static inline function hx(c:Int):String { return "#" + StringTools.hex(c, 6); }
    static inline function nh(c:Int):String { return StringTools.hex(c, 6); }

    // ── Display objects ───────────────────────────────────────────────────────
    var _bg:Shape;
    var _logTf:TextField;
    var _tabTf:TextField;
    var _subTf:TextField;
    var _promptTf:TextField;
    var _fmt:TextFormat;
    // ── Chat render state ─────────────────────────────────────────────────────
    var _records:Array<ChatRecord> = [];
    var _seenMessageIds:Map<String,Bool> = new Map();
    var _seenMessageOrder:Array<String> = [];
    var _bScrolling:Bool         = false;
    var _scrollSnapTimer:Timer   = null;   // deferred bottom-snap after htmlText relayout
    var _newWhileScrolled:Int    = 0;

    // ── Channel state ─────────────────────────────────────────────────────────
    var _chanIdx:Int             = 0;   // 0=global

    // ── Hide state (CAP-011) ────────────────────────────────────────────────────
    var _hidden:Bool             = false;   // true while the panel is hidden (/hide, F11 menu, hideKey)
    // Auto-hide: hide after _cfg.autoHideSec of no activity; reveal on a new message. F11-menu toggleable.
    var _autoHideOn:Bool         = false;
    var _autoHideTimer:Timer     = null;
    var _themeIdx:Int            = 0;       // F11 Customize → cycle color theme

    // ── chat.v1 session state ─────────────────────────────────────────────────
    var _api:Dynamic             = null;
    var _connected:Bool          = false;
    var _userId:String           = "";
    var _relayUserId:String      = "";
    var _displayName:String      = "Wanderer";
    // True only after AccountInfoData supplies the public Fallout/Bethesda account handle.
    // CharacterInfoData is the local character name and must never set this flag.
    var _falloutIdentityReady:Bool = false;
    var _connectDelay:Int        = CONNECT_RETRY_MS;
    var _connectAttempts:Int     = 0;
    var _cursor:Int              = 0;
    var _consecutivePollFailures:Int = 0;
    var _pollTimer:Timer         = null;
    var _sendEchoPollTimer:flash.utils.Timer = null;
    var _connectTimer:Timer      = null;
    var _worldTimer:Timer        = null;
    var _lastWorldId:String      = "";
    // Observation and relay membership are deliberately separate. Nearby-player HUD data only
    // means a server-room bind *can* be requested; SERVER becomes selectable only after the
    // relay acknowledges that request.
    var _inWorld:Bool            = false;
    var _serverSessionReady:Bool = false;
    var _serverSessionError:String = "";

    // ── ZFE search retry ──────────────────────────────────────────────────────
    var _zfeSearchTimer:Timer    = null;
    var _zfeSearchTries:Int      = 0;
    static inline var ZFE_SEARCH_MS:Int    = 1000;
    static inline var ZFE_SEARCH_MAX:Int   = 30;

    // ── Auth state ────────────────────────────────────────────────────────────
    var _authState:String        = "limited";
    // Server-authoritative permission snapshot from chat.v1.getAuthState. This only
    // controls whether staff-only references/help are shown; every action is still
    // authorized again by the relay from the linked Discord role.
    var _canModerate:Bool         = false;
    var _pinnedSystemBody:String = "";
    // True once the relay has sent a system link-code notice (sent ONLY to limited/unlinked
    // identities) — the authoritative "not linked" signal (ZFE getAuthState can't tell us).
    // STICKY: survives reconnects; only a "LINK COMPLETE" notice or a successful send clears
    // it (see the "Link gate" note in the file header).
    var _needsLink:Bool = false;
    // getTimer() stamp of the pinned notice, so a code that outlived its 10-minute TTL can be
    // refreshed instead of sitting on screen unredeemable. 0 = no pinned code.
    var _linkNoticeAt:Float = 0;
    // Guards one reconnect per stale code — cleared once a fresh notice lands.
    var _linkRefreshPending:Bool = false;

    // ── Input state ───────────────────────────────────────────────────────────
    var _inputOpen:Bool          = false;
    // True only after this widget successfully dispatched StartEditText. It prevents an
    // unmatched EndEditText from releasing a different HUD editor and lets release retry if
    // the HUD domain briefly rejects the first EndEditText dispatch.
    var _editTextLockOwned:Bool  = false;
    var _editTextUnlockRetry:flash.utils.Timer = null;
    // v2.5.3: DECODED native chat-input API — bare-value payloads ("true"/"false"),
    // consume=boolean, text from readChatInput. Native input is attempted lazily on open;
    // its activation buffer is cleared and verified before the session becomes visible.
    static inline var USE_NATIVE_INPUT:Bool = true;
    var _nativeInput:Bool        = false;          // true while a native session owns input
    var _inputTimer:flash.utils.Timer = null;      // in-session native input poll (~100 ms)
    var _inProgress:String       = "";             // last readChatInput buffer text
    var _lastReadRaw:String      = "";             // throttle [nativein] read logging
    var _nativeSubmitInFlight:Bool = false;        // mark a send originating from a native submit (diagnostic log)
    // Reset true on each relay connection; a failed open disables native input until reconnect
    // and leaves SharedHUDTools as the compatibility fallback.
    var _nativeInputUsable:Bool  = false;
    // Set by callTop when a native helper throws or returns a command-level failure. A failed
    // in-session helper must disable native input so the next open uses SharedHUDTools.
    var _nativeInputCommandFailed:Bool = false;
    static inline var INPUT_POLL_MS:Int  = 100;    // in-session native input-poll interval
    // ── Open-key poll — open chat on the configured ZFE OpenChatKey edge ───────────────
    var _openKeyTimer:flash.utils.Timer = null;    // low-rate (~150 ms) open-trigger poll
    static inline var OPEN_KEY_MS:Int = 150;       // open-key poll interval
    var _lastChatKey:Bool        = false;          // last isChatKeyPressed truthiness (edge detect)

    // ── SharedHUDTools (HUDModLoader text-entry + F11 menu integration) ───────
    var _hudTools:Dynamic        = null;

    // ── Optimistic-echo dedup (our just-sent messages) ────────────────────────
    var _pendingEchoes:Array<{key:String, ts:Float}> = [];

    // ─────────────────────────────────────────────────────────────────────────

    static function main():Void {
        flash.Lib.current.addChild(new FCMChatWidget());
    }

    public function new() {
        super();
        addEventListener(Event.ADDED_TO_STAGE, onStage);
    }

    // =========================================================================
    // Stage ready — load config then build panel
    // =========================================================================

    function onStage(e:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, onStage);
        loadConfig();
    }

    function loadConfig():Void {
        var ul:URLLoader = new URLLoader();
        ul.addEventListener(Event.COMPLETE, onConfigLoaded);
        ul.addEventListener(IOErrorEvent.IO_ERROR, function(_) { afterConfig(); });
        try {
            ul.load(new URLRequest("../FCMChat.ini"));
        } catch (e:Dynamic) {
            afterConfig();
        }
    }

    function onConfigLoaded(e:Event):Void {
        var ul:URLLoader = cast e.target;
        _cfg = FcmConfig.parse(Std.string(ul.data));
        afterConfig();
    }

    function afterConfig():Void {
        _autoHideOn = (_cfg != null && _cfg.autoHideSec > 0);   // default from config (60s)
        // Register HUDModLoader listeners before building the static panel.
        attachHUDModListeners();
        buildPanel();
        // Delay ZFE init 3 s — ZFE API may not be ready at SWF load time.
        var t:Timer = new Timer(3000, 1);
        t.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { init(); });
        t.start();
    }

    // =========================================================================
    // Panel chrome — no header row, no status row
    // =========================================================================

    function buildPanel():Void {
        var w:Int = _cfg.width;
        var h:Int = _cfg.height;
        // Log area gets everything except tab rows and input. HUDTools renders its
        // entry field as a top-level object, so leave an explicit safety gap between
        // the feed's clip rectangle and the input rectangle.
        var logTop:Int = TAB_H + SUB_H + 4;
        var logBottom:Int = h - INPUT_H - LOG_INPUT_GAP;
        var logHeight:Int = logBottom - logTop;

        _bg = new Shape();
        var g = _bg.graphics;
        g.beginFill(_cfg.bgColor, _cfg.bgAlpha);
        g.lineStyle(1, _cfg.borderColor, 0.3);
        g.drawRect(0, 0, w, h);
        g.endFill();
        // Tab rows (main + sub) — ONE fill at a single alpha so there is NO dim seam between
        // the main-tab row and the sub-tab row (user request; the two-alpha fill left a faint line).
        g.lineStyle();
        g.beginFill(_cfg.tabRowColor, 0.98);
        g.drawRect(1, 1, w - 2, TAB_H + SUB_H);
        g.endFill();
        // Sub-tab row bottom divider + log/input separator (full width, overlay parity @0.45).
        g.lineStyle(1, _cfg.borderColor, 0.45);
        g.moveTo(0, TAB_H + SUB_H); g.lineTo(w, TAB_H + SUB_H);
        g.lineStyle(1, _cfg.borderColor, 0.4);
        g.moveTo(0, h - INPUT_H); g.lineTo(w, h - INPUT_H);
        addChild(_bg);

        // Main tab label first so we can measure it to size the outline box.
        _tabTf = makeChromeTf(8, 2, w - 16, TAB_H - 2);
        renderMainTabs();
        addChild(_tabTf);

        // Active main-tab outline (overlay parity, CAP-015/A.7): border TOP+LEFT+RIGHT only
        // (open bottom), sized to the label, and the main-tab-row divider is CUT OUT under
        // the tab so NO line runs beneath the active tab. Solid lines, no fill, no filters.
        var tw:Float = 0.0;
        try { tw = _tabTf.textWidth; } catch (e:Dynamic) {}
        var boxL:Int = 4;
        var boxR:Int = (tw > 20) ? Std.int(8 + tw + 6) : 104;   // fit the text (tight right pad)
        g.lineStyle(1, _cfg.tabActiveColor, 0.5);
        g.moveTo(boxL, 2);     g.lineTo(boxR, 2);       // top
        g.moveTo(boxL, 2);     g.lineTo(boxL, TAB_H);   // left
        g.moveTo(boxR, 2);     g.lineTo(boxR, TAB_H);   // right
        // The ONLY main->sub separator: a yellow line at y=TAB_H across the full width, CUT OUT
        // under the active tab so the outline + this line form one continuous yellow line that
        // WRAPS the active "FALLOUT 76" tab. No dim divider anywhere on this boundary.
        g.moveTo(0, TAB_H);    g.lineTo(boxL, TAB_H);
        g.moveTo(boxR, TAB_H); g.lineTo(w, TAB_H);

        // Channel sub-tabs: plain text strip (NO boxes/borders) — active bright, inactive dim.
        _subTf = makeChromeTf(8, TAB_H + 2, w - 16, SUB_H - 2);
        renderSubTabs();
        addChild(_subTf);

        _logTf = new TextField();
        _logTf.x = 6;
        _logTf.y = logTop;
        _logTf.width  = w - 12;
        _logTf.height = logHeight;
        _logTf.multiline  = true;
        _logTf.wordWrap   = true;
        _logTf.selectable = false;
        _logTf.mouseEnabled = true;   // enable mouse-wheel scroll (CAP-008, VER-2)
        _logTf.embedFonts = true;
        _fmt = new TextFormat();
        _fmt.font    = FONT_BODY;
        _fmt.size    = _cfg.fontSize;
        _fmt.color   = _cfg.textColor;
        // Keep each message on the font's native line box. Direct image HTML
        // previously forced a 32px image line and exposed this extra leading;
        // substitution images now share the normal text baseline.
        _fmt.leading = 0;
        _logTf.defaultTextFormat = _fmt;
        setLogText("connecting...");
        addChild(_logTf);

        // Mouse-wheel over the log scrolls history (CAP-008, VER-2). HUD-availability
        // unverified; F11 "Scroll to newest" + auto-scroll stay the fallback.
        try {
            _logTf.addEventListener(flash.events.MouseEvent.MOUSE_WHEEL, onLogWheel);
        } catch (e:Dynamic) {}

        // ── Prompt row: idle hint / "typing..." (HUDTools draws its own entry box) ──
        _promptTf = makeChromeTf(6, h - INPUT_H + 4, w - 12, INPUT_H - 6);
        setPrompt(idlePrompt());
        addChild(_promptTf);

        x = _cfg.x;
        y = _cfg.y;
    }

    function makeChromeTf(tx:Float, ty:Float, tw:Float, th:Float):TextField {
        var tf:TextField = new TextField();
        tf.x = tx; tf.y = ty;
        tf.width = tw; tf.height = th;
        tf.selectable = false;
        tf.mouseEnabled = false;
        tf.embedFonts = true;
        // Apply the engine body alias so chrome text resolves (not tofu).
        var fmt:TextFormat = new TextFormat();
        fmt.font  = FONT_BODY;
        fmt.size  = 13;
        fmt.color = _cfg.tabInactiveColor;
        tf.defaultTextFormat = fmt;
        return tf;
    }

    /**
     * Channel slug-indices in DISPLAY order. SERVER (slug index 5) is shown
     * immediately to the right of GENERAL (0), but ONLY after the relay has accepted this
     * player's server-room control. Nearby-player observations alone are not membership.
     */
    function tabOrder():Array<Int> {
        return _serverSessionReady ? [0, 5, 1, 2, 3, 4] : [0, 1, 2, 3, 4];
    }

    function renderMainTabs():Void {
        if (_tabTf == null) return;
        // #344 / CAP-015 / D-11: single main tab "FALLOUT 76" (no PARTY); the active
        // outline box is drawn in buildPanel() via _bg.graphics (no brackets, no filters).
        _tabTf.htmlText =
            '<font face="' + FONT_BOLD + '" size="13" color="' + hx(_cfg.tabActiveColor) + '"><b>FALLOUT 76</b></font>';
    }

    function renderSubTabs():Void {
        if (_subTf == null) return;
        // Borderless text strip (no boxes). Sub-tabs use the HEADER text colors (same as the
        // "FALLOUT 76" main tab): active channel = tabActiveColor (bright), inactive =
        // tabInactiveColor (dim). Per-channel colors (chat_rooms.color) are applied only to the
        // [Channel] message tags, NOT this tab row. Slash /g /t /e /i /r still switch channels.
        var html:Array<String> = [];
        for (si in tabOrder()) {
            var color:String = (si == _chanIdx) ? hx(_cfg.tabActiveColor) : hx(_cfg.tabInactiveColor);
            html.push('<font face="' + FONT_BOLD + '" size="12" color="' + color + '"><b>' + CHAN_NAMES[si] + '</b></font>');
        }
        _subTf.htmlText = html.join('<font face="' + FONT_BODY + '" size="12" color="' + hx(_cfg.tabInactiveColor) + '">  </font>');
    }

    function idlePrompt():String {
        // Blank when idle unless showHints (CAP-014); in-progress text still shows while typing.
        if (!_cfg.showHints) return "";
        var suffix:String = _canModerate ? "  |  [F11] moderation" : "";
        return '<font face="' + FONT_BODY + '" size="13" color="' + hx(_cfg.promptColor) + '">&#x203A; ['
            + _cfg.openKey + '] chat  |  [/g /t /e /i /r] channel' + suffix + '</font>';
    }

    function typingPrompt():String {
        // No help text while typing (user request) — the prompt row shows only the
        // in-progress typed text (pollNativeInput appends it). Blank when nothing typed.
        return "";
    }

    function setLogText(s:String):Void {
        if (_logTf == null) return;
        _logTf.htmlText = '<font face="' + FONT_BODY + '" size="' + _cfg.fontSize + '" color="' + hx(_cfg.textColor) + '">' + s + '</font>';
    }

    function setPrompt(html:String):Void {
        if (_promptTf == null) return;
        _promptTf.htmlText = html;
    }

    /** Rebuild the feed through Scaleform's incremental HTML extension path. */
    function renderLogHtml(lines:Array<String>):Bool {
        if (_logTf == null) return false;
        try {
            var ext:Dynamic = null;
            var getDefinition:Dynamic = untyped __global__["flash.utils.getDefinitionByName"];
            if (getDefinition != null) {
                ext = Reflect.callMethod(null, getDefinition, ["scaleform.gfx.TextFieldEx"]);
            }
            if (ext == null) return false;
            var append:Dynamic = Reflect.field(ext, "appendHtml");
            if (append == null) return false;

            _logTf.htmlText = "";
            for (i in 0...lines.length) {
                var fragment:String = lines[i];
                if (i + 1 < lines.length) fragment += "<br/>";
                Reflect.callMethod(ext, append, [_logTf, fragment]);
            }
            return true;
        } catch (e:Dynamic) {
            zfeLog("warn", "render", "appendHtml unavailable; using htmlText fallback");
            return false;
        }
    }

    /** Snap after an append/reflow; both calls are guarded for GFx build variance. */
    function snapLogToBottom():Void {
        if (_logTf == null) return;
        try { _logTf.setSelection(_logTf.length, _logTf.length); } catch (e:Dynamic) {}
        try { _logTf.scrollV = _logTf.maxScrollV; } catch (e:Dynamic) {}
    }

    // =========================================================================
    // HUDModLoader listeners — SharedHUDTools + stage user-event
    // =========================================================================

    function attachHUDModListeners():Void {
        try {
            stage.addEventListener("HUDMod::UserEvent", onUserEvent);
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "stageListenerFailed: " + Std.string(e));
        }
        constructHudTools();
    }

    /**
     * Construct a SharedHUDTools instance for text-entry + HUDModLoader menu.
     *
     * Register(callback) subscribes to the HUDTools IPC bus (required before
     * TextEdit/FormatTextEdit will work).
     * RegisterMenu(build, select) adds us to the HUDModLoader menu (F11 upstream).
     */
    function constructHudTools():Void {
        // Extensions.enabled is required before any scaleform.gfx.* use.
        try {
            var ext:Dynamic = untyped __global__["scaleform.gfx.Extensions"];
            if (ext != null) ext.enabled = true;
        } catch (e:Dynamic) {}

        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("SharedHUDTools");
            if (cls != null) {
                _hudTools = untyped __new__(cls, VENDOR, "All");
                Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "Register"),
                    [function(sender:String, msg:String):Void { onHudMessage(sender, msg); }]);
                Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "RegisterMenu"),
                    [function(parentItem:String):Void { onBuildMenu(parentItem); },
                     function(item:String):Void { onSelectMenu(item); }]);
                // Position the HUDModLoader menu just under the channel-tab row.
                try {
                    Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatMenu"),
                        [_cfg.x, _cfg.y + TAB_H, "down"]);
                } catch (e:Dynamic) {}
                zfeLog("info", "hud", "SharedHUDTools registered");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "SharedHUDToolsMissing: " + Std.string(e));
        }

    }

    function onHudMessage(sender:String, msg:String):Void {
        // HUDTools messages can contain player-entered text. Keep a useful breadcrumb
        // without persisting message content or identity data in zfe.log.
        var bodyLen:Int = (msg == null) ? 0 : msg.length;
        zfeLog("info", "hud", "HUDTools message received bodyLen=" + bodyLen);
    }

    /**
     * Toggle the upstream HUDModLoader menu. RegisterMenu() only supplies our menu callbacks;
     * HUDTools requires explicit ShowMenu()/CloseMenu() requests for the F11 action. Its
     * isActive flag is shared by the menu and text editor, so never close an active chat edit
     * from this menu toggle.
     */
    function showHudLoaderMenu():Void {
        if (_hudTools == null) return;
        try {
            var active:Bool = (Reflect.field(_hudTools, "isActive") == true);
            if (active && !_inputOpen) {
                var close:Dynamic = Reflect.field(_hudTools, "CloseMenu");
                if (close != null) Reflect.callMethod(_hudTools, close, []);
            } else if (!active) {
                var show:Dynamic = Reflect.field(_hudTools, "ShowMenu");
                if (show != null) Reflect.callMethod(_hudTools, show, []);
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "menu", "menu toggle threw: " + Std.string(e));
        }
    }

    /**
     * HUDModLoader menu build callback.
     * Adds channel-switch entries, a scroll-to-newest action, and a link action
     * (enabled only while auth is limited).
     * AddMenuItem(id, text, isEnabled=true, isMenu=false, timeout=-1).
     */
    function onBuildMenu(parentItem:Dynamic):Void {
        if (_hudTools == null) return;
        var add:Dynamic = Reflect.field(_hudTools, "AddMenuItem");
        if (add == null) return;
        var p:String = Std.string(parentItem);
        try {
            // Customize submenu (opened when the "customize" isMenu item is selected — HUDTools
            // re-invokes this builder with parentItem = the submenu id).
            if (p == "customize") {
                Reflect.callMethod(_hudTools, add, ["cz_bigger",  "Size +",        true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_smaller", "Size -",        true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_up",      "Move up",       true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_down",    "Move down",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_left",    "Move left",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_right",   "Move right",    true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_opac_up", "Opacity +",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_opac_dn", "Opacity -",     true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_theme",   "Color theme >", true, false, -1]);
                Reflect.callMethod(_hudTools, add, ["cz_reset",   "Reset all settings", true, false, -1]);
                return;
            }
            // Top-level menu — channel entries in display order (SERVER included in-world).
            for (si in tabOrder()) {
                Reflect.callMethod(_hudTools, add, ["chan" + si, CHAN_NAMES[si], true, false, -1]);
            }
            Reflect.callMethod(_hudTools, add, ["scrollbottom", "Scroll to newest", true, false, -1]);
            Reflect.callMethod(_hudTools, add, ["hidechat", "Hide chat", true, false, -1]);
            Reflect.callMethod(_hudTools, add, ["autohide", (_autoHideOn ? "Auto-hide: ON" : "Auto-hide: OFF"), true, false, -1]);
            Reflect.callMethod(_hudTools, add, ["customize", "Customize...", true, true, -1]);   // isMenu=true
            // The relay provides this permission snapshot from the linked Discord role.
            // The command itself is re-authorized server-side on every submit.
            if (_canModerate) {
                Reflect.callMethod(_hudTools, add, ["moderationhelp", "Moderation commands", true, false, -1]);
            }
            Reflect.callMethod(_hudTools, add, ["relink", "Link account...", _authState != "authenticated", false, -1]);
        } catch (e:Dynamic) {
            zfeLog("warn", "menu", "AddMenuItem threw: " + Std.string(e));
        }
    }

    /**
     * HUDModLoader menu select callback. id is the AddMenuItem id string.
     */
    function onSelectMenu(item:Dynamic):Void {
        var id:String = Std.string(item);
        if (StringTools.startsWith(id, "cz_")) {
            doCustomize(id);
        } else if (StringTools.startsWith(id, "chan")) {
            selectChannel(Std.parseInt(id.substr(4)));
        } else if (id == "scrollbottom") {
            scrollToBottom();
        } else if (id == "hidechat") {
            hide();
        } else if (id == "autohide") {
            _autoHideOn = !_autoHideOn;
            if (_autoHideOn) { bumpAutoHide(); }
            else { if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; } if (_hidden) show(); }
            zfeLog("info", "menu", "auto-hide " + (_autoHideOn ? "on" : "off"));
        } else if (id == "moderationhelp") {
            setLogText(moderationHelp());
        } else if (id == "relink") {
            setLogText(linkHint());
        }
    }

    /**
     * HUDMod::UserEvent handler — control-map ACTIONS only. FO76 collapses every unbound key
     * (INSERT, Page Up/Down, Delete, …) to "Unmapped" with no key info, so this path is reliable
     * ONLY for real named actions. It is just a secondary open-chat trigger for when OpenChatKey
     * is a real action (Console / TeamChat). The primary open AND the channel cycle run off the
     * native isChatKeyPressed poll (pollOpenKey); channel jumps are slash commands or the
     * configured NextPage/PrevPage actions. event.EventName (String), event.IsKeyDown (Boolean)
     * per HUDModUserEvent.as.
     */
    function onUserEvent(e:Dynamic):Void {
        var action:String = "";
        var isDown:Bool   = false;
        try { action = Std.string(e.EventName); }  catch (_:Dynamic) {}
        try { isDown = (e.IsKeyDown == true); }    catch (_:Dynamic) {}
        if (isDown) return;

        // HUDModLoader's RegisterMenu() does not bind the F11 hotkey. The loader forwards
        // the key as a HUDMod::UserEvent, so explicitly open the shared menu here. Keep the
        // guard narrow: "Unmapped" represents every unbound key and must never open menus.
        if (action == "F11" || action == "HUDModMenu" || action == "HUDModLoaderMenu") {
            showHudLoaderMenu();
            return;
        }

        // Keep the active input session and its buffer intact while changing the destination
        // channel. This is the HUDModLoader equivalent of the legacy Text Chat mod's Tab switch.
        if (_inputOpen) {
            if (action == _cfg.channelNextKey) { cycleChannel(); return; }
            if (action == _cfg.channelPrevKey) { cyclePrev(); return; }
        }

        // Open only on a real action used as the open key (never on "Unmapped", which would
        // open on ANY unbound key). INSERT etc. open via the native poll, not here.
        if (action == "Console" || action == "ConsoleToggles" || action == "TeamChat"
                || (action == _cfg.openKey && action != "Unmapped")) {
            if (_inputOpen && _nativeInput) return;
            if (!_inputOpen) openInput();   // openInput() restores from hidden first (CAP-011)
        }
    }

    // =========================================================================
    // Channel switching
    // =========================================================================

    /** Re-render the single static tab row when the visible tab order changes. */
    function rebuildChannelTabs():Void {
        renderSubTabs();
    }

    /** Reflect the active channel in the static tab row. */
    function setSelectedTab(idx:Int):Void {
        renderSubTabs();
    }

    /**
     * Single channel-switch entry point (tab click, slash, cycle, F11 menu).
     */
    function selectChannel(idx:Int):Void {
        // idx is a SLUG index; only channels currently in the display order are selectable
        // (SERVER is excluded when not in a world).
        if (tabOrder().indexOf(idx) < 0 || idx == _chanIdx) { setSelectedTab(_chanIdx); return; }
        _chanIdx = idx;
        // Keep ALL channels' messages in _records (from the history backfill + live); renderRecords
        // filters by the active channel. Do NOT clear here, or switching a channel would blank its
        // history (the backfilled messages for that channel would be discarded).
        _bScrolling = false; _newWhileScrolled = 0;
        setSelectedTab(idx);
        renderRecords();             // re-render (filters to the newly-selected channel)
        bumpAutoHide();              // channel switch = activity
        zfeLog("info", "chan", "selected " + CHAN_SLUGS[idx]);
    }

    function cycleChannel():Void {
        // Cycle forward through the visible tabs in DISPLAY order (includes SERVER in-world).
        var order:Array<Int> = tabOrder();
        var pos:Int = order.indexOf(_chanIdx);
        if (pos < 0) pos = 0;
        selectChannel(order[(pos + 1) % order.length]);
    }

    function cyclePrev():Void {
        // Reverse-cycle through the visible tabs in DISPLAY order.
        var order:Array<Int> = tabOrder();
        var pos:Int = order.indexOf(_chanIdx);
        if (pos < 0) pos = 0;
        selectChannel(order[(pos + order.length - 1) % order.length]);
    }

    // =========================================================================
    // Hide / restore (CAP-011)
    //
    // hide() sets this.visible=false; show() sets it back. Timers + listeners keep
    // running while hidden so the feed stays current. Triggers: /hide, F11 "Hide chat",
    // optional hideKey action. Restore: the open key (INSERT) via openInput() -> show().
    // =========================================================================

    function hide():Void {
        this.visible = false;
        _hidden = true;
        if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; }
        zfeLog("info", "hide", "panel hidden");
    }

    function show():Void {
        this.visible = true;
        _hidden = false;
        bumpAutoHide();
        zfeLog("info", "hide", "panel restored");
    }

    /**
     * Restart the auto-hide countdown (called on any activity: show, open input, channel switch,
     * new message). When it elapses with no further activity — and the input isn't open — the
     * panel hides. A new message reveals it again (see parseAndRenderEvents). F11-menu toggleable.
     */
    function bumpAutoHide():Void {
        if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; }
        if (!_autoHideOn || _cfg == null || _cfg.autoHideSec <= 0) return;
        _autoHideTimer = new Timer(_cfg.autoHideSec * 1000, 1);
        _autoHideTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _autoHideTimer = null;
            if (!_inputOpen && !_hidden) hide();
        });
        _autoHideTimer.start();
    }

    // =========================================================================
    // F11 Customize — live resize / move / opacity / color theme (+ ZFE storage persistence)
    // =========================================================================

    // Live re-layout after a Customize change. Removes children BY REFERENCE only — NEVER
    // numChildren/getChildAt (Scaleform VM crash, rule #9). buildPanel re-adds everything
    // and re-applies x/y from _cfg.
    function rebuildPanel():Void {
        var kids:Array<flash.display.DisplayObject> = [_bg, _tabTf, _subTf, _logTf, _promptTf];
        for (c in kids) { try { if (c != null) removeChild(c); } catch (e:Dynamic) {} }
        buildPanel();
        setSelectedTab(_chanIdx);
        renderRecords();
    }

    // border, text, sender, tabActive, tabInactive
    static var THEMES:Array<Array<Int>> = [
        [0xF5CB5B, 0xFAF4DA, 0xF5CB5B, 0xF5CB5B, 0xB49544],   // Amber (default)
        [0x5AB0FF, 0xE6F2FF, 0x5AB0FF, 0x5AB0FF, 0x3A6A99],   // Blue
        [0x6AD46A, 0xE8FBE8, 0x6AD46A, 0x6AD46A, 0x3F7F3F],   // Green
        [0xD8D8D8, 0xF2F2F2, 0xFFFFFF, 0xFFFFFF, 0x888888],   // Mono
    ];

    function cycleTheme():Void {
        _themeIdx = (_themeIdx + 1) % THEMES.length;
        var t:Array<Int> = THEMES[_themeIdx];
        _cfg.borderColor = t[0]; _cfg.textColor = t[1]; _cfg.senderColor = t[2];
        _cfg.tabActiveColor = t[3]; _cfg.tabInactiveColor = t[4];
    }

    function doCustomize(id:String):Void {
        if (id == "cz_reset") {
            _cfg = FcmConfig.resetToDefaults(_cfg);
            _themeIdx = 0;
            if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; }
            _autoHideOn = (_cfg.autoHideSec > 0);
            rebuildPanel();
            if (_autoHideOn) bumpAutoHide();
            persistConfig();
            zfeLog("info", "customize", "all settings reset to defaults");
            return;
        }
        switch (id) {
            case "cz_bigger":  _cfg.width += 30; _cfg.height += 20;
            case "cz_smaller": _cfg.width -= 30; _cfg.height -= 20;
            case "cz_up":      _cfg.y -= 20;
            case "cz_down":    _cfg.y += 20;
            case "cz_left":    _cfg.x -= 20;
            case "cz_right":   _cfg.x += 20;
            case "cz_opac_up": _cfg.bgAlpha += 0.1;
            case "cz_opac_dn": _cfg.bgAlpha -= 0.1;
            case "cz_theme":   cycleTheme();
            default: return;
        }
        _cfg.clamp();   // keep size/position on-screen + alpha in range
        // Move is cheap (just reposition the container); size/opacity/theme need a redraw.
        if (id == "cz_up" || id == "cz_down" || id == "cz_left" || id == "cz_right") { x = _cfg.x; y = _cfg.y; }
        else rebuildPanel();
        persistConfig();
    }

    // Best-effort persist so customizations survive relaunch. ZFE storage is scoped to this vendor;
    // if unavailable the change is still applied live this session (guarded, no-op on failure).
    function persistConfig():Void {
        try {
            var payload:String = '{"vendor":"' + VENDOR + '","path":"' + SETTINGS_PATH
                + '","text":"' + jsonEscape(_cfg.toIni()) + '"}';
            var raw:String = callTop("writeStorage", payload);
            zfeLog("info", "customize", "persist raw=" + clip200(raw));
        } catch (e:Dynamic) {
            zfeLog("warn", "customize", "persist threw: " + Std.string(e));
        }
    }

    /** Apply persisted Customize values over the packaged environment config. */
    function loadPersistedConfig():Void {
        var environmentLinkUrl:String = _cfg.linkUrl;
        try {
            var payload:String = '{"vendor":"' + VENDOR + '","path":"' + SETTINGS_PATH + '"}';
            var raw:String = callTop("readStorage", payload);
            if (raw.indexOf('"success":true') < 0 || raw.indexOf('"found":true') < 0) return;
            var stored:String = FcmConfig.decodeJsonText(extractJsonString(raw, "text"));
            if (stored.indexOf("[FCMChat]") < 0) return;
            _cfg = FcmConfig.parse(stored);
            _cfg.linkUrl = environmentLinkUrl;
            _autoHideOn = (_cfg.autoHideSec > 0);
            rebuildPanel();
            zfeLog("info", "customize", "persisted settings loaded");
        } catch (e:Dynamic) {
            zfeLog("warn", "customize", "load persisted settings threw: " + Std.string(e));
        }
    }

    /**
     * Slash-command channel switching.
     * Returns true if the command matched — caller must NOT send the text as a message.
     */
    function switchChannelBySlash(cmd:String):Bool {
        cmd = cmd.toLowerCase();
        var idx:Int = -1;
        if      (cmd == "g" || cmd == "gen"     || cmd == "general")  idx = 0;
        else if (cmd == "t" || cmd == "trade"   || cmd == "trading")  idx = 1;
        else if (cmd == "e" || cmd == "event"   || cmd == "events")   idx = 2;
        else if (cmd == "i" || cmd == "inf"     || cmd == "infests")  idx = 3;
        else if (cmd == "r" || cmd == "raid"    || cmd == "raids")    idx = 4;
        else if (cmd == "s" || cmd == "server")                      idx = 5;
        if (idx < 0) return false;
        if (idx == 5 && !_serverSessionReady) {
            // SERVER only exists after the relay accepted a current room binding.
            zfeLog("info", "chan", "/server ignored — session not ready");
            return true;
        }
        selectChannel(idx);
        return true;
    }

    // =========================================================================
    // SharedHUDTools text-entry
    //
    // Flow (per decompiled HUDTools.as + SharedHUDTools.as):
    //
    //   1. FormatTextEdit(x,y,w,h,font,size,hexColor,bgHexColor,bgAlpha)
    //      → HUDTools stores entryFormats[VENDOR] via HUDMessageProvider IPC.
    //      font arg is the engine body alias (FONT_BODY = $MAIN_Font_Light),
    //      matching HUDTools' own entry_tf default — no embed needed.
    //
    //   2. FormatOnScreenKeyboard(oskX,oskY)
    //      → HUDTools stores entryOSKFormats[VENDOR].
    //      REQUIRED even on KB/mouse: startTextEdit checks BOTH Dicts.
    //      Missing → ERROR|TXT → textFunction(null) immediately ("released").
    //
    //   3. TextEdit(callback, "")
    //      → HUDTools.startTextEdit: adds entry_tf to topLevel, focuses it,
    //        dispatches ControlMap::StartEditText. User types; Enter → callback(text).
    //      → Esc/Tab → callback(null). Fires ONCE, then textFunction is nulled.
    //
    // =========================================================================

    // =========================================================================
    // Native chat-input verb invocation (TOP-LEVEL ZFE commands)
    //
    // The v2.5.0 in-game test proved the native chat-input verbs are TOP-LEVEL ZFE
    // commands (like getRuntimeInfo / readStorage), NOT chat.v1. commands:
    //   __ZFE.call("chat.v1.setChatInputActive", ...)
    //     → {"success":false,"error":{"code":"unsupported_command",...}}
    // So we call them BARE (no "chat.v1." prefix) via callTop(). NEVER prefix these.
    //
    // sendMessage is the opposite: it is chat.v1.sendMessage ONLY — never bare (bare
    // hits the useless legacy bridge, which returns literal `false`). See sendMessage().
    // =========================================================================

    /**
     * True if a raw response looks like "command not found / not dispatched".
     * Includes unsupported_command (the v2.5.0 prefixed-verb failure mode).
     */
    static function chatVerbFailed(raw:String):Bool {
        if (raw == null) return true;
        return raw.indexOf("dispatch_failed") >= 0
            || raw.indexOf("unsupported_command") >= 0
            || raw.indexOf("Unknown op") >= 0
            || raw.indexOf("unknown command") >= 0;
    }

    /**
     * Call a TOP-LEVEL ZFE command bare (no "chat.v1." prefix). Used for the native
     * chat-input verbs. Returns Std.string(result), or "" on throw.
     */
    function callTop(verb:String, payload:String):String {
        if (_api == null) {
            _nativeInputCommandFailed = true;
            return "";
        }
        try {
            var raw:String = Std.string(_api.call(verb, payload));
            if (chatVerbFailed(raw) || StringTools.trim(raw).toLowerCase().indexOf('"success":false') >= 0) {
                _nativeInputCommandFailed = true;
            }
            return raw;
        } catch (e:Dynamic) {
            _nativeInputCommandFailed = true;
            zfeLog("warn", "nativein", verb + " threw: " + Std.string(e));
            return "";
        }
    }

    /** Trim a raw response for diagnostic logging (n chars max). */
    static inline function clip(s:String, n:Int):String {
        return (s == null) ? "" : (s.length > n ? s.substr(0, n) : s);
    }
    static inline function clip200(s:String):String { return clip(s, 200); }

    /**
     * v2.5.3 — the native verbs return BARE booleans/strings (NOT JSON). "Truthy" means
     * the raw, trimmed+lowercased, equals "true" OR equals "1" OR contains "success":true.
     * A bare "false" / "" / JSON / a failure response is NOT truthy. Used for
     * setChatInputActive / isChatInputActive / isChatKeyPressed / consumeChatInputSubmitted.
     */
    static function nativeTruthy(raw:String):Bool {
        if (raw == null) return false;
        var t:String = StringTools.trim(raw).toLowerCase();
        if (t.length == 0) return false;
        if (chatVerbFailed(raw)) return false;       // dispatch_failed / unsupported_command / etc.
        if (t.indexOf('"success":false') >= 0) return false;
        return t == "true" || t == "1" || t.indexOf('"success":true') >= 0;
    }

    /**
     * Parse the readChatInput buffer text. The raw may be a bare string ("hello"), a
     * JSON-quoted string ("\"hello\""), or a JSON object with a text/value/input field.
     * A bare "false" / "" is treated as no text. Returns the in-progress text.
     */
    static function parseInputText(raw:String):String {
        if (raw == null) return "";
        var t:String = StringTools.trim(raw);
        if (t.length == 0) return "";
        var low:String = t.toLowerCase();
        if (low == "false" || low == "true") return ""; // bare boolean, never user text
        // JSON object → extract a text/value/input field.
        if (t.charAt(0) == "{") {
            var f:String = extractJsonString(t, "text");
            if (f.length > 0) return f;
            f = extractJsonString(t, "value");
            if (f.length > 0) return f;
            f = extractJsonString(t, "input");
            return f;
        }
        // Strip surrounding double-quotes from a JSON-quoted bare string.
        if (t.length >= 2 && t.charAt(0) == '"' && t.charAt(t.length - 1) == '"') {
            t = t.substr(1, t.length - 2);
        }
        return t;
    }

    function openInput():Void {
        if (_inputOpen) return;
        // If a previous EndEditText is still being retried, do not start another editor on
        // top of a possibly locked game control map. The retry is short and self-clearing.
        if (_editTextLockOwned) {
            setPrompt("Restoring game input...");
            zfeLog("warn", "input", "open blocked while EndEditText is pending");
            return;
        }
        // The open key both restores a hidden panel AND opens input (CAP-011, guaranteed).
        if (_hidden) show();
        bumpAutoHide();   // opening input = activity (the timer also never hides while input is open)
        // NATIVE FIRST, but only with a verified ControlMap edit-text lock. HUDTools' keyboard
        // editor can receive only the newest character on some Windows/Steam Input combinations.
        // The native ZFE session owns a cumulative buffer; its first activation is cleared and
        // verified before it is accepted. SharedHUDTools remains the compatibility fallback.
        if (USE_NATIVE_INPUT && _nativeInputUsable) {
            if (openInputNative()) return;
            // Do not keep re-triggering a known-bad native implementation for every Insert.
            // A reconnect resets this capability so a transient ZFE startup failure can retry.
            _nativeInputUsable = false;
        }
        openInputSharedHudTools();
    }

    // =========================================================================
    // Native chat-input session (PRIMARY) — decoded bare-value-payload flow (v2.5.3)
    //
    //   open:   setChatInputActive("true")        (bare "true" — NOT JSON)
    //   loop:   readChatInput("{}")               -> in-progress text (show in prompt)
    //           consumeChatInputSubmitted("{}")   -> bare boolean: true == Enter pressed
    //           isChatInputActive("{}")           -> bare boolean: false == cancelled (Esc)
    //   send:   final text from readChatInput -> handleSubmittedText -> chat.v1.sendMessage
    //   close:  clearChatInput("{}") + setChatInputActive("false")
    // =========================================================================

    /**
     * Open the ZFE native chat-input session via the decoded bare-value contract.
     * Returns true on success (caller is done); false → caller falls back to
     * the SharedHUDTools path.
     */
    /**
     * Suspend (start=true) / restore (start=false) the GAME's own keyboard+gamepad routing while
     * the chat input is active. ZFE's native input captures text but does NOT block the engine, so
     * WASD/hotkeys still fire while typing. The original FO76 Text Chat mod blocks them WITHOUT ZFE
     * by dispatching the engine's ControlMap edit-text events on BSUIDataManager (the same UI-data
     * surface we already read for worldId — EULA §4(F)-safe). Best-effort + fully guarded: if the
     * class/dispatch isn't available it logs and continues (no worse than today).
     */
    function dispatchEditText(start:Bool):Bool {
        var type:String = start ? "ControlMap::StartEditText" : "ControlMap::EndEditText";
        if (!start && !_editTextLockOwned) return true;
        try {
            // HUDModLoader widgets do not resolve the manager from __global__; findBSUI()
            // discovers Shared.AS3.Data.BSUIDataManager in the engine domain.
            var bsui:Dynamic = findBSUI();
            if (bsui == null) { zfeLog("warn", "input", "BSUIDataManager null; cannot " + type); return false; }
            var ev:Dynamic = null;
            var ceCls:Dynamic = null;
            for (className in ["Shared.AS3.Events.CustomEvent", "CustomEvent"]) {
                try {
                    ceCls = untyped __global__["flash.utils.getDefinitionByName"](className);
                    if (ceCls != null) break;
                } catch (ce:Dynamic) {}
            }
            if (ceCls != null) ev = untyped __new__(ceCls, type, { tag: "Chat" });
            else zfeLog("warn", "input", "CustomEvent unavailable; cannot " + type);
            // The engine's ControlMap contract requires the legacy CustomEvent payload
            // (`{tag:"Chat"}`). A generic Event is not evidence that game input was locked.
            if (ev == null) return false;
            bsui.dispatchEvent(ev);
            if (start) _editTextLockOwned = true;
            else _editTextLockOwned = false;
            zfeLog("info", "input", type + " dispatched (game input " + (start ? "suspended" : "restored") + ")");
            return true;
        } catch (e:Dynamic) {
            zfeLog("warn", "input", type + " dispatch threw: " + Std.string(e));
            return false;
        }
    }

    /**
     * Release only this widget's edit lock. A HUD-domain transition can reject an End event for
     * a frame; keep retrying with a small delay until it is accepted rather than abandoning the
     * ownership flag and leaving the game control map locked.
     */
    function releaseEditTextLock():Void {
        if (!_editTextLockOwned) return;
        if (dispatchEditText(false) || !_editTextLockOwned) return;
        if (_editTextUnlockRetry != null) { _editTextUnlockRetry.stop(); _editTextUnlockRetry = null; }
        _editTextUnlockRetry = new flash.utils.Timer(250, 1);
        _editTextUnlockRetry.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _editTextUnlockRetry = null;
            if (_editTextLockOwned) releaseEditTextLock();
        });
        _editTextUnlockRetry.start();
    }

    function openInputNative():Bool {
        if (_api == null) return false;
        _nativeInputCommandFailed = false;
        var raw:String = callTop("setChatInputActive", "true");   // bare "true", NOT JSON
        zfeLog("info", "nativein", "setChatInputActive(true) raw=" + clip200(raw));

        // Activation worked if the raw is truthy, or isChatInputActive becomes truthy.
        var active:Bool = nativeTruthy(raw);
        if (!active) {
            var a:String = callTop("isChatInputActive", "{}");
            active = nativeTruthy(a);
            zfeLog("info", "nativein", "isChatInputActive after activate raw=" + clip200(a));
        }
        if (!active) {
            // Even a rejected activation may have left a legacy payload in the native
            // buffer. Clear/deactivate before handing control to SharedHUDTools.
            var rejectedClear:String = callTop("clearChatInput", "{}");
            callTop("setChatInputActive", "false");
            zfeLog("warn", "nativein", "setChatInputActive not active; falling back clear="
                + clip200(rejectedClear));
            return false;
        }

        // Some Windows/ZFE builds return success but also expose the activation payload as
        // the current editable text. Clear it before creating the visible session and verify
        // that the buffer is empty. If either operation is unsupported, close the half-open
        // session and use SharedHUDTools instead; literal "true" must never reach the user.
        var clearRaw:String = callTop("clearChatInput", "{}");
        var afterClearRaw:String = callTop("readChatInput", "{}");
        if (_nativeInputCommandFailed) {
            callTop("setChatInputActive", "false");
            zfeLog("warn", "nativein", "activation helper failed; falling back");
            return false;
        }
        var afterClear:String = StringTools.trim(afterClearRaw).toLowerCase();
        if (parseInputText(afterClearRaw).length > 0 || afterClear == "true") {
            callTop("setChatInputActive", "false");
            zfeLog("warn", "nativein", "activation buffer not clear; falling back clear="
                + clip200(clearRaw) + " read=" + clip200(afterClearRaw));
            return false;
        }
        zfeLog("info", "nativein", "activation buffer cleared raw=" + clip200(clearRaw));

        // The user requirement is strict: do not accept a native input session unless the
        // corresponding engine edit lock was acquired. If that lock is unavailable, close the
        // half-open native session and use SharedHUDTools, which owns this lifecycle itself.
        if (!dispatchEditText(true)) {
            var closeRaw:String = callTop("setChatInputActive", "false");
            zfeLog("warn", "nativein", "game-input lock unavailable; native closed clear="
                + clip200(clearRaw) + " deactivate=" + clip200(closeRaw));
            return false;
        }

        _inputOpen   = true;
        _nativeInput = true;
        _inProgress  = "";
        _lastReadRaw = "";
        setPrompt(typingPrompt());
        zfeLog("info", "input path", "native-chat-input");
        if (_inputTimer != null) { _inputTimer.stop(); _inputTimer = null; }
        _inputTimer = new flash.utils.Timer(INPUT_POLL_MS);
        _inputTimer.addEventListener(TimerEvent.TIMER, function(_) { pollNativeInput(); });
        _inputTimer.start();
        return true;
    }

    /**
     * In-session native input tick (every INPUT_POLL_MS while a native session is open).
     * Guarded so a parse error never stops the timer — but a submit/cancel DOES close it.
     * Only ever called while a native session is open (never polls outside one).
     */
    function pollNativeInput():Void {
        if (!_nativeInput) return;
        _nativeInputCommandFailed = false;
        try {
            // ── 1. read the in-progress buffer; show it in the prompt ───────
            var rraw:String = callTop("readChatInput", "{}");
            if (_nativeInputCommandFailed) {
                zfeLog("warn", "nativein", "read helper failed; falling back");
                closeInputNative(true);
                return;
            }
            if (rraw != _lastReadRaw) {
                _lastReadRaw = rraw;
                zfeLog("info", "nativein", "read raw=" + clip200(rraw));
            }
            var text:String = parseInputText(rraw);
            _inProgress = text;
            if (text.length > 0) {
                setPrompt(typingPrompt() + ' <font face="' + FONT_BODY + '" size="13" color="'
                    + hx(_cfg.textColor) + '"> &#x203A; ' + FcmConfig.htmlEscape(text) + '</font>');
            } else {
                setPrompt(typingPrompt());
            }

            // ── 2. submit? consume returns a bare boolean (true = Enter pressed) ──
            var submittedRaw:String = callTop("consumeChatInputSubmitted", "{}");
            if (_nativeInputCommandFailed) {
                zfeLog("warn", "nativein", "submit helper failed; falling back");
                closeInputNative(true);
                return;
            }
            if (nativeTruthy(submittedRaw)) {
                // Read the final buffer once more; prefer it over the cached value.
                var finalRaw:String = callTop("readChatInput", "{}");
                if (_nativeInputCommandFailed) {
                    zfeLog("warn", "nativein", "final read helper failed; dropping submit");
                    closeInputNative(true);
                    return;
                }
                var textNow:String = parseInputText(finalRaw);
                var fin:String = (textNow.length > 0) ? textNow : _inProgress;
                closeInputNative();
                fin = StringTools.trim(fin);
                if (fin.length > 0) {
                    // Mark this send as native-submit so sendMessage logs the full raw
                    // (we are learning whether send works after a native session).
                    _nativeSubmitInFlight = true;
                    handleSubmittedText(fin);
                    _nativeSubmitInFlight = false;   // clear (slash-only inputs never send)
                }
                return;
            }

            // ── 3. still active? a non-truthy isChatInputActive = user cancelled (Esc) ──
            var activeRaw:String = callTop("isChatInputActive", "{}");
            if (_nativeInputCommandFailed) {
                zfeLog("warn", "nativein", "active helper failed; falling back");
                closeInputNative(true);
                return;
            }
            if (!nativeTruthy(activeRaw)) {
                zfeLog("info", "nativein", "isChatInputActive false; cancelled");
                closeInputNative();
                return;
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "nativein", "pollNativeInput threw: " + Std.string(e));
            // The lock must never survive a terminal native-input failure.
            closeInputNative(true);
        }
    }

    /**
     * Close the native chat-input session: stop the poll timer, clear + deactivate
     * the native input (bare "false"), and reset the prompt.
     */
    function closeInputNative(failed:Bool = false):Void {
        if (_inputTimer != null) { _inputTimer.stop(); _inputTimer = null; }
        var closeFailed:Bool = false;
        try {
            var c1:String = callTop("clearChatInput", "{}");
            zfeLog("info", "nativein", "clearChatInput raw=" + clip200(c1));
            var c2:String = callTop("setChatInputActive", "false");   // bare "false", NOT JSON
            zfeLog("info", "nativein", "setChatInputActive(false) raw=" + clip200(c2));
        } catch (e:Dynamic) {
            closeFailed = true;
            zfeLog("warn", "nativein", "native close threw: " + Std.string(e));
        }
        if (_nativeInputCommandFailed || closeFailed || failed) {
            _nativeInputUsable = false;
            zfeLog("warn", "nativein", "native input disabled until relay reconnect");
        }
        // Restore game routing only when this widget owns the lock; keep retrying if the HUD
        // domain is temporarily unavailable rather than silently forgetting the ownership.
        releaseEditTextLock();
        _inputOpen   = false;
        _nativeInput = false;
        _inProgress  = "";
        setPrompt(idlePrompt());
    }

    // =========================================================================
    // SharedHUDTools text-entry (FALLBACK)
    // =========================================================================

    // Dispatch a PlatformChangeEvent(PC_KB_MOUSE) so SharedHUDTools.startTextEdit picks the native
    // keyboard field (stage.focus = entry_tf) instead of the on-screen-keyboard/controller path.
    // HUDModLoader releases have used both the three- and four-argument event constructor, so
    // try the current four-argument form and fall back to the upstream three-argument form.
    function forceKeyboardPlatform():Void {
        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("Shared.AS3.Events.PlatformChangeEvent");
            var ev:Dynamic = null;
            try {
                ev = untyped __new__(cls, 0, false, 0, 0);
            } catch (_:Dynamic) {
                ev = untyped __new__(cls, 0, false, 0);
            }
            if (stage != null) {
                stage.dispatchEvent(ev);
                zfeLog("info", "input", "forced PC_KB_MOUSE platform (keyboard editing/backspace)");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "forceKeyboardPlatform threw: " + Std.string(e));
        }
    }

    function openInputSharedHudTools():Void {
        if (_inputOpen) return;
        if (_hudTools == null) {
            constructHudTools();
            if (_hudTools == null) {
                zfeLog("warn", "input", "SharedHUDTools unavailable; cannot open input");
                return;
            }
        }
        _inputOpen = true;
        setPrompt(typingPrompt());
        zfeLog("info", "input path", "shared-hud-tools");

        // ── Step 0: force KEYBOARD input mode (fixes backspace) ─────────────
        // SharedHUDTools.startTextEdit uses stage.focus = entry_tf (native TextField editing,
        // incl. Backspace) ONLY when isInputKeyboard() is true — i.e. uiController ==
        // PLATFORM_PC_KB_MOUSE (0). Under Proton/Steam Input the game reports a controller, so it
        // falls to the on-screen-keyboard path (we push off-screen) and Backspace does nothing.
        // Dispatch a PlatformChangeEvent(PC_KB_MOUSE) on the stage BEFORE TextEdit so HUDTools
        // switches to keyboard mode (must be before entryMode — the same handler ends an active edit).
        forceKeyboardPlatform();

        // ── Step 1: FormatTextEdit — position + style the entry box ─────────
        // x/y are stage coordinates (1920×1080 space). Position at widget's lower edge.
        // Color args are hex strings WITHOUT '#'. Font arg is the engine body alias.
        var editX:Float = x + 6;
        var editY:Float = y + _cfg.height - INPUT_H + 4;
        var editW:Float = _cfg.width - 12;
        var editH:Float = INPUT_H - 6;

        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatTextEdit"),
                [editX, editY, editW, editH,
                 FONT_BODY,                  // engine alias — matches HUDTools' entry_tf default ($MAIN_Font_Light)
                 _cfg.fontSize,
                 nh(_cfg.tabActiveColor),    // text color — no '#'
                 nh(_cfg.tabRowColor),       // bg color — no '#'
                 0.96]);                    // bg alpha (>0 triggers background rendering)
            zfeLog("info", "input", "FormatTextEdit ok");
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "FormatTextEdit threw: " + Std.string(e));
        }

        // ── Step 2: FormatOnScreenKeyboard — REQUIRED even on PC/KB/mouse ───
        // Position off-screen (y=-300) so the gamepad OSK is invisible on PC.
        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatOnScreenKeyboard"),
                [0.0, -300.0]);
            zfeLog("info", "input", "FormatOnScreenKeyboard ok");
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "FormatOnScreenKeyboard threw: " + Std.string(e));
        }

        // ── Step 3: TextEdit — open the entry; callback fires on submit ──────
        try {
            Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "TextEdit"),
                [function(text:Dynamic):Void { onInputSubmit(text); }, ""]);
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "TextEdit threw: " + Std.string(e));
            _inputOpen = false;
            setPrompt(idlePrompt());
            return;
        }
        // HUDTools renders its own focused entry field at this exact input position.
        // Do not mirror that same field into _promptTf, or every character appears twice.
        setPrompt(typingPrompt());
        zfeLog("info", "input", "opened");
    }

    /**
     * Callback from SharedHUDTools.TextEdit.
     * text == null: user cancelled (Esc/Tab) or TextEdit failed.
     * text == String: user submitted (Enter); may be empty.
     * Fires exactly once; textFunction is nulled by SharedHUDTools after.
     */
    function onInputSubmit(text:Dynamic):Void {
        _inputOpen = false;
        setPrompt(idlePrompt());
        var s:String = (text == null) ? "" : Std.string(text);
        handleSubmittedText(s);
    }

    /**
     * Shared submit handler — used by BOTH the native input path (pollNativeInput) and
     * the SharedHUDTools fallback (onInputSubmit). Applies the slash channel-switch
     * logic ("/g /t /e /i /r"), consuming a bare slash command, then sends the rest.
     */
    function handleSubmittedText(text:String):Void {
        var s:String = (text == null) ? "" : Std.string(text);
        s = StringTools.trim(s);
        if (s.length == 0) return;

        // /hide — hide the panel (CAP-011). Consume: never send. Restore with the open key.
        if (s.toLowerCase() == "/hide") { hide(); return; }

        // Staff-only, local HUD commands. They are parsed before channel switches so a
        // moderation request can never fall through and become a public chat message.
        // Authorization is still repeated by the relay from the linked Discord role.
        if (handleModerationCommand(s)) return;

        // Slash-command channel switch: "/g /t /e /i /r" (or ".g" alias).
        // If the whole input IS a slash command (bare or with trailing content),
        // consume it — never let it leak through as a chat message.
        // The engine EATS leading "/" and "." keystrokes in keyboard-edit mode, so
        // "/t" reaches us as "t". Treat a bare channel token as the ENTIRE message
        // as a switch — restores slash-command UX. (Cost: a literal one-word "t"/
        // "trade" can't be sent as chat; acceptable.)
        var bare:String = s.toLowerCase();
        if (bare == "g" || bare == "gen" || bare == "general"
            || bare == "t" || bare == "trade" || bare == "trading"
            || bare == "e" || bare == "event" || bare == "events"
            || bare == "i" || bare == "inf" || bare == "infests"
            || bare == "r" || bare == "raid" || bare == "raids"
            || bare == "s" || bare == "server") {
            if (switchChannelBySlash(bare)) {
                zfeLog("info", "chan", "bare-token switch: " + bare);
                return;
            }
        }
        if (s.length > 1 && (s.charAt(0) == "/" || s.charAt(0) == ".")) {
            var spaceIdx:Int = s.indexOf(" ");
            var slashCmd:String = (spaceIdx > 0) ? s.substr(1, spaceIdx - 1) : s.substr(1);
            if (switchChannelBySlash(slashCmd)) {
                // Slash consumed — send remaining text (after the space) if any.
                var rest:String = (spaceIdx > 0) ? StringTools.trim(s.substr(spaceIdx + 1)) : "";
                if (rest.length == 0) return;  // bare "/g" — done, do NOT send
                s = rest;                       // "/g hello" — send "hello" to the new channel
            }
        }

        sendMessage(s);
    }

    // =========================================================================
    // Moderation commands — staff-only HUD surface
    //
    // Commands accept an exact visible player name (quote multi-word names) or the
    // [#XXXXXXXX] reference rendered beside a visible message. Both resolve locally
    // to immutable relay IDs; the server validates the resolved IDs again.
    // =========================================================================

    function nextWord(input:String):{word:String, rest:String} {
        var s:String = StringTools.trim(input == null ? "" : input);
        if (s.length == 0) return { word: "", rest: "" };
        var i:Int = 0;
        while (i < s.length && s.charAt(i) != " " && s.charAt(i) != "\t") i++;
        return { word: s.substr(0, i), rest: StringTools.trim(s.substr(i)) };
    }

    function readModerationTarget(input:String):{target:String, rest:String, valid:Bool, quoted:Bool} {
        var s:String = StringTools.trim(input == null ? "" : input);
        if (s.length == 0) return { target: "", rest: "", valid: false, quoted: false };
        if (s.charAt(0) == "\"") {
            var close:Int = 1;
            while (close < s.length && s.charAt(close) != "\"") close++;
            if (close >= s.length) return { target: "", rest: "", valid: false, quoted: true };
            var quotedTarget:String = StringTools.trim(s.substr(1, close - 1));
            return {
                target: quotedTarget,
                rest: StringTools.trim(s.substr(close + 1)),
                valid: quotedTarget.length > 0,
                quoted: true,
            };
        }
        var word = nextWord(s);
        return { target: word.word, rest: word.rest, valid: word.word.length > 0, quoted: false };
    }

    function isVisibleModerationRecord(rec:ChatRecord, activeChannel:String):Bool {
        return rec.channel == activeChannel
            && rec.messageId != null && rec.messageId.length >= 8
            && rec.senderUserId != null && rec.senderUserId.length > 0;
    }

    function findModerationTargetByReference(reference:String):Null<ChatRecord> {
        var ref:String = StringTools.trim(reference == null ? "" : reference).toLowerCase();
        if (StringTools.startsWith(ref, "#")) ref = ref.substr(1);
        if (ref.length != 8) return null;
        var activeChannel:String = CHAN_SLUGS[_chanIdx];
        for (rec in _records) {
            if (!isVisibleModerationRecord(rec, activeChannel)) continue;
            if (rec.messageId.substr(0, 8).toLowerCase() == ref) return rec;
        }
        return null;
    }

    function resolveModerationTarget(targetInput:String):ModerationTargetResolution {
        var rawTarget:String = StringTools.trim(targetInput == null ? "" : targetInput);
        if (StringTools.startsWith(rawTarget, "#")) {
            return { target: findModerationTargetByReference(rawTarget), ambiguous: false };
        }

        var normalizedName:String = rawTarget.toLowerCase();
        if (normalizedName.length == 0) return { target: null, ambiguous: false };
        var activeChannel:String = CHAN_SLUGS[_chanIdx];
        var candidate:Null<ChatRecord> = null;
        for (rec in _records) {
            if (!isVisibleModerationRecord(rec, activeChannel)) continue;
            if (StringTools.trim(rec.user).toLowerCase() != normalizedName) continue;
            if (candidate != null && candidate.senderUserId != rec.senderUserId) {
                return { target: null, ambiguous: true };
            }
            // Records are chronological; delete-by-name should act on this user's latest row.
            candidate = rec;
        }
        return { target: candidate, ambiguous: false };
    }

    function moderationHelp():String {
        return "HUD MODERATION\n"
            + "Use an exact visible name (quote names with spaces), or [#XXXXXXXX]:\n"
            + "/mod Alice mute [minutes] [reason]\n"
            + "/mod \"Alice Smith\" kick [reason]\n"
            + "/mod #ref delete [reason]\n"
            + "/mod #ref kick [reason]\n"
            + "/mod #ref mute [minutes] [reason]\n"
            + "/mod #ref unmute [reason]\n"
            + "/mod #ref ban [minutes|permanent] [reason]\n"
            + "/mod #ref unban [reason]\n"
            + "Slow mode is not available.";
    }

    function moderationError(code:String, message:String):Void {
        var text:String = "Moderation failed";
        if (code == "permission_denied") text = "Moderation denied. Your linked staff role may have changed.";
        else if (code == "user_banned" || code == "user_kicked") text = "Chat session ended - reconnecting...";
        else if (message != null && message.length > 0) text += ": " + message;
        else if (code != null && code.length > 0) text += ": " + code;
        setLogText(FcmConfig.htmlEscape(text));
        if (code == "auth_token_invalid" || code == "auth_token_revoked" || code == "user_banned" || code == "user_kicked") {
            _connected = false;
            stopPollTimer();
            scheduleConnectRetry();
        }
    }

    function removeLocalMessage(messageId:String):Void {
        if (messageId == null || messageId.length == 0) return;
        for (i in 0..._records.length) {
            if (_records[i].messageId == messageId) {
                _records.splice(i, 1);
                renderRecords();
                return;
            }
        }
    }

    function submitModerationAction(action:String, target:ChatRecord, durationMinutes:Int, reason:String):Void {
        if (_api == null || !_connected || !_canModerate) {
            setLogText("Moderation is unavailable until your linked staff role is verified.");
            return;
        }
        reason = fcmClean(reason);
        if (reason.length == 0) {
            setLogText("A moderation reason is required.");
            return;
        }
        if (reason.length > 500) reason = reason.substr(0, 500);

        var messageId:String = action == "deleteMessage" ? target.messageId : "";
        var targetUserId:String = action == "deleteMessage" ? "" : target.senderUserId;
        var payload:String = '{"action":"' + jsonEscape(action)
            + '","messageId":"' + jsonEscape(messageId)
            + '","targetUserId":"' + jsonEscape(targetUserId)
            + '","durationMinutes":' + durationMinutes
            + ',"category":"Other","reason":"' + jsonEscape(reason) + '"}';
        try {
            var raw:String = Std.string(_api.call("chat.v1.moderationAction", payload));
            var success:Bool = raw.indexOf('"success":true') >= 0 || raw.indexOf('success:true') >= 0;
            if (!success) {
                moderationError(extractJsonString(raw, "code"), extractJsonString(raw, "message"));
                return;
            }
            if (action == "deleteMessage") removeLocalMessage(target.messageId);
            zfeLog("info", "moderation", "submitted action=" + action);
            setLogText("Moderation action submitted: " + action + ".");
        } catch (e:Dynamic) {
            zfeLog("warn", "moderation", "request threw: " + Std.string(e));
            setLogText("Moderation request failed (no relay).");
        }
    }

    /** Returns true only when the input is a /mod (or ZFE-stripped mod) command. */
    function handleModerationCommand(input:String):Bool {
        var s:String = StringTools.trim(input == null ? "" : input);
        if (StringTools.startsWith(s, "/") || StringTools.startsWith(s, ".")) s = StringTools.trim(s.substr(1));
        var command = nextWord(s);
        if (command.word.toLowerCase() != "mod") return false;
        if (!_canModerate) {
            setLogText("Moderation commands require a linked staff account.");
            return true;
        }

        var targetPart = readModerationTarget(command.rest);
        if (!targetPart.valid || (!targetPart.quoted && targetPart.target.toLowerCase() == "help")) {
            setLogText(moderationHelp());
            return true;
        }
        var actionPart = nextWord(targetPart.rest);
        if (actionPart.word.length == 0) {
            setLogText(moderationHelp());
            return true;
        }
        var resolution:ModerationTargetResolution = resolveModerationTarget(targetPart.target);
        var target = resolution.target;
        if (target == null) {
            if (resolution.ambiguous) {
                setLogText("That name matches multiple visible players. Use [#XXXXXXXX].");
            } else if (StringTools.startsWith(targetPart.target, "#")) {
                setLogText("That moderation reference is not visible in this channel.");
            } else {
                setLogText("That player name is not visible in this channel.");
            }
            return true;
        }

        var action:String = actionPart.word.toLowerCase();
        var rest:String = actionPart.rest;
        switch (action) {
            case "delete":
                submitModerationAction("deleteMessage", target, 0, rest);
            case "kick":
                submitModerationAction("kickUser", target, 0, rest);
            case "unmute":
                submitModerationAction("unmuteUser", target, 0, rest);
            case "unban":
                submitModerationAction("unbanUser", target, 0, rest);
            case "mute":
                var durationPart = nextWord(rest);
                var minutes:Null<Int> = Std.parseInt(durationPart.word);
                if (minutes == null || minutes <= 0 || minutes > 30 * 24 * 60) {
                    setLogText("Mute duration must be 1 to 43200 minutes.");
                } else {
                    submitModerationAction("muteUser", target, minutes, durationPart.rest);
                }
            case "ban":
                var durationPart = nextWord(rest);
                var durationWord:String = durationPart.word.toLowerCase();
                var minutes:Null<Int> = (durationWord == "perm" || durationWord == "permanent")
                    ? 0 : Std.parseInt(durationWord);
                if (minutes == null || minutes < 0 || minutes > 30 * 24 * 60) {
                    setLogText("Ban duration must be minutes or permanent.");
                } else {
                    submitModerationAction("banUser", target, minutes, durationPart.rest);
                }
            default:
                setLogText(moderationHelp());
        }
        return true;
    }

    // =========================================================================
    // Send path — chat.v1
    // =========================================================================

    function sendMessage(raw:String):Void {
        if (_api == null || !_connected) {
            zfeLog("warn", "send", "not connected; cannot send");
            return;
        }
        if (_authState != "authenticated") {
            zfeLog("warn", "send", "send blocked; authState=" + _authState + " (account not linked)");
            setLogText(linkHint());
            return;
        }

        if (raw.length > _cfg.maxSendLen) raw = raw.substr(0, _cfg.maxSendLen);
        raw = fcmClean(raw);
        if (raw.length == 0) return;

        var slug:String = CHAN_SLUGS[_chanIdx];
        if (slug == "server" && !_serverSessionReady) {
            // Never send ordinary server traffic until the same relay has acknowledged the
            // roster/world control. This avoids presenting a selectable dead tab during a
            // delayed deploy, reconnect, or rejected control.
            setLogText(_serverSessionError.length > 0
                ? ("Server chat is unavailable: " + _serverSessionError)
                : "Server chat is initializing...");
            zfeLog("warn", "server", "ordinary send blocked; session not ready");
            return;
        }
        var payload:String = '{"channel":"' + jsonEscape(slug) + '","targetUserId":"","body":"' + jsonEscape(raw) + '"}';
        zfeLog("info", "send", "payload ch=" + slug + " len=" + raw.length);
        try {
            // sendMessage is chat.v1.sendMessage ONLY — never bare. Bare hits the
            // useless legacy bridge (returns literal `false`) → false "Send failed."
            var rs:String = Std.string(_api.call("chat.v1.sendMessage", payload));
            // Diagnostics deliberately do NOT log the payload: it carries the player's message
            // text, and `[send] payload ch=/len=` above already records channel + length. The
            // response is logged only on FAILURE (below) — it holds the relay/ZFE error, never
            // user content. logSafe() is what makes either readable: zfeLog jsonEscapes its
            // message, a quote becomes an escape, and ZFE's writer truncates at the backslash.
            // v2.5.3 diagnostic: when this send is from a just-closed native session,
            // log the FULL raw result so we learn whether send works in that context.
            if (_nativeSubmitInFlight) {
                _nativeSubmitInFlight = false;
                zfeLog("info", "nativein", "send-in-session raw=" + clip200(rs));
            }
            var success:Bool = (rs.indexOf('"success":true') >= 0 || rs.indexOf('success:true') >= 0);
            if (success) {
                zfeLog("info", "send", "sent ch=" + slug + " len=" + raw.length);
                // A successful send proves this identity is LINKED — clear the link gate.
                if (_needsLink) { clearLinkGate("successful send"); }
                // Register the confirmed send for authoritative live-echo reconciliation
                // (only when we know our id). ZFE strips the additive fields and targetUserId
                // carrier from this native RPC response, so an optimistic row here would be
                // visibly untagged until the subscriber echo arrived. The live event is the
                // first reliable source for the sender's resolved cosmetics.
                if (_relayUserId.length > 0) {
                    var messageId:String = extractJsonString(rs, "messageId");
                    var ackTag:String = extractJsonString(rs, "tag");
                    var ackStarColor:String = extractJsonString(rs, "starColor");
                    // ZFE may strip the additive cosmetic members from native RPC
                    // responses, just as it does for live event frames. v2.10.16+
                    // relays mirror them in the known targetUserId member.
                    var ackHudTransport:String = extractJsonString(rs, "targetUserId");
                    var ackTransportTag:String = FcmConfig.hudTransportTag(ackHudTransport);
                    var ackTransportStarColor:String = FcmConfig.hudTransportStarColor(ackHudTransport);
                    if (ackTransportTag.length > 0) ackTag = ackTransportTag;
                    if (ackTransportStarColor.length > 0) ackStarColor = ackTransportStarColor;
                    var ackSupporterStar:Bool = FcmConfig.supporterStarPresent(
                        extractJsonBool(rs, "supporterStar")
                            || FcmConfig.hudTransportHasStar(ackHudTransport), ackStarColor);
                    zfeLog("info", "cosmetics", "sendAck len=" + rs.length
                        + " tag=" + (ackTag.length > 0 ? "y" : "n")
                        + " star=" + (ackSupporterStar ? "y" : "n")
                        + " color=" + (ackStarColor.length > 0 ? "y" : "n"));
                    var dedupKey:String = (messageId.length > 0)
                        ? echoIdKey(messageId)
                        : echoSbKey(_relayUserId, slug, raw);
                    _pendingEchoes.push({ key: dedupKey, ts: flash.Lib.getTimer() });
                    // Do not paint a second-class local row when the native ACK has no
                    // authoritative cosmetics. The subscriber event below is rendered as
                    // the canonical row, preserving tag/star data for new messages.
                    zfeLog("info", "echo", "awaiting authoritative live echo ch=" + slug
                        + " ackCosmetics=" + ((ackTag.length > 0 || ackSupporterStar) ? "y" : "n"));
                }
                scheduleEchoPoll();
            } else {
                // Surface the relay error code to the user.
                var code:String = extractJsonString(rs, "code");
                // Failure only: the untruncated response. This is the line that finally exposed
                // the v2.9.12 root cause after days of unreadable `raw={\` output.
                zfeLog("warn", "diag", "RSLEN=" + rs.length + " RSSAFE=" + logSafe(rs).substr(0, 300));
                // "send rejected" — NOT "relay rejected". A 1 ms rejection with no relay-side
                // ingress proves ZFE can reject locally without the frame ever leaving the
                // machine (2026-08-06). Do not re-attribute this to the relay without
                // ingress evidence.
                zfeLog("warn", "send", "send rejected code=" + code + " raw=" + rs.substr(0, 200));
                switch (code) {
                    case "permission_denied":
                        // Genuine not-linked / insufficient-role only (automod + slash now have
                        // their own codes below, so this no longer fires for filtered messages).
                        // A denied send confirms we're NOT linked → drive the persistent gate.
                        _needsLink = true;
                        setLogText(linkHint());
                    case "message_blocked":
                        setLogText("Message blocked by the chat filter.");
                    case "slash_ignored":
                        setLogText("Slash commands work in the dashboard, not in-game.");
                    case "user_muted":
                        setLogText("You are muted and cannot send right now.");
                    case "rate_limited":
                        setLogText("Sending too fast - slow down.");
                    case "invalid_channel":
                        if (slug == "server") {
                            setServerSessionReady(false, extractJsonString(rs, "message"));
                            setLogText(_serverSessionError.length > 0
                                ? ("Server chat is unavailable: " + _serverSessionError)
                                : "Server chat is initializing...");
                        } else {
                            setLogText("That channel is not available.");
                        }
                    case "message_too_long":
                        setLogText("Message too long (max " + _cfg.maxSendLen + ").");
                    case "auth_token_invalid", "auth_token_revoked", "user_banned":
                        setLogText("Chat session ended - reconnecting...");
                        if (_nativeInput) closeInputNative();
                        setServerSessionReady(false, "");
                        _connected = false;
                        stopPollTimer();
                        scheduleConnectRetry();
                    default:
                        setLogText(code.length > 0 ? ("Send failed: " + code) : "Send failed.");
                }
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "send", "sendMessage threw: " + Std.string(e));
            setLogText("Send failed (no relay).");
        }
    }

    // =========================================================================
    // ZFE API discovery + chat.v1 boot
    // =========================================================================

    /**
     * init() — entry point called 3 s after stage attach.
     *
     * ZFE installs __ZFE on the HUDMenu root a few seconds after dxgi.dll loads.
     * Retry every ZFE_SEARCH_MS ms up to ZFE_SEARCH_MAX times (~30 s total).
     */
    function init():Void {
        _zfeSearchTries = 0;
        tryFindZfe();
    }

    function tryFindZfe():Void {
        _zfeSearchTries++;
        _api = findZfeApi(this);
        if (_api != null) {
            onZfeFound();
            return;
        }
        if (_zfeSearchTries >= ZFE_SEARCH_MAX) {
            setLogText("ZFE not found\nInstall dxgi.dll + zfe.ini");
            return;
        }
        setLogText("searching for ZFE (" + _zfeSearchTries + "/" + ZFE_SEARCH_MAX + ")...");
        if (_zfeSearchTimer != null) { _zfeSearchTimer.stop(); _zfeSearchTimer = null; }
        _zfeSearchTimer = new Timer(ZFE_SEARCH_MS, 1);
        _zfeSearchTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _zfeSearchTimer = null;
            tryFindZfe();
        });
        _zfeSearchTimer.start();
    }

    function onZfeFound():Void {
        if (_zfeSearchTimer != null) { _zfeSearchTimer.stop(); _zfeSearchTimer = null; }

        // Capability gate: zfe-chat-online-v1 required (ZFE 0.9.8+).
        try {
            var info:String = Std.string(_api.call("chat.v1.getRuntimeInfo", "{}"));
            if (info.indexOf("zfe-chat-online-v1") < 0) {
                zfeLog("warn", "startup", "zfe-chat-online-v1 not present; need ZFE 0.9.8+");
                setLogText("ZFE 0.9.8+ required\nfor chat.v1");
                return;
            }
            zfeLog("info", "startup", VENDOR + " " + VERSION + " loaded");
            zfeLog("info", "startup", "BUILD=chatv1-widget-v" + VERSION);
            zfeLog("info", "startup", "zfe-chat-online-v1 OK");
            zfeLog("info", "startup", "found after " + _zfeSearchTries + " attempt(s)");
        } catch (e:Dynamic) {
            zfeLog("warn", "startup", "getRuntimeInfo threw: " + Std.string(e));
        }

        loadPersistedConfig();
        startConnect();
    }

    // =========================================================================
    // chat.v1 connect / reconnect
    // =========================================================================

    function resetFalloutIdentity():Void {
        _falloutIdentityReady = false;
        _displayName = "Wanderer";
    }

    function startConnect():Void {
        resetFalloutIdentity();
        if (_api == null) return;
        _connectAttempts++;
        // Re-read the public FO76 account handle each attempt until AccountInfoData has it.
        // Never substitute CharacterInfoData: that is the local character label, not the name
        // other Fallout 76 players see. The retry timer probes later without re-entering a live
        // native connection, and HUD data callbacks only update local state.
        refreshDisplayName();
        if (!hasResolvedDisplayName()) {
            zfeLog("info", "connect", "player identity not ready; delaying connect");
            setLogText("waiting for Fallout 76 player name...");
            scheduleConnectRetry();
            return;
        }
        zfeLog("info", "connect", "attempt=" + _connectAttempts);
        setLogText("connecting...");

        // clientVersion lets the relay tell which widget build it is talking to, so any
        // future wire-format addition can be gated on capability instead of shipped
        // blind. Before this, VERSION only ever reached the local ZFE log.
        //
        // This matters because the .ba2 is a MANUAL file copy — no auto-update, no way
        // to retire an old build — so older widgets stay in circulation indefinitely.
        // Without the handshake, a relay that started emitting a new field would render
        // it as visible garbage inside usernames on every stale client, permanently.
        var payload:String = '{"displayName":"' + jsonEscape(_displayName) + '","autoRegister":true,"clientVersion":"' + VERSION + '"}';
        var result:Dynamic = null;
        try {
            result = _api.call("chat.v1.connect", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "connect", "call threw: " + Std.string(e));
            scheduleConnectRetry();
            return;
        }

        var rs:String = Std.string(result);
        if (rs.indexOf('"success":true') < 0 && rs.indexOf('success:true') < 0) {
            zfeLog("warn", "connect", "failed: " + rs.substr(0, 200));
            scheduleConnectRetry();
            return;
        }

        _connected = true;
        // Native input is probed lazily on the first open. Never activate it at startup:
        // legacy Windows/ZFE builds can expose the bare probe payload as editable text.
        _nativeInputUsable = true;
        // A new relay connection has no room membership until the fresh control below is
        // acknowledged. Force a roster send even when the observed names did not change.
        setServerSessionReady(false, "");
        _lastRosterSentAt = 0;
        _lastRosterSent = "";
        _lastWorldId = ""; // force the legacy worldId fallback to rebind after reconnect
        _connectDelay = CONNECT_RETRY_MS;
        // The link gate is NOT cleared here (v2.9.7). The relay's link notice is a one-shot
        // push, so "no notice arrived on this connect" does not mean "linked" — it usually
        // means the push was missed. Staying unlinked until proven otherwise keeps the link
        // screen reachable; a "LINK COMPLETE" notice or a successful send clears it, and the
        // relay re-pushes a fresh code on subscribe while the identity is still limited.
        zfeLog("info", "connect", "connected"
            + (_needsLink ? " (link gate still up)" : ""));
        setLogText(_needsLink ? linkHint() : "connected. loading...");

        bumpAutoHide();   // start the idle countdown (hides after autoHideSec if nothing happens)
        refreshAuthState();
        _cursor = 0;
        startPollTimer();
        requestHistoryResync();
        startWorldTimer();
        startOpenKeyTimer();
    }

    /**
     * Tear down the live session and schedule a reconnect. Every caller previously inlined
     * this same four-step sequence; keeping it in one place stops the paths from drifting.
     */
    function forceReconnect(reason:String):Void {
        zfeLog("warn", "connect", "reconnecting: " + reason);
        resetFalloutIdentity();
        if (_nativeInput) closeInputNative();
        setServerSessionReady(false, "");
        _connected = false;
        stopPollTimer();
        stopEchoPollTimer();
        scheduleConnectRetry();
    }

    /** Clear the link gate — only ever called with PROOF the identity is linked. */
    function clearLinkGate(reason:String):Void {
        _needsLink          = false;
        _pinnedSystemBody   = "";
        _linkNoticeAt       = 0;
        _linkRefreshPending = false;
        zfeLog("info", "system", "link gate cleared: " + reason);
    }

    /** True when a pinned link code has outlived its usable lifetime. */
    function linkCodeStale(now:Float):Bool {
        if (!_needsLink || _linkNoticeAt <= 0) return false;
        return (now - _linkNoticeAt) >= LINK_CODE_REFRESH_MS;
    }

    /**
     * Drop the connection once when the on-screen code goes stale. The relay pushes a fresh
     * link notice on the next subscribe while the identity is still limited
     * (relayHandler.ts handleSubscribe), so a reconnect is how the widget asks for a new code.
     */
    function maybeRefreshLinkCode():Void {
        if (_linkRefreshPending || !linkCodeStale(flash.Lib.getTimer())) return;
        _linkRefreshPending = true;
        _pinnedSystemBody   = "";
        setLogText(linkHint());
        forceReconnect("link code expired; requesting a fresh one");
    }

    function scheduleConnectRetry():Void {
        if (_connectTimer != null) return;
        _connectTimer = new Timer(_connectDelay, 1);
        _connectTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _connectTimer = null;
            _connectDelay = Std.int(Math.min(_connectDelay * 2, CONNECT_MAX_MS));
            startConnect();
        });
        _connectTimer.start();
        setLogText("retrying in " + Std.int(_connectDelay / 1000) + "s...");
    }

    // =========================================================================
    // chat.v1 auth state
    // =========================================================================

    function refreshAuthState():Void {
        if (_api == null) return;
        try {
            var state:String = Std.string(_api.call("chat.v1.getAuthState", "{}"));
            var uid:String = extractJsonString(state, "userId");
            if (uid.length > 0) {
                _userId = uid;
                _relayUserId = uid;
                zfeLog("info", "auth", "relay identity available");
            }
            var prevAuth:String = _authState;
            var prevCanModerate:Bool = _canModerate;
            if (state.indexOf('"state":"authenticated"') >= 0 || state.indexOf('state:"authenticated"') >= 0) {
                _authState = "authenticated";
            } else {
                _authState = "limited";
            }
            _canModerate = extractJsonBool(state, "canDeleteMessage")
                || extractJsonBool(state, "canKickUser")
                || extractJsonBool(state, "canMuteUser")
                || extractJsonBool(state, "canUnmuteUser")
                || extractJsonBool(state, "canBanUser")
                || extractJsonBool(state, "canUnbanUser");
            if (_authState != prevAuth || _canModerate != prevCanModerate) {
                zfeLog("info", "auth", "authState=" + _authState + " moderation=" + (_canModerate ? "yes" : "no"));
                renderRecords();
            }
            if (_authState != "authenticated" && _connected) {
                forceReconnect("ZFE auth state not authenticated");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "auth", "getAuthState threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // Open-key poll — open chat on the configured ZFE OpenChatKey edge
    //
    // Replaces the v2.5.2 always-on watcher. Low-rate (~150 ms), runs only while
    // connected AND no input is open. On a false->true edge of isChatKeyPressed it
    // calls openInput(). It does NOT consume/read outside an open session.
    // =========================================================================

    function startOpenKeyTimer():Void {
        if (_openKeyTimer != null) { _openKeyTimer.stop(); _openKeyTimer = null; }
        _lastChatKey = false;
        _openKeyTimer = new flash.utils.Timer(OPEN_KEY_MS);
        _openKeyTimer.addEventListener(TimerEvent.TIMER, function(_) { pollOpenKey(); });
        _openKeyTimer.start();
        zfeLog("info", "nativein", "open-key poll started (" + OPEN_KEY_MS + "ms)");
    }

    function stopOpenKeyTimer():Void {
        if (_openKeyTimer != null) { _openKeyTimer.stop(); _openKeyTimer = null; }
    }

    /** Open chat on a false->true edge of isChatKeyPressed. */
    function pollOpenKey():Void {
        if (_api == null || !_connected) return;
        try {
            // The OpenChatKey is the ONE key a HUD widget can read (isChatKeyPressed). FO76
            // collapses every other unbound key to "Unmapped" (indistinguishable), so this is
            // the only key-driven control we get. On its rising edge: open chat when closed;
            // cycle to the next channel when already open. Slash (/g /t /e /i /r) covers direct
            // jumps + reverse. (Hidden: openInput() un-hides first.)
            var kp:Bool = nativeTruthy(callTop("isChatKeyPressed", "{}"));
            if (kp && !_lastChatKey) {
                if (!_inputOpen) {
                    zfeLog("info", "nativein", "OpenChatKey edge; opening input");
                    openInput();
                }
                // No cycle-on-second-press: it fired accidentally (key repeat / double-tap
                // while typing). Channels switch via the clickable tabs, slash commands
                // (/g /t /e /i /r), NextPage/PrevPage actions, or the F11 menu.
            }
            _lastChatKey = kp;
        } catch (e:Dynamic) {
            zfeLog("warn", "nativein", "pollOpenKey threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // chat.v1 poll events
    // =========================================================================

    function startPollTimer():Void {
        stopPollTimer();
        _pollTimer = new Timer(_cfg.pollMs);
        _pollTimer.addEventListener(TimerEvent.TIMER, function(_) { pollEvents(); });
        _pollTimer.start();
        pollEvents(); // immediate first poll for history
    }

    /** Poll once on the next event tick after a successful send for a fast authoritative echo. */
    function scheduleEchoPoll():Void {
        if (_sendEchoPollTimer != null) return;
        _sendEchoPollTimer = new flash.utils.Timer(SEND_ECHO_POLL_DELAY_MS, 1);
        _sendEchoPollTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _sendEchoPollTimer = null;
            if (_api != null && _connected) {
                zfeLog("info", "echo", "polling after send");
                pollEvents();
            }
        });
        _sendEchoPollTimer.start();
    }

    function stopPollTimer():Void {
        if (_pollTimer != null) { _pollTimer.stop(); _pollTimer = null; }
    }

    function stopEchoPollTimer():Void {
        if (_sendEchoPollTimer != null) { _sendEchoPollTimer.stop(); _sendEchoPollTimer = null; }
    }

    /**
     * HUDModLoader can recreate this SWF while ZFE retains its native subscriber.
     * That subscriber's queue is already drained, so request static history before
     * submitting a fresh roster/world bind for the new game server.
     */
    function requestHistoryResync():Void {
        if (_api == null || !_connected) return;
        var payload:String = '{"channel":"server","targetUserId":"","body":"' + HISTORY_RESYNC_PREFIX + '"}';
        try {
            var raw:String = Std.string(_api.call("chat.v1.sendMessage", payload));
            if (raw.indexOf('"success":true') >= 0 || raw.indexOf('success:true') >= 0) {
                zfeLog("info", "history", "resync requested");
            } else {
                zfeLog("warn", "history", "resync rejected raw=" + clip200(raw));
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "history", "resync threw: " + Std.string(e));
        }
    }

    function pollEvents():Void {
        if (_api == null || !_connected) return;
        // Swap an expired link code for a fresh one before doing anything else — the reconnect
        // this may trigger tears down the poll timer we are running on.
        maybeRefreshLinkCode();
        if (!_connected) return;
        var payload:String = '{"max":64,"cursor":' + _cursor + '}';
        var result:Dynamic = null;
        try {
            result = _api.call("chat.v1.pollEvents", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "poll", "call threw: " + Std.string(e));
            notePollFailure("call threw");
            return;
        }

        var rs:String = Std.string(result);
        if (rs.indexOf('"success":false') >= 0 || rs.indexOf('success:false') >= 0) {
            if (rs.indexOf('auth_token_invalid') >= 0 || rs.indexOf('auth_token_revoked') >= 0
                    || rs.indexOf('user_banned') >= 0) {
                forceReconnect("relay returned an auth error on poll");
            } else {
                notePollFailure("relay returned an unsuccessful response");
            }
            return;
        }

        _consecutivePollFailures = 0;
        parseAndRenderEvents(rs);
    }

    /** Reconnect instead of leaving the HUD in a permanently stale "connected" state. */
    function notePollFailure(reason:String):Void {
        _consecutivePollFailures++;
        zfeLog("warn", "poll", "failure=" + _consecutivePollFailures + " reason=" + reason);
        if (_consecutivePollFailures < 3) return;
        forceReconnect("poll failure threshold reached");
    }

    function parseAndRenderEvents(rs:String):Void {
        var evStart:Int = rs.indexOf('"events":[');
        if (evStart < 0) evStart = rs.indexOf('events:[');
        if (evStart < 0) return;

        // Expire stale optimistic-echo dedup keys (>15s) so a never-arriving
        // server echo cannot permanently suppress later messages.
        expirePendingEchoes();

        var newRecords:Bool = false;
        var parsedCount:Int = 0;   // diagnostic: events seen this poll (logged below)
        var wireStarCount:Int = 0;
        var wireStarColorCount:Int = 0;
        var wireTagCount:Int = 0;
        var wireTransportCount:Int = 0;
        var ownEchoMatchedCount:Int = 0;
        var i:Int = evStart;
        while (i < rs.length) {
            var objStart:Int = rs.indexOf('{', i);
            if (objStart < 0) break;
            var j:Int = jsonObjectEnd(rs, objStart);
            if (j >= rs.length) break;
            var obj:String = rs.substring(objStart, j + 1);
            i = j + 1;

            if (obj.indexOf('"chat.message"') < 0 && obj.indexOf('chat.message') < 0) {
                updateCursorFromEvent(obj);
                continue;
            }

            var rawChannel:String   = extractJsonString(obj, "channel");
            var channel:String      = normChannel(rawChannel);
            var senderUserId:String = extractJsonString(obj, "senderUserId");
            var displayName:String  = extractJsonString(obj, "senderDisplayName");
            var tag:String          = extractJsonString(obj, "tag");
            var starColor:String    = extractJsonString(obj, "starColor");
            // ZFE's native chat bridge strips unknown additive members. The relay
            // therefore mirrors cosmetics into targetUserId for widget builds that
            // negotiated the FCMHUD/1 transport. targetUserId is empty for ordinary
            // channel messages and is never used as a real recipient here.
            var hudTransport:String = extractJsonString(obj, "targetUserId");
            var transportTag:String = FcmConfig.hudTransportTag(hudTransport);
            var transportStarColor:String = FcmConfig.hudTransportStarColor(hudTransport);
            if (transportTag.length > 0) tag = transportTag;
            if (transportStarColor.length > 0) starColor = transportStarColor;
            if (tag.length > 0) wireTagCount++;
            if (hudTransport.length > 0 && StringTools.startsWith(
                    hudTransport, FcmConfig.HUD_COSMETICS_TRANSPORT_PREFIX)) wireTransportCount++;
            var supporterStar:Bool  = FcmConfig.supporterStarPresent(
                extractJsonBool(obj, "supporterStar")
                    || FcmConfig.hudTransportHasStar(hudTransport), starColor);
            if (supporterStar) wireStarCount++;
            if (starColor.length > 0) wireStarColorCount++;
            var body:String         = extractJsonString(obj, "body");
            var messageId:String    = extractJsonString(obj, "messageId");
            var evId:Int            = extractJsonInt(obj, "id");

            // Always advance the cursor, even for skipped/deduped events.
            if (evId > _cursor) _cursor = evId;
            parsedCount++;
            if (body.length == 0) continue;

            // System channel — link handshake. "LINK COMPLETE" means the web redeem finished
            // (relay pushed it post-activation) → clear the gate and hand off to chat. Anything
            // else is the link-required code notice (relay sends it ONLY to limited identities).
            if (rawChannel == "system" || senderUserId == "system") {
                if (body.indexOf("LINK COMPLETE") >= 0) {
                    clearLinkGate("LINK COMPLETE notice");
                } else {
                    _pinnedSystemBody    = body;
                    _needsLink           = true;
                    _linkNoticeAt        = flash.Lib.getTimer();
                    _linkRefreshPending  = false;
                    zfeLog("info", "system", "link notice received -> needsLink");
                }
                newRecords = true;
                continue;
            }

            // Reconcile a pending self-send with the authoritative relay event before
            // deduping it. The relay is the source of truth for supporterStar, starColor,
            // and tag. If the native ACK was stripped and no optimistic row exists, fall
            // through so this canonical event is stored and rendered normally.
            if (isOwnEcho(messageId, senderUserId, channel, body)) {
                ownEchoMatchedCount++;
                // There was no optimistic row because the native ACK did not preserve
                // cosmetics. Fall through and store this authoritative event normally.
            }

            // Store ALL known channels (renderRecords filters to the active tab).
            // The old active-channel ingest filter silently discarded every other
            // channel's one-shot subscribe backfill — history looked empty on
            // Trading/Events/Raids/Infests forever after connect.
            if (CHAN_SLUGS.indexOf(channel) < 0) continue;
            if (!shouldRenderReplayMessage(messageId)) continue;

            _records.push({
                color: hx(_cfg.senderColor), channel: channel, user: displayName,
                tag: tag, supporterStar: supporterStar, starColor: starColor, body: body,
                messageId: messageId, senderUserId: senderUserId,
            });
            while (_records.length > _cfg.maxMessages) _records.shift();
            if (_bScrolling) _newWhileScrolled++;
            newRecords = true;
        }

        if (parsedCount > 0) zfeLog("info", "recv", "events=" + parsedCount + " cursor=" + _cursor
            + " newRecords=" + (newRecords ? "y" : "n")
            + " wireStars=" + wireStarCount + " wireStarColors=" + wireStarColorCount
            + " wireTags=" + wireTagCount + " wireTransport=" + wireTransportCount
            + " ownEchoMatched=" + ownEchoMatchedCount);
        if (newRecords) {
            if (_autoHideOn && _hidden) show();   // auto-hide: pop back up on a new message
            renderRecords();
            bumpAutoHide();                        // any new message counts as activity
        }
    }

    /** Keep replayed history from duplicating records when ZFE also makes a fresh subscribe. */
    function shouldRenderReplayMessage(messageId:String):Bool {
        if (messageId == null || messageId.length == 0) return true;
        if (_seenMessageIds.exists(messageId)) return false;
        _seenMessageIds.set(messageId, true);
        _seenMessageOrder.push(messageId);
        var cap:Int = Std.int(Math.max(256, _cfg.maxMessages * 2));
        while (_seenMessageOrder.length > cap) {
            var oldest:String = _seenMessageOrder.shift();
            _seenMessageIds.remove(oldest);
        }
        return true;
    }

    /**
     * Return the closing brace for an object beginning at `start`, honoring JSON
     * strings and escapes. Chat bodies may legitimately contain {, }, \", and \\.
     */
    static function jsonObjectEnd(s:String, start:Int):Int {
        var depth:Int = 0;
        var inString:Bool = false;
        var escaped:Bool = false;
        var j:Int = start;
        while (j < s.length) {
            var c:String = s.charAt(j);
            if (inString) {
                if (escaped) escaped = false;
                else if (c == "\\") escaped = true;
                else if (c == "\"") inString = false;
            } else if (c == "\"") {
                inString = true;
            } else if (c == "{") {
                depth++;
            } else if (c == "}") {
                depth--;
                if (depth == 0) return j;
            }
            j++;
        }
        return s.length;
    }

    /**
     * Dedup keys for optimistic echo.
     * id key  = "id:" + messageId  (server-assigned id, when present).
     * sb key  = "sb:" + senderUserId + "|" + channel + "|" + body.
     */
    static inline function echoIdKey(messageId:String):String {
        return "id:" + messageId;
    }
    static inline function echoSbKey(userId:String, channel:String, body:String):String {
        return "sb:" + userId + "|" + channel + "|" + body;
    }

    function expirePendingEchoes():Void {
        var now:Float = flash.Lib.getTimer();
        var kept:Array<{key:String, ts:Float}> = [];
        for (e in _pendingEchoes) {
            if (now - e.ts <= 15000) kept.push(e);
        }
        _pendingEchoes = kept;
    }

    /**
     * Returns true if an incoming chat.message is our own pending self-send.
     * Consumes the matched _pendingEchoes entry so the canonical live event is
     * stored exactly once.
     */
    function isOwnEcho(messageId:String, senderUserId:String, channel:String, body:String):Bool {
        // Strong signal: the relay told us our own id and it's coming back.
        if (_relayUserId.length > 0 && senderUserId == _relayUserId) {
            removePendingMatch(messageId, senderUserId, channel, body);
            return true;
        }
        // Otherwise match against pending keys.
        var idK:String = (messageId.length > 0) ? echoIdKey(messageId) : "";
        var sbUser:String = (_relayUserId.length > 0) ? _relayUserId : senderUserId;
        var sbK:String = echoSbKey(sbUser, channel, body);
        for (k in 0..._pendingEchoes.length) {
            var pk:String = _pendingEchoes[k].key;
            if ((idK.length > 0 && pk == idK) || pk == sbK) {
                _pendingEchoes.splice(k, 1);
                return true;
            }
        }
        return false;
    }

    function removePendingMatch(messageId:String, senderUserId:String, channel:String, body:String):Void {
        var idK:String = (messageId.length > 0) ? echoIdKey(messageId) : "";
        var sbUser:String = (_relayUserId.length > 0) ? _relayUserId : senderUserId;
        var sbK:String = echoSbKey(sbUser, channel, body);
        for (k in 0..._pendingEchoes.length) {
            var pk:String = _pendingEchoes[k].key;
            if ((idK.length > 0 && pk == idK) || pk == sbK) {
                _pendingEchoes.splice(k, 1);
                return;
            }
        }
    }

    function updateCursorFromEvent(obj:String):Void {
        var evId:Int = extractJsonInt(obj, "id");
        if (evId > _cursor) _cursor = evId;
    }

    // =========================================================================
    // Server-room controls: roster is primary; legacy worldId is a guarded fallback.
    // =========================================================================

    /**
     * Apply the synchronous result from a server-room control. The native bridge returns the
     * relay's response directly, so this is the acknowledgement boundary for exposing SERVER.
     */
    function applyServerControlResult(raw:String, source:String, readyOnSuccess:Bool = true):Bool {
        var ok:Bool = raw != null && (raw.indexOf('"success":true') >= 0 || raw.indexOf('success:true') >= 0);
        if (ok) {
            setServerSessionReady(readyOnSuccess, "");
            zfeLog("info", "world", source + " control acknowledged");
            return true;
        }
        var message:String = extractJsonString(raw, "message");
        if (message.length == 0) message = extractJsonString(raw, "code");
        if (message.length == 0) message = "relay did not accept the server session";
        setServerSessionReady(false, message);
        zfeLog("warn", "world", source + " control rejected raw=" + clip200(raw));
        return false;
    }

    /** Keep the tab strip, active channel, and user-facing state in sync with relay membership. */
    function setServerSessionReady(ready:Bool, error:String):Void {
        var changed:Bool = (_serverSessionReady != ready);
        _serverSessionReady = ready;
        _serverSessionError = ready ? "" : ((error == null) ? "" : error);
        if (!ready && _chanIdx == 5) _chanIdx = 0;
        if (changed) {
            rebuildChannelTabs();
            renderRecords();
        }
    }

    function startWorldTimer():Void {
        if (_worldTimer != null) { _worldTimer.stop(); _worldTimer = null; }
        _worldTimer = new Timer(WORLD_POLL_MS);
        _worldTimer.addEventListener(TimerEvent.TIMER, function(_) { checkWorldId(); });
        _worldTimer.start();
        checkWorldId();
    }

    function hasFreshRosterObservation(now:Float):Bool {
        return (now - _lastRosterObservationAt) <= ROSTER_FRESH_MS;
    }

    /** Fresh observed names (within ROSTER_FRESH_MS), pruning stale entries. */
    function freshRosterNames():Array<String> {
        var now:Float = flash.Lib.getTimer();
        var out:Array<String> = [];
        var stale:Array<String> = [];
        for (nm in _seenNames.keys()) {
            if (now - _seenNames.get(nm) <= ROSTER_FRESH_MS) out.push(nm);
            else stale.push(nm);
        }
        for (s in stale) _seenNames.remove(s);
        out.sort(function(a, b) return (a < b) ? -1 : (a > b ? 1 : 0));
        if (out.length > 16) out = out.slice(0, 16);
        return out;
    }

    /** Roster-derived world membership: send while observations are fresh. The SERVER tab is
     *  driven by the relay acknowledgement, not by this local observation. */
    function tickRoster():Void {
        if (_api == null || !_connected || _relayUserId.length == 0) return;
        var now:Float = flash.Lib.getTimer();
        var names:Array<String> = freshRosterNames();
        var wasInWorld:Bool = _inWorld;
        // In-world = we are observing the HUD's nearby-player surfaces. (These publish
        // only while loaded into a world; an empty server still counts once any
        // provider has published at least once — tracked via _worldPollCount heuristics
        // kept simple: names OR a recent observation window.)
        // A received PlayerListData update is an approved HUD-layer indication that the
        // world roster surface is live, even for a solo/empty world. It expires with the
        // same freshness window as names, so menu/stale data cannot keep SERVER alive.
        var rosterObserved:Bool = hasFreshRosterObservation(now);
        _inWorld = (names.length > 0 || rosterObserved);
        if (_inWorld) {
            var namesField:String = names.join("|");
            if (!_serverSessionReady || (now - _lastRosterSentAt) >= ROSTER_SEND_MS || namesField != _lastRosterSent) {
                _lastRosterSentAt = now;
                _lastRosterSent = namesField;
                var body:String = WORLD_ROSTER_PREFIX + namesField;
                var payload:String = '{"channel":"server","targetUserId":"","body":"' + jsonEscape(body) + '"}';
                try {
                    var raw:String = Std.string(_api.call("chat.v1.sendMessage", payload));
                    applyServerControlResult(raw, "roster");
                    zfeLog("info", "world", "roster control sent names=" + names.length);
                } catch (e:Dynamic) {
                    setServerSessionReady(false, "relay unavailable");
                    zfeLog("warn", "world", "roster send threw: " + Std.string(e));
                }
            }
        } else if (wasInWorld) {
            zfeLog("info", "world", "roster went stale; sending LEAVE");
            setServerSessionReady(false, "");
            sendWorldLeaveControl();
            _lastRosterSent = "";
        }
    }

    function checkWorldId():Void {
        if (_api == null || !_connected) return;
        _worldPollCount++;
        subscribeRoster();
        // AccountInfoData can be republished during world transitions. Re-read it for local
        // state only; refreshDisplayName never enters the native relay connection path.
        refreshDisplayName();
        tickRoster();
        if (!_dataInventoryDone && _worldPollCount >= 6) { _dataInventoryDone = true; dumpDataInventory(); }
        var worldId:String = readWorldId();
        if (worldId == _lastWorldId) return;            // no change since last poll
        // worldId is a compatibility fallback. Some HUD builds leave it blank even while the
        // roster provider is fresh, so a blank fallback value must not tear down a successful
        // roster-derived room. tickRoster() owns leave semantics when that observation expires.
        if (worldId.length == 0 && hasFreshRosterObservation(flash.Lib.getTimer())) {
            zfeLog("info", "world", "blank worldId ignored; fresh roster session remains authoritative");
            return;
        }
        var wasInWorld:Bool = _inWorld;
        _lastWorldId = worldId;
        _inWorld     = (worldId.length > 0);
        if (_inWorld) {
            // JOINED (or hopped to) a world → bind the server room.
            zfeLog("info", "world", "joined world; sending JOIN control");
            sendWorldIdControl(worldId);
        } else if (wasInWorld) {
            // LEFT the world (worldId cleared) → unbind the server room.
            zfeLog("info", "world", "left world; sending LEAVE control");
            sendWorldLeaveControl();
            setServerSessionReady(false, "");
        }
    }

    function sendWorldIdControl(worldId:String):Void {
        if (_api == null || !_connected) return;
        var body:String = WORLD_CTRL_PREFIX + worldId;
        var payload:String = '{"channel":"server","targetUserId":"","body":"' + jsonEscape(body) + '"}';
        try {
            applyServerControlResult(Std.string(_api.call("chat.v1.sendMessage", payload)), "worldId");
        } catch (e:Dynamic) {
            setServerSessionReady(false, "relay unavailable");
            zfeLog("warn", "world", "join sendMessage threw: " + Std.string(e));
        }
    }

    function sendWorldLeaveControl():Void {
        if (_api == null || !_connected) return;
        var body:String = WORLD_LEAVE_PREFIX;
        var payload:String = '{"channel":"server","targetUserId":"","body":"' + jsonEscape(body) + '"}';
        try {
            applyServerControlResult(Std.string(_api.call("chat.v1.sendMessage", payload)), "leave", false);
        } catch (e:Dynamic) {
            zfeLog("warn", "world", "leave sendMessage threw: " + Std.string(e));
        }
    }

    // =========================================================================
    // Render
    // =========================================================================

    function renderRecords():Void {
        if (_logTf == null) return;

        try {
            var ext:Dynamic = untyped __global__["scaleform.gfx.Extensions"];
            if (ext != null) ext.enabled = true;
        } catch (e:Dynamic) {}

        // First load / not linked: show ONLY the link screen — never the chat history (user
        // request). An unlinked identity can't post, so the link prompt takes the whole feed.
        if (!_connected) { setLogText("connecting..."); return; }
        // Link gate. ZFE's getAuthState.state is ALWAYS "authenticated" when merely CONNECTED
        // (it does NOT reflect the relay's linked/limited state), so we must NOT use it here.
        // The relay sends a system link-code notice ONLY to limited (unlinked) identities; its
        // arrival (_needsLink) is the authoritative "not linked" signal. It is STICKY across
        // reconnects and cleared only by clearLinkGate() — a "LINK COMPLETE" notice or a
        // successful send, both of which only a linked identity can produce.
        if (_needsLink) { setLogText(linkHint()); return; }

        var html:Array<String> = [];
        var fs:Int = _cfg.fontSize;

        for (rec in _records) {
            // Per-channel view: only render messages for the active tab's channel.
            if (rec.channel != CHAN_SLUGS[_chanIdx]) continue;
            var col:String  = ~/^#[0-9a-fA-F]{6}$/.match(rec.color) ? rec.color : hx(_cfg.senderColor);
            // Escape sender name + body — both are unsanitized relay/Discord input (SR-001).
            var user:String = FcmConfig.htmlEscape(rec.user);
            var msg:String  = FcmConfig.htmlEscape(rec.body);
            // Optional proper-cased channel tag (CAP-012, D-09).
            var tagHtml:String = "";
            if (_cfg.showChannelTag) {
                tagHtml = '<font face="' + FONT_BOLD + '" size="' + fs + '" color="' + hx(_cfg.channelColor(rec.channel)) + '">[' + FcmConfig.chanLabel(rec.channel) + ']</font> ';
            }
            // Keep the channel and server-resolved identity tag on the same text
            // line as the sender name and message body.
            var customTagHtml:String = (rec.tag != null && rec.tag.length > 0)
                ? '<font face="' + FONT_BOLD + '" size="' + fs + '" color="' + col + '">['
                    + FcmConfig.htmlEscape(rec.tag) + ']</font> '
                : "";
            // Staff only: a short, stable reference for the moderation command surface.
            // Never target by display name — names can be changed and are not unique.
            var moderationRefHtml:String = "";
            if (_canModerate && rec.messageId != null && rec.messageId.length >= 8
                    && rec.senderUserId != null && rec.senderUserId.length > 0) {
                moderationRefHtml = '<font color="' + hx(_cfg.promptColor) + '">[#'
                    + rec.messageId.substr(0, 8).toUpperCase() + ']</font> ';
            }
            // Every visible run uses the same explicit size. Weight comes from the
            // HUD bold alias, not from a nested <b> tag that can alter GFx metrics.
            html.push(
                '<font face="' + FONT_BODY + '" size="' + fs + '">'
                + tagHtml
                + moderationRefHtml
                + customTagHtml
                + '<font face="' + FONT_BOLD + '" size="' + fs + '" color="' + col + '">' + user + ':</font> '
                + '<font face="' + FONT_BODY + '" size="' + fs + '" color="' + hx(_cfg.textColor) + '">' + msg + '</font>'
                + '</font>');
        }

        // Authenticated with an empty feed (the unlinked / connecting cases returned above).
        zfeLog("info", "render", "records=" + _records.length + " shown=" + html.length
            + " tags=enabled tab=" + CHAN_SLUGS[_chanIdx]);
        if (html.length == 0) {
            setLogText("No messages in " + CHAN_NAMES[_chanIdx] + " yet"); return;
        }

        // "v N new" hint when scrolled up and new messages arrived below.
        if (_bScrolling && _newWhileScrolled > 0) {
            html.push('<font face="' + FONT_BOLD + '" size="' + fs + '" color="' + hx(_cfg.tabActiveColor)
                + '">v ' + _newWhileScrolled + ' new - wheel down or F11 Scroll to newest</font>');
        }

        if (!renderLogHtml(html)) _logTf.htmlText = html.join("<br/>");

        if (!_bScrolling) {
            // Use the legacy Text Chat end-selection snap and retain the deferred
            // maxScrollV pass for GFx builds that lay out appendHtml asynchronously.
            snapLogToBottom();
            if (_scrollSnapTimer != null) { _scrollSnapTimer.stop(); _scrollSnapTimer = null; }
            _scrollSnapTimer = new Timer(30, 1);
            _scrollSnapTimer.addEventListener(TimerEvent.TIMER, function(_) {
                _scrollSnapTimer = null;
                if (!_bScrolling && _logTf != null) {
                    snapLogToBottom();
                }
            });
            _scrollSnapTimer.start();
        }
    }

    /**
     * The in-game link prompt — numbered steps (Flow A): the code is shown IN-GAME (pulled from
     * the relay's pinned notice), the player enters it on the web /link page. Multi-line htmlText;
     * dynamic bits (url, code) are htmlEscaped (crash rule #2: numeric refs only).
     */
    function linkHint():String {
        var code:String = extractLinkCode(_pinnedSystemBody);
        var url:String  = FcmConfig.htmlEscape(_cfg.linkUrl);
        var s:String =
            '<font face="' + FONT_BOLD + '" color="' + hx(_cfg.tabActiveColor) + '"><b>LINK YOUR ACCOUNT TO CHAT</b></font><br/>'
            + '<font color="' + hx(_cfg.textColor) + '">'
            + '1) Open ' + url + ' in a web browser<br/>'
            + '2) Sign in with Discord<br/>'
            + '3) Enter this code:</font> ';
        if (code.length > 0) {
            s += '<font face="' + FONT_BOLD + '" size="' + (_cfg.fontSize + 2)
                + '" color="' + hx(_cfg.tabActiveColor) + '"><b>' + FcmConfig.htmlEscape(code) + '</b></font>';
        } else {
            // No code pinned: either we have not received the first notice yet, or the last one
            // expired and maybeRefreshLinkCode() is reconnecting to fetch a replacement.
            s += '<font color="' + hx(_cfg.promptColor) + '">'
                + (_linkRefreshPending ? '(your code expired - getting a new one...)' : '(waiting for your code...)')
                + '</font>';
        }
        return s;
    }

    /** Pull the "XXXX-XXXX" code out of the relay notice ("...enter code: XXXX-XXXX (expires...)"). */
    static function extractLinkCode(body:String):String {
        if (body == null) return "";
        var i:Int = body.indexOf("code: ");
        if (i < 0) return "";
        var rest:String = StringTools.trim(body.substr(i + 6));
        var out:StringBuf = new StringBuf();
        for (j in 0...rest.length) {
            var cc:Int = rest.charCodeAt(j);
            // 0-9, A-Z, a-z, '-' only; stop at the first space/paren/other.
            if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc == 45)
                out.add(rest.charAt(j));
            else break;
        }
        return out.toString();
    }

    // =========================================================================
    // Scroll
    // =========================================================================

    public function scrollUp():Void {
        if (_logTf == null) return;
        if (_logTf.scrollV > 1) { _logTf.scrollV--; _bScrolling = true; }
    }

    public function scrollDown():Void {
        if (_logTf == null) return;
        _logTf.scrollV++;
        if (_logTf.scrollV >= _logTf.maxScrollV) {
            _bScrolling = false; _newWhileScrolled = 0;
        }
    }

    public function scrollToBottom():Void {
        if (_logTf == null) return;
        snapLogToBottom();
        _bScrolling = false; _newWhileScrolled = 0;
    }

    /** Mouse-wheel over the log: wheel up scrolls back, wheel down toward newest (CAP-008). */
    function onLogWheel(e:flash.events.MouseEvent):Void {
        try {
            if (e.delta > 0) scrollUp();
            else if (e.delta < 0) scrollDown();
        } catch (err:Dynamic) {
            zfeLog("warn", "scroll", "onLogWheel threw: " + Std.string(err));
        }
    }

    // =========================================================================
    // BSUIDataManager reads — displayName + worldId
    // =========================================================================

    // Read a field from an AS3 object without letting a sealed/native object abort the rest of
    // the identity priority chain. HUDModLoader widgets run in a child movie domain, so both
    // Reflect.field and bracket access have existed in supported HUD builds.
    function uiField(obj:Dynamic, field:String):Dynamic {
        if (obj == null) return null;
        try {
            var value:Dynamic = Reflect.field(obj, field);
            if (value != null) return value;
        } catch (e:Dynamic) {}
        try { return untyped obj[field]; } catch (e:Dynamic) {}
        return null;
    }

    function uiData(raw:Dynamic):Dynamic {
        if (raw == null) return null;
        var data:Dynamic = uiField(raw, "data");
        return data != null ? data : raw;
    }

    function uiName(value:Dynamic, stripDecorations:Bool = false):String {
        if (value == null) return "";
        var name:String = fcmClean(Std.string(value));
        if (stripDecorations) {
            var marker:Int = name.indexOf("<");
            if (marker >= 0) name = name.substr(0, marker);
            name = StringTools.replace(name, "|", "");
        }
        return FcmIdentity.normalizeDisplayName(name);
    }

    function uiNameFromFields(obj:Dynamic, fields:Array<String>, stripDecorations:Bool = false):String {
        if (obj == null) return "";
        for (field in fields) {
            var name:String = uiName(uiField(obj, field), stripDecorations);
            if (name.length > 0) return name;
        }
        return "";
    }

    function uiArray(raw:Dynamic):Dynamic {
        var data:Dynamic = uiData(raw);
        if (data == null) return null;
        try {
            var rawLength:Dynamic = uiField(data, "length");
            if (rawLength != null && Std.int(rawLength) >= 0) return data;
        } catch (e:Dynamic) {}
        for (field in ["players", "entries", "list"]) {
            var list:Dynamic = uiField(data, field);
            if (list == null) continue;
            try {
                var rawLength:Dynamic = uiField(list, "length");
                if (rawLength != null && Std.int(rawLength) >= 0) return list;
            } catch (e:Dynamic) {}
        }
        return null;
    }

    function uiBool(value:Dynamic):Bool {
        if (value == true || value == 1) return true;
        if (value == null) return false;
        var text:String = StringTools.trim(Std.string(value)).toLowerCase();
        return text == "true" || text == "1";
    }

    /** Return the local character name from a PlayerListData payload. */
    function readLocalPlayerNameFromData(raw:Dynamic):String {
        var list:Dynamic = uiArray(raw);
        if (list == null) return "";
        var length:Int = 0;
        try {
            var rawLength:Dynamic = uiField(list, "length");
            if (rawLength == null) return "";
            length = Std.int(rawLength);
        } catch (e:Dynamic) { return ""; }
        if (length < 0) return "";
        for (i in 0...length) {
            var entry:Dynamic = null;
            try { entry = list[i]; } catch (e:Dynamic) {}
            if (entry == null) continue;
            var local:Bool = uiBool(uiField(entry, "isLocal"))
                || uiBool(uiField(entry, "isLocalPlayer"))
                || uiBool(uiField(entry, "isSelf"));
            if (!local) continue;
            var name:String = uiNameFromFields(entry,
                ["characterName", "displayName", "playerName", "name"], true);
            if (name.length > 0) return name;
        }
        return "";
    }

    function readLocalPlayerName(mgr:Dynamic):String {
        return readLocalPlayerNameFromData(getBSUIData(mgr, "PlayerListData"));
    }

    function readNamedData(mgr:Dynamic, key:String):String {
        var data:Dynamic = uiData(getBSUIData(mgr, key));
        var name:String = uiNameFromFields(data,
            ["characterName", "displayName", "playerName", "name"], true);
        if (name.length > 0) return name;
        for (field in ["character", "player"]) {
            name = uiNameFromFields(uiField(data, field),
                ["characterName", "displayName", "playerName", "name"], true);
            if (name.length > 0) return name;
        }
        return "";
    }

    /** Return the public Fallout/Bethesda handle from AccountInfoData. */
    function readAccountDisplayName(mgr:Dynamic):String {
        var data:Dynamic = uiData(getBSUIData(mgr, "AccountInfoData"));
        var name:String = uiNameFromFields(data,
            ["name", "displayName", "playerName"]);
        if (name.length > 0) return name;
        // Retain compatibility with older HUD payloads that wrapped the same
        // Fallout account object rather than publishing its fields directly.
        return uiNameFromFields(uiField(data, "account"),
            ["name", "displayName", "playerName"]);
    }

    // Returns only the public FO76 account handle, or "" until AccountInfoData is ready.
    // PlayerListData and CharacterInfoData are read as explicit non-authoritative candidates;
    // FcmIdentity refuses to let either character label satisfy the relay handshake.
    function readFalloutDisplayName(rosterData:Dynamic = null):String {
        var mgr:Dynamic = findBSUI();
        if (mgr == null) return "";

        var accountName:String = readAccountDisplayName(mgr);
        var localName:String = readLocalPlayerNameFromData(rosterData);
        if (localName.length == 0) localName = readLocalPlayerName(mgr);
        var characterInfoName:String = readNamedData(mgr, "CharacterInfoData");
        return FcmIdentity.selectFalloutDisplayName(accountName, localName, characterInfoName);
    }

    function hasResolvedDisplayName():Bool {
        return _falloutIdentityReady && FcmIdentity.isUsableFalloutDisplayName(_displayName);
    }

    /**
     * Apply a newly available HUD identity. This is observation-only: in particular, it must
     * never call a native relay verb. Initial connection attempts are deferred until the retry
     * timer observes a resolved identity, while an already-connected session keeps its relay
     * identity until the next normal reconnect.
     */
    function refreshDisplayName(rosterData:Dynamic = null):Void {
        var name:String = readFalloutDisplayName(rosterData);
        if (name.length == 0) return;

        _falloutIdentityReady = true;
        var changed:Bool = (_displayName != name);
        _displayName = name;
        if (changed) zfeLog("info", "identity",
            "Fallout account name resolved from AccountInfoData len=" + name.length);
    }

    // BSUIDataManager discovery — the engine injects it as a PROPERTY on the HUD
    // movie root (not a lexical global in the widget's domain — the v2.1.x
    // ReferenceError #1065 and the 2.8.0 "Wanderer" fallback were both lexical
    // lookups). Probe property scopes like the ZFECodeObj fix: global, root,
    // parent chain, stage, stage children. Cached after first hit; logs the scope.
    var _bsui:Dynamic = null;

    function canUseBSUI(candidate:Dynamic):Bool {
        if (candidate == null) return false;
        try {
            // Validate the callable, not just a non-null class/property lookup. A decoy
            // object here used to be cached forever and made every name read fall back.
            candidate.GetDataFromClient("AccountInfoData");
            return true;
        } catch (e:Dynamic) {}
        return false;
    }

    function getBSUIData(mgr:Dynamic, key:String):Dynamic {
        if (mgr == null) return null;
        try {
            return mgr.GetDataFromClient(key);
        } catch (e:Dynamic) {
            if (_bsui == mgr) _bsui = null;
        }
        return null;
    }

    function findBSUI():Dynamic {
        if (_bsui != null) {
            if (canUseBSUI(_bsui)) return _bsui;
            _bsui = null;
        }
        var names:Array<String> = ["classDef", "__global__", "root", "parent", "stage", "stageChild"];
        var cands:Array<Dynamic> = [];
        // The manager is the packaged class Shared.AS3.Data.BSUIDataManager (public,
        // static-style API). In HUDModLoader's shared ApplicationDomain it resolves via
        // getDefinitionByName — the same mechanism used for SharedHUDTools.
        // (Bare lexical lookups and property probes both miss it: it's a class, not an
        // injected root property.)
        try { cands.push(untyped __global__["flash.utils.getDefinitionByName"]("Shared.AS3.Data.BSUIDataManager")); } catch (e:Dynamic) { cands.push(null); }
        try { cands.push(untyped __global__["BSUIDataManager"]); } catch (e:Dynamic) { cands.push(null); }
        try { cands.push(untyped root["BSUIDataManager"]); } catch (e:Dynamic) { cands.push(null); }
        try {
            var pr:Dynamic = null;
            var p:Dynamic = parent;
            while (p != null && pr == null) {
                try { pr = untyped p["BSUIDataManager"]; } catch (e:Dynamic) {}
                p = p.parent;
            }
            cands.push(pr);
        } catch (e:Dynamic) { cands.push(null); }
        try { cands.push(untyped stage["BSUIDataManager"]); } catch (e:Dynamic) { cands.push(null); }
        try {
            var hit:Dynamic = null;
            if (stage != null) for (i in 0...(stage.numChildren : Int)) {
                try {
                    var c:Dynamic = stage.getChildAt(i);
                    var b:Dynamic = untyped c["BSUIDataManager"];
                    if (b != null) { hit = b; break; }
                } catch (e:Dynamic) {}
            }
            cands.push(hit);
        } catch (e:Dynamic) { cands.push(null); }
        for (k in 0...cands.length) {
            if (cands[k] != null && canUseBSUI(cands[k])) {
                _bsui = cands[k];
                zfeLog("info", "world", "BSUIDataManager found via " + names[k]);
                return _bsui;
            }
        }
        return null;
    }

    var _worldDiagDone:Bool = false;
    var _rosterSubscribed:Bool = false;
    var _seenNames:Map<String, Float> = new Map();   // bare character name -> last-seen ms
    var _lastRosterObservationAt:Float = -ROSTER_FRESH_MS;
    var _lastRosterSentAt:Float = 0;
    var _lastRosterSent:String = "";
    var _rosterLogCount:Int = 0;
    var _lastRosterLogAt:Float = 0;

    /** Subscribe to PlayerListData — the documented BSUIDataManager pull pattern
     *  (Subscribe = GetDataFromClient + CHANGE listener; a one-shot Get only reads
     *  the cache and is empty for providers nothing has subscribed to). The roster
     *  is the EULA-safe UI-layer source for a server-grouping key. Logs the first
     *  few updates + every 30s: entry count, first-entry fields, names. */
    function subscribeRoster():Void {
        if (_rosterSubscribed) return;
        var mgr:Dynamic = findBSUI();
        if (mgr == null) return;
        try {
            mgr.Subscribe("PlayerListData", function(evt:Dynamic):Void {
                try { onRosterChange(evt); } catch (e:Dynamic) {}
            });
            for (k in ["TeamMarkers", "PartyMenuList", "VoiceChatAreaData"]) {
                var key:String = k;
                try {
                    mgr.Subscribe(key, function(evt:Dynamic):Void {
                        try { onAuxDataChange(key, evt); } catch (e:Dynamic) {}
                    });
                } catch (e:Dynamic) {}
            }
            _rosterSubscribed = true;
            zfeLog("info", "roster", "subscribed to PlayerListData + TeamMarkers/PartyMenuList/VoiceChatAreaData");
        } catch (e:Dynamic) {
            zfeLog("warn", "roster", "Subscribe threw: " + Std.string(e));
        }
    }

    var _auxLogAt:Float = 0;
    /** Bare character name: strip the <title decorations and wire-unsafe chars. */
    function bareName(s:String):String {
        if (s == null) return "";
        // fcmClean first: roster names come from the same BSUIDataManager surface as the
        // display name, so they carry the same NUL/escaped-NUL baggage. An unsanitized name
        // here corrupts the ROSTER control body and the relay cannot bind a world room.
        s = fcmClean(s);
        var i:Int = s.indexOf("<");
        if (i >= 0) s = s.substr(0, i);
        s = StringTools.replace(s, "|", "");
        return StringTools.trim(s);
    }

    /** Record nearby-player observations (TeamMarkers / VoiceChat / PlayerList). */
    function collectRoster(key:String, d:Dynamic):Void {
        var now:Float = flash.Lib.getTimer();
        var arr:Dynamic = null;
        if (key == "TeamMarkers") { try { arr = d.Markers; } catch (e:Dynamic) {} }
        else if (key == "VoiceChatAreaData") { try { arr = d.participants; } catch (e:Dynamic) {} }
        else arr = d; // PlayerListData is the array itself
        if (arr == null) return;
        var n:Int = 0;
        try {
            var rawLength:Dynamic = uiField(arr, "length");
            if (rawLength == null) return;
            n = Std.int(rawLength);
        } catch (e:Dynamic) { return; }
        // An empty update is meaningful: it represents a valid solo world roster.
        _lastRosterObservationAt = now;
        for (i in 0...n) {
            var e0:Dynamic = arr[i];
            if (uiBool(uiField(e0, "isLocalPlayer"))
                    || uiBool(uiField(e0, "isLocal"))
                    || uiBool(uiField(e0, "isSelf"))) continue;
            var nm:String = "";
            for (cand in ["displayName", "characterName", "name", "playerName"]) {
                try {
                    var v:Dynamic = Reflect.field(e0, cand);
                    if (v != null && Std.string(v).length > 0) { nm = Std.string(v); break; }
                } catch (e:Dynamic) {}
            }
            nm = bareName(nm);
            if (nm.length > 0 && nm != bareName(_displayName)) _seenNames.set(nm, now);
        }
    }

    function onAuxDataChange(key:String, evt:Dynamic):Void {
        var now:Float = flash.Lib.getTimer();
        var dc:Dynamic = null;
        try { dc = evt.data; } catch (e:Dynamic) {}
        if (dc == null) { try { dc = evt.target.data; } catch (e:Dynamic) {} }
        if (dc != null) collectRoster(key, dc);
        if ((now - _auxLogAt) < 15000) return;
        _auxLogAt = now;
        var d:Dynamic = null;
        try { d = evt.data; } catch (e:Dynamic) {}
        if (d == null) { try { d = evt.target.data; } catch (e:Dynamic) {} }
        if (d == null) { zfeLog("info", "roster", key + " update: no data"); return; }
        var n:Int = 0;
        try { n = Std.int(d.length); } catch (e:Dynamic) {}
        if (n > 0) {
            zfeLog("info", "roster", key + " update entries=" + n);
        } else {
            zfeLog("info", "roster", key + " update received");
        }
    }

    /** Describe an array-of-objects payload: length + first-entry fields + name-ish values. */
    function describeEntries(label:String, arr:Dynamic):String {
        var n:Int = 0;
        try { n = Std.int(arr.length); } catch (e:Dynamic) { return label + "=<not-array>"; }
        if (n == 0) return label + "=[]";
        var f0:Array<String> = [];
        try { f0 = Reflect.fields(arr[0]); } catch (e:Dynamic) {}
        var vals:Array<String> = [];
        for (i in 0...n) {
            if (i >= 6) break;
            var e0:Dynamic = arr[i];
            var best:String = "";
            for (cand in ["name", "characterName", "playerName", "username", "displayName", "text"]) {
                try {
                    var v:Dynamic = Reflect.field(e0, cand);
                    if (v != null) { best = cand + ":" + Std.string(v); break; }
                } catch (e:Dynamic) {}
            }
            if (best == "") {
                try {
                    var fs = Reflect.fields(e0);
                    if (fs.length > 0) best = fs[0] + ":" + Std.string(Reflect.field(e0, fs[0])).substr(0, 20);
                } catch (e:Dynamic) {}
            }
            vals.push(best);
        }
        return label + " len=" + n + " fields=[" + f0.join(",") + "] vals={" + vals.join(" | ") + "}";
    }

    function onRosterChange(evt:Dynamic):Void {
        var now:Float = flash.Lib.getTimer();
        var d:Dynamic = null;
        try { d = evt.data; } catch (e:Dynamic) {}
        if (d == null) { try { d = evt.target.data; } catch (e:Dynamic) {} }
        if (d == null) return;
        // Pass the event payload as a non-authoritative character candidate. The public relay
        // identity still comes exclusively from AccountInfoData inside refreshDisplayName().
        refreshDisplayName(d);
        collectRoster("PlayerListData", d);
        // Throttle: first 3 updates, then at most every 30s.
        if (_rosterLogCount >= 3 && (now - _lastRosterLogAt) < 30000) return;
        _rosterLogCount++;
        _lastRosterLogAt = now;
        var n:Int = 0;
        try { n = Std.int(d.length); } catch (e:Dynamic) {}
        if (n > 0) {
            var f0:Array<String> = [];
            try { f0 = Reflect.fields(d[0]); } catch (e:Dynamic) {}
            zfeLog("info", "roster", "PlayerListData len=" + n + " fields=[" + f0.join(",") + "]");
        } else {
            var fx:Array<String> = [];
            try { fx = Reflect.fields(d); } catch (e:Dynamic) {}
            zfeLog("info", "roster", "PlayerListData update: len=0 fields=[" + fx.join(",") + "]");
        }
    }
    var _worldPollCount:Int = 0;
    var _dataInventoryDone:Bool = false;

    /** One-shot in-world inventory of candidate BSUIDataManager keys — logs each
     *  key's field names (+scalar values) so we can find a real server/world
     *  identifier empirically (AccountInfoData.worldId proved nonexistent;
     *  the vanilla HUD reads only worldType from it). */
    function dumpDataInventory():Void {
        var mgr:Dynamic = findBSUI();
        if (mgr == null) return;
        for (key in ["AccountInfoData", "CharacterInfoData", "PlayerListData", "HUDModeData", "MenuStackData"]) {
            try {
                var r:Dynamic = getBSUIData(mgr, key);
                if (r == null || r.data == null) { zfeLog("info", "inv", key + ": <no data>"); continue; }
                var d:Dynamic = r.data;
                // PlayerListData is an Array of entries — dump count + first entry's fields.
                var isArr:Bool = false;
                try { isArr = (d.length != null && d[0] != null); } catch (e:Dynamic) {}
                if (isArr) {
                    var n:Int = Std.int(d.length);
                    var f0:Array<String> = [];
                    try { f0 = Reflect.fields(d[0]); } catch (e:Dynamic) {}
                    zfeLog("info", "inv", key + ": array len=" + n + " entryFields=[" + f0.join(",") + "]");
                } else {
                    var fields:Array<String> = [];
                    try { fields = Reflect.fields(d); } catch (e:Dynamic) {}
                    zfeLog("info", "inv", key + ": fields=[" + fields.join(",") + "]");
                }
            } catch (e:Dynamic) {
                zfeLog("warn", "inv", key + " threw: " + Std.string(e));
            }
        }
    }
    function readWorldId():String {
        try {
            var mgr:Dynamic = findBSUI();
            if (mgr == null) return "";
            var a:Dynamic = getBSUIData(mgr, "AccountInfoData");
            // One-shot diagnostic: what does AccountInfoData actually carry in-world?
            if (!_worldDiagDone && a != null && a.data != null) {
                _worldDiagDone = true;
                var hasWorldId:Bool = false;
                try { hasWorldId = a.data.worldId != null; } catch (e:Dynamic) {}
                zfeLog("info", "world", "AccountInfoData inspected hasWorldId=" + hasWorldId);
            }
            if (a != null && a.data != null && a.data.worldId != null) {
                var w:String = Std.string(a.data.worldId);
                if (w.length > 0) return w;
            }
        } catch (e:Dynamic) {}
        return "";
    }

    // =========================================================================
    // JSON helpers — minimal string scanning, no parser dependency
    // =========================================================================

    static function extractJsonString(json:String, key:String):String {
        return FcmConfig.extractJsonString(json, key);
    }

    static function extractJsonInt(json:String, key:String):Int {
        var needle:String = '"' + key + '":';
        var idx:Int = json.indexOf(needle);
        if (idx < 0) {
            needle = key + ':';
            idx = json.indexOf(needle);
            if (idx < 0) return 0;
        }
        var start:Int = idx + needle.length;
        while (start < json.length && json.charAt(start) == ' ') start++;
        var end:Int = start;
        while (end < json.length && "0123456789-".indexOf(json.charAt(end)) >= 0) end++;
        if (end == start) return 0;
        return Std.parseInt(json.substring(start, end));
    }

    /** Read a compact or whitespace-formatted JSON boolean without a parser dependency. */
    static function extractJsonBool(json:String, key:String):Bool {
        return FcmConfig.extractJsonBool(json, key);
    }

    /**
     * Normalize a relay-supplied channel slug to our canonical CHAN_SLUGS values.
     * Guards against the relay tagging messages "general"/"trading"/etc.
     */
    static function normChannel(c:String):String {
        c = StringTools.trim(c).toLowerCase();
        switch (c) {
            case "general":         return "global";
            case "gen":             return "global";
            case "trading":         return "trade";
            case "event":           return "events";
            case "infest", "inf":   return "infests";
            case "raid":            return "raids";
            default:                return c;
        }
    }

    static function jsonEscape(s:String):String {
        if (s == null) return "";
        s = s.split("\\").join("\\\\");
        s = s.split('"').join('\\"');
        // Control bytes cannot be split() on under GFx, and printable control frames mean they
        // should never reach the wire anyway - drop them before escaping the rest.
        s = stripControlChars(s);
        s = s.split("\r").join("\\r");
        s = s.split("\n").join("\\n");
        s = s.split("\t").join("\\t");
        return s;
    }

    /**
     * Render a string so ZFE's logger will actually print all of it.
     *
     * zfeLog() jsonEscapes its message, so a `"` becomes `\"` — and ZFE's log writer truncates
     * the line at the first backslash it emits. Every JSON payload and response starts `{"`,
     * which is why `raw=` never showed more than `{\`. Quotes, backslashes and NULs are all
     * substituted here; the result is not valid JSON, it is only meant to be readable.
     */
    static function logSafe(s:String):String {
        if (s == null) return "";
        s = stripControlChars(s);
        s = s.split("\\").join("/");
        s = s.split("\"").join("'");
        return s;
    }

    static function fcmClean(s:String):String {
        if (s == null) return "";
        s = s.split("~").join(" ");
        s = s.split("\r").join(" ");
        s = s.split("\n").join(" ");
        s = stripControlChars(s);
        // Also drop ALREADY-ESCAPED NUL text. Game-UI strings reach us via ZFE, which hands
        // some values back with their NULs pre-escaped as the six-character text "\\x00"
        // (and, when its own encoding is off, as a bare "u0000"). Those are not control bytes
        // any more, so the NUL split above cannot see them — strip both forms explicitly or
        // they ride out onto the wire and corrupt names and channel slugs alike.
        s = s.split("\\u0000").join("");
        s = s.split("u0000").join("");
        s = StringTools.trim(s);
        return s;
    }

    // =========================================================================
    // ZFE log
    // =========================================================================

    function zfeLog(level:String, category:String, message:String):Void {
        if (_api == null) return;
        try {
            _api.call("log",
                '{"vendor":"' + VENDOR + '","level":"' + level
                + '","category":"' + category + '","message":"' + jsonEscape(message) + '"}');
        } catch (e:Dynamic) {}
    }

    // =========================================================================
    // findZfeApi — minimal, bulletproof ZFE bridge discovery
    // =========================================================================

    /**
     * findZfeApi — finds the ZFE bridge object on the HUDMenu root.
     *
     * ZFE (dxgi.dll) installs __ZFE on the HUDMenu root (stage.getChildAt(0)).
     *
     * SAFETY RULES:
     *   - Every property read and child access is in its own try/catch.
     *   - NO getChildAt loop on arbitrary objects.
     *   - NO BFS over stage descendants — Scaleform crashes on numChildren/getChildAt.
     *   - NO hard casts — dynamic untyped access only.
     */
    static function findZfeApi(scope:Dynamic):Dynamic {
        var NAMES:Array<String> = ["__ZFE", "ZFECodeObj", "__SFCodeObj"];

        function check(obj:Dynamic):Dynamic {
            if (obj == null) return null;
            for (nm in NAMES) {
                try {
                    var z:Dynamic = untyped obj[nm];
                    if (z != null) {
                        try { if (untyped z.call != null) return z; } catch (_:Dynamic) {}
                    }
                } catch (_:Dynamic) {}
            }
            return null;
        }

        // Strategy 1: stage.getChildAt(0) = HUDMenu root (most reliable)
        try {
            var st:Dynamic = scope.stage;
            if (st != null) {
                var hudMenuRoot:Dynamic = null;
                try { hudMenuRoot = st.getChildAt(0); } catch (_:Dynamic) {}
                if (hudMenuRoot != null) {
                    var z:Dynamic = check(hudMenuRoot);
                    if (z != null) return z;
                }
            }
        } catch (_:Dynamic) {}

        // Strategy 2: parent-chain walk (up to 25 levels)
        var cur:Dynamic = scope;
        var depth:Int = 0;
        while (cur != null && depth < 25) {
            var z:Dynamic = check(cur);
            if (z != null) return z;
            var next:Dynamic = null;
            try { next = cur.parent; } catch (_:Dynamic) {}
            cur = next;
            depth++;
        }

        // Strategy 3: scope.root
        try {
            var r:Dynamic = null;
            try { r = scope.root; } catch (_:Dynamic) {}
            if (r != null) {
                var z:Dynamic = check(r);
                if (z != null) return z;
            }
        } catch (_:Dynamic) {}

        // Strategy 4: scope.stage direct property
        try {
            var st:Dynamic = null;
            try { st = scope.stage; } catch (_:Dynamic) {}
            if (st != null) {
                var z:Dynamic = check(st);
                if (z != null) return z;
            }
        } catch (_:Dynamic) {}

        return null;
    }
}
