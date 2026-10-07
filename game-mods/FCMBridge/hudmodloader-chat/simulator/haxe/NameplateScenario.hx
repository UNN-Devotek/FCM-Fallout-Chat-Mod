import flash.display.Sprite;
import flash.text.TextField;

/** Shared painter on sealed accessor-backed nameplates, exercised through the real HUD private-event path. */
@:access(FCMChatWidget)
class NameplateScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    public static function surface():Dynamic return {TeamNameplates:[new HarnessNameplate(11, "HarnessPeer"), new HarnessNameplate(12, "NonUser")]};
    public static function start(widget:FCMChatWidget, host:FCMHarness, provider:String):Void {
        var timer = new haxe.Timer(250); var attempts = 0;
        timer.run = function():Void {
            try {
                if (++attempts > 60) throw "setup timeout";
                if (!widget._connected || widget._authState != "authenticated") return;
                timer.stop(); widget.stopWorldTimer(); widget.stopPollTimer(); widget.stopServerHistoryDrain();
                widget._serverSession.begin("nameplates-world"); widget._serverSessionReady = true;
                var painter = widget._nameplatePainter, lease = widget._nameplatePresence;
                var plates:Array<HarnessNameplate> = cast host.TeammateMarkerBase.TeamNameplates;
                function observe(hostile:Bool = false, wanted:String = "notWanted"):Void {
                    painter.observe({dataReady:true,isTest:false,data:{Markers:[
                        {entityID:11,displayName:"HarnessPeer",isLocalPlayer:false,isHostile:hostile,playerState:"teammate",wantedState:wanted},
                        {entityID:12,displayName:"NonUser",isLocalPlayer:false,isHostile:false,playerState:"teammate",wantedState:"notWanted"}
                    ]}});
                }
                function deliver(world:String = "nameplates-world", ttl:Int = 10000):Void {
                    var request = lease.request(flash.Lib.getTimer(), world);
                    var parsed = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
                    var body = FcmNameplates.EVENT + haxe.Json.stringify({version:1,requestId:parsed.requestId,
                        context:lease.context,ttlMs:ttl,names:["harnesspeer"]});
                    widget.parseAndRenderEvents(haxe.Json.stringify({events:[{id:9000,kind:"chat.message",channel:"system",senderUserId:"system",body:body}]}));
                }
                observe(); deliver(); painter.paint(flash.Lib.getTimer());
                check("matching FCM name blue", plates[0].Name_tf.textColor == FcmNameplates.BLUE);
                check("nonuser normal", plates[1].Name_tf.textColor == 0xFFFFFF);
                check("private reply never a chat row", [for (record in widget._records) if (record.body.indexOf(FcmNameplates.EVENT) >= 0) record].length == 0);
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
                lease.reset(); deliver("next-world"); painter.paint(flash.Lib.getTimer());
                check("new world colors", plates[0].Name_tf.textColor == FcmNameplates.BLUE);
                widget.setServerSessionReady(false, "");
                check("leave immediately restores", plates[0].Name_tf.textColor == 0xDDBB44);
                lease.reset(); widget._serverSessionReady = true; deliver("last-world"); painter.paint(flash.Lib.getTimer());
                widget._cfg.blueNameplates = false; widget.updateNameplates();
                check("config opt-out restores", plates[0].Name_tf.textColor == 0xDDBB44);
                widget.shutdown();
                painter.paint(flash.Lib.getTimer());
                check("disposed never recolors", plates[0].Name_tf.textColor == 0xDDBB44);
                flash.Lib.trace("NAMEPLATES PASS " + provider);
            } catch (error:Dynamic) { timer.stop(); widget.shutdown(); flash.Lib.trace("NAMEPLATES FAIL " + provider + " " + Std.string(error)); }
        };
    }
}
@:keep private class HarnessNameplate extends Sprite {
    public var Name_tf:TextField = new TextField();
    var id:Int;
    public function new(id:Int, name:String) { super(); this.id = id; Name_tf.text = name; Name_tf.textColor = 0xFFFFFF; addChild(Name_tf); }
    @:getter(entityID) public function readId():Int return id;
    public function SetIsDirty():Void {}
}
