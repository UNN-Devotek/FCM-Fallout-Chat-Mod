import flash.display.MovieClip;
import flash.display.DisplayObjectContainer;
import flash.display.Shape;
import flash.display.Sprite;
import flash.events.Event;
import flash.events.KeyboardEvent;
import flash.events.TimerEvent;
import flash.utils.Timer;
import flash.text.TextField;
import flash.text.TextFieldType;
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
    var createdAt:String;
    var arrivalOrder:Int;
    var serverReplay:Bool;
    @:optional var linkUrl:String;
}

private typedef FeedRowView = {
    @:optional var textField:TextField;
    @:optional var bodyOffset:Int;
    var view:Sprite;
    var contentY:Float;
    var height:Float;
    @:optional var linkUrl:String;
}

private typedef ModerationTargetResolution = {
    var target:Null<ChatRecord>;
    var ambiguous:Bool;
}

/**
 * Optional FCM HUDModLoader child widget; the desktop overlay stays separate.
 * Native transport is selected through FcmNativeApi: ZFE command/JSON dispatch
 * or xScal chatInterface object/no-argument methods. Generic callbacks are separate.
 *
 * General projects the six allowed source channels without copying/rebroadcasting.
 * Retained IDs reject replay before pending echo matching; conflicting stable IDs
 * never fall back to body matching. SERVER records require the current room gate.
 *
 * SharedHUDTools owns ZFE's editor and its balanced ControlMap lifecycle;
 * xScal owns its native text session when available.
 * The child does not dispatch ControlMap lock events. Legacy ZFE editor/Input.*
 * compatibility is distinct from public input.v1.* and hotkeys.v1.* contracts.
 * Idle Page Up/Down changes tabs; feed scrolling requires a visible owned editor.
 *
 * Rendering uses native plain-text rows with TextFormat ranges and measured
 * row-local vector decorations. Runtime-proven Fallout font aliases are used
 * with embedFonts=true; historical failures do not prove universal GFx limits.
 * Optional decoration preserves a styled baseline. Each delayed slice checks
 * its generation and catches its own errors before a readable fallback.
 *
 * The sticky link gate survives reconnect until linked state is established.
 * World/roster observations come only from HUD-published BSUIDataManager data.
 * Diagnostics report bounded status/counts; do not log tokens, names, or bodies.
 * See README.md / BUILD.md and docs/overlay/zfe/ for the maintained contract.
 */
class FCMChatWidget extends MovieClip {

    // ── Widget identity ────────────────────────────────────────────────────────
    static inline var VENDOR:String   = "FCMChatWidget";
    // 2.10.0 is the first build that reports clientVersion to the relay. The relay
    // treats "no version reported" as "oldest possible client" and gates any new wire
    // field on this, so the version bump IS the capability signal.
    static inline var VERSION:String  = "2.10.128"; // chronological private giveaway help
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
    // These are Fallout's active GFx aliases. The current English font config maps
    // "$MAIN_Font" and "$MAIN_Font_Bold"; "$MAIN_Font_Light" is not a valid alias.
    // They resolve in child widget SWFs (ApplicationDomain.currentDomain) with
    // embedFonts=true — no @:font embed needed (GFx ignores child-SWF embedded TTFs).
    #if fcm_harness
    // The game resolves the aliases below through fontconfig_en.txt. Ruffle does not process
    // Bethesda's font config, so the harness addresses the same game font faces directly.
    static inline var FONT_BODY:String = "Roboto Condensed";
    static inline var FONT_BOLD:String = "Roboto Condensed Bold";
    #else
    static inline var FONT_BODY:String = "$MAIN_Font";        // body / feed / messages / prompts / notices
    static inline var FONT_BOLD:String = "$MAIN_Font_Bold";   // tab labels / headers / sender names / active-tab
    #end
    // FALLBACK (do NOT ship unless aliases tofu in-game): re-add the @:font embed and
    // set TextFormat.font / the FormatTextEdit font arg to the TTF's DefineFont FAMILY
    // name "DejaVu Sans" (with the space) — NOT the postscript "DejaVuSans". GFx matches
    // the DefineFont family name; the v2.3.0 build used the postscript name, which is the
    // only reason its embed also rendered tofu as a fallback.

    // ── chat.v1 poll / connect timing ─────────────────────────────────────────
    // Event-poll interval moved to FcmConfig.pollMs (tunable via FCMChat.ini `pollMs`,
    // default 5000) — each poll is a fresh wss/TLS handshake under Wine, so the rate is the
    // game-lag knob. See FcmConfig.pollMs.
    // ZFE's async WSS worker normally publishes chat.send.accepted/failed several hundred
    // milliseconds after queueing. Poll after that window instead of the old next-tick probe,
    // which consistently ran before the completion existed.
    static inline var SEND_ECHO_POLL_DELAY_MS:Int = 750;
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
    // Row order from top: TAB_H (main tab) | SUB_H (channel tabs) | log | input height
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
    // The active feed is an immutable, fully-positioned snapshot. Delayed render slices build
    // into a hidden sibling and replace this container only after the snapshot is complete.
    var _feedContentLayer:Sprite;
    var _pendingFeedContentLayer:Sprite;
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
    var _selectedRowIndex:Int = -1;
    var _nextSendSequence:Int = 1;
    var _nextRecordOrder:Int = 1;
    var _lastEchoMatchMode:String = "";
    var _newWhileScrolled:Int    = 0;
    // Loader versions differ in whether they emit key-down, key-up, or both. Feed/channel
    // navigation is handled on the first edge available, then the matching key-up is ignored.
    var _navigationActionsDown:Map<String,Bool> = new Map();
    // Physical-key polling is an extender bookkeeping/read path, not a game-input lock. Page
    // keys are always eligible for channel navigation; configured feed keys are read only while
    // an Insert-open feed session is active. The map prevents a stage event and the physical
    // path from handling the same press twice.
    var _physicalNavigationDown:Map<Int,Bool> = new Map();
    // Patched HUDMenu calls the widget before it dispatches HUDMod::UserEvent. The matching
    // bubbling event is still useful for unpatched hosts, but must be ignored after the host
    // path has already handled it or Page/TeamChat would execute twice.
    var _hostEventSuppressionKey:String = "";
    // Input diagnostics are deduplicated by action/edge so a bad mapping cannot flood zfe.log.
    var _userEventDiagnostics:Map<String,Bool> = new Map();
    var _xscalCancelDiagnosticPending:Bool = false;
    var _hudEventListenerAttached:Bool = false;

    // ── Channel state ─────────────────────────────────────────────────────────
    var _chanIdx:Int             = 0;   // 0=global

    // ── Hide state (CAP-011) ────────────────────────────────────────────────────
    var _hidden:Bool             = false;   // true while the panel is hidden (/hide, F11 menu, hideKey)
    var _manuallyHidden:Bool     = false;
    var _autoHidden:Bool         = false;
    // Auto-hide: hide after _cfg.autoHideSec of no activity; reveal on a new message. F11-menu toggleable.
    var _autoHideOn:Bool         = false;
    var _autoHideTimer:Timer     = null;
    var _themeIdx:Int            = 0;       // F11 Customize → cycle color theme
    // HUDMode gating — blacklist via hideInHUDModes (single INI key, opinionated default)
    var _hiddenByHUDMode:Bool    = false;
    var _cachedHUDMode:String    = "";
    var _hudModeSubscribed:Bool  = false;
    var _hudModeCallback:Dynamic = null;
    var _menuStackCallback:Dynamic = null;
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
    var _queueLossDiagnosticCount:Int = 0;
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
    static inline var NATIVE_POLL_BATCH:Int = 16;
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
    var _serverSession:FcmServerSession = new FcmServerSession();
    var _serverAtMainMenu:Bool = false;
    var _serverSessionError:String = "";
    var _lastRoomDiagnosticBody:String = "";
    var _roomDiagnosticCount:Int = 0;
    static inline var MAX_ROOM_DIAGNOSTICS:Int = 32;
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
    // One-shot latch so the ZFE grace-expiry notice logs once per handshake.
    var _zfeAuthGraceLogged:Bool = false;
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
    var _inputGeneration:Int = 0;
    var _pipboyTransitionUntil:Float = 0;
    var _inputOpen:Bool          = false;
    // v2.5.3: DECODED native chat-input API — bare-value payloads ("true"/"false"),
    // consume=boolean, text from readChatInput. Native input is attempted lazily on open;
    // its activation buffer is cleared and verified before the session becomes visible.
    static inline var USE_NATIVE_INPUT:Bool = true;
    var _nativeInput:Bool        = false;          // true while a native session owns input
    var _ownedInput:Bool         = false;          // true for ZFE input.v1 owner-scoped capture
    var _xscalSessionInput:Bool  = false;
    var _xscalSessionUsable:Bool = true;
    var _xscalSessionReleaseUncertain:Bool = false;
    var _xscalSessionId:Dynamic = null;
    var _xscalSessionRevision:Int = -1;
    var _ownedInputUsable:Bool   = false;
    var _ownedInputSession:Dynamic = null;
    var _ownedInputRevision:Int = -1;
    var _ownedInputSubmitted:Bool = false;
    var _ownedInputCancelled:Bool = false;
    var _ownedReleaseStable:Int = 0;
    var _inputTimer:flash.utils.Timer = null;      // in-session native input poll (~100 ms)
    var _sharedInputDiagTimer:flash.utils.Timer = null;
    var _lastSharedInputDiag:String = "";
    static inline var SHARED_INPUT_FOCUS_GRACE_MS:Float = 225;
    var _sharedInputField:TextField = null;
    var _sharedInputDraft:String = "";
    var _sharedInputAllowEmpty:Bool = false;
    var _sharedInputSubmitArmed:Bool = false;
    var _sharedInputCancelArmed:Bool = false;
    var _sharedInputFocusLostAt:Float = 0;
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
    static inline var INPUT_POLL_MS:Int  = 100;    // in-session legacy native input-poll interval
    static inline var OWNED_INPUT_POLL_MS:Int = 40;
    static inline var OWNED_RELEASE_STABLE_POLLS:Int = 3;
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
    var _physicalOpenKey:Int = 0;
    var _physicalOpenKeyDown:Bool = false;
    var _ownedHotkeyTimer:flash.utils.Timer = null;
    var _ownedHotkeys:Array<Dynamic> = [];
    var _ownedHotkeyCodes:Array<Int> = [];
    static inline var OWNED_HOTKEY_POLL_MS:Int = 75;

    // ── SharedHUDTools (HUDModLoader text-entry + F11 menu integration) ───────
    var _hudTools:Dynamic        = null;
    var _hudToolsRegistered:Bool = false;
    var _hudEventStage:Dynamic   = null;
    var _menuViewport:FcmMenuViewport = new FcmMenuViewport();
    var _configLoader:URLLoader  = null;
    var _configTimer:Timer       = null;
    var _sendTimers:Array<Timer> = [];
    var _outbox:FcmOutbox = new FcmOutbox();
    var _outboxIdentity:String = "";
    // ZFE queue acceptance is not relay acceptance. Correlate its provider-local request id
    // with the durable HUD transaction/control until pollEvents publishes the completion.
    var _zfePendingSends:Map<Int, String> = new Map();
    var _zfePendingControls:Map<Int, String> = new Map();
    var _canRetryHudSend:Bool = false;
    var _canSendRoomDiagnostics:Bool = false;
    var _connectStartedAt:Float = 0;
    var _sendNonce:String = Std.string(Date.now().getTime()) + "-" + Std.string(Std.random(1000000000));

    function clearOutbox():Void {
        for (id in _outbox.clear()) removeOptimisticRecord(id);
        _zfePendingSends = new Map();
        _zfePendingControls = new Map();
        _outboxIdentity = "";
        _records = [];
    }

    function outboxStatus(message:String):Void {
        setPrompt('<font face="' + FONT_BODY + '" size="13" color="' + hx(_cfg.promptColor) + '">' + FcmConfig.htmlEscape(message) + '</font>');
    }

    function flushOutbox():Void {
        if (_disposed || !_connected || _authState != "authenticated" || _outboxIdentity.length == 0) return;
        var dropped = _outbox.prune(_outboxIdentity, _serverSession.room, _serverSessionReady, flash.Lib.getTimer());
        for (id in dropped) removeOptimisticRecord(id);
        if (dropped.length > 0) { requestRender(); outboxStatus("Queued message expired or its server changed; please resend."); }
        var entry = _outbox.next(_outboxIdentity, _serverSession.room, _serverSessionReady, flash.Lib.getTimer());
        if (entry == null) return;
        runSendTransportSafely(entry.channel, entry.body, false, entry.id, entry.identity);
    }

    /** xScal returns queued immediately; the private subscriber carries relay completion. */
    function acceptOutboxReceipt(body:String):Void {
        var response = FcmOutbox.privateReceipt(body);
        if (response.length == 0) return;
        var carrier = extractJsonString(response, "targetUserId");
        var id = FcmOutbox.receipt(carrier);
        var entry = _outbox.get(id);
        if (entry == null || entry.identity != _outboxIdentity) return;
        if (extractJsonBool(response, "success")) {
            var messageId = FcmConfig.hudTransportMessageId(carrier);
            if (messageId.length == 0) messageId = extractJsonString(response, "messageId");
            if (messageId.length == 0) return; // Only durable relay completion ends a retry.
            _outbox.remove(id);
            var tag = FcmConfig.hudTransportTag(carrier);
            var color = FcmConfig.hudTransportStarColor(carrier);
            updateOptimisticRecord(id, messageId, tag,
                FcmConfig.hudTransportHasStar(carrier), color, true,
                FcmConfig.hudTransportNameColor(carrier));
            var giveawayFeedback = FcmConfig.hudTransportValue(carrier, "g");
            if (giveawayFeedback.length > 0) setLogText(FcmConfig.htmlEscape(giveawayFeedback));
            if (_outbox.entries.length == 0 && !_inputOpen) setPrompt(idlePrompt());
            return;
        }
        var code = extractJsonString(response, "code");
        if (FcmOutbox.retryable(code)) {
            outboxStatus("Message queued - waiting to retry.");
            return;
        }
        _outbox.remove(id);
        removeOptimisticRecord(id);
        requestRender();
        outboxStatus(code == "send_uncertain"
            ? "Delivery unconfirmed. Check history before sending again."
            : "Message not sent: " + code);
    }

    function retryQueuedSend(localSendId:String, reason:String):Void {
        if (_outbox.get(localSendId) == null) return;
        outboxStatus("Message queued - retrying when chat reconnects.");
        if (_connected) forceReconnect(reason);
        else scheduleConnectRetry();
    }

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

    // Random per-load tag also distinguishes separately loaded SWF application domains.
    var _diagnosticInstance:String = Std.string(Std.random(0x3fffffff));

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
        zfeLog("info", "lifecycle", "widget shutdown");
        _disposed = true;
        stopBrowser();

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
        stopOwnedHotkeys();
        stopPhysicalNavigation();
        stopConnectRetry();
        stopZfeSearchTimer();
        stopInputTimer();

        for (timer in _sendTimers) {
            try { timer.stop(); } catch (e:Dynamic) {}
        }
        _sendTimers = [];
        clearOutbox();

        if (_configLoader != null) {
            try {
                _configLoader.removeEventListener(Event.COMPLETE, onConfigLoaded);
                _configLoader.removeEventListener(IOErrorEvent.IO_ERROR, onConfigIoError);
            } catch (e:Dynamic) {}
            _configLoader = null;
        }

        if (_hudEventStage != null) {
            try { _hudEventStage.removeEventListener(Event.ENTER_FRAME, keepMenuInFrame); } catch (_:Dynamic) {}
            _menuViewport.clear();
            try { _hudEventStage.removeEventListener("HUDMod::UserEvent", onUserEventSafe); }
            catch (e:Dynamic) {}
            _hudEventStage = null;
        }
        // BSUIDataManager retains callback references independently of the child SWF. Remove
        // every subscription before releasing the manager so an old reload instance cannot
        // continue processing world/roster updates after the replacement is live.
        try { unsubscribeRoster(); } catch (e:Dynamic) {}
        try { unsubscribeHudMode(); } catch (e:Dynamic) {}
        try { unsubscribeRecentActivities(); } catch (e:Dynamic) {}
        try { unsubscribeIdentityUpdates(); } catch (e:Dynamic) {}
        try { stopRecentActivitiesFallback(); } catch (e:Dynamic) {}
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
        stopSharedInputDiagnostics();
    }

    function stopSharedInputDiagnostics():Void {
        if (_sharedInputDiagTimer != null) {
            _sharedInputDiagTimer.stop();
            _sharedInputDiagTimer = null;
        }
        if (_sharedInputField != null) {
            try { _sharedInputField.removeEventListener(KeyboardEvent.KEY_DOWN, onSharedInputKeyDown); }
            catch (_:Dynamic) {}
        }
        _sharedInputField = null;
        _sharedInputDraft = "";
        _sharedInputAllowEmpty = false;
        _sharedInputSubmitArmed = false;
        _sharedInputCancelArmed = false;
        _sharedInputFocusLostAt = 0;
        _lastSharedInputDiag = "";
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
        cancelPendingRender();
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
        _feedContentLayer = null;
        _pendingFeedContentLayer = null;
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
        _autoHideOn = (_cfg != null && _cfg.autoHideActive());   // default from config (60s)
        // Register HUDModLoader listeners before building the static panel.
        attachHUDModListeners();
        buildPanel();
        subscribeHudMode();
        subscribeRecentActivities();
        updateHUDVisibility();
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
        var logBottom:Int = h - _cfg.effectiveInputHeight() - LOG_INPUT_GAP;
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
        g.beginFill(_cfg.tabRowColor, _cfg.bgAlpha);
        g.drawRect(1, 1, w - 2, TAB_H + SUB_H);
        g.endFill();
        // Sub-tab row bottom divider + log/input separator (full width, overlay parity @0.45).
        g.lineStyle(1, _cfg.borderColor, 0.45);
        g.moveTo(0, TAB_H + SUB_H); g.lineTo(w, TAB_H + SUB_H);
        g.lineStyle(1, _cfg.borderColor, 0.4);
        g.moveTo(0, h - _cfg.effectiveInputHeight()); g.lineTo(w, h - _cfg.effectiveInputHeight());
        g.lineStyle();
        g.beginFill(_cfg.inputBgColor, _cfg.bgAlpha);
        g.drawRect(1, h - _cfg.effectiveInputHeight() + 1, w - 2, _cfg.effectiveInputHeight() - 2);
        g.endFill();
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
        _feedLayer.mouseChildren = true; // Link fields retain selection/copy fallback.
        _feedLayer.scrollRect = new Rectangle(0, 0, _logTf.width, _logTf.height);
        _feedLayer.visible = false;
        _feedContentLayer = new Sprite();
        _feedLayer.addChild(_feedContentLayer);
        addChild(_feedLayer);

        // Mouse-wheel over the log scrolls history (CAP-008, VER-2). HUD-availability
        // unverified; F11 "Scroll to newest" + auto-scroll stay the fallback.
        try {
            _feedLayer.addEventListener(flash.events.MouseEvent.MOUSE_WHEEL, onLogWheel);
        } catch (e:Dynamic) {}

        // ── Prompt row: idle hint / "typing..." (HUDTools draws its own entry box) ──
        var input = _cfg.inputRect();
        _promptTf = makeChromeTf(input.x, input.y, input.width, input.height);
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

    function channelTabLabel(index:Int):String {
        return CHAN_SLUGS[index] == "server" && _canModerate ? "YOUR SERVER" : CHAN_NAMES[index];
    }

    function renderSubTabs():Void {
        if (_subTf == null) return;
        // Borderless text strip (no boxes). Sub-tabs use the HEADER text colors (same as the
        // "FALLOUT 76" main tab): active channel = tabActiveColor (bright), inactive =
        // tabInactiveColor (dim). Per-channel colors (chat_rooms.color) are applied only to the
        // [Channel] message tags, NOT this tab row. Slash /g /t /e /i /r still switch channels.
        var labels:Array<String> = [];
        var ranges:Array<{start:Int, end:Int, active:Bool}> = [];
        var offset:Int = 0;
        for (si in tabOrder()) {
            if (labels.length > 0) { labels.push("  "); offset += 2; }
            var label = channelTabLabel(si);
            labels.push(label);
            ranges.push({start:offset, end:offset + label.length, active:si == _chanIdx});
            offset += label.length;
        }
        // Fallout GFx has produced field-wide color inheritance for adjacent htmlText tags.
        // Explicit character ranges keep each tab's focus color independent.
        _subTf.text = labels.join("");
        for (range in ranges) {
            var format = new TextFormat(FONT_BOLD, 12,
                range.active ? _cfg.tabActiveColor : _cfg.tabInactiveColor, true);
            _subTf.setTextFormat(format, range.start, range.end);
        }
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
        applySelectedRowStyle();
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
                _hudEventStage.addEventListener(Event.ENTER_FRAME, keepMenuInFrame);
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
            if (p == "colors") {
                for (i in 0...FcmConfig.COLOR_FIELDS.length)
                    Reflect.callMethod(_hudTools, add, ["color_" + FcmConfig.COLOR_FIELDS[i],
                        FcmConfig.COLOR_LABELS[i], true, true, MENU_ACTION_TIMEOUT_MS]);
                return;
            }
            if (StringTools.startsWith(p, "color_")) {
                var field = p.substr(6);
                if (FcmConfig.COLOR_FIELDS.indexOf(field) < 0) return;
                for (i in 0...FcmConfig.COLOR_VALUES.length)
                    Reflect.callMethod(_hudTools, add, ["cz_color_" + field + "_" + i,
                        FcmConfig.COLOR_NAMES[i], true, false, MENU_ACTION_TIMEOUT_MS]);
                return;
            }
            // Keep each branch short: HUDTools stacks entries upward without scrolling.
            if (p == "customize") {
                for (item in [
                    {id:"position", label:"Position..."}, {id:"panel_size", label:"Panel size..."},
                    {id:"text_size", label:"Text and input..."}, {id:"appearance", label:"Appearance..."},
                    {id:"auto_hide", label:"Auto-hide..."}, {id:"colors", label:"Colors..."}
                ]) Reflect.callMethod(_hudTools, add, [item.id, item.label, true, true, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_reset", "Reset all settings", true, false, MENU_ACTION_TIMEOUT_MS]);
                return;
            }
            if (p == "position") {
                for (item in [
                    {id:"cz_up", label:"Move up"}, {id:"cz_down", label:"Move down"},
                    {id:"cz_left", label:"Move left"}, {id:"cz_right", label:"Move right"},
                    {id:"cz_position_reset", label:"Reset position"}
                ]) Reflect.callMethod(_hudTools, add, [item.id, item.label, true, false, MENU_ACTION_TIMEOUT_MS]);
                return;
            }
            if (p == "panel_size" || p == "text_size") {
                for (item in _cfg.sizingMenu()) {
                    var panel = item.id == "cz_width_up" || item.id == "cz_width_dn"
                        || item.id == "cz_height_up" || item.id == "cz_height_dn";
                    if (panel == (p == "panel_size"))
                        Reflect.callMethod(_hudTools, add, [item.id, item.label, true, false, MENU_ACTION_TIMEOUT_MS]);
                }
                return;
            }
            if (p == "appearance") {
                Reflect.callMethod(_hudTools, add, ["cz_opac_up", "Opacity +", true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_opac_dn", "Opacity -", true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_theme", "Color theme >", true, false, MENU_ACTION_TIMEOUT_MS]);
                return;
            }
            if (p == "auto_hide") {
                Reflect.callMethod(_hudTools, add, ["autohide", (_cfg.autoHideActive() ? "Auto-hide: ON" : "Auto-hide: OFF"), true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_hide_delay_up", "Hide delay +5s (" + _cfg.autoHideSec + "s)", true, false, MENU_ACTION_TIMEOUT_MS]);
                Reflect.callMethod(_hudTools, add, ["cz_hide_delay_dn", "Hide delay -5s (" + _cfg.autoHideSec + "s)", true, false, MENU_ACTION_TIMEOUT_MS]);
                return;
            }
            // Top-level menu — channel entries in display order (SERVER included in-world).
            for (si in tabOrder()) {
                Reflect.callMethod(_hudTools, add, ["chan" + si, channelTabLabel(si), true, false, MENU_ACTION_TIMEOUT_MS]);
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

    function keepMenuInFrame(_:Event):Void {
        if (_disposed || stage == null) return;
        try {
            if (_inputOpen || _hudTools == null || Reflect.field(_hudTools, "isActive") != true) {
                _menuViewport.clear();
                return;
            }
            _menuViewport.update(stage, stage.stageWidth, stage.stageHeight, VENDOR);
        } catch (_:Dynamic) { _menuViewport.clear(); }
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
            _cfg.toggleAutoHide();
            _autoHideOn = _cfg.autoHideActive();
            persistConfig();
            if (_autoHideOn) { bumpAutoHide(); }
            else { stopAutoHideTimer(); if (_autoHidden && !_manuallyHidden) show(); }
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
            _cfg.channelNextKey, _cfg.channelPrevKey,
            _cfg.scrollUpKey, _cfg.scrollDownKey, _cfg.scrollBottomKey);
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
        if (_xscalCancelDiagnosticPending) {
            _xscalCancelDiagnosticPending = false;
            zfeLog("info", "input", "xScal post-cancel HUD event action="
                + FcmCommand.actionKey(action) + " edge=" + (isDown ? "down" : "up"));
        }

        // Close whichever input owner is active before HUDMenu processes a named modal action.
        // Only the host-domain SharedHUDTools path owns the engine's ControlMap lock; the native
        // fallback owns only its ZFE bridge session.
        // action such as OpenSocial (Ctrl+Tab), OpenFriendList, or Escape. This must run on the
        // event's key-down/key-up edge before the game's own menu handler gets the action.
        if (FcmCommand.actionKey(action) == "pipboy") {
            // Cover either ordering of Insert and PipBoy while the menu stack catches up.
            _pipboyTransitionUntil = flash.Lib.getTimer() + 1500;
        }
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

        // A user may bind hideKey=DELETE. While either provider's editor owns input, Delete must
        // reach that editor as character deletion and must not close or hide the widget.
        var hideAction:String = FcmCommand.configuredHideAction(action, _cfg.hideKey, _inputOpen);
        if (hideAction == "editor") return false;
        if (hideAction == "hide") {
            if (isDown) hide();
            return true;
        }

        if (FcmCommand.linkActivationEnabled(action, _cfg.activateLinkKey,
                _inputOpen, selectedRowHasLink())) {
            if (isDown) activateSelectedLinkFromOpenInput();
            return true;
        }

        // Navigation is a set of one-shot commands, never a persistent "channel selection"
        // mode. This matters because the same stage also hosts the SharedHUDTools editor: an
        // ordinary character or an Unmapped action must never be routed into channel handling.
        // Page actions switch channels while idle or while typing; the editor owner and draft are
        // left untouched. Configured feed actions are feed commands only for an active Insert session.
        var navAction:String = FcmCommand.navigationAction(action,
            _cfg.channelNextKey, _cfg.channelPrevKey,
            _cfg.scrollUpKey, _cfg.scrollDownKey, _cfg.scrollBottomKey);
        if (navAction.length > 0) {
            // Configured feed actions remain ordinary gameplay controls until Insert owns a
            // visible editor. Page actions are FCM channel commands in either visible state.
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

        // INSERT etc. open via the provider poll, not this named-action path.
        // M/Map, I/QuickInventory, and movement may still arrive as HUD actions
        // while either editor is active. Consume them before HUDMenu handles gameplay.
        return _inputOpen;
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
        _bScrolling = false; _newWhileScrolled = 0; _selectedRowIndex = -1;
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

    function hide(manual:Bool = true):Void {
        if (_disposed) return;
        if (_inputOpen) {
            zfeLog("info", "hide", "hide ignored while editor owns input");
            return;
        }
        stopBrowser();
        if (manual) _manuallyHidden = true;
        else _autoHidden = true;
        this.visible = false;
        _hidden = true;
        stopAutoHideTimer();
        zfeLog("info", "hide", "panel hidden");
    }

    function show():Void {
        if (_disposed) return;
        // HUDMode gating overrides manual show — keep hidden while HUDMode says hidden
        if (_hiddenByHUDMode || !isValidHUDMode()) {
            zfeLog("info", "hud", "show suppressed HUDMode=" + currentHUDMode());
            updateHUDVisibility();
            return;
        }
        this.visible = true;
        _hidden = false;
        _manuallyHidden = false;
        _autoHidden = false;
        bumpAutoHide();
        zfeLog("info", "hide", "panel restored");
    }

    // ── HUDMode gating — single INI key hideInHUDModes (blacklist, opinionated default) ──
    function currentHUDMode():String {
        // MenuStackData MainMenu is synthetic; otherwise cached HUDModeData string
        try {
            if (FcmRoster.isMainMenu(uiData(getBSUIData(findBSUI(), "MenuStackData")))) return "MainMenu";
        } catch (_:Dynamic) {}
        return _cachedHUDMode;
    }

    function isValidHUDMode():Bool {
        if (_cfg == null || _cfg.hideInHUDModes == null || _cfg.hideInHUDModes.length == 0) return true;
        var cur:String = currentHUDMode();
        if (cur == null || cur.length == 0) return true;
        var low:String = cur.toLowerCase();
        for (v in _cfg.hideInHUDModes) {
            if (v != null && StringTools.trim(v).toLowerCase() == low) return false;
        }
        return true;
    }

    function updateHUDVisibility():Void {
        if (_disposed) return;
        var shouldHideByMode:Bool = !isValidHUDMode();
        if (shouldHideByMode) {
            if (!_hiddenByHUDMode) {
                _hiddenByHUDMode = true;
                if (!_hidden) {
                    if (_inputOpen) {
                        try {
                            if (_nativeInput) closeInputNative();
                            else closeInputSharedHudTools("HUDMode hide");
                        } catch (_:Dynamic) {}
                    }
                    this.visible = false;
                    _hidden = true;
                    stopAutoHideTimer();
                    zfeLog("info", "hud", "HUDMode hide hudMode=" + currentHUDMode());
                } else {
                    zfeLog("info", "hud", "HUDMode already hidden hudMode=" + currentHUDMode());
                }
            }
        } else {
            if (_hiddenByHUDMode) {
                _hiddenByHUDMode = false;
                if (_hidden && !_manuallyHidden && !_autoHidden) {
                    // A menu owns only its temporary hide, never a user's hide or idle timeout.
                    this.visible = true;
                    _hidden = false;
                    bumpAutoHide();
                    zfeLog("info", "hud", "HUDMode show hudMode=" + currentHUDMode());
                } else {
                    zfeLog("info", "hud", "HUDMode no longer hidden hudMode=" + currentHUDMode());
                }
            }
        }
    }

    function onHUDModeChanged(evt:Dynamic):Void {
        try {
            var d:Dynamic = null;
            try { d = evt.data; } catch (_:Dynamic) {}
            if (d == null) try { d = evt.target.data; } catch (_:Dynamic) {}
            var mode:String = "";
            if (d != null) {
                if (Reflect.hasField(d, "hudMode")) mode = Std.string(Reflect.field(d, "hudMode"));
                else if (d.hudMode != null) mode = Std.string(d.hudMode);
                else if (d.data != null) {
                    if (Reflect.hasField(d.data, "hudMode")) mode = Std.string(Reflect.field(d.data, "hudMode"));
                    else if (d.data.hudMode != null) mode = Std.string(d.data.hudMode);
                }
            }
            if (mode.length > 0) _cachedHUDMode = mode;
            zfeLog("info", "hud", "HUDMode evt hudMode=" + _cachedHUDMode + " valid=" + isValidHUDMode());
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "HUDMode evt threw: " + Std.string(e));
        }
        updateHUDVisibility();
    }

    function onMenuStackChanged(evt:Dynamic):Void {
        // MenuStackData change can flip isMainMenu synthetic mode
        zfeLog("info", "hud", "MenuStack evt valid=" + isValidHUDMode() + " isMainMenu=" + FcmRoster.isMainMenu(uiData(getBSUIData(findBSUI(), "MenuStackData"))));
        updateHUDVisibility();
    }

    function subscribeHudMode():Void {
        if (_hudModeSubscribed) return;
        var mgr:Dynamic = findBSUI();
        if (mgr == null) return;
        try {
            _hudModeCallback = function(evt:Dynamic):Void { try { onHUDModeChanged(evt); } catch (_:Dynamic) {} };
            mgr.Subscribe("HUDModeData", _hudModeCallback);
            _menuStackCallback = function(evt:Dynamic):Void { try { onMenuStackChanged(evt); } catch (_:Dynamic) {} };
            mgr.Subscribe("MenuStackData", _menuStackCallback);
            _hudModeSubscribed = true;
            // Pull current values — Subscribe does not replay cached value (see subscribeRoster comment)
            try {
                var hud:Dynamic = getBSUIData(mgr, "HUDModeData");
                var d:Dynamic = uiData(hud);
                if (d != null) {
                    var m:String = "";
                    if (Reflect.hasField(d, "hudMode")) m = Std.string(Reflect.field(d, "hudMode"));
                    else if (d.hudMode != null) m = Std.string(d.hudMode);
                    if (m.length > 0) _cachedHUDMode = m;
                }
            } catch (_:Dynamic) {}
            zfeLog("info", "hud", "subscribed HUDModeData/MenuStackData hudMode=" + _cachedHUDMode);
            updateHUDVisibility();
        } catch (e:Dynamic) {
            zfeLog("warn", "hud", "Subscribe HUDMode threw: " + Std.string(e));
            unsubscribeHudMode(mgr);
        }
    }

    function unsubscribeHudMode(mgr:Dynamic = null):Void {
        var target:Dynamic = (mgr != null) ? mgr : findBSUI();
        if (target == null) target = _rosterManager;
        if (target != null) {
            try {
                var unsub:Dynamic = Reflect.field(target, "Unsubscribe");
                if (unsub != null) {
                    if (_hudModeCallback != null) Reflect.callMethod(target, unsub, ["HUDModeData", _hudModeCallback]);
                    if (_menuStackCallback != null) Reflect.callMethod(target, unsub, ["MenuStackData", _menuStackCallback]);
                }
            } catch (e:Dynamic) {
                zfeLog("warn", "hud", "Unsubscribe HUDMode threw: " + Std.string(e));
            }
        }
        _hudModeCallback = null;
        _menuStackCallback = null;
        _hudModeSubscribed = false;
    }

    // ── Public-event auto-broadcast — reads RecentActivitiesData like HUDChallenges ──
    static inline var AUTO_BROADCAST_SEEN_CAP:Int = 512;
    var _recentActivitiesSubscribed:Bool = false;
    var _recentActivitiesCallback:Dynamic = null;
    var _recentActivitiesData:Dynamic = null;
    var _broadcastedWorldEvents:Map<String, Float> = new Map();
    var _broadcastInFlight:Map<String, Bool> = new Map();
    var _broadcastOrder:Array<String> = [];
    var _recentActivitiesFailCount:Int = 0;
    var _recentActivitiesFallbackTimer:Timer = null;
    static inline var RECENT_ACTIVITIES_THROTTLE_MS:Float = 30000;
    var _lastRecentCheck:Float = -1e12;
    // Cross-domain safe accessors — RecentActivitiesData objects live in the host
    // ApplicationDomain; direct Reflect.field/dot access on them throws #1014.
    // uiField() already isolates sealed/native objects, so route everything through it.
    function raStr(obj:Dynamic, field:String):String {
        try {
            var v:Dynamic = uiField(obj, field);
            if (v == null) return "";
            var s:String = Std.string(v);
            if (s == "null") return "";
            return s;
        } catch (_:Dynamic) { return ""; }
    }
    function raInt(obj:Dynamic, field:String, fallback:Int = -1):Int {
        try {
            var v:Dynamic = uiField(obj, field);
            if (v == null) return fallback;
            if (Std.isOfType(v, Int)) return v;
            var p:Null<Int> = Std.parseInt(StringTools.trim(Std.string(v)));
            return (p == null) ? fallback : p;
        } catch (_:Dynamic) { return fallback; }
    }
    function raLen(obj:Dynamic):Int {
        try {
            var v:Dynamic = uiField(obj, "length");
            if (v == null) return -1;
            return Std.int(v);
        } catch (_:Dynamic) { return -1; }
    }
    function raAt(arr:Dynamic, idx:Int):Dynamic {
        try { return untyped arr[idx]; } catch (_:Dynamic) { return null; }
    }

    function stableWorldEventCode(id:String):String {
        if (id == null || id.length == 0) return "EVT-000000000000";
        var h:Int = 0;
        for (i in 0...id.length) h = (h * 31 + id.charCodeAt(i)) & 0x7fffffff;
        var h2:Int = Std.int(id.length * 0x9e3779b9) & 0x7fffffff;
        return "EVT-" + StringTools.hex(h, 8).toUpperCase().substr(0, 8) + StringTools.hex(h2, 4).toUpperCase().substr(0, 4);
    }

    function isValidWorldEventName(name:String):Bool {
        if (name == null) return false;
        var t:String = StringTools.trim(name);
        return t.length >= 3;
    }

    function extractWorldEventMutation(details:Dynamic):String {
        if (details == null) return "";
        try {
            var n:Int = raLen(details);
            if (n < 0) return "";
            for (i in 0...n) {
                var d:Dynamic = raAt(details, i);
                if (d == null) continue;
                var g:String = raStr(d, "groupLabel");
                if (g != "$DailyOps_Header_Mutation") continue;
                var pairs:Dynamic = null;
                try { pairs = uiField(d, "pairList"); } catch (_:Dynamic) { continue; }
                if (pairs == null) continue;
                var m:Int = raLen(pairs);
                if (m < 0) continue;
                var out:String = "";
                for (j in 0...m) {
                    var entry:Dynamic = raAt(pairs, j);
                    if (entry == null) continue;
                    var lbl:String = StringTools.trim(raStr(entry, "label"));
                    if (lbl.length == 0) continue;
                    out = (out.length == 0) ? lbl : out + "|" + lbl;
                }
                return out;
            }
        } catch (_:Dynamic) {}
        return "";
    }

    function extractWorldEventParticipants(details:Dynamic):Int {
        if (details == null) return -1;
        try {
            var n:Int = raLen(details);
            if (n < 0) return -1;
            for (i in 0...n) {
                var d:Dynamic = raAt(details, i);
                if (d == null) continue;
                var g:String = raStr(d, "groupLabel");
                if (g != "$STATS") continue;
                var pairs:Dynamic = null;
                try { pairs = uiField(d, "pairList"); } catch (_:Dynamic) { continue; }
                if (pairs == null) continue;
                var m:Int = raLen(pairs);
                if (m < 0) continue;
                for (j in 0...m) {
                    var entry:Dynamic = raAt(pairs, j);
                    if (entry == null) continue;
                    var lbl:String = raStr(entry, "label");
                    if (lbl != "$Participants") continue;
                    var desc:String = StringTools.trim(raStr(entry, "description"));
                    if (desc.length == 0) continue;
                    var v:Null<Int> = Std.parseInt(desc);
                    if (v != null) return v;
                }
            }
        } catch (_:Dynamic) {}
        return -1;
    }

    function formatWorldEventBody(name:String, mutation:String, participants:Int):String {
        var body:String = "Public Event: " + name;
        if (mutation != null && StringTools.trim(mutation).length > 0) body += " [" + StringTools.trim(mutation) + "]";
        if (participants >= 0) body += " Participants: " + participants;
        return body;
    }

    function onRecentActivitiesUpdate(evt:Dynamic):Void {
        // NOTE: never touch evt.data / evt.target — the RecentActivities event object
        // lives in the host ApplicationDomain and property access on it throws
        // TypeError #1014 (class not found) in this child domain (see xscal.log).
        // Pull fresh via GetDataFromClient instead; the event is just a wake-up ping.
        // Gate + throttle: default-off users pay nothing; opt-in users max 1 check/30s
        // (HUDChallenges DATA_RELOAD_TIME), so per-frame Subscribe storms can't stall UI.
        // autoBroadcastActive also folds in the empty-allow rule (blank allow-list = off).
        if (_cfg == null || !_cfg.autoBroadcastActive()) return;
        try {
            var raw:Dynamic = null;
            try { raw = getBSUIData(findBSUI(), "RecentActivitiesData"); } catch (_:Dynamic) {}
            try { _recentActivitiesData = raw; } catch (_:Dynamic) {}
            var d:Dynamic = null;
            try { d = uiData(raw); } catch (_:Dynamic) {}
            maybeAutoBroadcastWorldEvents(d != null ? d : raw);
            _recentActivitiesFailCount = 0;
        } catch (e:Dynamic) {
            _recentActivitiesFailCount++;
            zfeLog("warn", "events", "onRecentActivitiesUpdate threw: " + Std.string(e));
            // After 3 consecutive #1014s the Subscribe path is poisoned — fall back to
            // 30s polling (HUDChallenges DATA_RELOAD_TIME) which uses GetDataFromClient
            // only and never touches the cross-domain event object.
            if (_recentActivitiesFailCount >= 3 && _recentActivitiesFallbackTimer == null) {
                startRecentActivitiesFallback();
            }
        }
    }

    function maybeAutoBroadcastWorldEvents(raw:Dynamic):Void {
        if (_cfg == null || !_cfg.autoBroadcastActive()) {
            try { stopRecentActivitiesFallback(); } catch (_:Dynamic) {}
            return;
        }
        if (_api == null || !_connected || _needsLink) return;
        // Throttle to DATA_RELOAD_TIME: Subscribe can fire per-frame; only process 1/30s.
        var now:Float = 0;
        try { now = flash.Lib.getTimer(); } catch (_:Dynamic) {}
        if (now - _lastRecentCheck < RECENT_ACTIVITIES_THROTTLE_MS) return;
        _lastRecentCheck = now;
        if (raw == null) {
            try { raw = uiData(getBSUIData(findBSUI(), "RecentActivitiesData")); } catch (_:Dynamic) {}
            if (raw == null) return;
        }
        // raw may be {recentActivities: [...]} or already that array container.
        // Use uiField (sealed-object safe) — never raw Reflect.hasField/dot on host objects.
        var acts:Dynamic = null;
        try {
            var cand:Dynamic = uiField(raw, "recentActivities");
            acts = (cand != null) ? cand : raw;
        } catch (_:Dynamic) { acts = raw; }
        if (acts == null) return;
        var n:Int = raLen(acts);
        if (n < 0) {
            // Single object instead of array? Treat length-1 defensively.
            try {
                var singleType:Int = raInt(acts, "type", -99);
                if (singleType == -99) return;
                n = 1;
                acts = [acts];
            } catch (_:Dynamic) { return; }
        }
        if (n <= 0) return;
        var currentIds:Map<String, Bool> = new Map();
        var toBroadcast:Array<Dynamic> = [];
        for (i in 0...n) {
            var act:Dynamic = null;
            try { act = raAt(acts, i); } catch (_:Dynamic) { continue; }
            if (act == null) continue;
            var type:Int = -1;
            try { type = raInt(act, "type", -1); } catch (_:Dynamic) { continue; }
            if (type != 1) continue; // publicEvent only per confirmed scope (type 1; worldEvent is 2)
            var idProbe:String = "";
            var nameProbe:String = "";
            try {
                idProbe = StringTools.trim(raStr(act, "id"));
                nameProbe = StringTools.trim(raStr(act, "name"));
            } catch (_:Dynamic) {}
            if (idProbe.length == 0) continue;
            if (!isValidWorldEventName(nameProbe)) continue;
            // Allow/deny list gate (exact, case-insensitive; never substrings).
            if (!FcmConfig.eventPassesFilter(nameProbe, _cfg.broadcastEvents, _cfg.broadcastEventsMode)) continue;
            currentIds.set(idProbe, true);
            if (!_broadcastedWorldEvents.exists(idProbe) && !_broadcastInFlight.exists(idProbe)) toBroadcast.push(act);
        }
        // Exactly-once global broadcast to events leaf (global, not server ephemeral FCMROOM).
        // Per-item isolation: one poisoned entry must not abort the rest (the #1014 flood).
        for (act in toBroadcast) {
            var id:String = "";
            var name:String = "";
            var details:Dynamic = null;
            try {
                id = StringTools.trim(raStr(act, "id"));
                name = StringTools.trim(raStr(act, "name"));
                details = uiField(act, "details");
            } catch (_:Dynamic) { continue; }
            if (id.length == 0 || !isValidWorldEventName(name)) continue;
            if (!FcmConfig.eventPassesFilter(name, _cfg.broadcastEvents, _cfg.broadcastEventsMode)) continue;
            var mutation:String = "";
            var participants:Int = -1;
            try { mutation = extractWorldEventMutation(details); } catch (_:Dynamic) {}
            try { participants = extractWorldEventParticipants(details); } catch (_:Dynamic) {}
            // Display the prefix-free name ("Public Event: Scorched Earth",
            // not "Public Event: Event: ..."); dedupe keys above still use the raw id.
            var body:String = formatWorldEventBody(FcmConfig.stripEventPrefix(name), mutation, participants);
            var chan:String = "events"; // global leaf 000...003 per channelMap, not server FCMROOM
            // Reserve before the synchronous bridge call so a re-entrant activity update
            // cannot submit the same event twice. The history key is released on failure.
            if (_broadcastedWorldEvents.exists(id) || _broadcastInFlight.exists(id)) continue;
            _broadcastInFlight.set(id, true);

            // Second guard via history dedupe (backscroll repeat fix)
            var accepted:Bool = false;
            try {
                accepted = _history.accept(chan, 0, "world:" + id, 512, _records);
            } catch (historyError:Dynamic) {
                _broadcastInFlight.remove(id);
                zfeLog("warn", "events", "auto-broadcast history guard threw id=" + id + ": " + clip200(Std.string(historyError)));
                continue;
            }
            if (!accepted) {
                _broadcastInFlight.remove(id);
                continue;
            }
            try {
                var payload:String = '{"channel":"' + chan + '","targetUserId":"","body":"' + jsonEscape(body) + '"}';
                var rawResp:String = Std.string(_api.call("chat.v1.sendMessage", payload));
                if (rawResp.indexOf('"success":true') >= 0 || rawResp.indexOf('success:true') >= 0) {
                    _broadcastInFlight.remove(id);
                    _broadcastedWorldEvents.set(id, flash.Lib.getTimer());
                    _broadcastOrder.push(id);
                    zfeLog("info", "events", "auto-broadcast publicEvent id=" + id + " name=" + name + " participants=" + participants);
                    while (_broadcastOrder.length > AUTO_BROADCAST_SEEN_CAP) {
                        var old:String = _broadcastOrder.shift();
                        _broadcastedWorldEvents.remove(old);
                    }
                } else {
                    _broadcastInFlight.remove(id);
                    _history.release(chan, 0, "world:" + id);
                    zfeLog("warn", "events", "auto-broadcast relay rejected id=" + id + " raw=" + clip200(rawResp));
                }
            } catch (e:Dynamic) {
                _broadcastInFlight.remove(id);
                _history.release(chan, 0, "world:" + id);
                zfeLog("warn", "events", "auto-broadcast threw id=" + id + ": " + Std.string(e));
            }
        }
        // Presence-based prune: when activity.id disappears, forget it so next occurrence of same Bethesda id can re-broadcast after expiry
        try {
            var kept:Array<String> = [];
            for (k in _broadcastOrder) if (currentIds.exists(k)) kept.push(k); else _broadcastedWorldEvents.remove(k);
            _broadcastOrder = kept;
        } catch (_:Dynamic) {}
    }

    function startRecentActivitiesFallback():Void {
        if (_cfg == null || !_cfg.autoBroadcastActive()) return;
        if (_recentActivitiesFallbackTimer != null) return;
        try {
            zfeLog("warn", "events", "Subscribe path poisoned (#1014 x3) — falling back to 30s GetDataFromClient poll");
            try { unsubscribeRecentActivities(); } catch (_:Dynamic) {}
            _recentActivitiesFallbackTimer = new Timer(30000, 0);
            _recentActivitiesFallbackTimer.addEventListener(TimerEvent.TIMER, function(_:Dynamic) {
                try {
                    if (_disposed) return;
                    if (_cfg == null || !_cfg.autoBroadcastActive()) return;
                    var raw:Dynamic = null;
                    try { raw = getBSUIData(findBSUI(), "RecentActivitiesData"); } catch (_:Dynamic) { return; }
                    var d:Dynamic = null;
                    try { d = uiData(raw); } catch (_:Dynamic) { return; }
                    maybeAutoBroadcastWorldEvents(d != null ? d : raw);
                } catch (e:Dynamic) {
                    try { zfeLog("warn", "events", "fallback poll threw: " + Std.string(e)); } catch (_:Dynamic) {}
                }
            });
            _recentActivitiesFallbackTimer.start();
        } catch (_:Dynamic) {}
    }

    function stopRecentActivitiesFallback():Void {
        if (_recentActivitiesFallbackTimer != null) {
            try { _recentActivitiesFallbackTimer.stop(); } catch (_:Dynamic) {}
            _recentActivitiesFallbackTimer = null;
        }
        _recentActivitiesFailCount = 0;
    }

    function subscribeRecentActivities():Void {
        // Gate: default-off users never subscribe and never pay GetDataFromClient cost.
        // autoBroadcastActive folds in the empty-allow rule (blank allow-list = off).
        if (_cfg == null || !_cfg.autoBroadcastActive()) {
            try { unsubscribeRecentActivities(); } catch (_:Dynamic) {}
            try { stopRecentActivitiesFallback(); } catch (_:Dynamic) {}
            return;
        }
        if (_recentActivitiesSubscribed) return;
        var mgr:Dynamic = findBSUI();
        if (mgr == null) return;
        try {
            _recentActivitiesCallback = function(evt:Dynamic):Void { try { onRecentActivitiesUpdate(evt); } catch (_:Dynamic) {} };
            mgr.Subscribe("RecentActivitiesData", _recentActivitiesCallback);
            _recentActivitiesSubscribed = true;
            _recentActivitiesFailCount = 0;
            try { stopRecentActivitiesFallback(); } catch (_:Dynamic) {}
            try {
                var raw:Dynamic = getBSUIData(mgr, "RecentActivitiesData");
                var d:Dynamic = uiData(raw);
                if (d != null) maybeAutoBroadcastWorldEvents(d);
                else if (raw != null) maybeAutoBroadcastWorldEvents(raw);
            } catch (_:Dynamic) {}
            zfeLog("info", "events", "subscribed RecentActivitiesData");
        } catch (e:Dynamic) {
            zfeLog("warn", "events", "Subscribe RecentActivities threw: " + Std.string(e));
            unsubscribeRecentActivities(mgr);
            // Subscribe itself rejected — poll instead so broadcasts still work.
            try { startRecentActivitiesFallback(); } catch (_:Dynamic) {}
        }
    }

    function unsubscribeRecentActivities(mgr:Dynamic = null):Void {
        var target:Dynamic = (mgr != null) ? mgr : findBSUI();
        if (target == null) target = _rosterManager;
        if (target != null) {
            try {
                var unsub:Dynamic = Reflect.field(target, "Unsubscribe");
                if (unsub != null && _recentActivitiesCallback != null) Reflect.callMethod(target, unsub, ["RecentActivitiesData", _recentActivitiesCallback]);
            } catch (e:Dynamic) { zfeLog("warn", "events", "Unsubscribe RecentActivities threw: " + Std.string(e)); }
        }
        _recentActivitiesCallback = null;
        _recentActivitiesSubscribed = false;
    }

    /**
     * Restart the auto-hide countdown (called on any activity: show, open input, channel switch,
     * new message). When it elapses with no further activity — and the input isn't open — the
     * panel hides. A new message reveals it again (see parseAndRenderEvents). F11-menu toggleable.
     */
    function bumpAutoHide():Void {
        if (_disposed) return;
        stopAutoHideTimer();
        if (_hidden || !_autoHideOn || _cfg == null || _cfg.autoHideSec <= 0) return;
        _autoHideTimer = new Timer(_cfg.autoHideSec * 1000, 1);
        _autoHideTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) { runAutoHideSafely(); });
        _autoHideTimer.start();
    }

    function runAutoHideSafely():Void {
        if (_disposed) return;
        try {
            _autoHideTimer = null;
            if (_autoHideOn && !_inputOpen && !_hidden) hide(false);
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
        stopBrowser();
        if (_disposed) return;
        cancelPendingRender();
        if (_feedLayer != null) {
            try { _feedLayer.removeEventListener(flash.events.MouseEvent.MOUSE_WHEEL, onLogWheel); }
            catch (e:Dynamic) {}
        }
        var kids:Array<flash.display.DisplayObject> = [_bg, _tabTf, _subTf, _logTf, _feedLayer, _promptTf];
        for (c in kids) { try { if (c != null) removeChild(c); } catch (e:Dynamic) {} }
        _feedRows = [];
        _renderedRecordKeys = [];
        _renderedChanIdx = -1;
        _renderedViewportWidth = -1;
        _renderedVisualContext = "";
        _feedContentHeight = 0;
        _feedScrollY = 0;
        _feedMaxScrollY = 0;
        buildPanel();
        setSelectedTab(_chanIdx);
        renderRecords();
        refreshSharedInputLayout();
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
        _cfg.selectedRowColor = t[3];
    }

    function doCustomize(id:String):Void {
        if (id == "cz_hide_delay_up" || id == "cz_hide_delay_dn") {
            _cfg.adjustAutoHideDelay(id == "cz_hide_delay_up" ? 5 : -5);
            _autoHideOn = _cfg.autoHideActive();
            bumpAutoHide();
            persistConfig();
            closeHudLoaderMenuAfterStateChange();
            return;
        }
        if (id == "cz_reset") {
            _cfg = FcmConfig.resetToDefaults(_cfg);
            _themeIdx = 0;
            if (_autoHideTimer != null) { _autoHideTimer.stop(); _autoHideTimer = null; }
            _autoHideOn = _cfg.autoHideActive();
            rebuildPanel();
            updateHUDVisibility();
            try { subscribeRecentActivities(); } catch (_:Dynamic) {}
            if (_autoHideOn) bumpAutoHide();
            persistConfig();
            zfeLog("info", "customize", "all settings reset to defaults");
            return;
        }
        // Delegate sizing/font customizations to FcmConfig (includes inputHeight/inputFontSize, feed font, panel size)
        if (_cfg.customizeSize(id)) {
            _cfg.clamp();
            rebuildPanel();
            updateHUDVisibility();
            persistConfig();
            zfeLog("info", "customize", "sizing " + id);
            return;
        }
        switch (id) {
            case "cz_position_reset": _cfg.x = 10; _cfg.y = 10;
            case "cz_up":      _cfg.y -= 20;
            case "cz_down":    _cfg.y += 20;
            case "cz_left":    _cfg.x -= 20;
            case "cz_right":   _cfg.x += 20;
            case "cz_opac_up": _cfg.bgAlpha += 0.1;
            case "cz_opac_dn": _cfg.bgAlpha -= 0.1;
            case "cz_theme":   cycleTheme();
            default: if (!_cfg.customizeSize(id) && !_cfg.customizeColor(id)) return;
        }
        _cfg.clamp();   // bound manual offsets, dimensions and alpha
        // Move is cheap (just reposition the container); size/opacity/theme need a redraw.
        if (id == "cz_up" || id == "cz_down" || id == "cz_left" || id == "cz_right" || id == "cz_position_reset") { x = _cfg.x; y = _cfg.y; refreshSharedInputLayout(); }
        else rebuildPanel();
        persistConfig();
    }

    // Best-effort persist so customizations survive relaunch. ZFE storage is scoped to this vendor;
    // if unavailable the change is still applied live this session (guarded, no-op on failure).
    var _hudLayoutSupported:Bool = false;
    var _hudLayout:FcmHudLayout = new FcmHudLayout(Std.string(Std.int(Math.random() * 1000000000)));

    function syncHudLayout():Void {
        if (_api == null || _api.provider != FcmNativeApi.XSCAL || !_connected || _needsLink || !_hudLayoutSupported) return;
        var body = _hudLayout.request(flash.Lib.getTimer(), _cfg);
        if (body.length == 0) return;
        try {
            _api.call("chat.v1.sendMessage", haxe.Json.stringify({channel:"server", targetUserId:"", body:body}));
        } catch (_:Dynamic) { zfeLog("warn", "customize", "layout sync deferred"); }
    }

    function persistConfig():Void {
        if (_api == null || _api.provider == FcmNativeApi.XSCAL) {
            _hudLayout.changed();
            syncHudLayout();
            return;
        }
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
        if (_api == null || _api.provider == FcmNativeApi.XSCAL) return;
        try {
            var payload:String = '{"vendor":"' + VENDOR + '","path":"' + SETTINGS_PATH + '"}';
            var raw:String = callTop("readStorage", payload);
            if (raw.indexOf('"success":true') < 0 || raw.indexOf('"found":true') < 0) return;
            var stored:String = FcmConfig.decodeJsonText(extractJsonString(raw, "text"));
            if (stored.indexOf("[FCMChat]") < 0) return;
            _cfg = FcmConfig.mergePersistedCustomization(_cfg, stored);
            _autoHideOn = _cfg.autoHideActive();
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
    //      font arg is the engine body alias (FONT_BODY = $MAIN_Font),
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

    function pipboyOwnsInput():Bool {
        return flash.Lib.getTimer() < _pipboyTransitionUntil
            || FcmRoster.hasPipboy(uiData(getBSUIData(_rosterManager, "MenuStackData")));
    }

    function releaseInputForPipboy():Void {
        if (!_inputOpen || !pipboyOwnsInput()) return;
        if (_nativeInput) closeInputNative();
        else closeInputSharedHudTools("PipBoy menu active");
    }

    function openInput():Void {
        if (_disposed) return;
        if (_inputOpen) return;
        if (_xscalSessionReleaseUncertain) {
            zfeLog("warn", "input", "xScal open blocked: prior session release unconfirmed");
            return;
        }
        // Provider hotkeys are global. Never take text ownership while Fallout owns a
        // blacklisted UI such as ContainerMode, where T may mean Deposit All.
        if (!isValidHUDMode()) return;
        if (pipboyOwnsInput()) return;
        // A navigation key may have been held across the Insert edge. Start each edit with a
        // clean latch so its key-up cannot select a channel or steal the first typed character.
        clearNavigationLatches();
        // The open key both restores a hidden panel AND opens input (CAP-011, guaranteed).
        if (_hidden) show();
        bumpAutoHide();   // opening input = activity (the timer also never hides while input is open)
        // One BA2 serves both providers. ZFE uses the host-owned SharedHUDTools editor,
        // which starts Fallout's ControlMap text lock. xScal uses its native session.
        // ZFE input.v1 alone still lets gameplay actions through on the native test build.
        var provider:String = _api == null ? "" : _api.provider;
        var route:String = FcmInputRoute.preferred(provider, _ownedInputUsable,
            provider == FcmNativeApi.XSCAL && _xscalSessionUsable);
        if (route == FcmInputRoute.XSCAL_SESSION) {
            if (openXscalSessionInput()) return;
            if (_xscalSessionReleaseUncertain) return;
            if (_xscalSessionUsable) return; // Busy native owner: do not open a second editor.
            openInputSharedHudTools();
        } else if (route == FcmInputRoute.SHARED) openInputSharedHudTools();
        if (_inputOpen) return;

        zfeLog("warn", "input", "text editor unavailable; no ControlMap lock, input refused");
        setPrompt("chat input unavailable (HUDModLoader editor)");
    }

    /** xScal owns composition/editing; the widget consumes only session snapshots. */
    function openXscalSessionInput():Bool {
        if (_api == null || _api.provider != FcmNativeApi.XSCAL || !_xscalSessionUsable) return false;
        try {
            var begin = FcmXscalInput.begin(_api.xscalBeginInput());
            if (!begin.success) {
                if (begin.busy) {
                    zfeLog("info", "input", "xScal text session busy; retry on next open");
                    return false;
                }
                if (!begin.unsupported && begin.sessionId != null) {
                    try { _api.xscalEndInput(begin.sessionId); } catch (_:Dynamic) {}
                }
                _xscalSessionReleaseUncertain = !begin.unsupported;
                _xscalSessionUsable = false;
                zfeLog("warn", "input", begin.unsupported
                    ? "xScal text session unsupported; using SharedHUDTools"
                    : "xScal begin malformed; input blocked until reload");
                return false;
            }
            _xscalSessionId = begin.sessionId;
            _xscalSessionRevision = -1;
            _xscalSessionInput = true;
            _nativeInput = true;
            _inputOpen = true;
            _inProgress = "";
            var generation:Int = ++_inputGeneration;
            setPrompt(typingPrompt());
            stopInputTimer();
            _inputTimer = new flash.utils.Timer(OWNED_INPUT_POLL_MS);
            _inputTimer.addEventListener(TimerEvent.TIMER,
                function(_) { runXscalSessionInputSafely(generation); });
            _inputTimer.start();
            zfeLog("info", "input path", "xscal-session-v1 begin accepted");
            return true;
        } catch (e:Dynamic) {
            if (_xscalSessionId != null) closeXscalSessionInput(true);
            else _xscalSessionReleaseUncertain = true;
            _xscalSessionUsable = false;
            zfeLog("warn", "input", "xScal session begin failed: " + clip200(Std.string(e)));
            return false;
        }
    }

    function runXscalSessionInputSafely(generation:Int):Void {
        if (_disposed || !_xscalSessionInput || generation != _inputGeneration) return;
        try {
            var snapshot = FcmXscalInput.poll(_api.xscalPollInput(_xscalSessionId),
                _xscalSessionId, 512);
            if (!snapshot.success || snapshot.revision < _xscalSessionRevision
                    || (snapshot.revision == _xscalSessionRevision && snapshot.text != _inProgress)) {
                zfeLog("warn", "input", "xScal poll rejected valid=" + snapshot.success
                    + " revision=" + snapshot.revision + " previous=" + _xscalSessionRevision
                    + " changedWithoutRevision=" + (snapshot.text != _inProgress));
                closeXscalSessionInput(true);
                return;
            }
            if (snapshot.revision != _xscalSessionRevision || snapshot.text != _inProgress) {
                zfeLog("info", "input", "xScal poll state=" + snapshot.state
                    + " revision=" + snapshot.revision + " textLen=" + snapshot.text.length);
                _xscalSessionRevision = snapshot.revision;
                _inProgress = snapshot.text;
                setPrompt(_inProgress.length == 0 ? typingPrompt()
                    : typingPrompt() + ' <font face="' + FONT_BODY + '" size="'
                        + _cfg.effectiveInputFontSize(true) + '" color="'
                        + hx(_cfg.inputTextColor) + '"> &#x203A; '
                        + FcmConfig.htmlEscape(_inProgress) + '</font>');
            }
            if (snapshot.state == "active") return;
            var submitted:Bool = snapshot.state == "submitted";
            var text:String = StringTools.trim(_inProgress);
            zfeLog("info", "input", "xScal terminal state=" + snapshot.state
                + " revision=" + snapshot.revision + " textLen=" + text.length);
            var cancelDiagnostic:Bool = snapshot.state == "cancelled";
            var closeStarted:Int = flash.Lib.getTimer();
            if (cancelDiagnostic) zfeLog("info", "input", "xScal cancel close enter");
            var ended:Bool = closeXscalSessionInput();
            if (cancelDiagnostic) {
                _xscalCancelDiagnosticPending = true;
                zfeLog("info", "input", "xScal cancel close exit elapsedMs="
                    + (flash.Lib.getTimer() - closeStarted) + " released=" + ended);
                haxe.Timer.delay(function():Void {
                    if (!_disposed) zfeLog("info", "input", "xScal cancel UI timer alive"
                        + " waitingForHudEvent=" + _xscalCancelDiagnosticPending);
                }, 1000);
            }
            // Poll's terminal state owns the submit decision. EndInput is cleanup; the
            // author's contract does not specify its return shape. A failed cleanup still
            // blocks reopening, but must not silently discard an accepted submission.
            if (submitted && text.length > 0) {
                zfeLog("info", "input", "xScal submitted draft dispatch endConfirmed=" + ended);
                handleSubmittedText(text);
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "xScal session poll failed: " + clip200(Std.string(e)));
            closeXscalSessionInput(true);
        }
    }

    /** Balance every successful begin, including modal interruption and widget teardown. */
    function closeXscalSessionInput(failed:Bool = false):Bool {
        stopInputTimer();
        var id = _xscalSessionId;
        _xscalSessionId = null;
        _xscalSessionInput = false;
        ++_inputGeneration;
        var ended:Bool = id == null;
        if (id != null && _api != null) {
            try {
                var endStarted:Int = flash.Lib.getTimer();
                var result:Dynamic = _api.xscalEndInput(id);
                ended = result == true;
                zfeLog(ended ? "info" : "warn", "input", "xScal end result="
                    + (ended ? "true" : result == false ? "false" : result == null ? "null" : "other")
                    + " elapsedMs=" + (flash.Lib.getTimer() - endStarted));
            } catch (e:Dynamic) {
                ended = false;
                zfeLog("warn", "input", "xScal end threw: " + clip200(Std.string(e)));
            }
            if (!ended) {
                // EndInput's 0.2.18 return shape is not documented and is not a
                // reliable release signal in GFx. Verify the old ID is dead using
                // xScal's own invalid_session response before allowing a new begin.
                try {
                    var probeStarted:Int = flash.Lib.getTimer();
                    ended = FcmXscalInput.confirmsReleased(_api.xscalPollInput(id));
                    zfeLog(ended ? "info" : "warn", "input", "xScal release probe="
                        + (ended ? "invalid_session" : "unconfirmed")
                        + " elapsedMs=" + (flash.Lib.getTimer() - probeStarted));
                } catch (e:Dynamic) {
                    zfeLog("warn", "input", "xScal release probe threw: "
                        + clip200(Std.string(e)));
                }
            }
        }
        if (!ended) _xscalSessionReleaseUncertain = true;
        if (!ended) failed = true;
        if (failed) _xscalSessionUsable = false;
        _inputOpen = false;
        _nativeInput = false;
        _xscalSessionRevision = -1;
        _inProgress = "";
        clearNavigationLatches();
        setPrompt(idlePrompt());
        return !failed && ended;
    }

    /** Open a controller-independent, owner-scoped ZFE keyboard session. */
    function openOwnedInput():Bool {
        if (_api == null || _api.provider != FcmNativeApi.ZFE || !_ownedInputUsable) return false;
        try {
            var raw = _api.call("input.v1.begin",
                FcmZfeInput.beginPayload(VENDOR, "", Std.int(Math.min(512, _cfg.maxSendLen))));
            var result = FcmZfeInput.begin(raw);
            if (!result.success || !result.rawSuppression || !result.releaseBarrier) {
                zfeLog("warn", "input", "input.v1.begin rejected required ownership guarantees");
                _ownedInputUsable = false;
                return false;
            }
            _inputOpen = true;
            _nativeInput = true;
            _ownedInput = true;
            _ownedInputSession = result.session;
            _ownedInputRevision = -1;
            _ownedInputSubmitted = false;
            _ownedInputCancelled = false;
            _ownedReleaseStable = 0;
            _inProgress = "";
            setPrompt(typingPrompt());
            zfeLog("info", "input", "input path: zfe-input-v1 controller-test");
            stopInputTimer();
            _inputTimer = new flash.utils.Timer(OWNED_INPUT_POLL_MS);
            _inputTimer.addEventListener(TimerEvent.TIMER, function(_) { runOwnedInputSafely(); });
            _inputTimer.start();
            return true;
        } catch (e:Dynamic) {
            _ownedInputUsable = false;
            zfeLog("warn", "input", "input.v1.begin failed: " + clip200(Std.string(e)));
            return false;
        }
    }

    function runOwnedInputSafely():Void {
        if (_disposed || !_ownedInput) return;
        try { pollOwnedInput(); }
        catch (e:Dynamic) {
            zfeLog("warn", "input", "input.v1.poll failed: " + clip200(Std.string(e)));
            closeOwnedInput(true);
        }
    }

    function pollOwnedInput():Void {
        var result = FcmZfeInput.poll(_api.call("input.v1.poll",
            FcmZfeInput.sessionPayload(_ownedInputSession)), _cfg.maxSendLen);
        if (!result.success || !FcmZfeInput.sameSession(_ownedInputSession, result.session)
                || result.revision < _ownedInputRevision) {
            closeOwnedInput(true);
            return;
        }
        if (result.revision != _ownedInputRevision) {
            _ownedInputRevision = result.revision;
            _inProgress = result.text;
            setPrompt(_inProgress.length == 0 ? typingPrompt()
                : typingPrompt() + ' <font face="' + FONT_BODY + '" size="' + _cfg.effectiveInputFontSize(true)
                    + '" color="' + hx(_cfg.inputTextColor) + '"> &#x203A; '
                    + FcmConfig.htmlEscape(_inProgress) + '</font>');
        }
        if (result.submitted) _ownedInputSubmitted = true;
        if (result.cancelled) _ownedInputCancelled = true;
        if (_ownedInputSubmitted && _ownedInputCancelled) { closeOwnedInput(true); return; }
        if (!_ownedInputSubmitted && !_ownedInputCancelled) {
            if (!result.active) closeOwnedInput(true);
            return;
        }
        _ownedReleaseStable = result.releaseReady ? _ownedReleaseStable + 1 : 0;
        if (_ownedReleaseStable < OWNED_RELEASE_STABLE_POLLS) return;
        var submitted = _ownedInputSubmitted;
        var text = StringTools.trim(_inProgress);
        closeOwnedInput(false);
        if (submitted && text.length > 0) handleSubmittedText(text);
    }

    function closeOwnedInput(failed:Bool = false):Void {
        stopInputTimer();
        var session = _ownedInputSession;
        _ownedInputSession = null;
        if (session != null && _api != null) try {
            var ended = Std.string(_api.call("input.v1.end", FcmZfeInput.sessionPayload(session)));
            if (ended.indexOf('"success":true') < 0) failed = true;
        } catch (_:Dynamic) { failed = true; }
        if (failed) _ownedInputUsable = false;
        _inputOpen = false;
        _nativeInput = false;
        _ownedInput = false;
        _ownedInputRevision = -1;
        _ownedInputSubmitted = false;
        _ownedInputCancelled = false;
        _ownedReleaseStable = 0;
        _inProgress = "";
        clearNavigationLatches();
        setPrompt(idlePrompt());
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
                setPrompt(typingPrompt() + ' <font face="' + FONT_BODY + '" size="' + _cfg.effectiveInputFontSize(true) + '" color="'
                    + hx(_cfg.inputTextColor) + '"> &#x203A; ' + FcmConfig.htmlEscape(text) + '</font>');
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
        if (_xscalSessionInput) { closeXscalSessionInput(failed); return; }
        if (_ownedInput) { closeOwnedInput(failed); return; }
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
        stopSharedInputDiagnostics();
        _inputGeneration++;
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

    function refreshSharedInputLayout():Void {
        if (_inputOpen && !_nativeInput && _hudTools != null) {
            try { formatSharedInput(); }
            catch (e:Dynamic) { zfeLog("warn", "input", "live input layout failed: " + clip200(Std.string(e))); }
        }
    }

    function formatSharedInput():Void {
        var input = _cfg.inputRect();
        Reflect.callMethod(_hudTools, Reflect.field(_hudTools, "FormatTextEdit"),
            [x + input.x, y + input.y, input.width, input.height, FONT_BODY,
             _cfg.effectiveInputFontSize(), nh(_cfg.inputTextColor), nh(_cfg.inputBgColor), _cfg.bgAlpha]);
        zfeLog("info", "input", "FormatTextEdit ok x=" + (x + input.x) + " y=" + (y + input.y)
            + " width=" + input.width + " height=" + input.height + " font=" + _cfg.effectiveInputFontSize());
    }

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
        zfeLog("info", "input", "input path: shared-hud-tools");

        // ── Step 1: FormatTextEdit — position + style the entry box ─────────
        // x/y are stage coordinates (1920×1080 space). Position at widget's lower edge.
        // Color args are hex strings WITHOUT '#'. Font arg is the engine body alias.
        var textEditStarted:Bool = false;
        var generation:Int = ++_inputGeneration;

        try {
            var formatEdit:Dynamic = Reflect.field(_hudTools, "FormatTextEdit");
            var formatOsk:Dynamic = Reflect.field(_hudTools, "FormatOnScreenKeyboard");
            var textEdit:Dynamic = Reflect.field(_hudTools, "TextEdit");
            if (formatEdit == null || formatOsk == null || textEdit == null) {
                throw "SharedHUDTools text-edit API incomplete";
            }
            formatSharedInput();

            // ── Step 2: FormatOnScreenKeyboard — required by HUDTools ────────
            // Keep the host's 300x180 controller keyboard outside the viewport.
            // In ZFE controller mode, focus the visible text entry below instead.
            Reflect.callMethod(_hudTools, formatOsk, [0.0, -300.0]);
            zfeLog("info", "input", "FormatOnScreenKeyboard ok x=0 y=-300");

            // ── Step 3: TextEdit — open the entry; callback fires on submit ──────
            textEditStarted = true;
            var accepted:Dynamic = Reflect.callMethod(_hudTools, textEdit,
                [function(text:Dynamic):Void {
                    if (FcmCommand.acceptsInputCallback(_inputOpen, _inputGeneration, generation)) onInputSubmitSafely(text);
                }, ""]);
            if (accepted == false) throw "SharedHUDTools rejected TextEdit";
            // HUDTools renders its own focused entry field at this exact input position.
            // Do not mirror that same field into _promptTf, or every character appears twice.
            setPrompt(typingPrompt());
            zfeLog("info", "input", "opened");
            focusZfePhysicalKeyboardField();
            startSharedInputDiagnostics(generation);
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
     * HUDTools focuses its off-screen controller field in gamepad mode. The visible
     * entry field is a sibling on the public display list and retains HUDTools'
     * key handlers and the host ControlMap lock when focused. This lets a player
     * keep the controller active while typing on a physical keyboard.
     */
    function focusZfePhysicalKeyboardField():Void {
        if (_api == null || _api.provider != FcmNativeApi.ZFE || stage == null
                || !Std.isOfType(stage.focus, TextField)) return;
        var focused:TextField = cast stage.focus;
        if (focused.y >= 0 || focused.width > 1) return;
        var host:DisplayObjectContainer = focused.parent;
        if (host == null) return;
        var input = _cfg.inputRect();
        var expectedX:Float = x + input.x;
        var expectedY:Float = y + input.y;
        for (i in 0...host.numChildren) {
            var child = host.getChildAt(i);
            if (!Std.isOfType(child, TextField)) continue;
            var candidate:TextField = cast child;
            if (candidate == focused || !candidate.visible || candidate.type != TextFieldType.INPUT
                    || Math.abs(candidate.x - expectedX) > 2
                    || Math.abs(candidate.y - expectedY) > 2
                    || Math.abs(candidate.width - input.width) > 2) continue;
            candidate.selectable = true;
            stage.focus = candidate;
            candidate.setSelection(candidate.length, candidate.length);
            zfeLog("info", "input", "ZFE controller mode: physical keyboard focused host entry");
            return;
        }
        zfeLog("warn", "input", "ZFE controller mode: host entry field not found");
    }

    /**
     * Callback from SharedHUDTools.TextEdit.
     * text == null: user cancelled (Esc/Tab) or TextEdit failed.
     * text == String: user submitted (Enter); may be empty.
     * Fires exactly once; textFunction is nulled by SharedHUDTools after.
     */
    function onInputSubmit(text:Dynamic):Void {
        if (_disposed) return;
        var recoveredDraft:String = _sharedInputDraft;
        var submitWasArmed:Bool = _sharedInputSubmitArmed;
        stopSharedInputDiagnostics();
        _inputOpen = false;
        clearNavigationLatches();
        setPrompt(idlePrompt());
        if (text == null) return; // Cancellation is never link activation.
        var s:String = Std.string(text);
        if (submitWasArmed && StringTools.trim(s).length == 0
                && StringTools.trim(recoveredDraft).length > 0) {
            s = recoveredDraft;
            zfeLog("warn", "input", "recovered empty SharedHUDTools submit len=" + s.length);
        }
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
     * Observe the host-owned editor without recording its text. This distinguishes a selected
     * character being replaced from field reinitialization, focus loss, and visual clipping.
     * The focused TextField is a public Stage property; HUDTools' private field is not accessed.
     */
    function startSharedInputDiagnostics(generation:Int):Void {
        stopSharedInputDiagnostics();
        pollSharedInputDiagnostics(generation);
        _sharedInputDiagTimer = new flash.utils.Timer(75);
        _sharedInputDiagTimer.addEventListener(TimerEvent.TIMER, function(_:Dynamic) {
            try { pollSharedInputDiagnostics(generation); }
            catch (err:Dynamic) {
                zfeLog("warn", "inputdiag", "shared editor diagnostic isolated: " + clip200(Std.string(err)));
                stopSharedInputDiagnostics();
            }
        });
        _sharedInputDiagTimer.start();
    }

    function bindSharedInputField(tf:TextField):Void {
        if (_sharedInputField == tf) return;
        if (_sharedInputField != null) {
            try { _sharedInputField.removeEventListener(KeyboardEvent.KEY_DOWN, onSharedInputKeyDown); }
            catch (_:Dynamic) {}
        }
        _sharedInputField = tf;
        _sharedInputField.addEventListener(KeyboardEvent.KEY_DOWN, onSharedInputKeyDown, false, 1000);
    }

    function onSharedInputKeyDown(e:KeyboardEvent):Void {
        if (_disposed || !_inputOpen || _nativeInput || _sharedInputField == null) return;
        var keyCode:Int = Std.int(e.keyCode);
        if (keyCode != 13 && FcmCommand.linkActivationEnabled(
                FcmCommand.physicalKeyAction(keyCode).length > 0
                    ? FcmCommand.physicalKeyAction(keyCode) : _cfg.activateLinkKey,
                _cfg.activateLinkKey, _inputOpen, selectedRowHasLink())
                && FcmCommand.virtualKeyCode(_cfg.activateLinkKey) == keyCode) {
            e.preventDefault();
            e.stopImmediatePropagation();
            activateSelectedLinkFromOpenInput();
            return;
        }
        // Keep the draft only in memory so an observed HUDTools callback loss cannot discard an
        // Enter submission. Neither the characters nor derived content are written to the log.
        _sharedInputDraft = FcmSharedInputRecovery.stableDraft(
            _sharedInputDraft, _sharedInputField.text, _sharedInputAllowEmpty);
        _sharedInputAllowEmpty = (e.keyCode == 8 || e.keyCode == 46)
            && _sharedInputField.length <= 1;
        if (e.keyCode == 13) {
            _sharedInputSubmitArmed = true;
            zfeLog("info", "inputdiag", "shared editor Enter reserved for submit len="
                + _sharedInputDraft.length);
        }
        else if (e.keyCode == 27 || e.keyCode == 9) _sharedInputCancelArmed = true;
    }

    function recoverLostSharedInputFocus(generation:Int, decision:String):Void {
        if (!FcmCommand.acceptsInputCallback(_inputOpen, _inputGeneration, generation)) return;
        var draft:String = _sharedInputDraft;
        var draftLength:Int = draft == null ? 0 : draft.length;
        closeInputSharedHudTools("host editor callback missing");
        if (decision == FcmSharedInputRecovery.SUBMIT) {
            zfeLog("warn", "input", "recovered missing SharedHUDTools submit callback len=" + draftLength);
            handleSubmittedText(draft);
        } else {
            zfeLog("warn", "input", "released SharedHUDTools session after editor focus loss");
        }
    }

    function pollSharedInputDiagnostics(generation:Int):Void {
        if (_disposed || !_inputOpen || _nativeInput || generation != _inputGeneration || stage == null) {
            stopSharedInputDiagnostics();
            return;
        }
        // SharedHUDTools can deliver TextEdit to the host on the next frame.
        // Recheck after that handoff before binding diagnostics to its focus field.
        focusZfePhysicalKeyboardField();
        var focused:Dynamic = stage.focus;
        var isTextField:Bool = focused != null && Std.isOfType(focused, TextField);
        var length:Int = -1;
        var selectionStart:Int = -1;
        var selectionEnd:Int = -1;
        var caret:Int = -1;
        var maxChars:Int = -1;
        var inputType:String = "none";
        if (isTextField) {
            var tf:TextField = cast focused;
            bindSharedInputField(tf);
            var observedDraft:String = tf.text;
            var stableDraft:String = FcmSharedInputRecovery.stableDraft(
                _sharedInputDraft, observedDraft, _sharedInputAllowEmpty);
            if (observedDraft.length == 0 && stableDraft.length > 0) {
                tf.text = stableDraft;
                tf.setSelection(stableDraft.length, stableDraft.length);
                zfeLog("warn", "inputdiag", "restored transient empty shared editor len="
                    + stableDraft.length);
            }
            _sharedInputDraft = stableDraft;
            _sharedInputAllowEmpty = false;
            _sharedInputFocusLostAt = 0;
            // HUDTools creates an INPUT field with selectable=false. In observed Scaleform builds
            // that leaves the caret unstable and the draft returns to length zero between keys.
            // Enabling selection is the public TextField fix; it does not read or rewrite text.
            if (!tf.selectable) {
                tf.selectable = true;
                zfeLog("info", "inputdiag", "shared editor selectable enabled");
            }
            length = tf.length;
            selectionStart = tf.selectionBeginIndex;
            selectionEnd = tf.selectionEndIndex;
            caret = tf.caretIndex;
            maxChars = tf.maxChars;
            inputType = Std.string(tf.type);
        } else if (_sharedInputField != null) {
            var now:Float = flash.Lib.getTimer();
            if (_sharedInputFocusLostAt == 0) _sharedInputFocusLostAt = now;
            var lostMs:Float = now - _sharedInputFocusLostAt;
            var decision:String = FcmSharedInputRecovery.decide(true, lostMs,
                SHARED_INPUT_FOCUS_GRACE_MS, _sharedInputSubmitArmed, _sharedInputCancelArmed,
                _sharedInputDraft == null ? 0 : _sharedInputDraft.length);
            if (decision != FcmSharedInputRecovery.WAIT) {
                recoverLostSharedInputFocus(generation, decision);
                return;
            }
        }
        var signature:String = "generation=" + generation
            + " focusedTextField=" + (isTextField ? "yes" : "no")
            + " type=" + inputType + " len=" + length
            + " selection=" + selectionStart + ":" + selectionEnd
            + " caret=" + caret + " maxChars=" + maxChars;
        if (signature == _lastSharedInputDiag) return;
        _lastSharedInputDiag = signature;
        zfeLog("info", "inputdiag", signature);
    }

    /**
     * Shared submit handler — used by BOTH the native fallback (pollNativeInput) and
     * the SharedHUDTools primary path (onInputSubmit). Applies the slash channel-switch
     * logic ("/g /t /e /i /r"), consuming a bare slash command, then sends the rest.
     */
    function handleSubmittedText(text:String):Void {
        var s:String = (text == null) ? "" : Std.string(text);
        s = StringTools.trim(s);
        if (s.length == 0) {
            if (FcmCommand.linkActivationEnabled("ENTER", _cfg.activateLinkKey, true, selectedRowHasLink())) {
                activateSelectedLink();
            }
            return;
        }

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

        if (FcmCommand.isGiveawayHelp(s)) {
            addPrivateGiveawayHelp();
            return;
        }
        var giveawayCommand = FcmCommand.giveawayCommand(s);
        if (giveawayCommand.length > 0) {
            sendMessage(giveawayCommand);
            return;
        }

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

        var emojiCommand = FcmEmojiCommand.resolve(s);
        if (emojiCommand.handled) {
            if (emojiCommand.error.length > 0) {
                setLogText(FcmConfig.htmlEscape(emojiCommand.error));
                return;
            }
            s = emojiCommand.body;
        }
        sendMessage(s);
    }

    var _browser:FcmBrowser = null;
    var _browserTimer:Timer = null;

    function stopBrowser():Void {
        if (_browserTimer != null) { _browserTimer.stop(); _browserTimer = null; }
        if (_browser != null) { _browser.cancel(); _browser = null; }
    }

    function browserPrompt():Void {
        if (_browser == null) return;
        var text = switch (_browser.state) {
            case "handed_off": "Browser handoff accepted";
            case "accepted", "pending_confirmation": "Browser request awaiting ZFE";
            case "launching": "Browser handoff in progress";
            case "launch_unknown": "Browser outcome unknown; no automatic retry";
            case "denied", "cancelled", "expired": "Browser request closed";
            default: "Browser link unavailable; the URL remains in chat";
        };
        setPrompt(text);
    }

    function activateSelectedLink():Void {
        if (_selectedRowIndex < 0 || _selectedRowIndex >= _feedRows.length) return;
        var url:String = _feedRows[_selectedRowIndex].linkUrl;
        if (!FcmLink.validHttpUrl(url)) return;
        if (_browser != null && _browser.pending()) return;
        stopBrowser();
        if (_api == null || _api.provider != FcmNativeApi.ZFE) {
            setPrompt("Browser links unavailable on this provider; the URL remains in chat");
            return;
        }
        // Capture the owning bridge. Never route a pending request through a replacement.
        var owner = _api;
        _browser = new FcmBrowser(function(verb, payload) { return owner.call(verb, payload); });
        _browser.activate(url, flash.Lib.getTimer());
        browserPrompt();
        if (!_browser.pending()) return;
        _browserTimer = new Timer(250);
        _browserTimer.addEventListener(TimerEvent.TIMER, function(_) {
            if (_disposed || _api != owner) { stopBrowser(); return; }
            _browser.tick(flash.Lib.getTimer());
            browserPrompt();
            if (!_browser.pending() && _browserTimer != null) {
                _browserTimer.stop(); _browserTimer = null;
            }
        });
        _browserTimer.start();
    }

    function selectedRowHasLink():Bool {
        return _selectedRowIndex >= 0 && _selectedRowIndex < _feedRows.length
            && FcmLink.validHttpUrl(_feedRows[_selectedRowIndex].linkUrl);
    }

    function activateSelectedLinkFromOpenInput():Void {
        if (!_inputOpen || !selectedRowHasLink()) return;
        activateSelectedLink();
        if (_nativeInput) closeInputNative();
        else closeInputSharedHudTools("selected link activation");
        browserPrompt();
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
        return FcmCommand.channelVisible(activeChannel, rec.channel)
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
                requestRender();
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
        // Lazily recover _outboxIdentity if LINK COMPLETE just fired but the
        // next getAuthState has not yet populated it; avoids the 8294-type
        // "outboxIdLen=0" block that shows the link screen even though needsLink is false.
        if (_outboxIdentity.length == 0 && !_needsLink) {
            var seed:String = _linkedUserId.length > 0 ? _linkedUserId : (_relayUserId.length > 0 ? _relayUserId : _userId);
            if (seed.length > 0) {
                _outboxIdentity = seed;
            } else {
                try { refreshAuthState(); } catch (_:Dynamic) {}
                if (_outboxIdentity.length == 0) {
                    var retrySeed:String = _linkedUserId.length > 0 ? _linkedUserId : (_relayUserId.length > 0 ? _relayUserId : _userId);
                    if (retrySeed.length > 0) _outboxIdentity = retrySeed;
                }
            }
        }
        if (_api == null || _outboxIdentity.length == 0 || _needsLink) {
            setLogText(linkHint());
            return;
        }
        if (!_api.supportsNonBlockingSend()) {
            setLogText("Sending is disabled: update ZFE for safe async chat.");
            zfeLog("warn", "send", "blocked synchronous provider send to protect the game UI thread");
            return;
        }

        if (raw.length > _cfg.maxSendLen) raw = raw.substr(0, _cfg.maxSendLen);
        raw = fcmClean(raw);
        if (raw.length == 0) return;

        var isGiveawayCommand:Bool = FcmCommand.giveawayCommand(raw).length > 0;
        var slug:String = isGiveawayCommand ? "events" : CHAN_SLUGS[_chanIdx];
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
        if (!_outbox.add(localSendId, slug, raw, _outboxIdentity,
                slug == "server" ? _serverSession.room : "", flash.Lib.getTimer())) {
            outboxStatus("Message queue is full; wait for chat to reconnect.");
            return;
        }
        var nativeSubmit:Bool = _nativeSubmitInFlight;
        var ownCosmetics = ownCosmeticsForSend();
        if (!isGiveawayCommand) {
            addOptimisticEcho(slug, raw, "", ownCosmetics.tag, ownCosmetics.supporterStar,
                ownCosmetics.starColor, localUserId, localSendId);
            zfeLog("info", "echo", "created canonical local row; transport deferred ch=" + slug);
        }

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
                if (_canRetryHudSend) retryQueuedSend(localSendId, "deferred send exception");
                else { _outbox.remove(localSendId); try { removeOptimisticRecord(localSendId); requestRender(); } catch (_:Dynamic) {} }
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
            if (_canRetryHudSend) { retryQueuedSend(localSendId, "isolated send exception"); return; }
            _outbox.remove(localSendId);
            try { removeOptimisticRecord(localSendId); } catch (_:Dynamic) {}
            try {
                if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], slug)) requestRender();
            } catch (_:Dynamic) {}
        }
    }

    /** Invoke the provider after the optimistic row had a paint opportunity. */
    function sendMessageTransport(slug:String, raw:String, nativeSubmit:Bool, localSendId:String,
            localUserId:String):Void {
        var queued = _outbox.get(localSendId);
        if (queued == null) return;
        if (_api == null || !_connected || _authState != "authenticated") {
            retryQueuedSend(localSendId, "queued send awaiting connection");
            return;
        }
        if (queued.identity != _outboxIdentity) { _outbox.remove(localSendId); removeOptimisticRecord(localSendId); return; }
        if (slug == "server" && (!_serverSessionReady || queued.room != _serverSession.room)) return;
        if (queued.attempts > 0 && !_canRetryHudSend) {
            _outbox.remove(localSendId); removeOptimisticRecord(localSendId);
            outboxStatus("Delivery unconfirmed; automatic retry needs the updated relay.");
            return;
        }
        if (queued.attempts == 0) {
            for (rec in _records) if (rec.pending && rec.localSendId == localSendId) rec.pendingAt = flash.Lib.getTimer();
        }
        _outbox.attempted(localSendId, flash.Lib.getTimer());

        if (raw.length > _cfg.maxSendLen) raw = raw.substr(0, _cfg.maxSendLen);
        raw = fcmClean(raw);
        if (raw.length == 0) {
            // sendMessage() creates the optimistic row before deferring transport. A
            // control-character-only draft must remove that exact transaction rather than
            // leaving a permanent phantom message in the feed.
            _outbox.remove(localSendId);
            removeOptimisticRecord(localSendId);
            if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], slug)) requestRender();
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
            if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], slug)) requestRender();
            zfeLog("warn", "server", "ordinary send blocked; session not ready");
            return;
        }
        var serverTarget = _canRetryHudSend ? FcmOutbox.target(localSendId, queued.room)
            : (slug == "server" ? "FCMROOM/1;" + _serverSession.room : "");
        var payload:String = '{"channel":"' + jsonEscape(slug) + '","targetUserId":"' + jsonEscape(serverTarget) + '","body":"' + jsonEscape(raw) + '"}';
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
                zfeLog("info", "nativein", "send-in-session code=" + extractJsonString(rs, "code") + " status=" + extractJsonString(rs, "status"));
            }
            var queuedRequestId:Int = _api.provider == FcmNativeApi.ZFE
                ? FcmWire.queuedRequestId(rs) : 0;
            if (queuedRequestId > 0) {
                _zfePendingSends.set(queuedRequestId, localSendId);
                zfeLog("info", "send", "queued ch=" + slug + " requestId=" + queuedRequestId);
                scheduleEchoPoll();
                return;
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
                    var ackNameColor:String = extractJsonString(rs, "nameColor");
                    // ZFE may strip additive cosmetic members from native RPC responses, just as
                    // it does for live event frames. v2.10.16+ relays mirror the message ID and
                    // validated cosmetics in the known targetUserId member.
                    var ackHudTransport:String = extractJsonString(rs, "targetUserId");
                    var giveawayFeedback = FcmConfig.hudTransportValue(ackHudTransport, "g");
                    if (giveawayFeedback.length > 0) setLogText(FcmConfig.htmlEscape(giveawayFeedback));
                    var ackTransportMessageId:String = FcmConfig.hudTransportMessageId(ackHudTransport);
                    if (ackTransportMessageId.length > 0) messageId = ackTransportMessageId;
                    if (messageId.length > 0 || FcmOutbox.receipt(ackHudTransport) == localSendId) _outbox.remove(localSendId);
                    else if (!_canRetryHudSend) _outbox.remove(localSendId);
                    var ackTransportNameColor = FcmConfig.hudTransportNameColor(ackHudTransport);
                    if (ackTransportNameColor.length > 0) ackNameColor = ackTransportNameColor;
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
                        ackSupporterStar, ackStarColor, ackCosmeticsKnown, ackNameColor);
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
                var code:String = extractJsonString(rs, "code");
                if (_canRetryHudSend && FcmOutbox.retryable(code)) {
                    if (code == "rate_limited" || code == "send_in_progress") outboxStatus("Message queued - waiting to retry.");
                    else retryQueuedSend(localSendId, "transient send failure");
                    return;
                }
                _outbox.remove(localSendId);
                removeOptimisticRecord(localSendId);
                if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], slug)) requestRender();
                // Surface permanent rejections without retrying them.
                // Failure only: the untruncated response. This is the line that finally exposed
                // the v2.9.12 root cause after days of unreadable `raw={\` output.
                zfeLog("warn", "diag", "RSLEN=" + rs.length + " RSSAFE=" + logSafe(rs).substr(0, 300));
                // "send rejected" — NOT "relay rejected". A 1 ms rejection with no relay-side
                // ingress proves ZFE can reject locally without the frame ever leaving the
                // machine (2026-08-06). Do not re-attribute this to the relay without
                // ingress evidence.
                zfeLog("warn", "send", "send rejected code=" + code + " raw=" + rs.substr(0, 200));
                switch (code) {
                    case "send_uncertain":
                        outboxStatus("Delivery could not be confirmed. Check chat history before sending again.");
                    case "send_conflict":
                        outboxStatus("Message could not be retried. Please send it again.");
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
            if (_canRetryHudSend) { retryQueuedSend(localSendId, "send transport exception"); return; }
            _outbox.remove(localSendId);
            removeOptimisticRecord(localSendId);
            if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], slug)) requestRender();
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
        stopBrowser();
        if (FcmNativeApi.hasProviderConflict(this)) {
            setLogText("ZFE and xScal both detected\nRemove one script extender");
            zfeLog("warn", "startup", "provider conflict; exactly one extender is required");
            return;
        }
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
        zfeLog("info", "startup", "BUILD=chatv1-widget-v" + VERSION + " diagnostics=dup-v1");
        zfeLog("info", "startup", _api.provider == FcmNativeApi.ZFE
            ? "zfe-chat-online-v1 OK"
            : "xscal-chat-interface OK");
        var generalReady = _api.probeGeneralInputCapabilities();
        _ownedInputUsable = generalReady && _api.supportsOwnedTextInput();
        zfeLog(_ownedInputUsable ? "info" : "warn", "input",
            _ownedInputUsable ? "zfe-input-v1 + release barrier ready"
                : (_api.provider == FcmNativeApi.ZFE
                    ? "owner-scoped input unavailable; SharedHUDTools compatibility active"
                    : "xScal SharedHUDTools input path active (controller text is best-effort)"));
        zfeLog(_api.supportsNonBlockingControl() ? "info" : "warn", "startup",
            _api.supportsNonBlockingControl()
                ? "automatic Server-room controls enabled through non-blocking provider path"
                : "automatic Server-room controls disabled; provider lacks a non-blocking control path");
        zfeLog("info", "startup", "found after " + _zfeSearchTries + " attempt(s)");
        zfeLog(_hudEventListenerAttached ? "info" : "warn", "input",
            _hudEventListenerAttached
                ? "HUDMod::UserEvent stage listener attached"
                : "HUDMod::UserEvent stage listener unavailable; physical input fallback required");

        loadPersistedConfig();
        syncConfiguredZfeHotkey();
        startOwnedHotkeys();
        // Physical Page/arrow polling is provider-level input, not relay state: start it as
        // soon as the extender is known so channel switching works before (and without) auth.
        startPhysicalNavigation();
        // Push-driven identity: a stale pre-login AccountInfoData snapshot can make the
        // 24-30s GetDataFromClient polls retry forever; resolves on first live push.
        try { subscribeIdentityUpdates(); } catch (_:Dynamic) {}
        startConnect();
    }

    /** Keep ZFE's process-level watcher aligned with the active environment config. */
    function syncConfiguredZfeHotkey():Void {
        if (_api == null || _api.provider != FcmNativeApi.ZFE || _cfg == null) return;
        try {
            var raw = callTop("updateChatHotkey", _cfg.openKey);
            zfeLog("info", "input", "ZFE OpenChatKey synchronized key=" + _cfg.openKey
                + " raw=" + clip200(raw));
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "ZFE OpenChatKey synchronization failed: " + clip200(Std.string(e)));
        }
    }

    function startOwnedHotkeys():Void {
        stopOwnedHotkeys();
        if (_disposed || _api == null || _api.provider != FcmNativeApi.ZFE
                || !_api.supportsOwnedHotkeys()) return;
        var tokens = [_cfg.openKey, _cfg.hideKey, _cfg.channelNextKey, _cfg.channelPrevKey,
            _cfg.scrollUpKey, _cfg.scrollDownKey, _cfg.scrollBottomKey, _cfg.activateLinkKey];
        for (token in tokens) {
            var key = FcmZfeHotkeys.keyName(token);
            var code = FcmCommand.virtualKeyCode(token);
            if (key.length == 0 || code <= 0 || _ownedHotkeyCodes.indexOf(code) >= 0) continue;
            try {
                var result = FcmZfeHotkeys.registration(_api.call("hotkeys.v1.register",
                    FcmZfeHotkeys.registerPayload(VENDOR, key)));
                if (result.success) {
                    _ownedHotkeys.push({registration:result.registration, keyCode:code});
                    _ownedHotkeyCodes.push(code);
                }
            } catch (e:Dynamic) {
                zfeLog("warn", "input", "hotkeys.v1.register failed key=" + key
                    + " error=" + clip200(Std.string(e)));
            }
        }
        if (_ownedHotkeys.length == 0) return;
        _ownedHotkeyTimer = new flash.utils.Timer(OWNED_HOTKEY_POLL_MS);
        _ownedHotkeyTimer.addEventListener(TimerEvent.TIMER, function(_) { pollOwnedHotkeysSafely(); });
        _ownedHotkeyTimer.start();
        zfeLog("info", "input", "owner-scoped configured hotkeys ready keys="
            + _ownedHotkeyCodes.join(","));
    }

    function pollOwnedHotkeysSafely():Void {
        if (_disposed || _api == null) return;
        try {
            for (entry in _ownedHotkeys) {
                var registration = Reflect.field(entry, "registration");
                var presses = FcmZfeHotkeys.presses(_api.call("hotkeys.v1.poll",
                    FcmZfeHotkeys.tokenPayload(VENDOR, registration)), registration);
                if (presses < 0) {
                    zfeLog("warn", "input", "hotkeys.v1.poll rejected key=" + entry.keyCode
                        + "; stopping owner-scoped hotkeys");
                    stopOwnedHotkeys();
                    return;
                }
                if (presses > 0) dispatchOwnedHotkey(Std.int(Reflect.field(entry, "keyCode")));
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "input", "hotkeys.v1.poll failed: " + clip200(Std.string(e)));
            stopOwnedHotkeys();
        }
    }

    function dispatchOwnedHotkey(keyCode:Int):Void {
        if (keyCode == FcmCommand.virtualKeyCode(_cfg.openKey)) {
            if (!_inputOpen && isValidHUDMode()
                    && (_connected || !(_outboxIdentity.length == 0 || _needsLink))) openInput();
            return;
        }
        var action = FcmCommand.virtualKeyCode(_cfg.hideKey) == keyCode ? _cfg.hideKey
            : FcmCommand.virtualKeyCode(_cfg.activateLinkKey) == keyCode ? _cfg.activateLinkKey
            : FcmCommand.virtualKeyCode(_cfg.channelNextKey) == keyCode ? _cfg.channelNextKey
            : FcmCommand.virtualKeyCode(_cfg.channelPrevKey) == keyCode ? _cfg.channelPrevKey
            : FcmCommand.physicalNavigationAction(keyCode,
                _cfg.scrollUpKey, _cfg.scrollDownKey, _cfg.scrollBottomKey);
        if (action.length == 0) return;
        handleUserEvent(action, true);
        handleUserEvent(action, false);
    }

    function stopOwnedHotkeys():Void {
        if (_ownedHotkeyTimer != null) { _ownedHotkeyTimer.stop(); _ownedHotkeyTimer = null; }
        if (_api != null) for (entry in _ownedHotkeys) try {
            _api.call("hotkeys.v1.unregister", FcmZfeHotkeys.tokenPayload(VENDOR,
                Reflect.field(entry, "registration")));
        } catch (_:Dynamic) {}
        _ownedHotkeys = [];
        _ownedHotkeyCodes = [];
    }

    // =========================================================================
    // chat.v1 connect / reconnect
    // =========================================================================

    function resetFalloutIdentity():Void {
        _falloutIdentityReady = false;
        _displayName = "Wanderer";
        _ownCosmeticsKnown = false;
        _ownNameColor = "";
        _ownTag = "";
        _ownSupporterStar = false;
        _ownStarColor = "";
    }

    function startConnect():Void {
        if (_disposed) return;
        stopBrowser();
        resetFalloutIdentity();
        if (_api == null) return;
        _connectAttempts++;
        _connectStartedAt = flash.Lib.getTimer();
        _zfeAuthGraceLogged = false;
        _canRetryHudSend = false;
        _canSendRoomDiagnostics = false;
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
        if (_outboxIdentity.length > 0 && !_needsLink) outboxStatus("Reconnecting to chat...");
        else setLogText("connecting...");

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
        _consecutivePollFailures = 0;
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
        retainServerRecords("relay connection");
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
        _queueLossDiagnosticCount = 0;
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
        stopBrowser();
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
        if (_outboxIdentity.length == 0 || _needsLink) stopOpenKeyTimer();
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
        clearOutbox();
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
        // After LINK COMPLETE the relay identity is now linked, but the HUD's
        // _outboxIdentity may still be empty (limited identity never set it).
        // Lazily seed it from known aliases so the next send is not blocked
        // with "outboxIdLen=0" while we wait for the next getAuthState poll.
        if (_outboxIdentity.length == 0) {
            var seed:String = _linkedUserId.length > 0 ? _linkedUserId : (_relayUserId.length > 0 ? _relayUserId : _userId);
            if (seed.length > 0) {
                _outboxIdentity = seed;
            }
        }
        // Promptly refresh authState so _linkedUserId/_authState become authoritative;
        // Do not wait for the next normal auth poll after a live link.
        try { refreshAuthState(); } catch (_:Dynamic) {}
        // A RESYNC attempted while the identity was still limited is rejected by
        // the relay. Re-arm the bounded recovery state and schedule a fresh request
        // now that LINK COMPLETE proves the account transition.
        _history.authenticationChanged();
        scheduleHistoryResyncFallback();
        // Re-render to drop the link screen immediately.
        try { renderRecords(); } catch (_:Dynamic) {}
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
        stopBrowser();
        if (_disposed) return;
        if (_connectTimer != null) return;
        _connectTimer = new Timer(_connectDelay, 1);
        _connectTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_) {
            _connectTimer = null;
            _connectDelay = Std.int(Math.min(_connectDelay * 2, CONNECT_MAX_MS));
            runStartConnectSafely();
        });
        _connectTimer.start();
        if (_outboxIdentity.length > 0 && !_needsLink) {
            renderRecords();
            outboxStatus("Reconnecting in " + Std.int(_connectDelay / 1000) + "s; queued messages will retry.");
        } else setLogText("retrying in " + Std.int(_connectDelay / 1000) + "s...");
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
            var authEnvelope:Dynamic = FcmJson.parse(state);
            if (authEnvelope == null || Reflect.field(authEnvelope, "success") == false) {
                if (!FcmReconnect.pendingAllowed(_connectStartedAt, flash.Lib.getTimer())) forceReconnect("auth response unavailable");
                return;
            }
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
                _ownNameColor = "";
                _ownTag = "";
                _ownSupporterStar = false;
                _ownStarColor = "";
            }
            _canRetryHudSend = extractJsonBool(state, "canRetryHudSend");
            _canSendRoomDiagnostics = extractJsonBool(state, "canSendRoomDiagnostics");
            if (authDecision == FcmAuthFlow.AUTHENTICATED) {
                var identity = linkedUid.length > 0 ? linkedUid : uid;
                if (_outboxIdentity.length > 0 && identity.length > 0 && identity != _outboxIdentity) clearOutbox();
                if (identity.length > 0) _outboxIdentity = identity;
            }
            _hudLayoutSupported = extractJsonBool(state, "canSaveHudLayout");
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
                renderSubTabs();
            }
            if (authDecision == FcmAuthFlow.AUTHENTICATED) {
                // xScal may complete its worker-side handshake after the initial bounded
                // warm-up has elapsed. Restart that drain once at the transition, not on every
                // steady-state poll, so delayed subscribe history is still prompt and bounded.
                if (becameAuthenticated && _api.provider == FcmNativeApi.XSCAL) {
                    startXscalWarmup();
                }
                syncHudLayout();
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
                if (!FcmReconnect.pendingAllowed(_connectStartedAt, flash.Lib.getTimer())) forceReconnect("authentication handshake timed out");
                else setLogText("connecting to chat...");
            } else if (_authState != "authenticated" && _connected) {
                // ZFE's native handshake completes asynchronously after transport
                // connect, like xScal's worker handshake above: a non-authenticated
                // reading inside the handshake window is an in-flight connection,
                // not a dead session. Tearing it down restarts the very handshake
                // being awaited, which wedges boot in a reconnect loop (every poll
                // reconnects ~3s after the previous connect). Grant the same
                // pending grace xScal gets; past the window, downgrade to limited
                // (usable transport + link gate) instead of looping forever.
                // Genuinely dead transports still recycle via the poll-failure
                // threshold path, and a late authentication is picked up by the
                // becameAuthenticated transition above.
                if (FcmReconnect.pendingAllowed(_connectStartedAt, flash.Lib.getTimer())) {
                    // Only paint over an empty feed; never blank rendered rows or
                    // the link screen for a transitional reading.
                    var hasContent:Bool = false;
                    try { hasContent = _records.length > 0; } catch (_:Dynamic) {}
                    if (!hasContent) setLogText("connecting to chat...");
                } else if (!_zfeAuthGraceLogged) {
                    _zfeAuthGraceLogged = true;
                    zfeLog("warn", "auth", "ZFE auth never established; continuing limited");
                    try { renderRecords(); } catch (_:Dynamic) {}
                }
            }
        } catch (e:Dynamic) {
            zfeLog("warn", "auth", "getAuthState threw: " + Std.string(e));
            if (_connected && !FcmReconnect.pendingAllowed(_connectStartedAt, flash.Lib.getTimer())) forceReconnect("auth probe failed");
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
        // xScal has no ZFE isChatKeyPressed command. Its configured open key is
        // handled by the physical Input.* poll that starts at provider discovery.
        if (_disposed || _api == null || _api.provider != FcmNativeApi.ZFE
                || (!_connected && (_outboxIdentity.length == 0 || _needsLink))) return;
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
     * bridge. Both providers poll the configured FCMChat.ini openKey here.
     * Registration does not consume a key or lock Fallout controls.
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

        // Register exactly the active profile. stopPhysicalNavigation() releases every
        // previous registration before this set is installed, so a changed binding cannot
        // remain live through the provider-level physical fallback.
        var keyCodes:Array<Int> = [];
        for (token in [_cfg.channelNextKey, _cfg.channelPrevKey,
                _cfg.scrollUpKey, _cfg.scrollDownKey, _cfg.scrollBottomKey,
                _cfg.activateLinkKey, _cfg.hideKey]) {
            var configuredCode:Int = FcmCommand.virtualKeyCode(token);
            if (configuredCode == 0x0D && token == _cfg.activateLinkKey) continue;
            if (configuredCode > 0 && keyCodes.indexOf(configuredCode) < 0) keyCodes.push(configuredCode);
        }
        // ZFE's native OpenChatKey vocabulary is narrower than Input.* (for example,
        // updateChatHotkey rejects F12). Register the configured open key through the
        // shared physical surface for both providers; ZFE's native watcher remains a
        // compatibility fallback for the named tokens it accepts.
        _physicalOpenKey = FcmCommand.virtualKeyCode(_cfg.openKey);
        _physicalOpenKeyDown = false;
        if (_physicalOpenKey > 0 && keyCodes.indexOf(_physicalOpenKey) < 0) {
            keyCodes.push(_physicalOpenKey);
        }
        for (keyCode in keyCodes) {
            // ZFE's owner hotkey may miss a physical keyboard press while the game is
            // in controller mode. Keep the open key on Input.* as an independent edge
            // source; _inputOpen prevents either source from opening a second editor.
            if (_ownedHotkeyCodes.indexOf(keyCode) >= 0 && keyCode != _physicalOpenKey) continue;
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
            + _physicalNavRegistered.join(",") + " openKey=" + _physicalOpenKey
            + " scrollUp=" + _cfg.scrollUpKey + " scrollDown=" + _cfg.scrollDownKey
            + " scrollBottom=" + (_cfg.scrollBottomKey.length > 0 ? _cfg.scrollBottomKey : "<unset>")
            + " activateLink=" + _cfg.activateLinkKey
            + " hideKey=" + (_cfg.hideKey.length > 0 ? _cfg.hideKey : "<unset>"));
    }

    var _physicalNavStep:String = "idle";

    function runPhysicalNavigationSafely():Void {
        if (_disposed) return;
        try {
            pollPhysicalNavigation();
        } catch (e:Dynamic) {
            // A target-build Input.* or render failure must not escape a timer callback and
            // become another global UncaughtErrorEvent. Stop this optional fallback if its
            // boundary is unhealthy; named HUD actions remain available.
            zfeLog("warn", "input", "physical navigation timer isolated step=" + _physicalNavStep
                + " via=" + _api.inputDispatcherName + " raw=" + clip200(_api.lastInputResponse)
                + ": " + clip200(Std.string(e)));
            stopPhysicalNavigation();
        }
    }

    function pollPhysicalNavigation():Void {
        _physicalNavStep = "input-owner";
        releaseInputForPipboy();
        if (_disposed || !_physicalNavReady || _api == null) return;
        if (_physicalOpenKey > 0
                && _physicalNavRegistered.indexOf(_physicalOpenKey) >= 0) {
            _physicalNavStep = "read-open-key-" + _physicalOpenKey;
            var openDown:Bool = _api.isPhysicalKeyPressed(_physicalOpenKey);
            if (openDown != _physicalOpenKeyDown) {
                _physicalOpenKeyDown = openDown;
                if (openDown && !_inputOpen
                        && (_connected || !(_outboxIdentity.length == 0 || _needsLink))) {
                    zfeLog("info", "nativein", _api.provider + " physical openKey edge key=" + _physicalOpenKey);
                    openInput();
                }
            }
        }
        for (keyCode in _physicalNavRegistered) {
            if (keyCode == _physicalOpenKey) continue;
            // Page keys switch channels in either state. Configured feed keys remain ordinary
            // game controls until the player has opened the editor with Insert.
            var isPhysicalHide:Bool = FcmCommand.virtualKeyCode(_cfg.hideKey) == keyCode;
            var isPhysicalLink:Bool = FcmCommand.virtualKeyCode(_cfg.activateLinkKey) == keyCode;
            var action:String = isPhysicalHide ? _cfg.hideKey
                : isPhysicalLink ? _cfg.activateLinkKey
                : FcmCommand.virtualKeyCode(_cfg.channelNextKey) == keyCode ? _cfg.channelNextKey
                : FcmCommand.virtualKeyCode(_cfg.channelPrevKey) == keyCode ? _cfg.channelPrevKey
                : FcmCommand.physicalNavigationAction(keyCode,
                    _cfg.scrollUpKey, _cfg.scrollDownKey, _cfg.scrollBottomKey);
            if (action.length == 0) continue;
            var command:String = FcmCommand.navigationAction(action,
                _cfg.channelNextKey, _cfg.channelPrevKey,
                _cfg.scrollUpKey, _cfg.scrollDownKey, _cfg.scrollBottomKey);
            _physicalNavStep = "read-key-" + keyCode;
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
                _physicalNavStep = "dispatch-key-" + keyCode;
                var handled:Bool = handleUserEvent(action, true);
                if (command.length > 0 || isPhysicalHide || isPhysicalLink) {
                    zfeLog("info", "input", "physical key=" + keyCode + " action=" + action
                        + " edge=down command=" + (isPhysicalHide ? "hide" : isPhysicalLink ? "activate-link" : command)
                        + " handled=" + (handled ? "true" : "false"));
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
        _physicalOpenKey = 0;
        _physicalOpenKeyDown = false;
    }

    /** Open chat on a false->true edge of isChatKeyPressed. */
    function pollOpenKey():Void {
        releaseInputForPipboy();
        if (_api == null || _api.provider != FcmNativeApi.ZFE
                || (!_connected && (_outboxIdentity.length == 0 || _needsLink))) return;
        try {
            // The OpenChatKey is the one configured key exposed by the top-level ZFE chat
            // helper. Other physical navigation keys use the provider Input.* fallback above.
            // On its rising edge, open chat when closed. Slash (/g /t /e /i /r) covers direct
            // jumps + reverse. (Hidden: openInput() un-hides first.)
            var kp:Bool = nativeTruthy(callTop("isChatKeyPressed", "{}"));
            if (!isValidHUDMode()) {
                // Preserve the edge state while blocked so a key held in ContainerMode cannot
                // open chat immediately after Fallout returns to the ordinary HUD.
                _lastChatKey = kp;
                return;
            }
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
        if (_api != null && _api.provider == FcmNativeApi.ZFE && initialCount >= NATIVE_POLL_BATCH) {
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
            // while the provider returns full 16-event batches, with a hard attempt cap.
            if (count >= NATIVE_POLL_BATCH && _zfeInitialDrainAttempts < ZFE_INITIAL_DRAIN_MAX) {
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
                var queuedRequestId:Int = _api.provider == FcmNativeApi.ZFE
                    ? FcmWire.queuedRequestId(raw) : 0;
                if (queuedRequestId > 0) {
                    _zfePendingControls.set(queuedRequestId, "history");
                    scheduleEchoPoll();
                }
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
        // Both providers can finish their handshake after connect returns. ZFE must
        // refresh its pending identity without requiring the user to send a message.
        // Keep xScal's continuous status checks; settled ZFE avoids redundant auth
        // reads during history-drain bursts. This reads provider-local auth state.
        if (_api.provider == FcmNativeApi.XSCAL
                || _authState != "authenticated" || _relayUserId.length == 0) {
            _eventPollPhase = "auth-refresh";
            refreshAuthState();
            if (!_connected) return 0;
        }
        _eventPollPhase = "history-resync";
        maybeRequestHistoryResync();
        _eventPollPhase = "poll-call";
        // Mitigation C: chunk xScal drain to avoid ~1s UI stalls — request 16 per tick,
        // chain immediate next-tick polls while full batches arrive (covers 64 snapshot over 4 turns)
        var payload:String = '{"max":' + NATIVE_POLL_BATCH + ',"cursor":' + _cursor + '}';
        var tPollStart:Float = flash.Lib.getTimer();
        var result:Dynamic = null;
        try {
            result = _api.call("chat.v1.pollEvents", payload);
        } catch (e:Dynamic) {
            zfeLog("warn", "poll", "call threw: " + Std.string(e));
            notePollFailure("call threw");
            return 0;
        }
        var pollDt:Float = flash.Lib.getTimer() - tPollStart;
        if (pollDt > 50) zfeLog("info", "poll", "poll dt=" + pollDt + "ms");

        _eventPollPhase = "response";
        var rs:String = Std.string(result);
        if (rs.indexOf('"success":false') >= 0 || rs.indexOf('success:false') >= 0) {
            if (rs.indexOf('auth_token_invalid') >= 0 || rs.indexOf('auth_token_revoked') >= 0
                    || rs.indexOf('user_banned') >= 0) {
                forceReconnect("relay returned an auth error on poll");
            } else if (_api.provider == FcmNativeApi.XSCAL
                    && FcmAuthFlow.isPendingTransportResponse(rs)
                    && FcmReconnect.pendingAllowed(_connectStartedAt, flash.Lib.getTimer())) {
                // The xScal worker has not opened its subscriber yet. This is
                // expected while connect() reports status=connecting; do not
                // spend the poll-failure budget or restart the worker.
                return 0;
            } else {
                notePollFailure("relay returned an unsuccessful response");
            }
            return 0;
        }

        if (!FcmReconnect.validPoll(rs)) {
            notePollFailure("malformed poll response");
            return 0;
        }
        _consecutivePollFailures = 0;
        _eventPollPhase = "render";
        var tRenderStart:Float = flash.Lib.getTimer();
        var parsed:Int = parseAndRenderEvents(rs);
        var renderDt:Float = flash.Lib.getTimer() - tRenderStart;
        if (renderDt > 30) zfeLog("info", "poll", "render dt=" + renderDt + "ms events=" + parsed);
        flushOutbox();
        _eventPollPhase = "complete";
        // Mitigation C: if xScal drain returned a full 16-batch, chain an immediate next-tick poll to keep draining without stalling a full 64 in one turn
        if (parsed >= 16 && !_disposed && _connected) {
            var chunk:Timer = new Timer(1, 1);
            chunk.addEventListener(TimerEvent.TIMER_COMPLETE, function(_:Dynamic) {
                try { if (!_disposed) runEventPollSafely(); } catch (_:Dynamic) {}
            });
            chunk.start();
        }
        return parsed;
    }

    /** Reconnect instead of leaving the HUD in a permanently stale "connected" state. */
    function notePollFailure(reason:String):Void {
        _consecutivePollFailures++;
        zfeLog("warn", "poll", "failure=" + _consecutivePollFailures + " reason=" + reason);
        if (_consecutivePollFailures < 3) return;
        forceReconnect("poll failure threshold reached");
    }

    function parseAndRenderEvents(rs:String, allowServerDeferral:Bool = true):Int {
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
        var wireNameColorCount:Int = 0;
        var carrierNameColorCount:Int = 0;
        var wireTagCount:Int = 0;
        var wireTransportCount:Int = 0;
        var wireMessageIdCount:Int = 0;
        var wireTransportMessageIdCount:Int = 0;
        var wireSenderIdCount:Int = 0;
        var ownEchoMatchedCount:Int = 0;
        var ownEchoIdMatchCount:Int = 0;
        var ownEchoFallbackMatchCount:Int = 0;
        var ownEchoAmbiguousCount:Int = 0;
        var appendedCount:Int = 0;
        var duplicateRejectedCount:Int = 0;
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
                var cursorBefore:Int = _cursor;
                var unreadGap:Bool = FcmWire.droppedMarkerHasUnreadGap(obj, cursorBefore);
                updateCursorFromEvent(obj);
                parsedCount++;
                if (unreadGap) {
                    droppedCount++;
                    _history.dropped = true;
                }
                // A lifetime cap retains privacy-safe evidence for both acknowledged native
                // retirement and true forward gaps without flooding the provider log.
                if (_queueLossDiagnosticCount < 3) {
                    _queueLossDiagnosticCount++;
                    try {
                        zfeLog("info", "queue-loss", "queue-loss diagnostic=" + _queueLossDiagnosticCount
                            + " before=" + cursorBefore + " after=" + _cursor
                            + " unreadGap=" + (unreadGap ? "1" : "0")
                            + " marker[" + FcmWire.queueLossSummary(obj) + "]"
                            + " envelope[" + FcmWire.queueLossSummary(rs) + "]");
                    } catch (_:Dynamic) {} // Diagnostics cannot interrupt normal recovery.
                }
                continue;
            }

            var asyncCompletion:Int = FcmWire.asyncSendCompletion(obj);
            if (asyncCompletion != 0) {
                updateCursorFromEvent(obj);
                parsedCount++;
                applyZfeAsyncCompletion(obj, asyncCompletion > 0);
                continue;
            }

            var isChatEditEvent:Bool = extractJsonString(obj, "kind") == "chat.edit";
            if (obj.indexOf('"chat.message"') < 0 && obj.indexOf('chat.message') < 0 && !isChatEditEvent) {
                updateCursorFromEvent(obj);
                continue;
            }

            var rawChannel:String   = extractJsonString(obj, "channel");
            var channel:String      = normChannel(rawChannel);
            var senderUserId:String = extractJsonString(obj, "senderUserId");
            var displayName:String  = extractJsonString(obj, "senderDisplayName");
            var tag:String          = extractJsonString(obj, "tag");
            var nameColor:String    = extractJsonString(obj, "nameColor");
            var starColor:String    = extractJsonString(obj, "starColor");
            // ZFE's native chat bridge strips unknown additive members. The relay
            // therefore mirrors cosmetics into targetUserId for widget builds that
            // negotiated the FCMHUD/1 transport. targetUserId is empty for ordinary
            // channel messages and is never used as a real recipient here.
            var hudTransport:String = extractJsonString(obj, "targetUserId");
            var transportTag:String = FcmConfig.hudTransportTag(hudTransport);
            var transportStarColor:String = FcmConfig.hudTransportStarColor(hudTransport);
            var transportNameColor = FcmConfig.hudTransportNameColor(hudTransport);
            var transportLinkUrl:String = FcmConfig.hudTransportValue(hudTransport, "u");
            if (!FcmLink.validHttpUrl(transportLinkUrl)) transportLinkUrl = "";
            if (transportNameColor.length > 0) { nameColor = transportNameColor; carrierNameColorCount++; }
            if (FcmConfig.parseHexColor(nameColor, -1) >= 0) wireNameColorCount++;
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
            // extractJsonString deliberately preserves transport escapes. Chat text must be
            // decoded exactly once before control checks, optimistic-echo matching, and display;
            // otherwise `"quoted"` local sends compare against `\"quoted\"` authoritative
            // events and both rows remain in the feed.
            var body:String         = FcmConfig.decodeJsonText(extractJsonString(obj, "body"));
            if (rawChannel == "system" && senderUserId == "system" && StringTools.startsWith(body, "FCMACK/1;")) {
                updateCursorFromEvent(obj);
                acceptOutboxReceipt(body);
                continue; // Private delivery receipts never appear as public chat.
            }
            if (rawChannel == "system" && senderUserId == "system" && StringTools.startsWith(body, "FCMLAYOUT/1;")) {
                updateCursorFromEvent(obj);
                if (_api != null && _api.provider == FcmNativeApi.XSCAL && _hudLayout.accept(body, _cfg)) {
                    _autoHideOn = _cfg.autoHideActive();
                    rebuildPanel();
                    if (!_autoHideOn && _autoHidden && !_manuallyHidden) show();
                    bumpAutoHide();
                }
                continue; // Private settings are never rendered as chat or interpreted as a link notice.
            }
            if (rawChannel == "system" && senderUserId == "system"
                    && StringTools.startsWith(body, FcmServerSession.READY_PREFIX)) {
                updateCursorFromEvent(obj);
                var previousRoom = _serverSession.room;
                if (_inWorld && !_serverAtMainMenu && _serverSession.accept(body, flash.Lib.getTimer())) {
                    if (previousRoom != _serverSession.room) retainServerRecords("confirmed room changed");
                    setServerSessionReady(true, "");
                    var pending = _serverSession.takePending();
                    if (pending.length > 0) parseAndRenderEvents('{"events":[' + pending.join(",") + ']}', false);
                    startServerHistoryDrain();
                    zfeLog("info", "world", "relay confirmed room=" + _serverSession.room);
                } else zfeLog("info", "world", "ignored stale server confirmation");
                continue;
            }
            if (channel == "server" && !_serverSessionReady) {
                if (allowServerDeferral) _serverSession.defer(obj);
                updateCursorFromEvent(obj);
                continue; // Validate queued rows against the next confirmed room before rendering.
            }
            if (rawChannel == "system" && senderUserId == "system" && body == "FCMCTL/1/HISTORY-DONE") {
                updateCursorFromEvent(obj);
                _history.finish();
                stopHistoryResyncFallback();
                zfeLog("info", "history", "replay completed");
                continue;
            }
            // Preserve raw emoji identifiers for rendering and echo reconciliation.
            var displayBody:String  = body;
            var messageId:String    = extractJsonString(obj, "messageId");
            var transportMessageId:String = FcmConfig.hudTransportMessageId(hudTransport);
            if (transportMessageId.length > 0) messageId = transportMessageId;
            var historyRoom:String = FcmConfig.hudTransportValue(hudTransport, "h");
            var serverReplay:Bool = channel == "server" && historyRoom.length > 0;
            var createdAt:String = extractJsonString(obj, "createdAt");
            if (channel == "server" && !_serverSession.acceptsMessage(messageId, historyRoom)) {
                if (allowServerDeferral) _serverSession.defer(obj);
                updateCursorFromEvent(obj);
                if (!allowServerDeferral) zfeLog("info", "world", "discarded server row outside confirmed room");
                continue;
            }
            var evId:Int            = extractJsonInt(obj, "id");
            if (senderUserId.length > 0) wireSenderIdCount++;
            if (messageId.length > 0) wireMessageIdCount++;
            if (transportMessageId.length > 0) wireTransportMessageIdCount++;

            // Always advance the cursor, even for skipped/deduped events.
            if (evId > _cursor) _cursor = evId;
            parsedCount++;
            if (body.length == 0) continue;

            // Scheduled-event lifecycle updates are delivered as chat.edit frames
            // with the same durable message ID as the original compact event row.
            // Replace that row in place so a connected HUD never accumulates stale
            // Upcoming/Live/Ended/Canceled copies. The event code is a secondary
            // identity when the compact 70-character line has room for it.
            var eventEditAccepted:Bool = false;
            if (isChatEditEvent && displayName == "[EVENT] FCM") {
                eventEditAccepted = markSeenEventUpdate(channel, evId);
                if (!eventEditAccepted) continue;
                if (replaceHudEventRecord(channel, messageId, body, displayName, tag,
                        nameColor, starColor, supporterStar)) {
                    newRecords = true;
                    continue;
                }
            }

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

            // Store each source message once before projecting it into General or its tab.
            // A replay must be rejected BEFORE matching a newer same-text pending send.
            if (CHAN_SLUGS.indexOf(channel) < 0) continue;
            if (!eventEditAccepted && !markSeenEvent(channel, evId, messageId)) {
                duplicateRejectedCount++;
                continue;
            }

            // Reconcile a pending self-send in place. The relay is the source of truth for
            // cosmetics, but appending a second canonical row would duplicate the message when
            // the event arrives after the optimistic row.
            if (reconcileOwnEcho(messageId, senderUserId, channel, body, displayName, tag,
                    supporterStar, starColor, nameColor, createdAt, serverReplay)) {
                ownEchoMatchedCount++;
                if (_lastEchoMatchMode == "id") ownEchoIdMatchCount++;
                else ownEchoFallbackMatchCount++;
                newRecords = true;
                continue;
            }
            if (_lastEchoMatchMode == "ambiguous") ownEchoAmbiguousCount++;

            // Store ALL known channels (renderRecords filters to the active tab).
            // The old active-channel ingest filter silently discarded every other
            // channel's one-shot subscribe backfill — history looked empty on
            // Trading/Events/Raids/Infests forever after connect.
            appendedCount++;

            _records.push({
                color: FcmConfig.parseHexColor(nameColor, -1) >= 0 ? nameColor : "", channel: channel, user: displayName,
                tag: tag, supporterStar: supporterStar, starColor: starColor, body: displayBody,
                messageId: messageId, senderUserId: senderUserId, pending: false,
                localSendId: "", pendingAt: 0, sendAccepted: false, linkUrl: transportLinkUrl,
                createdAt: createdAt, arrivalOrder: _nextRecordOrder++, serverReplay: serverReplay,
            });
            while (_records.length > _cfg.maxMessages) _records.shift();
            if (_bScrolling && FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], channel)) _newWhileScrolled++;
            newRecords = true;
        }

        if (parsedCount > 0) zfeLog("info", "recv", "events=" + parsedCount + " cursor=" + _cursor
            + " newRecords=" + (newRecords ? "y" : "n")
            + " dropped=" + droppedCount
            + " wireNameColors=" + wireNameColorCount + " carrierNameColors=" + carrierNameColorCount
            + " wireStars=" + wireStarCount + " wireStarColors=" + wireStarColorCount
            + " wireTags=" + wireTagCount + " wireTransport=" + wireTransportCount
            + " wireMessageIds=" + wireMessageIdCount
            + " wireTransportIds=" + wireTransportMessageIdCount
            + " wireSenderIds=" + wireSenderIdCount
            + " ownEchoMatched=" + ownEchoMatchedCount
            + " ownEchoId=" + ownEchoIdMatchCount
            + " ownEchoFallback=" + ownEchoFallbackMatchCount
            + " ownEchoAmbiguous=" + ownEchoAmbiguousCount
            + " appended=" + appendedCount + " duplicateRejected=" + duplicateRejectedCount
            + " recordsBefore=" + recordsBefore + " recordsAfter=" + _records.length);
        if (droppedCount > 0) {
            zfeLog("warn", "recv", "provider reported dropped events; cursor advanced without replay");
            scheduleHistoryResyncFallback();
        }
        seedOwnCosmeticsFromHistory();
        if (newRecords) {
            if (_autoHideOn && _autoHidden && !_manuallyHidden) show(); // only wake idle hiding
            requestRender();
            bumpAutoHide();                        // any new message counts as activity
        }
        return parsedCount;
    }

    /** Apply ZFE's terminal queue event. The initial sendMessage result only means queued. */
    function applyZfeAsyncCompletion(obj:String, accepted:Bool):Void {
        var requestId:Int = FcmWire.asyncRequestId(obj);
        if (requestId <= 0) return;

        if (_zfePendingSends.exists(requestId)) {
            var localSendId:String = _zfePendingSends.get(requestId);
            _zfePendingSends.remove(requestId);
            var entry = _outbox.get(localSendId);
            if (entry == null) return;
            if (accepted) {
                if (_needsLink) clearLinkGate("ZFE relay accepted send");
                zfeLog("info", "send", "relay accepted ch=" + entry.channel
                    + " requestId=" + requestId + "; awaiting durable echo");
                scheduleEchoPoll();
                return;
            }

            var code:String = FcmWire.asyncErrorCode(obj);
            zfeLog("warn", "send", "relay rejected requestId=" + requestId + " code=" + code);
            if (_canRetryHudSend && FcmOutbox.retryable(code)) {
                outboxStatus("Message queued - waiting to retry.");
                return;
            }
            _outbox.remove(localSendId);
            removeOptimisticRecord(localSendId);
            requestRender();
            switch (code) {
                case "permission_denied":
                    _needsLink = true;
                    setLogText(linkHint());
                case "message_blocked": setLogText("Message blocked by the chat filter.");
                case "slash_ignored": setLogText("Slash commands work in the dashboard, not in-game.");
                case "user_muted": setLogText("You are muted and cannot send right now.");
                case "rate_limited": setLogText("Sending too fast - slow down.");
                case "invalid_channel":
                    if (entry.channel == "server") setServerSessionReady(false, "invalid_channel");
                    setLogText(entry.channel == "server"
                        ? "Server chat is unavailable: invalid_channel"
                        : "That channel is not available.");
                case "message_too_long": setLogText("Message too long (max " + _cfg.maxSendLen + ").");
                case "auth_token_invalid", "auth_token_revoked", "user_banned":
                    setLogText("Chat session ended - reconnecting...");
                    if (_nativeInput) closeInputNative();
                    setServerSessionReady(false, "");
                    _connected = false;
                    stopPollTimer();
                    scheduleConnectRetry();
                default: setLogText(code.length > 0 ? ("Send failed: " + code) : "Send failed.");
            }
            return;
        }

        if (_zfePendingControls.exists(requestId)) {
            var source:String = _zfePendingControls.get(requestId);
            _zfePendingControls.remove(requestId);
            if (accepted) {
                zfeLog("info", "world", source + " relay accepted requestId=" + requestId
                    + "; awaiting terminal marker");
                return;
            }
            var code:String = FcmWire.asyncErrorCode(obj);
            zfeLog("warn", "world", source + " relay rejected requestId=" + requestId
                + " code=" + code);
            if (source == "roster" || source == "worldId") {
                setServerSessionReady(false, code.length > 0 ? code : "server session rejected");
                _lastRosterSentAt = 0;
            }
        }
    }

    /** Keep replay identity scoped to the feed whose records are retained. Backscroll fix: scan live _records so LRU-evicted messageIds don't re-append randomly. */
    function markSeenEvent(channel:String, eventId:Int, messageId:String):Bool {
        return _history.accept(channel, eventId, messageId,
            Std.int(Math.max(256, _cfg.maxMessages * 2)), _records);
    }

    /** Edits retain the message ID, so deduplicate their fresh relay cursor separately. */
    function markSeenEventUpdate(channel:String, eventId:Int):Bool {
        return _history.accept(channel, eventId, "",
            Std.int(Math.max(256, _cfg.maxMessages * 2)));
    }

    function eventCodeFromHudBody(body:String):String {
        var marker:String = "[EVT-";
        var start:Int = body.indexOf(marker);
        if (start < 0) return "";
        var end:Int = body.indexOf("]", start);
        if (end <= start) return "";
        return body.substring(start + 1, end);
    }

    /** Update one compact event row in place, matching by durable ID or visible event code. */
    function replaceHudEventRecord(channel:String, messageId:String, body:String,
            displayName:String, tag:String, nameColor:String, starColor:String,
            supporterStar:Bool):Bool {
        var eventCode:String = eventCodeFromHudBody(body);
        for (rec in _records) {
            if (rec.channel != channel) continue;
            var sameMessage:Bool = messageId.length > 0 && rec.messageId == messageId;
            var sameEventCode:Bool = eventCode.length > 0 && eventCodeFromHudBody(rec.body) == eventCode;
            if (!sameMessage && !sameEventCode) continue;
            rec.user = displayName;
            rec.tag = tag;
            rec.color = FcmConfig.parseHexColor(nameColor, -1) >= 0 ? nameColor : "";
            rec.starColor = starColor;
            rec.supporterStar = supporterStar;
            rec.body = body;
            if (messageId.length > 0) rec.messageId = messageId;
            return true;
        }
        return false;
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
        var id:String = "send-" + _sendNonce + "-" + _nextSendSequence;
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
            displayName:String, tag:String, supporterStar:Bool, starColor:String, nameColor:String = "",
            createdAt:String = "", serverReplay:Bool = false):Bool {
        _lastEchoMatchMode = "";
        var normalized:String = body;
        var pending:Array<FcmEcho.FcmPendingEcho> = [];
        for (i in 0..._records.length) {
            var pendingRecord:ChatRecord = _records[i];
            if (!pendingRecord.pending) continue;
            // An offline draft is not a sent event. History from another device with the
            // same body must never consume it. Retry-capable sends wait for exact receipt ID.
            var queuedEcho = _outbox.get(pendingRecord.localSendId);
            if (!FcmOutbox.canCorrelate(queuedEcho, pendingRecord.messageId, _canRetryHudSend)) continue;
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
        rec.color = FcmConfig.parseHexColor(nameColor, -1) >= 0 ? nameColor : "";
        _ownNameColor = rec.color;
        rec.tag = tag;
        rec.supporterStar = supporterStar;
        rec.starColor = starColor;
        rec.body = normalized;
        _outbox.remove(rec.localSendId);
        rec.pending = false;
        rec.localSendId = "";
        rec.pendingAt = 0;
        rec.sendAccepted = false;
        rec.createdAt = createdAt;
        rec.serverReplay = serverReplay;
        rememberOwnCosmetics(rec.tag, rec.supporterStar, rec.starColor, rec.color, rec.senderUserId);
        if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], channel)) requestRender();
        return true;
    }

    /** Store only server-resolved HUD cosmetics for the known local sender. */
    function rememberOwnCosmetics(tag:String, supporterStar:Bool, starColor:String,
            nameColor:String = "", senderUserId:String = ""):Void {
        _ownCosmeticsKnown = true;
        _ownTag = tag == null ? "" : tag;
        _ownSupporterStar = supporterStar;
        _ownStarColor = starColor == null ? "" : starColor;
        if (FcmConfig.parseHexColor(nameColor, -1) >= 0) _ownNameColor = nameColor;

        // History can arrive while authentication/cosmetic resolution is still warming.
        // Once an authoritative ACK or self-echo supplies the current projection, update
        // retained rows for the same authenticated identity just as a fresh backend history
        // fetch would. Never match by display name: another player can use the same name.
        for (rec in _records) {
            if (!isOwnSenderId(rec.senderUserId, senderUserId)) continue;
            rec.color = _ownNameColor;
            rec.tag = _ownTag;
            rec.supporterStar = _ownSupporterStar;
            rec.starColor = _ownStarColor;
        }
    }

    function isOwnSenderId(candidate:String, authoritative:String = ""):Bool {
        if (candidate == null || candidate.length == 0) return false;
        return (authoritative != null && authoritative.length > 0 && candidate == authoritative)
            || (_linkedUserId.length > 0 && candidate == _linkedUserId)
            || (_relayUserId.length > 0 && candidate == _relayUserId)
            || (_userId.length > 0 && candidate == _userId);
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
            rememberOwnCosmetics(candidate.tag, candidate.supporterStar, candidate.starColor,
                candidate.color, candidate.senderUserId);
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

    /** Keep command help in this widget's feed only; no relay or Discord publication. */
    function addPrivateGiveawayHelp():Void {
        var channel = CHAN_SLUGS[_chanIdx];
        var order = _nextRecordOrder++;
        _records.push({
            color: "", channel: channel, user: "FCM Help", tag: "", supporterStar: false,
            starColor: "", body: FcmCommand.giveawayHelp(), messageId: "", senderUserId: "",
            pending: false, localSendId: "giveaway-help-" + order, pendingAt: 0,
            sendAccepted: false, createdAt: FcmFeedPlan.utcTimestamp(Date.now()),
            arrivalOrder: order, serverReplay: false,
        });
        while (_records.length > _cfg.maxMessages) _records.shift();
        scrollToBottom();
        requestRender();
    }

    /** Paint a local send immediately; the ACK/event then replaces fallback cosmetics authoritatively. */
    function addOptimisticEcho(channel:String, body:String, messageId:String, tag:String,
            supporterStar:Bool, starColor:String, senderUserId:String, localSendId:String):Void {
        if (senderUserId == null) senderUserId = "";
        _records.push({
            color: _ownNameColor.length > 0 ? _ownNameColor : "", channel: channel, user: _displayName,
            tag: tag, supporterStar: supporterStar, starColor: starColor,
            body: body,
            messageId: messageId, senderUserId: senderUserId, pending: true,
            localSendId: localSendId, pendingAt: flash.Lib.getTimer(), sendAccepted: false,
            createdAt: "", arrivalOrder: _nextRecordOrder++, serverReplay: false,
        });
        while (_records.length > _cfg.maxMessages) _records.shift();
        if (_bScrolling && FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], channel)) _newWhileScrolled++;
        if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], channel)) requestRender();
    }

    /** Apply the ACK to the exact transaction row; no text/identity search occurs here. */
    function updateOptimisticRecord(localSendId:String, messageId:String, tag:String,
            supporterStar:Bool, starColor:String, cosmeticsKnown:Bool, nameColor:String = ""):Bool {
        if (messageId != null && messageId.length > 0) {
            for (existing in _records) if (!existing.pending && existing.messageId == messageId) {
                removeOptimisticRecord(localSendId);
                requestRender();
                return true;
            }
        }
        for (rec in _records) {
            if (!rec.pending || rec.localSendId != localSendId) continue;
            if (messageId != null && messageId.length > 0) rec.messageId = messageId;
            // Old Dev ACKs contain only {success:true}. Preserve the bounded
            // local snapshot until the authoritative live event arrives. New
            // ACKs carry FCMHUD/1 (or additive fields), so an explicit empty
            // projection is also respected when the user is not a supporter.
            if (cosmeticsKnown) {
                rec.color = FcmConfig.parseHexColor(nameColor, -1) >= 0 ? nameColor : "";
                rec.tag = tag;
                rec.supporterStar = supporterStar;
                rec.starColor = starColor;
                rememberOwnCosmetics(tag, supporterStar, starColor, rec.color, rec.senderUserId);
            }
            rec.sendAccepted = true;
            if (FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], rec.channel)) requestRender();
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
     * Apply native acceptance of a server-room control. Some bridges queue sends;
     * acceptance alone does not prove relay delivery or completion of history replay.
     */
    function applyServerControlResult(raw:String, source:String, readyOnSuccess:Bool = true):Bool {
        var ok:Bool = FcmWire.controlAccepted(raw);
        if (ok) {
            if (!readyOnSuccess) setServerSessionReady(false, "");
            var queuedRequestId:Int = _api != null && _api.provider == FcmNativeApi.ZFE
                ? FcmWire.queuedRequestId(raw) : 0;
            if (queuedRequestId > 0) {
                _zfePendingControls.set(queuedRequestId, source);
                scheduleEchoPoll();
                zfeLog("info", "world", source + " control queued requestId=" + queuedRequestId
                    + "; awaiting relay completion");
            } else {
                zfeLog("info", "world", source
                    + " control accepted by native transport; awaiting relay confirmation");
            }
            return true;
        }
        var message:String = extractJsonString(raw, "message");
        if (message.length == 0) message = extractJsonString(raw, "code");
        if (message.length == 0) message = "relay did not accept the server session";
        setServerSessionReady(false, message);
        zfeLog("warn", "world", source + " control rejected raw=" + clip200(raw));
        return false;
    }

    /** Best-effort transition evidence. Fixed enums prevent names, messages, IDs or tokens entering the payload. */
    function sendRoomDiagnostic(event:String, source:String, rosterCount:Int):Void {
        if (_api == null || !_connected || _authState != "authenticated" || _needsLink
                || !_canSendRoomDiagnostics
                || !_api.supportsNonBlockingControl() || _roomDiagnosticCount >= MAX_ROOM_DIAGNOSTICS) return;
        if (source == null || source.length == 0) source = "none";
        var body = FcmDiagnostics.roomControl(event, _api.provider, source, rosterCount, VERSION);
        if (body.length == 0 || body == _lastRoomDiagnosticBody) return;
        var payload = '{"channel":"server","targetUserId":"' + _serverSession.target()
            + '","body":"' + body + '"}';
        try {
            var raw = Std.string(_api.call("chat.v1.sendMessage", payload));
            if (FcmWire.controlAccepted(raw)) {
                _lastRoomDiagnosticBody = body;
                _roomDiagnosticCount++;
            }
        } catch (_:Dynamic) {} // Diagnostics can never change room state or interrupt the HUD.
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

    /** Prefer fresh world-wide player snapshots over auxiliary nearby/team lists. */
    function freshRosterNames():Array<String> {
        return _rosterSnapshots.sessionNames(flash.Lib.getTimer(), ROSTER_FRESH_MS, _lastRosterSent);
    }

    /** Reset room-scoped deduplication while retaining accepted SERVER rows for
     *  the lifetime of this widget instance. New delivery remains bound to the
     *  current confirmed room; retained rows are display-only session history. */
    function retainServerRecords(reason:String):Void {
        _history.clearServer();
        var retained:Int = 0;
        for (rec in _records) if (rec.channel == "server") retained++;
        zfeLog("info", "history", "retained server session rows=" + retained + " reason=" + reason);
    }

    /** Roster-derived world membership: send while observations are fresh. The SERVER tab is
     *  driven by the relay acknowledgement, not by this local observation. */
    function tickRoster():Void {
        if (_api == null || !_connected || _relayUserId.length == 0) return;
        // Older ZFE builds execute roster/leave controls synchronously on Fallout's
        // Scaleform thread and can freeze it for the native timeout. Current ZFE advertises
        // a dedicated async-control contract; xScal's chatInterface is non-blocking by
        // contract. Gate the behavior, not the provider name.
        if (!_api.supportsNonBlockingControl()) return;
        // An unlinked account cannot be admitted to the server room. In particular, do not
        // keep issuing synchronous roster calls while the one-shot link notice is being shown.
        if (_needsLink || _authState != "authenticated") return;
        var now:Float = flash.Lib.getTimer();
        _worldPollPhase = "roster-snapshots";
        if (_serverSessionReady && !_serverSession.fresh(now)) {
            setServerSessionReady(false, "server confirmation expired");
            retainServerRecords("server confirmation expired");
            _lastRosterSentAt = 0;
        }
        var names:Array<String> = freshRosterNames();
        _worldPollPhase = "roster-binding";
        var wasInWorld:Bool = _inWorld;
        // Main-menu state is checked before reading these cached HUD observations.
        // An empty roster permits a solo session; it does not prove an empty world.
        var rosterObserved:Bool = hasFreshRosterObservation(now);
        _inWorld = (names.length > 0 || rosterObserved);
        if (_inWorld) {
            // Loading can briefly blank even the primary roster. Preserve the current room
            // while it recovers, without sending an empty roster or extending the relay lease.
            if (_rosterSnapshots.waitForRoster(_lastRosterSent, names, now, ROSTER_FRESH_MS)) {
                sendRoomDiagnostic("roster_hold",
                    _rosterSnapshots.sessionSource(now, ROSTER_FRESH_MS, _lastRosterSent), names.length);
                return;
            }
            var namesField:String = names.join("|");
            // A roster replacement with no shared name is the only reliable world-hop signal
            // available from the approved HUD data surfaces. The relay may otherwise compute
            // the same room key and keep this subscriber on the previous server feed. Leave
            // first, retain the local session transcript, then let the next tick submit the new roster;
            // the fresh bind triggers the existing server-history backfill.
            // Keep the prior roster comparison even if the relay lease just expired and
            // reset the send timestamp; a permanent empty must still leave the old room.
            if (FcmCommand.shouldRebindRosterSession(_lastRosterSent, namesField)) {
                sendRoomDiagnostic("roster_boundary",
                    _rosterSnapshots.sessionSource(now, ROSTER_FRESH_MS, namesField), names.length);
                zfeLog("info", "world", "roster session changed; retaining transcript and rebinding");
                retainServerRecords("roster session changed");
                setServerSessionReady(false, "");
                _lastRosterSentAt = 0;
                _lastRosterSent = "";
                sendWorldLeaveControl();
                resetRosterObservation("roster boundary");
                return;
            }
            var hasSentRoster:Bool = _lastRosterSentAt > 0;
            if (FcmCommand.shouldSendRoster(true, _serverSessionReady,
                    now - _lastRosterSentAt, hasSentRoster)) {
                _lastRosterSentAt = now;
                _lastRosterSent = namesField;
                var aliases:Array<String> = rosterSelfAliases();
                var body:String = FcmCommand.rosterControlBody(aliases, namesField);
                if (body.length == 0) return;
                var payload:String = '{"channel":"server","targetUserId":"' + _serverSession.target() + '","body":"' + jsonEscape(body) + '"}';
                try {
                    var raw:String = Std.string(_api.call("chat.v1.sendMessage", payload));
                    var accepted = applyServerControlResult(raw, "roster");
                    if (accepted) sendRoomDiagnostic("roster_send",
                        _rosterSnapshots.sessionSource(now, ROSTER_FRESH_MS, namesField), names.length);
                    zfeLog("info", "world", "roster control sent names=" + names.length
                        + " source=" + _rosterSnapshots.sessionSource(now, ROSTER_FRESH_MS, namesField));
                } catch (e:Dynamic) {
                    setServerSessionReady(false, "relay unavailable");
                    zfeLog("warn", "world", "roster send threw: " + Std.string(e));
                }
            }
        } else if (wasInWorld) {
            sendRoomDiagnostic("roster_stale", "none", 0);
            zfeLog("info", "world", "roster went stale; sending LEAVE");
            retainServerRecords("roster stale");
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
        if (FcmRoster.isMainMenu(uiData(getBSUIData(_rosterManager, "MenuStackData")))) {
            if (!_serverAtMainMenu) {
                sendRoomDiagnostic("main_menu", "none", 0);
                _serverAtMainMenu = true;
                _inWorld = false;
                retainServerRecords("main menu");
                setServerSessionReady(false, "");
                sendWorldLeaveControl();
                resetRosterObservation("main menu");
                _lastRosterSentAt = 0;
                _lastRosterSent = "";
            }
            return;
        }
        _serverAtMainMenu = false;
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
                retainServerRecords("legacy worldId changed");
                setServerSessionReady(false, "");
            }
            // JOINED (or hopped to) a world → bind the server room.
            zfeLog("info", "world", "joined world; sending JOIN control");
            sendWorldIdControl(worldId);
        } else if (wasInWorld) {
            // LEFT the world (worldId cleared) → unbind the server room.
            retainServerRecords("legacy worldId cleared");
            zfeLog("info", "world", "left world; sending LEAVE control");
            sendWorldLeaveControl();
            setServerSessionReady(false, "");
        }
        _worldPollPhase = "complete";
    }

    function sendWorldIdControl(worldId:String):Void {
        if (_api == null || !_connected || !_api.supportsNonBlockingControl()) return;
        var body:String = WORLD_CTRL_PREFIX + worldId;
        var payload:String = '{"channel":"server","targetUserId":"' + _serverSession.target() + '","body":"' + jsonEscape(body) + '"}';
        try {
            applyServerControlResult(Std.string(_api.call("chat.v1.sendMessage", payload)), "worldId");
        } catch (e:Dynamic) {
            setServerSessionReady(false, "relay unavailable");
            zfeLog("warn", "world", "join sendMessage threw: " + Std.string(e));
        }
    }

    function sendWorldLeaveControl():Void {
        if (_api == null || !_connected || !_api.supportsNonBlockingControl()) return;
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
    static inline var STAR_CONTENT_GAP:Float = 4;

    /** Create a feed-owned TextField with the same explicit HUD font contract as the chrome. */
    function makeFeedTextField(html:String, width:Float, height:Float, wrap:Bool):TextField {
        var tf:TextField = new TextField();
        tf.x = 0;
        tf.y = 0;
        tf.width = Math.max(1, width);
        tf.height = Math.max(20, height);
        tf.multiline = true;
        tf.wordWrap = wrap;
        tf.autoSize = wrap ? flash.text.TextFieldAutoSize.LEFT : flash.text.TextFieldAutoSize.NONE;
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

    function formatFeedRange(tf:TextField, start:Int, end:Int, font:String, color:Int):Void {
        if (start < 0 || end <= start || end > tf.length) return;
        tf.setTextFormat(cachedFeedFormat(font, _cfg.fontSize, color), start, end);
    }

    function measuredFeedHeight(tf:TextField):Float {
        var measured:Float = _cfg.fontSize + 4;
        try {
            if (tf.textHeight > 0) measured = Math.ceil(tf.textHeight + 2);
        } catch (e:Dynamic) {}
        return Math.max(measured, _cfg.fontSize + 4);
    }

    function measuredFeedLineHeight(tf:TextField):Float {
        // A single-line sample avoids an optional TextLineMetrics class dependency.
        // Hoisted per render via cachedLineHeight(); the per-row call stays as a
        // fallback for direct callers.
        return cachedLineHeight();
    }

    /**
     * Build one complete message row. The channel, marker, and content are children of the
     * same row Sprite. The marker therefore moves with its message during rebuilds and scrolls;
     * it cannot drift into the header or be placed over another row by TextField indices.
     */
    function buildFeedMessageRow(rec:ChatRecord, viewportWidth:Float, displayBody:String = null):FeedRowView {
        _renderStep = "styled-row-entry";
        var row:Sprite = new Sprite();
        var fs:Int = _cfg.fontSize;
        var rawUser:String = rec.user == null ? "" : rec.user;
        var sourceBody:String = rec.body == null ? "" : rec.body;
        var rawBody:String = displayBody != null ? displayBody
            : FcmConfig.normalizeDiscordEmojiMarkup(sourceBody);
        var rowLink:String = rec.linkUrl != null && FcmLink.validHttpUrl(rec.linkUrl)
            ? rec.linkUrl : FcmLink.firstUrl(sourceBody);
        if (rowLink.length > 0 && rawBody.indexOf(rowLink) < 0) rawBody += "\n" + rowLink;
        var queuedSend = rec.pending ? _outbox.get(rec.localSendId) : null;
        var deliveryStatus:String = queuedSend == null ? ""
            : " [" + (queuedSend.attempts > 0 ? "sending" : "queued") + "]";
        var rawTag:String = rec.tag == null ? "" : rec.tag;
        var nameColor:Int = FcmConfig.parseHexColor(rec.color, _cfg.senderColor);
        var channelLabel:String = FcmConfig.chanLabel(rec.channel, _canModerate);
        var moderationText:String = "";
        if (_canModerate && rec.messageId != null && rec.messageId.length >= 8
                && rec.senderUserId != null && rec.senderUserId.length > 0)
            moderationText = "[#" + rec.messageId.substr(0, 8).toUpperCase() + "] ";
        // A single full-width native field lets continuation lines return beneath the channel.
        // Non-breaking spaces reserve an inline vector slot and stay with the first name word.
        var hasMarker:Bool = rec.supporterStar && rawUser.length > 0;
        var markerSize:Float = Math.max(8, Math.min(16, fs * 0.95));
        var markerSpaces:Int = 0;
        if (hasMarker) {
            markerSpaces = FcmStarLayout.markerSpaces(markerSize, STAR_CONTENT_GAP,
                cachedNbspAdvance(fs), fs);
        }
        var runs = FcmFeedText.compose(channelLabel, moderationText, rawTag, rawUser,
            rawBody, markerSpaces, deliveryStatus);
        _renderStep = "native-wrapped-text";
        var contentTf:TextField = makeFeedTextField("", viewportWidth, fs + 8, true);
        contentTf.text = runs.text;
        contentTf.selectable = rowLink.length > 0;
        contentTf.mouseEnabled = rowLink.length > 0;
        contentTf.tabEnabled = rowLink.length > 0;
        row.addChild(contentTf);
        _renderStep = "native-text-colors";
        // Set the whole row to the theme first, then override only named ranges.
        // Plain text prevents HTML font inheritance and keeps indices exact for escaped text.
        formatFeedRange(contentTf, 0, contentTf.length, FONT_BODY, _cfg.textColor);
        formatFeedRange(contentTf, 0, runs.channelEnd, FONT_BOLD, _cfg.channelColor(rec.channel));
        formatFeedRange(contentTf, runs.channelEnd, runs.moderationEnd, FONT_BODY, _cfg.promptColor);
        formatFeedRange(contentTf, runs.moderationEnd, runs.tagEnd, FONT_BOLD, _cfg.textColor);
        formatFeedRange(contentTf, runs.tagEnd, runs.nameStart, FONT_BOLD, _cfg.textColor);
        formatFeedRange(contentTf, runs.nameStart, runs.nameEnd, FONT_BOLD, nameColor);
        formatFeedRange(contentTf, runs.nameEnd, runs.statusStart, FONT_BODY, _cfg.textColor);
        formatFeedRange(contentTf, runs.statusStart, contentTf.length, FONT_BODY, _cfg.promptColor);
        var contentHeight:Float = Math.max(contentTf.height, measuredFeedHeight(contentTf));
        var lineHeight:Float = measuredFeedLineHeight(contentTf);
        _renderStep = "native-marker";

        if (hasMarker) {
            var star:Shape = makeSupporterStar(
                FcmConfig.supporterStarColor(rec.starColor, _cfg.tabActiveColor), markerSize);
            // Hide only the optional marker if GFx cannot resolve the inline slot; never paint
            // an estimated star over the channel or a different continuation line.
            star.visible = false;
            row.addChild(star);
            try {
                var authorIndex = runs.nameStart;
                var authorBounds:Rectangle = contentTf.getCharBoundaries(authorIndex);
                var slotBounds:Rectangle = contentTf.getCharBoundaries(authorIndex - markerSpaces);
                var markerBounds:Rectangle = star.getBounds(star);
                if (authorBounds != null && slotBounds != null && authorBounds.height > 0
                        && markerBounds.height > 0 && Math.abs(slotBounds.y - authorBounds.y) < 1
                        && authorBounds.x - slotBounds.x >= markerBounds.width + STAR_CONTENT_GAP) {
                    // Both objects are direct children of row; text-field bounds need only its offset.
                    star.x = contentTf.x + authorBounds.x - STAR_CONTENT_GAP - markerBounds.width - markerBounds.x;
                    star.y = FcmStarLayout.alignMarker(contentTf.y + authorBounds.y,
                        authorBounds.height, markerBounds.y, markerBounds.height);
                    star.visible = true;
                }
            } catch (_:Dynamic) {}
        }
        row.mouseEnabled = false;
        row.mouseChildren = rowLink.length > 0;
        return { view: row, contentY: 0, height: Math.max(contentHeight, lineHeight), textField: contentTf,
            bodyOffset: runs.nameEnd + 2, linkUrl: rowLink };
    }

    // Called only after a complete styled baseline exists. Optional class verification,
    // tokenization, and sprite construction cannot remove that baseline on failure.
    function buildEmojiFeedRow(rec:ChatRecord, viewportWidth:Float):FeedRowView {
        _renderStep = "emoji-plan";
        var plan:FcmEmoji.FcmEmojiPlan;
        var linkSafeBody:String = FcmLink.abbreviateBody(rec.body == null ? "" : rec.body);
        try {
            plan = FcmEmoji.plan(linkSafeBody, true, rec.user + rec.tag);
        } catch (error:Dynamic) {
            reportEmojiStatus("planner failed at " + FcmEmoji.stage + ": " + clip200(Std.string(error)));
            return null;
        }
        _renderStep = "emoji-layout";
        var emoji = FcmEmojiLayout.prepare(plan);
        if (emoji.slots.length == 0) return null;
        // A decoration failure should show a readable name, not missing font glyphs.
        var fallback = FcmEmoji.plan(linkSafeBody, false).text;
        try {
            _renderStep = "emoji-styled-row";
            var candidate = buildFeedMessageRow(rec, viewportWidth, emoji.text);
            _renderStep = "emoji-decoration";
            if (FcmEmojiRenderer.decorate(candidate.view, candidate.textField, emoji.slots,
                    candidate.bodyOffset, _cfg.fontSize, FONT_BODY, _cfg.textColor)) {
                candidate.height = Math.max(candidate.textField.height, measuredFeedHeight(candidate.textField));
                reportEmojiStatus("native sprites placed");
                return candidate;
            }
            reportEmojiStatus("readable fallback at " + FcmEmojiRenderer.stage);
        } catch (error:Dynamic) {
            reportEmojiStatus("readable fallback; step=" + _renderStep + ": " + clip200(Std.string(error)));
        }
        return buildFeedMessageRow(rec, viewportWidth, fallback);
    }

    var _emojiLastStatus:String = "";
    function reportEmojiStatus(status:String):Void {
        if (_emojiLastStatus == status) return;
        _emojiLastStatus = status;
        zfeLog("info", "emoji", status);
    }

    function buildFeedNoticeRow(text:String, viewportWidth:Float):FeedRowView {
        var row:Sprite = new Sprite();
        var html:String = '<font face="' + FONT_BOLD + '" size="' + _cfg.fontSize
            + '" color="' + hx(_cfg.tabActiveColor) + '">' + FcmConfig.htmlEscape(text) + '</font>';
        var tf:TextField = makeFeedTextField(html, viewportWidth, _cfg.fontSize + 8, true);
        row.addChild(tf);
        var height:Float = Math.max(tf.height, measuredFeedHeight(tf));
        row.mouseEnabled = false;
        row.mouseChildren = false;
        return { view: row, contentY: 0, height: height };
    }

    var _renderStep:String = "idle";
    var _ownNameColor:String = "";
    // Windows 10 xScal evidence measured 32-row slices at 32-65ms. Six rows keeps the observed
    // per-slice construction cost below an 8ms UI-work budget while the old snapshot stays visible.
    var _renderPending:Bool = false;
    static inline var RENDER_SLICE_ROWS:Int = 6;
    var _renderSliceSize:Int = RENDER_SLICE_ROWS;
    var _pendingVisibleRecords:Array<ChatRecord> = null;
    var _pendingContentY:Float = 0;
    var _renderGeneration:FcmRenderGeneration = new FcmRenderGeneration();
    // Burst coalescing: rapid ingest/poll/ACK triggers collapse into one deferred
    // render. Tab switches, resizes, and config changes still render immediately.
    var _renderCoalescer:FcmRenderCoalescer = new FcmRenderCoalescer();
    var _coalesceTimer:Timer = null;
    // Snapshot identity for incremental append: parallel keys for the committed
    // visible rows (notice row excluded). A matching prefix is reparented as-is.
    var _renderedRecordKeys:Array<String> = [];
    var _renderedChanIdx:Int = -1;
    var _renderedViewportWidth:Float = -1;
    var _renderedFontSize:Int = -1;
    var _renderedVisualContext:String = "";
    // Cached GFx measurements and TextFormat objects (invalidated on fontSize change).
    var _cachedLineHeight:Float = -1;
    var _cachedLineHeightFs:Int = -1;
    var _cachedNbspAdvance:Float = -1;
    var _cachedNbspFs:Int = -1;
    var _formatCache:Map<String, TextFormat> = new Map();
    var _formatCacheFs:Int = -1;
    // Reused display objects: at most two staging layers (double-buffer). Only
    // one slice timer may be live; its listener is detached at every terminal edge.
    var _stagingPool:Array<Sprite> = [];
    var _sliceTimer:Timer = null;
    var _sliceTimerHandler:Dynamic = null;

    /** Invalidate delayed slices before replacing or detaching the feed display tree. */
    function cancelPendingRender():Void {
        _renderGeneration.invalidate();
        _renderCoalescer.reset();
        stopCoalesceTimer();
        stopSliceTimer();
        discardPendingFeedSnapshot();
    }

    /**
     * Coalesced render request for burst-prone tail-append traffic (ingest batches,
     * optimistic echo, ACK reconciliation). Collapses N rapid triggers into one
     * deferred renderRecords() on the next timer tick.
     */
    function requestRender():Void {
        if (_disposed || _logTf == null || _feedLayer == null) return;
        if (!_renderCoalescer.request()) return;
        if (_coalesceTimer != null) return;
        _coalesceTimer = new Timer(1, 1);
        _coalesceTimer.addEventListener(TimerEvent.TIMER_COMPLETE, function(_:Dynamic) {
            _coalesceTimer = null;
            if (_disposed) { _renderCoalescer.reset(); return; }
            if (!_renderCoalescer.consumeTick()) return;
            try {
                renderRecords();
            } catch (err:Dynamic) {
                renderRecordsFallback(err);
            }
        });
        try { _coalesceTimer.start(); } catch (_:Dynamic) {
            _coalesceTimer = null;
            if (_renderCoalescer.consumeTick()) renderRecords();
        }
    }

    function stopCoalesceTimer():Void {
        if (_coalesceTimer != null) {
            try { _coalesceTimer.stop(); } catch (_:Dynamic) {}
            _coalesceTimer = null;
        }
    }

    function stopSliceTimer():Void {
        if (_sliceTimer != null) {
            try { _sliceTimer.stop(); } catch (_:Dynamic) {}
            if (_sliceTimerHandler != null) {
                try { _sliceTimer.removeEventListener(TimerEvent.TIMER_COMPLETE, _sliceTimerHandler); }
                catch (_:Dynamic) {}
            }
        }
        _sliceTimer = null;
        _sliceTimerHandler = null;
    }

    /** Stable identity keys for the currently visible snapshot (notice row excluded). */
    function visibleRecordKeys(visible:Array<ChatRecord>):Array<String> {
        var keys:Array<String> = [];
        for (rec in visible) {
            var queued = rec.pending ? _outbox.get(rec.localSendId) : null;
            var delivery:String = queued == null ? "ready" : (queued.attempts > 0 ? "sending" : "queued");
            var visual:String = visualPart(rec.user) + visualPart(rec.tag) + visualPart(rec.color)
                + visualPart(rec.supporterStar ? "1" : "0") + visualPart(rec.starColor)
                + visualPart(rec.body) + visualPart(rec.linkUrl) + visualPart(rec.senderUserId)
                + visualPart(rec.pending ? "1" : "0") + visualPart(rec.sendAccepted ? "1" : "0")
                + visualPart(delivery);
            keys.push(FcmFeedPlan.recordKey(rec.channel, rec.messageId, rec.localSendId, visual));
        }
        return keys;
    }

    /** Length-prefix values so arbitrary chat text cannot make two visual keys collide. */
    function visualPart(value:Dynamic):String {
        var text:String = value == null ? "" : Std.string(value);
        return text.length + ":" + text;
    }

    function feedVisualContext():String {
        return (_canModerate ? "mod1" : "mod0")
            + ":" + _cfg.textColor + ":" + _cfg.promptColor + ":" + _cfg.senderColor
            + ":" + _cfg.tabActiveColor + ":" + _cfg.channelTagColor
            + ":" + _cfg.chanColorGlobal + ":" + _cfg.chanColorTrade
            + ":" + _cfg.chanColorEvents + ":" + _cfg.chanColorInfests
            + ":" + _cfg.chanColorRaids + ":" + _cfg.chanColorServer;
    }

    function snapshotMatchesCommitted(newKeys:Array<String>, viewportWidth:Float):Bool {
        if (_feedContentLayer == null || _feedRows.length == 0) return false;
        if (_renderedChanIdx != _chanIdx) return false;
        if (_renderedFontSize != _cfg.fontSize) return false;
        if (_renderedViewportWidth != viewportWidth) return false;
        if (_renderedVisualContext != feedVisualContext()) return false;
        if (_renderedRecordKeys.length > newKeys.length) return false;
        return FcmFeedPlan.prefixReuseCount(_renderedRecordKeys, newKeys) == _renderedRecordKeys.length;
    }

    function obtainStagingLayer():Sprite {
        while (_stagingPool.length > 0) {
            var layer:Sprite = _stagingPool.pop();
            if (layer == null) continue;
            try {
                while (layer.numChildren > 0) layer.removeChildAt(0);
            } catch (_:Dynamic) { continue; }
            layer.visible = false;
            layer.y = 0;
            return layer;
        }
        var fresh:Sprite = new Sprite();
        fresh.visible = false;
        return fresh;
    }

    function recycleStagingLayer(layer:Sprite):Void {
        if (layer == null) return;
        if (_stagingPool.length >= 2) return;
        try {
            while (layer.numChildren > 0) layer.removeChildAt(0);
        } catch (_:Dynamic) { return; }
        layer.visible = false;
        _stagingPool.push(layer);
    }

    function cachedFeedFormat(font:String, size:Int, color:Int):TextFormat {
        if (_formatCacheFs != _cfg.fontSize) {
            _formatCache = new Map();
            _formatCacheFs = _cfg.fontSize;
        }
        var key:String = font + "|" + size + "|" + color;
        var fmt:TextFormat = _formatCache.get(key);
        if (fmt == null) {
            fmt = new TextFormat();
            fmt.font = font;
            fmt.size = size;
            fmt.color = color;
            _formatCache.set(key, fmt);
        }
        return fmt;
    }

    function cachedNbspAdvance(fs:Int):Float {
        if (_cachedNbspFs == fs && _cachedNbspAdvance >= 0) return _cachedNbspAdvance;
        var spaceSample = makeFeedTextField('<font face="' + FONT_BOLD + '">M&#160;M</font>', 200, fs + 8, false);
        var plainSample = makeFeedTextField('<font face="' + FONT_BOLD + '">MM</font>', 200, fs + 8, false);
        var advance:Float = 0;
        try { advance = spaceSample.textWidth - plainSample.textWidth; } catch (_:Dynamic) { advance = 0; }
        if (!Math.isFinite(advance) || advance < 0) advance = 0;
        _cachedNbspAdvance = advance;
        _cachedNbspFs = fs;
        return advance;
    }

    function cachedLineHeight():Float {
        var fs:Int = _cfg.fontSize;
        if (_cachedLineHeightFs == fs && _cachedLineHeight > 0) return _cachedLineHeight;
        var sample = makeFeedTextField("Mg", 100, fs + 8, false);
        var measured:Float = fs + 2;
        try { measured = Math.max(fs + 2, Math.ceil(sample.textHeight + 2)); } catch (_:Dynamic) {}
        _cachedLineHeight = measured;
        _cachedLineHeightFs = fs;
        return measured;
    }

    /**
     * Single-pass row builder. The emoji planner runs only when the fast
     * prefilter allows it; emoji rows are built once with the decorated text
     * instead of plain-then-decorated. Failures keep the readable baseline.
     */
    function buildFeedRowSinglePass(rec:ChatRecord, viewportWidth:Float):FeedRowView {
        if (!FcmFeedPlan.needsEmojiPass(rec.body == null ? "" : rec.body)) {
            return buildFeedMessageRow(rec, viewportWidth);
        }
        _renderStep = "build-row";
        try {
            var decorated = buildEmojiFeedRow(rec, viewportWidth);
            if (decorated != null) return decorated;
        } catch (emojiError:Dynamic) {
            zfeLog("warn", "emoji", "kept styled row; step=" + _renderStep + ": " + clip200(Std.string(emojiError)));
        }
        return buildFeedMessageRow(rec, viewportWidth);
    }

    function discardPendingFeedSnapshot():Void {
        if (_pendingFeedContentLayer != null && _feedLayer != null) {
            try { _feedLayer.removeChild(_pendingFeedContentLayer); } catch (_:Dynamic) {}
            recycleStagingLayer(_pendingFeedContentLayer);
        }
        _pendingFeedContentLayer = null;
        _renderPending = false;
        _pendingVisibleRecords = null;
        _pendingContentY = 0;
        applySelectedRowStyle();
    }

    /** Commit one completed snapshot without exposing partially positioned rows. */
    function commitFeedSnapshot(renderToken:Int, layer:Sprite, rows:Array<FeedRowView>, contentHeight:Float,
            ?recordKeys:Array<String>, viewportWidth:Float = -1, reuseCount:Int = 0):Void {
        if (!_renderGeneration.mayCommit(renderToken, _renderPending)
                || _feedLayer == null || layer == null || layer != _pendingFeedContentLayer) return;
        var retired:Sprite = null;
        if (_feedContentLayer != null && _feedContentLayer != layer) {
            retired = _feedContentLayer;
        }
        // Reparent a proven unchanged prefix only at the atomic commit edge. The
        // old snapshot therefore remains complete and visible throughout every
        // delayed suffix slice and is untouched if that render is cancelled.
        var moved:Int = 0;
        if (reuseCount > 0 && retired != null) {
            try {
                for (i in 0...reuseCount) {
                    layer.addChildAt(rows[i].view, i);
                    moved++;
                }
            } catch (moveError:Dynamic) {
                for (i in 0...moved) {
                    try { retired.addChildAt(rows[i].view, i); } catch (_:Dynamic) {}
                }
                throw moveError;
            }
        }
        if (retired != null) try { _feedLayer.removeChild(retired); } catch (_:Dynamic) {}
        _feedContentLayer = layer;
        _pendingFeedContentLayer = null;
        _feedRows = rows;
        if (retired != null) recycleStagingLayer(retired);
        if (_selectedRowIndex >= _feedRows.length) _selectedRowIndex = _feedRows.length - 1;
        if (recordKeys != null) {
            _renderedRecordKeys = recordKeys;
            _renderedChanIdx = _chanIdx;
            _renderedViewportWidth = viewportWidth;
            _renderedFontSize = _cfg.fontSize;
            _renderedVisualContext = feedVisualContext();
        }
        _feedContentHeight = contentHeight;
        _feedMaxScrollY = Math.max(0, _feedContentHeight - _logTf.height);
        if (!_bScrolling) {
            _feedScrollY = _feedMaxScrollY;
        } else {
            _feedScrollY = Math.max(0, Math.min(_feedScrollY, _feedMaxScrollY));
            if (_feedMaxScrollY <= 0) { _bScrolling = false; _newWhileScrolled = 0; }
        }
        applyFeedScroll();
        layer.visible = true;
        _logTf.visible = false;
        _feedLayer.visible = true;
        _renderPending = false;
        _pendingVisibleRecords = null;
        _pendingContentY = 0;
    }


    function renderRecords():Void {
        var renderToken:Int = _renderGeneration.begin();
        _renderCoalescer.reset();
        stopCoalesceTimer();
        stopSliceTimer();
        discardPendingFeedSnapshot();
        if (_logTf == null || _feedLayer == null) return;

        try {
            try {
                var ext:Dynamic = untyped __global__["scaleform.gfx.Extensions"];
                if (ext != null) ext.enabled = true;
            } catch (e:Dynamic) {}

        // First load / not linked: show ONLY the link screen — never the chat history (user
        // request). An unlinked identity can't post, so the link prompt takes the whole feed.
        if (!_connected && _outboxIdentity.length == 0) { setLogText("connecting..."); return; }
        // Link gate. ZFE's getAuthState.state is ALWAYS "authenticated" when merely CONNECTED
        // (it does NOT reflect the relay's linked/limited state), so we must NOT use it here.
        // The relay sends a system link-code notice ONLY to limited (unlinked) identities; its
        // arrival (_needsLink) is the authoritative "not linked" signal.
        if (_needsLink) { setLogText(linkHint()); return; }

        var oldestStaticAt:String = "";
        for (rec in _records) {
            if (rec.channel == "server" || rec.createdAt == null || rec.createdAt.length == 0) continue;
            if (oldestStaticAt.length == 0 || rec.createdAt < oldestStaticAt) oldestStaticAt = rec.createdAt;
        }
        var visibleRecords:Array<ChatRecord> = [];
        for (rec in _records) {
            var activeChannel:String = CHAN_SLUGS[_chanIdx];
            if (FcmCommand.channelVisible(activeChannel, rec.channel)
                    && FcmFeedPlan.replayVisibleInFeed(activeChannel, rec.channel,
                        rec.serverReplay, rec.createdAt, oldestStaticAt)) visibleRecords.push(rec);
        }
        visibleRecords.sort(function(a:ChatRecord, b:ChatRecord):Int {
            return FcmFeedPlan.compareChronology(a.createdAt, a.arrivalOrder, b.createdAt, b.arrivalOrder);
        });
        zfeLog("info", "render", "records=" + _records.length + " shown=" + visibleRecords.length
            + " layout=row-local tags=enabled tab=" + CHAN_SLUGS[_chanIdx]);
        if (visibleRecords.length == 0) {
            setLogText("No messages in " + channelTabLabel(_chanIdx) + " yet"); return;
        }

        var viewportWidth:Float = _logTf.width;
        var newKeys:Array<String> = visibleRecordKeys(visibleRecords);
        // Incremental append: a matching committed prefix is reparented as-is so
        // burst tail-appends only construct the genuinely new suffix rows.
        var reuseCount:Int = 0;
        if (snapshotMatchesCommitted(newKeys, viewportWidth)) {
            reuseCount = FcmFeedPlan.prefixReuseCount(_renderedRecordKeys, newKeys);
            if (reuseCount > _feedRows.length) reuseCount = _feedRows.length;
        }
        var stagingLayer:Sprite = obtainStagingLayer();
        _pendingFeedContentLayer = stagingLayer;
        _feedLayer.addChild(stagingLayer);
        var stagingRows:Array<FeedRowView> = [];
        var contentY:Float = 0;
        if (reuseCount > 0 && _feedContentLayer != null) {
            for (i in 0...reuseCount) {
                var kept:FeedRowView = _feedRows[i];
                // Do not reparent yet: these rows remain in the visible committed
                // layer until commitFeedSnapshot performs the synchronous swap.
                stagingRows.push(kept);
                contentY += kept.height + FEED_ROW_GAP;
            }
        }
        // Warm the hoisted line-height cache once per render, not once per row.
        cachedLineHeight();
        var remaining:Int = visibleRecords.length - reuseCount;
        // Small feeds render synchronously; larger feeds spend a bounded slice per timer turn.
        if (remaining <= _renderSliceSize) {
            var customNameColors:Int = 0;
            for (idx in reuseCount...visibleRecords.length) {
                var rec:ChatRecord = visibleRecords[idx];
                _renderStep = "build-row";
                if (FcmConfig.parseHexColor(rec.color, _cfg.senderColor) != _cfg.senderColor) customNameColors++;
                var rendered:FeedRowView = buildFeedRowSinglePass(rec, viewportWidth);
                rendered.contentY = contentY;
                rendered.view.y = contentY;
                stagingRows.push(rendered);
                stagingLayer.addChild(rendered.view);
                contentY += rendered.height + FEED_ROW_GAP;
            }
            zfeLog("info", "name-colors", "rows=" + visibleRecords.length + " differentFromTheme=" + customNameColors
                + " reused=" + reuseCount);
            if (_bScrolling && _newWhileScrolled > 0) {
                var notice:FeedRowView = buildFeedNoticeRow(
                    "v " + _newWhileScrolled + " new - wheel down or F11 Scroll to newest", viewportWidth);
                notice.contentY = contentY;
                notice.view.y = contentY;
                stagingRows.push(notice);
                stagingLayer.addChild(notice.view);
                contentY += notice.height + FEED_ROW_GAP;
            }
            _renderPending = true;
            commitFeedSnapshot(renderToken, stagingLayer, stagingRows, contentY, newKeys, viewportWidth, reuseCount);
        } else {
            // Chunked path — bounded rows per timer turn based on the Windows 10 frame-time trace.
            // The slice size adapts to measured construction cost to hold the UI-work budget.
            var pendingRecords:Array<ChatRecord> = visibleRecords;
            var pendingContentY:Float = contentY;
            _pendingVisibleRecords = pendingRecords;
            _pendingContentY = pendingContentY;
            _renderPending = true;
            var renderedCount:Int = reuseCount;
            var customNameColorsChunk:Int = 0;
            for (idx in 0...reuseCount) {
                var seen:ChatRecord = pendingRecords[idx];
                if (FcmConfig.parseHexColor(seen.color, _cfg.senderColor) != _cfg.senderColor) customNameColorsChunk++;
            }
            var tChunkStart:Float = flash.Lib.getTimer();
            var doSlice:Dynamic = null;
            doSlice = function():Void {
                // Timer callbacks can outlive a rebuild or a widget reload. Never let an
                // older callback consume the next render's shared state or touch a detached
                // Scaleform display object.
                if (_disposed || !_renderGeneration.isCurrent(renderToken)
                        || !_renderPending || _pendingVisibleRecords == null || _feedLayer == null
                        || _pendingFeedContentLayer != stagingLayer) {
                    if (_renderGeneration.isCurrent(renderToken)) {
                        _renderPending = false;
                        _pendingVisibleRecords = null;
                        _pendingContentY = 0;
                    }
                    return;
                }
                var sliceStart:Float = flash.Lib.getTimer();
                var start:Int = renderedCount;
                var end:Int = Std.int(Math.min(pendingRecords.length, start + _renderSliceSize));
                for (idx in start...end) {
                    var rec:ChatRecord = pendingRecords[idx];
                    _renderStep = "build-row";
                    if (FcmConfig.parseHexColor(rec.color, _cfg.senderColor) != _cfg.senderColor) customNameColorsChunk++;
                    var rendered:FeedRowView = buildFeedRowSinglePass(rec, viewportWidth);
                    rendered.contentY = pendingContentY;
                    rendered.view.y = pendingContentY;
                    stagingRows.push(rendered);
                    stagingLayer.addChild(rendered.view);
                    pendingContentY += rendered.height + FEED_ROW_GAP;
                    _pendingContentY = pendingContentY;
                }
                renderedCount = end;
                _renderSliceSize = FcmFeedPlan.nextSliceSize(_renderSliceSize, flash.Lib.getTimer() - sliceStart);
                if (renderedCount < pendingRecords.length) {
                    stopSliceTimer();
                    _sliceTimer = new Timer(1, 1);
                    var sliceRef:Timer = _sliceTimer;
                    var sliceHandler:Dynamic = null;
                    sliceHandler = function(_:Dynamic) {
                        try { sliceRef.removeEventListener(TimerEvent.TIMER_COMPLETE, sliceHandler); }
                        catch (_:Dynamic) {}
                        if (sliceRef != _sliceTimer) return;
                        _sliceTimer = null;
                        _sliceTimerHandler = null;
                        _renderGeneration.runCurrent(renderToken, doSlice, renderRecordsFallback);
                    };
                    _sliceTimerHandler = sliceHandler;
                    sliceRef.addEventListener(TimerEvent.TIMER_COMPLETE, sliceHandler);
                    try { sliceRef.start(); } catch (_:Dynamic) {
                        stopSliceTimer();
                        _renderGeneration.runCurrent(renderToken, doSlice, renderRecordsFallback);
                    }
                } else {
                    zfeLog("info", "name-colors", "rows=" + pendingRecords.length + " differentFromTheme=" + customNameColorsChunk
                        + " reused=" + reuseCount + " slice=" + _renderSliceSize
                        + " sliced render dt=" + (flash.Lib.getTimer() - tChunkStart) + "ms");
                    var contentY:Float = pendingContentY;
                    if (_bScrolling && _newWhileScrolled > 0) {
                        var notice:FeedRowView = buildFeedNoticeRow(
                            "v " + _newWhileScrolled + " new - wheel down or F11 Scroll to newest", viewportWidth);
                        notice.contentY = contentY;
                        notice.view.y = contentY;
                        stagingRows.push(notice);
                        stagingLayer.addChild(notice.view);
                        contentY += notice.height + FEED_ROW_GAP;
                    }
                    stopSliceTimer();
                    commitFeedSnapshot(renderToken, stagingLayer, stagingRows, contentY, newKeys, viewportWidth, reuseCount);
                    var dt:Float = flash.Lib.getTimer() - tChunkStart;
                    if (dt > 80) zfeLog("info", "render", "sliced render complete dt=" + dt + "ms rows=" + pendingRecords.length);
                }
            };
            doSlice();
        }
        } catch (err:Dynamic) {
            renderRecordsFallback(err);
        }
    }

    /** Shared first-slice/timer failure path; invalidate pending work before showing plain text. */
    function renderRecordsFallback(err:Dynamic):Void {
        cancelPendingRender();
        try {
            clearFeedRows();
            _logTf.visible = true;
            _feedLayer.visible = false;
            _logTf.multiline = true;
            _logTf.wordWrap = true;
            var fallback = new StringBuf();
            for (rec in _records) {
                if ((!_connected && _outboxIdentity.length == 0) || _needsLink) break;
                if (!FcmCommand.channelVisible(CHAN_SLUGS[_chanIdx], rec.channel)) continue;
                fallback.add("[" + FcmConfig.chanLabel(rec.channel, _canModerate) + "] " + rec.user + ": " + rec.body + "\n");
            }
            _logTf.text = !_connected && _outboxIdentity.length == 0 ? "connecting..."
                : (_needsLink ? "Link your account to chat" : fallback.toString());
            _logTf.scrollV = _logTf.maxScrollV;
        } catch (_:Dynamic) {}
        zfeLog("warn", "render", "isolated render exception step=" + _renderStep + ": " + clip200(Std.string(err)));
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
            + '2) Sign in with Steam or Discord<br/>'
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
        discardPendingFeedSnapshot();
        if (_feedLayer != null && _feedContentLayer != null) {
            try { _feedLayer.removeChild(_feedContentLayer); } catch (_:Dynamic) {}
            recycleStagingLayer(_feedContentLayer);
            _feedContentLayer = obtainStagingLayer();
            _feedContentLayer.visible = true;
            try { _feedLayer.addChild(_feedContentLayer); } catch (_:Dynamic) {}
        }
        _feedRows = [];
        _renderedRecordKeys = [];
        _renderedChanIdx = -1;
        _renderedVisualContext = "";
        _feedContentHeight = 0;
        _feedMaxScrollY = 0;
        _selectedRowIndex = -1;
    }

    /** Apply the current content offset to every row inside the clipped feed layer. */
    function applyFeedScroll():Void {
        if (_feedLayer == null || _feedContentLayer == null) return;
        _feedScrollY = Math.max(0, Math.min(_feedScrollY, _feedMaxScrollY));
        _feedContentLayer.y = -_feedScrollY;
    }

    function applySelectedRowStyle():Void {
        for (i in 0..._feedRows.length) {
            var row = _feedRows[i];
            row.view.graphics.clear();
            if (i != _selectedRowIndex) continue;
            row.view.graphics.lineStyle(1, _cfg.selectedRowColor, 0.85);
            row.view.graphics.beginFill(_cfg.selectedRowColor, 0.14);
            row.view.graphics.drawRect(-3, -1, Math.max(1, _logTf.width + 6), row.height + 2);
            row.view.graphics.endFill();
        }
    }

    function moveRowSelection(direction:Int):Void {
        if (_feedRows.length == 0) return;
        if (_selectedRowIndex < 0) _selectedRowIndex = direction < 0 ? _feedRows.length - 1 : 0;
        else _selectedRowIndex = Std.int(Math.max(0, Math.min(_feedRows.length - 1, _selectedRowIndex + direction)));
        var selected = _feedRows[_selectedRowIndex];
        if (selected.contentY < _feedScrollY) _feedScrollY = selected.contentY;
        var bottom:Float = selected.contentY + selected.height;
        if (bottom > _feedScrollY + _logTf.height) _feedScrollY = bottom - _logTf.height;
        _bScrolling = _feedScrollY < _feedMaxScrollY;
        applyFeedScroll();
        applySelectedRowStyle();
        setPrompt(selected.linkUrl != null && FcmLink.validHttpUrl(selected.linkUrl)
            ? "Selected link - activate to open " + FcmConfig.htmlEscape(selected.linkUrl)
            : "Selected message - no link");
    }

    public function scrollUp():Void {
        if (_feedLayer == null) return;
        try {
            moveRowSelection(-1);
        } catch (e:Dynamic) {
            zfeLog("warn", "scroll", "scrollUp threw: " + Std.string(e));
        }
    }

    public function scrollDown():Void {
        if (_feedLayer == null) return;
        try {
            moveRowSelection(1);
        } catch (e:Dynamic) {
            zfeLog("warn", "scroll", "scrollDown threw: " + Std.string(e));
        }
    }

    public function scrollToBottom():Void {
        if (_feedLayer == null) return;
        _selectedRowIndex = -1;
        snapLogToBottom();
        applySelectedRowStyle();
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
        // Hardened like every other ui* helper: a cross-domain value can throw #1014
        // inside Std.string/fcmClean, and the identity path must degrade to "" (retry),
        // never abort boot (connecting... stall).
        if (value == null) return "";
        try {
            var name:String = fcmClean(Std.string(value));
            if (stripDecorations) {
                var marker:Int = name.indexOf("<");
                if (marker >= 0) name = name.substr(0, marker);
                name = StringTools.replace(name, "|", "");
            }
            return FcmIdentity.normalizeDisplayName(name);
        } catch (_:Dynamic) { return ""; }
    }

    function uiNameFromFields(obj:Dynamic, fields:Array<String>, stripDecorations:Bool = false):String {
        if (obj == null) return "";
        for (field in fields) {
            var name:String = "";
            try { name = uiName(uiField(obj, field), stripDecorations); } catch (_:Dynamic) {}
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
    /**
     * Return the public Fallout/Bethesda handle from AccountInfoData, trying every
     * viable manager candidate. A cached single manager can be a decoy serving
     * MenuStack/HUDMode while its AccountInfoData is hostile or empty (xScal generic
     * dispatcher vs the real classDef) — first non-empty name across candidates wins
     * so one decoy can no longer wedge boot in "retrying..." forever.
     */
    function readAccountDisplayNameAny():String {
        var cands:Array<Dynamic> = [];
        try { cands = bsuiCandidates(); } catch (_:Dynamic) {}
        if (cands.length == 0) {
            var single:Dynamic = null;
            try { single = findBSUI(); } catch (_:Dynamic) {}
            if (single != null) cands.push(single);
        }
        for (mgr in cands) {
            // xScal's GetDataFromClient throws transient #1014s yet reads fine
            // milliseconds later; retry the same manager before moving on.
            // Cheap (µs native round-trip) and only runs on connect attempts.
            var attempt:Int = 0;
            while (attempt < 3) {
                var s:String = "";
                try { s = readAccountDisplayName(mgr); } catch (_:Dynamic) {}
                if (s.length > 0) return s;
                attempt++;
            }
        }
        return "";
    }

    function readAccountDisplayName(mgr:Dynamic):String {
        var data:Dynamic = uiData(getBSUIData(mgr, "AccountInfoData"));
        var name:String = uiNameFromFields(data,
            ["name", "displayName", "playerName", "athenaName"]);
        if (name.length > 0) return name;
        // Retain compatibility with older HUD payloads that wrapped the same
        // Fallout account object rather than publishing its fields directly.
        // athenaName is Bethesda's backend handle and may be populated when the
        // Scaleform display name is not yet (or vice versa).
        return uiNameFromFields(uiField(data, "account"),
            ["name", "displayName", "playerName", "athenaName"]);
    }

    // Push-driven identity resolution. xScal can serve a STALE pre-login snapshot
    // from GetDataFromClient (empty name, isLoggedIn=false) for the whole session
    // while the live data arrives only via subscription pushes — polling the frozen
    // snapshot every 24-30s then retries forever. So besides the poll fallback in
    // startConnect, subscribe to AccountInfoData and kick a connect the moment a
    // push carries a usable handle. Never touches the event payload itself
    // (cross-domain #1014 lesson from RecentActivitiesData); the push is only a
    // wake-up ping, data is pulled fresh, throttled to one kick per 5s.
    static inline var IDENTITY_PUSH_MIN_MS:Float = 5000;
    var _identityCallback:Dynamic = null;
    var _identitySubscribed:Bool = false;
    var _lastPushConnectAt:Float = -1e12;

    function onAccountInfoPush(evt:Dynamic):Void {
        if (_disposed || _connected) return;
        var now:Float = 0;
        try { now = flash.Lib.getTimer(); } catch (_:Dynamic) {}
        if (now - _lastPushConnectAt < IDENTITY_PUSH_MIN_MS) return;
        var name:String = "";
        try { name = readAccountDisplayNameAny(); } catch (_:Dynamic) {}
        if (name.length == 0) return;
        _lastPushConnectAt = now;
        try { zfeLog("info", "connect", "AccountInfoData push carries handle len=" + name.length); } catch (_:Dynamic) {}
        try { runStartConnectSafely(); } catch (_:Dynamic) {}
    }

    function subscribeIdentityUpdates():Void {
        if (_identitySubscribed) return;
        var mgr:Dynamic = null;
        try { mgr = findBSUI(); } catch (_:Dynamic) {}
        if (mgr == null) return;
        try {
            _identityCallback = function(evt:Dynamic):Void { try { onAccountInfoPush(evt); } catch (_:Dynamic) {} };
            mgr.Subscribe("AccountInfoData", _identityCallback);
            _identitySubscribed = true;
            zfeLog("info", "connect", "subscribed AccountInfoData pushes");
        } catch (e:Dynamic) {
            zfeLog("warn", "connect", "Subscribe AccountInfo threw: " + Std.string(e));
            unsubscribeIdentityUpdates(mgr);
        }
    }

    function unsubscribeIdentityUpdates(mgr:Dynamic = null):Void {
        var target:Dynamic = (mgr != null) ? mgr : findBSUI();
        if (target == null) target = _rosterManager;
        if (target != null) {
            try {
                var unsub:Dynamic = Reflect.field(target, "Unsubscribe");
                if (unsub != null && _identityCallback != null) Reflect.callMethod(target, unsub, ["AccountInfoData", _identityCallback]);
            } catch (e:Dynamic) { zfeLog("warn", "connect", "Unsubscribe AccountInfo threw: " + Std.string(e)); }
        }
        _identityCallback = null;
        _identitySubscribed = false;
    }

    // Returns only the public FO76 account handle, or "" until AccountInfoData is ready.
    // PlayerListData and CharacterInfoData are read as explicit non-authoritative candidates;
    // FcmIdentity refuses to let either character label satisfy the relay handshake.
    function readFalloutDisplayName(rosterData:Dynamic = null):String {
        var mgr:Dynamic = null;
        try { mgr = findBSUI(); } catch (_:Dynamic) {}
        // Authoritative handle first: read across ALL candidates so a decoy manager
        // serving MenuStack but hostile AccountInfoData cannot wedge resolution.
        var accountName:String = "";
        try { accountName = readAccountDisplayNameAny(); } catch (_:Dynamic) {}
        if (accountName.length == 0 && mgr != null) {
            try { accountName = readAccountDisplayName(mgr); } catch (_:Dynamic) {}
        }
        if (mgr == null && accountName.length == 0) return "";
        var localName:String = "";
        try { localName = readLocalPlayerNameFromData(rosterData); } catch (_:Dynamic) {}
        if (localName.length == 0 && mgr != null) {
            try { localName = readLocalPlayerName(mgr); } catch (_:Dynamic) {}
        }
        var characterInfoName:String = "";
        if (mgr != null) {
            try { characterInfoName = readNamedData(mgr, "CharacterInfoData"); } catch (_:Dynamic) {}
        }
        var selected:String = "";
        try { selected = FcmIdentity.selectFalloutDisplayName(accountName, localName, characterInfoName); } catch (_:Dynamic) {}
        // Manual fallback (FCMChat.ini displayName=): the game can serve a blank
        // AccountInfoData all session (empty name, isLoggedIn=false) while the
        // player is fully in-world — without this, boot waits forever and never
        // reaches chat.v1.connect. Real game data always wins; the override only
        // fills the gap and is replaced (re-hello sync) once the game provides it.
        if (selected.length == 0 && _cfg != null) {
            try {
                var ov:String = FcmIdentity.normalizeDisplayName(_cfg.displayNameOverride);
                if (ov.length > 0) {
                    selected = ov;
                    if (_displayName != ov) {
                        try { zfeLog("info", "connect", "using INI displayName override len=" + ov.length); } catch (_:Dynamic) {}
                    }
                }
            } catch (_:Dynamic) {}
        }
        return selected;
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

    // Raw manager probes in priority order with their scope names. Shared by
    // findBSUI (first passing candidate wins, cached) and bsuiCandidates (all
    // passing candidates, de-duplicated, for identity reads that must survive a
    // decoy serving MenuStack/HUDMode while its AccountInfoData is hostile).
    function bsuiProbeLists():Dynamic {
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
        return { names: names, cands: cands };
    }

    // All manager candidates in probe priority order, de-duplicated. PERMISSIVE by
    // design: a candidate is included unless canUseBSUI cleanly returns false. A
    // single transient #1014 from xScal's GetDataFromClient must not permanently
    // exclude the good manager for the whole session — reads are individually
    // guarded and retried, so an extra candidate costs microseconds and can only
    // add chances. findBSUI (first clean pass wins) is unchanged for subscribers.
    function bsuiCandidates():Array<Dynamic> {
        var out:Array<Dynamic> = [];
        try {
            var lists:Dynamic = bsuiProbeLists();
            var cands:Array<Dynamic> = lists.cands;
            for (k in 0...cands.length) {
                var cand:Dynamic = null;
                try { cand = cands[k]; } catch (_:Dynamic) {}
                if (cand == null) continue;
                var dup:Bool = false;
                for (o in out) { try { if (o == cand) { dup = true; break; } } catch (_:Dynamic) {} }
                if (dup) continue;
                var ok:Bool = false;
                var threw:Bool = false;
                try { ok = canUseBSUI(cand); } catch (_:Dynamic) { threw = true; }
                if (ok || threw) out.push(cand);
            }
        } catch (_:Dynamic) {}
        return out;
    }

    function findBSUI():Dynamic {
        if (_bsui != null) {
            if (canUseBSUI(_bsui)) return _bsui;
            _bsui = null;
        }
        try {
            var lists:Dynamic = bsuiProbeLists();
            var names:Array<String> = lists.names;
            var cands:Array<Dynamic> = lists.cands;
            for (k in 0...cands.length) {
                if (cands[k] != null && canUseBSUI(cands[k])) {
                    _bsui = cands[k];
                    zfeLog("info", "world", "BSUIDataManager found via " + names[k]);
                    return _bsui;
                }
            }
        } catch (_:Dynamic) {}
        return null;
    }

    var _worldDiagDone:Bool = false;
    var _rosterSubscribed:Bool = false;
    // Keep a replaceable snapshot per UI provider. The old global _seenNames map merged names
    // forever, so names from the previous world remained in the next ROSTER control until TTL.
    var _rosterSnapshots:FcmRoster = new FcmRoster();
    var _rosterObservedSelfNames:Array<String> = [];
    // Copy-only timestamps for the direct GFx-safe roster decoder. Never retain
    // a game-owned provider/payload object across a poll or world boundary.
    var _rosterSourceObservations:Array<{key:String, signature:String, at:Float}> = [];
    var _rosterCallbackKeys:Array<String> = [];
    var _rosterCallbacks:Map<String, Dynamic> = new Map();
    var _rosterManager:Dynamic = null;
    var _lastRosterObservationAt:Float = -ROSTER_FRESH_MS;
    var _lastRosterSentAt:Float = 0;
    var _lastRosterSent:String = "";
    var _lastRosterReadWarningAt:Float = -30000;
    var _rosterLogCount:Int = 0;
    var _lastRosterLogAt:Float = 0;
    var _rosterReadPhase:String = "not started";
    var _rosterReadWarnings:Array<{key:String, at:Float}> = [];
    var _rosterRuntimeProbed:Bool = false;

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
        _rosterSourceObservations = [];
        _rosterObservedSelfNames = [];
        setServerSessionReady(false, "");
        _rosterSnapshots = new FcmRoster();
        _serverSession.begin(Std.string(flash.Lib.getTimer()) + "-" + Std.string(Std.random(1000000000)));
        _lastRosterObservationAt = -ROSTER_FRESH_MS;
        _rosterLogCount = 0;
        _lastRosterLogAt = 0;
        // Public-event dedupe is per-world — forgetting old ids allows same Bethesda id to re-broadcast in new world
        _broadcastedWorldEvents = new Map();
        _broadcastInFlight = new Map();
        _broadcastOrder = [];
        // A relay reconnect resets the local candidate map but must retain synthetic
        // message identities for the same world. Release them only at an observed
        // world/menu boundary so a reconnect cannot duplicate an already-sent event.
        if (reason == "roster boundary" || reason == "roster stale"
                || reason == "main menu" || reason == "BSUIDataManager changed") {
            _history.clearWorldBroadcasts();
        }
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
            unsubscribeHudMode(_rosterManager);
            unsubscribeRecentActivities(_rosterManager);
            unsubscribeIdentityUpdates(_rosterManager);
            resetRosterObservation("BSUIDataManager changed");
        }
        _rosterManager = mgr;
        // Ensure HUDMode gating follows the same manager lifecycle (keeps poll running while hidden)
        if (!_hudModeSubscribed) subscribeHudMode();
        if (!_recentActivitiesSubscribed) subscribeRecentActivities();
        if (!_identitySubscribed && !_connected) subscribeIdentityUpdates();
        if (_rosterSubscribed) return;
        try {
            var playerCallback:Dynamic = function(evt:Dynamic):Void {
                try { onRosterChange(evt); } catch (e:Dynamic) {}
            };
            mgr.Subscribe("PlayerListData", playerCallback);
            _rosterCallbacks.set("PlayerListData", playerCallback);
            _rosterCallbackKeys.push("PlayerListData");
            for (k in ["TeamMarkers", "PartyMenuList", "VoiceChatAreaData", "MapMenuData", "PublicTeamsData"]) {
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
            zfeLog("info", "roster", "subscribed to player, team, voice, map and public-team data");
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
    /** Grouping aliases only; the authenticated relay/display identity is unchanged. */
    function rosterSelfAliases():Array<String> {
        var aliases:Array<String> = [];
        var add = function(value:String):Void {
            var name = bareName(value);
            if (name.length > 0 && aliases.indexOf(name) < 0 && aliases.length < 4) aliases.push(name);
        };
        add(_displayName);
        for (name in _rosterObservedSelfNames) add(name);
        return aliases;
    }
    /** Restore the pre-2.10.103 widget reader, keeping copied observation timestamps
     * and effective-roster session policy separate from native object traversal. */
    function collectRoster(key:String, d:Dynamic, pushed:Bool = false):Void {
        if (_serverAtMainMenu) return;
        var now:Float = flash.Lib.getTimer();
        _rosterReadPhase = "widget reader entered";
        if (key == "MapMenuData" || key == "PublicTeamsData") {
            var rawRows:Dynamic = uiField(d, key == "MapMenuData" ? "MarkerData" : "publicTeams");
            if (rawRows == null || uiField(rawRows, "length") == null) return;
            _rosterReadPhase = "map team helper";
            var names = FcmRoster.readNames(key, d, _displayName);
            if (names == null) return; // Invalid/damaged list cannot renew room evidence.
            var observedSelf = bareName(FcmRoster.lastSelfName);
            if (observedSelf.length > 0 && _rosterObservedSelfNames.indexOf(observedSelf) < 0
                    && _rosterObservedSelfNames.length < 3) _rosterObservedSelfNames.push(observedSelf);
            var clean:Array<String> = [];
            for (name in names) {
                var value = bareName(name);
                if (value.length > 0 && value.toLowerCase() != _displayName.toLowerCase()) clean.push(value);
            }
            rememberRosterSnapshot(key, clean, now, pushed);
            return;
        }
        var arr:Dynamic = null;
        if (key == "TeamMarkers") { try { arr = d.Markers; } catch (e:Dynamic) {} }
        else if (key == "VoiceChatAreaData") { try { arr = d.participants; } catch (e:Dynamic) {} }
        else if (key == "PlayerListData" || key == "PartyMenuList") arr = d;
        if (arr == null) return;
        var n:Int = 0;
        _rosterReadPhase = "widget list length";
        try {
            var rawLength:Dynamic = uiField(arr, "length");
            if (!Std.isOfType(rawLength, Int) && !Std.isOfType(rawLength, Float)) return;
            n = Std.int(rawLength);
            if (n != rawLength || n < 0 || n > 2048) return;
        } catch (e:Dynamic) { return; }

        var snapshot:Array<String> = [];
        var localName:String = bareName(_displayName).toLowerCase();
        var skippedEntries:Int = 0;
        _rosterReadPhase = "widget row traversal";
        for (i in 0...n) {
            try {
                var e0:Dynamic = arr[i];
                if (e0 == null) continue;
                if (uiBool(uiField(e0, "isLocalPlayer"))
                        || uiBool(uiField(e0, "isLocal"))
                        || uiBool(uiField(e0, "isSelf"))) {
                    var selfName:String = "";
                    for (selfField in ["displayName", "characterName", "name", "playerName"]) {
                        var selfValue:Dynamic = uiField(e0, selfField);
                        if (selfValue != null && Std.string(selfValue).length > 0) { selfName = bareName(Std.string(selfValue)); break; }
                    }
                    if (selfName.length > 0 && _rosterObservedSelfNames.indexOf(selfName) < 0
                            && _rosterObservedSelfNames.length < 3) _rosterObservedSelfNames.push(selfName);
                    continue;
                }
                var nm:String = "";
                for (cand in ["displayName", "characterName", "name", "playerName"]) {
                    var v:Dynamic = uiField(e0, cand);
                    if (v != null && Std.string(v).length > 0) { nm = Std.string(v); break; }
                }
                nm = bareName(nm);
                if (nm.length > 0 && nm.toLowerCase() != localName
                        && snapshot.indexOf(nm) < 0 && snapshot.length < 24) snapshot.push(nm);
            } catch (e:Dynamic) {
                skippedEntries++;
            }
        }
        if (skippedEntries > 0 && now - _lastRosterReadWarningAt >= 30000) {
            _lastRosterReadWarningAt = now;
            zfeLog("warn", "roster", key + " skipped native entries=" + skippedEntries);
        }
        if (skippedEntries > 0) return;
        snapshot.sort(function(a, b) return (a < b) ? -1 : (a > b ? 1 : 0));
        rememberRosterSnapshot(key, snapshot, now, pushed);
    }

    /** An unchanged getter cache must keep its observation time even on the restored reader. */
    function rememberRosterSnapshot(key:String, snapshot:Array<String>, now:Float, pushed:Bool):Void {
        var signature = snapshot.join("|");
        var source = null;
        for (entry in _rosterSourceObservations) if (entry.key == key) { source = entry; break; }
        var observedAt:Float = now;
        if (source == null) {
            source = {key:key, signature:signature, at:now};
            _rosterSourceObservations.push(source);
        } else if (pushed || source.signature != signature) {
            source.signature = signature;
            source.at = now;
        } else {
            // Re-reading an unchanged getter cache is not fresh world evidence.
            observedAt = source.at;
        }
        _rosterReadPhase = "snapshot store";
        storeRosterSnapshot(key, snapshot, observedAt);
        _rosterReadPhase = "snapshot complete";
    }

    /** Emit only fixed phases and numeric error IDs, at most once/source/30 seconds. */
    function rosterReadFailed(key:String, path:String, error:Dynamic):Void {
        var now:Float = flash.Lib.getTimer();
        var warning = null;
        for (entry in _rosterReadWarnings) if (entry.key == key) { warning = entry; break; }
        if (warning != null && now - warning.at < 30000) return;
        if (warning == null) _rosterReadWarnings.push({key:key, at:now});
        else warning.at = now;
        var code:Int = 0;
        try { code = Std.int(error.errorID); } catch (_:Dynamic) {}
        zfeLog("warn", "roster", key + " " + path + " phase=" + _rosterReadPhase
            + " decoder=" + FcmRoster.readPhase + " errorID=" + code);
        try { probeRosterRuntime(); } catch (probeError:Dynamic) {
            var probeCode:Int = 0;
            try { probeCode = Std.int(probeError.errorID); } catch (_:Dynamic) {}
            zfeLog("warn", "roster-probe", "probe method entry errorID=" + probeCode);
        }
    }

    /** One-shot local checks after a real failure. No game reads, snapshot writes or transport.
     * These results are diagnostics only and can never establish a world or renew a lease. */
    function probeRosterRuntime():Void {
        if (_rosterRuntimeProbed) return;
        _rosterRuntimeProbed = true;
        var savedPhase = FcmRoster.readPhase;
        for (probe in ["type-int", "type-number", "finite", "empty", "player", "map", "teams"]) {
            var ok = false;
            FcmRoster.readPhase = "probe entry";
            try {
                if (probe == "type-int") ok = Std.isOfType(0, Int);
                else if (probe == "type-number") ok = Std.isOfType(0.5, Float);
                else if (probe == "finite") ok = Math.isFinite(1.0);
                else {
                    var key = "PlayerListData";
                    var data:Dynamic = [];
                    if (probe == "player") data = [{displayName:"FcmProbe"}];
                    else if (probe == "map") { key = "MapMenuData"; data = {MarkerData:[{markerType:"PlayerRemote", text:"FcmProbe"}]}; }
                    else if (probe == "teams") { key = "PublicTeamsData"; data = {publicTeams:[{members:[{playerName:"FcmProbe"}]}]}; }
                    var result = FcmRoster.readNative(key, data, "");
                    ok = result.valid && result.skipped == 0 && result.names.length == (probe == "empty" ? 0 : 1);
                }
                zfeLog("info", "roster-probe", probe + " ok=" + ok + " phase=" + FcmRoster.readPhase);
            } catch (error:Dynamic) {
                var code:Int = 0;
                try { code = Std.int(error.errorID); } catch (_:Dynamic) {}
                zfeLog("warn", "roster-probe", probe + " phase=" + FcmRoster.readPhase + " errorID=" + code);
            }
        }
        FcmRoster.readPhase = savedPhase;
    }

    function storeRosterSnapshot(key:String, snapshot:Array<String>, now:Float):Void {
        var previousSnapshot:Array<String> = _rosterSnapshots.replace(key, snapshot, now);
        if (previousSnapshot == null || previousSnapshot.join("|") != snapshot.join("|"))
            zfeLog("info", "roster", key + " snapshot names=" + snapshot.length);
        // Snapshot callbacks do not decide session boundaries. tickRoster compares the
        // effective full roster once all cached surfaces have been refreshed. An auxiliary
        // list becoming empty/disjoint is normal during same-world fast travel.
        _lastRosterObservationAt = Math.max(_lastRosterObservationAt, now);
    }

    function onAuxDataChange(key:String, evt:Dynamic):Void {
        var now:Float = flash.Lib.getTimer();
        var dc:Dynamic = null;
        try { dc = evt.data; } catch (e:Dynamic) {}
        if (dc == null) { try { dc = evt.target.data; } catch (e:Dynamic) {} }
        if (dc != null) try { collectRoster(key, dc, true); }
            catch (error:Dynamic) { rosterReadFailed(key, "push", error); }
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
        try { collectRoster("PlayerListData", d, true); }
        catch (error:Dynamic) { rosterReadFailed("PlayerListData", "push", error); }
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
        for (key in ["PlayerListData", "TeamMarkers", "PartyMenuList", "VoiceChatAreaData", "MapMenuData", "PublicTeamsData"]) {
            try {
                _rosterReadPhase = "provider getter";
                FcmRoster.readPhase = "not called";
                var provider:Dynamic = getBSUIData(mgr, key);
                _rosterReadPhase = "payload access";
                var data:Dynamic = uiData(provider);
                if (data != null) collectRoster(key, data);
            } catch (e:Dynamic) {
                rosterReadFailed(key, "snapshot", e);
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
        for (key in ["AccountInfoData", "CharacterInfoData", "PlayerListData", "PartyMenuList",
                "MapMenuData", "PublicTeamsData", "TeamMarkers", "VoiceChatAreaData", "HUDModeData", "MenuStackData"]) {
            try {
                var r:Dynamic = getBSUIData(mgr, key);
                if (r == null || r.data == null) { zfeLog("info", "inv", key + ": <no data>"); continue; }
                var d:Dynamic = r.data;
                // Resolve one representative row without logging any player value.
                var sample:Dynamic = d;
                try {
                    if (key == "MapMenuData") sample = d.MarkerData != null && d.MarkerData.length > 0 ? d.MarkerData[0] : null;
                    else if (key == "PublicTeamsData") sample = d.publicTeams != null && d.publicTeams.length > 0
                        && d.publicTeams[0].members != null && d.publicTeams[0].members.length > 0 ? d.publicTeams[0].members[0] : null;
                    else if (key == "TeamMarkers") sample = d.Markers != null && d.Markers.length > 0 ? d.Markers[0] : null;
                    else if (key == "VoiceChatAreaData") sample = d.participants != null && d.participants.length > 0 ? d.participants[0] : null;
                    else if ((key == "PlayerListData" || key == "PartyMenuList") && d.length > 0) sample = d[0];
                } catch (_:Dynamic) { sample = null; }
                var idFields = FcmRoster.identityFieldNames(sample);
                // Array-like providers log only their size and shape; never row values.
                var isArr:Bool = false;
                try { isArr = (d.length != null && d[0] != null); } catch (e:Dynamic) {}
                if (isArr) {
                    var n:Int = Std.int(d.length);
                    var f0:Array<String> = [];
                    try { f0 = Reflect.fields(d[0]); } catch (e:Dynamic) {}
                    zfeLog("info", "inv", key + ": array len=" + n + " entryFields=[" + f0.join(",")
                        + "] idFields=[" + idFields.join(",") + "]");
                } else {
                    var fields:Array<String> = [];
                    try { fields = Reflect.fields(d); } catch (e:Dynamic) {}
                    zfeLog("info", "inv", key + ": fields=[" + fields.join(",")
                        + "] idFields=[" + idFields.join(",") + "]");
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
                + '","category":"' + category + '","message":"' + jsonEscape('[instance=' + _diagnosticInstance + '] ' + message) + '"}');
        } catch (e:Dynamic) {}
    }

}
