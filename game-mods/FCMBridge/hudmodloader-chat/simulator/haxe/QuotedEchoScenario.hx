/** Quoted chat must reconcile the optimistic row with its JSON-escaped authoritative echo. */
@:access(FCMChatWidget)
class QuotedEchoScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts:Int = 0;
        var ready = new haxe.Timer(250);
        ready.run = function():Void {
            try {
                if (++attempts > 60) throw "quoted echo setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                ready.stop();
                var localSendId = "quoted-fixture-local";
                var body = 'I found "Bertha"';
                check("fixture outbox", widget._outbox.add(localSendId, "global", body,
                    widget._outboxIdentity, "", flash.Lib.getTimer()));
                widget._outbox.attempted(localSendId, flash.Lib.getTimer());
                widget.addOptimisticEcho("global", body, "quoted-fixture-message", "", false, "",
                    "sim-linked-user", localSendId);
                widget.parseAndRenderEvents('{"success":true,"events":[{"id":1,'
                    + '"kind":"chat.message","channel":"global","messageId":"quoted-fixture-message",'
                    + '"senderUserId":"sim-linked-user","senderDisplayName":"Simulator76",'
                    + '"body":"I found \\\"Bertha\\\""}]}');
                var matching = [];
                for (record in widget._records) if (record.body.indexOf("Bertha") >= 0) matching.push(record);
                check("one canonical quoted row", matching.length == 1);
                check("quoted body decoded", matching[0].body == body);
                check("authoritative echo replaced pending row", !matching[0].pending);
                flash.Lib.trace("QUOTED-ECHO PASS " + provider);
            } catch (error:Dynamic) {
                ready.stop();
                flash.Lib.trace("QUOTED-ECHO FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
