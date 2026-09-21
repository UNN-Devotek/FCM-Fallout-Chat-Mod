import flash.display.Sprite;
import flash.display.Loader;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.external.ExternalInterface;
import flash.net.URLRequest;
import flash.system.ApplicationDomain;
import flash.system.LoaderContext;

/** Deliberately has NO production class path/imports, @:access, or shared mocks.
 * Loads the decoded release-package child in a fresh domain. Only local provider storage is faked; no backend confirmation is invented. */
class PackagedBridgeHost extends Sprite {
    public var BSUIDataManager:Dynamic;
    public var __ZFE:Dynamic;
    public var __SFECodeObj:Dynamic;
    public var __SFCodeObj:Dynamic;
    public var BRG_OBJ:Dynamic;
    var storageCapability:Bool = true;
    var runtimeProbes:Int = 0;
    var probeFault:String = "";
    var child:Dynamic = null;
    var storageDiagnostic:String = "not loaded";
    var movie:Loader = new Loader();
    var providers:Array<{key:String, value:Dynamic}> = [];
    var listeners:Array<{key:String, callback:Dynamic}> = [];
    var snapshot:Dynamic = null;
    var writes:Int = 0;
    var failed:Bool = false;
    var registered:Bool = false;
    var registerCalls:Int = 0;
    var namedWrites:Int = 0;
    var lastWrite:Float = -1000;
    var controls:Int = 0;
    var leaves:Int = 0;
    var polls:Int = 0;
    var reads:Int = 0;
    var active:Bool = false;
    var isolated:Bool = false;
    var violation:Bool = false;
    var violationReason:String = "";
    var request:String = "";
    var previousRequest:String = "";
    var rebound:Bool = false;
    var source:String = "xscal";
    var phase:String = "initial";
    var acceptedNames:Bool = false;
    var disposed:Bool = false;

    static function main():Void { flash.Lib.current.addChild(new PackagedBridgeHost()); }
    public function new() {
        super();
        source = flash.Lib.current.loaderInfo.parameters.provider == "zfe" ? "zfe" : "xscal";
        var scenario = flash.Lib.current.loaderInfo.parameters.scenario;
        if (scenario == "packaged-probe-throw") probeFault = "throw";
        if (scenario == "packaged-probe-malformed") probeFault = "malformed";
        if (scenario == "packaged-probe-oversized") probeFault = "oversized";
        BSUIDataManager = {
            GetDataFromClient:function(key:String):Dynamic {
                reads++;
                if (disposed) { violation = true; violationReason = "read after unload"; }
                if (key == "MenuStackData") polls++;
                if (!disposed && scenario == "packaged-unload-getter" && key == "MenuStackData") retire();
                for (entry in providers) if (entry.key == key) return entry.value;
                return null;
            },
            Subscribe:function(key:String, callback:Dynamic):Void {
                if (disposed) { violation = true; violationReason = "subscribe after unload"; }
                listeners.push({key:key, callback:callback});
                if (!disposed && scenario == "packaged-unload-subscribe") retire();
            },
            Unsubscribe:function(key:String, callback:Dynamic):Void {
                for (entry in listeners.copy()) if (entry.key == key && entry.callback == callback) listeners.remove(entry);
            }
        };
        publish("MenuStackData", {menuStackA:[]});
        publish("AccountInfoData", {name:"HarnessSelf"});
        roster(["PeerA", "PeerB"], flash.Lib.current.loaderInfo.parameters.scenario != "packaged-unready");
        if (source == "zfe") {
            if (scenario == "packaged-legacy" || scenario == "packaged-legacy-unavailable") {
                BRG_OBJ = {call:dispatch};
                storageCapability = scenario != "packaged-legacy-unavailable";
            } else __ZFE = {call:dispatch};
        }
        else if (scenario != "packaged-xscal-late") __SFCodeObj = xscalApi();
        if (ExternalInterface.available) ExternalInterface.addCallback("simPackaged", action);
        addEventListener(Event.ADDED_TO_STAGE, start);
    }
    function start(_:Event):Void {
        removeEventListener(Event.ADDED_TO_STAGE, start);
        var domain = new ApplicationDomain(null);
        isolated = !domain.hasDefinition("FCMServerBridge") && !ApplicationDomain.currentDomain.hasDefinition("FCMServerBridge");
        movie.contentLoaderInfo.addEventListener(Event.COMPLETE, function(_:Event):Void {
            isolated = isolated && domain.hasDefinition("FCMServerBridge")
                && !ApplicationDomain.currentDomain.hasDefinition("FCMServerBridge");
            var container:Dynamic = movie.content;
            child = container.getChildAt(0);
            emit("PACKAGED loaded provider=" + source + " isolated=" + isolated);
        });
        movie.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(_:IOErrorEvent):Void { violation = true; emit("PACKAGED load failed"); });
        addChild(movie);
        movie.load(new URLRequest("/FCMServerBridge.swf"), new LoaderContext(false, domain));
    }
    function emit(value:String):Void { if (ExternalInterface.available) ExternalInterface.call("fcmSimLog", value); }
    function retire():Void {
        // Remove synchronously but keep the child code loaded so an in-progress
        // native callback returns normally and exposes post-unload reentry bugs.
        if (movie.parent == this) removeChild(movie);
        disposed = true;
    }
    function save(document:String):Bool {
        var now = flash.Lib.getTimer();
        if (now - lastWrite < 1000 || disposed || document.length > 8192) {
            violation = true; violationReason = "write-boundary elapsed=" + (now - lastWrite);
        }
        lastWrite = now;
        writes++;
        if (failed) return false;
        var data:Dynamic = haxe.Json.parse(document);
        if (data.schemaVersion != 1 || data.environment != "dev" || data.provider != source
            || data.sequence <= 0 || data.observationAgeMs < 0) violation = true;
        for (key in ["token","password","code","room","accountId"]) if (Reflect.hasField(data,key)) violation = true;
        if (snapshot != null && data.sequence <= snapshot.sequence) violation = true;
        snapshot = data;
        var nextActive = data.state == "active" || data.state == "holding";
        if (active && !nextActive) leaves++;
        active = nextActive;
        if (active && data.worldGeneration != request) {
            controls++;
            previousRequest = request; request = data.worldGeneration;
            rebound = previousRequest != "" && request != previousRequest;
        }
        if (data.state == "active") {
            // A provider push is settled on the next production world-poll batch.
            // Until then a heartbeat must retain BOTH the old roster and generation;
            // new names with the old generation (or vice versa) is a regression.
            acceptedNames = phase == "hop"
                ? data.names.join("|") == (controls >= 2 ? "NewPeer" : "PeerA|PeerB")
                : data.names.join("|") == "PeerA|PeerB";
            if (!acceptedNames) { violation = true; violationReason = "unexpected-roster"; }
        }
        return true;
    }
    function xscalApi():Dynamic return {version:{runtime:"xScal",value:"0.2.17",platform:"sim"},modStorage:{
        register:function(_:String):Bool { registerCalls++; return false; },
        load:Reflect.makeVarArgs(function(_:Array<Dynamic>):Dynamic return false),
        save:Reflect.makeVarArgs(function(args:Array<Dynamic>):Dynamic {
            if (args.length != 2 || Std.string(args[0]) != "fcmserverbridge-dev") {
                violation = true; violationReason = "named-storage-contract"; return false;
            }
            namedWrites++;
            registered = true;
            return save(Std.string(args[1]));
        })
    }};
    function dispatch(verb:String, payload:String):Dynamic {
        if (source != "zfe") { violation = true; return ""; }
        if (verb == "getRuntimeInfo") {
            runtimeProbes++;
            if (probeFault == "throw") throw new flash.errors.Error("private native payload", 1014);
            if (probeFault == "malformed") return "private malformed native payload";
            if (probeFault == "oversized") return StringTools.rpad('{"success":true,"capabilities":["zfe-storage-v1"]}', " ", 262145);
            // Exercise whitespace, nested extra data and escaped capability spelling.
            return storageCapability ? ' { "success" : true, "capabilities" : ["other", "zfe-storage-v\\u0031"], "extra":{"version":1} } '
                : '{"success":true,"capabilities":[]}';
        }
        if (verb == "writeStorage") {
            var args:Dynamic = haxe.Json.parse(payload);
            registered = args.vendor == "FCMServerBridge" && args.path == "dev-state.json";
            if (!registered) { violation = true; return '{"success":false}'; }
            var ok = save(args.text);
            return haxe.Json.stringify({success:ok,status:ok ? "saved" : "failed"});
        }
        violation = true; // Any native chat/auth/network call is a regression.
        return '{"success":false}';
    }
    function publish(key:String, data:Dynamic, ready:Bool = true):Void {
        var value = new IsolatedProvider(data, ready);
        var found = false;
        for (entry in providers) if (entry.key == key) { entry.value = value; found = true; }
        if (!found) providers.push({key:key,value:value});
        for (entry in listeners.copy()) if (entry.key == key) entry.callback(new IsolatedEvent(value));
    }
    function roster(names:Array<String>, ready:Bool = true):Void {
        publish("MapMenuData", {MarkerData:[for (name in names) {markerType:"PlayerRemote",text:name}]}, ready);
    }
    function action(command:String):String {
        if (!disposed && child != null) storageDiagnostic = child.storageDiagnostic();
        if (!disposed) switch command {
            case "loading": publish("MenuStackData", {menuStackA:[{menuName:"LoadingMenu"}]}); roster([]);
            case "resume": roster(["PeerB", "PeerA"]); publish("MenuStackData", {menuStackA:[]});
            case "hop": phase = "hop"; roster(["NewPeer"]);
            case "main-menu": publish("MenuStackData", {menuStackA:[{menuName:"MainMenu"}]});
            case "unload":
                retire(); // Production REMOVED_FROM_STAGE owns shutdown.
                movie.unloadAndStop(true);
            case "storage-fail": failed = true;
            case "storage-recover": failed = false;
            case "storage-capability":
                storageCapability = true; probeFault = "";
                if (source == "xscal" && __SFCodeObj == null) __SFCodeObj = xscalApi();
            case "snapshot":
            default: violation = true;
        }
        return haxe.Json.stringify({provider:source,isolated:isolated,registered:registered,registerCalls:registerCalls,namedWrites:namedWrites,
            active:active,storageDiagnostic:storageDiagnostic,
            controls:controls,leaves:leaves,polls:polls,reads:reads,writes:writes,runtimeProbes:runtimeProbes,snapshot:snapshot,subscriptions:listeners.length,
            acceptedNames:acceptedNames,rebound:rebound,violation:violation,violationReason:violationReason,disposed:disposed,
            stageProviderReserved:stage != null && Reflect.hasField(stage, "__SFCodeObj")});
    }
}

/** Separate-domain, accessor-backed objects. No production helpers are linked here. */
@:keep private class IsolatedProvider {
    var payload:Dynamic;
    var ready:Bool;
    public function new(payload:Dynamic, ready:Bool) { this.payload = payload; this.ready = ready; }
    @:getter(data) public function readData():Dynamic return payload;
    @:getter(dataReady) public function readReady():Bool return ready;
    @:getter(isTest) public function readTest():Bool return false;
}
@:keep private class IsolatedEvent {
    var provider:Dynamic;
    public function new(provider:Dynamic) { this.provider = provider; }
    @:getter(fromClient) public function readProvider():Dynamic return provider;
}
