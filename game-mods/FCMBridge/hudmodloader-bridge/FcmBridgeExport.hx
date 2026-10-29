/** Pure rate/freshness policy. A heartbeat advances sequence, NEVER observationSequence. */
class FcmBridgeExport {
    public static inline var VERSION:String = "0.2.19";
    public static inline var BUILD:String = VERSION;
    public var sequence(default, null):Int = 0;
    public var observationSequence(default, null):Int = 1;
    public var lastSuccess(default, null):Bool = false;
    /** Pending samples and provider pushes cannot authorize a cosmetic world. */
    public var publishedWorld(default, null):String = "";
    #if bridge_nameplate_probe
    public var nameplateProbe:String = "start:none:r0:a0:j0";
    #end
    var sessionId:String;
    var environment:String;
    var lastAttempt:Float = -5000;
    var lastSaved:Float = -5000;
    var lastKey:String = "";
    var successfulWrites:Int = 0;
    var lastSavedObservationSequence:Int = 0;
    var lastObservation:Float = -60000;
    var lastWorld:String = "";
    var lastNames:Array<String> = [];
    var lastOwnName:String = "";
    var lastAliases:Array<String> = [];
    var lastSource:String = "none";
    var clock:Void->Float;
    var sample:{mode:String, world:String, ownName:String, names:Array<String>, aliases:Array<String>, source:String} = null;
    #if bridge_perf
    public var timing:FcmBridgeTiming;
    #end
    public function new(sessionId:String, environment:String, clock:Void->Float = null) {
        this.sessionId = sessionId; this.environment = environment; this.clock = clock;
        #if flash
        if (this.clock == null) this.clock = function() return flash.Lib.getTimer();
        #end
    }
    public function update(now:Float, state:FcmBridgeState, ownName:String, provider:String,
        save:String->Bool, inactive:Bool = false, accountName:String = ""):Bool {
        var world = state.session.requestId;
        var holding = state.holding(now);
        if (holding) ownName = lastOwnName;
        var evidenceAt = holding ? lastObservation : state.evidenceAt(now);
        var fresh = !inactive && ownName.length > 0 && state.fresh(now)
            && evidenceAt >= 0 && now - evidenceAt < 30000
            && (!holding || (world == lastWorld && now - lastObservation < 30000));
        var mode = !fresh ? "inactive" : state.holding(now) ? "holding" : "active";
        var names = !fresh ? [] : holding ? lastNames.copy() : state.names(now).slice(0, 24);
        var selfName = !fresh ? "" : holding ? lastOwnName : ownName;
        var aliases = !fresh ? [] : holding ? lastAliases.copy() : state.rosterAliases(now, selfName, accountName);
        var source = !fresh ? "none" : holding ? lastSource : state.rosterSource(now);
        if (fresh && !holding && (evidenceAt != lastObservation || world != lastWorld || names.join("|") != lastNames.join("|")
                || selfName != lastOwnName || aliases.join("|") != lastAliases.join("|") || source != lastSource)) {
            observationSequence++; lastObservation = evidenceAt; lastWorld = world;
            lastNames = names.copy();
            lastOwnName = selfName; lastAliases = aliases.copy(); lastSource = source;
        }
        sample = {mode:mode, world:world, ownName:selfName, names:names, aliases:aliases, source:source};
        return heartbeat(now, provider, save);
    }
    /** Only copied, settled batch data crosses heartbeat ticks. Provider pushes
     * may update live state between ticks but cannot export a new roster with an old generation. */
    public function heartbeat(now:Float, provider:String, save:String->Bool):Bool {
        if (sample == null || now - lastAttempt < 1000) return false;
        var fresh = sample.mode != "inactive" && now - lastObservation < 30000;
        var mode = fresh ? sample.mode : "inactive";
        var world = sample.world;
        var ownName = sample.ownName;
        var names = fresh ? sample.names : [];
        // xScal named storage can stall the HUD thread. Keep sampling every two
        // seconds, but publish an unchanged roster at most every five seconds.
        // The second successful fresh snapshot still establishes a live writer.
        var aliases = fresh ? sample.aliases : [];
        var source = fresh ? sample.source : "none";
        var key = haxe.Json.stringify([mode, world, ownName, names, aliases, source,
            provider == "xscal" ? 0 : observationSequence]);
        var establishingWriter = provider == "xscal" && successfulWrites == 1
            && observationSequence > lastSavedObservationSequence;
        if (key == lastKey && now - lastSaved < 5000 && !establishingWriter) return false;
        lastAttempt = now;
        #if bridge_nameplate_probe
        // Fixed gate/error labels and bounded lifetime counters only. Keep the
        // schema, single export and write cadence identical to the normal build.
        var build = BUILD + "-np:" + nameplateProbe.substr(0, 48);
        #elseif bridge_perf
        var encodeStarted = clock == null ? now : clock();
        var build = BUILD + "-c5" + (timing == null ? "-perf" : timing.label());
        #else
        var build = BUILD;
        #end
        var document = haxe.Json.stringify({schemaVersion:1, environment:environment, provider:provider,
            build:build, sessionId:sessionId, worldGeneration:world,
            sequence:++sequence, observationSequence:Std.int(Math.max(1, observationSequence)),
            observationAgeMs:Std.int(Math.min(60000, Math.max(0, now - lastObservation))),
            state:mode, ownName:fresh ? ownName.substr(0, 64) : "", names:names,
            ownAliases:aliases, rosterSource:source});
        #if bridge_perf
        // This write carries the previous encode/save samples; the next carries these timings.
        if (timing != null && clock != null) timing.encode(clock() - encodeStarted);
        #end
        lastSuccess = save(document);
        // Budget from completion, not the timer tick captured before native reads
        // and serialization. Variable work duration must never compress write spacing.
        if (clock != null) lastAttempt = Math.max(now, clock());
        if (lastSuccess) {
            lastSaved = lastAttempt; lastKey = key;
            publishedWorld = mode == "inactive" ? "" : world;
            lastSavedObservationSequence = observationSequence;
            successfulWrites++;
        }
        return true;
    }
}
