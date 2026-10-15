/** Background bridge requires actual ready-provider envelopes, not raw widget fixtures. */
class MockBridgeGameData {
    static var providers:Map<String, Dynamic> = new Map();
    static var callbacks:Map<String, Array<Dynamic>> = new Map();
    public static var onRead:Void->Void = null;
    public static var readErrorKey:String = "";
    public static var subscribeErrorKey:String = "";
    public static var readCount:Int = 0;
    public static function publish(key:String, data:Dynamic):Void {
        publishProvider(key, new MockBridgeProvider(data));
    }
    /** Register the exact accessor-backed envelope before delivering its event. */
    public static function publishProvider(key:String, provider:Dynamic):Void {
        providers.set(key, provider);
        push(key, provider);
    }
    /** A fresh event may arrive while GetDataFromClient still serves its old envelope. */
    public static function push(key:String, provider:Dynamic):Void {
        var listeners = callbacks.get(key);
        if (listeners != null) for (callback in listeners.copy()) callback(new MockBridgeProvider.MockBridgeEvent(provider));
    }
    public static function map(names:Array<String>):Void {
        publish("MapMenuData", {MarkerData:[for (name in names) {markerType:"PlayerRemote", text:name}]});
    }
    public static function menu(name:String):Void {
        publish("MenuStackData", {menuStackA:name == "" ? [] : [{menuName:name}]});
    }
    public static function subscriptions():Int {
        var count = 0;
        for (listeners in callbacks) count += listeners.length;
        return count;
    }
    public static function manager():Dynamic {
        menu("");
        publish("AccountInfoData", {name:"Simulator76"});
        map(["PeerA", "PeerB"]);
        publish("TeamMarkers", {Markers:[{name:"PeerA"}]});
        return {
            GetDataFromClient:function(key:String, create:Bool = true):Dynamic {
                readCount++;
                if (onRead != null) { var callback = onRead; onRead = null; callback(); }
                if (key == readErrorKey) throw new flash.errors.Error("Private getter payload", 1014);
                return providers.get(key);
            },
            Subscribe:function(key:String, callback:Dynamic):Void {
                if (key == subscribeErrorKey) throw new flash.errors.Error("Private subscription payload", 1006);
                if (!callbacks.exists(key)) callbacks.set(key, []);
                callbacks.get(key).push(callback);
            },
            Unsubscribe:function(key:String, callback:Dynamic):Bool {
                var listeners = callbacks.get(key);
                return listeners != null && listeners.remove(callback);
            }
        };
    }
}
