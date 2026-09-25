/** Exercise command submission and canonical giveaway rows in the compiled widget. */
@:access(FCMChatWidget)
class GiveawayScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var ready = new haxe.Timer(200);
        ready.run = function():Void {
            try {
                if (++attempts > 60) throw "giveaway setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                ready.stop();
                widget.handleSubmittedText("giveaway start Flux x10 5");
                var sent = new haxe.Timer(250);
                var sendAttempts = 0;
                sent.run = function():Void {
                    try {
                        if (++sendAttempts > 20) throw "giveaway send timed out";
                        if (MockXscal.lastGiveawayBody.length == 0) return;
                        sent.stop();
                        check("command routed to Events", MockXscal.lastGiveawayChannel == "events"
                            && MockXscal.lastGiveawayBody == "/giveaway start Flux x10 5");
                        for (record in widget._records)
                            check("no public command echo", record.body != MockXscal.lastGiveawayBody);
                        if (provider == "zfe" && widget._outbox.entries.length > 0) {
                            var id = widget._outbox.entries[0].id;
                            var receipt = haxe.Json.stringify({success:true, messageId:"sim-giveaway-receipt",
                                targetUserId:"FCMHUD/1;g=Giveaway%20started;q=" + StringTools.urlEncode(id)});
                            widget.parseAndRenderEvents(haxe.Json.stringify({success:true, events:[{
                                id:widget._cursor + 1, kind:"chat.message", channel:"system",
                                senderUserId:"system", senderDisplayName:"FCM",
                                body:"FCMACK/1;" + StringTools.urlEncode(receipt), targetUserId:""
                            }]}));
                            check("private command receipt consumed", widget._outbox.entries.length == 0);
                        }
                        var startId = widget._cursor + 1;
                        widget.parseAndRenderEvents(haxe.Json.stringify({success:true, events:[
                            {id:startId, kind:"chat.message", channel:"events", messageId:"giveaway-card-1",
                                senderUserId:"giveaway-bot", senderDisplayName:"[Vault-Tec]",
                                body:"🎁 Flux x10 giveaway [ABC234] — join with giveaway join ABC234", targetUserId:""},
                            {id:startId + 1, kind:"chat.message", channel:"events", messageId:"giveaway-winner-1",
                                senderUserId:"giveaway-bot", senderDisplayName:"[Vault-Tec]",
                                body:"🎉 Winner: Wastelander — Flux x10 [ABC234]", targetUserId:""}
                        ]}));
                        var cards = 0;
                        for (record in widget._records) if (record.messageId == "giveaway-card-1"
                                || record.messageId == "giveaway-winner-1") cards++;
                        check("announcement and winner are retained", cards == 2);
                        flash.Lib.trace("GIVEAWAY PASS " + provider);
                    } catch (error:Dynamic) {
                        sent.stop();
                        flash.Lib.trace("GIVEAWAY FAIL " + provider + " " + Std.string(error));
                    }
                };
            } catch (error:Dynamic) {
                ready.stop();
                flash.Lib.trace("GIVEAWAY FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
