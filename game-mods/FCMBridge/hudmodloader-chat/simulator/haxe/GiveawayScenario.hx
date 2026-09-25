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
                var beforeHelp = widget._records.length;
                widget.handleSubmittedText("/giveaway");
                widget.handleSubmittedText("giveaway");
                check("help is local to this widget", MockXscal.lastGiveawayBody.length == 0
                    && widget._records.length == beforeHelp + 2);
                var localHelp = widget._records[widget._records.length - 1];
                check("help is a private feed record", localHelp.user == "FCM Help"
                    && localHelp.senderUserId == "" && localHelp.messageId == ""
                    && localHelp.body.indexOf("giveaway join <id>") >= 0);
                check("help has a sortable timestamp", localHelp.createdAt.length > 0
                    && FcmFeedPlan.compareChronology(localHelp.createdAt, localHelp.arrivalOrder,
                        FcmFeedPlan.utcTimestamp(Date.fromTime(Date.now().getTime() + 1000)),
                        localHelp.arrivalOrder + 1) < 0);
                widget.handleSubmittedText("giveaway start Flux x10 5");
                var sent = new haxe.Timer(250);
                var sendAttempts = 0;
                sent.run = function():Void {
                    try {
                        if (++sendAttempts > 20) throw "giveaway send timed out";
                        if (MockXscal.lastGiveawayBody.length == 0 || widget._outbox.entries.length > 0) return;
                        sent.stop();
                        check("command stays in selected General channel", MockXscal.lastGiveawayChannel == "global"
                            && MockXscal.lastGiveawayBody == "/giveaway start Flux x10 5");
                        check("private command receipt shown without hiding feed",
                            widget._promptTf.text.indexOf("Giveaway started") >= 0 && widget._feedLayer.visible);
                        var renderedHelp = false;
                        for (row in widget._feedRows) if (row.textField != null
                                && row.textField.text.indexOf("GIVEAWAY COMMANDS") >= 0)
                            renderedHelp = true;
                        check("private help rendered in feed", renderedHelp && widget._feedLayer.visible);
                        for (record in widget._records)
                            check("no public command echo", record.body != MockXscal.lastGiveawayBody);
                        var startId = widget._cursor + 1;
                        var announcementAt = FcmFeedPlan.utcTimestamp(Date.fromTime(Date.now().getTime() + 1000));
                        var resultAt = FcmFeedPlan.utcTimestamp(Date.fromTime(Date.now().getTime() + 2000));
                        widget.parseAndRenderEvents(haxe.Json.stringify({success:true, events:[
                            {id:startId, kind:"chat.message", channel:"global", messageId:"giveaway-card-1",
                                senderUserId:"giveaway-bot", senderDisplayName:"[Vault-Tec]",
                                body:"🎁 Flux x10 giveaway [ABC234] — join with giveaway join ABC234",
                                createdAt:announcementAt, targetUserId:""},
                            {id:startId + 1, kind:"chat.message", channel:"global", messageId:"giveaway-winner-1",
                                senderUserId:"giveaway-bot", senderDisplayName:"[Vault-Tec]",
                                body:"🎉 Winner: Wastelander — Flux x10 [ABC234]",
                                createdAt:resultAt, targetUserId:""}
                        ]}));
                        var cards = 0;
                        for (record in widget._records) if (record.messageId == "giveaway-card-1"
                                || record.messageId == "giveaway-winner-1") cards++;
                        check("announcement and winner are retained", cards == 2);
                        var orderAttempts = 0;
                        var ordered = new haxe.Timer(100);
                        ordered.run = function():Void {
                            try {
                                if (++orderAttempts > 20) throw "giveaway feed order timed out";
                                var helpIndex = -1;
                                var cardIndex = -1;
                                var winnerIndex = -1;
                                for (i in 0...widget._feedRows.length) {
                                    var field = widget._feedRows[i].textField;
                                    if (field == null) continue;
                                    if (field.text.indexOf("GIVEAWAY COMMANDS") >= 0) helpIndex = i;
                                    if (field.text.indexOf("Flux x10 giveaway") >= 0) cardIndex = i;
                                    if (field.text.indexOf("Winner: Wastelander") >= 0) winnerIndex = i;
                                }
                                if (winnerIndex < 0) return;
                                ordered.stop();
                                check("new messages scroll after private help", helpIndex >= 0
                                    && cardIndex > helpIndex && winnerIndex > cardIndex);
                                flash.Lib.trace("GIVEAWAY PASS " + provider);
                            } catch (error:Dynamic) {
                                ordered.stop();
                                flash.Lib.trace("GIVEAWAY FAIL " + provider + " " + Std.string(error));
                            }
                        };
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
