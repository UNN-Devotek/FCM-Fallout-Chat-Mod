import flash.display.MovieClip;
import flash.display.Shape;
import flash.display.Sprite;
import flash.events.Event;
import flash.events.TimerEvent;
import flash.utils.Timer;
import flash.text.TextField;
import flash.text.TextFormat;
import flash.geom.Rectangle;
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
    var pending:Bool;
    // Non-wire transaction identity. It is generated once on send and is the only
    // path ACK handling uses to update/remove the optimistic row.
    var localSendId:String;
    var pendingAt:Float;
    var sendAccepted:Bool;
}

private typedef FeedRowView = {
    var view:Sprite;
    var contentY:Float;
    var height:Float;
}

private typedef ModerationTargetResolution = {
    var target:Null<ChatRecord>;
    var ambiguous:Bool;
}

/**
 * FCMChatWidget — HUDModLoader widget for Fallout Chat Mod.
 *
 * Transport: ZFE chat.v1 or xScal chatInterface, selected automatically.
 *   __ZFE.call("chat.v1.connect",    payload)   — register + connect
 *   __ZFE.call("chat.v1.pollEvents", payload)   — cursor-based event poll
 *   __ZFE.call("chat.v1.sendMessage",payload)   — send a message
 *   __ZFE.call("chat.v1.getAuthState","{}") — connection/auth health
 *   __ZFE.call("clearChatAuth","{}") — clear ZFE's local relay token (relink)
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
 * Native input fallback (v2.5.3): DECODED native chat-input API. The verbs are TOP-LEVEL ZFE
 *   commands that take BARE-VALUE payloads (not JSON) and return bare booleans/strings:
 *     setChatInputActive payload "true" -> true (ACTIVATES); "false" deactivates.
 *       (JSON {} / {"active":true} return false / do nothing — use bare "true"/"false".)
 *     consumeChatInputSubmitted -> bare BOOLEAN (true = Enter pressed since last check);
 *       the MESSAGE TEXT comes from readChatInput, NOT from the consume result.
 *     readChatInput -> the in-progress text buffer (bare string).
 *     isChatInputActive -> true/false ; isChatKeyPressed -> true when OpenChatKey
 *       (INSERT by default) pressed ; clearChatInput -> true.
 *   nativeTruthy(raw): trimmed/lowercased == "true" OR == "1" OR contains "success":true.
 *   FLOW (openInputNative, no game-control lock): setChatInputActive("true") -> _inputTimer (~100 ms)
 *     pollNativeInput(): readChatInput (show in-progress) ; if consume truthy => SUBMIT
 *       (final text = readChatInput, run through shared handleSubmittedText -> direct
 *       chat.v1.sendMessage, log full raw) ; else if !isChatInputActive => cancel (Esc).
 *     closeInputNative(): clearChatInput + setChatInputActive("false").
 *   OPEN triggers: HUDMod::UserEvent open key, AND a low-rate (~150 ms) pollOpenKey()
 *     that opens on an isChatKeyPressed false->true edge (so the configured key opens chat).
 *   HUDModLoader menu: the F11 HUDMod::UserEvent explicitly calls SharedHUDTools.ShowMenu();
 *     RegisterMenu() only registers FCM's entries and does not open the menu by itself.
 *   SharedHUDTools is the primary editor because its host-domain TextEdit owns the engine's
 *     ControlMap lifecycle. Native input is a no-lock fallback only when HUDTools is unavailable
 *     or cannot open. The first native activation is immediately cleared and verified because
 *     some Windows/ZFE builds expose the bare activation payload as literal text. NEVER run both.
 *     sendMessage stays chat.v1.sendMessage ONLY.
 *
 * Input owner (PRIMARY): SharedHUDTools.FormatTextEdit + FormatOnScreenKeyboard + TextEdit.
 *   HUDModLoader's HUDTools handles StartEditText/EndEditText and gamepad OSK.
 *   ALL THREE must be called in order:
 *     1. FormatTextEdit(x,y,w,h,font,size,hexColor,bgHexColor,bgAlpha)
 *     2. FormatOnScreenKeyboard(oskX,oskY) — REQUIRED even on KB/mouse
 *     3. TextEdit(callback, startText)
 *   Without FormatOnScreenKeyboard, HUDTools sends ERROR|TXT → callback(null)
 *   immediately (the v2.0.3 "immediately released" bug).
 *
 * Native provider discovery: widget runs in HUDModLoader's ApplicationDomain
 * (shared with HUDMenu). FcmNativeApi walks the widget's parent/root chain for
 * an explicit ZFE bridge or xScal's chatInterface under __SFECodeObj or
 * __SFCodeObj. xScal may also install a generic call-only __SFCodeObj.call on
 * the movie root; that object is not a ZFE bridge and is never selected by name alone.
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
 *  10. NO hard casts (MovieClip(...)) — native-provider access is isolated in
 *      FcmNativeApi, which performs the guarded parent/root discovery.
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
    static inline var VERSION:String  = "2.10.55"; // physical nav via ZFE dispatcher, relay-independent
    static inline var SETTINGS_PATH:String = "settings.ini";
    // This is a top-level ZFE command, not a relay operation. ZFE owns the DPAPI/local auth file
    // and must clear it; the SWF is not allowed to write arbitrary files from the HUD domain.
    static inline var CLEAR_AUTH_COMMAND:String = "clearChatAuth";
    // Expose for HUDModLoader hot-reload
    public var isReloadable:Bool      = true;
    // Stable marker for the legacy HUDMenu self-loader's duplicate-renderer guard.
    public var fcmChatWidgetMarker:Bool = true;

    // HUDModLoader can remove and recreate a reloadable widget while the old movie's
    // timers/callbacks are still queued. Every asynchronous boundary checks this flag,
    // and shutdown() is deliberately idempotent so both the loader and REMOVED_FROM_STAGE
    // may call it safely.
    var _disposed:Bool = false;

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

    // ── Layout ────────────────────────────────────────────────────────────────
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
    // Server controls use the synchronous native RPC surface. Do not retry a rejected or
    // timed-out control on every 5s world tick; older ZFE builds can block the HUD for the
    // full socket timeout while the relay is unavailable or the account is still unlinked.
    static inline var ROSTER_RETRY_MS:Float = 60000;

    // ── Config (FcmConfig — parsed from Data/FCMChat.ini; see FcmConfig.hx) ─────
    var _cfg:FcmConfig = new FcmConfig();

    // Hex-string helpers for htmlText / setColors / FormatTextEdit (derive from _cfg Ints).
    static inline function hx(c:Int):String { return "#" + StringTools.hex(c, 6); }
    static inline function nh(c:Int):String { return StringTools.hex(c, 6); }

    // ── Display objects ───────────────────────────────────────────────────────
    var _bg:Shape;
    // _logTf is the status/link text field. Message rows use _feedLayer so the
    // supporter marker and its text share one row-local coordinate system.
    var _logTf:TextField;
    var _feedLayer:Sprite;
    var _tabTf:TextField;
    var _subTf:TextField;
    var _promptTf:TextField;
    var _fmt:TextFormat;
    // ── Chat render state ─────────────────────────────────────────────────────
    var _records:Array<ChatRecord> = [];
    var _history:FcmHistory = new FcmHistory();
    var _bScrolling:Bool         = false;
    var _feedRows:Array<FeedRowView> = [];
    var _feedContentHeight:Float = 0;
    var _feedScrollY:Float = 0;
    var _feedMaxScrollY:Float = 0;
    var _nextSendSequence:Int = 1;
    var _lastEchoMatchMode:String = "";
    var _newWhileScrolled:Int    = 0;
    // Loader versions differ in whether they emit key-down, key-up, or both. Feed/channel
    // navigation is handled on the first edge available, then the matching key-up is ignored.
    var _navigationActionsDown:Map<String,Bool> = new Map();
    // Physical-key polling is an extender bookkeeping/read path, not a game-input lock. Page
    // keys are always eligible for channel navigation; arrows/Home/End are read only while an
    // Insert-open feed session is active. The map prevents a stage event and the physical path
    // from handling the same press twice.
    var _physicalNavigationDown:Map<Int,Bool> = new Map();
    // Patched HUDMenu calls the widget before it dispatches HUDMod::UserEvent. The matching
    // bubbling event is still useful for unpatched hosts, but must be ignored after the host
    // path has already handled it or Page/TeamChat would execute twice.
    var _hostEventSuppressionKey:String = "";
    // Input diagnostics are deduplicated by action/edge so a bad mapping cannot flood zfe.log.
    var _userEventDiagnostics:Map<String,Bool> = new Map();
    var _hudEventListenerAttached:Bool = false;

    // ── Channel state ─────────────────────────────────────────────────────────
    var _chanIdx:Int             = 0;   // 0=global

    // ── Hide state (CAP-011) ────────────────────────────────────────────────────
    var _hidden:Bool             = false;   // true while the panel is hidden (/hide, F11 menu, hideKey)
    // Auto-hide: hide after _cfg.autoHideSec of no activity; reveal on a new message. F11-menu toggleable.
    var _autoHideOn:Bool         = false;
    var _autoHideTimer:Timer     = null;
    var _themeIdx:Int            = 0;       // F11 Customize → cycle color theme
    // HUDTools disables a clicked item until its timeout expires. A short cooldown
    // keeps repeatable actions usable without allowing key-repeat to flood commands.
    static inline var MENU_ACTION_TIMEOUT_MS:Float = 250;

    // ── chat.v1 session state ─────────────────────────────────────────────────
    var _api:FcmNativeApi        = null;
    var _connected:Bool          = false;
    var _userId:String           = "";
    var _relayUserId:String      = "";
    // Persisted chat rows use the linked FCM account UUID as senderUserId, while
    // getAuthState.userId is the relay-text identity. Keep both local aliases so
    // self-echo reconciliation can bridge those two authenticated namespaces.
    var _linkedUserId:String     = "";
    var _displayName:String      = "Wanderer";
    // True only after AccountInfoData supplies the public Fallout/Bethesda account handle.
    // CharacterInfoData is the local character name and must never set this flag.
    var _falloutIdentityReady:Bool = false;
    var _connectDelay:Int        = CONNECT_RETRY_MS;
    var _connectAttempts:Int     = 0;
    var _cursor:Int              = 0;
    var _consecutivePollFailures:Int = 0;
    // Timer callbacks are native event boundaries. Keep the last phase visible to the guarded
    // wrapper so a target-build exception is logged and isolated instead of escaping as an
    // UncaughtErrorEvent into the game.
    var _eventPollPhase:String   = "idle";
    var _pollTimer:Timer         = null;
    var _sendEchoPollTimer:flash.utils.Timer = null;
    // xScal accepts connect asynchronously. Drain its subscriber promptly after the
    // accepted response so the initial all-channel history does not wait for the
    // normal (much slower) steady-state poll interval.
    var _xscalWarmupTimer:flash.utils.Timer = null;
    var _xscalWarmupAttempts:Int = 0;
    static inline var XSCAL_WARMUP_MS:Int = 250;
    static inline var XSCAL_WARMUP_MAX:Int = 20;
    var _zfeInitialDrainTimer:flash.utils.Timer = null;
    var _zfeInitialDrainAttempts:Int = 0;
    static inline var ZFE_INITIAL_DRAIN_MS:Int = 250;
    static inline var ZFE_INITIAL_DRAIN_MAX:Int = 4;
    var _connectTimer:Timer      = null;
    var _worldTimer:Timer        = null;
    var _serverHistoryDrainTimer:Timer = null;
    var _serverHistoryDrainAttempts:Int = 0;
    var _serverHistoryDrainIdleAttempts:Int = 0;
    var _serverHistoryPending:Bool = false;
    static inline var SERVER_HISTORY_DRAIN_MS:Int = 150;
    static inline var SERVER_HISTORY_DRAIN_MAX:Int = 8;
    static inline var SERVER_HISTORY_DRAIN_IDLE_MAX:Int = 2;
    var _lastWorldId:String      = "";
    var _worldPollPhase:String   = "idle";
    // Observation and relay membership are deliberately separate. Nearby-player HUD data only
    // means a server-room bind *can* be requested; SERVER becomes selectable only after the
    // relay acknowledges that request.
    var _inWorld:Bool            = false;
    var _serverSessionReady:Bool = false;
    var _serverSessionError:String = "";
    // History resync is a send operation and must wait until xScal's async
    // subscriber has reached an authenticated state.
    // A fresh cursor-zero subscription already contains the complete bounded snapshot. Delay the
    // shared recovery control until that first snapshot has had a chance to arrive; sending it
    // immediately would append a second static snapshot and overflow the native 128-event queue.
    var _historyResyncFallbackTimer:Timer = null;
    static inline var HISTORY_RESYNC_FALLBACK_MS:Int = 1500;

    // Config completion is reached from both COMPLETE and IO_ERROR fallbacks on some GFx builds.
    // Keep the panel/timers single-instanced if a target build emits both callbacks.
    var _configStarted:Bool = false;

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
    // Provider state used to avoid repeating the same diagnostic every poll.
    var _lastAuthObservation:String = "";

    // ── Input state ───────────────────────────────────────────────────────────
    var _inputOpen:Bool          = false;
    // v2.5.3: DECODED native chat-input API — bare-value payloads ("true"/"false"),
    // consume=boolean, text from readChatInput. Native input is attempted lazily on open;
    // its activation buffer is cleared and verified before the session becomes visible.
    static inline var USE_NATIVE_INPUT:Bool = true;
    var _nativeInput:Bool        = false;          // true while a native session owns input
    var _inputTimer:flash.utils.Timer = null;      // in-session native input poll (~100 ms)
    var _inProgress:String       = "";             // last readChatInput buffer text
    var _nativeInputMode:String   = "unknown";    // cumulative, delta, or unknown
    var _lastObservedInput:String = "";           // raw logical buffer from the prior changed read
    var _lastReadRaw:String      = "";             // throttle [nativein] read logging
    var _nativeSubmitInFlight:Bool = false;        // mark a send originating from a native submit (diagnostic log)
    // Reset true on each relay connection; a failed native open disables native input until
    // reconnect. SharedHUDTools is always attempted first and remains the lock-owning path.
    var _nativeInputUsable:Bool  = false;
    // Set by callTop when a native helper throws or returns a command-level failure. A failed
    // in-session helper must disable native input so the next open uses SharedHUDTools.
    var _nativeInputCommandFailed:Bool = false;
    static inline var INPUT_POLL_MS:Int  = 100;    // in-session native input-poll interval
    // ── Open-key poll — open chat on the configured ZFE OpenChatKey edge ───────────────
    var _openKeyTimer:flash.utils.Timer = null;    // low-rate (~150 ms) open-trigger poll
    static inline var OPEN_KEY_MS:Int = 150;       // open-key poll interval
    var _lastChatKey:Bool        = false;          // last isChatKeyPressed truthiness (edge detect)
    // Windows virtual-key fallback for loaders that collapse physical Page keys to Unmapped.
    static inline var PHYSICAL_NAV_POLL_MS:Int = 75;
    static inline var VK_PAGEUP:Int = 0x21;
    static inline var VK_PAGEDOWN:Int = 0x22;
    static inline var VK_HOME:Int = 0x24;
    static inline var VK_END:Int = 0x23;
    static inline var VK_UP:Int = 0x26;
    static inline var VK_DOWN:Int = 0x28;
    var _physicalNavTimer:flash.utils.Timer = null;
    var _physicalNavRegistered:Array<Int> = [];
    var _physicalNavReady:Bool = false;
    var _physicalNavProbeLogged:Bool = false;      // one raw IsKeyPressed sample per session

    // ── SharedHUDTools (HUDModLoader text-entry + F11 menu integration) ───────
    var _hudTools:Dynamic        = null;
    var _hudToolsRegistered:Bool = false;
    var _hudEventStage:Dynamic   = null;
    var _configLoader:URLLoader  = null;
    var _configTimer:Timer       = null;
    var _sendTimers:Array<Timer> = [];

    // ── Self-send transaction state ──────────────────────────────────────────
    // Legacy Dev ACKs do not carry the server-resolved cosmetic projection. Once
    // one authoritative row identifies this local account, retain that bounded
    // snapshot for the next optimistic row. The ACK/event still remains the
    // authority; this only prevents an old bridge from painting a bare self-row.
    var _ownCosmeticsKnown:Bool = false;
    var _ownTag:String = "";
    var _ownSupporterStar:Bool = false;
    var _ownStarColor:String = "";

    // ─────────────────────────────────────────────────────────────────────────

    static function main():Void {
        flash.Lib.current.addChild(new FCMChatWidget());
    }

    public function new() {
        super();
        name = "FCMChatWidget";
        addEventListener(Event.ADDED_TO_STAGE, onStage);
        addEventListener(Event.REMOVED_FROM_STAGE, onRemovedFromStage);
    }

    // =========================================================================
    // Stage ready — load config then build panel
    // =========================================================================

    function onStage(e:Event):Void {
        if (_disposed) return;
        try {
            removeEventListener(Event.ADDED_TO_STAGE, onStage);
            announceModernWidgetSafely();
            loadConfig();
        } catch (err:Dynamic) {
            zfeLog("warn", "config", "stage init isolated: " + clip200(Std.string(err)));
            runAfterConfigSafely();
        }
    }

    function onRemovedFromStage(e:Event):Void {
        // REMOVED_FROM_STAGE is itself a Scaleform callback boundary. Keep a
        // defensive outer guard here in case a target build rejects one of the
        // optional timer/listener cleanup calls during reload.
        try {
            shutdown();
        } catch (err:Dynamic) {
            try { zfeLog("warn", "lifecycle", "removed-from-stage cleanup isolated: " + clip200(Std.string(err))); }
            catch (_:Dynamic) {}
            _api = null;
            _connected = false;
        }
    }

    /**
     * Balance every resource acquired by this reloadable child movie.
     *
     * HUDModLoader's public reload flag means the old instance is not guaranteed to
     * receive a second lifecycle callback before the new instance starts. Keep this
     * method safe to call more than once and make the disposed check the first line of
     * every async callback's ownership boundary.
     */
    public function shutdown():Void {
        if (_disposed) return;
        _disposed = true;

        // Mark ownership lost before EndTextEdit: some loader builds invoke the cancel
        // callback synchronously, and that callback must not submit the draft or reopen
        // the channel/navigation path during teardown.
        if (_inputOpen) {
            try {
                if (_nativeInput) closeInputNative(true);
                else closeInputSharedHudTools("widget shutdown");
            } catch (e:Dynamic) {
                zfeLog("warn", "lifecycle", "input shutdown isolated: " + clip200(Std.string(e)));
            }
        }

        stopAutoHideTimer();
        stopConfigTimer();
        stopPollTimer();
        stopEchoPollTimer();
        stopServerHistoryDrain();
        stopWorldTimer();
        stopOpenKeyTimer();
        stopPhysicalNavigation();
        stopConnectRetry();
        stopZfeSearchTimer();
        stopInputTimer();

        for (timer in _sendTimers) {
            try { timer.stop(); } catch (e:Dynamic) {}
        }
        _sendTimers = [];

        if (_configLoader != null) {
            try {
                _configLoader.removeEventListener(Event.COMPLETE, onConfigLoaded);
                _configLoader.removeEventListener(IOErrorEvent.IO_ERROR, onConfigIoError);
            } catch (e:Dynamic) {}
            _configLoader = null;
        }

        if (_hudEventStage != null) {
            try { _hudEventStage.removeEventListener("HUDMod::UserEvent", onUserEventSafe); }
            catch (e:Dynamic) {}
            _hudEventStage = null;
        }
        // BSUIDataManager retains callback references independently of the child SWF. Remove
        // every subscription before releasing the manager so an old reload instance cannot
        // continue processing world/roster updates after the replacement is live.
        try { unsubscribeRoster(); } catch (e:Dynamic) {}
        _rosterManager = null;
        _bsui = null;
        try { removeEventListener(Event.ADDED_TO_STAGE, onStage); } catch (e:Dynamic) {}
        try { removeEventListener(Event.REMOVED_FROM_STAGE, onRemovedFromStage); } catch (e:Dynamic) {}

        // SharedHUDTools.Shutdown unregisters both the message and menu callbacks for
        // this vendor. EndTextEdit above handles the active editor before Shutdown.
        if (_hudTools != null) {
            try {
                var close:Dynamic = Reflect.field(_hudTools, "CloseMenu");
                if (close != null) Reflect.callMethod(_hudTools, close, []);
            } catch (e:Dynamic) {}
            try {
                var stop:Dynamic = Reflect.field(_hudTools, "Shutdown");
                if (stop != null) Reflect.callMethod(_hudTools, stop, []);
            } catch (e:Dynamic) {
                zfeLog("warn", "lifecycle", "SharedHUDTools shutdown isolated: " + clip200(Std.string(e)));
            }
            _hudTools = null;
            _hudToolsRegistered = false;
        }

        detachPanelChildren();
        zfeLog("info", "lifecycle", "widget shutdown complete");
        _api = null;
        _connected = false;
        _serverHistoryPending = false;
        _navigationActionsDown = new Map();
    }

    function stopAutoHideTimer():Void {
        if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; }
    }

    function stopConfigTimer():Void {
        if (_configTimer != null) { _configTimer.stop(); _configTimer = null; }
    }

    function stopConnectRetry():Void {
        if (_connectTimer != null) { _connectTimer.stop(); _connectTimer = null; }
    }

    function stopZfeSearchTimer():Void {
        if (_zfeSearchTimer != null) { _zfeSearchTimer.stop(); _zfeSearchTimer = null; }
    }

    function stopInputTimer():Void {
        if (_inputTimer != null) { _inputTimer.stop(); _inputTimer = null; }
    }

    function stopWorldTimer():Void {
        if (_worldTimer != null) { _worldTimer.stop(); _worldTimer = null; }
        _worldPollPhase = "idle";
    }

    function stopServerHistoryDrain():Void {
        if (_serverHistoryDrainTimer != null) {
            _serverHistoryDrainTimer.stop();
            _serverHistoryDrainTimer = null;
        }
        _serverHistoryDrainAttempts = 0;
        _serverHistoryDrainIdleAttempts = 0;
        _serverHistoryPending = false;
    }

    function detachPanelChildren():Void {
        clearFeedRows();
        if (_feedLayer != null) {
            try { _feedLayer.removeEventListener(flash.events.MouseEvent.MOUSE_WHEEL, onLogWheel); }
            catch (e:Dynamic) {}
        }
        var kids:Array<flash.display.DisplayObject> = [_bg, _tabTf, _subTf, _logTf, _feedLayer, _promptTf];
        for (child in kids) {
            try { if (child != null && child.parent == this) removeChild(child); } catch (e:Dynamic) {}
        }
        _bg = null;
        _tabTf = null;
        _subTf = null;
        _logTf = null;
        _feedLayer = null;
        _promptTf = null;
        _feedRows = [];
    }

    /**
     * Claim renderer ownership from the patched HUDMenu as soon as this child
     * SWF is attached. The HUDMenu fallback has an intentionally delayed scan,
     * but waiting for that timer leaves the legacy untagged renderer alive long
     * enough to duplicate sends and rows. Keep this callback optional so the
     * widget remains compatible with an unpatched HUDModLoader host.
     */
    function announceModernWidgetSafely():Void {
        try {
            var current:Dynamic = this;
            var depth:Int = 0;
            while (current != null && depth < 24) {
                var notify:Dynamic = null;
                try { notify = Reflect.field(current, "fcmNotifyModernWidget"); }
                catch (_:Dynamic) {}
                if (notify != null && Reflect.isFunction(notify)) {
                    Reflect.callMethod(current, notify, [this]);
                    return;
                }
                try { current = Reflect.field(current, "parent"); }
                catch (_:Dynamic) { current = null; }
                depth++;
            }
        } catch (err:Dynamic) {
            // Renderer handoff is a compatibility hook. It must never prevent
            // the modern widget from loading its own config.
            zfeLog("warn", "selfload", "modern renderer handoff isolated: " + clip200(Std.string(err)));
        }
    }

    function loadConfig():Void {
        if (_disposed) return;
        if (_configLoader != null) return;
        var ul:URLLoader = new URLLoader();
        _configLoader = ul;
        ul.addEventListener(Event.COMPLETE, onConfigLoaded);
        ul.addEventListener(IOErrorEvent.IO_ERROR, onConfigIoError);
        try {
            ul.load(new URLRequest("../FCMChat.ini"));
        } catch (e:Dynamic) {
            runAfterConfigSafely();
        }
    }

    function onConfigIoError(e:IOErrorEvent):Void {
        if (_disposed) return;
        runAfterConfigSafely();
    }

    function onConfigLoaded(e:Event):Void {
        if (_disposed) return;
        try {
            var ul:URLLoader = cast e.target;
            _cfg = FcmConfig.parse(Std.string(ul.data));
            afterConfig();
        } catch (err:Dynamic) {
            zfeLog("warn", "config", "config parse isolated: " + clip200(Std.string(err)));
            _cfg = new FcmConfig();
            runAfterConfigSafely();
        }
    }

    function afterConfig():Void {
        if (_disposed || _configStarted) return;
        _configStarted = true;
        if (_configLoader != null) {
            try {
                _configLoader.removeEventListener(Event.COMPLETE, onConfigLoaded);
                _configLoader.removeEventListener(IOErrorEvent.IO_ERROR, onConfigIoError);
            } catch (e:Dynamic) {}
            _configLoader = null;
        }
        _autoHideOn = (_cfg != null && _cfg.autoHideSec > 0);   // default from config (60s)
        // Register HUDModLoader listeners before building the static panel.
        attachHUDModListeners();
        buildPanel();
        // Delay ZFE init 3 s — ZFE API may not be ready at SWF load time.
        stopConfigTimer();
        _configTimer = new Timer(3000, 1);
        _configTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _configTimer = null;
            runInitSafely();
        });
        _configTimer.start();
    }

    function runAfterConfigSafely():Void {
        if (_disposed) return;
        try {
            if (_cfg == null) _cfg = new FcmConfig();
            afterConfig();
        } catch (err:Dynamic) {
            zfeLog("warn", "config", "afterConfig isolated: " + clip200(Std.string(err)));
        }
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

        // Message rows live in their own clipped layer. Each row owns its channel field,
        // content field, and optional vector star; the marker never depends on the document
        // index or coordinate transforms of one large HTML TextField.
        _feedLayer = new Sprite();
        _feedLayer.x = _logTf.x;
        _feedLayer.y = _logTf.y;
        _feedLayer.mouseEnabled = true;
        _feedLayer.mouseChildren = false;
        _feedLayer.scrollRect = new Rectangle(0, 0, _logTf.width, _logTf.height);
        _feedLayer.visible = false;
        addChild(_feedLayer);

        // Mouse-wheel over the log scrolls history (CAP-008, VER-2). HUD-availability
        // unverified; F11 "Scroll to newest" + auto-scroll stay the fallback.
        try {
            _feedLayer.addEventListener(flash.events.MouseEvent.MOUSE_WHEEL, onLogWheel);
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
        try {
            clearFeedRows();
            _feedScrollY = 0;
            _bScrolling = false;
            _newWhileScrolled = 0;
            _logTf.visible = true;
            if (_feedLayer != null) _feedLayer.visible = false;
            _logTf.htmlText = '<font face="' + FONT_BODY + '" size="' + _cfg.fontSize + '" color="' + hx(_cfg.textColor) + '">' + s + '</font>';
        } catch (err:Dynamic) {
            try { _logTf.text = s; } catch (_:Dynamic) {}
            zfeLog("warn", "render", "status text isolated: " + clip200(Std.string(err)));
        }
    }

    function setPrompt(html:String):Void {
        if (_promptTf == null) return;
        try {
            _promptTf.htmlText = html;
        } catch (err:Dynamic) {
            try { _promptTf.text = html; } catch (_:Dynamic) {}
            zfeLog("warn", "render", "prompt text isolated: " + clip200(Std.string(err)));
        }
    }

    /** Snap the row layer after a feed rebuild. */
    function snapLogToBottom():Void {
        _feedScrollY = _feedMaxScrollY;
        _bScrolling = false;
        _newWhileScrolled = 0;
        applyFeedScroll();
    }

    // =========================================================================
    // HUDModLoader listeners — SharedHUDTools + stage user-event
    // =========================================================================

    function attachHUDModListeners():Void {
        if (_disposed) return;
        try {
            _hudEventStage = stage;
            if (_hudEventStage != null) {
                _hudEventStage.addEventListener("HUDMod::UserEvent", onUserEventSafe);
                _hudEventListenerAttached = true;
            } else {
                _hudEventListenerAttached = false;
            }
        } catch (e:Dynamic) {
            _hudEventListenerAttached = false;
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
        if (_disposed || _hudTools != null) return;
        // Extensions.enabled is required before any scaleform.gfx.* use.
        try {
            var ext:Dynamic = untyped __global__["scaleform.gfx.Extensions"];
            if (ext != null) ext.enabled = true;
        } catch (e:Dynamic) {}

        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("SharedHUDTools");
            if (cls != null) {
                _hudTools = untyped __new__(cls, VENDOR, "All");
                var register:Dynamic = Reflect.field(_hudTools, "Register");
                var registerMenu:Dynamic = Reflect.field(_hudTools, "RegisterMenu");
                if (register == null || registerMenu == null) throw "SharedHUDTools registration API missing";
                Reflect.callMethod(_hudTools, register,
                    [function(sender:String, msg:String):Void { onHudMessageSafe(sender, msg); }]);
                Reflect.callMethod(_hudTools, registerMenu,
                    [function(parentItem:String):Void { onBuildMenuSafe(parentItem); },
                     function(item:String):Void { onSelectMenuSafe(item); }]);
                _hudToolsRegistered = true;
                // Position the HUDModLoader menu just under the channel-tab row.
                try {
                    Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatMenu"),
                        [_cfg.x, _cfg.y + TAB_H, "down"]);
                } catch (e:Dynamic) {}
                zfeLog("info", "hud", "SharedHUDTools registered");
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "SharedHUDToolsMissing: " + Std.string(e));
            if (_hudTools != null) {
                try {
                    var stop:Dynamic = Reflect.field(_hudTools, "Shutdown");
                    if (stop != null) Reflect.callMethod(_hudTools, stop, []);
                } catch (_:Dynamic) {}
                _hudTools = null;
                _hudToolsRegistered = false;
            }
        }

    }

    function onHudMessage(sender:String, msg:String):Void {
        // HUDTools messages can contain player-entered text. Keep a useful breadcrumb
        // without persisting message content or identity data in zfe.log.
        var bodyLen:Int = (msg == null) ? 0 : msg.length;
        zfeLog("info", "hud", "HUDTools message received bodyLen=" + bodyLen);
    }

    function onHudMessageSafe(sender:String, msg:String):Void {
        try {
            onHudMessage(sender, msg);
        } catch (err:Dynamic) {
            zfeLog("warn", "hud", "HUDTools message isolated: " + clip200(Std.string(err)));
        }
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
     * AddMenuItem(id, text, isEnabled=true, isMenu=false, timeout=250).
     * HUDTools treats timeout=0 as a one-shot item until the menu is rebuilt, so
     * repeatable actions must use a positive timeout.
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
                Reflect.callMethod(_hudTools, add, ["cz_bigger",  "Size +",        true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_smaller", "Size -",        true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_up",      "Move up",       true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_down",    "Move down",     true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_left",    "Move left",     true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_right",   "Move right",    true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_opac_up", "Opacity +",     true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_opac_dn", "Opacity -",     true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_theme",   "Color theme >", true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_reset",   "Reset all settings", true, false, MENU_ACTION_TIMEOUT_MS]);
                return;
            }
            // Top-level menu — channel entries in display order (SERVER included in-world).
            for (si in tabOrder()) {
                Reflect.callMethod(_hudTools, add, ["chan" + si, CHAN_NAMES[si], true, false, MENU_ACTION_TIMEOUT_MS]);
            }
            Reflect.callMethod(_hudTools, add, ["scrollbottom", "Scroll to newest", true, false, MENU_ACTION_TIMEOUT_MS]);
            Reflect.callMethod(_hudTools, add, ["hidechat", "Hide chat", true, false, MENU_ACTION_TIMEOUT_MS]);
            Reflect.callMethod(_hudTools, add, ["autohide", (_autoHideOn ? "Auto-hide: ON" : "Auto-hide: OFF"), true, false, MENU_ACTION_TIMEOUT_MS]);
            Reflect.callMethod(_hudTools, add, ["customize", "Customize...", true, true, MENU_ACTION_TIMEOUT_MS]);   // isMenu=true
            // The relay provides this permission snapshot from the linked Discord role.
            // The command itself is re-authorized server-side on every submit.
            if (_canModerate) {
                Reflect.callMethod(_hudTools, add, ["moderationhelp", "Moderation commands", true, false, MENU_ACTION_TIMEOUT_MS]);
            }
            // Relink is intentionally available even while authenticated: it is the recovery
            // path when a user linked the wrong Discord account or wants to switch accounts.
            Reflect.callMethod(_hudTools, add, ["relink", "Relink account...", true, false, MENU_ACTION_TIMEOUT_MS]);
        } catch (e:Dynamic) {
            zfeLog("warn", "menu", "AddMenuItem threw: " + Std.string(e));
        }
    }

    function onBuildMenuSafe(parentItem:Dynamic):Void {
        try {
            onBuildMenu(parentItem);
        } catch (err:Dynamic) {
            zfeLog("warn", "menu", "build callback isolated: " + clip200(Std.string(err)));
        }
    }

    /**
     * HUDModLoader menu select callback. id is the AddMenuItem id string.
     */
    function onSelectMenuSafe(item:Dynamic):Void {
        try {
            onSelectMenu(item);
        } catch (err:Dynamic) {
            zfeLog("warn", "menu", "select callback isolated: " + clip200(Std.string(err)));
        }
    }

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
            // HUDTools does not update the text of an existing button when a menu
            // is rebuilt in place. Close this menu so the next F11 open constructs
            // a fresh item with the current ON/OFF label.
            closeHudLoaderMenuAfterStateChange();
        } else if (id == "moderationhelp") {
            setLogText(moderationHelp());
        } else if (id == "relink") {
            requestRelink();
        }
    }

    function closeHudLoaderMenuAfterStateChange():Void {
        if (_hudTools == null || _inputOpen) return;
        try {
            if (Reflect.field(_hudTools, "isActive") == true) {
                var close:Dynamic = Reflect.field(_hudTools, "CloseMenu");
                if (close != null) Reflect.callMethod(_hudTools, close, []);
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "menu", "menu refresh close threw: " + Std.string(e));
        }
    }

    /**
     * HUDMod::UserEvent handler — control-map ACTIONS only. FO76 collapses every unbound key
     * (INSERT, Page Up/Down, Delete, …) to "Unmapped" with no key info, so this path is reliable
     * ONLY for real named actions. HUDModLoader's public event uses actionName/isDown; the
     * capitalized aliases are retained for older loader builds. The primary open trigger still
     * uses the native isChatKeyPressed poll (pollOpenKey).
     */
    function onUserEventSafe(e:Dynamic):Void {
        try {
            onUserEvent(e);
        } catch (err:Dynamic) {
            zfeLog("warn", "input", "HUDMod::UserEvent isolated: " + clip200(Std.string(err)));
        }
    }

    function onUserEvent(e:Dynamic):Void {
        // EventName/IsKeyDown are accessors on HUDModUserEvent. Reflect.field()
        // ignores AS3 getters on Flash, so use the dedicated native-property
        // adapter or every named action is silently reduced to ""/key-up.
        var action:String = FcmUserEvent.action(e);
        var isDown:Bool   = FcmUserEvent.isDown(e);

        var observedAction:String = action.length > 0 ? FcmCommand.actionKey(action) : "<empty>";
        var observedKey:String = observedAction + "|" + (isDown ? "down" : "up");
        if (!_userEventDiagnostics.exists(observedKey)) {
            _userEventDiagnostics.set(observedKey, true);
            zfeLog("info", "input", "HUDMod::UserEvent observed action=" + observedAction
                + " edge=" + (isDown ? "down" : "up"));
        }

        var navigation:String = FcmCommand.navigationAction(action,
            _cfg.channelNextKey, _cfg.channelPrevKey);
        if (navigation.length > 0) {
            zfeLog("info", "input", "HUDMod::UserEvent action=" + action
                + " edge=" + (isDown ? "down" : "up") + " command=" + navigation);
        }

        var eventKey:String = hostEventKey(action, isDown);
        if (_hostEventSuppressionKey == eventKey) {
            _hostEventSuppressionKey = "";
            return;
        }
        // If a target host did not dispatch the expected bubbling event, do not let an old
        // suppression token hide a later real action.
        if (_hostEventSuppressionKey.length > 0) _hostEventSuppressionKey = "";
        handleUserEvent(action, isDown);
    }

    /**
     * Host-side ProcessUserEvent entry point. The patched HUDMenu invokes this before its own
     * dispatch so a true result can set the vanilla Boolean consumed flag. External modal
     * actions intentionally return false after closing FCM input, allowing the game to open the
     * social/friends menu normally.
     */
    public function fcmHandleHostUserEvent(action:String, isDown:Bool):Bool {
        if (_disposed) return false;
        var consumed:Bool = handleUserEvent(action, isDown);
        if (consumed) _hostEventSuppressionKey = hostEventKey(action, isDown);
        return consumed;
    }

    function hostEventKey(action:String, isDown:Bool):String {
        return FcmCommand.actionKey(action) + "|" + (isDown ? "1" : "0");
    }

    /** Shared implementation for both patched-host and unpatched stage-listener paths. */
    function handleUserEvent(action:String, isDown:Bool):Bool {
        if (_disposed) return false;

        // Close whichever input owner is active before HUDMenu processes a named modal action.
        // Only the host-domain SharedHUDTools path owns the engine's ControlMap lock; the native
        // fallback owns only its ZFE bridge session.
        // action such as OpenSocial (Ctrl+Tab), OpenFriendList, or Escape. This must run on the
        // event's key-down/key-up edge before the game's own menu handler gets the action.
        var externalClosePath:String = FcmCommand.externalInputClosePath(_inputOpen, _nativeInput, action);
        if (externalClosePath == "native") {
            zfeLog("info", "input", "native session closed for external action " + action);
            closeInputNative();
            // Let Fallout open the requested external modal after the FCM owner is released.
            return false;
        } else if (externalClosePath == "shared") {
            closeInputSharedHudTools("external action " + action);
            return false;
        }
        // HUDModLoader's RegisterMenu() does not bind the F11 hotkey. The loader forwards
        // the key as a HUDMod::UserEvent, so explicitly open the shared menu here. Keep the
        // guard narrow: "Unmapped" represents every unbound key and must never open menus.
        if (action == "F11" || action == "HUDModMenu" || action == "HUDModLoaderMenu") {
            showHudLoaderMenu();
            return true;
        }

        // Navigation is a set of one-shot commands, never a persistent "channel selection"
        // mode. This matters because the same stage also hosts the SharedHUDTools editor: an
        // ordinary character or an Unmapped action must never be routed into channel handling.
        // Page actions switch channels while idle or while typing; the editor owner and draft are
        // left untouched. Arrows/Home/End are feed commands only for an active Insert session.
        var navAction:String = FcmCommand.navigationAction(action,
            _cfg.channelNextKey, _cfg.channelPrevKey);
        if (navAction.length > 0) {
            // Arrow/Home/End remain ordinary gameplay controls until Insert owns a visible
            // editor. Page actions are FCM channel commands in either visible state.
            var feedCommand:Bool = navAction == "feed-up" || navAction == "feed-down"
                || navAction == "feed-bottom";
            if (feedCommand && !FcmCommand.feedNavigationEnabled(_inputOpen, _hidden)) {
                return false;
            }
            var navKey:String = FcmCommand.actionKey(action);
            var alreadyLatched:Bool = _navigationActionsDown.exists(navKey);
            if (!FcmCommand.navigationEdgeIsNew(alreadyLatched)) {
                if (!isDown) _navigationActionsDown.remove(navKey);
                return true;
            }
            if (isDown) _navigationActionsDown.set(navKey, true);

            if (navAction == "feed-up") { scrollUp(); return true; }
            if (navAction == "feed-down") { scrollDown(); return true; }
            if (navAction == "feed-bottom") { scrollToBottom(); return true; }
            if (navAction == "next-channel") { cycleChannel(); return true; }
            if (navAction == "previous-channel") { cyclePrev(); return true; }
            // Feed commands are intentionally ignored while idle/hidden; they must remain game
            // controls and must not fall through to input opening or channel selection.
            return false;
        }

        // Named open actions are consumed only after the FCM editor is actually live. This keeps
        // Console/TeamChat available when SharedHUDTools is missing, while preventing vanilla
        // TeamChat from creating a second native editor after FCM has opened successfully.
        var normalizedAction:String = FcmCommand.actionKey(action);
        var configuredOpen:String = FcmCommand.actionKey(_cfg.openKey);
        var isOpenAction:Bool = action == "Console" || action == "ConsoleToggles" || action == "TeamChat"
            || (normalizedAction.length > 0 && normalizedAction == configuredOpen
                && normalizedAction != "unmapped");
        if (isOpenAction) {
            if (isDown) return _inputOpen;
            if (_inputOpen) return true;
            openInput();
            return _inputOpen;
        }

        // INSERT etc. open via the native poll, not this named-action path. Ordinary actions and
        // Unmapped must never enter a persistent channel-selection/input mode.
        return false;
    }

    /** Reset edge state whenever ownership changes; a held Page/arrow cannot leak into a new edit. */
    function clearNavigationLatches():Void {
        _navigationActionsDown = new Map();
    }

    /** Named-action compatibility wrapper retained for source-level callers/tests. */
    static function isExternalInputAction(action:String):Bool {
        return FcmCommand.isExternalInputAction(action);
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
        if (_disposed) return;
        if (_inputOpen) {
            if (_nativeInput) closeInputNative();
            else closeInputSharedHudTools("hide");
        }
        this.visible = false;
        _hidden = true;
        stopAutoHideTimer();
        zfeLog("info", "hide", "panel hidden");
    }

    function show():Void {
        if (_disposed) return;
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
        if (_disposed) return;
        stopAutoHideTimer();
        if (!_autoHideOn || _cfg == null || _cfg.autoHideSec <= 0) return;
        _autoHideTimer = new Timer(_cfg.autoHideSec * 1000, 1);
        _autoHideTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { runAutoHideSafely(); });
        _autoHideTimer.start();
    }

    function runAutoHideSafely():Void {
        if (_disposed) return;
        try {
            _autoHideTimer = null;
            if (!_inputOpen && !_hidden) hide();
        } catch (err:Dynamic) {
            zfeLog("warn", "hide", "auto-hide callback isolated: " + clip200(Std.string(err)));
        }
    }

    // =========================================================================
    // F11 Customize — live resize / move / opacity / color theme (+ ZFE storage persistence)
    // =========================================================================

    // Live re-layout after a Customize change. Removes children BY REFERENCE only — NEVER
    // numChildren/getChildAt (Scaleform VM crash, rule #9). buildPanel re-adds everything
    // and re-applies x/y from _cfg.
    function rebuildPanel():Void {
        if (_disposed) return;
        if (_feedLayer != null) {
            try { _feedLayer.removeEventListener(flash.events.MouseEvent.MOUSE_WHEEL, onLogWheel); }
            catch (e:Dynamic) {}
        }
        var kids:Array<flash.display.DisplayObject> = [_bg, _tabTf, _subTf, _logTf, _feedLayer, _promptTf];
        for (c in kids) { try { if (c != null) removeChild(c); } catch (e:Dynamic) {} }
        _feedRows = [];
        _feedContentHeight = 0;
        _feedScrollY = 0;
        _feedMaxScrollY = 0;
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

    /**
     * Some ZFE/Steam Input combinations expose only the newest character from the native
     * buffer. Preserve the complete draft in that case while still honoring a real edit that
     * returns a shorter buffer (backspace/cursor editing). The raw-response guard in the poller
     * ensures a repeated poll of the same one-character value is not appended twice.
     */
    function mergeNativeInputText(observed:String):String {
        var current:String = observed == null ? "" : observed;
        var mode:String = FcmCommand.detectNativeInputMode(_lastObservedInput, current, _nativeInputMode);
        var merged:String = FcmCommand.mergeNativeInputTextWithMode(
            _inProgress, _lastObservedInput, current, _nativeInputMode);
        _nativeInputMode = mode;
        _lastObservedInput = current;
        return merged;
    }

    function openInput():Void {
        if (_disposed) return;
        if (_inputOpen) return;
        // A navigation key may have been held across the Insert edge. Start each edit with a
        // clean latch so its key-up cannot select a channel or steal the first typed character.
        clearNavigationLatches();
        // The open key both restores a hidden panel AND opens input (CAP-011, guaranteed).
        if (_hidden) show();
        bumpAutoHide();   // opening input = activity (the timer also never hides while input is open)
        // SharedHUDTools is the only supported path for a session that must suppress gameplay
        // input. It dispatches ControlMap::StartEditText/EndEditText from the HUD host domain,
        // where Bethesda's event contract is known to work. A child widget dispatching the same
        // event through a dynamically resolved class caused the repeated Error #1014 flood and
        // left the game-control lock active in v2.10.45. Try the host-owned editor first.
        openInputSharedHudTools();
        if (_inputOpen) return;

        // ZFE native input is deliberately a no-lock fallback. It is better to provide a
        // receive/send editor than to dispatch the unsafe child-domain ControlMap event again;
        // when this fallback is active, movement keys remain owned by the game.
        if (USE_NATIVE_INPUT && _nativeInputUsable) {
            zfeLog("warn", "input", "SharedHUDTools unavailable; using no-lock native fallback");
            if (openInputNative()) return;
            // Do not keep re-triggering a known-bad native implementation for every Insert.
            // A reconnect resets this capability so a transient ZFE startup failure can retry.
            _nativeInputUsable = false;
        }
    }

    // =========================================================================
    // Native chat-input session (NO-LOCK FALLBACK) — decoded bare-value-payload flow (v2.5.3)
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
     * This is used only when the host-domain SharedHUDTools editor is unavailable or fails.
     * It intentionally does not dispatch ControlMap events from the child widget: that
     * boundary produced uncaught Scaleform errors and left gameplay locked in v2.10.45.
     * Returns true on success; false leaves the caller with no input owner.
     */
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

        // Some Windows/ZFE builds return a bare boolean from readChatInput immediately after
        // activation. Clear it before creating the visible session and verify that the buffer is
        // empty. A bare boolean is an empty status response only when clearChatInput succeeded;
        // real text still rejects the native path if the clear did not take.
        var clearRaw:String = callTop("clearChatInput", "{}");
        var afterClearRaw:String = callTop("readChatInput", "{}");
        if (_nativeInputCommandFailed) {
            callTop("setChatInputActive", "false");
            zfeLog("warn", "nativein", "activation helper failed; falling back");
            return false;
        }
        if (!FcmCommand.nativeInputBufferIsClear(afterClearRaw, clearRaw)) {
            callTop("setChatInputActive", "false");
            zfeLog("warn", "nativein", "activation buffer not clear; falling back clear="
                + clip200(clearRaw) + " read=" + clip200(afterClearRaw));
            return false;
        }
        zfeLog("info", "nativein", "activation buffer cleared raw=" + clip200(clearRaw)
            + " read=" + clip200(afterClearRaw));

        _inputOpen   = true;
        _nativeInput = true;
        _inProgress  = "";
        _nativeInputMode = "unknown";
        _lastObservedInput = "";
        _lastReadRaw = "";
        setPrompt(typingPrompt());
        zfeLog("info", "input path", "native-chat-input");
        if (_inputTimer != null) { _inputTimer.stop(); _inputTimer = null; }
        _inputTimer = new flash.utils.Timer(INPUT_POLL_MS);
        _inputTimer.addEventListener(TimerEvent.TIMER, function(_) { runNativeInputSafely(); });
        _inputTimer.start();
        return true;
    }

    function runNativeInputSafely():Void {
        if (_disposed) return;
        try {
            pollNativeInput();
        } catch (err:Dynamic) {
            zfeLog("warn", "nativein", "input timer isolated: " + clip200(Std.string(err)));
            try { closeInputNative(true); } catch (_:Dynamic) {}
        }
    }

    /**
     * In-session native input tick (every INPUT_POLL_MS while a native session is open).
     * Guarded so a parse error never stops the timer — but a submit/cancel DOES close it.
     * Only ever called while a native session is open (never polls outside one).
     */
    function pollNativeInput():Void {
        if (_disposed || !_nativeInput) return;
        _nativeInputCommandFailed = false;
        try {
            // ── 1. read the in-progress buffer; show it in the prompt ───────
            var rraw:String = callTop("readChatInput", "{}");
            if (_nativeInputCommandFailed) {
                zfeLog("warn", "nativein", "read helper failed; falling back");
                closeInputNative(true);
                return;
            }
            var readChanged:Bool = (rraw != _lastReadRaw);
            if (readChanged) {
                _lastReadRaw = rraw;
                zfeLog("info", "nativein", "read raw=" + clip200(rraw));
            }
            var observed:String = parseInputText(rraw);
            var text:String = readChanged ? mergeNativeInputText(observed) : _inProgress;
            _inProgress = text;
            _lastReadRaw = rraw;
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
                var finalObserved:String = parseInputText(finalRaw);
                var textNow:String = (finalRaw == _lastReadRaw)
                    ? _inProgress
                    : mergeNativeInputText(finalObserved);
                _lastReadRaw = finalRaw;
                _inProgress = textNow;
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
            // Native input has no widget-owned ControlMap lock; close only its own bridge session.
            closeInputNative(true);
        }
    }

    /**
     * Close the native chat-input session: stop the poll timer, clear + deactivate
     * the native input (bare "false"), and reset the prompt.
     */
    function closeInputNative(failed:Bool = false):Void {
        stopInputTimer();
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
        _inputOpen   = false;
        _nativeInput = false;
        _inProgress  = "";
        _nativeInputMode = "unknown";
        _lastObservedInput = "";
        _lastReadRaw = "";
        clearNavigationLatches();
        setPrompt(idlePrompt());
    }

    /**
     * Cancel the SharedHUDTools editor before Fallout processes another modal action.
     *
     * SharedHUDTools owns the actual entry TextField and the matching EndEditText event,
     * so clearing only this widget's flag is not sufficient: the focused HUDTools field
     * would remain alive and the game ControlMap would continue treating the next menu as
     * text input. EndTextEdit is the public HUDTools cancellation API; its callback arrives
     * asynchronously with a null value, which is harmless because this method closes the
     * widget state first and does not submit the draft.
     */
    function resetSharedInputState():Void {
        _inputOpen = false;
        _inProgress = "";
        clearNavigationLatches();
        setPrompt(idlePrompt());
    }

    function closeInputSharedHudTools(reason:String):Void {
        // Release local ownership before asking HUDTools to finish. Its callback may be
        // synchronous on some loader builds; clearing first makes that callback a cancel and
        // prevents a stale editor event from re-entering channel/input handling.
        resetSharedInputState();
        var requested:Bool = false;
        try {
            if (_hudTools != null) {
                var end:Dynamic = Reflect.field(_hudTools, "EndTextEdit");
                if (end != null) {
                    Reflect.callMethod(_hudTools, end, []);
                    requested = true;
                    zfeLog("info", "input", "SharedHUDTools EndTextEdit requested (" + reason + ")");
                }
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "SharedHUDTools EndTextEdit threw: " + Std.string(e));
        }
        if (!requested) {
            // A missing helper means HUDTools cannot own a live editor through this object. Do
            // not dispatch an unmatched EndEditText, which could release another mod's lock.
            zfeLog("warn", "input", "SharedHUDTools EndTextEdit unavailable (" + reason + ")");
        }
    }

    // =========================================================================
    // SharedHUDTools text-entry (PRIMARY)
    // =========================================================================

    function openInputSharedHudTools():Void {
        if (_disposed || _inputOpen) return;
        if (_hudTools == null) {
            constructHudTools();
            if (_hudTools == null) {
                zfeLog("warn", "input", "SharedHUDTools unavailable; cannot open input");
                return;
            }
        }
        clearNavigationLatches();
        _inputOpen = true;
        setPrompt(typingPrompt());
        zfeLog("info", "input path", "shared-hud-tools");

        // ── Step 1: FormatTextEdit — position + style the entry box ─────────
        // x/y are stage coordinates (1920×1080 space). Position at widget's lower edge.
        // Color args are hex strings WITHOUT '#'. Font arg is the engine body alias.
        var editX:Float = x + 6;
        var editY:Float = y + _cfg.height - INPUT_H + 4;
        var editW:Float = _cfg.width - 12;
        var editH:Float = INPUT_H - 6;
        var textEditStarted:Bool = false;

        try {
            var formatEdit:Dynamic = Reflect.field(_hudTools, "FormatTextEdit");
            var formatOsk:Dynamic = Reflect.field(_hudTools, "FormatOnScreenKeyboard");
            var textEdit:Dynamic = Reflect.field(_hudTools, "TextEdit");
            if (formatEdit == null || formatOsk == null || textEdit == null) {
                throw "SharedHUDTools text-edit API incomplete";
            }
            Reflect.callMethod(_hudTools, formatEdit,
                [editX, editY, editW, editH,
                 FONT_BODY,                  // engine alias — matches HUDTools' entry_tf default ($MAIN_Font_Light)
                 _cfg.fontSize,
                 nh(_cfg.tabActiveColor),    // text color — no '#'
                 nh(_cfg.tabRowColor),       // bg color — no '#'
                 0.96]);                    // bg alpha (>0 triggers background rendering)
            zfeLog("info", "input", "FormatTextEdit ok");

            // ── Step 2: FormatOnScreenKeyboard — REQUIRED even on PC/KB/mouse ───
            // Position off-screen (y=-300) so the gamepad OSK is invisible on PC.
            Reflect.callMethod(_hudTools, formatOsk,
                [0.0, -300.0]);
            zfeLog("info", "input", "FormatOnScreenKeyboard ok");

            // ── Step 3: TextEdit — open the entry; callback fires on submit ──────
            textEditStarted = true;
            Reflect.callMethod(_hudTools, textEdit,
                [function(text:Dynamic):Void { onInputSubmitSafely(text); }, ""]);
            // HUDTools renders its own focused entry field at this exact input position.
            // Do not mirror that same field into _promptTf, or every character appears twice.
            setPrompt(typingPrompt());
            zfeLog("info", "input", "opened");
        } catch (e:Dynamic) {
            // A partial Format/OSK/TextEdit sequence is not a usable editor. EndTextEdit is
            // only requested after TextEdit was entered; otherwise the local state is enough
            // and the native no-lock fallback may be attempted by openInput().
            zfeLog("warn", "input", "SharedHUDTools open failed: " + clip200(Std.string(e)));
            if (textEditStarted) closeInputSharedHudTools("open failure");
            else resetSharedInputState();
        }
    }

    /**
     * Callback from SharedHUDTools.TextEdit.
     * text == null: user cancelled (Esc/Tab) or TextEdit failed.
     * text == String: user submitted (Enter); may be empty.
     * Fires exactly once; textFunction is nulled by SharedHUDTools after.
     */
    function onInputSubmit(text:Dynamic):Void {
        if (_disposed) return;
        _inputOpen = false;
        clearNavigationLatches();
        setPrompt(idlePrompt());
        var s:String = (text == null) ? "" : Std.string(text);
        handleSubmittedText(s);
    }

    function onInputSubmitSafely(text:Dynamic):Void {
        if (_disposed) return;
        try {
            onInputSubmit(text);
        } catch (err:Dynamic) {
            _inputOpen = false;
            clearNavigationLatches();
            zfeLog("warn", "input", "TextEdit callback isolated: " + clip200(Std.string(err)));
            try { setPrompt(idlePrompt()); } catch (_:Dynamic) {}
        }
    }

    /**
     * Shared submit handler — used by BOTH the native fallback (pollNativeInput) and
     * the SharedHUDTools primary path (onInputSubmit). Applies the slash channel-switch
     * logic ("/g /t /e /i /r"), consuming a bare slash command, then sends the rest.
     */
    function handleSubmittedText(text:String):Void {
        var s:String = (text == null) ? "" : Std.string(text);
        s = StringTools.trim(s);
        if (s.length == 0) return;

        // /relink is local and standalone. It must be consumed before auth-gated sending and
        // before the channel parser; when the game strips a leading slash, bare "relink" is
        // accepted by FcmCommand as the equivalent input.
        if (FcmCommand.isRelink(s)) { requestRelink(); return; }

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
        if (_disposed) return;
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
            setLogText(_serverSessionError.length > 0
                ? ("Server chat is unavailable: " + _serverSessionError)
                : "Server chat is initializing...");
            zfeLog("warn", "server", "ordinary send blocked; session not ready");
            return;
        }

        // Provider calls may block or enqueue work. Create one local transaction row first,
        // then enter the provider on the next timer tick so a slow TLS/socket operation cannot
        // hold the Scaleform frame before the player sees their own message.
        var localUserId:String = _relayUserId.length > 0 ? _relayUserId : _userId;
        var localSendId:String = nextLocalSendId();
        var nativeSubmit:Bool = _nativeSubmitInFlight;
        var ownCosmetics = ownCosmeticsForSend();
        addOptimisticEcho(slug, raw, "", ownCosmetics.tag, ownCosmetics.supporterStar,
            ownCosmetics.starColor, localUserId, localSendId);
        zfeLog("info", "echo", "created canonical local row; transport deferred ch=" + slug);

        var sendTimer:Timer = new Timer(1, 1);
        sendTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            if (_disposed) return;
            try {
                // Array.remove compiles to Flash 19 removeAt, unavailable on older GFx.
                // Keep cleanup inside the same exception boundary as transport dispatch.
                var timerIndex:Int = _sendTimers.indexOf(sendTimer);
                if (timerIndex >= 0) _sendTimers.splice(timerIndex, 1);
                zfeLog("info", "send", "deferred callback entered ch=" + slug);
                runSendTransportSafely(slug, raw, nativeSubmit, localSendId, localUserId);
            } catch (err:Dynamic) {
                zfeLog("warn", "send", "deferred callback failed: " + clip200(Std.string(err)));
                try { removeOptimisticRecord(localSendId); renderRecords(); } catch (_:Dynamic) {}
            }
        });
        _sendTimers.push(sendTimer);
        sendTimer.start();
    }

    function runSendTransportSafely(slug:String, raw:String, nativeSubmit:Bool,
            localSendId:String, localUserId:String):Void {
        if (_disposed) return;
        try {
            sendMessageTransport(slug, raw, nativeSubmit, localSendId, localUserId);
        } catch (err:Dynamic) {
            zfeLog("warn", "send", "send timer isolated: " + clip200(Std.string(err)));
            try { removeOptimisticRecord(localSendId); } catch (_:Dynamic) {}
            try {
                if (slug == CHAN_SLUGS[_chanIdx]) renderRecords();
            } catch (_:Dynamic) {}
        }
    }

    /** Invoke the provider after the optimistic row had a paint opportunity. */
    function sendMessageTransport(slug:String, raw:String, nativeSubmit:Bool, localSendId:String,
            localUserId:String):Void {
        if (_api == null || !_connected) {
            removeOptimisticRecord(localSendId);
            if (slug == CHAN_SLUGS[_chanIdx]) renderRecords();
            zfeLog("warn", "send", "not connected; cannot send");
            return;
        }
        if (_authState != "authenticated") {
            removeOptimisticRecord(localSendId);
            if (slug == CHAN_SLUGS[_chanIdx]) renderRecords();
            zfeLog("warn", "send", "send blocked; authState=" + _authState + " (account not linked)");
            setLogText(linkHint());
            return;
        }

        if (raw.length > _cfg.maxSendLen) raw = raw.substr(0, _cfg.maxSendLen);
        raw = fcmClean(raw);
        if (raw.length == 0) {
            // sendMessage() creates the optimistic row before deferring transport. A
            // control-character-only draft must remove that exact transaction rather than
            // leaving a permanent phantom message in the feed.
            removeOptimisticRecord(localSendId);
            if (slug == CHAN_SLUGS[_chanIdx]) renderRecords();
            return;
        }

        if (slug == "server" && !_serverSessionReady) {
            // Never send ordinary server traffic until the same relay has acknowledged the
            // roster/world control. This avoids presenting a selectable dead tab during a
            // delayed deploy, reconnect, or rejected control.
            setLogText(_serverSessionError.length > 0
                ? ("Server chat is unavailable: " + _serverSessionError)
                : "Server chat is initializing...");
            removeOptimisticRecord(localSendId);
            if (slug == CHAN_SLUGS[_chanIdx]) renderRecords();
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
            if (nativeSubmit) {
                zfeLog("info", "nativein", "send-in-session raw=" + clip200(rs));
            }
            var success:Bool = (rs.indexOf('"success":true') >= 0 || rs.indexOf('success:true') >= 0);
            if (success) {
                zfeLog("info", "send", "sent ch=" + slug + " len=" + raw.length);
                // A successful send proves this identity is LINKED — clear the link gate.
                if (_needsLink) { clearLinkGate("successful send"); }
                // Register the confirmed send for authoritative live-echo reconciliation.
                // Prefer the relay id, but retain the authenticated native id during the brief
                // window before getAuthState has populated the relay-specific field. The native
                // bridge may strip additive fields, so the known targetUserId carrier supplies
                // the stable relay message ID and any resolved cosmetics that are available.
                {
                    var messageId:String = extractJsonString(rs, "messageId");
                    var ackTag:String = extractJsonString(rs, "tag");
                    var ackStarColor:String = extractJsonString(rs, "starColor");
                    // ZFE may strip additive cosmetic members from native RPC responses, just as
                    // it does for live event frames. v2.10.16+ relays mirror the message ID and
                    // validated cosmetics in the known targetUserId member.
                    var ackHudTransport:String = extractJsonString(rs, "targetUserId");
                    var ackTransportMessageId:String = FcmConfig.hudTransportMessageId(ackHudTransport);
                    if (ackTransportMessageId.length > 0) messageId = ackTransportMessageId;
                    var ackTransportTag:String = FcmConfig.hudTransportTag(ackHudTransport);
                    var ackTransportStarColor:String = FcmConfig.hudTransportStarColor(ackHudTransport);
                    if (ackTransportTag.length > 0) ackTag = ackTransportTag;
                    if (ackTransportStarColor.length > 0) ackStarColor = ackTransportStarColor;
                    var ackSupporterStar:Bool = FcmConfig.supporterStarPresent(
                        extractJsonBool(rs, "supporterStar")
                            || FcmConfig.hudTransportHasStar(ackHudTransport), ackStarColor);
                    var ackCosmeticsKnown:Bool = StringTools.startsWith(
                        ackHudTransport, FcmConfig.HUD_COSMETICS_TRANSPORT_PREFIX)
                        || rs.indexOf('"tag":') >= 0
                        || rs.indexOf('"supporterStar":') >= 0
                        || rs.indexOf('"starColor":') >= 0;
                    var ackUpdated:Bool = updateOptimisticRecord(localSendId, messageId, ackTag,
                        ackSupporterStar, ackStarColor, ackCosmeticsKnown);
                    zfeLog("info", "cosmetics", "sendAck len=" + rs.length
                        + " provider=" + (_api == null ? "none" : _api.provider)
                        + " id=" + (messageId.length > 0 ? "y" : "n")
                        + " transportId=" + (ackTransportMessageId.length > 0 ? "y" : "n")
                        + " tag=" + (ackTag.length > 0 ? "y" : "n")
                        + " star=" + (ackSupporterStar ? "y" : "n")
                        + " color=" + (ackStarColor.length > 0 ? "y" : "n")
                        + " cosmeticsKnown=" + (ackCosmeticsKnown ? "y" : "n")
                        + " optimisticUpdated=" + (ackUpdated ? "y" : "n"));
                    zfeLog("info", "echo", "awaiting authoritative live echo ch=" + slug
                        + " ackCosmetics=" + (ackCosmeticsKnown ? "y" : "n"));
                }
                scheduleEchoPoll();
            } else {
                removeOptimisticRecord(localSendId);
                if (slug == CHAN_SLUGS[_chanIdx]) renderRecords();
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
            removeOptimisticRecord(localSendId);
            if (slug == CHAN_SLUGS[_chanIdx]) renderRecords();
            zfeLog("warn", "send", "sendMessage threw: " + Std.string(e));
            setLogText("Send failed (no relay).");
        }
    }

    // =========================================================================
    // ZFE/xScal API discovery + chat boot
    // =========================================================================

    /**
     * init() — entry point called 3 s after stage attach.
     *
     * ZFE or xScal installs its bridge on the HUDMenu root a few seconds after
     * dxgi.dll loads. Retry every ZFE_SEARCH_MS ms up to ZFE_SEARCH_MAX times.
     */
    function init():Void {
        if (_disposed) return;
        _zfeSearchTries = 0;
        tryFindZfe();
    }

    function runInitSafely():Void {
        if (_disposed) return;
        try {
            init();
        } catch (err:Dynamic) {
            zfeLog("warn", "startup", "init timer isolated: " + clip200(Std.string(err)));
            try { runTryFindSafely(); } catch (_:Dynamic) {}
        }
    }

    function tryFindZfe():Void {
        if (_disposed) return;
        _zfeSearchTries++;
        _api = FcmNativeApi.discover(this);
        if (_api != null) {
            onZfeFound();
            return;
        }
        if (_zfeSearchTries >= ZFE_SEARCH_MAX) {
            setLogText("ZFE/xScal not found\nInstall one script extender");
            return;
        }
        setLogText("searching for ZFE/xScal (" + _zfeSearchTries + "/" + ZFE_SEARCH_MAX + ")...");
        if (_zfeSearchTimer != null) { _zfeSearchTimer.stop(); _zfeSearchTimer = null; }
        _zfeSearchTimer = new Timer(ZFE_SEARCH_MS, 1);
        _zfeSearchTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _zfeSearchTimer = null;
            runTryFindSafely();
        });
        _zfeSearchTimer.start();
    }

    function runTryFindSafely():Void {
        if (_disposed) return;
        try {
            tryFindZfe();
        } catch (err:Dynamic) {
            zfeLog("warn", "startup", "provider search timer isolated: " + clip200(Std.string(err)));
        }
    }

    function onZfeFound():Void {
        if (_disposed) return;
        if (_zfeSearchTimer != null) { _zfeSearchTimer.stop(); _zfeSearchTimer = null; }

        // Probe only the provider selected by FcmNativeApi. Calling the ZFE
        // chat.v1 runtime verb on xScal's generic __SFCodeObj is a dispatch
        // failure and was the source of the reported xScal log line.
        if (!_api.probeChatCapability()) {
            if (_api.provider == FcmNativeApi.ZFE) {
                zfeLog("warn", "startup", "zfe-chat-online-v1 not present; need ZFE 0.9.8+");
            } else {
                zfeLog("warn", "startup", "xscal-chat-interface capability probe failed");
            }
            setLogText("ZFE 0.9.8+ or xScal chat\ninterface required");
            return;
        }
        zfeLog("info", "startup", VENDOR + " " + VERSION + " loaded");
        zfeLog("info", "startup", "BUILD=chatv1-widget-v" + VERSION);
        zfeLog("info", "startup", _api.provider == FcmNativeApi.ZFE
            ? "zfe-chat-online-v1 OK"
            : "xscal-chat-interface OK");
        zfeLog("info", "startup", "found after " + _zfeSearchTries + " attempt(s)");
        zfeLog(_hudEventListenerAttached ? "info" : "warn", "input",
            _hudEventListenerAttached
                ? "HUDMod::UserEvent stage listener attached"
                : "HUDMod::UserEvent stage listener unavailable; physical input fallback required");

        loadPersistedConfig();
        // Physical Page/arrow polling is provider-level input, not relay state: start it as
        // soon as the extender is known so channel switching works before (and without) auth.
        startPhysicalNavigation();
        startConnect();
    }

    // =========================================================================
    // chat.v1 connect / reconnect
    // =========================================================================

    function resetFalloutIdentity():Void {
        _falloutIdentityReady = false;
        _displayName = "Wanderer";
        _ownCosmeticsKnown = false;
        _ownTag = "";
        _ownSupporterStar = false;
        _ownStarColor = "";
    }

    function startConnect():Void {
        if (_disposed) return;
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

        var connectStatus:String = extractJsonString(rs, "status");
        var connectCode:String = extractJsonString(rs, "code");
        var connectDecision:String = FcmAuthFlow.classify(_api.provider, "", connectStatus, connectCode);
        _connected = true; // native transport accepted; _authState separately gates chat sends
        // Native input is probed lazily on the first open. Never activate it at startup:
        // legacy Windows/ZFE builds can expose the bare probe payload as editable text.
        _nativeInputUsable = _api.supportsNativeInput();
        // A new relay connection has no room membership until the fresh control below is
        // acknowledged. Force a roster send even when the observed names did not change.
        setServerSessionReady(false, "");
        _lastRosterSentAt = 0;
        _lastRosterSent = "";
        resetRosterObservation("relay connection", true);
        _lastWorldId = ""; // force the legacy worldId fallback to rebind after reconnect
        clearServerRecords("relay connection");
        _history.startConnection();
        stopHistoryResyncFallback();
        _lastAuthObservation = "";
        _connectDelay = CONNECT_RETRY_MS;
        // The link gate is NOT cleared here (v2.9.7). The relay's link notice is a one-shot
        // push, so "no notice arrived on this connect" does not mean "linked" — it usually
        // means the push was missed. Staying unlinked until proven otherwise keeps the link
        // screen reachable; a "LINK COMPLETE" notice or a successful send clears it, and the
        // relay re-pushes a fresh code on subscribe while the identity is still limited.
        if (_api.provider == FcmNativeApi.XSCAL && connectDecision == FcmAuthFlow.PENDING) {
            zfeLog("info", "connect", "transport accepted; xScal auth pending");
            setLogText("connecting to chat...");
        } else {
            zfeLog("info", "connect", "connected"
                + (_needsLink ? " (link gate still up)" : ""));
            setLogText(_needsLink ? linkHint() : "connected. loading...");
        }

        bumpAutoHide();   // start the idle countdown (hides after autoHideSec if nothing happens)
        refreshAuthState();
        _cursor = 0;
        startPollTimer();
        startXscalWarmup();
        maybeRequestHistoryResync();
        startWorldTimer();
        startOpenKeyTimer();
    }

    /**
     * Tear down the live session and schedule a reconnect. Every caller previously inlined
     * this same four-step sequence; keeping it in one place stops the paths from drifting.
     */
    function forceReconnect(reason:String):Void {
        if (_disposed) return;
        zfeLog("warn", "connect", "reconnecting: " + reason);
        resetFalloutIdentity();
        clearNavigationLatches();
        if (_inputOpen) {
            if (_nativeInput) closeInputNative();
            else closeInputSharedHudTools("relay reconnect");
        }
        setServerSessionReady(false, "");
        _connected = false;
        stopPollTimer();
        stopEchoPollTimer();
        stopServerHistoryDrain();
        stopWorldTimer();
        stopOpenKeyTimer();
        scheduleConnectRetry();
    }

    /**
     * Start a deliberate account relink.
     *
     * The relay token is owned by ZFE and stored outside the SWF. The widget therefore requests
     * the explicit top-level ZFE `clearChatAuth` operation instead of trying to write
     * `Data/ZFE/chat-auth.bin` through the unrelated vendor-scoped settings API. On older ZFE
     * builds the command is unsupported; leave the existing session alone and show the exact
     * manual fallback so a user is never told that their account was reset when it was not.
     */
    function requestRelink():Void {
        if (_inputOpen) {
            if (_nativeInput) closeInputNative();
            else closeInputSharedHudTools("relink");
        }
        _needsLink          = true;
        _pinnedSystemBody   = "";
        _linkNoticeAt       = 0;
        _linkRefreshPending = false;
        _authState           = "limited";
        _canModerate         = false;
        setServerSessionReady(false, "");

        if (_api == null) {
            setLogText("Relink unavailable: ZFE is not connected. Restart ZFE and try again.");
            zfeLog("warn", "relink", "cannot clear auth without ZFE");
            return;
        }

        var cleared:Bool = false;
        try {
            var raw:String = Std.string(_api.call(CLEAR_AUTH_COMMAND, "{}"));
            cleared = !chatVerbFailed(raw)
                && (nativeTruthy(raw) || raw.indexOf('"cleared":true') >= 0);
            zfeLog(cleared ? "info" : "warn", "relink",
                "clearChatAuth " + (cleared ? "accepted" : "rejected"));
        } catch (e:Dynamic) {
            zfeLog("warn", "relink", "clearChatAuth threw: " + Std.string(e));
        }

        if (!cleared) {
            setLogText("Relink needs the current ZFE. Exit Fallout 76, delete Data/ZFE/chat-auth.bin, then restart.");
            return;
        }

        setLogText("Local chat auth cleared. Reconnecting for a new link code...");
        forceReconnect("user requested relink");
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
        if (_disposed) return;
        if (_connectTimer != null) return;
        _connectTimer = new Timer(_connectDelay, 1);
        _connectTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _connectTimer = null;
            _connectDelay = Std.int(Math.min(_connectDelay * 2, CONNECT_MAX_MS));
            runStartConnectSafely();
        });
        _connectTimer.start();
        setLogText("retrying in " + Std.int(_connectDelay / 1000) + "s...");
    }

    function runStartConnectSafely():Void {
        if (_disposed) return;
        try {
            startConnect();
        } catch (err:Dynamic) {
            zfeLog("warn", "connect", "connect timer isolated: " + clip200(Std.string(err)));
            try { scheduleConnectRetry(); } catch (_:Dynamic) {}
        }
    }

    // =========================================================================
    // chat.v1 auth state
    // =========================================================================

    function refreshAuthState():Void {
        if (_api == null) return;
        try {
            var state:String = Std.string(_api.call("chat.v1.getAuthState", "{}"));
            var observedState:String = extractJsonString(state, "state");
            var observedStatus:String = extractJsonString(state, "status");
            var observedCode:String = extractJsonString(state, "code");
            var authDecision:String = FcmAuthFlow.classify(_api.provider,
                observedState, observedStatus, observedCode);
            var observation:String = observedState + "/" + observedStatus + "/" + observedCode;
            if (_api.provider == FcmNativeApi.XSCAL && observation != _lastAuthObservation) {
                _lastAuthObservation = observation;
                zfeLog("info", "auth", "xscal state=" + logSafe(observedState)
                    + " status=" + logSafe(observedStatus)
                    + " code=" + logSafe(observedCode));
            }
            var uid:String = extractJsonString(state, "userId");
            var linkedUid:String = extractJsonString(state, "linkedUserId");
            if (uid.length > 0) {
                _userId = uid;
                _relayUserId = uid;
                zfeLog("info", "auth", "relay identity available aliases=relay/" + (uid.length > 0 ? "y" : "n")
                    + " linked/" + (linkedUid.length > 0 ? "y" : "n"));
            }
            if (linkedUid.length > 0 && linkedUid != _linkedUserId) {
                _linkedUserId = linkedUid;
                _ownCosmeticsKnown = false;
                _ownTag = "";
                _ownSupporterStar = false;
                _ownStarColor = "";
            }
            var prevAuth:String = _authState;
            var prevCanModerate:Bool = _canModerate;
            var becameAuthenticated:Bool = prevAuth != "authenticated"
                && authDecision == FcmAuthFlow.AUTHENTICATED;
            _authState = authDecision == FcmAuthFlow.AUTHENTICATED
                ? "authenticated" : "limited";
            if (_authState != "authenticated") _linkedUserId = "";
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
            if (authDecision == FcmAuthFlow.AUTHENTICATED) {
                // xScal may complete its worker-side handshake after the initial bounded
                // warm-up has elapsed. Restart that drain once at the transition, not on every
                // steady-state poll, so delayed subscribe history is still prompt and bounded.
                if (becameAuthenticated && _api.provider == FcmNativeApi.XSCAL) {
                    startXscalWarmup();
                }
                maybeRequestHistoryResync();
            } else if (_api.provider == FcmNativeApi.XSCAL
                    && _connected && authDecision == FcmAuthFlow.RECONNECT) {
                forceReconnect("xScal auth state "
                    + (observedState.length > 0 ? observedState : observedCode));
            } else if (_api.provider == FcmNativeApi.XSCAL
                    && authDecision == FcmAuthFlow.PENDING) {
                // xScal returns status=connecting while its worker performs the
                // async hello/register flow. Keep the transport alive and let
                // pollEvents call us again on the normal cadence.
                setLogText("connecting to chat...");
            } else if (_authState != "authenticated" && _connected) {
                // Preserve the established ZFE behavior. Its getAuthState
                // contract is synchronous and a non-authenticated result is a
                // dead session rather than an in-flight connection.
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
        if (_disposed || _api == null || !_connected) return;
        if (_openKeyTimer != null) { _openKeyTimer.stop(); _openKeyTimer = null; }
        _lastChatKey = false;
        _openKeyTimer = new flash.utils.Timer(OPEN_KEY_MS);
        _openKeyTimer.addEventListener(TimerEvent.TIMER, function(_) { runOpenKeySafely(); });
        _openKeyTimer.start();
        zfeLog("info", "nativein", "open-key poll started (" + OPEN_KEY_MS + "ms)");
    }

    function runOpenKeySafely():Void {
        if (_disposed) return;
        try {
            pollOpenKey();
        } catch (err:Dynamic) {
            zfeLog("warn", "nativein", "open-key timer isolated: " + clip200(Std.string(err)));
        }
    }

    function stopOpenKeyTimer():Void {
        if (_openKeyTimer != null) { _openKeyTimer.stop(); _openKeyTimer = null; }
    }

    // =========================================================================
    // Physical navigation fallback — ZFE/xScal Input.* compatibility surface
    // =========================================================================

    /**
     * Register and poll the physical keys that HUDModLoader may collapse to
     * "Unmapped". xScal documents this as Input.RegisterKey/IsKeyPressed, and
     * current ZFE builds expose the same compatibility surface on the generic
     * bridge. Registration does not consume a key or lock Fallout controls.
     */
    function startPhysicalNavigation():Void {
        // Channel switching is local HUD state, so this runs from provider discovery on and
        // deliberately does not wait for (or stop with) the relay session. A player whose
        // relay auth is rejected can still page through channels and read the link screen.
        if (_disposed || _api == null) return;
        stopPhysicalNavigation();
        if (!_api.supportsPhysicalInput()) {
            zfeLog("warn", "input", "physical navigation unavailable; no Input.* dispatcher"
                + " (generic callback or ZFE bridge)");
            return;
        }

        var keyCodes:Array<Int> = [VK_PAGEUP, VK_PAGEDOWN, VK_UP, VK_DOWN, VK_HOME, VK_END];
        for (keyCode in keyCodes) {
            try {
                var registered:Bool = _api.registerPhysicalKey(keyCode);
                zfeLog("info", "input", "physical key registration key=" + keyCode
                    + " result=" + (registered ? "accepted" : "rejected")
                    + " via=" + (_api.inputDispatcherName.length > 0 ? _api.inputDispatcherName : "none")
                    + " raw=" + clip200(_api.lastInputResponse));
                if (registered) _physicalNavRegistered.push(keyCode);
            } catch (e:Dynamic) {
                zfeLog("warn", "input", "Input.RegisterKey threw key=" + keyCode
                    + " error=" + clip200(Std.string(e)));
            }
        }
        if (_physicalNavRegistered.length == 0) {
            zfeLog("warn", "input", "physical navigation registration rejected");
            return;
        }

        _physicalNavReady = true;
        _physicalNavigationDown = new Map();
        _physicalNavTimer = new flash.utils.Timer(PHYSICAL_NAV_POLL_MS);
        _physicalNavTimer.addEventListener(TimerEvent.TIMER,
            function(_) { runPhysicalNavigationSafely(); });
        _physicalNavTimer.start();
        zfeLog("info", "input", "physical navigation poll started provider="
            + _api.provider + " interval=" + PHYSICAL_NAV_POLL_MS + "ms keys="
            + _physicalNavRegistered.join(","));
    }

    function runPhysicalNavigationSafely():Void {
        if (_disposed) return;
        try {
            pollPhysicalNavigation();
        } catch (e:Dynamic) {
            // A target-build Input.* or render failure must not escape a timer callback and
            // become another global UncaughtErrorEvent. Stop this optional fallback if its
            // boundary is unhealthy; named HUD actions remain available.
            zfeLog("warn", "input", "physical navigation timer isolated: " + clip200(Std.string(e)));
            stopPhysicalNavigation();
        }
    }

    function pollPhysicalNavigation():Void {
        if (_disposed || !_physicalNavReady || _api == null) return;
        for (keyCode in _physicalNavRegistered) {
            // Page keys switch channels in either state. Feed-only keys remain ordinary game
            // controls until the player has opened the editor with Insert.
            var action:String = FcmCommand.physicalKeyAction(keyCode);
            if (action == "ArrowUp" || action == "ArrowDown" || action == "Home" || action == "End") {
                if (!FcmCommand.feedNavigationEnabled(_inputOpen, _hidden)) continue;
            }
            var isDown:Bool = _api.isPhysicalKeyPressed(keyCode);
            if (!_physicalNavProbeLogged && keyCode == VK_PAGEUP) {
                // One line per session showing the raw IsKeyPressed answer shape, so a live
                // zfe.log can confirm the decoder without flooding at the poll rate.
                _physicalNavProbeLogged = true;
                zfeLog("info", "input", "physical poll probe key=" + keyCode
                    + " via=" + _api.inputDispatcherName + " raw=" + clip200(_api.lastInputResponse)
                    + " decoded=" + (isDown ? "down" : "up"));
            }
            var wasDown:Bool = _physicalNavigationDown.exists(keyCode)
                && _physicalNavigationDown.get(keyCode);
            if (isDown == wasDown) continue;
            if (isDown) {
                var command:String = FcmCommand.navigationAction(action,
                    _cfg.channelNextKey, _cfg.channelPrevKey);
                var handled:Bool = handleUserEvent(action, true);
                if (command.length > 0) {
                    zfeLog("info", "input", "physical key=" + keyCode + " action=" + action
                        + " edge=down command=" + command + " handled=" + (handled ? "true" : "false"));
                }
                _physicalNavigationDown.set(keyCode, true);
            } else {
                // The physical API supplies both edges, so release only clears the shared latch.
                // Do not re-run handleUserEvent on key-up: a bubbling HUD event may already have
                // cleared that latch, and invoking the key-up-only compatibility path afterward
                // would switch the channel a second time.
                _physicalNavigationDown.remove(keyCode);
                _navigationActionsDown.remove(FcmCommand.actionKey(action));
            }
        }
    }

    function stopPhysicalNavigation():Void {
        if (_physicalNavTimer != null) {
            _physicalNavTimer.stop();
            _physicalNavTimer = null;
        }
        if (_api != null) {
            for (keyCode in _physicalNavRegistered) {
                try { _api.unregisterPhysicalKey(keyCode); } catch (e:Dynamic) {}
            }
        }
        _physicalNavRegistered = [];
        _physicalNavigationDown = new Map();
        _physicalNavReady = false;
        _physicalNavProbeLogged = false;
    }

    /** Open chat on a false->true edge of isChatKeyPressed. */
    function pollOpenKey():Void {
        if (_api == null || !_connected) return;
        try {
            // The OpenChatKey is the one configured key exposed by the top-level ZFE chat
            // helper. Other physical navigation keys use the provider Input.* fallback above.
            // On its rising edge, open chat when closed. Slash (/g /t /e /i /r) covers direct
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
        if (_disposed || _api == null || !_connected) return;
        stopPollTimer();
        _pollTimer = new Timer(_cfg.pollMs);
        _pollTimer.addEventListener(TimerEvent.TIMER, function(_) { runEventPollSafely(); });
        _pollTimer.start();
        var initialCount:Int = runEventPollSafely(); // immediate first poll for history
        if (_api != null && _api.provider == FcmNativeApi.ZFE && initialCount >= 64) {
            // ZFE exposes the queue synchronously. A full first batch proves that a second
            // native poll is needed; drain it promptly instead of waiting for pollMs.
            startZfeInitialHistoryDrain();
        }
    }

    /**
     * xScal's connect response only acknowledges starting its async subscriber.
     * Poll a short, bounded warm-up window so subscribe-time history reaches the
     * widget promptly while keeping ZFE on its existing lifecycle.
     */
    function startXscalWarmup():Void {
        if (_disposed) return;
        stopXscalWarmup();
        if (_api == null || _api.provider != FcmNativeApi.XSCAL || !_connected) return;
        _xscalWarmupAttempts = 0;
        scheduleXscalWarmup();
    }

    function scheduleXscalWarmup():Void {
        if (_disposed) return;
        if (_xscalWarmupTimer != null
                || _api == null
                || _api.provider != FcmNativeApi.XSCAL
                || !_connected
                || _xscalWarmupAttempts >= XSCAL_WARMUP_MAX) return;
        _xscalWarmupTimer = new flash.utils.Timer(XSCAL_WARMUP_MS, 1);
        _xscalWarmupTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            runXscalWarmupSafely();
        });
        _xscalWarmupTimer.start();
    }

    function runXscalWarmupSafely():Void {
        if (_disposed) return;
        try {
            _xscalWarmupTimer = null;
            if (_api == null || _api.provider != FcmNativeApi.XSCAL || !_connected) return;
            _xscalWarmupAttempts++;
            runEventPollSafely();
            if (_connected && _xscalWarmupAttempts < XSCAL_WARMUP_MAX) {
                scheduleXscalWarmup();
            }
        } catch (err:Dynamic) {
            zfeLog("warn", "history", "xscal warmup isolated: " + clip200(Std.string(err)));
        }
    }

    function stopXscalWarmup():Void {
        if (_xscalWarmupTimer != null) {
            _xscalWarmupTimer.stop();
            _xscalWarmupTimer = null;
        }
        _xscalWarmupAttempts = 0;
    }

    /** Drain a second ZFE startup batch without turning steady-state polling into a hot loop. */
    function startZfeInitialHistoryDrain():Void {
        stopZfeInitialHistoryDrain();
        if (_disposed || _api == null || _api.provider != FcmNativeApi.ZFE || !_connected) return;
        _zfeInitialDrainAttempts = 0;
        scheduleZfeInitialHistoryDrain();
    }

    function scheduleZfeInitialHistoryDrain():Void {
        if (_disposed || _zfeInitialDrainTimer != null || _api == null
                || _api.provider != FcmNativeApi.ZFE || !_connected
                || _zfeInitialDrainAttempts >= ZFE_INITIAL_DRAIN_MAX) return;
        _zfeInitialDrainTimer = new flash.utils.Timer(ZFE_INITIAL_DRAIN_MS, 1);
        _zfeInitialDrainTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            runZfeInitialHistoryDrainSafely();
        });
        _zfeInitialDrainTimer.start();
    }

    function runZfeInitialHistoryDrainSafely():Void {
        if (_disposed) return;
        try {
            _zfeInitialDrainTimer = null;
            if (_api == null || _api.provider != FcmNativeApi.ZFE || !_connected) return;
            _zfeInitialDrainAttempts++;
            var count:Int = runEventPollSafely();
            // A short batch means the bounded cursor-zero snapshot is drained. Continue only
            // while the provider returns full 64-event batches, with a hard attempt cap.
            if (count >= 64 && _zfeInitialDrainAttempts < ZFE_INITIAL_DRAIN_MAX) {
                scheduleZfeInitialHistoryDrain();
            } else {
                stopZfeInitialHistoryDrain();
            }
        } catch (err:Dynamic) {
            zfeLog("warn", "history", "zfe initial drain isolated: " + clip200(Std.string(err)));
            stopZfeInitialHistoryDrain();
        }
    }

    function stopZfeInitialHistoryDrain():Void {
        if (_zfeInitialDrainTimer != null) {
            _zfeInitialDrainTimer.stop();
            _zfeInitialDrainTimer = null;
        }
        _zfeInitialDrainAttempts = 0;
    }

    /** Poll once on the next event tick after a successful send for a fast authoritative echo. */
    function scheduleEchoPoll():Void {
        if (_disposed) return;
        if (_sendEchoPollTimer != null) return;
        _sendEchoPollTimer = new flash.utils.Timer(SEND_ECHO_POLL_DELAY_MS, 1);
        _sendEchoPollTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            runEchoPollSafely();
        });
        _sendEchoPollTimer.start();
    }

    /** Keep the post-send timer inside the same exception boundary as normal polling. */
    function runEchoPollSafely():Void {
        if (_disposed) return;
        try {
            _sendEchoPollTimer = null;
            if (_api != null && _connected) {
                zfeLog("info", "echo", "polling after send");
                runEventPollSafely();
            }
        } catch (err:Dynamic) {
            zfeLog("warn", "echo", "send echo timer isolated: " + clip200(Std.string(err)));
        }
    }

    function stopPollTimer():Void {
        if (_pollTimer != null) { _pollTimer.stop(); _pollTimer = null; }
        stopXscalWarmup();
        stopZfeInitialHistoryDrain();
        stopHistoryResyncFallback();
    }

    function stopEchoPollTimer():Void {
        if (_sendEchoPollTimer != null) { _sendEchoPollTimer.stop(); _sendEchoPollTimer = null; }
    }

    /**
     * HUDModLoader can recreate this SWF while either provider retains its native subscriber.
     * That subscriber's queue is already drained, so request static history before
     * submitting a fresh roster/world bind for the new game server.
     */
    function requestHistoryResync():Void {
        if (_api == null || !_connected || !_history.needsRecovery(_authState == "authenticated", flash.Lib.getTimer())) return;
        stopHistoryResyncFallback();
        _history.attempted(flash.Lib.getTimer());
        var payload:String = '{"channel":"server","targetUserId":"","body":"' + HISTORY_RESYNC_PREFIX + '"}';
        try {
            var raw:String = Std.string(_api.call("chat.v1.sendMessage", payload));
            if (raw.indexOf('"success":true') >= 0 || raw.indexOf('success:true') >= 0) {
                // Queued/accepted is not completion; await HISTORY-DONE from the subscriber.
                // RESYNC defers SERVER until a fresh bind, including an unchanged roster.
                _lastRosterSentAt = -ROSTER_SEND_MS;
                _lastWorldId = "";
                if (_api.provider == FcmNativeApi.XSCAL) startXscalWarmup();
                else startZfeInitialHistoryDrain();
                zfeLog("info", "history", "resync requested attempt=" + _history.attempts + "; awaiting delivered completion");
            } else {
                zfeLog("warn", "history", "resync rejected raw=" + clip200(raw));
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "history", "resync threw: " + Std.string(e));
        }
    }

    /** Give either provider time to deliver its subscription snapshot before recovery. */
    function scheduleHistoryResyncFallback():Void {
        if (_historyResyncFallbackTimer != null || _api == null || !_connected
                || !FcmNativeApi.widgetMustRequestHistoryResync(_api.provider)
                || !_history.needsRecovery(_authState == "authenticated", flash.Lib.getTimer())) return;
        _historyResyncFallbackTimer = new Timer(HISTORY_RESYNC_FALLBACK_MS, 1);
        _historyResyncFallbackTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            runHistoryResyncFallbackSafely();
        });
        _historyResyncFallbackTimer.start();
    }

    function runHistoryResyncFallbackSafely():Void {
        if (_disposed) return;
        try {
            _historyResyncFallbackTimer = null;
            if (_api == null || !_connected
                    || !_history.needsRecovery(_authState == "authenticated", flash.Lib.getTimer())) return;
            zfeLog("info", "history", _history.dropped
                ? "initial queue reported loss; requesting history RESYNC"
                : "initial subscribe poll empty; requesting history RESYNC");
            requestHistoryResync();
        } catch (err:Dynamic) {
            zfeLog("warn", "history", "resync fallback isolated: " + clip200(Std.string(err)));
        }
    }

    function stopHistoryResyncFallback():Void {
        if (_historyResyncFallbackTimer != null) {
            _historyResyncFallbackTimer.stop();
            _historyResyncFallbackTimer = null;
        }
    }

    function maybeRequestHistoryResync():Void {
        scheduleHistoryResyncFallback();
    }

    /**
     * Timer/event boundaries must not let a target-build native or render exception escape into
     * Scaleform's global UncaughtErrorEvent handler. Keep the timer alive and identify the phase
     * so a later in-game log can distinguish transport, auth, and render failures.
     */
    function runEventPollSafely():Int {
        if (_disposed) return 0;
        _eventPollPhase = "timer";
        try {
            var count:Int = pollEvents();
            _eventPollPhase = "idle";
            return count;
        } catch (e:Dynamic) {
            zfeLog("warn", "poll", "isolated timer exception phase=" + _eventPollPhase
                + " error=" + clip200(Std.string(e)));
        }
        _eventPollPhase = "idle";
        return 0;
    }

    function pollEvents():Int {
        _eventPollPhase = "guard";
        if (_api == null || !_connected) return 0;
        // Swap an expired link code for a fresh one before doing anything else — the reconnect
        // this may trigger tears down the poll timer we are running on.
        _eventPollPhase = "link-refresh";
        maybeRefreshLinkCode();
        if (!_connected) return 0;
        // xScal's connect() is asynchronous. Refreshing here advances its
        // pending -> authenticated transition without issuing another connect.
        if (_api.provider == FcmNativeApi.XSCAL) {
            _eventPollPhase = "auth-refresh";
            refreshAuthState();
            if (!_connected) return 0;
        }
        _eventPollPhase = "history-resync";
        maybeRequestHistoryResync();
        _eventPollPhase = "poll-call";
        var payload:String = '{"max":64,"cursor":' + _cursor + '}';
        var result:Dynamic = null;
        try {
            result = _api.call("chat.v1.pollEvents", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "poll", "call threw: " + Std.string(e));
            notePollFailure("call threw");
            return 0;
        }

        _eventPollPhase = "response";
        var rs:String = Std.string(result);
        if (rs.indexOf('"success":false') >= 0 || rs.indexOf('success:false') >= 0) {
            if (rs.indexOf('auth_token_invalid') >= 0 || rs.indexOf('auth_token_revoked') >= 0
                    || rs.indexOf('user_banned') >= 0) {
                forceReconnect("relay returned an auth error on poll");
            } else if (_api.provider == FcmNativeApi.XSCAL
                    && FcmAuthFlow.isPendingTransportResponse(rs)) {
                // The xScal worker has not opened its subscriber yet. This is
                // expected while connect() reports status=connecting; do not
                // spend the poll-failure budget or restart the worker.
                return 0;
            } else {
                notePollFailure("relay returned an unsuccessful response");
            }
            return 0;
        }

        _consecutivePollFailures = 0;
        _eventPollPhase = "render";
        var parsed:Int = parseAndRenderEvents(rs);
        _eventPollPhase = "complete";
        return parsed;
    }

    /** Reconnect instead of leaving the HUD in a permanently stale "connected" state. */
    function notePollFailure(reason:String):Void {
        _consecutivePollFailures++;
        zfeLog("warn", "poll", "failure=" + _consecutivePollFailures + " reason=" + reason);
        if (_consecutivePollFailures < 3) return;
        forceReconnect("poll failure threshold reached");
    }

    function parseAndRenderEvents(rs:String):Int {
        var evStart:Int = FcmWire.findEventsArrayStart(rs);
        if (evStart < 0) return 0;

        // Keep the pending rows as the canonical transaction records. Their eligibility
        // window is enforced by FcmEcho.choose(), so a stale send cannot consume a newer
        // event merely because its text happens to be identical.

        var newRecords:Bool = false;
        var parsedCount:Int = 0;   // diagnostic: events seen this poll (logged below)
        var droppedCount:Int = 0;  // provider queue-loss markers still advance the cursor
        var wireStarCount:Int = 0;
        var wireStarColorCount:Int = 0;
        var wireTagCount:Int = 0;
        var wireTransportCount:Int = 0;
        var wireMessageIdCount:Int = 0;
        var wireTransportMessageIdCount:Int = 0;
        var wireSenderIdCount:Int = 0;
        var ownEchoMatchedCount:Int = 0;
        var ownEchoIdMatchCount:Int = 0;
        var ownEchoFallbackMatchCount:Int = 0;
        var ownEchoAmbiguousCount:Int = 0;
        var recordsBefore:Int = _records.length;
        var i:Int = evStart;
        while (i < rs.length) {
            var objStart:Int = rs.indexOf('{', i);
            if (objStart < 0) break;
            var j:Int = jsonObjectEnd(rs, objStart);
            if (j >= rs.length) break;
            var obj:String = rs.substring(objStart, j + 1);
            i = j + 1;

            if (FcmWire.isDroppedEvent(obj)) {
                updateCursorFromEvent(obj);
                parsedCount++;
                droppedCount++;
                _history.dropped = true;
                continue;
            }

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
            if (rawChannel == "system" && senderUserId == "system" && body == "FCMCTL/1/HISTORY-DONE") {
                updateCursorFromEvent(obj);
                _history.finish();
                stopHistoryResyncFallback();
                zfeLog("info", "history", "replay completed");
                continue;
            }
            // The web client renders Discord custom emojis from CDN images. The
            // Scaleform HUD cannot safely load those images, so keep the readable
            // emoji name and remove the numeric Discord snowflake from this surface.
            var displayBody:String  = FcmConfig.normalizeDiscordEmojiMarkup(body);
            var messageId:String    = extractJsonString(obj, "messageId");
            var transportMessageId:String = FcmConfig.hudTransportMessageId(hudTransport);
            if (transportMessageId.length > 0) messageId = transportMessageId;
            var evId:Int            = extractJsonInt(obj, "id");
            if (senderUserId.length > 0) wireSenderIdCount++;
            if (messageId.length > 0) wireMessageIdCount++;
            if (transportMessageId.length > 0) wireTransportMessageIdCount++;

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

            _history.observe(channel);

            // Reconcile a pending self-send in place. The relay is the source of truth for
            // cosmetics, but appending a second canonical row would duplicate the message when
            // the event arrives after the optimistic row.
            if (reconcileOwnEcho(messageId, senderUserId, channel, body, displayName, tag,
                    supporterStar, starColor)) {
                ownEchoMatchedCount++;
                if (_lastEchoMatchMode == "id") ownEchoIdMatchCount++;
                else ownEchoFallbackMatchCount++;
                markSeenEvent(channel, evId, messageId);
                newRecords = true;
                continue;
            }
            if (_lastEchoMatchMode == "ambiguous") ownEchoAmbiguousCount++;

            // Store ALL known channels (renderRecords filters to the active tab).
            // The old active-channel ingest filter silently discarded every other
            // channel's one-shot subscribe backfill — history looked empty on
            // Trading/Events/Raids/Infests forever after connect.
            if (CHAN_SLUGS.indexOf(channel) < 0) continue;
            if (!markSeenEvent(channel, evId, messageId)) continue;

            _records.push({
                color: hx(_cfg.senderColor), channel: channel, user: displayName,
                tag: tag, supporterStar: supporterStar, starColor: starColor, body: displayBody,
                messageId: messageId, senderUserId: senderUserId, pending: false,
                localSendId: "", pendingAt: 0, sendAccepted: false,
            });
            while (_records.length > _cfg.maxMessages) _records.shift();
            if (_bScrolling) _newWhileScrolled++;
            newRecords = true;
        }

        if (parsedCount > 0) zfeLog("info", "recv", "events=" + parsedCount + " cursor=" + _cursor
            + " newRecords=" + (newRecords ? "y" : "n")
            + " dropped=" + droppedCount
            + " wireStars=" + wireStarCount + " wireStarColors=" + wireStarColorCount
            + " wireTags=" + wireTagCount + " wireTransport=" + wireTransportCount
            + " wireMessageIds=" + wireMessageIdCount
            + " wireTransportIds=" + wireTransportMessageIdCount
            + " wireSenderIds=" + wireSenderIdCount
            + " ownEchoMatched=" + ownEchoMatchedCount
            + " ownEchoId=" + ownEchoIdMatchCount
            + " ownEchoFallback=" + ownEchoFallbackMatchCount
            + " ownEchoAmbiguous=" + ownEchoAmbiguousCount
            + " recordsBefore=" + recordsBefore + " recordsAfter=" + _records.length);
        if (droppedCount > 0) {
            zfeLog("warn", "recv", "provider reported dropped events; cursor advanced without replay");
            scheduleHistoryResyncFallback();
        } else if (_history.staticEventsSeen && !_history.dropped && !_history.resyncSent) {
            // A fresh subscribe snapshot has arrived. Do not issue an immediate recovery replay;
            // the duplicate would consume the remaining native queue capacity.
            stopHistoryResyncFallback();
        }
        seedOwnCosmeticsFromHistory();
        if (newRecords) {
            if (_autoHideOn && _hidden) show();   // auto-hide: pop back up on a new message
            renderRecords();
            bumpAutoHide();                        // any new message counts as activity
        }
        return parsedCount;
    }

    /** Keep replay identity scoped to the feed whose records are retained. */
    function markSeenEvent(channel:String, eventId:Int, messageId:String):Bool {
        return _history.accept(channel, eventId, messageId,
            Std.int(Math.max(256, _cfg.maxMessages * 2)));
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

    /** Generate the only identity used to mutate a local send row after it is created. */
    function nextLocalSendId():String {
        var id:String = "send-" + _nextSendSequence;
        _nextSendSequence++;
        if (_nextSendSequence > 1000000) _nextSendSequence = 1;
        return id;
    }

    /**
     * Reconcile one pending transaction with authoritative fields, without appending a
     * duplicate. ACKs identify the row by localSendId; events are assigned through the pure
     * FcmEcho decision table (stable id, identity, then bounded legacy fallback).
     */
    function reconcileOwnEcho(messageId:String, senderUserId:String, channel:String, body:String,
            displayName:String, tag:String, supporterStar:Bool, starColor:String):Bool {
        _lastEchoMatchMode = "";
        var normalized:String = FcmConfig.normalizeDiscordEmojiMarkup(body);
        var pending:Array<FcmEcho.FcmPendingEcho> = [];
        for (i in 0..._records.length) {
            var pendingRecord:ChatRecord = _records[i];
            if (!pendingRecord.pending) continue;
            pending.push({
                recordIndex: i,
                channel: pendingRecord.channel,
                body: pendingRecord.body,
                senderUserId: pendingRecord.senderUserId,
                displayName: pendingRecord.user,
                messageId: pendingRecord.messageId,
                createdAt: pendingRecord.pendingAt,
                accepted: pendingRecord.sendAccepted,
            });
        }
        var decision:FcmEcho.FcmEchoDecision = FcmEcho.choose(messageId, senderUserId, displayName,
            channel, normalized, pending, flash.Lib.getTimer(), _relayUserId,
            _userId, _linkedUserId, true);
        if (decision.recordIndex < 0) {
            _lastEchoMatchMode = decision.mode;
            return false;
        }

        _lastEchoMatchMode = decision.mode;
        var rec:ChatRecord = _records[decision.recordIndex];
        rec.messageId = messageId.length > 0 ? messageId : rec.messageId;
        rec.senderUserId = senderUserId.length > 0 ? senderUserId : rec.senderUserId;
        if (displayName != null && displayName.length > 0) rec.user = displayName;
        rec.tag = tag;
        rec.supporterStar = supporterStar;
        rec.starColor = starColor;
        rec.body = normalized;
        rec.pending = false;
        rec.localSendId = "";
        rec.pendingAt = 0;
        rec.sendAccepted = false;
        rememberOwnCosmetics(rec.tag, rec.supporterStar, rec.starColor);
        if (channel == CHAN_SLUGS[_chanIdx]) renderRecords();
        return true;
    }

    /** Store only server-resolved HUD cosmetics for the known local sender. */
    function rememberOwnCosmetics(tag:String, supporterStar:Bool, starColor:String):Void {
        _ownCosmeticsKnown = true;
        _ownTag = tag == null ? "" : tag;
        _ownSupporterStar = supporterStar;
        _ownStarColor = starColor == null ? "" : starColor;
    }

    /**
     * Seed the legacy-ACK cache from an authoritative history row. If the relay
     * has supplied the linked UUID, use it exactly. Older Dev auth responses omit
     * that alias, so the compatibility path requires one and only one sender UUID
     * behind the local display name; otherwise it refuses to guess.
     */
    function seedOwnCosmeticsFromHistory():Void {
        if (_ownCosmeticsKnown) return;

        var candidate:ChatRecord = null;
        if (_linkedUserId.length > 0) {
            for (rec in _records) {
                if (!rec.pending && rec.senderUserId == _linkedUserId) candidate = rec;
            }
        } else {
            var senderIds:Array<String> = [];
            for (rec in _records) {
                if (rec.pending || rec.user == null || _displayName == null) continue;
                if (StringTools.trim(rec.user).toLowerCase()
                        != StringTools.trim(_displayName).toLowerCase()) continue;
                if (rec.senderUserId == null || rec.senderUserId.length == 0) continue;
                if (senderIds.indexOf(rec.senderUserId) < 0) senderIds.push(rec.senderUserId);
            }
            if (senderIds.length != 1) return;
            for (rec in _records) {
                if (!rec.pending && rec.senderUserId == senderIds[0]) candidate = rec;
            }
        }

        if (candidate != null) {
            rememberOwnCosmetics(candidate.tag, candidate.supporterStar, candidate.starColor);
        }
    }

    function ownCosmeticsForSend():{tag:String, supporterStar:Bool, starColor:String} {
        seedOwnCosmeticsFromHistory();
        return {
            tag: _ownCosmeticsKnown ? _ownTag : "",
            supporterStar: _ownCosmeticsKnown && _ownSupporterStar,
            starColor: _ownCosmeticsKnown ? _ownStarColor : ""
        };
    }

    /** Paint a local send immediately; the ACK/event then replaces fallback cosmetics authoritatively. */
    function addOptimisticEcho(channel:String, body:String, messageId:String, tag:String,
            supporterStar:Bool, starColor:String, senderUserId:String, localSendId:String):Void {
        if (senderUserId == null) senderUserId = "";
        _records.push({
            color: hx(_cfg.senderColor), channel: channel, user: _displayName,
            tag: tag, supporterStar: supporterStar, starColor: starColor,
            body: FcmConfig.normalizeDiscordEmojiMarkup(body),
            messageId: messageId, senderUserId: senderUserId, pending: true,
            localSendId: localSendId, pendingAt: flash.Lib.getTimer(), sendAccepted: false,
        });
        while (_records.length > _cfg.maxMessages) _records.shift();
        if (_bScrolling) _newWhileScrolled++;
        if (channel == CHAN_SLUGS[_chanIdx]) renderRecords();
    }

    /** Apply the ACK to the exact transaction row; no text/identity search occurs here. */
    function updateOptimisticRecord(localSendId:String, messageId:String, tag:String,
            supporterStar:Bool, starColor:String, cosmeticsKnown:Bool):Bool {
        for (rec in _records) {
            if (!rec.pending || rec.localSendId != localSendId) continue;
            if (messageId != null && messageId.length > 0) rec.messageId = messageId;
            // Old Dev ACKs contain only {success:true}. Preserve the bounded
            // local snapshot until the authoritative live event arrives. New
            // ACKs carry FCMHUD/1 (or additive fields), so an explicit empty
            // projection is also respected when the user is not a supporter.
            if (cosmeticsKnown) {
                rec.tag = tag;
                rec.supporterStar = supporterStar;
                rec.starColor = starColor;
                rememberOwnCosmetics(tag, supporterStar, starColor);
            }
            rec.sendAccepted = true;
            if (rec.channel == CHAN_SLUGS[_chanIdx]) renderRecords();
            return true;
        }
        return false;
    }

    /** Remove a rejected local send by its transaction token, never by message text. */
    function removeOptimisticRecord(localSendId:String):Void {
        for (i in 0..._records.length) {
            var rec:ChatRecord = _records[i];
            if (rec.pending && rec.localSendId == localSendId) {
                _records.splice(i, 1);
                return;
            }
        }
    }

    function updateCursorFromEvent(obj:String):Void {
        var evId:Int = extractJsonInt(obj, "id");
        if (evId <= 0) evId = extractJsonInt(obj, "cursor");
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
            if (readyOnSuccess) startServerHistoryDrain();
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
        if (!ready) stopServerHistoryDrain();
        if (!ready && _chanIdx == 5) _chanIdx = 0;
        if (changed) {
            rebuildChannelTabs();
            renderRecords();
        }
    }

    function startWorldTimer():Void {
        if (_disposed || _api == null || !_connected) return;
        if (_worldTimer != null) { _worldTimer.stop(); _worldTimer = null; }
        _worldTimer = new Timer(WORLD_POLL_MS);
        _worldTimer.addEventListener(TimerEvent.TIMER, function(_) { runWorldPollSafely(); });
        _worldTimer.start();
        runWorldPollSafely();
    }

    /** Keep the 5-second world/roster timer alive when GFx rejects a native provider read. */
    function runWorldPollSafely():Void {
        if (_disposed) return;
        _worldPollPhase = "timer";
        try {
            checkWorldId();
        } catch (e:Dynamic) {
            zfeLog("warn", "world", "isolated timer exception phase=" + _worldPollPhase
                + " error=" + clip200(Std.string(e)));
        }
        _worldPollPhase = "idle";
    }

    /**
     * Drain server-room backfill promptly after a roster/world acknowledgement. xScal's
     * subscriber is asynchronous, so the ordinary poll interval can otherwise leave the
     * SERVER tab blank for several seconds after a world hop.
     */
    function startServerHistoryDrain():Void {
        if (_disposed || !_connected || _api == null || !_serverSessionReady) return;
        if (_serverHistoryPending) return;
        _serverHistoryPending = true;
        _serverHistoryDrainAttempts = 0;
        _serverHistoryDrainIdleAttempts = 0;
        scheduleServerHistoryDrain();
    }

    function scheduleServerHistoryDrain():Void {
        if (_disposed || !_serverHistoryPending || _serverHistoryDrainTimer != null
                || _api == null || !_connected || _serverHistoryDrainAttempts >= SERVER_HISTORY_DRAIN_MAX) return;
        _serverHistoryDrainTimer = new Timer(SERVER_HISTORY_DRAIN_MS, 1);
        _serverHistoryDrainTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            runServerHistoryDrainSafely();
        });
        _serverHistoryDrainTimer.start();
    }

    function runServerHistoryDrainSafely():Void {
        if (_disposed) return;
        try {
            _serverHistoryDrainTimer = null;
            if (!_serverHistoryPending || _api == null || !_connected || !_serverSessionReady) {
                stopServerHistoryDrain();
                return;
            }
            _serverHistoryDrainAttempts++;
            var count:Int = runEventPollSafely();
            if (count > 0) {
                _serverHistoryDrainIdleAttempts = 0;
            } else {
                _serverHistoryDrainIdleAttempts++;
            }
            // The relay sends the entire server snapshot before acknowledging the roster/world
            // control, but xScal can publish those frames to its subscriber one tick later. Keep
            // draining through a short idle window instead of stopping at the first server row;
            // otherwise the remaining history waits for the normal five-second poll interval.
            if (_serverHistoryDrainIdleAttempts >= SERVER_HISTORY_DRAIN_IDLE_MAX) {
                _serverHistoryPending = false;
                _serverHistoryDrainTimer = null;
                zfeLog("info", "history", "server backfill drain complete events=" + count);
            } else if (_serverHistoryPending && _serverHistoryDrainAttempts < SERVER_HISTORY_DRAIN_MAX) {
                scheduleServerHistoryDrain();
            } else if (_serverHistoryPending) {
                _serverHistoryPending = false;
                zfeLog("warn", "history", "server backfill drain timed out; normal poll remains active");
            }
        } catch (err:Dynamic) {
            zfeLog("warn", "history", "server backfill drain isolated: " + clip200(Std.string(err)));
            if (_serverHistoryPending && _serverHistoryDrainAttempts < SERVER_HISTORY_DRAIN_MAX) {
                scheduleServerHistoryDrain();
            }
        }
    }

    function hasFreshRosterObservation(now:Float):Bool {
        return (now - _lastRosterObservationAt) <= ROSTER_FRESH_MS;
    }

    /** Fresh observed names (within ROSTER_FRESH_MS), unioned from current provider snapshots. */
    function freshRosterNames():Array<String> {
        return _rosterSnapshots.fresh(flash.Lib.getTimer(), ROSTER_FRESH_MS);
    }

    /** Drop only ephemeral SERVER rows before a new roster-derived room is bound. */
    function clearServerRecords(reason:String):Void {
        _history.clearServer();
        var kept:Array<ChatRecord> = [];
        var removed:Int = 0;
        for (rec in _records) {
            if (rec.channel == "server") removed++;
            else kept.push(rec);
        }
        if (removed == 0) return;
        _records = kept;
        _newWhileScrolled = 0;
        zfeLog("info", "history", "cleared server feed rows=" + removed + " reason=" + reason);
        if (_chanIdx == 5) renderRecords();
    }

    /** Roster-derived world membership: send while observations are fresh. The SERVER tab is
     *  driven by the relay acknowledgement, not by this local observation. */
    function tickRoster():Void {
        if (_api == null || !_connected || _relayUserId.length == 0) return;
        // An unlinked account cannot be admitted to the server room. In particular, do not
        // keep issuing synchronous roster calls while the one-shot link notice is being shown.
        if (_needsLink || _authState != "authenticated") return;
        var now:Float = flash.Lib.getTimer();
        _worldPollPhase = "roster-snapshots";
        var names:Array<String> = freshRosterNames();
        _worldPollPhase = "roster-binding";
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
            // A roster replacement with no shared name is the only reliable world-hop signal
            // available from the approved HUD data surfaces. The relay may otherwise compute
            // the same room key and keep this subscriber on the previous server feed. Leave
            // first, clear local ephemeral rows, then let the next tick submit the new roster;
            // the fresh bind triggers the existing server-history backfill.
            if (_serverSessionReady
                    && (_rosterBoundaryPending
                        || FcmCommand.shouldRebindRosterSession(_lastRosterSent, namesField))) {
                zfeLog("info", "world", "roster session changed; clearing feed and rebinding");
                clearServerRecords("roster session changed");
                setServerSessionReady(false, "");
                _lastRosterSentAt = 0;
                _lastRosterSent = "";
                _rosterBoundaryPending = false;
                sendWorldLeaveControl();
                return;
            }
            var retrySuppressed:Bool = !_serverSessionReady && _lastRosterSentAt > 0
                && (now - _lastRosterSentAt) < ROSTER_RETRY_MS;
            if (!retrySuppressed && (!_serverSessionReady
                    || (now - _lastRosterSentAt) >= ROSTER_SEND_MS
                    || namesField != _lastRosterSent)) {
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
            clearServerRecords("roster stale");
            setServerSessionReady(false, "");
            sendWorldLeaveControl();
            _lastRosterSent = "";
            _lastRosterSentAt = 0;
            resetRosterObservation("roster stale", true);
        }
    }

    function checkWorldId():Void {
        _worldPollPhase = "guard";
        if (_api == null || !_connected) return;
        _worldPollCount++;
        _worldPollPhase = "subscribe";
        subscribeRoster();
        // AccountInfoData can be republished during world transitions. Re-read it for local
        // state only; refreshDisplayName never enters the native relay connection path.
        _worldPollPhase = "identity";
        refreshDisplayName();
        // BSUIDataManager.Subscribe() only installs Event.CHANGE listeners; it does not call
        // them for the provider value already in the cache. Pull the current snapshots so a
        // freshly joined server can bind and replay history even when no further CHANGE fires.
        _worldPollPhase = "snapshots";
        refreshRosterSnapshots(_rosterManager);
        _worldPollPhase = "roster";
        tickRoster();
        if (!_dataInventoryDone && _worldPollCount >= 6) {
            _worldPollPhase = "inventory";
            _dataInventoryDone = true;
            dumpDataInventory();
        }
        _worldPollPhase = "world-id";
        var worldId:String = readWorldId();
        if (worldId == _lastWorldId) return;            // no change since last poll
        // worldId is a compatibility fallback. Some HUD builds leave it blank even while the
        // roster provider is fresh, so a blank fallback value must not tear down a successful
        // roster-derived room. tickRoster() owns leave semantics when that observation expires.
        if (worldId.length == 0 && hasFreshRosterObservation(flash.Lib.getTimer())) {
            zfeLog("info", "world", "blank worldId ignored; fresh roster session remains authoritative");
            return;
        }
        _worldPollPhase = "world-transition";
        var wasInWorld:Bool = _inWorld;
        var previousWorldId:String = _lastWorldId;
        _lastWorldId = worldId;
        _inWorld     = (worldId.length > 0);
        if (_inWorld) {
            if (previousWorldId.length > 0 && previousWorldId != worldId) {
                clearServerRecords("legacy worldId changed");
                setServerSessionReady(false, "");
            }
            // JOINED (or hopped to) a world → bind the server room.
            zfeLog("info", "world", "joined world; sending JOIN control");
            sendWorldIdControl(worldId);
        } else if (wasInWorld) {
            // LEFT the world (worldId cleared) → unbind the server room.
            clearServerRecords("legacy worldId cleared");
            zfeLog("info", "world", "left world; sending LEAVE control");
            sendWorldLeaveControl();
            setServerSessionReady(false, "");
        }
        _worldPollPhase = "complete";
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

    static inline var FEED_ROW_GAP:Float = 2;
    // The supporter marker is intentionally a little farther from the closing
    // channel bracket; this also moves the reserved content slot with it.
    static inline var STAR_CHANNEL_GAP:Float = 5;
    static inline var STAR_CONTENT_GAP:Float = 4;
    static inline var STAR_MARKER_Y_NUDGE:Float = 2;

    /** Create a feed-owned TextField with the same explicit HUD font contract as the chrome. */
    function makeFeedTextField(html:String, width:Float, height:Float, wrap:Bool):TextField {
        var tf:TextField = new TextField();
        tf.x = 0;
        tf.y = 0;
        tf.width = Math.max(1, width);
        tf.height = Math.max(20, height);
        tf.multiline = true;
        tf.wordWrap = wrap;
        tf.selectable = false;
        tf.mouseEnabled = false;
        tf.embedFonts = true;
        var fmt:TextFormat = new TextFormat();
        fmt.font = FONT_BODY;
        fmt.size = _cfg.fontSize;
        fmt.color = _cfg.textColor;
        fmt.leading = 0;
        tf.defaultTextFormat = fmt;
        tf.htmlText = html;
        return tf;
    }

    /** GFx reports the width of this small field reliably; use a conservative fallback only if it does not. */
    function measuredFeedWidth(tf:TextField, plain:String):Float {
        var measured:Float = 0;
        try { measured = tf.textWidth + 2; } catch (e:Dynamic) {}
        if (measured > 2) return Math.ceil(measured);
        return Math.max(8, Math.ceil(plain.length * _cfg.fontSize * 0.62));
    }

    function measuredFeedHeight(tf:TextField):Float {
        var measured:Float = _cfg.fontSize + 4;
        try {
            if (tf.textHeight > 0) measured = Math.ceil(tf.textHeight + 2);
        } catch (e:Dynamic) {}
        return Math.max(measured, _cfg.fontSize + 4);
    }

    function measuredFeedLineHeight(tf:TextField):Float {
        var lineHeight:Float = _cfg.fontSize + 4;
        try {
            var metrics:Dynamic = tf.getLineMetrics(0);
            if (metrics != null && metrics.height > 0) lineHeight = metrics.height;
        } catch (e:Dynamic) {}
        return Math.max(lineHeight, _cfg.fontSize + 2);
    }

    /**
     * Build one complete message row. The channel, marker, and content are children of the
     * same row Sprite. The marker therefore moves with its message during rebuilds and scrolls;
     * it cannot drift into the header or be placed over another row by TextField indices.
     */
    function buildFeedMessageRow(rec:ChatRecord, viewportWidth:Float):FeedRowView {
        var row:Sprite = new Sprite();
        var fs:Int = _cfg.fontSize;
        var rawUser:String = rec.user == null ? "" : rec.user;
        var rawBody:String = rec.body == null ? "" : rec.body;
        var rawTag:String = rec.tag == null ? "" : rec.tag;
        var col:String = ~/^#[0-9a-fA-F]{6}$/.match(rec.color) ? rec.color : hx(_cfg.senderColor);
        var channelLabel:String = FcmConfig.chanLabel(rec.channel);
        var channelWidth:Float = 0;

        if (_cfg.showChannelTag) {
            var channelHtml:String = '<font face="' + FONT_BOLD + '" size="' + fs + '" color="'
                + hx(_cfg.channelColor(rec.channel)) + '">[' + channelLabel + ']</font>';
            var channelTf:TextField = makeFeedTextField(channelHtml, viewportWidth, fs + 8, false);
            channelWidth = measuredFeedWidth(channelTf, "[" + channelLabel + "]");
            channelTf.width = channelWidth;
            channelTf.height = fs + 8;
            row.addChild(channelTf);
        }

        var user:String = FcmConfig.htmlEscape(rawUser);
        var msg:String = FcmConfig.htmlEscape(rawBody);
        var customTagHtml:String = (rawTag.length > 0)
            ? '<font face="' + FONT_BOLD + '" size="' + fs + '" color="' + col + '">['
                + FcmConfig.htmlEscape(rawTag) + ']</font> '
            : "";
        var moderationRefHtml:String = "";
        if (_canModerate && rec.messageId != null && rec.messageId.length >= 8
                && rec.senderUserId != null && rec.senderUserId.length > 0) {
            moderationRefHtml = '<font color="' + hx(_cfg.promptColor) + '">[#'
                + rec.messageId.substr(0, 8).toUpperCase() + ']</font> ';
        }
        // The body field starts after the reserved marker slot. This is an intentional hanging
        // layout: all wrapped body lines share the same content origin and can never collide with
        // the channel tag or supporter marker.
        var contentHtml:String = '<font face="' + FONT_BODY + '" size="' + fs + '">'
            + moderationRefHtml + customTagHtml
            + '<font face="' + FONT_BOLD + '" size="' + fs + '" color="' + col + '">' + user + ':</font> '
            + '<font face="' + FONT_BODY + '" size="' + fs + '" color="' + hx(_cfg.textColor) + '">' + msg + '</font>'
            + '</font>';
        var hasMarker:Bool = rec.supporterStar && rawUser.length > 0;
        var markerSize:Float = Math.max(8, Math.min(16, fs * 0.95));
        var channelGap:Float = _cfg.showChannelTag ? STAR_CHANNEL_GAP : 0;
        var initial = FcmStarLayout.row(channelWidth, fs + 4, markerSize,
            channelGap, STAR_CONTENT_GAP, hasMarker, STAR_MARKER_Y_NUDGE);
        var contentWidth:Float = Math.max(20, viewportWidth - initial.contentX);
        var contentTf:TextField = makeFeedTextField(contentHtml, contentWidth, 1000, true);
        contentTf.x = initial.contentX;
        var contentHeight:Float = measuredFeedHeight(contentTf);
        var lineHeight:Float = measuredFeedLineHeight(contentTf);
        var placement = FcmStarLayout.row(channelWidth, lineHeight, markerSize,
            channelGap, STAR_CONTENT_GAP, hasMarker, STAR_MARKER_Y_NUDGE);
        contentTf.x = placement.contentX;
        contentTf.height = contentHeight;
        row.addChild(contentTf);

        if (hasMarker) {
            var star:Shape = makeSupporterStar(
                FcmConfig.supporterStarColor(rec.starColor, _cfg.tabActiveColor), markerSize);
            star.x = placement.markerX;
            star.y = placement.markerY;
            row.addChild(star);
        }
        row.mouseEnabled = false;
        row.mouseChildren = false;
        return { view: row, contentY: 0, height: Math.max(contentHeight, lineHeight) };
    }

    function buildFeedNoticeRow(text:String, viewportWidth:Float):FeedRowView {
        var row:Sprite = new Sprite();
        var html:String = '<font face="' + FONT_BOLD + '" size="' + _cfg.fontSize
            + '" color="' + hx(_cfg.tabActiveColor) + '">' + FcmConfig.htmlEscape(text) + '</font>';
        var tf:TextField = makeFeedTextField(html, viewportWidth, 1000, true);
        var height:Float = measuredFeedHeight(tf);
        tf.height = height;
        row.addChild(tf);
        row.mouseEnabled = false;
        row.mouseChildren = false;
        return { view: row, contentY: 0, height: height };
    }

    function renderRecords():Void {
        if (_logTf == null || _feedLayer == null) return;

        try {
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
        // arrival (_needsLink) is the authoritative "not linked" signal.
        if (_needsLink) { setLogText(linkHint()); return; }

        var visibleRecords:Array<ChatRecord> = [];
        for (rec in _records) {
            if (rec.channel == CHAN_SLUGS[_chanIdx]) visibleRecords.push(rec);
        }
        zfeLog("info", "render", "records=" + _records.length + " shown=" + visibleRecords.length
            + " layout=row-local tags=enabled tab=" + CHAN_SLUGS[_chanIdx]);
        if (visibleRecords.length == 0) {
            setLogText("No messages in " + CHAN_NAMES[_chanIdx] + " yet"); return;
        }

        clearFeedRows();
        _logTf.visible = false;
        _feedLayer.visible = true;
        var contentY:Float = 0;
        for (rec in visibleRecords) {
            var rendered:FeedRowView = buildFeedMessageRow(rec, _logTf.width);
            rendered.contentY = contentY;
            _feedRows.push(rendered);
            _feedLayer.addChild(rendered.view);
            contentY += rendered.height + FEED_ROW_GAP;
        }
        // "v N new" hint when scrolled up and new messages arrived below.
        if (_bScrolling && _newWhileScrolled > 0) {
            var notice:FeedRowView = buildFeedNoticeRow(
                "v " + _newWhileScrolled + " new - wheel down or F11 Scroll to newest", _logTf.width);
            notice.contentY = contentY;
            _feedRows.push(notice);
            _feedLayer.addChild(notice.view);
            contentY += notice.height + FEED_ROW_GAP;
        }
        _feedContentHeight = contentY;
        _feedMaxScrollY = Math.max(0, _feedContentHeight - _logTf.height);
        if (!_bScrolling) {
            _feedScrollY = _feedMaxScrollY;
        } else {
            _feedScrollY = Math.max(0, Math.min(_feedScrollY, _feedMaxScrollY));
            if (_feedMaxScrollY <= 0) { _bScrolling = false; _newWhileScrolled = 0; }
        }
            applyFeedScroll();
        } catch (err:Dynamic) {
            try {
                clearFeedRows();
                _logTf.visible = true;
                _feedLayer.visible = false;
                _logTf.text = "chat render unavailable";
            } catch (_:Dynamic) {}
            zfeLog("warn", "render", "isolated render exception: " + clip200(Std.string(err)));
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

    /** Remove message rows by reference; no native child enumeration is needed. */
    function clearFeedRows():Void {
        if (_feedLayer != null) {
            for (row in _feedRows) {
                try { _feedLayer.removeChild(row.view); } catch (e:Dynamic) {}
            }
        }
        _feedRows = [];
        _feedContentHeight = 0;
        _feedMaxScrollY = 0;
    }

    /** Apply the current content offset to every row inside the clipped feed layer. */
    function applyFeedScroll():Void {
        if (_feedLayer == null) return;
        _feedScrollY = Math.max(0, Math.min(_feedScrollY, _feedMaxScrollY));
        for (row in _feedRows) row.view.y = row.contentY - _feedScrollY;
    }

    public function scrollUp():Void {
        if (_feedLayer == null) return;
        try {
            if (_feedMaxScrollY <= 0) return;
            var before:Float = _feedScrollY;
            _feedScrollY = Math.max(0, _feedScrollY - Math.max(8, _cfg.fontSize + 2));
            if (_feedScrollY != before) _bScrolling = true;
            applyFeedScroll();
        } catch (e:Dynamic) {
            zfeLog("warn", "scroll", "scrollUp threw: " + Std.string(e));
        }
    }

    public function scrollDown():Void {
        if (_feedLayer == null) return;
        try {
            if (_feedMaxScrollY <= 0) {
                _bScrolling = false; _newWhileScrolled = 0;
            } else {
                _feedScrollY = Math.min(_feedMaxScrollY,
                    _feedScrollY + Math.max(8, _cfg.fontSize + 2));
                if (_feedScrollY >= _feedMaxScrollY) {
                    _bScrolling = false; _newWhileScrolled = 0;
                }
            }
            applyFeedScroll();
        } catch (e:Dynamic) {
            zfeLog("warn", "scroll", "scrollDown threw: " + Std.string(e));
        }
    }

    public function scrollToBottom():Void {
        if (_feedLayer == null) return;
        snapLogToBottom();
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

    /** Draw one fixed, font-independent five-point star. */
    function makeSupporterStar(color:Int, size:Float):Shape {
        var star:Shape = new Shape();
        var g = star.graphics;
        var cx:Float = size / 2;
        var cy:Float = size / 2;
        var outer:Float = size / 2;
        var inner:Float = size * 0.22;
        g.beginFill(color, 1.0);
        for (i in 0...10) {
            var radius:Float = (i % 2 == 0) ? outer : inner;
            var angle:Float = -Math.PI / 2 + i * Math.PI / 5;
            var px:Float = cx + Math.cos(angle) * radius;
            var py:Float = cy + Math.sin(angle) * radius;
            if (i == 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.lineTo(cx, cy - outer);
        g.endFill();
        return star;
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
    // Keep a replaceable snapshot per UI provider. The old global _seenNames map merged names
    // forever, so names from the previous world remained in the next ROSTER control until TTL.
    var _rosterSnapshots:FcmRoster = new FcmRoster();
    var _rosterCallbackKeys:Array<String> = [];
    var _rosterCallbacks:Map<String, Dynamic> = new Map();
    var _rosterManager:Dynamic = null;
    // A single provider can publish the new-world roster before another provider refreshes. Keep
    // that boundary instead of letting a stale union member make the old room look current.
    var _rosterBoundaryPending:Bool = false;
    var _lastRosterObservationAt:Float = -ROSTER_FRESH_MS;
    var _lastRosterSentAt:Float = 0;
    var _lastRosterSent:String = "";
    var _lastRosterReadWarningAt:Float = -30000;
    var _rosterLogCount:Int = 0;
    var _lastRosterLogAt:Float = 0;

    /** Remove the exact callbacks registered by subscribeRoster(). */
    function unsubscribeRoster(mgr:Dynamic = null):Void {
        var target:Dynamic = (mgr != null) ? mgr : _rosterManager;
        if (target != null) {
            for (key in _rosterCallbackKeys) {
                var callback:Dynamic = _rosterCallbacks.get(key);
                try {
                    var unsubscribe:Dynamic = Reflect.field(target, "Unsubscribe");
                    if (unsubscribe != null && callback != null) {
                        Reflect.callMethod(target, unsubscribe, [key, callback]);
                    }
                } catch (e:Dynamic) {
                    zfeLog("warn", "roster", "Unsubscribe " + key + " threw: " + Std.string(e));
                }
            }
        }
        _rosterCallbacks = new Map();
        _rosterCallbackKeys = [];
        _rosterSubscribed = false;
    }

    /** Clear provider snapshots at a session boundary; stale names must never seed a new world. */
    function resetRosterObservation(reason:String, detach:Bool = false):Void {
        if (detach) unsubscribeRoster();
        _rosterSnapshots = new FcmRoster();
        _rosterBoundaryPending = false;
        _lastRosterObservationAt = -ROSTER_FRESH_MS;
        _rosterLogCount = 0;
        _lastRosterLogAt = 0;
        zfeLog("info", "roster", "observation reset: " + reason);
    }

    /** Subscribe to the documented BSUIDataManager pull pattern. Re-subscribe after a world
     * transition because the game can replace the provider cache while leaving the manager
     * class itself alive. Every callback is retained so Unsubscribe can remove exactly this
     * widget's listeners before the next subscription. */
    function subscribeRoster():Void {
        var mgr:Dynamic = findBSUI();
        if (mgr == null) return;
        if (_rosterManager != null && _rosterManager != mgr) {
            unsubscribeRoster(_rosterManager);
            resetRosterObservation("BSUIDataManager changed");
        }
        _rosterManager = mgr;
        if (_rosterSubscribed) return;
        try {
            var playerCallback:Dynamic = function(evt:Dynamic):Void {
                try { onRosterChange(evt); } catch (e:Dynamic) {}
            };
            mgr.Subscribe("PlayerListData", playerCallback);
            _rosterCallbacks.set("PlayerListData", playerCallback);
            _rosterCallbackKeys.push("PlayerListData");
            for (k in ["TeamMarkers", "PartyMenuList", "VoiceChatAreaData"]) {
                var key:String = k;
                try {
                    var auxCallback:Dynamic = function(evt:Dynamic):Void {
                        try { onAuxDataChange(key, evt); } catch (e:Dynamic) {}
                    };
                    mgr.Subscribe(key, auxCallback);
                    _rosterCallbacks.set(key, auxCallback);
                    if (_rosterCallbackKeys.indexOf(key) < 0) _rosterCallbackKeys.push(key);
                } catch (e:Dynamic) {}
            }
            _rosterSubscribed = true;
            zfeLog("info", "roster", "subscribed to PlayerListData + TeamMarkers/PartyMenuList/VoiceChatAreaData");
        } catch (e:Dynamic) {
            unsubscribeRoster(mgr);
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

    /** Record a replaceable nearby-player snapshot (TeamMarkers / VoiceChat / PlayerList). */
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
        if (n < 0) return;

        var snapshot:Array<String> = [];
        var localName:String = bareName(_displayName).toLowerCase();
        var skippedEntries:Int = 0;
        for (i in 0...n) {
            // GFx native arrays can be replaced between reading length and reading an index
            // during a world hop. Never let one invalid slot escape the timer boundary.
            try {
                var e0:Dynamic = arr[i];
                if (e0 == null) continue;
                if (uiBool(uiField(e0, "isLocalPlayer"))
                        || uiBool(uiField(e0, "isLocal"))
                        || uiBool(uiField(e0, "isSelf"))) continue;
                var nm:String = "";
                for (cand in ["displayName", "characterName", "name", "playerName"]) {
                    var v:Dynamic = uiField(e0, cand);
                    if (v != null && Std.string(v).length > 0) { nm = Std.string(v); break; }
                }
                nm = bareName(nm);
                if (nm.length > 0 && nm.toLowerCase() != localName && snapshot.indexOf(nm) < 0) {
                    snapshot.push(nm);
                }
            } catch (e:Dynamic) {
                skippedEntries++;
            }
        }
        if (skippedEntries > 0 && now - _lastRosterReadWarningAt >= 30000) {
            _lastRosterReadWarningAt = now;
            zfeLog("warn", "roster", key + " skipped native entries=" + skippedEntries);
        }
        snapshot.sort(function(a, b) return (a < b) ? -1 : (a > b ? 1 : 0));
        var previousSnapshot:Array<String> = _rosterSnapshots.replace(key, snapshot, now);
        // Compare this provider with its own previous value, not the cross-provider union.
        // An unchanged empty auxiliary list is normal and must not clear the feed repeatedly.
        // During a world hop the primary roster surface can already be completely replaced while an auxiliary provider still contains
        // one old name. Remember the disjoint/empty provider snapshot and let tickRoster perform
        // a real LEAVE before the next ROSTER bind.
        var snapshotField:String = snapshot.join("|");
        if (_serverSessionReady && previousSnapshot != null
                && FcmCommand.shouldRebindRosterSession(previousSnapshot.join("|"), snapshotField)) {
            _rosterBoundaryPending = true;
            zfeLog("info", "roster", key + " marks a new session boundary names=" + snapshot.length);
        }
        // An empty update is meaningful: it represents a valid solo world roster and also
        // provides the boundary needed to stop using names from the previous world.
        _lastRosterObservationAt = now;
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

    /** Pull the current UI-layer provider values because Subscribe() does not invoke callbacks. */
    function refreshRosterSnapshots(mgr:Dynamic):Void {
        if (mgr == null) return;
        for (key in ["PlayerListData", "TeamMarkers", "PartyMenuList", "VoiceChatAreaData"]) {
            try {
                var provider:Dynamic = getBSUIData(mgr, key);
                var data:Dynamic = uiData(provider);
                if (data != null) collectRoster(key, data);
            } catch (e:Dynamic) {
                zfeLog("warn", "roster", key + " snapshot phase threw: " + clip200(Std.string(e)));
            }
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

}
