import FcmHudRosterReader.FcmRosterObservation;
import FcmHudRosterReader.FcmMenuObservation;

/** Pure, bounded UI observation and room-confirmation policy for the background mod. */
class FcmBridgeState {
    public var session(default, null):FcmServerSession = new FcmServerSession();
    public var inWorld(default, null):Bool = false;
    public var observedAt(default, null):Float = -60000;
    var roster:FcmRoster = new FcmRoster();
    var snapshots:Array<{key:String, revision:Int, names:Array<String>, selfName:String, at:Float, blocked:Bool}> = [];
    var selfLabels:Array<{name:String, at:Float}> = [];
    var loading:Bool = false;
    var waiting:Bool = false;
    var lastNames:String = "";
    var makeId:Void->String;
    var menuReason:String = "not observed";
    public var missingClass(default, null):String = "not reported";
    var readReasons:Array<{key:String, label:String, reason:String}> = [
        {key:"MapMenuData", label:"Map", reason:"not observed"},
        {key:"PublicTeamsData", label:"Public teams", reason:"not observed"},
        {key:"PlayerListData", label:"Player list", reason:"not observed"},
        {key:"TeamMarkers", label:"Team markers", reason:"not observed"},
        {key:"PartyMenuList", label:"Party list", reason:"not observed"},
        {key:"VoiceChatAreaData", label:"Voice area", reason:"not observed"}
    ];
    public function new(makeId:Void->String) { this.makeId = makeId; reset(); }
    public function reset():Void {
        session.begin(makeId());
        observedAt = -60000;
        roster = new FcmRoster();
        waiting = false;
        lastNames = "";
        selfLabels = [];
        missingClass = "not reported";
        for (entry in readReasons) entry.reason = "not observed";
        for (entry in snapshots) entry.blocked = true;
    }
    /** A transport reconnect within the same observed world need not wait for a
     * roster mutation. World/menu boundaries still block cached providers. */
    public function reconnect():Void { session.begin(makeId()); }
    public static function field(value:Dynamic, key:String):Dynamic { return FcmRoster.field(value, key); }
    /** Cached fixed labels only. Opening the loader menu performs no provider/native calls. */
    public function diagnostics(now:Float):Array<String> {
        var lines = ["Menu - " + menuReason,
            "Roster - " + (observedAt < 0 ? "not observed" : fresh(now) ? "fresh" : "expired")];
        for (entry in readReasons) lines.push(entry.label + " - " + entry.reason);
        return lines;
    }
    public function readProblem(key:String, expiredPush:Bool = false):Void {
        var reason = expiredPush ? "expired push" : "read failed";
        if (key == "MenuStackData") menuReason = reason;
        noteRead(key, reason);
    }
    public function readException(key:String, attempt:FcmBridgeRead, error:Dynamic):Void {
        var reason = attempt.step + " " + FcmBridgeRead.errorCode(error);
        var missing = FcmBridgeRead.missingClass(error);
        if (missing != "") missingClass = missing;
        if (key == "MenuStackData") menuReason = reason;
        noteRead(key, reason);
    }
    function noteRead(key:String, reason:String):Void {
        for (entry in readReasons) if (entry.key == key) { entry.reason = reason; return; }
    }
    /** Native access is complete before session policy is entered. */
    public function menu(observation:FcmMenuObservation):Void {
        loading = observation.loading;
        menuReason = observation.reason;
        if (observation.allowed && loading) return;
        if (!observation.allowed && inWorld) reset();
        inWorld = observation.allowed;
    }
    public function observe(observation:FcmRosterObservation):Void {
        var key = observation.key;
        if (!inWorld) { noteRead(key, "world gate"); return; }
        if (loading) { noteRead(key, "loading"); return; }
        if (observation.reason != "") { noteRead(key, observation.reason); return; }
        var previous = null;
        for (entry in snapshots) if (entry.key == key) previous = entry;
        if (previous != null && previous.blocked && previous.revision == observation.revision) {
            noteRead(key, "old world cache"); return;
        }
        var names = observation.names.copy();
        if (previous == null) {
            previous = {key:key, revision:observation.revision, names:names, selfName:observation.selfName, at:observation.at, blocked:false};
            snapshots.push(previous);
        } else {
            previous.revision = observation.revision; previous.names = names;
            previous.selfName = observation.selfName; previous.at = observation.at; previous.blocked = false;
        }
        roster.replace(key, names, observation.at);
        var self = cleanName(observation.selfName).toLowerCase();
        if (self.length > 0) {
            var known = null;
            for (entry in selfLabels) if (entry.name == self) known = entry;
            if (known != null) known.at = Math.max(known.at, observation.at);
            else {
                // Five labels bound the primary plus at most four aliases. A
                // cached getter carries its old timestamp and cannot renew one.
                if (selfLabels.length >= 5) {
                    selfLabels.sort(function(a, b) return a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
                    selfLabels.shift();
                }
                selfLabels.push({name:self, at:observation.at});
            }
        }
        observedAt = Math.max(observedAt, observation.at);
        noteRead(key, "accepted");
    }
    public function rosterGate():String return !inWorld ? "world gate" : loading ? "loading" : "";
    public static function cleanName(name:String):String return FcmHudRosterReader.cleanName(name);
    public function fresh(now:Float):Bool { return inWorld && now - observedAt < 30000; }
    public function names(now:Float):Array<String> { return roster.sessionNames(now, 30000, lastNames); }
    /** Prefer a local name from the same fresh roster source peers are selected from. */
    public function rosterSelfName(now:Float, fallback:String):String {
        var source = roster.sessionSource(now, 30000, lastNames);
        for (entry in snapshots) if (!entry.blocked && now - entry.at < 30000
                && entry.key == source && entry.selfName.length > 0) return entry.selfName;
        for (entry in snapshots) if (!entry.blocked && now - entry.at < 30000 && entry.selfName.length > 0) return entry.selfName;
        return cleanName(fallback);
    }
    /** Fresh UI self rows and the current AccountInfoData label are matching
     * evidence only. Peer rows and blocked/expired providers cannot add aliases. */
    public function rosterAliases(now:Float, ownName:String, accountName:String):Array<String> {
        var names:Array<String> = [];
        var own = cleanName(ownName).toLowerCase();
        var add = function(value:String):Void {
            var name = cleanName(value).toLowerCase();
            if (name.length > 0 && name != own && names.indexOf(name) < 0 && names.length < 4) names.push(name);
        };
        add(accountName);
        selfLabels = [for (entry in selfLabels) if (now - entry.at < 30000) entry];
        for (entry in selfLabels) add(entry.name);
        for (entry in snapshots) if (!entry.blocked && now - entry.at < 30000) add(entry.selfName);
        names.sort(function(a, b) return a < b ? -1 : a > b ? 1 : 0);
        return names;
    }
    public function rosterSource(now:Float):String {
        var source = roster.sessionSource(now, 30000, lastNames);
        return source.length > 0 ? source : "none";
    }
    /** Timestamp of the evidence actually selected by the existing roster policy.
     * A fresh auxiliary list cannot renew an older primary map/player roster.
     * Union fallback is conservatively limited by its oldest contributing source. */
    public function evidenceAt(now:Float):Float {
        var source = roster.sessionSource(now, 30000, lastNames);
        var oldest = Math.POSITIVE_INFINITY;
        var newest:Float = -60000;
        for (entry in snapshots) if (!entry.blocked && now - entry.at < 30000) {
            if (entry.key == source) return entry.at;
            newest = Math.max(newest, entry.at);
            if (entry.names.length > 0) oldest = Math.min(oldest, entry.at);
        }
        return source != "" ? -60000 : Math.isFinite(oldest) ? oldest : newest;
    }
    /** Settle a complete observation batch before sending controls. No timers or lease renewal. */
    public function settle(now:Float):Void {
        waiting = false;
        if (!fresh(now)) {
            if (lastNames.length > 0 || session.room.length > 0) reset();
            return;
        }
        if (loading) return;
        var current = names(now);
        waiting = roster.waitForRoster(lastNames, current, now, 30000);
        if (waiting) return;
        var namesField = current.join("|");
        if (FcmCommand.shouldRebindRosterSession(lastNames, namesField)) {
            // Preserve only the evidence chosen by FcmRoster.sessionNames. Other cached
            // providers stay blocked until changed/pushed, so old-world names cannot return.
            var retained = [for (entry in snapshots) if (!entry.blocked && now - entry.at <= 30000) entry];
            var source = roster.sessionSource(now, 30000, lastNames);
            if (source.length > 0) retained = [for (entry in retained) if (entry.key == source) entry];
            reset();
            for (entry in retained) {
                entry.blocked = false;
                roster.replace(entry.key, entry.names, entry.at);
                observedAt = Math.max(observedAt, entry.at);
            }
        }
        lastNames = namesField;
    }
    /** Suppress both ROSTER and LEAVE while a bounded transition is unresolved. */
    public function holding(now:Float):Bool { return fresh(now) && (loading || waiting); }
}
