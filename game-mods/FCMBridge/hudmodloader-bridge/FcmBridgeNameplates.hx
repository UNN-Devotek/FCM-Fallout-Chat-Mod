/** Cosmetic-only native receiver. The authenticated desktop export owns presence.
 * Never sends room controls, community messages, credentials or UI/input commands. */
class FcmBridgeNameplates {
    var call:(String, String)->Dynamic;
    var presence:FcmNameplates;
    var started:Bool = false;
    var nextConnect:Float = 0;
    var nextPoll:Float = 0;
    var cursor:Int = 0;
    var disposed:Bool = false;
    public var diagnostic(default, null):String = "waiting";
    public function new(call:(String, String)->Dynamic, presence:FcmNameplates) {
        this.call = call; this.presence = presence;
    }
    static function decode(value:Dynamic):Dynamic return Std.isOfType(value, String) ? FcmJson.parse(value) : value;
    static function field(value:Dynamic, name:String):Dynamic return FcmRoster.field(value, name);
    public function tick(now:Float, session:String, world:String, active:Bool):Void {
        if (disposed) return;
        if (!active) { presence.reset(); diagnostic = "inactive"; return; }
        presence.setContext("bridge:" + session + "/" + world);
        if (now < nextPoll) return;
        nextPoll = now + 1000;
        try {
            if (!started) {
                if (now < nextConnect) return;
                nextConnect = now + 30000;
                var result = decode(call("chat.v1.connect", haxe.Json.stringify({displayName:"FCM Server Bridge",
                    autoRegister:true, clientVersion:FcmBridgeExport.VERSION + "-nameplates"})));
                if (disposed) return;
                started = field(result, "success") == true;
                if (!started) { presence.reset(); diagnostic = "transport unavailable"; return; }
                cursor = 0;
            }
            var auth = decode(call("chat.v1.getAuthState", "{}"));
            if (disposed) return;
            var state = field(auth, "state");
            var ready = field(auth, "success") != false && (state == "limited" || state == "authenticated");
            var polled = decode(call("chat.v1.pollEvents", haxe.Json.stringify({cursor:cursor, max:16})));
            if (disposed) return;
            var events:Dynamic = field(polled, "events");
            if (Std.isOfType(events, Array)) {
                var rows:Array<Dynamic> = cast events;
                for (i in 0...Std.int(Math.min(16, rows.length))) {
                    var event = rows[i];
                    var id:Dynamic = field(event, "id");
                    if ((Std.isOfType(id, Int) || Std.isOfType(id, Float)) && id > cursor && id <= 2147483647) cursor = Std.int(id);
                    var body = field(event, "body");
                    if (ready && field(event, "kind") == "chat.message" && field(event, "channel") == "system"
                        && field(event, "senderUserId") == "system" && Std.isOfType(body, String)) presence.accept(body, now);
                }
            }
            if (!ready) {
                presence.reset(); diagnostic = "waiting for native transport";
                if (state != "connecting") started = false;
                return;
            }
            var body = presence.request(now, "", session, world);
            if (body.length > 0) {
                var sent = decode(call("chat.v1.sendMessage", haxe.Json.stringify({channel:"server", targetUserId:"", body:body})));
                if (disposed) return;
                if (field(sent, "success") != true) { presence.reset(); started = false; diagnostic = "presence unavailable"; return; }
            }
            diagnostic = "cosmetic receiver active";
        } catch (_:Dynamic) {
            if (disposed) return;
            presence.reset(); started = false; diagnostic = "presence unavailable";
        }
    }
    public function shutdown():Void {
        disposed = true; presence.reset();
        // Do not clear/logout shared provider credentials or disconnect a replacement child.
    }
}
