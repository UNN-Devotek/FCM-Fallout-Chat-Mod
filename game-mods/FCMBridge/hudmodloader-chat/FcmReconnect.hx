/**
 * Pure transport health policy. A quiet valid events array remains healthy, but a
 * provider that keeps answering polls locally while the relay never replies is not.
 */
class FcmReconnect {
    public static inline var HANDSHAKE_MS:Int = 60000;
    /** An accepted send with no receipt and no echo by then is unconfirmed. */
    public static inline var SEND_CONFIRM_MS:Int = 15000;
    /** Unanswered room renewals that, with a lapsed confirmation, prove a silent relay. */
    public static inline var SILENT_RENEWALS:Int = 3;
    /** Unanswered room requests (about one minute at the 10 s retry) before any confirmation. */
    public static inline var SILENT_JOINS:Int = 6;
    /** Retry-capable send attempts without any relay answer before the transport restarts. */
    public static inline var SILENT_RETRIES:Int = 3;

    public static function pendingAllowed(startedAt:Float, now:Float):Bool {
        return now - startedAt < HANDSHAKE_MS;
    }
    public static function validPoll(raw:String):Bool {
        if (raw == null) return false;
        try {
            var data:Dynamic = FcmJson.parse(raw);
            return data != null && Reflect.field(data, "success") == true
                && Std.isOfType(Reflect.field(data, "events"), Array);
        } catch (_:Dynamic) { return false; }
    }

    /**
     * The Server room confirmation lapsed although the HUD kept asking for renewal:
     * the relay stopped answering. With fewer unanswered renewals (loading screen,
     * menus, one missed reply) the lapse only closes the Server tab and the next
     * renewal restores it; that is not a transport failure.
     */
    public static function relaySilent(serverReady:Bool, fresh:Bool, unansweredRenewals:Int):Bool {
        return serverReady && !fresh && unansweredRenewals >= SILENT_RENEWALS;
    }

    /**
     * Room requests keep going out but no room was ever confirmed, e.g. the link died
     * during a world hop before the first confirmation. An explicit rejection is an
     * answer and is never counted.
     */
    public static function joinSilent(serverReady:Bool, unansweredRequests:Int):Bool {
        return !serverReady && unansweredRequests >= SILENT_JOINS;
    }

    /**
     * A provider-accepted send that is no longer tracked by the outbox (no retry path)
     * and has neither a relay receipt nor its authoritative echo after SEND_CONFIRM_MS.
     * A relay message ID proves durable delivery, so such a row is never unconfirmed.
     */
    public static function sendUnconfirmed(pending:Bool, accepted:Bool, tracked:Bool,
            relayMessageId:String, pendingAt:Float, now:Float):Bool {
        return pending && accepted && !tracked && (relayMessageId == null || relayMessageId.length == 0)
            && pendingAt > 0
            && now - pendingAt >= SEND_CONFIRM_MS;
    }
}
