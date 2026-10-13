import flash.display.DisplayObject;
import flash.display.Stage;
import flash.events.Event;
import flash.text.TextField;

/** Uses only the installed HUD's public TeammateMarkerBase/TeamNameplates/Name_tf surface.
 * No copied Bethesda/Text Chat classes, gameplay mutation, fonts or extra labels. */
class FcmNameplatePainter {
    var owner:DisplayObject;
    var frameStage:Stage = null;
    var presence:FcmNameplates;
    var host:Dynamic = null;
    var boundHost:Dynamic = null;
    var manager:Dynamic = null;
    var callback:Dynamic = null;
    var markers:Array<{id:Float, name:String, eligible:Bool}> = [];
    // Retain only the owned envelope identity, never native rows/payloads/events.
    var markerProvider:Dynamic = null;
    var markerObservedAt:Float = -1;
    var markerGeneration:Int = -1;
    var markerContext:String = "";
    var markerSource:String = "none";
    // Expiry closes acquisition. An already admitted visible field may continue
    // under current private presence and exact public identity/eligibility checks.
    // Neither that continuation nor cached reads renew markerObservedAt.
    var sourceExpired:Bool = false;
    var bindingGeneration:Int = 0;
    var observationSequence:Int = 0;
    var reconcilingRender:Bool = false;
    var painted:Array<{field:TextField, plate:Dynamic, id:Float, name:String, color:Int}> = [];
    var disposed:Bool = false;
    public var enabled:Bool = true;
    public var diagnostic(default, null):String = "waiting";
    public var automaticFrames(default, null):Int = 0;
    public var renderFrames(default, null):Int = 0;
    var bindCount:Int = 0;
    var pushCount:Int = 0;
    var snapshotCount:Int = 0;
    var observationCount:Int = 0;
    var subscribed:Bool = false;
    var bindingPhase:String = "waiting";
    var observationPhase:String = "waiting";
    var readyFlag:String = "missing";
    var testFlag:String = "missing";
    var rowCount:Int = -1;
    var skippedRows:Int = 0;
    var eligibleRows:Int = 0;
    var bindingError:Int = 0;
    var managerScope:String = "waiting";
    var domainRelation:String = "waiting";
    var domainError:Int = 0;
    var paintPhase:String = "waiting";
    var frameErrors:Int = 0;
    var renderErrors:Int = 0;
    var lastPaintErrorCode:Int = 0;
    var lastPaintErrorHook:String = "none";
    var lastPaintErrorPhase:String = "none";
    var clearCount:Int = 0;
    var lastClearReason:String = "none";
    var lastProbeAt:Float = -10000;
    var probeDiagnostic:String = "probe=waiting";
    var currentSourceState:String = "not-read";
    var privateMarkers:Int = 0;
    var visibleLabels:Int = 0;
    var privatePlateMatches:Int = 0;
    var currentRowMatches:Int = 0;
    var uniquePlateMatches:Int = 0;
    var exactLabelMatches:Int = 0;
    var retainedPlates:Int = 0;
    public function new(owner:DisplayObject, presence:FcmNameplates) {
        this.owner = owner; this.presence = presence;
        owner.addEventListener(Event.ADDED_TO_STAGE, attached);
        if (owner.stage != null) attached(null);
    }
    public function startFrames():Void { attached(null); }
    function attached(_:Event):Void {
        if (disposed || owner.stage == null || frameStage == owner.stage) return;
        if (frameStage != null) {
            frameStage.removeEventListener(Event.ENTER_FRAME, frame);
            frameStage.removeEventListener(Event.RENDER, afterNativeRedraw);
            clear("stage"); detach();
        }
        frameStage = owner.stage; frameStage.addEventListener(Event.ENTER_FRAME, frame);
        // Native BSDisplayObject schedules redraw on this same dispatcher at priority 0.
        frameStage.addEventListener(Event.RENDER, afterNativeRedraw, false, -10000);
        diagnostic = "frame attached";
    }
    static function field(value:Dynamic, name:String):Dynamic return FcmRoster.field(value, name);
    static function bump(value:Int):Int return value < 1000000 ? value + 1 : value;
    static function flag(value:Dynamic):String return value == null ? "missing" :
        !Std.isOfType(value, Bool) ? "other" : value == true ? "true" : "false";
    /** Fixed phases, booleans and bounded counts only; never native payloads or identities. */
    public function sourceDiagnostic():String {
        var age = markerObservedAt < 0 ? -1 : Std.int(Math.max(0,
            Math.min(30000, flash.Lib.getTimer() - markerObservedAt)));
        return "bound=" + (manager != null) + " subscribed=" + subscribed
            + " binds=" + bindCount + " pulls=" + snapshotCount + " pushes=" + pushCount
            + " observations=" + observationCount + " bindPhase=" + bindingPhase
            + " readPhase=" + observationPhase + " ready=" + readyFlag + " test=" + testFlag
            + " rows=" + rowCount + " skipped=" + skippedRows + " eligible=" + eligibleRows
            + " bindError=" + bindingError + " managerScope=" + managerScope
            + " hostManager=" + domainRelation + " domainError=" + domainError
            + " markerSource=" + markerSource + " markerAgeMs=" + age + " renderFrames=" + renderFrames
            + " frameErrors=" + frameErrors + " renderErrors=" + renderErrors
            + " lastPaintErrorCode=" + lastPaintErrorCode + " lastPaintErrorHook=" + lastPaintErrorHook
            + " lastPaintErrorPhase=" + lastPaintErrorPhase + " clearCount=" + clearCount
            + " lastClearReason=" + lastClearReason + " sourceExpired=" + sourceExpired
            + " currentSource=" + currentSourceState + " privateMarkers=" + privateMarkers
            + " visibleLabels=" + visibleLabels + " privatePlates=" + privatePlateMatches
            + " currentRows=" + currentRowMatches + " uniquePlates=" + uniquePlateMatches
            + " exactLabels=" + exactLabelMatches + " retained=" + retainedPlates + " " + probeDiagnostic;
    }
    public function isBoundTo(value:Dynamic):Bool return manager != null && manager == value;
    public function bind(next:Dynamic):Void {
        if (disposed) return;
        var before = bindingGeneration;
        var nextHost = findHost();
        var resolved = FcmNameplateSource.resolve(nextHost, next);
        if (disposed || bindingGeneration != before || findHost() != nextHost) return;
        next = resolved.manager; managerScope = resolved.scope;
        domainRelation = resolved.relation; domainError = resolved.error;
        // A failed Subscribe retains the resolved manager, but owns no healthy
        // listener. Retry that same manager without rebinding a healthy source.
        if (manager == next && boundHost == nextHost && subscribed) return;
        clear("binding"); detach(); manager = next; boundHost = nextHost; host = nextHost;
        if (manager == null) return;
        bindCount = bump(bindCount); bindingError = 0;
        var source = manager;
        var sourceHost = boundHost, epoch = bindingGeneration;
        callback = function(event:Dynamic):Void {
            if (!owns(source, sourceHost, epoch)) return;
            pushCount = bump(pushCount);
            var provider = field(event, "fromClient");
            observationPhase = provider == null ? "event-envelope-missing" : "event";
            observe(provider, event);
            if (owns(source, sourceHost, epoch)) probe(provider, event);
        };
        var listener = callback;
        var sequence = observationSequence;
        try {
            bindingPhase = "subscribe";
            source.Subscribe("TeamMarkers", listener);
            if (!owns(source, sourceHost, epoch)) {
                source.Unsubscribe("TeamMarkers", listener); return;
            }
            subscribed = true; bindingPhase = "snapshot";
            snapshotCount = bump(snapshotCount);
            var data = source.GetDataFromClient("TeamMarkers", false);
            // A getter or Subscribe can dispatch a newer event. An older snapshot cannot replace it.
            if (owns(source, sourceHost, epoch) && observationSequence == sequence) { observe(data); probe(data); }
            if (owns(source, sourceHost, epoch)) bindingPhase = "complete";
        }
        catch (error:Dynamic) {
            if (!owns(source, sourceHost, epoch) || observationSequence != sequence) return;
            var code:Dynamic = field(error, "errorID");
            bindingError = (Std.isOfType(code, Int) || Std.isOfType(code, Float)) && code >= 0 && code <= 1000000 ? Std.int(code) : 0;
            markers = []; markerProvider = null; markerSource = "none";
        }
    }
    function owns(source:Dynamic, sourceHost:Dynamic, epoch:Int):Bool {
        return !disposed && manager == source && boundHost == sourceHost
            && bindingGeneration == epoch && findHost() == sourceHost;
    }
    function probe(provider:Dynamic, event:Dynamic = null):Void {
        var now = flash.Lib.getTimer();
        if (disposed || !subscribed || now - lastProbeAt < 10000) return;
        lastProbeAt = now;
        // These comparisons cannot feed markers, freshness or presence authority.
        try { probeDiagnostic = FcmNameplateProbe.diagnostic(FcmNameplateProbe.sample(findHost(), manager, provider, event)); }
        catch (_:Dynamic) { probeDiagnostic = "probe=failed"; }
    }
    public function observe(provider:Dynamic, event:Dynamic = null):Void {
        if (disposed) return;
        observationCount = bump(observationCount);
        var sequence = ++observationSequence;
        var source = manager, sourceHost = boundHost, epoch = bindingGeneration;
        var generation = presence.generation, context = presence.context;
        // Explicit Dynamic preserves a missing/throwing accessor as null; inferred
        // Flash Boolean locals would coerce it to false and lose provenance.
        var ready:Dynamic = field(provider, "dataReady"), test:Dynamic = field(provider, "isTest");
        var valid = FcmNameplateObservation.isLive(provider);
        var mode = event == null ? "live-snapshot" : "live-event";
        if (!valid && event != null && subscribed && managerScope == "host-domain"
                && sourceHost != null && context != "" && owns(source, sourceHost, epoch)) {
            // Registration flags never become live. This separate cosmetic source
            // needs an owned fresh event AND exact canonical envelope/payload identity.
            try { valid = FcmNameplateObservation.isHostEvent(provider, event,
                source.GetDataFromClient("TeamMarkers", false)); }
            catch (_:Dynamic) { valid = false; }
            mode = "hud-event";
        }
        var result = valid ? FcmNameplateObservation.copy(field(provider, "data")) : null;
        if (!owns(source, sourceHost, epoch) || observationSequence != sequence
                || presence.generation != generation || presence.context != context) return;
        readyFlag = flag(ready); testFlag = flag(test);
        rowCount = result == null ? -1 : result.length; skippedRows = 0; eligibleRows = 0;
        observationPhase = !valid ? "not-live" : result == null ? "invalid-rows" : "complete";
        markers = result == null ? [] : result;
        for (row in markers) if (row.eligible) eligibleRows++;
        markerProvider = result == null ? null : provider;
        markerSource = result == null ? "none" : mode;
        markerObservedAt = result == null ? -1 : flash.Lib.getTimer();
        sourceExpired = false;
        markerGeneration = generation; markerContext = context;
    }
    function findHost():Dynamic {
        var current:Dynamic = owner;
        for (_ in 0...24) {
            if (current == null) break;
            if (field(current, "TeammateMarkerBase") != null) return current;
            current = field(current, "parent");
        }
        return null;
    }
    public function hasSurface():Bool return findHost() != null;
    function frame(_:Event):Void {
        automaticFrames++;
        try { paint(flash.Lib.getTimer()); }
        catch (error:Dynamic) { paintFailed(error, "frame"); }
    }
    function afterNativeRedraw(_:Event):Void {
        if (disposed) return;
        renderFrames++;
        reconcilingRender = true;
        try { paint(flash.Lib.getTimer()); }
        catch (error:Dynamic) { paintFailed(error, "render"); }
        reconcilingRender = false;
    }
    function paintFailed(error:Dynamic, hook:String):Void {
        if (hook == "frame") frameErrors = bump(frameErrors); else renderErrors = bump(renderErrors);
        lastPaintErrorCode = errorCode(error); lastPaintErrorHook = hook; lastPaintErrorPhase = paintPhase;
        diagnostic = hook + " error " + lastPaintErrorCode;
        // A rendering failure withdraws colors, not still-valid source evidence.
        // The next callback rechecks the original age, context, lease and public rows.
        restorePainted();
    }
    static function errorCode(error:Dynamic):Int {
        var n:Dynamic = field(error, "errorID");
        return (Std.isOfType(n, Int) || Std.isOfType(n, Float)) && Math.isFinite(n)
            && n >= 0 && n <= 1000000 && n == Math.floor(n) ? Std.int(n) : 0;
    }
    /** Current public rows can withdraw eligibility but can never renew source age. */
    function currentMarkers():Array<{id:Float, name:String, eligible:Bool}> {
        currentSourceState = "absent";
        if (markerProvider == null) return null;
        if (markerSource == "hud-event") {
            currentSourceState = "scope";
            if (managerScope != "host-domain" || boundHost == null) return null;
            var current:Dynamic = null;
            currentSourceState = "getter";
            try { current = manager.GetDataFromClient("TeamMarkers", false); }
            catch (_:Dynamic) { return null; }
            currentSourceState = "envelope";
            if (current != markerProvider) return null;
            var ready:Dynamic = field(current, "dataReady"), test:Dynamic = field(current, "isTest");
            currentSourceState = "flags";
            if (!Std.isOfType(ready, Bool) || !Std.isOfType(test, Bool) || ready != false || test != true) return null;
        } else {
            currentSourceState = "flags";
            if (!FcmNameplateObservation.isLive(markerProvider)) return null;
        }
        var rows = FcmNameplateObservation.copy(field(markerProvider, "data"));
        currentSourceState = rows == null ? "rows" : "valid";
        return rows;
    }
    function displayed(text:TextField):Bool {
        if (frameStage == null || text.stage != frameStage) return false;
        var current:DisplayObject = text;
        for (_ in 0...24) {
            if (current == frameStage) return true;
            if (current == null || !current.visible || current.alpha <= 0) return false;
            current = current.parent;
        }
        return false;
    }
    public function paint(now:Float):Void {
        if (disposed) return;
        paintPhase = "host"; diagnostic = "host";
        var next = findHost();
        if (host != next || (manager != null && boundHost != next)) { clear("host"); detach(); host = next; }
        if (markerProvider != null) {
            if (markerGeneration != presence.generation || markerContext != presence.context) {
                clear("context"); observationPhase = "retired";
            } else if (!sourceExpired && !FcmNameplateObservation.fresh(markerObservedAt, now)) {
                // Retire source acquisition at the original deadline. Preserve only
                // fields that were already admitted; every continuation below still
                // requires a current private lease, owned envelope, complete current
                // rows and the same visible public field/plate/entity/name.
                sourceExpired = true; markers = []; observationPhase = "retired";
                clearCount = bump(clearCount); lastClearReason = "source-expired";
            }
        }
        var source = manager, sourceHost = boundHost, epoch = bindingGeneration, sequence = observationSequence;
        var generation = presence.generation, context = presence.context;
        paintPhase = "lease"; diagnostic = "lease";
        var names = enabled ? presence.current(now) : [];
        currentSourceState = "not-read";
        var current = names.length > 0 ? currentMarkers() : null;
        if (!owns(source, sourceHost, epoch) || observationSequence != sequence
                || presence.generation != generation || presence.context != context) return;
        var active:Array<TextField> = [];
        privateMarkers = 0; visibleLabels = 0; privatePlateMatches = 0;
        currentRowMatches = 0; uniquePlateMatches = 0; exactLabelMatches = 0; retainedPlates = 0;
        for (marker in markers) if (marker.eligible && names.indexOf(marker.name) >= 0) privateMarkers++;
        paintPhase = "plates"; diagnostic = "plates";
        var plates:Dynamic = field(field(host, "TeammateMarkerBase"), "TeamNameplates");
        paintPhase = "length"; diagnostic = "length";
        var n:Dynamic = field(plates, "length");
        diagnostic = "names=" + names.length + " markers=" + markers.length + " plates=" + (n == null ? -1 : Std.int(n));
        paintPhase = "matching";
        if (names.length > 0 && current != null && (Std.isOfType(n, Int) || Std.isOfType(n, Float)) && n >= 0 && n <= 128 && n == Math.floor(n)) {
            for (i in 0...Std.int(n)) {
                var plate:Dynamic = field(plates, Std.string(i));
                var label:Dynamic = field(plate, "Name_tf");
                if (!Std.isOfType(label, TextField) || field(plate, "visible") != true || !displayed(cast label)) continue;
                visibleLabels++;
                var match = null;
                for (marker in markers) if (marker.id == field(plate, "entityID")) { match = marker; break; }
                if (sourceExpired) for (old in painted) {
                    if (old.field == label && old.plate == plate && old.id == field(plate, "entityID")) {
                        match = {id:old.id,name:old.name,eligible:true}; break;
                    }
                }
                if (match == null || !match.eligible || names.indexOf(match.name) < 0) continue;
                privatePlateMatches++;
                if (!FcmNameplateObservation.matches(current, match.id, match.name, names)) continue;
                currentRowMatches++;
                var identities = 0;
                for (j in 0...Std.int(n)) if (field(field(plates, Std.string(j)), "entityID") == match.id) identities++;
                if (identities != 1) continue;
                uniquePlateMatches++;
                var text:TextField = cast label;
                if (FcmNameplates.clean(text.text) != match.name) continue; // recycled or not yet redrawn
                exactLabelMatches++;
                if (!owns(source, sourceHost, epoch) || observationSequence != sequence
                        || presence.generation != generation || presence.context != context || presence.current(now) != names) return;
                var entry = null;
                for (old in painted) if (old.field == text) { entry = old; break; }
                if (entry != null && (entry.name != match.name || entry.id != match.id || entry.plate != plate)) {
                    restore(entry); removePainted(entry); entry = null;
                }
                if (entry == null) { entry = {field:text, plate:plate, id:match.id, name:match.name, color:Std.int(text.textColor)}; painted.push(entry); }
                else if (text.textColor != FcmNameplates.BLUE) entry.color = Std.int(text.textColor);
                if (text.textColor != FcmNameplates.BLUE) text.textColor = FcmNameplates.BLUE;
                active.push(text);
                if (sourceExpired) retainedPlates++;
            }
        }
        if (!owns(source, sourceHost, epoch) || observationSequence != sequence
                || presence.generation != generation || presence.context != context) return;
        paintPhase = "restore";
        for (entry in painted.copy()) if (active.indexOf(entry.field) < 0) { restore(entry); removePainted(entry); }
        if (sourceExpired && painted.length == 0) markerProvider = null;
        diagnostic += " painted=" + painted.length;
    }
    function removePainted(entry:{field:TextField, plate:Dynamic, id:Float, name:String, color:Int}):Void {
        // Array.remove uses Flash 19 removeAt at this SWF target; older GFx lacks it.
        var index = painted.indexOf(entry);
        if (index >= 0) painted.splice(index, 1);
    }
    function restore(entry:{field:TextField, plate:Dynamic, id:Float, name:String, color:Int}):Void {
        try {
            if (entry.field.textColor == FcmNameplates.BLUE) entry.field.textColor = entry.color;
            var dirty = field(entry.plate, "SetIsDirty");
            // Native BSDisplayObject asserts that redraw itself never dirties the plate.
            if (!reconcilingRender && Reflect.isFunction(dirty)) Reflect.callMethod(entry.plate, dirty, []);
        } catch (_:Dynamic) {}
    }
    function restorePainted():Void {
        var previous = painted; painted = [];
        for (entry in previous) restore(entry);
    }
    public function clear(reason:String = "explicit"):Void {
        lastClearReason = switch (reason) {
            case "binding", "stage", "host", "room", "auth", "gated", "context", "source-expired", "shutdown": reason;
            default: "explicit";
        };
        clearCount = bump(clearCount);
        observationSequence++;
        markers = []; markerProvider = null; markerObservedAt = -1;
        markerGeneration = -1; markerContext = ""; markerSource = "none";
        sourceExpired = false;
        restorePainted();
    }
    function detach():Void {
        var source = manager; var listener = callback;
        bindingGeneration++;
        manager = null; boundHost = null; callback = null; markers = [];
        markerProvider = null; markerObservedAt = -1; markerSource = "none";
        sourceExpired = false;
        subscribed = false; bindingPhase = "detached";
        if (source != null && listener != null) try { source.Unsubscribe("TeamMarkers", listener); } catch (_:Dynamic) {}
    }
    public function shutdown():Void {
        if (disposed) return;
        disposed = true; clear("shutdown"); detach(); owner.removeEventListener(Event.ADDED_TO_STAGE, attached);
        if (frameStage != null) {
            frameStage.removeEventListener(Event.ENTER_FRAME, frame);
            frameStage.removeEventListener(Event.RENDER, afterNativeRedraw);
        }
        frameStage = null; host = null;
    }
}
