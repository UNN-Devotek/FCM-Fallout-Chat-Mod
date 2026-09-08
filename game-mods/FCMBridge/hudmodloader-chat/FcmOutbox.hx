typedef FcmQueuedSend = {
    var id:String;
    var channel:String;
    var body:String;
    var identity:String;
    var room:String;
    var createdAt:Float;
    var nextAt:Float;
    var attempts:Int;
}

/** In-memory, authenticated-widget outbox. No disk/private-message persistence. */
class FcmOutbox {
    public static inline var MAX:Int = 32;
    public static inline var TTL:Int = 1800000;
    public var entries(default, null):Array<FcmQueuedSend> = [];
    public function new() {}
    public function add(id:String, channel:String, body:String, identity:String, room:String, now:Float):Bool {
        if (entries.length >= MAX || identity.length == 0) return false;
        entries.push({id:id, channel:channel, body:body, identity:identity, room:room,
            createdAt:now, nextAt:now, attempts:0});
        return true;
    }
    public function get(id:String):FcmQueuedSend {
        for (entry in entries) if (entry.id == id) return entry;
        return null;
    }
    public function remove(id:String):Void {
        for (i in 0...entries.length) if (entries[i].id == id) { entries.splice(i, 1); return; }
    }
    public function clear():Array<String> {
        var ids = [for (entry in entries) entry.id]; entries = []; return ids;
    }
    public function prune(identity:String, room:String, roomReady:Bool, now:Float):Array<String> {
        var removed:Array<String> = [];
        for (entry in entries.copy()) {
            if (entry.identity != identity || now - entry.createdAt >= TTL
                    || (entry.channel == "server" && roomReady && entry.room != room)) {
                removed.push(entry.id); remove(entry.id);
            }
        }
        return removed;
    }
    public function next(identity:String, room:String, roomReady:Bool, now:Float):FcmQueuedSend {
        for (entry in entries) {
            if (entry.identity != identity || now < entry.nextAt) continue;
            if (entry.channel == "server" && (!roomReady || entry.room != room)) continue;
            return entry;
        }
        return null;
    }
    public function attempted(id:String, now:Float):Void {
        var entry = get(id); if (entry == null) return;
        entry.attempts++;
        entry.nextAt = now + Math.min(30000, 3000 * Math.pow(2, Math.min(entry.attempts - 1, 4)));
    }
    public static function target(id:String, room:String):String {
        return "FCMOUT/1;i=" + StringTools.urlEncode(id) + ";r=" + StringTools.urlEncode(room);
    }
    public static function receipt(carrier:String):String {
        if (carrier == null || !StringTools.startsWith(carrier, "FCMHUD/1;")) return "";
        for (part in carrier.split(";")) if (StringTools.startsWith(part, "q=")) {
            try { return StringTools.urlDecode(part.substr(2)); } catch (_:Dynamic) { return ""; }
        }
        return "";
    }
    public static function privateReceipt(body:String):String {
        if (body == null || !StringTools.startsWith(body, "FCMACK/1;")) return "";
        try {
            var raw = StringTools.urlDecode(body.substr(9));
            var parsed:Dynamic = haxe.Json.parse(raw);
            if (parsed == null || receipt(Reflect.field(parsed, "targetUserId")).length == 0) return "";
            return raw;
        } catch (_:Dynamic) { return ""; }
    }
    public static function canCorrelate(entry:FcmQueuedSend, messageId:String, safeRetry:Bool):Bool {
        if (entry == null) return true;
        if (entry.attempts == 0) return false;
        return !safeRetry || (messageId != null && messageId.length > 0);
    }
    public static function retryable(code:String):Bool {
        return ["", "not_connected", "not_started", "timeout", "request_timeout", "relay_timeout",
            "rate_limited", "dispatch_failed", "connection_failed", "network_error", "internal_error", "send_in_progress"].indexOf(code) >= 0;
    }
}
