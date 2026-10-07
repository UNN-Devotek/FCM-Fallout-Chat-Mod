/** Private cosmetic leases. Names are display matching evidence, never identity/auth. */
class FcmNameplates {
    public static inline var CONTROL:String = "FCMCTL/1/NAMEPLATES;";
    public static inline var EVENT:String = "FCMNAMEPLATES/1;";
    public static inline var BLUE:Int = 0x167FAF;
    public var context(default, null):String = "";
    public var names(default, null):Array<String> = [];
    var seed:String;
    var revision:Int = 0;
    var pending:String = "";
    var sentAt:Float = 0;
    var expiresAt:Float = 0;
    var nextRequest:Float = 0;
    public function new(seed:String) { this.seed = seed.substr(0, 12); }
    public function reset():Void { context = ""; names = []; pending = ""; expiresAt = 0; nextRequest = 0; }
    public function setContext(value:String):Void {
        if (context == value) return;
        reset(); context = value;
    }
    public function request(now:Float, nativeRequestId:String = "", session:String = "", world:String = ""):String {
        var next = session.length > 0 ? "bridge:" + session + "/" + world : "hud:" + nativeRequestId;
        if (!nonce(nativeRequestId) && !(nonce(session) && nonce(world))) { reset(); return ""; }
        setContext(next);
        if (now < nextRequest) return "";
        nextRequest = now + 5000;
        sentAt = now; pending = seed + "-" + (++revision);
        return CONTROL + (session.length > 0
            ? haxe.Json.stringify({mode:"bridge", requestId:pending, sessionId:session, worldGeneration:world})
            : haxe.Json.stringify({mode:"hud", requestId:pending, nativeRequestId:nativeRequestId}));
    }
    public function accept(body:String, now:Float):Bool {
        if (body == null || body.length > 8192 || !StringTools.startsWith(body, EVENT) || pending == "") return false;
        var data = FcmJson.parse(body.substr(EVENT.length));
        if (data == null || FcmRoster.field(data, "version") != 1
            || FcmRoster.field(data, "requestId") != pending || FcmRoster.field(data, "context") != context) return false;
        var ttl:Dynamic = FcmRoster.field(data, "ttlMs");
        var rows:Dynamic = FcmRoster.field(data, "names");
        if ((!Std.isOfType(ttl, Int) && !Std.isOfType(ttl, Float)) || !Math.isFinite(ttl)
            || ttl < 0 || ttl > 10000 || Math.floor(ttl) != ttl || !Std.isOfType(rows, Array)
            || (cast rows:Array<Dynamic>).length > 24) return false;
        var result:Array<String> = [];
        for (row in (cast rows:Array<Dynamic>)) {
            if (!Std.isOfType(row, String) || row.length == 0 || row.length > 64 || clean(row) != row) return false;
            if (result.indexOf(row) < 0) result.push(row);
        }
        pending = "";
        // Start at request submission, not receipt: queued/delayed/replayed replies cannot renew a stale lease.
        expiresAt = sentAt + ttl;
        names = expiresAt > now ? result : [];
        return true;
    }
    public function current(now:Float):Array<String> {
        if (now >= expiresAt) names = [];
        return names;
    }
    public static function clean(value:String):String {
        if (value == null) return "";
        var name = StringTools.trim(value.split("<")[0]).toLowerCase();
        if (name.length > 64) return "";
        for (i in 0...name.length) if (name.charCodeAt(i) < 32 || name.charCodeAt(i) == 127) return "";
        return name;
    }
    static function nonce(value:String):Bool return value != null && ~/^[a-z0-9-]{1,64}$/.match(value);
}
