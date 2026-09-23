import flash.display.MovieClip;
import flash.display.DisplayObjectContainer;
import flash.events.Event;
import flash.events.TimerEvent;
import flash.utils.Timer;

/** Invisible HUDModLoader child. All chat rendering and user sends live in the desktop overlay. */
class FCMServerBridge extends MovieClip {
    public static inline var VERSION:String = FcmBridgeExport.VERSION;
    public var fcmServerBridgeMarker:Bool = true;
    /** Read-only diagnostics for provider logs, exports, and the isolated artifact harness. */
    public function storageDiagnostic():String return FcmBridgeStorage.diagnostic;
    public var lastFailure(default, null):String = "none";
    var tickPhase:String = "startup";
    var api:FcmBridgeStorage = null;
    var exporter:FcmBridgeExport;
    #if bridge_native_prototype
    #if !bridge_dev
    #error "Native transport prototype is development-only"
    #end
    var nativePrototype:FcmBridgeNativePrototype = null;
    var nativeApi:FcmNativeApi = null;
    var nativeSession:String = "np-" + Std.random(1000000000) + "-" + Std.random(1000000000)
        + "-" + Std.random(1000000000) + "-" + Std.random(1000000000);
    public function nativeDiagnostic():String return nativePrototype == null ? "waiting" : nativePrototype.diagnostic;
    #end
    #if bridge_perf
    var timing:FcmBridgeTiming = new FcmBridgeTiming();
    #end
    static inline var ENVIRONMENT:String = #if bridge_dev "dev" #else "prod" #end;
    var manager:Dynamic = null;
    var timer:Timer;
    var state:FcmBridgeState;
    var rosterReader:FcmHudRosterReader = new FcmHudRosterReader();
    var callbacks:Array<{key:String, callback:Dynamic}> = [];
    var subscriptionError:String = "";
    var disposed:Bool = false;
    var conflict:Bool = false;
    var displayName:String = "";
    var status:String = "Waiting for scoped storage provider";
    var nextProvider:Float = 0;
    var nextWorld:Float = 0;
    var tickBusy:Bool = false;
    var refreshRequested:Bool = false;
    var identityChanged:Bool = false;
    var pushes:Array<{key:String, provider:Dynamic, at:Float}> = [];
    var readRetries:Array<{key:String, failures:Int, after:Float}> = [];
    static var KEYS:Array<String> = ["PlayerListData", "TeamMarkers", "PartyMenuList", "VoiceChatAreaData", "MapMenuData", "PublicTeamsData"];

    public function new() {
        super();
        mouseEnabled = false;
        mouseChildren = false;
        state = new FcmBridgeState(function() return Std.string(flash.Lib.getTimer()) + "-" + Std.string(Std.random(1000000000)));
        exporter = new FcmBridgeExport(#if bridge_native_prototype nativeSession #else
            Std.string(Std.random(1000000000)) + "-" + Std.string(Std.random(1000000000)) #end, ENVIRONMENT);
        #if bridge_perf
        exporter.timing = timing;
        #end
        addEventListener(Event.REMOVED_FROM_STAGE, removed);
        if (stage != null) start(null); else addEventListener(Event.ADDED_TO_STAGE, start);
    }
    static function main():Void { flash.Lib.current.addChild(new FCMServerBridge()); }
    function start(_:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, start);
        timer = new Timer(500);
        timer.addEventListener(TimerEvent.TIMER, tick);
        timer.start();
    }
    static function field(value:Dynamic, key:String):Dynamic { return FcmRoster.field(value, key); }
    static function text(value:Dynamic):String { return value == null ? "" : Std.string(value); }
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
            if (disposed) return null;
            candidate.GetDataFromClient("AccountInfoData"); return disposed ? null : candidate;
        } catch (_:Dynamic) {}
        return null;
    }
    function detach():Void {
        if (manager != null) for (item in callbacks) try { manager.Unsubscribe(item.key, item.callback); } catch (_:Dynamic) {}
        callbacks = [];
        pushes = [];
        readRetries = [];
        rosterReader.clear();
        subscriptionError = "";
    }
    function subscribe(key:String):Void {
        if (disposed || manager == null) return;
        var owner = manager;
        var callback:Dynamic = function(event:Dynamic):Void {
            if (disposed || manager != owner) return;
            // FromClientDataEvent carries the authoritative provider, including its
            // readiness/test flags. Re-reading GetDataFromClient here can return an
            // older cache and can re-enter native data dispatch.
            var provider = field(event, "fromClient");
            if (provider == null) provider = field(event, "target");
            if (provider == null || field(provider, "dataReady") == null) return;
            var entry = null;
            for (item in pushes) if (item.key == key) entry = item;
            if (entry == null) { entry = {key:key, provider:provider, at:flash.Lib.getTimer()}; pushes.push(entry); }
            else { entry.provider = provider; entry.at = flash.Lib.getTimer(); }
            // Pure state only: no native sends/disconnects from subscription callbacks.
            try { observe(key, true, provider); } catch (_:Dynamic) {}
        };
        try {
            owner.Subscribe(key, callback);
            if (disposed || manager != owner) {
                try { owner.Unsubscribe(key, callback); } catch (_:Dynamic) {}
                return;
            }
            callbacks.push({key:key, callback:callback});
        }
        catch (error:Dynamic) { subscriptionError = FcmBridgeRead.errorCode(error); }
    }
    function observe(key:String, pushed:Bool, provider:Dynamic = null):Void {
        if (disposed || manager == null) return;
        var retry = null;
        for (entry in readRetries) if (entry.key == key) retry = entry;
        if (retry != null && flash.Lib.getTimer() < retry.after) return;
        var attempt = new FcmBridgeRead();
        try {
            observeAttempt(key, pushed, provider, attempt);
            if (retry != null) readRetries.remove(retry);
        } catch (error:Dynamic) {
            // Roster failures cannot hammer a broken runtime entry on every callback.
            // Menu/account gates continue to be checked on the regular lifecycle path.
            if (KEYS.indexOf(key) >= 0) {
                if (retry == null) { retry = {key:key, failures:0, after:0.0}; readRetries.push(retry); }
                retry.failures = Std.int(Math.min(5, retry.failures + 1));
                retry.after = flash.Lib.getTimer() + FcmBridgeRead.retryDelay(retry.failures);
            }
            state.readException(key, attempt, error); throw error;
        }
    }
    function observeAttempt(key:String, pushed:Bool, provider:Dynamic, attempt:FcmBridgeRead):Void {
        var observedAt:Float = flash.Lib.getTimer();
        if (!pushed) {
            var owner = manager;
            provider = owner.GetDataFromClient(key);
            if (disposed || manager != owner) return;
            attempt.step = "push cache";
            for (entry in pushes) if (entry.key == key && provider != entry.provider) {
                // The older getter is not fresh evidence, even after the push
                // expires. Wait for convergence or another event; never roll back.
                if (observedAt - entry.at >= 30000) { state.readProblem(key, true); return; }
                provider = entry.provider;
                observedAt = entry.at;
            }
        }
        attempt.step = "processor entry";
        if (key == "MenuStackData") state.menu(FcmHudRosterReader.menu(provider));
        else if (key == "AccountInfoData") {
            if (FcmHudRosterReader.providerReason(provider) != "") return;
            var data = field(provider, "data");
            var name = FcmIdentity.normalizeDisplayName(FcmBridgeState.cleanName(text(field(data, "name"))));
            if (name.length == 0) name = FcmIdentity.normalizeDisplayName(text(field(field(data, "account"), "name")));
            if (name.length > 0 && name != displayName) {
                if (displayName.length > 0) identityChanged = true;
                displayName = name;
            }
        } else {
            var gate = state.rosterGate();
            if (gate != "") {
                state.observe(new FcmHudRosterReader.FcmRosterObservation(key, observedAt, gate));
                return;
            }
            var observation:FcmHudRosterReader.FcmRosterObservation;
            try { observation = rosterReader.provider(key, provider, displayName, observedAt, pushed); }
            catch (error:Dynamic) { attempt.step = rosterReader.phase; throw error; }
            attempt.step = "session entry";
            state.observe(observation);
        }
    }
    function world(now:Float):Void {
        tickPhase = "manager";
        var next = findManager();
        if (disposed) return;
        if (next != manager) {
            detach(); state.reset(); manager = next;
            if (manager != null) {
                subscribe("MenuStackData"); subscribe("AccountInfoData");
                for (key in KEYS) subscribe(key);
            }
        }
        if (disposed) return;
        if (manager == null) { status = "Waiting for HUD data"; return; }
        tickPhase = "menu read";
        observe("MenuStackData", false);
        if (disposed) return;
        tickPhase = "account read";
        observe("AccountInfoData", false);
        if (disposed) return;
        tickPhase = "roster reads";
        for (key in KEYS) try { observe(key, false); } catch (_:Dynamic) {}
        if (disposed) return;
        if (identityChanged) { identityChanged = false; state.reset(); rosterReader.clear(); return; }
        tickPhase = "settle";
        state.settle(now);
    }
    function exportState(now:Float, inactive:Bool = false, sampled:Bool = true):Void {
        if (api == null) return;
        #if bridge_native_prototype
        if (api.provider != "xscal") return;
        if (nativePrototype == null) {
            nativeApi = FcmNativeApi.discover(this);
            if (nativeApi == null || nativeApi.provider != "xscal" || !nativeApi.probeChatCapability()
                || !nativeApi.supportsNonBlockingControl()) return;
            nativePrototype = new FcmBridgeNativePrototype(nativeSession, nativeApi.call, api.save, function() return Date.now().getTime());
        }
        nativePrototype.tick(now);
        var save = nativePrototype.save;
        #else
        #if bridge_perf
        var storage = api;
        var save = function(document:String):Bool {
            var started = flash.Lib.getTimer();
            var result = storage.save(document);
            timing.save(flash.Lib.getTimer() - started);
            return result;
        };
        #else
        var save = api.save;
        #end
        #end
        if (sampled) exporter.update(now, state, state.rosterSelfName(now, displayName), api.provider, save, inactive);
        else exporter.heartbeat(now, api.provider, save);
        if (conflict) return;
        status = !exporter.lastSuccess ? "Storage unavailable - retrying"
            : !state.fresh(now) ? "Waiting for a fresh world roster"
            : state.holding(now) ? "Exporting - waiting for roster recovery"
            : "Exporting - sign into the desktop overlay";
    }
    function tick(_:TimerEvent):Void {
        if (disposed || tickBusy) return;
        tickBusy = true;
        tickOnce();
        tickBusy = false;
    }
    function tickOnce():Void {
        var now = flash.Lib.getTimer();
        var sampled = false;
        try {
            if (refreshRequested) {
                refreshRequested = false; nextProvider = 0; nextWorld = 0;
                status = "Refreshing bridge observations";
            }
            if (now >= nextWorld) {
                nextWorld = now + 2000;
                tickPhase = "conflict check";
                conflict = competingMod();
                if (conflict) {
                    // Never enter the other mod's native chat queue.
                    state.reset(); exportState(now, true);
                    status = "Disable the other FCM HUD mod before using this bridge";
                    return;
                }
                tickPhase = "world entry";
                #if bridge_perf
                var pollStarted = flash.Lib.getTimer();
                #end
                world(now);
                #if bridge_perf
                timing.poll(flash.Lib.getTimer() - pollStarted);
                #end
                if (disposed) return;
                sampled = true;
            }
            if (conflict) return;
            if (api == null && now >= nextProvider) {
                nextProvider = now + 5000;
                tickPhase = "storage discovery";
                var discovered = FcmBridgeStorage.discover(this, ENVIRONMENT);
                if (disposed) return;
                api = discovered;
            }
            if (api == null) {
                status = "Update extender - scoped storage required";
                return;
            }
            tickPhase = "export";
            exportState(now, false, sampled);
        } catch (error:Dynamic) {
            lastFailure = tickPhase + " " + FcmBridgeRead.errorCode(error);
            status = "Bridge temporarily unavailable - retrying";
        }
    }
    function removed(_:Event):Void { shutdown(); }
    public function shutdown():Void {
        if (disposed) return;
        disposed = true;
        // Respect the same write budget on unload. If rate-limited or storage fails,
        // desktop game-exit/heartbeat expiry provides the fail-closed cleanup.
        try { exportState(flash.Lib.getTimer(), true); } catch (_:Dynamic) {}
        #if bridge_native_prototype
        if (nativePrototype != null) nativePrototype.close();
        #end
        if (timer != null) { timer.stop(); timer.removeEventListener(TimerEvent.TIMER, tick); }
        removeEventListener(Event.ADDED_TO_STAGE, start);
        removeEventListener(Event.REMOVED_FROM_STAGE, removed);
        detach();
        manager = null;
        api = null;
    }
}
