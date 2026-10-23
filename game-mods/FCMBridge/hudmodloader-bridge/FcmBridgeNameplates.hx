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
    public var probe(default, null):String = "start";
    public var lastError(default, null):String = "none";
    public function new(call:(String, String)->Dynamic, presence:FcmNameplates) {
        this.call = call; this.presence = presence;
    }
    static function decode(value:Dynamic):Dynamic return Std.isOfType(value, String) ? FcmJson.parse(value) : value;
    static function field(value:Dynamic, name:String):Dynamic return FcmRoster.field(value, name);
    public function tick(now:Float, session:String, world:String, active:Bool):Void {
        if (disposed) return;
        if (!active) { presence.reset(); probe = "world"; diagnostic = "inactive"; return; }
        presence.setContext("bridge:" + session + "/" + world);
        if (now < nextPoll) return;
        nextPoll = now + 1000;
        try {
            if (!started && now < nextConnect) return;
            // Match the working HUD's separate connect/auth/poll/send boundaries.
            // GFx rejected the former combined method before its catch ran; keep
            // native work and event decoding outside this small orchestration body.
            probe = "connect-call";
            if (!connect(now) || disposed) return;
            probe = "auth-call";
            var auth = readAuth();
            if (disposed) return;
            var state = field(auth, "state");
            var ready = field(auth, "success") != false && (state == "limited" || state == "authenticated");
            probe = "poll-call";
            poll(now, ready);
            if (disposed) return;
            if (!ready) {
                presence.reset(); probe = "waiting"; diagnostic = "waiting for native transport";
                if (state != "connecting") started = false;
                return;
            }
            probe = "request-call";
            if (!request(now, session, world) || disposed) return;
            probe = "active";
            diagnostic = "cosmetic receiver active";
        } catch (error:Dynamic) {
            if (disposed) return;
            probe = "failure"; lastError = FcmRuntimeError.errorCode(error);
            presence.reset(); started = false; diagnostic = "presence unavailable";
        }
    }
    function connect(now:Float):Bool {
        if (started) return true;
        if (now < nextConnect) return false;
        nextConnect = now + 30000;
        probe = "connect";
        var result = decode(call("chat.v1.connect", haxe.Json.stringify({displayName:"FCM Server Bridge",
            autoRegister:true, clientVersion:FcmBridgeExport.VERSION + "-nameplates"})));
        if (disposed) return false;
        started = field(result, "success") == true;
        if (!started) { presence.reset(); probe = "transport"; diagnostic = "transport unavailable"; return false; }
        cursor = 0;
        return true;
    }
    function readAuth():Dynamic {
        probe = "auth";
        return decode(call("chat.v1.getAuthState", "{}"));
    }
    function poll(now:Float, ready:Bool):Void {
        probe = "poll";
        var polled = decode(call("chat.v1.pollEvents", haxe.Json.stringify({cursor:cursor, max:16})));
        if (disposed) return;
        probe = "events-call";
        consumeEvents(field(polled, "events"), now, ready);
    }
    function consumeEvents(events:Dynamic, now:Float, ready:Bool):Void {
        probe = "events";
        if (!Std.isOfType(events, Array)) return;
        var rows:Array<Dynamic> = cast events;
        var index = 0;
        while (index < rows.length && index < 16) {
            probe = "event-call";
            consumeEvent(rows[index++], now, ready);
        }
    }
    function consumeEvent(event:Dynamic, now:Float, ready:Bool):Void {
        probe = "event";
        var id:Dynamic = field(event, "id");
        if ((Std.isOfType(id, Int) || Std.isOfType(id, Float)) && id > cursor && id <= 2147483647) cursor = Std.int(id);
        var body:Dynamic = field(event, "body");
        if (ready && field(event, "kind") == "chat.message" && field(event, "channel") == "system"
            && field(event, "senderUserId") == "system" && Std.isOfType(body, String)) presence.accept(body, now);
    }
    function request(now:Float, session:String, world:String):Bool {
        probe = "request";
        var body = presence.request(now, "", session, world);
        if (body.length == 0) return true;
        probe = "send";
        var sent = decode(call("chat.v1.sendMessage", haxe.Json.stringify({channel:"server", targetUserId:"", body:body})));
        if (disposed) return false;
        if (field(sent, "success") == true) return true;
        presence.reset(); started = false; diagnostic = "presence unavailable";
        return false;
    }
    public function shutdown():Void {
        disposed = true; presence.reset();
        // Do not clear/logout shared provider credentials or disconnect a replacement child.
    }
}
