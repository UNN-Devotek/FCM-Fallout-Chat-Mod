/** Private cosmetic leases. Names are display matching evidence, never identity/auth. */
class FcmNameplates {
    public static inline var CONTROL:String = "FCMCTL/1/NAMEPLATES;";
    public static inline var EVENT:String = "FCMNAMEPLATES/1;";
    public static inline var BLUE:Int = 0x167FAF;
    // Leave headroom below the HUD's five-second timer so jitter cannot skip a renewal.
    static inline var REQUEST_MIN_MS:Int = 3000;
    static inline var MAX_PENDING:Int = 4;
    public var context(default, null):String = "";
    /** Retires local rendering evidence even when the same world/context is reacquired. */
    public var generation(default, null):Int = 0;
    public var names(default, null):Array<String> = [];
    public var requestCount(default, null):Int = 0;
    public var acceptedCount(default, null):Int = 0;
    public var rejectedCount(default, null):Int = 0;
    public var requestPhase(default, null):String = "waiting";
    var seed:String;
    var revision:Int = 0;
    var pending:Array<{requestId:String,revision:Int,sentAt:Float}> = [];
    var acceptedRevision:Int = 0;
    var expiresAt:Float = 0;
    var nextRequest:Float = 0;
    public function new(seed:String) { this.seed = seed.substr(0, 12); }
    public function reset():Void { generation++; context = ""; names = []; pending = []; acceptedRevision = 0; expiresAt = 0; nextRequest = 0; requestPhase = "retired"; }
    public function setContext(value:String):Void {
        if (context == value) return;
        reset(); context = value;
    }
    public function request(now:Float, nativeRequestId:String = "", session:String = "", world:String = ""):String {
        requestPhase = "binding";
        var next = session.length > 0 ? "bridge:" + session + "/" + world : "hud:" + nativeRequestId;
        if (!nonce(nativeRequestId) && !(nonce(session) && nonce(world))) { reset(); return ""; }
        setContext(next);
        if (now < nextRequest) { requestPhase = "throttled"; return ""; }
        nextRequest = now + REQUEST_MIN_MS;
        // Keep the public method small and distinguish rejection of a helper
        // before entry from a failure while its body is running in native GFx.
        requestPhase = "pruning-call";
        prunePending(now);
        requestPhase = "queuing-call";
        var requestId = queueRequest(now);
        requestPhase = "encoding-call";
        var body = encodeRequest(requestId, nativeRequestId, session, world);
        requestPhase = "ready";
        return body;
    }
    function prunePending(now:Float):Void {
        // Independent timers can submit a renewal before polling the prior reply.
        // Retain only bounded, unexpired requests from this exact context.
        requestPhase = "pruning";
        var index = pending.length;
        while (index > 0) {
            index--;
            if (now - pending[index].sentAt >= 10000) pending.splice(index, 1);
        }
        if (pending.length >= MAX_PENDING) pending.splice(0, 1);
    }
    function queueRequest(now:Float):String {
        requestPhase = "queuing";
        var requestId = seed + "-" + (++revision);
        pending.push({requestId:requestId,revision:revision,sentAt:now});
        if (requestCount < 1000000) requestCount++;
        return requestId;
    }
    function encodeRequest(requestId:String, nativeRequestId:String, session:String, world:String):String {
        requestPhase = "encoding";
        return CONTROL + (session.length > 0
            ? haxe.Json.stringify({mode:"bridge", requestId:requestId, sessionId:session, worldGeneration:world})
            : haxe.Json.stringify({mode:"hud", requestId:requestId, nativeRequestId:nativeRequestId}));
    }
    public function accept(body:String, now:Float):Bool {
        var accepted = acceptReply(body, now);
        if (accepted) { if (acceptedCount < 1000000) acceptedCount++; }
        else if (rejectedCount < 1000000) rejectedCount++;
        return accepted;
    }
    function acceptReply(body:String, now:Float):Bool {
        if (body == null || body.length > 8192 || !StringTools.startsWith(body, EVENT) || pending.length == 0) return false;
        var data = FcmJson.parse(body.substr(EVENT.length));
        if (data == null || FcmRoster.field(data, "version") != 1
            || FcmRoster.field(data, "context") != context) return false;
        var request = null;
        var index = 0;
        while (index < pending.length) {
            var entry = pending[index++];
            if (entry.requestId == FcmRoster.field(data, "requestId")) { request = entry; break; }
        }
        if (request == null || request.revision <= acceptedRevision) return false;
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
        acceptedRevision = request.revision;
        // A newer accepted reply (including an empty withdrawal) fences all older replies.
        index = pending.length;
        while (index > 0) {
            index--;
            if (pending[index].revision <= acceptedRevision) pending.splice(index, 1);
        }
        // Start at request submission, not receipt: queued/delayed/replayed replies cannot renew a stale lease.
        expiresAt = request.sentAt + ttl;
        names = expiresAt > now ? result : [];
        return true;
    }
    public function current(now:Float):Array<String> {
        if (now >= expiresAt) names = [];
        return names;
    }
    /** Numeric lifetime counters only; never include peer names or context/request identifiers. */
    public function diagnostic(now:Float):String {
        var remaining = Std.int(Math.max(0, Math.min(10000, expiresAt - now)));
        return "requests=" + requestCount + " accepted=" + acceptedCount + " rejected=" + rejectedCount
            + " requestPhase=" + requestPhase
            + " pending=" + (pending.length > 0 ? "yes" : "no") + " leaseMs=" + remaining
            + " names=" + (expiresAt > now ? names.length : 0);
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
