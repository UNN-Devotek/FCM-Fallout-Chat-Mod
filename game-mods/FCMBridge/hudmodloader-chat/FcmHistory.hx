/** History recovery and replay identity, independent of the native provider and Flash timers. */
class FcmHistory {
    public var resyncSent:Bool = false;
    public var attempts:Int = 0;
    public var complete:Bool = false;
    var nextAttemptAt:Float = 0;
    public var staticEventsSeen:Bool = false;
    public var dropped:Bool = false;
    var seen:Map<String, Bool> = new Map();
    var order:Array<String> = [];

    public function new() {}

    public function startConnection():Void {
        resyncSent = false;
        attempts = 0;
        complete = false;
        nextAttemptAt = 0;
        staticEventsSeen = false;
        dropped = false;
        // Native event sequences may restart; durable message IDs still deduplicate replay.
        forget(":event:", false);
        clearServer();
    }

    public function needsRecovery(authenticated:Bool, now:Float = 0):Bool {
        return authenticated && attempts < 3 && now >= nextAttemptAt
            && (!complete || dropped) && (resyncSent || !staticEventsSeen || dropped);
    }

    public function attempted(now:Float):Void {
        attempts++;
        resyncSent = true;
        nextAttemptAt = now + 10000;
    }

    public function finish():Void {
        complete = true;
        dropped = false;
        resyncSent = false;
        attempts = 0;
    }

    public function observe(channel:String):Void {
        if (["global", "trade", "events", "infests", "raids"].indexOf(channel) >= 0)
            staticEventsSeen = true;
    }

    public function clearServer():Void {
        forget("server:", true);
    }

    /** Release a speculative message/event identity after a send was rejected. */
    public function release(channel:String, eventId:Int, messageId:String):Void {
        var keys:Array<String> = [];
        if (eventId > 0) keys.push(channel + ":event:" + eventId);
        if (messageId != null && messageId.length > 0) keys.push(channel + ":message:" + messageId);
        for (key in keys) releaseExact(key);
    }

    /** Synthetic public-event message IDs are scoped to a world, not a connection. */
    public function clearWorldBroadcasts():Void {
        forget(":message:world:", false);
    }

    function releaseExact(key:String):Void {
        if (!seen.exists(key)) return;
        seen.remove(key);
        var kept:Array<String> = [];
        for (current in order) if (current != key) kept.push(current);
        order = kept;
    }

    function forget(value:String, prefix:Bool):Void {
        var kept:Array<String> = [];
        for (key in order) {
            if (prefix ? StringTools.startsWith(key, value) : key.indexOf(value) >= 0)
                seen.remove(key);
            else kept.push(key);
        }
        order = kept;
    }

    /** Scope both IDs to the feed so clearing SERVER cannot invalidate static deduplication. */
    public function accept(channel:String, eventId:Int, messageId:String, cap:Int,
            ?retained:Array<{channel:String, messageId:String, pending:Bool}>):Bool {
        var keys:Array<String> = [];
        if (eventId > 0) keys.push(channel + ":event:" + eventId);
        if (messageId != null && messageId.length > 0) keys.push(channel + ":message:" + messageId);
        var duplicate:Bool = false;
        // Replay cursors can evict cached identities while their rows are still visible.
        // Retained canonical rows are authoritative; never match text or pending sends.
        if (retained != null && messageId != null && messageId.length > 0) {
            for (row in retained) {
                if (!row.pending && row.channel == channel && row.messageId == messageId) {
                    duplicate = true;
                    break;
                }
            }
        }
        for (key in keys) {
            if (seen.exists(key)) duplicate = true;
            else {
                seen.set(key, true);
                order.push(key);
            }
        }
        while (order.length > cap) seen.remove(order.shift());
        return !duplicate;
    }
}
