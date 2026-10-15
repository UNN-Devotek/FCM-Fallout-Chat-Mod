import flash.display.Sprite;
import flash.text.TextField;

/** Shared painter on sealed accessor-backed nameplates, exercised through the real HUD private-event path. */
@:access(FCMChatWidget)
@:access(FcmNameplatePainter)
class NameplateScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    public static function surface():Dynamic {
        return new HarnessNameplateSurface();
    }
    public static function start(widget:FCMChatWidget, host:FCMHarness, provider:String):Void {
        var timer = new haxe.Timer(250); var attempts = 0;
        timer.run = function():Void {
            try {
                if (++attempts > 60) throw "setup timeout";
                if (!widget._connected || widget._authState != "authenticated") return;
                timer.stop(); widget.stopWorldTimer(); widget.stopPollTimer(); widget.stopServerHistoryDrain();
                widget._serverSession.begin("nameplates-world"); widget._serverSessionReady = true;
                var painter = widget._nameplatePainter, lease = widget._nameplatePresence;
                var plates:flash.Vector<HarnessNameplate> = cast host.TeammateMarkerBase.TeamNameplates;
                lease.reset(); widget._inWorld = false; widget._serverAtMainMenu = false;
                widget.updateNameplates();
                check("out of world cannot request", lease.requestCount == 0 && widget.nameplateDiagnosticGate() == "world");
                widget._inWorld = true; widget._serverSessionReady = false; widget.updateNameplates();
                check("unconfirmed room cannot request", lease.requestCount == 0 && widget.nameplateDiagnosticGate() == "room");
                widget._serverSessionReady = true; widget._cfg.blueNameplates = false; widget.updateNameplates();
                check("disabled cannot request", lease.requestCount == 0 && widget.nameplateDiagnosticGate() == "disabled");
                widget._cfg.blueNameplates = true; widget.updateNameplates();
                check("active widget submits private request", lease.requestCount == 1
                    && widget.nameplateDiagnosticGate() == "active"
                    && StringTools.startsWith(MockXscal.lastNameplateControl, FcmNameplates.CONTROL));
                widget.updateNameplates(); check("normal update cadence", lease.requestCount == 1);
                var markerManager = MockBridgeGameData.manager();
                HarnessBSUIDataManager.use(markerManager);
                var staleChildManager:Dynamic = {
                    GetDataFromClient:function(_:String):Dynamic return new MockBridgeProvider({Markers:[]}, true, false),
                    Subscribe:function(_:String, _:Dynamic):Void {},
                    Unsubscribe:function(_:String, _:Dynamic):Void {}
                };
                painter.bind(staleChildManager);
                check("host domain wins over unready child manager", MockBridgeGameData.subscriptions() == 1);
                check("host source is reported without provider data", painter.sourceDiagnostic().indexOf("managerScope=host-domain hostManager=different domainError=0") >= 0);
                var priorBinds = painter.bindCount;
                painter.bind(staleChildManager);
                check("repeated fallback input does not rebind host subscription " + priorBinds + "/" + painter.bindCount,
                    MockBridgeGameData.subscriptions() == 1 && painter.bindCount == priorBinds);
                var priorObservations = painter.observationCount, priorPushes = painter.pushCount;
                function observe(hostile:Bool = false, wanted:String = "notWanted"):Void {
                    MockBridgeGameData.publish("TeamMarkers", {Markers:[
                        {entityID:11,displayName:"HarnessPeer",isLocalPlayer:false,isHostile:hostile,playerState:"teammate",wantedState:wanted},
                        {entityID:12,displayName:"NonUser",isLocalPlayer:false,isHostile:false,playerState:"teammate",wantedState:"notWanted"}
                    ]});
                }
                function deliver(world:String = "nameplates-world", ttl:Int = 10000, submitted:String = null):Void {
                    var request = submitted == null ? lease.request(flash.Lib.getTimer(), world) : submitted;
                    var parsed = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
                    var body = FcmNameplates.EVENT + haxe.Json.stringify({version:1,requestId:parsed.requestId,
                        context:lease.context,ttlMs:ttl,names:["harnesspeer"]});
                    widget.parseAndRenderEvents(haxe.Json.stringify({events:[{id:9000,kind:"chat.message",channel:"system",senderUserId:"system",body:body}]}));
                }
                observe(); deliver("nameplates-world", 10000, MockXscal.lastNameplateControl); painter.paint(flash.Lib.getTimer());
                check("matching FCM name blue", plates[0].Name_tf.textColor == FcmNameplates.BLUE);
                var sourceDiagnostic = painter.sourceDiagnostic();
                check("sealed provider push is counted and copied", sourceDiagnostic.indexOf("subscribed=true") >= 0
                    && painter.pushCount == priorPushes + 1 && painter.observationCount == priorObservations + 1
                    && sourceDiagnostic.indexOf("ready=true test=false rows=2 skipped=0 eligible=2") >= 0);
                var nativeProvider = markerManager.GetDataFromClient("TeamMarkers", false);
                var nativeEvent = new MockBridgeProvider.MockBridgeEvent(nativeProvider);
                var nativeProbe = FcmNameplateProbe.sample(host, markerManager, nativeProvider, nativeEvent);
                check("sealed event and provider ownership probe invokes accessors", nativeProbe.rows == 2
                    && nativeProbe.eligible == 2 && nativeProbe.plateMatches == 2
                    && nativeProbe.eventPayload == "same" && nativeProbe.getterPayload == "same"
                    && nativeProbe.readyArity == 1);
                widget._lastNameplateDiagnosticAt = -1e12; widget.logNameplateDiagnostic();
                var diagnostic = MockXscal.SimLog.last;
                check("native diagnostic shows accepted reply and painted label", diagnostic.indexOf("gate=active") >= 0
                    && diagnostic.indexOf("accepted=1") >= 0 && diagnostic.indexOf("painted=1") >= 0);
                check("native diagnostic excludes names and context", diagnostic.indexOf("HarnessPeer") < 0
                    && diagnostic.indexOf("harnesspeer") < 0 && diagnostic.indexOf("nameplates-world") < 0);
                var logCount = MockXscal.SimLog.count; widget.logNameplateDiagnostic();
                check("native diagnostic cadence", MockXscal.SimLog.count == logCount);
                check("nonuser normal", plates[1].Name_tf.textColor == 0xFFFFFF);
                check("private reply never a chat row", [for (record in widget._records) if (record.body.indexOf(FcmNameplates.EVENT) >= 0) record].length == 0);
                var rows = {Markers:[{entityID:11,displayName:"HarnessPeer",isLocalPlayer:false,isHostile:false,playerState:"teammate",wantedState:"notWanted"}]};
                var placeholder = new MockBridgeProvider(rows, true, false);
                painter.lastProbeAt = -10000;
                var probeReads = MockBridgeGameData.readCount;
                MockBridgeGameData.push("TeamMarkers", placeholder); painter.paint(flash.Lib.getTimer());
                sourceDiagnostic = painter.sourceDiagnostic();
                check("populated placeholder is diagnosed without authorizing paint", plates[0].Name_tf.textColor == 0xFFFFFF
                    && sourceDiagnostic.indexOf("ready=false test=true") >= 0
                    && sourceDiagnostic.indexOf("probeRows=1 probeEligible=1 probePlates=1 eventPayload=same getterPayload=different") >= 0
                    && MockBridgeGameData.readCount == probeReads + 2);
                check("probe preserves original flags", FcmRoster.field(placeholder, "dataReady") == false
                    && FcmRoster.field(placeholder, "isTest") == true);
                probeReads = MockBridgeGameData.readCount;
                MockBridgeGameData.push("TeamMarkers", placeholder);
                check("native probe cadence bounds cached reads", MockBridgeGameData.readCount == probeReads + 1);
                for (secret in ["HarnessPeer", "PrivateCharacter", "entityID", "displayName"])
                    check("native probe never logs private evidence", sourceDiagnostic.indexOf(secret) < 0);
                MockBridgeGameData.push("TeamMarkers", new MockBridgeProvider(rows, false, false)); painter.paint(flash.Lib.getTimer());
                check("unready envelope cannot paint", plates[0].Name_tf.textColor == 0xFFFFFF
                    && painter.sourceDiagnostic().indexOf("readPhase=not-live ready=false test=false") >= 0);
                MockBridgeGameData.push("TeamMarkers", new MockBridgeProvider(rows, true)); painter.paint(flash.Lib.getTimer());
                check("test envelope cannot paint", plates[0].Name_tf.textColor == 0xFFFFFF
                    && painter.sourceDiagnostic().indexOf("ready=true test=true") >= 0);
                MockBridgeGameData.push("TeamMarkers", {dataReady:true,data:rows}); painter.paint(flash.Lib.getTimer());
                check("missing test flag cannot paint", plates[0].Name_tf.textColor == 0xFFFFFF
                    && painter.sourceDiagnostic().indexOf("ready=true test=missing") >= 0);
                MockBridgeGameData.push("TeamMarkers", new ThrowingNameplateProvider()); painter.paint(flash.Lib.getTimer());
                check("throwing accessor cannot paint or leak " + painter.sourceDiagnostic() + " color=" + plates[0].Name_tf.textColor, plates[0].Name_tf.textColor == 0xFFFFFF
                    && painter.sourceDiagnostic().indexOf("ready=missing") >= 0
                    && painter.sourceDiagnostic().indexOf("Private") < 0);
                MockBridgeGameData.push("TeamMarkers", new MockBridgeProvider(rows)); painter.paint(flash.Lib.getTimer());
                check("fresh sealed event replaces stale getter snapshot", plates[0].Name_tf.textColor == FcmNameplates.BLUE);
                plates[0].Name_tf.textColor = 0xDDBB44; painter.paint(flash.Lib.getTimer());
                check("vanilla redraw repainted", plates[0].Name_tf.textColor == FcmNameplates.BLUE);
                observe(true); painter.paint(flash.Lib.getTimer());
                check("hostile restoration uses latest base", plates[0].Name_tf.textColor == 0xDDBB44);
                observe(false, "wanted"); painter.paint(flash.Lib.getTimer());
                check("wanted normal", plates[0].Name_tf.textColor != FcmNameplates.BLUE);
                observe(); painter.paint(flash.Lib.getTimer());
                plates[0].Name_tf.text = "RecycledPlayer"; painter.paint(flash.Lib.getTimer());
                check("recycled label normal", plates[0].Name_tf.textColor != FcmNameplates.BLUE);
                plates[0].Name_tf.text = "HarnessPeer"; painter.paint(flash.Lib.getTimer());
                check("valid recycled slot repaints", plates[0].Name_tf.textColor == FcmNameplates.BLUE);
                painter.paint(flash.Lib.getTimer() + 10001);
                check("expiry restores color", plates[0].Name_tf.textColor == 0xDDBB44);
                lease.reset(); deliver("next-world"); observe(); painter.paint(flash.Lib.getTimer());
                check("new world colors", plates[0].Name_tf.textColor == FcmNameplates.BLUE);
                widget.setServerSessionReady(false, "");
                check("leave immediately restores", plates[0].Name_tf.textColor == 0xDDBB44);
                lease.reset(); widget._serverSessionReady = true; deliver("last-world"); observe(); painter.paint(flash.Lib.getTimer());
                widget._cfg.blueNameplates = false; widget.updateNameplates();
                check("config opt-out restores", plates[0].Name_tf.textColor == 0xDDBB44);
                painter.shutdown();
                HarnessBSUIDataManager.use(null);
                // A detached owner has no host domain; keep the existing fallback/error checks.
                painter = new FcmNameplatePainter(new Sprite(), lease);
                MockBridgeGameData.subscribeErrorKey = "TeamMarkers";
                painter.bind(MockBridgeGameData.manager());
                sourceDiagnostic = painter.sourceDiagnostic();
                check("subscription failure records fixed phase and numeric error", sourceDiagnostic.indexOf("subscribed=false") >= 0
                    && sourceDiagnostic.indexOf("bindPhase=subscribe") >= 0 && sourceDiagnostic.indexOf("bindError=1006") >= 0
                    && sourceDiagnostic.indexOf("Private") < 0);
                MockBridgeGameData.subscribeErrorKey = ""; MockBridgeGameData.readErrorKey = "TeamMarkers";
                painter.bind(MockBridgeGameData.manager());
                sourceDiagnostic = painter.sourceDiagnostic();
                check("snapshot failure records fixed phase and numeric error", sourceDiagnostic.indexOf("subscribed=true") >= 0
                    && sourceDiagnostic.indexOf("bindPhase=snapshot") >= 0 && sourceDiagnostic.indexOf("bindError=1014") >= 0
                    && sourceDiagnostic.indexOf("Private") < 0);
                MockBridgeGameData.readErrorKey = "";
                painter.shutdown();
                widget.shutdown();
                check("marker subscription removed on shutdown", MockBridgeGameData.subscriptions() == 0);
                logCount = MockXscal.SimLog.count; widget.logNameplateDiagnostic();
                check("disposed diagnostic is silent", MockXscal.SimLog.count == logCount);
                painter.paint(flash.Lib.getTimer());
                check("disposed never recolors", plates[0].Name_tf.textColor == 0xDDBB44);
                flash.Lib.trace("NAMEPLATES PASS " + provider);
            } catch (error:Dynamic) { timer.stop(); widget.shutdown(); HarnessBSUIDataManager.use(null); flash.Lib.trace("NAMEPLATES FAIL " + provider + " " + Std.string(error)); }
        };
    }
}
@:keep private class ThrowingNameplateProvider {
    public function new() {}
    @:getter(dataReady) public function readReady():Bool throw new flash.errors.Error("Private accessor payload", 1014);
    @:getter(isTest) public function readTest():Bool return false;
}
@:keep private class HarnessNameplate extends Sprite {
    public var NamePlateNameGroup_mc:Sprite = new Sprite();
    public var Name_tf:TextField = new TextField();
    var id:Int;
    public function new(id:Int, name:String) { super(); this.id = id; Name_tf.text = name; Name_tf.textColor = 0xFFFFFF; NamePlateNameGroup_mc.addChild(Name_tf); addChild(NamePlateNameGroup_mc); }
    @:getter(entityID) public function readId():Int return id;
    public function SetIsDirty():Void {}
}
@:keep private class HarnessNameplateSurface extends Sprite {
    public var TeamNameplates:flash.Vector<HarnessNameplate> = new flash.Vector<HarnessNameplate>();
    public function new() {
        super();
        TeamNameplates.push(new HarnessNameplate(11, "HarnessPeer")); TeamNameplates.push(new HarnessNameplate(12, "NonUser"));
        for (plate in TeamNameplates) addChild(plate);
    }
}
