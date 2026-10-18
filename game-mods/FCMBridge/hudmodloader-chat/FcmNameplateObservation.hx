/** Bounded scalar evidence for cosmetic nameplate matching. This helper never
 * grants room/presence authority, changes provider flags, or retains native rows.
 * Host ownership, world generation and visible-plate corroboration belong to the
 * painter; an anomalous envelope alone is never sufficient to paint. */
class FcmNameplateObservation {
    public static inline var MAX_AGE:Float = 30000;
    static function field(value:Dynamic, key:String):Dynamic return FcmRoster.field(value, key);
    static function numeric(value:Dynamic):Bool return (Std.isOfType(value, Int) || Std.isOfType(value, Float))
        && Math.isFinite(value);
    public static function isLive(provider:Dynamic):Bool {
        // Dynamic prevents Flash's inferred Boolean locals from turning a
        // missing/throwing accessor into an apparently explicit false flag.
        var ready:Dynamic = field(provider, "dataReady");
        var test:Dynamic = field(provider, "isTest");
        return Std.isOfType(ready, Bool) && Std.isOfType(test, Bool) && ready == true && test == false;
    }
    /** Only the observed registration anomaly qualifies for separate host-HUD
     * corroboration. Neither a snapshot nor a borrowed envelope/payload qualifies. */
    public static function isHostEvent(provider:Dynamic, event:Dynamic, cached:Dynamic):Bool {
        if (provider == null || event == null || cached == null || provider != cached
                || field(event, "fromClient") != provider) return false;
        var ready:Dynamic = field(provider, "dataReady");
        var test:Dynamic = field(provider, "isTest");
        if (!Std.isOfType(ready, Bool) || !Std.isOfType(test, Bool) || ready != false || test != true) return false;
        var payload:Dynamic = field(provider, "data");
        return payload != null && field(event, "data") == payload && field(cached, "data") == payload;
    }
    /** Reject the whole observation when identity/list data are incomplete.
     * Non-friendly or unknown dispositions remain copied, explicitly ineligible. */
    public static function copy(payload:Dynamic):Array<{id:Float,name:String,eligible:Bool}> {
        var rows:Dynamic = field(payload, "Markers");
        // Native GFx collections need shape-based traversal without an inferred
        // Array cast, but primitive values cannot represent a marker collection.
        if (rows == null || Std.isOfType(rows, String) || Std.isOfType(rows, Bool)
                || Std.isOfType(rows, Int) || Std.isOfType(rows, Float) || Reflect.isFunction(rows)) return null;
        var length:Dynamic = field(rows, "length");
        if (!numeric(length) || length < 0 || length > 128 || length != Math.floor(length)) return null;
        var result:Array<{id:Float,name:String,eligible:Bool}> = [];
        var ids:Array<Float> = [];
        for (i in 0...Std.int(length)) {
            var row:Dynamic = null;
            try { row = rows[i]; } catch (_:Dynamic) { return null; }
            var id:Dynamic = field(row, "entityID");
            var rawName:Dynamic = field(row, "displayName");
            // Float retains the upper half of native uint IDs. uint.MAX_VALUE
            // is the native nameplate constructor's unassigned-ID sentinel.
            if (!numeric(id) || id < 0 || id >= 4294967295.0 || id != Math.ffloor(id)
                    || !Std.isOfType(rawName, String)) return null;
            var number:Float = id;
            var name = FcmNameplates.clean(rawName);
            if (name.length == 0 || ids.indexOf(number) >= 0) return null;
            ids.push(number);
            var local:Dynamic = field(row, "isLocalPlayer");
            var hostile:Dynamic = field(row, "isHostile");
            var state:Dynamic = field(row, "playerState");
            var wanted:Dynamic = field(row, "wantedState");
            var eligible = Std.isOfType(local, Bool) && local == false
                && Std.isOfType(hostile, Bool) && hostile == false && Std.isOfType(state, String)
                && ["teammate", "eventgroupmate", "nonhostile", "friend", "potentialHostile"].indexOf(state) >= 0
                && Std.isOfType(wanted, String) && wanted == "notWanted";
            result.push({id:number,name:name,eligible:eligible});
        }
        return result;
    }
    /** A cached read/frame cannot move observedAt forward; the painter owns that
     * timestamp exclusively from a validated source publication. */
    public static function fresh(observedAt:Float, now:Float):Bool return Math.isFinite(observedAt)
        && Math.isFinite(now) && observedAt >= 0 && now >= observedAt && now - observedAt < MAX_AGE;
    /** Current copied eligibility corroborates an admission; it grants no source
     * timestamp, new identity, private lease or world authority. */
    public static function matches(rows:Array<{id:Float,name:String,eligible:Bool}>, id:Float,
            name:String, names:Array<String>):Bool {
        if (rows == null || names == null || names.indexOf(name) < 0) return false;
        var matches = 0;
        for (row in rows) if (row.id == id) {
            if (!row.eligible || row.name != name) return false;
            matches++;
        }
        return matches == 1;
    }
}
