import flash.display.MovieClip;
import flash.display.DisplayObjectContainer;
import flash.events.Event;
import flash.events.TimerEvent;
import flash.utils.Timer;

/** Invisible HUDModLoader child. All chat rendering and user sends live in the desktop overlay. */
class FCMServerBridge extends MovieClip {
    public static inline var VERSION:String = "0.1.0";
    public var fcmServerBridgeMarker:Bool = true;
    var api:FcmNativeApi = null;
    var manager:Dynamic = null;
    var hudTools:Dynamic = null;
    var timer:Timer;
    var state:FcmBridgeState;
    var callbacks:Array<{key:String, callback:Dynamic}> = [];
    var disposed:Bool = false;
    var connected:Bool = false;
    var authenticated:Bool = false;
    var terminal:Bool = false;
    var conflict:Bool = false;
    var displayName:String = "";
    var code:String = "";
    var codeAt:Float = 0;
    var status:String = "Waiting for native chat provider";
    var cursor:Float = 0;
    var nextConnect:Float = 0;
    var connectAt:Float = 0;
    var nextWorld:Float = 0;
    var lastSend:Float = -15000;
    var sentRequest:String = "";
    var failures:Int = 0;
    var retryMs:Int = 5000;
    var menuDown:Bool = false;
    var eventStage:Dynamic = null;
    static var KEYS:Array<String> = ["PlayerListData", "TeamMarkers", "PartyMenuList", "VoiceChatAreaData", "MapMenuData", "PublicTeamsData"];

    public function new() {
        super();
        mouseEnabled = false;
        mouseChildren = false;
        state = new FcmBridgeState(function() return Std.string(flash.Lib.getTimer()) + "-" + Std.string(Std.random(1000000000)));
        addEventListener(Event.REMOVED_FROM_STAGE, removed);
        if (stage != null) start(null); else addEventListener(Event.ADDED_TO_STAGE, start);
    }
    static function main():Void { flash.Lib.current.addChild(new FCMServerBridge()); }
    function start(_:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, start);
        timer = new Timer(500);
        timer.addEventListener(TimerEvent.TIMER, tick);
        timer.start();
        eventStage = stage;
        if (eventStage != null) eventStage.addEventListener("HUDMod::UserEvent", menuKey);
    }
    function menuKey(event:Dynamic):Void {
        if (disposed || hudTools == null) return;
        try {
            var action = FcmUserEvent.action(event);
            // DiagnosticSnapshot is already handled by upstream HUDTools. These
            // aliases cover loaders that forward an explicit menu action instead.
            if (action != "F11" && action != "HUDModMenu" && action != "HUDModLoaderMenu") return;
            var down = FcmUserEvent.isDown(event);
            if (down && !menuDown) {
                if (hudTools.isActive == true) hudTools.CloseMenu(); else hudTools.ShowMenu();
            }
            menuDown = down;
        } catch (_:Dynamic) {}
    }
    static function field(value:Dynamic, key:String):Dynamic { return FcmRoster.field(value, key); }
    static function text(value:Dynamic):String { return value == null ? "" : Std.string(value); }
    function call(verb:String, payload:String = "{}"):Dynamic {
        var raw = api.call("chat.v1." + verb, payload);
        return Std.isOfType(raw, String) ? FcmJson.parse(Std.string(raw)) : raw;
    }
    function control(body:String, target:String):Void {
        if (api == null || !connected || !authenticated) return;
        call("sendMessage", '{"channel":"server","body":' + quote(body) + ',"targetUserId":' + quote(target) + '}');
    }
    static function quote(value:String):String {
        var out = '"';
        for (i in 0...value.length) {
            var c = value.charAt(i);
            var n = value.charCodeAt(i);
            if (c == '"' || c == "\\") out += "\\" + c;
            else if (n < 32) out += "\\u" + StringTools.hex(n, 4);
            else out += c;
        }
        return out + '"';
    }
    function leave():Void {
        if (sentRequest.length > 0) {
            var old = sentRequest;
            sentRequest = "";
            try { control("FCMCTL/1/LEAVE", "FCMBRIDGE/1;" + old); } catch (_:Dynamic) {}
        }
    }
    function registerMenu():Void {
        if (hudTools != null) return;
        try {
            var cls:Dynamic = untyped __global__["flash.utils.getDefinitionByName"]("SharedHUDTools");
            hudTools = untyped __new__(cls, "FCM Server Bridge", "All");
            hudTools.Register(function(_:String, _:String):Void {});
            hudTools.RegisterMenu(function(_:String):Void {
                if (disposed) return;
                try {
                    // HUDTools uses commas/semicolons as delimiters. Labels are fixed or sanitized.
                    hudTools.AddMenuItem("status", status, false);
                    if (code.length > 0 && !authenticated) {
                        hudTools.AddMenuItem("code", "Link code: " + code, false);
                        #if bridge_dev
                        hudTools.AddMenuItem("link", "dev.falloutchatmod.com/link", false);
                        #else
                        hudTools.AddMenuItem("link", "falloutchatmod.com/link", false);
                        #end
                    }
                    hudTools.AddMenuItem("retry", "Reconnect bridge", true, false, 500);
                } catch (_:Dynamic) {}
            }, function(item:String):Void {
                if (disposed || item != "retry") return;
                terminal = false; code = ""; reconnect(); nextConnect = 0;
            });
        } catch (_:Dynamic) {
            if (hudTools != null) try { hudTools.Shutdown(); } catch (_:Dynamic) {}
            hudTools = null;
        }
    }
    /** Bounded display-tree inspection of FCM markers only; no native modules or game memory. */
    function competingMod():Bool {
        if (stage == null) return false;
        var queue:Array<Dynamic> = [stage];
        var scanned = 0;
        while (queue.length > 0 && scanned++ < 512) {
            var node = queue.shift();
            if (node != this && (field(node, "fcmChatWidgetMarker") == true || field(node, "fcmServerBridgeMarker") == true)) return true;
            if (Std.isOfType(node, DisplayObjectContainer)) {
                var container:DisplayObjectContainer = cast node;
                for (i in 0...Std.int(Math.min(container.numChildren, 128))) queue.push(container.getChildAt(i));
            }
        }
        return false;
    }
    function findManager():Dynamic {
        var candidates:Array<Dynamic> = [];
        try { candidates.push(untyped __global__["flash.utils.getDefinitionByName"]("Shared.AS3.Data.BSUIDataManager")); } catch (_:Dynamic) {}
        try { candidates.push(untyped __global__["BSUIDataManager"]); } catch (_:Dynamic) {}
        var scope:Dynamic = this;
        for (_ in 0...16) {
            if (scope == null) break;
            candidates.push(field(scope, "BSUIDataManager")); scope = field(scope, "parent");
        }
        if (stage != null) for (i in 0...Std.int(Math.min(stage.numChildren, 32))) candidates.push(field(stage.getChildAt(i), "BSUIDataManager"));
        for (candidate in candidates) if (candidate != null) try {
            candidate.GetDataFromClient("AccountInfoData"); return candidate;
        } catch (_:Dynamic) {}
        return null;
    }
    function detach():Void {
        if (manager != null) for (item in callbacks) try { manager.Unsubscribe(item.key, item.callback); } catch (_:Dynamic) {}
        callbacks = [];
    }
    function subscribe(key:String):Void {
        var callback:Dynamic = function(_:Dynamic):Void {
            if (disposed) return;
            try { observe(key, true); } catch (_:Dynamic) {}
        };
        try { manager.Subscribe(key, callback); callbacks.push({key:key, callback:callback}); } catch (_:Dynamic) {}
    }
    function observe(key:String, pushed:Bool):Void {
        var provider:Dynamic = manager.GetDataFromClient(key);
        if (key == "MenuStackData") state.menu(provider);
        else if (key == "AccountInfoData") {
            if (!FcmBridgeState.ready(provider)) return;
            var data = field(provider, "data");
            var name = FcmIdentity.normalizeDisplayName(FcmBridgeState.cleanName(text(field(data, "name"))));
            if (name.length == 0) name = FcmIdentity.normalizeDisplayName(text(field(field(data, "account"), "name")));
            if (name.length > 0 && name != displayName) {
                if (displayName.length > 0 && connected) reconnect();
                displayName = name;
            }
        } else state.observe(key, provider, displayName, flash.Lib.getTimer(), pushed);
        if (sentRequest.length > 0 && sentRequest != state.session.requestId) leave();
    }
    function world(now:Float):Void {
        var next = findManager();
        if (next != manager) {
            leave(); detach(); state.reset(); manager = next;
            if (manager != null) {
                subscribe("MenuStackData"); subscribe("AccountInfoData");
                for (key in KEYS) subscribe(key);
            }
        }
        if (manager == null) { status = "Waiting for HUD data"; return; }
        observe("MenuStackData", false);
        observe("AccountInfoData", false);
        for (key in KEYS) try { observe(key, false); } catch (_:Dynamic) {}
        if (!state.fresh(now)) {
            leave();
            if (authenticated) status = "Waiting for a fresh world roster";
            return;
        }
        if (authenticated && (sentRequest != state.session.requestId || now - lastSend >= 15000)) {
            leaveIfChanged();
            control("FCMCTL/1/ROSTER:" + state.names(now).join("|"), state.target());
            sentRequest = state.session.requestId;
            lastSend = now;
        }
        if (authenticated) status = state.session.fresh(now) ? "Connected - chat is in the desktop overlay" : "Confirming server room";
    }
    function leaveIfChanged():Void { if (sentRequest != state.session.requestId) leave(); }
    function reconnect():Void {
        leave(); connected = false; authenticated = false; cursor = 0; state.reconnect();
        if (api != null) try { call("disconnect"); } catch (_:Dynamic) {}
        api = null; // Native roots can be replaced during a HUD reload; discover again.
        nextConnect = flash.Lib.getTimer() + retryMs;
        retryMs = Std.int(Math.min(60000, retryMs * 2));
        status = "Reconnecting to relay";
    }
    function poll(now:Float):Void {
        var auth = call("getAuthState");
        var authState = text(field(auth, "state"));
        var authStatus = text(field(auth, "status"));
        var error = text(field(field(auth, "error"), "code"));
        if (error.length == 0) error = text(field(auth, "code"));
        if (FcmBridgeState.terminal(authState, error) || FcmBridgeState.terminal(authStatus, error)) {
            reconnect(); terminal = true; status = "Account unavailable - check linking on the website"; return;
        }
        authenticated = FcmBridgeState.authenticated(auth);
        if (authenticated) { code = ""; retryMs = 5000; }
        else if (authState == "limited" || authStatus == "limited") status = "Link this bridge to your overlay account";
        else if (now - connectAt > 30000) { reconnect(); return; }
        var result = call("pollEvents", '{"max":16,"cursor":' + cursor + '}');
        if (result == null || field(result, "success") == false) {
            if (now - connectAt > 30000 && ++failures >= 6) reconnect();
            return;
        }
        failures = 0;
        var events = field(result, "events");
        var count = field(events, "length");
        if (count != null) for (i in 0...Std.int(Math.min(16, Std.int(count)))) {
            var event = events[i];
            var id = Std.parseFloat(text(field(event, "id")));
            if (Math.isFinite(id) && id > cursor) cursor = id;
            if (field(event, "channel") != "system" || field(event, "senderUserId") != "system") continue;
            var body = text(field(event, "body"));
            if (authenticated) state.session.accept(body, now);
            var nextCode = FcmBridgeState.linkCode(body);
            if (nextCode.length > 0 && nextCode != code) { code = nextCode; codeAt = now; }
        }
        // A limited native subscription receives a new code on reconnect. Never log it.
        if (!authenticated && ((code.length > 0 && now - codeAt > 540000) || (code.length == 0 && now - connectAt > 60000))) reconnect();
    }
    function tick(_:TimerEvent):Void {
        if (disposed) return;
        var now = flash.Lib.getTimer();
        try {
            registerMenu();
            if (now >= nextWorld) {
                nextWorld = now + 2000;
                conflict = competingMod();
                if (conflict) {
                    // Stop consuming the extender's single queue. Do not disconnect the widget's transport.
                    leave(); connected = false; authenticated = false; state.reset();
                    status = "Disable the other FCM HUD mod before using this bridge";
                    return;
                }
                world(now);
            }
            if (conflict) return;
            if (api == null) api = FcmNativeApi.discover(this);
            if (api == null || terminal || displayName.length == 0) return;
            if (!connected && now >= nextConnect) {
                var result = call("connect", '{"displayName":' + quote(displayName) + ',"autoRegister":true,"clientVersion":"bridge-' + VERSION + '"}');
                if (result == null || field(result, "success") == false) { nextConnect = now + retryMs; retryMs = Std.int(Math.min(60000, retryMs * 2)); return; }
                connected = true; connectAt = now; status = "Connecting to relay";
            }
            if (connected) poll(now);
        } catch (_:Dynamic) {
            status = "Bridge temporarily unavailable - retrying";
            if (++failures >= 6) { try { reconnect(); } catch (_:Dynamic) { connected = false; } failures = 0; }
        }
    }
    function removed(_:Event):Void { shutdown(); }
    public function shutdown():Void {
        if (disposed) return;
        leave(); disposed = true;
        if (timer != null) { timer.stop(); timer.removeEventListener(TimerEvent.TIMER, tick); }
        removeEventListener(Event.ADDED_TO_STAGE, start);
        removeEventListener(Event.REMOVED_FROM_STAGE, removed);
        if (eventStage != null) try { eventStage.removeEventListener("HUDMod::UserEvent", menuKey); } catch (_:Dynamic) {}
        eventStage = null;
        detach();
        if (hudTools != null) try { hudTools.Shutdown(); } catch (_:Dynamic) {}
        // Do not logout/clear credentials: native account linking survives a game restart.
        if (api != null && connected) try { call("disconnect"); } catch (_:Dynamic) {}
        api = null; hudTools = null; connected = false;
    }
}
