/**
 * Pure self-echo correlation for the HUD feed.
 *
 * The widget owns one local row per send transaction. This helper only chooses
 * which pending transaction an authoritative event completes; it never creates or
 * removes rows. Keeping that decision separate prevents ACK handling and event
 * rendering from independently matching the same message in different ways.
 */
typedef FcmPendingEcho = {
    var recordIndex:Int;
    var channel:String;
    var body:String;
    var senderUserId:String;
    var displayName:String;
    var messageId:String;
    var createdAt:Float;
    var accepted:Bool;
}

typedef FcmEchoDecision = {
    var recordIndex:Int;
    var mode:String;
}

class FcmEcho {
    /** The fallback is deliberately short; a late event must not consume a new send. */
    public static inline var MATCH_WINDOW_MS:Float = 15000;

    /**
     * Select one pending transaction for an authoritative event.
     *
     * Priority:
     *   1. exact server message id (the negotiated FCMHUD/1 transport),
     *   2. a proven local sender identity,
     *   3. one ACK-accepted legacy event with the same channel/body/display name.
     *
     * A negotiated live event may arrive before the short-lived send ACK. When
     * `allowPreAck` is true, the same identity/name rules may consume one
     * unaccepted transaction, but only when the event carries a stable message
     * id. An old bridge without that id remains ACK-gated.
     *
     * The legacy path is intentionally unique-only and time-bounded. If two local
     * sends are indistinguishable, it returns "ambiguous" and the event remains a
     * normal authoritative row rather than being attached to the wrong send.
     */
    public static function choose(messageId:String, senderUserId:String, displayName:String,
            channel:String, body:String, pending:Array<FcmPendingEcho>, now:Float,
            relayUserId:String, localUserId:String, localLinkedUserId:String,
            allowPreAck:Bool = false):FcmEchoDecision {
        var decision:FcmEchoDecision = { recordIndex: -1, mode: "none" };
        if (pending == null) return decision;
        var preAckAllowed:Bool = allowPreAck && has(messageId);

        // FCMHUD/1 carries the authoritative message id through the native-known
        // targetUserId member. This is the only match that does not need a time/name
        // fallback, but still requires channel/body agreement to reject malformed frames.
        if (has(messageId)) {
            for (candidate in pending) {
                if ((!candidate.accepted && !preAckAllowed) || !same(candidate.channel, channel)
                        || candidate.body != body || candidate.messageId != messageId) continue;
                if (decision.recordIndex >= 0) return { recordIndex: -1, mode: "ambiguous" };
                decision = { recordIndex: candidate.recordIndex, mode: "id" };
            }
            if (decision.recordIndex >= 0) return decision;
        }

        var identityCandidates:Array<FcmPendingEcho> = [];
        for (candidate in pending) {
            if (!eligible(candidate, channel, body, now, preAckAllowed)) continue;
            var senderMatches:Bool = sameNonEmpty(senderUserId, candidate.senderUserId)
                || isKnownLocal(senderUserId, relayUserId, localUserId, localLinkedUserId)
                || (isKnownLocal(candidate.senderUserId, relayUserId, localUserId, localLinkedUserId)
                    && !has(senderUserId));
            if (senderMatches) identityCandidates.push(candidate);
        }
        if (identityCandidates.length == 1) {
            return { recordIndex: identityCandidates[0].recordIndex, mode: "identity" };
        }
        if (identityCandidates.length > 1) return { recordIndex: -1, mode: "ambiguous" };

        // A linkedUserId may be unavailable on older native bridges. In that case
        // the server event still carries the Fallout display name used on send.
        // If a linked alias is known, do not let a same-named foreign account use
        // this compatibility path.
        var legacyCandidates:Array<FcmPendingEcho> = [];
        var incomingKnownLocal:Bool = isKnownLocal(senderUserId, relayUserId, localUserId, localLinkedUserId);
        for (candidate in pending) {
            if (!eligible(candidate, channel, body, now, preAckAllowed)) continue;
            if (!sameName(displayName, candidate.displayName)) continue;
            if (has(localLinkedUserId) && has(senderUserId) && !incomingKnownLocal) continue;
            legacyCandidates.push(candidate);
        }
        if (legacyCandidates.length == 1) {
            return { recordIndex: legacyCandidates[0].recordIndex, mode: "legacy-name" };
        }
        if (legacyCandidates.length > 1) return { recordIndex: -1, mode: "ambiguous" };
        return decision;
    }

    static function eligible(candidate:FcmPendingEcho, channel:String, body:String, now:Float,
            allowUnaccepted:Bool):Bool {
        if (candidate == null || (!candidate.accepted && !allowUnaccepted)) return false;
        if (!same(candidate.channel, channel) || candidate.body != body) return false;
        return now - candidate.createdAt >= 0 && now - candidate.createdAt <= MATCH_WINDOW_MS;
    }

    static function same(a:String, b:String):Bool {
        return (a == null ? "" : a) == (b == null ? "" : b);
    }

    static function sameNonEmpty(a:String, b:String):Bool {
        return has(a) && has(b) && a == b;
    }

    static function sameName(a:String, b:String):Bool {
        if (!has(a) || !has(b)) return false;
        return StringTools.trim(a).toLowerCase() == StringTools.trim(b).toLowerCase();
    }

    static function has(value:String):Bool {
        return value != null && value.length > 0;
    }

    public static function isKnownLocal(value:String, relayUserId:String, localUserId:String,
            localLinkedUserId:String):Bool {
        if (!has(value)) return false;
        return (has(relayUserId) && value == relayUserId)
            || (has(localUserId) && value == localUserId)
            || (has(localLinkedUserId) && value == localLinkedUserId);
    }
}
