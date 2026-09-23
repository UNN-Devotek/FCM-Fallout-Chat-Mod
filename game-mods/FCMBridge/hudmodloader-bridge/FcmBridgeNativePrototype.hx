/** Explicit development experiment: one capsule write, native roster transport.
 * Uses the existing linked xScal identity. No editor, hotkeys or account-wide binding.
 */
class FcmBridgeNativePrototype {
    public var diagnostic(default, null):String = "waiting";
    var call:(String, String)->Dynamic;
    var storage:String->Bool;
    var session:String;
    var capsuleSaved:Bool = false;
    var connected:Bool = false;
    var ready:Bool = false;
    var nextCheck:Float = 0;
    var disposed:Bool = false;
    var clock:Void->Float;
    public function new(session:String, call:(String, String)->Dynamic, storage:String->Bool, clock:Void->Float) {
        this.session = session; this.call = call; this.storage = storage; this.clock = clock;
    }
    static function decode(value:Dynamic):Dynamic return Std.isOfType(value, String) ? FcmJson.parse(value) : value;
    static function field(value:Dynamic, name:String):Dynamic return FcmRoster.field(value, name);
    public function tick(now:Float):Void {
        if (disposed || now < nextCheck) return;
        nextCheck = now + 5000;
        ready = false;
        try {
            if (!connected) {
                var result = decode(call("chat.v1.connect", '{"displayName":"FCM Transport Test","autoRegister":false,"clientVersion":"0.2.8-native-prototype"}'));
                connected = field(result, "success") == true;
                if (!connected || disposed) { diagnostic = "connect rejected"; return; }
            }
            var auth = decode(call("chat.v1.getAuthState", "{}"));
            if (disposed) return;
            var decision = FcmAuthFlow.classify("xscal", text(field(auth, "state")),
                text(field(auth, "status")), text(field(auth, "code")));
            ready = auth != null && field(auth, "success") != false && decision == FcmAuthFlow.AUTHENTICATED;
            call("chat.v1.pollEvents", '{"max":64}'); // Drain bounded native queues; never render/store community messages.
            if (disposed) return;
            if (!ready) { diagnostic = "linked dev identity required"; connected = decision != FcmAuthFlow.RECONNECT; return; }
            if (!capsuleSaved) capsuleSaved = storage(haxe.Json.stringify({schemaVersion:"native-prototype-1",
                environment:"dev", provider:"xscal", sessionId:session}));
            ready = ready && capsuleSaved;
            diagnostic = ready ? "native transport ready" : "capsule write failed";
        } catch (_:Dynamic) { ready = false; connected = false; diagnostic = "native transport unavailable"; }
    }
    static function text(value:Dynamic):String return value == null ? "" : Std.string(value);
    public function save(document:String):Bool {
        if (disposed || !ready) return false;
        try {
            var snapshot = FcmJson.parse(document);
            if (snapshot == null || field(snapshot, "sessionId") != session || field(snapshot, "environment") != "dev") return false;
            var body = "FCMCTL/1/NATIVE-PROTOTYPE:" + haxe.Json.stringify({sentAt:clock(), snapshot:snapshot});
            var result = decode(call("chat.v1.sendMessage", haxe.Json.stringify({channel:"server", targetUserId:"", body:body})));
            return !disposed && field(result, "success") == true;
        } catch (_:Dynamic) { diagnostic = "native send failed"; return false; }
    }
    public function close():Void { disposed = true; ready = false; }
}
