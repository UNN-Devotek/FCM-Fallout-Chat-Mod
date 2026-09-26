/**
 * Pure feed-render planning helpers for the in-game chat text feed.
 *
 * These functions contain no Flash/Scaleform dependencies so they run under
 * `haxe --interp` CI. FCMChatWidget uses them to decide:
 * - whether a row can skip the emoji planner entirely (fast prefilter),
 * - how many leading rows of a new snapshot can reuse the previous snapshot,
 * - how to adapt the per-tick slice size to measured construction cost,
 * - whether burst-triggered renders should coalesce into one deferred render.
 *
 * Rendering itself still builds one full-width native TextField per row with
 * TextFormat ranges, keeps the readable baseline before optional emoji work,
 * and guards delayed slices with FcmRenderGeneration.
 */
class FcmFeedPlan {
    /** Bounds for the adaptive slice size (rows per timer turn). */
    public static inline var MIN_SLICE_ROWS:Int = 4;
    public static inline var DEFAULT_SLICE_ROWS:Int = 6;
    public static inline var MAX_SLICE_ROWS:Int = 12;

    /** Match the relay's UTC ISO timestamps so local help keeps its feed position. */
    public static function utcTimestamp(date:Date):String {
        var millis = Std.int(date.getTime() % 1000);
        return StringTools.lpad(Std.string(date.getUTCFullYear()), "0", 4) + "-"
            + StringTools.lpad(Std.string(date.getUTCMonth() + 1), "0", 2) + "-"
            + StringTools.lpad(Std.string(date.getUTCDate()), "0", 2) + "T"
            + StringTools.lpad(Std.string(date.getUTCHours()), "0", 2) + ":"
            + StringTools.lpad(Std.string(date.getUTCMinutes()), "0", 2) + ":"
            + StringTools.lpad(Std.string(date.getUTCSeconds()), "0", 2) + "."
            + StringTools.lpad(Std.string(millis), "0", 3) + "Z";
    }

    /**
     * Fast prefilter: true only when the body could contain an emoji token.
     * Unicode emoji needs a non-ASCII char; custom Discord markup needs ':' or
     * '<' (e.g. `:name:` or `<:name:123>`). Plain ASCII chat without those
     * characters can skip FcmEmoji.plan() entirely.
     */
    public static function needsEmojiPass(body:String):Bool {
        if (body == null || body.length == 0) return false;
        for (i in 0...body.length) {
            var c:Int = body.charCodeAt(i);
            if (c > 127 || c == 58 || c == 60) return true; // non-ASCII, ':' or '<'
        }
        return false;
    }

    /**
     * Stable identity key for prefix-reuse comparison. Prefers the durable
     * messageId, falls back to the optimistic localSendId transaction token,
     * mirroring the widget's ACK reconciliation (never body/sender fallback
     * for identity). The caller supplies a complete visual fingerprint so
     * in-place sender, cosmetic, moderation, body, link, and delivery-status
     * changes invalidate reuse instead of serving a stale row.
     */
    public static function recordKey(channel:String, messageId:String, localSendId:String,
            visualFingerprint:String):String {
        var mid:String = messageId == null ? "" : messageId;
        var txn:String = localSendId == null ? "" : localSendId;
        var ch:String = channel == null ? "" : channel;
        var visual:String = visualFingerprint == null ? "" : visualFingerprint;
        if (mid.length > 0) return ch + "\x1fM" + mid + "\x1fV" + visual;
        if (txn.length > 0) return ch + "\x1fT" + txn + "\x1fV" + visual;
        // Records without any identity cannot be reused safely; give each call
        // site a non-matching key so prefix reuse stops before them.
        return ch + "\x1fX";
    }

    /**
     * Count how many leading keys of the new snapshot match the previous
     * snapshot in order. Those rows may be reparented as-is; only the suffix
     * needs fresh construction. Any mismatch (including pending-status flips
     * on identity-less rows) stops reuse so stale delivery state is rebuilt.
     */
    public static function prefixReuseCount(oldKeys:Array<String>, newKeys:Array<String>):Int {
        if (oldKeys == null || newKeys == null) return 0;
        var n:Int = oldKeys.length < newKeys.length ? oldKeys.length : newKeys.length;
        var count:Int = 0;
        for (i in 0...n) {
            var a:String = oldKeys[i];
            var b:String = newKeys[i];
            if (a == null || b == null || a.length == 0 || b.length == 0) break;
            // Identity-less sentinel keys collide across different rows, so
            // they deliberately stop prefix reuse.
            if (StringTools.endsWith(a, "\x1fX") || StringTools.endsWith(b, "\x1fX")) break;
            if (a != b) break;
            count++;
        }
        return count;
    }

    /**
     * Adapt the slice size to the measured construction cost of the last slice.
     * Keeps per-tick UI work near the ~8ms budget the widget's slice comment
     * targets: grow when cheap, shrink when expensive, otherwise hold.
     */
    public static function nextSliceSize(current:Int, sliceMs:Float):Int {
        var size:Int = current;
        if (size < MIN_SLICE_ROWS) size = MIN_SLICE_ROWS;
        if (size > MAX_SLICE_ROWS) size = MAX_SLICE_ROWS;
        if (sliceMs < 4 && size < MAX_SLICE_ROWS) return size + 1;
        if (sliceMs > 12 && size > MIN_SLICE_ROWS) return size - 1;
        return size;
    }

    /** General shows only the part of a restored Server snapshot that overlaps
     * its loaded static history. The Server tab always retains the full replay. */
    public static function replayVisibleInFeed(active:String, channel:String, serverReplay:Bool,
            createdAt:String, oldestStaticAt:String):Bool {
        if (active != "global" || channel != "server" || !serverReplay) return true;
        if (oldestStaticAt == null || oldestStaticAt.length == 0) return true;
        return createdAt != null && createdAt.length > 0 && createdAt >= oldestStaticAt;
    }

    /** ISO-8601 UTC timestamps sort lexically. Missing timestamps are current
     * optimistic rows and stay after dated history, with arrival order as the
     * deterministic tie-breaker. */
    public static function compareChronology(aCreatedAt:String, aArrival:Int,
            bCreatedAt:String, bArrival:Int):Int {
        var a:String = aCreatedAt == null ? "" : aCreatedAt;
        var b:String = bCreatedAt == null ? "" : bCreatedAt;
        if (a.length == 0 && b.length > 0) return 1;
        if (b.length == 0 && a.length > 0) return -1;
        if (a < b) return -1;
        if (a > b) return 1;
        return aArrival < bArrival ? -1 : (aArrival > bArrival ? 1 : 0);
    }
}
