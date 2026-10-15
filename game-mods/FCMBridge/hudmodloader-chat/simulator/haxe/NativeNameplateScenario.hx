import flash.display.Sprite;
import flash.display.Stage;
import flash.events.Event;
import flash.text.TextField;

/** Native registration anomaly, public display correlation and deferred redraw.
 * Authentication and cosmetic replies still pass through the actual HUD widget. */
@:access(FCMChatWidget)
@:access(FcmNameplatePainter)
@:access(FcmNameplates)
@:access(MockBridgeProvider)
class NativeNameplateScenario {
    var widget:FCMChatWidget;
    var host:FCMHarness;
    var provider:String;
    var timer:haxe.Timer;
    var painter:FcmNameplatePainter;
    var lease:FcmNameplates;
    var faultLease:OneShotNameplateLease;
    var nativeSurface:NativeNameplateSurface;
    var manager:Dynamic;
    var phase:Int = 0;
    var attempts:Int = 0;
    var recordId:Int = 9100;
    var priorRedraws:Int = 0;
    var priorDirtyCalls:Int = 0;
    var priorFrames:Int = 0;
    var priorRenderFrames:Int = 0;
    var redrawCycles:Int = 0;
    var expectedNativeColor:Int = 0xDDBB44;
    var expiryCalls:Int = 0;
    var expireListener:Event->Void = null;
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    public static function surface():Dynamic return new NativeNameplateSurface();
    public static function start(widget:FCMChatWidget, host:FCMHarness, provider:String):Void {
        new NativeNameplateScenario(widget, host, provider);
    }
    function new(widget:FCMChatWidget, host:FCMHarness, provider:String) {
        this.widget = widget; this.host = host; this.provider = provider;
        timer = new haxe.Timer(250); timer.run = tick;
    }
    function plate():NativeNameplate return nativeSurface.TeamNameplates[0];
    function isBlue():Bool return plate().Name_tf.textColor == FcmNameplates.BLUE;
    static function row(id:Float = 11, name:String = "HarnessPeer", hostile:Bool = false, wanted:String = "notWanted"):Dynamic {
        return {entityID:id,displayName:name,isLocalPlayer:false,isHostile:hostile,playerState:"teammate",wantedState:wanted};
    }
    function anomaly(payload:Dynamic):MockBridgeProvider return new MockBridgeProvider(payload, true, false);
    function publish(payload:Dynamic):MockBridgeProvider {
        var envelope = anomaly(payload); MockBridgeGameData.publishProvider("TeamMarkers", envelope); return envelope;
    }
    function paint():Void painter.paint(flash.Lib.getTimer());
    function grant(context:String = "native-nameplates-world"):Void {
        // Only fixture scheduling is accelerated; the real parser validates request/context/TTL.
        lease.nextRequest = 0;
        var request = lease.request(flash.Lib.getTimer(), context);
        check("private request available", request != "");
        var parsed = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
        var body = FcmNameplates.EVENT + haxe.Json.stringify({version:1,requestId:parsed.requestId,
            context:lease.context,ttlMs:10000,names:["harnesspeer"]});
        var accepted = lease.acceptedCount;
        widget.parseAndRenderEvents(haxe.Json.stringify({events:[{id:++recordId,kind:"chat.message",channel:"system",senderUserId:"system",body:body}]}));
        check("actual widget accepts private cosmetic reply", lease.acceptedCount == accepted + 1);
    }
    function owned():MockBridgeProvider return publish({Markers:[row(), row(12, "NonUser")]});
    function system(body:String):Void {
        widget.parseAndRenderEvents(haxe.Json.stringify({events:[{id:++recordId,kind:"chat.message",channel:"system",senderUserId:"system",body:body}]}));
    }
    function linkNoticeRetirement():Void {
        grant(); owned(); paint(); check("link notice begins with active blue lease", isBlue());
        // Keep the existing lease active while a renewal is pending. Its delayed
        // reply must remain unusable even after the link gate is cleared again.
        lease.nextRequest = 0;
        var request = lease.request(flash.Lib.getTimer(), "native-nameplates-world");
        var parsed = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
        var staleBody = FcmNameplates.EVENT + haxe.Json.stringify({version:1,requestId:parsed.requestId,
            context:lease.context,ttlMs:10000,names:["harnesspeer"]});
        var generation = lease.generation, accepted = lease.acceptedCount;
        system("Link required: relink your FCM account.");
        check("system link-required notice immediately retires colors and evidence", !isBlue()
            && widget._needsLink && lease.context == "" && lease.names.length == 0
            && lease.generation > generation && painter.markers.length == 0);
        check("link retirement records a fixed auth clear reason", diagnosticValue("lastClearReason", painter.sourceDiagnostic()) == "auth");
        system(staleBody);
        check("old private reply cannot cross a raised link gate", lease.acceptedCount == accepted
            && lease.context == "" && lease.names.length == 0);
        system("LINK COMPLETE");
        check("actual link-complete notice clears the link gate", !widget._needsLink
            && widget._authState == "authenticated");
        paint(); check("link confirmation alone cannot revive retired evidence", !isBlue());
        var rejected = lease.rejectedCount;
        system(staleBody); paint();
        check("old pending reply stays rejected after fresh link confirmation", lease.acceptedCount == accepted
            && lease.rejectedCount == rejected + 1 && lease.context == "" && lease.names.length == 0 && !isBlue());
        grant(); paint(); check("fresh private lease still requires a post-link marker event", !isBlue());
        owned(); paint(); check("fresh linked lease and fresh marker event recover blue", isBlue());
        flash.Lib.trace("NATIVE-NAMEPLATES LINK PASS " + provider + " retirement=immediate stale=rejected recovery=fresh");
    }
    function sameManagerSubscribeRetry():Void {
        painter.clear(); painter.detach();
        var baseline = MockBridgeGameData.subscriptions();
        var attempts = 0, installed = 0, removed = 0;
        var ownedListener:Dynamic = null;
        var stable:Dynamic = {
            GetDataFromClient:function(key:String, create:Bool = true):Dynamic return manager.GetDataFromClient(key, create),
            Subscribe:function(key:String, listener:Dynamic):Void {
                attempts++;
                if (attempts == 1) throw new flash.errors.Error("Transient fixture subscribe failure", 1014);
                check("retry installs only one exact owned listener", key == "TeamMarkers" && ownedListener == null);
                manager.Subscribe(key, listener); ownedListener = listener; installed++;
            },
            Unsubscribe:function(key:String, listener:Dynamic):Void {
                manager.Unsubscribe(key, listener);
                if (listener == ownedListener) { ownedListener = null; removed++; }
            }
        };
        HarnessBSUIDataManager.use(stable);
        var failure:Dynamic = null;
        try {
            painter.bind(stable);
            var firstManager = painter.manager, firstHost = painter.boundHost;
            check("failed Subscribe leaves no owned listener", attempts == 1 && installed == 0 && !painter.subscribed
                && painter.bindingError == 1014 && MockBridgeGameData.subscriptions() == baseline);
            painter.bind(stable);
            check("exact same manager retries failed own subscription", attempts == 2 && installed == 1 && painter.subscribed
                && painter.manager == firstManager && painter.boundHost == firstHost
                && MockBridgeGameData.subscriptions() == baseline + 1);
            owned(); paint(); check("fresh owned event paints after same-manager retry", isBlue());
            // Set an older, still-valid timestamp to catch even an immediate
            // healthy rebind that would otherwise reuse the same timer value.
            painter.markerObservedAt = flash.Lib.getTimer() - 1000;
            var observedAt = painter.markerObservedAt, observations = painter.observationCount, binds = painter.bindCount;
            painter.bind(stable); painter.bind(stable); paint();
            check("healthy identical binds preserve subscription and source age", attempts == 2 && installed == 1
                && MockBridgeGameData.subscriptions() == baseline + 1 && painter.bindCount == binds
                && painter.observationCount == observations && painter.markerObservedAt == observedAt && isBlue());
        } catch (error:Dynamic) { failure = error; }
        painter.clear(); painter.detach();
        var balanced = ownedListener == null && installed == removed && MockBridgeGameData.subscriptions() == baseline;
        HarnessBSUIDataManager.use(manager); painter.bind(manager); owned(); paint();
        if (failure != null) throw failure;
        check("retry and detach balance the exact owned subscription", balanced && installed == 1 && removed == 1);
        flash.Lib.trace("NATIVE-NAMEPLATES SUBSCRIBE PASS " + provider + " manager=same retry=owned healthy=stable unload=balanced");
    }
    function reviewRegressions():Void {
        var failures:Array<String> = [];
        try { linkNoticeRetirement(); }
        catch (error:Dynamic) {
            failures.push(Std.string(error));
            // Restore only the fixture's auth state so the independent retry
            // regression can expose its own failure in the same red run.
            widget._needsLink = false; widget._authState = "authenticated";
            lease.reset(); grant(); owned(); paint();
        }
        try { sameManagerSubscribeRetry(); }
        catch (error:Dynamic) { failures.push(Std.string(error)); }
        try { overlappingPrivateReplies(); }
        catch (error:Dynamic) { failures.push(Std.string(error)); }
        try { requestFailureDiagnostics(); }
        catch (error:Dynamic) { failures.push(Std.string(error)); }
        try { legacyArrayCleanup(); }
        catch (error:Dynamic) { failures.push(Std.string(error)); }
        try { transientPaintRecovery(); }
        catch (error:Dynamic) { failures.push(Std.string(error)); }
        try { stationaryRetention(); }
        catch (error:Dynamic) { failures.push(Std.string(error)); }
        if (failures.length > 0) throw failures.join("; ");
    }
    /** Advance source age and private request time together without extending a lease. */
    function grantAt(now:Float, names:Array<String> = null):Void {
        lease.nextRequest = 0;
        var request = lease.request(now, "native-nameplates-world");
        var parsed = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
        check("logical-time private lease passes the real parser", lease.accept(FcmNameplates.EVENT
            + haxe.Json.stringify({version:1,requestId:parsed.requestId,context:lease.context,
                ttlMs:10000,names:names == null ? ["harnesspeer"] : names}), now));
    }
    function stationaryRetention():Void {
        lease.reset(); grant(); owned(); paint();
        check("stationary fixture begins with an admitted visible plate", isBlue());
        var observedAt = painter.markerObservedAt, pushes = painter.pushCount;
        var now = observedAt + FcmNameplateObservation.MAX_AGE + 1;
        grantAt(now); painter.paint(now);
        check("unchanged visible admission survives marker expiry with a fresh private lease", isBlue());
        check("retention never renews marker source or manufactures a push", painter.markerObservedAt == observedAt
            && painter.pushCount == pushes);
        for (i in 1...25) {
            grantAt(now + i * 5000); painter.paint(now + i * 5000);
            check("stationary continuation follows fresh bounded leases for two modeled minutes", isBlue()
                && painter.markerObservedAt == observedAt && painter.pushCount == pushes);
        }
        now += 120000;
        plate().Name_tf.textColor = 0xDDBB44; painter.paint(now + 1);
        check("stationary retention reapplies after vanilla recolor", isBlue());
        grantAt(now + 1, ["harnesspeer", "nonuser"]); painter.paint(now + 1);
        check("expired source cannot admit another newly eligible private peer", nativeSurface.TeamNameplates[1].Name_tf.textColor != FcmNameplates.BLUE);
        var diag = painter.sourceDiagnostic();
        check("stationary diagnostics distinguish retired acquisition from current admission",
            diagnosticValue("sourceExpired", diag) == "true" && diagnosticValue("currentSource", diag) == "valid"
            && diagnosticCount("retained", diag) == 1 && diagnosticCount("privatePlates", diag) == 1
            && diagnosticCount("exactLabels", diag) == 1);
        plate().NamePlateNameGroup_mc.visible = false; painter.paint(now + 2);
        check("hidden stationary admission retires immediately", !isBlue());
        plate().NamePlateNameGroup_mc.visible = true; painter.paint(now + 3);
        check("expired source cannot acquire a new or previously retired admission", !isBlue());
        lease.reset(); grant(); owned(); paint();
        now = painter.markerObservedAt + FcmNameplateObservation.MAX_AGE + 1;
        grantAt(now); painter.paint(now);
        painter.paint(now + 10000);
        check("stationary retention ends at original private submission deadline", !isBlue());
        for (mode in ["hostile", "wanted", "renamed", "removed", "flags", "recycled", "duplicate", "withdrawn"]) {
            lease.reset(); grant();
            var payload:Dynamic = {Markers:[row(), row(12, "NonUser")]};
            var envelope = publish(payload); paint();
            now = painter.markerObservedAt + FcmNameplateObservation.MAX_AGE + 1;
            grantAt(now); painter.paint(now);
            check("stationary " + mode + " fixture is admitted", isBlue());
            switch (mode) {
                case "hostile": payload.Markers[0].isHostile = true;
                case "wanted": payload.Markers[0].wantedState = "wanted";
                case "renamed": payload.Markers[0].displayName = "RecycledPlayer";
                case "removed": payload.Markers = [row(12, "NonUser")];
                case "flags": envelope.ready = true;
                case "recycled": plate().setId(99);
                case "duplicate": nativeSurface.TeamNameplates[1].setId(11);
                case "withdrawn": grantAt(now + 1, []);
            }
            painter.paint(now + 1);
            check("stationary " + mode + " change immediately retires admission", !isBlue());
            plate().setId(11); nativeSurface.TeamNameplates[1].setId(12);
        }
        lease.reset(); grant(); owned(); paint();
        now = painter.markerObservedAt + FcmNameplateObservation.MAX_AGE + 1;
        grantAt(now); painter.paint(now);
        lease.reset(); grantAt(now + 1); painter.paint(now + 1);
        check("same-context reset cannot inherit stationary admission", !isBlue());
        lease.reset(); grant(); owned(); paint();
        flash.Lib.trace("NATIVE-NAMEPLATES STATIONARY PASS " + provider
            + " admitted=retained source=not-renewed hidden=retired acquisition=fresh lease=bounded");
    }
    /** Injected boundary errors validate diagnostics; they do not reproduce GFx verification. */
    function captureRequestFault():Void {
        try { widget.updateNameplates(); }
        catch (error:Dynamic) { widget.logWorldPollFailure(error); }
    }
    function requestFailureDiagnostics():Void {
        grant(); owned(); paint();
        var observations = painter.observationCount, age = painter.markerObservedAt;
        var generation = lease.generation, accepted = lease.acceptedCount;
        var requests = lease.requestCount, expires = lease.expiresAt;
        var room = widget._serverSession.room, requestId = widget._serverSession.requestId;
        for (failurePhase in ["retired", "pruning-call", "queuing-call", "encoding-call"]) {
            faultLease.requestFailurePhase = failurePhase;
            faultLease.requestFailureMessage = "private-request-fixture-message";
            faultLease.throwRequest = true;
            captureRequestFault();
            var diagnostic = MockXscal.SimLog.last;
            check("request fault reaches isolated world catch", !faultLease.throwRequest
                && diagnostic.indexOf("isolated timer exception phase=nameplates-request") >= 0);
            check("request fault records its own fixed stage", diagnostic.indexOf("requestPhase=" + failurePhase) >= 0);
            check("unrecognized request exception text stays private", diagnostic.indexOf("errorID=E1014") >= 0
                && diagnostic.indexOf("missingClass=not-reported") >= 0
                && diagnostic.indexOf("private-request-fixture-message") < 0);
            check("request diagnosis preserves original lease and evidence", lease.generation == generation
                && lease.requestCount == requests && lease.acceptedCount == accepted && lease.expiresAt == expires
                && painter.markerObservedAt == age && painter.observationCount == observations);
            check("request diagnosis preserves current native room authority", widget._serverSession.room == room
                && widget._serverSession.requestId == requestId && widget._serverSessionReady);
        }
        faultLease.requestFailurePhase = "retired";
        faultLease.requestFailureMessage = "Class fixture.Missing could not be found.";
        faultLease.throwRequest = true; captureRequestFault();
        check("canonical VM class identifier is extracted without message", MockXscal.SimLog.last.indexOf("missingClass=fixture.Missing") >= 0
            && MockXscal.SimLog.last.indexOf(" could not be found.") < 0);
        faultLease.requestFailureMessage += " private-request-fixture-message";
        faultLease.throwRequest = true; captureRequestFault();
        check("appended private exception text rejects class template", MockXscal.SimLog.last.indexOf("missingClass=not-reported") >= 0
            && MockXscal.SimLog.last.indexOf("private-request-fixture-message") < 0);
        grant(); owned(); paint();
        flash.Lib.trace("NATIVE-NAMEPLATES REQUEST-DIAGNOSTICS PASS " + provider + " phases=fixed exception=private class=allowlisted lease=unchanged");
    }
    /** Real registered stage callbacks own exception handling; the fixture only
     * substitutes a local lease read that throws once without changing evidence. */
    function stagePaint(hook:String):Void {
        host.stage.dispatchEvent(new Event(hook == "frame" ? Event.ENTER_FRAME : Event.RENDER));
    }
    function overlappingPrivateReplies():Void {
        grant(); owned(); paint();
        function pendingReply(names:Array<String>):String {
            lease.nextRequest = 0;
            var request = lease.request(flash.Lib.getTimer(), "native-nameplates-world");
            var parsed = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
            return FcmNameplates.EVENT + haxe.Json.stringify({version:1,requestId:parsed.requestId,
                context:lease.context,ttlMs:10000,names:names});
        }
        var first = pendingReply(["harnesspeer"]), second = pendingReply([]);
        var accepted = lease.acceptedCount, age = painter.markerObservedAt, generation = lease.generation;
        system(first); stagePaint("frame");
        check("actual parser accepts an unexpired prior reply while renewal is pending", lease.acceptedCount == accepted + 1 && isBlue());
        check("reply overlap does not renew or reset marker evidence", painter.markerObservedAt == age && lease.generation == generation);
        system(second); stagePaint("frame");
        check("newer empty reply immediately restores vanilla color", lease.acceptedCount == accepted + 2 && !isBlue());
        var rejected = lease.rejectedCount;
        system(first); stagePaint("frame");
        check("older reply cannot revive after newer withdrawal", lease.rejectedCount == rejected + 1 && !isBlue());
        first = pendingReply([]); second = pendingReply(["harnesspeer"]);
        system(second); stagePaint("render"); check("newer positive reply paints", isBlue());
        rejected = lease.rejectedCount;
        system(first); stagePaint("render");
        check("older withdrawal cannot overwrite newer positive presence", lease.rejectedCount == rejected + 1 && isBlue());
        grant(); owned(); paint();
        flash.Lib.trace("NATIVE-NAMEPLATES OVERLAP PASS " + provider + " previous=accepted newest=authoritative replay=rejected age=unchanged");
    }
    function legacyArrayCleanup():Void {
        var failures:Array<String> = [];
        for (mode in ["expiry", "recycled"]) {
            try {
                grant(); owned(); paint(); check("legacy cleanup starts painted", isBlue());
                var unavailableCalls = 0;
                // Haxe's dynamic remove helper delegates to Flash 19 removeAt.
                // Replace only that helper on the fixture-owned paint array;
                // sealed Ruffle builtins and the global prototype stay intact.
                untyped painter.painted["remove"] = function(_:Dynamic):Bool {
                    unavailableCalls++;
                    throw new flash.errors.Error("private-legacy-array-fixture", 1006);
                };
                var errors = painter.frameErrors;
                if (mode == "expiry") lease.expiresAt = flash.Lib.getTimer() - 1;
                else painter.painted[0].name = "fixture-old-name";
                stagePaint("frame");
                check("legacy " + mode + " cleanup never invokes unavailable removeAt", unavailableCalls == 0
                    && painter.frameErrors == errors);
                check("legacy " + mode + " cleanup retains the correct native color", mode == "expiry" ? !isBlue() : isBlue());
            } catch (error:Dynamic) { failures.push(Std.string(error)); }
            painter.clear(); grant(); owned(); paint();
        }
        if (failures.length > 0) throw failures.join("; ");
        flash.Lib.trace("NATIVE-NAMEPLATES LEGACY-CLEANUP PASS " + provider + " expiry=restored recycled=repainted removeAt=unused");
    }
    function failLeaseRead(hook:String):Void {
        var failures = faultLease.failures;
        faultLease.throwNext = true;
        stagePaint(hook);
        check("actual " + hook + " callback consumes one transient lease-read fault", faultLease.failures == failures + 1 && !faultLease.throwNext);
        check("actual " + hook + " fault immediately restores vanilla colors", !isBlue());
    }
    function diagnosticValue(key:String, diagnostic:String):String {
        var prefix = key + "=";
        for (part in diagnostic.split(" ")) if (StringTools.startsWith(part, prefix)) return part.substr(prefix.length);
        return "";
    }
    function diagnosticCount(key:String, diagnostic:String):Int {
        var raw = diagnosticValue(key, diagnostic), value = Std.parseInt(raw);
        check("lasting " + key + " diagnostic is a bounded integer", value != null && Std.string(value) == raw && value >= 0 && value <= 1000000);
        return cast value;
    }
    function transientPaintRecovery():Void {
        var failures:Array<String> = [];
        for (hook in ["frame", "render"]) {
            try {
                grant(); owned(); paint(); check("transient " + hook + " recovery begins with a blue plate", isBlue());
                var at = painter.markerObservedAt, generation = painter.markerGeneration, context = painter.markerContext;
                var envelope = painter.markerProvider, source = painter.markerSource;
                var pushes = painter.pushCount, observations = painter.observationCount;
                var before = painter.sourceDiagnostic();
                failLeaseRead(hook);
                check("transient " + hook + " fault preserves validated source without renewal", painter.markerProvider == envelope
                    && painter.markerObservedAt == at && painter.markerGeneration == generation && painter.markerContext == context
                    && painter.markerSource == source && painter.markers.length > 0 && painter.pushCount == pushes
                    && painter.observationCount == observations);
                var failed = painter.sourceDiagnostic();
                check("transient " + hook + " error is recorded with fixed numeric phase evidence",
                    diagnosticValue("lastPaintErrorCode", failed) == "1034"
                    && diagnosticValue("lastPaintErrorHook", failed) == hook && diagnosticValue("lastPaintErrorPhase", failed) == "lease"
                    && diagnosticCount(hook + "Errors", failed) == diagnosticCount(hook + "Errors", before) + 1
                    && diagnosticCount(hook == "frame" ? "renderErrors" : "frameErrors", failed)
                        == diagnosticCount(hook == "frame" ? "renderErrors" : "frameErrors", before)
                    && diagnosticCount("clearCount", failed) == diagnosticCount("clearCount", before)
                    && diagnosticValue("lastClearReason", failed) == diagnosticValue("lastClearReason", before));
                stagePaint(hook);
                check("successful " + hook + " callback revalidates and repaints without a new native push", isBlue()
                    && painter.markerObservedAt == at && painter.markerProvider == envelope && painter.pushCount == pushes
                    && painter.observationCount == observations);
                var recovered = painter.sourceDiagnostic();
                for (key in ["frameErrors", "renderErrors", "lastPaintErrorCode", "lastPaintErrorHook", "lastPaintErrorPhase", "clearCount", "lastClearReason"])
                    check("successful " + hook + " recovery preserves lasting diagnostic " + key,
                        diagnosticValue(key, recovered) == diagnosticValue(key, failed));
                for (secret in ["private-paint-fixture-message", "HarnessPeer", "harnesspeer", "entityID", "paint-fixture", "native-nameplates-world"])
                    check("lasting paint-error diagnostics exclude private data", recovered.indexOf(secret) < 0);
            } catch (error:Dynamic) {
                failures.push(Std.string(error));
                faultLease.throwNext = false; painter.clear(); grant(); owned(); paint();
            }
        }
        if (failures.length > 0) throw failures.join("; ");

        grant(); owned(); paint(); painter.markerObservedAt = flash.Lib.getTimer() - 30001;
        failLeaseRead("frame"); stagePaint("frame");
        check("paint-fault recovery cannot revive expired marker evidence", !isBlue() && painter.markerProvider == null);
        check("source expiry records its reason and absent source age", diagnosticValue("lastClearReason", painter.sourceDiagnostic()) == "source-expired"
            && diagnosticValue("markerAgeMs", painter.sourceDiagnostic()) == "-1");
        grant(); stagePaint("render"); check("a fresh private reply cannot renew expired marker evidence after a fault", !isBlue());

        grant(); owned(); paint(); var at = painter.markerObservedAt, envelope = painter.markerProvider;
        lease.expiresAt = flash.Lib.getTimer() - 1;
        failLeaseRead("render"); stagePaint("frame");
        check("paint-fault recovery cannot revive an expired private lease", !isBlue() && lease.names.length == 0
            && painter.markerObservedAt == at && painter.markerProvider == envelope);

        grant(); owned(); paint(); var generation = painter.markerGeneration;
        lease.reset(); grant();
        failLeaseRead("frame"); stagePaint("render");
        check("paint-fault recovery cannot cross a same-context reset", lease.generation > generation
            && !isBlue() && painter.markerProvider == null);
        check("same-context reset records a fixed context clear reason", diagnosticValue("lastClearReason", painter.sourceDiagnostic()) == "context");
        owned(); stagePaint("frame"); check("a fresh event recovers after fault and context reset", isBlue());
        var observedAt = flash.Lib.getTimer() - 1234;
        painter.markerObservedAt = observedAt;
        var reportedAge = Std.parseInt(diagnosticValue("markerAgeMs", painter.sourceDiagnostic()));
        check("source-age diagnostic reports bounded age without renewing it", reportedAge != null && reportedAge >= 1234
            && reportedAge <= 30000 && painter.markerObservedAt == observedAt);
        painter.frameErrors = 1000000; painter.renderErrors = 1000000; painter.clearCount = 1000000;
        failLeaseRead("frame"); stagePaint("frame"); failLeaseRead("render"); stagePaint("render");
        painter.clear("private-paint-fixture-message");
        var bounded = painter.sourceDiagnostic();
        check("paint and clear diagnostics saturate without integer overflow", diagnosticCount("frameErrors", bounded) == 1000000
            && diagnosticCount("renderErrors", bounded) == 1000000 && diagnosticCount("clearCount", bounded) == 1000000);
        check("unrecognized clear reason cannot leak private text", diagnosticValue("lastClearReason", bounded) == "explicit"
            && bounded.indexOf("private-paint-fixture-message") < 0);
        grant(); owned(); paint();
        flash.Lib.trace("NATIVE-NAMEPLATES PAINT-RECOVERY PASS " + provider + " frame=recovered render=recovered age=unchanged expiry=fenced reset=fenced");
    }
    function begin():Void {
        widget.stopWorldTimer(); widget.stopPollTimer(); widget.stopServerHistoryDrain();
        widget._serverSession.begin("native-nameplates-world"); widget._serverSessionReady = true;
        widget._inWorld = true; widget._serverAtMainMenu = false;
        painter = widget._nameplatePainter;
        faultLease = new OneShotNameplateLease("paint-fixture");
        lease = faultLease; widget._nameplatePresence = lease; painter.presence = lease;
        nativeSurface = cast host.TeammateMarkerBase;
        lease.reset(); widget.updateNameplates();
        manager = MockBridgeGameData.manager(); HarnessBSUIDataManager.use(manager); painter.bind(manager);
        grant();
        check("native vector and full public display tree attached", plate().stage == host.stage
            && plate().Name_tf.parent == plate().NamePlateNameGroup_mc && plate().parent == nativeSurface);
        var payload:Dynamic = {Markers:[row(), row(12, "NonUser")]};
        var envelope = anomaly(payload);
        MockBridgeGameData.publishProvider("TeamMarkers", envelope); paint();
        check("owned populated registration anomaly paints matching native plate", isBlue());
        check("original registration flags preserved", FcmRoster.field(envelope, "dataReady") == false && FcmRoster.field(envelope, "isTest") == true);
        check("nonusers retain vanilla color", nativeSurface.TeamNameplates[1].Name_tf.textColor == 0xFFFFFF);
        check("private reply never enters history", [for (r in widget._records) if (r.body.indexOf(FcmNameplates.EVENT) >= 0) r].length == 0);
        var upperId:UInt = cast 4294967294.0;
        plate().setId(upperId);
        publish({Markers:[row(4294967294.0), row(12, "NonUser")]}); paint();
        check("native uint getter retains upper-range ID and matches owned row", FcmRoster.field(plate(), "entityID") == 4294967294.0 && isBlue());
        plate().setId(11); owned(); paint();

        painter.clear(); painter.observe(envelope); paint();
        check("snapshot alone cannot admit registration anomaly", !isBlue());
        owned(); paint(); check("fresh owned event restores admission", isBlue());
        MockBridgeGameData.push("TeamMarkers", anomaly({Markers:[row()]})); paint();
        check("divergent getter envelope rejected", !isBlue());
        var ownedEnvelope = owned(); paint();
        painter.observe(ownedEnvelope, {fromClient:ownedEnvelope,data:{Markers:[row()]}}); paint();
        check("divergent event payload rejected", !isBlue());
        var invalidProviders:Array<Dynamic> = [new MockBridgeProvider({Markers:[row()]}, true, true),
                new MockBridgeProvider({Markers:[row()]}, false, false),
                {data:{Markers:[row()]},dataReady:false},
                {data:{Markers:[row()]},isTest:true},
                {data:{Markers:[row()]},dataReady:"false",isTest:true}];
        for (bad in invalidProviders) {
            MockBridgeGameData.publishProvider("TeamMarkers", bad); paint();
            check("test/live/missing/malformed flags do not enter native anomaly path", !isBlue());
        }
        var detached = new FcmNameplatePainter(new Sprite(), lease);
        detached.bind(manager); MockBridgeGameData.publishProvider("TeamMarkers", envelope);
        check("fallback source cannot admit registration anomaly", detached.markers.length == 0);
        detached.shutdown(); owned(); paint();

        publish({Markers:[row(), row(11, "NonUser")]}); paint(); check("duplicate row IDs rejected", !isBlue());
        publish({Markers:[row(11, "")]}); paint(); check("empty normalized names rejected", !isBlue());
        nativeSurface.TeamNameplates[1].setId(11); nativeSurface.TeamNameplates[1].Name_tf.text = "HarnessPeer";
        owned(); paint(); check("duplicate native plate IDs rejected", !isBlue() && nativeSurface.TeamNameplates[1].Name_tf.textColor != FcmNameplates.BLUE);
        nativeSurface.TeamNameplates[1].setId(12); nativeSurface.TeamNameplates[1].Name_tf.text = "NonUser";
        owned(); plate().NamePlateNameGroup_mc.visible = false; paint(); check("hidden name group rejected", !isBlue());
        plate().NamePlateNameGroup_mc.visible = true; owned(); plate().Name_tf.visible = false; paint(); check("hidden text rejected", !isBlue());
        plate().Name_tf.visible = true; owned(); nativeSurface.visible = false; paint(); check("hidden plate ancestor rejected", !isBlue());
        nativeSurface.visible = true; owned(); host.visible = false; paint(); check("hidden host ancestor rejected", !isBlue());
        host.visible = true; owned(); plate().visible = false; paint(); check("hidden plate rejected", !isBlue());
        plate().visible = true; owned(); plate().Name_tf.text = "RecycledPlayer"; paint(); check("recycled label rejected", !isBlue());
        plate().Name_tf.text = "HarnessPeer";
        owned(); plate().Name_tf.text = "HarnessPeer $$InConversation"; paint();
        check("native conversation suffix cannot replace exact displayed identity", !isBlue());
        plate().Name_tf.text = "HarnessPeer"; owned(); paint(); check("ordinary exact name recovers after conversation suffix", isBlue());
        flash.Lib.trace("NATIVE-NAMEPLATES IDENTITY PASS " + provider + " uint=upper-range conversation=exact-only");

        payload = {Markers:[row()]}; publish(payload); paint(); check("fresh native event admitted before mutations", isBlue());
        payload.Markers[0].isHostile = true; paint(); check("in-place hostility revokes without push", !isBlue());
        payload = {Markers:[row()]}; publish(payload); paint(); payload.Markers[0].wantedState = "wanted"; paint();
        check("in-place wanted state revokes without push", !isBlue());
        payload = {Markers:[row()]}; publish(payload); paint(); payload.Markers = []; paint();
        check("in-place row removal revokes without push", !isBlue());

        owned(); paint(); var savedSurface = host.TeammateMarkerBase;
        host.TeammateMarkerBase = null; paint(); host.TeammateMarkerBase = savedSurface; painter.bind(manager); paint();
        check("host disappearance retires marker evidence", !isBlue());
        owned(); paint(); check("fresh event restores host evidence", isBlue());
        var generation = lease.generation; lease.reset(); grant(); paint();
        check("same-context reset fences marker evidence", lease.generation > generation && !isBlue());
        owned(); paint(); check("same-context fresh marker reopens", isBlue());
        grant("next-native-world"); paint(); check("context change fences prior markers", !isBlue());
        owned(); paint(); check("new context requires and accepts new push", isBlue());
        grant(); owned(); paint();
        MockBridgeGameData.onRead = function():Void { lease.reset(); grant(); };
        owned(); paint(); check("reset during getter read fences in-flight observation", !isBlue());
        owned(); paint();
        MockBridgeGameData.onRead = function():Void { owned(); };
        publish({Markers:[row(12, "NonUser")]}); paint();
        check("newer nested push wins over older getter continuation", isBlue()
            && painter.markers.length > 0 && painter.markers[0].name == "harnesspeer");

        owned(); paint(); check("auth retirement begins with active blue lease", isBlue());
        generation = lease.generation;
        widget.moderationError("auth_token_revoked", "");
        check("terminal auth error immediately retires colors and evidence", !isBlue()
            && !widget._connected && lease.context == "" && lease.names.length == 0
            && lease.generation > generation && painter.markers.length == 0);
        widget.stopConnectRetry(); widget._connected = true; widget._authState = "authenticated"; widget._needsLink = false;
        grant(); owned(); paint(); check("fresh auth and marker event recover after revocation", isBlue());
        generation = lease.generation;
        var deniedId = "native-nameplate-denied";
        check("async auth fixture queued", widget._outbox.add(deniedId, "general", "auth-retirement-fixture", "native-fixture", "", flash.Lib.getTimer()));
        widget._zfePendingSends.set(9317, deniedId);
        widget.applyZfeAsyncCompletion('{"kind":"chat.send.failed","requestId":9317,"error":{"code":"permission_denied"}}', false);
        check("async permission denial immediately retires colors and evidence", !isBlue()
            && widget._needsLink && lease.context == "" && lease.names.length == 0
            && lease.generation > generation && painter.markers.length == 0 && widget._outbox.get(deniedId) == null);
        widget.stopConnectRetry(); widget._connected = true; widget._authState = "authenticated"; widget._needsLink = false;
        grant(); owned(); paint(); check("fresh auth and marker event recover after permission denial", isBlue());
        flash.Lib.trace("NATIVE-NAMEPLATES AUTH PASS " + provider + " terminal=immediate async-denied=immediate recovery=fresh");
        reviewRegressions();

        owned(); paint(); var aged = flash.Lib.getTimer() - 30001; painter.markerObservedAt = aged;
        manager.GetDataFromClient("TeamMarkers", false);
        var current = manager.GetDataFromClient("TeamMarkers", false);
        painter.lastProbeAt = -10000; painter.probe(current, new MockBridgeProvider.MockBridgeEvent(current));
        grant(); paint();
        check("30s source acquisition expiry survives getters/probe/frames/new private lease", isBlue()
            && painter.sourceExpired && painter.markers.length == 0 && painter.markerObservedAt == aged);
        plate().NamePlateNameGroup_mc.visible = false; paint();
        plate().NamePlateNameGroup_mc.visible = true; paint();
        check("expired cached observation cannot reacquire a retired visible field", !isBlue());
        owned(); paint(); check("new event renews expired marker evidence", isBlue());
        var diag = painter.sourceDiagnostic();
        for (secret in ["HarnessPeer", "harnesspeer", "entityID", "native-nameplates-world", "next-native-world"])
            check("native diagnostics remain count-only", diag.indexOf(secret) < 0);
        flash.Lib.trace("NATIVE-NAMEPLATES MATRIX PASS " + provider + " source=owned expiry=bounded invalid=restored generation=fenced");

        priorRedraws = plate().redrawCount; priorRenderFrames = painter.renderFrames;
        plate().setBase(0xDDBB44); phase = 1;
    }
    function tick():Void {
        try {
            if (++attempts > 60) throw "setup/render timeout";
            if (phase == 0) {
                if (!widget._connected || widget._authState != "authenticated") return;
                begin(); return;
            }
            if (phase == 1) {
                if (plate().redrawCount <= priorRedraws) return;
                check("deferred native redraw leaves final blue", isBlue() && painter.renderFrames > priorRenderFrames);
                check("vanilla color was actually assigned by deferred redraw", plate().lastVanillaColor == expectedNativeColor);
                if (++redrawCycles < 12) {
                    priorRedraws = plate().redrawCount; priorRenderFrames = painter.renderFrames;
                    expectedNativeColor = redrawCycles % 2 == 0 ? 0xDDBB44 : 0xFFFFFF;
                    plate().setBase(expectedNativeColor); return;
                }
                flash.Lib.trace("NATIVE-NAMEPLATES REDRAW-STRESS PASS " + provider + " cycles=12 final=blue");
                priorRedraws = plate().redrawCount;
                expireListener = function(_:Event):Void {
                    host.stage.removeEventListener(Event.RENDER, expireListener);
                    expiryCalls++; lease.expiresAt = flash.Lib.getTimer() - 1;
                };
                host.stage.addEventListener(Event.RENDER, expireListener, false, 100);
                plate().SetIsDirty(); priorDirtyCalls = plate().dirtyCount; phase = 2; return;
            }
            if (phase == 2) {
                if (plate().redrawCount <= priorRedraws || expiryCalls == 0) return;
                check("RENDER expiry restores native color", !isBlue() && Std.int(plate().Name_tf.textColor) == expectedNativeColor);
                check("RENDER restoration never schedules dirty loop", plate().dirtyCount == priorDirtyCalls && expiryCalls == 1);
                grant(); owned(); paint(); check("fresh reply and push repaint after expiry", isBlue());
                widget.shutdown(); priorFrames = painter.automaticFrames; priorRenderFrames = painter.renderFrames;
                priorRedraws = plate().redrawCount; plate().setBase(0xEEBB11); phase = 3; return;
            }
            if (phase == 3) {
                if (plate().redrawCount <= priorRedraws) return;
                check("unload removes frame and RENDER hooks", painter.automaticFrames == priorFrames && painter.renderFrames == priorRenderFrames);
                check("unloaded painter never recolors after native redraw", plate().Name_tf.textColor == 0xEEBB11);
                check("marker subscription removed", MockBridgeGameData.subscriptions() == 0);
                flash.Lib.trace("NATIVE-NAMEPLATES RENDER PASS " + provider + " native=deferred final=blue expiry=no-loop unload=clean");
                finish(); flash.Lib.trace("NATIVE-NAMEPLATES PASS " + provider);
            }
        } catch (error:Dynamic) { finish(); flash.Lib.trace("NATIVE-NAMEPLATES FAIL " + provider + " " + Std.string(error)); }
    }
    function finish():Void {
        timer.stop(); MockBridgeGameData.onRead = null; host.visible = true;
        if (expireListener != null && host.stage != null) host.stage.removeEventListener(Event.RENDER, expireListener);
        if (nativeSurface != null) nativeSurface.cleanup();
        widget.shutdown(); HarnessBSUIDataManager.use(null);
    }
}

/** Test-only failure at a public FCM lease boundary. Its private error text must
 * never be copied to production diagnostics or used as source evidence. */
@:access(FcmNameplates)
private class OneShotNameplateLease extends FcmNameplates {
    public var throwNext:Bool = false;
    public var failures(default, null):Int = 0;
    public var throwRequest:Bool = false;
    public var requestFailurePhase:String = "retired";
    public var requestFailureMessage:String = "";
    public function new(seed:String) { super(seed); }
    override public function request(now:Float, nativeRequestId:String = "", session:String = "", world:String = ""):String {
        if (throwRequest) {
            throwRequest = false; requestPhase = requestFailurePhase;
            throw new flash.errors.Error(requestFailureMessage, 1014);
        }
        return super.request(now, nativeRequestId, session, world);
    }
    override public function current(now:Float):Array<String> {
        if (throwNext) {
            throwNext = false; failures++;
            throw new flash.errors.Error("private-paint-fixture-message", 1034);
        }
        return super.current(now);
    }
}

@:keep private class NativeNameplateSurface extends Sprite {
    public var TeamNameplates:flash.Vector<NativeNameplate> = new flash.Vector<NativeNameplate>();
    public function new() {
        super();
        for (entry in [{id:11,name:"HarnessPeer"}, {id:12,name:"NonUser"}]) {
            var plate = new NativeNameplate(entry.id, entry.name); TeamNameplates.push(plate); addChild(plate);
        }
    }
    public function cleanup():Void { for (plate in TeamNameplates) plate.cleanup(); }
}

/** Sealed native-style public getter and nested display tree. Dirty redraw occurs
 * on a later stage RENDER event at vanilla/default priority, never synchronously. */
@:keep private class NativeNameplate extends Sprite {
    public var NamePlateNameGroup_mc:Sprite = new Sprite();
    public var Name_tf:TextField = new TextField();
    public var dirtyCount(default, null):Int = 0;
    public var redrawCount(default, null):Int = 0;
    public var lastVanillaColor(default, null):Int = 0xFFFFFF;
    var id:UInt;
    var baseColor:Int = 0xFFFFFF;
    var redrawStage:Stage = null;
    public function new(id:UInt, name:String) {
        super(); this.id = id; Name_tf.text = name; Name_tf.textColor = baseColor;
        NamePlateNameGroup_mc.addChild(Name_tf); addChild(NamePlateNameGroup_mc);
    }
    @:getter(entityID) public function readId():UInt return id;
    public function setId(value:UInt):Void { id = value; }
    public function setBase(color:Int):Void { baseColor = color; SetIsDirty(); }
    public function SetIsDirty():Void {
        dirtyCount++;
        if (redrawStage == null && stage != null) { redrawStage = stage; stage.addEventListener(Event.RENDER, redraw); stage.invalidate(); }
    }
    function redraw(_:Event):Void {
        redrawStage.removeEventListener(Event.RENDER, redraw); redrawStage = null;
        lastVanillaColor = baseColor; Name_tf.textColor = baseColor; redrawCount++;
    }
    public function cleanup():Void {
        if (redrawStage != null) redrawStage.removeEventListener(Event.RENDER, redraw);
        redrawStage = null;
    }
}
