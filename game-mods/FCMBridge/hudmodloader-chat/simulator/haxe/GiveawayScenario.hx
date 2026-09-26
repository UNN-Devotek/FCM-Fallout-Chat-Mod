/** Exercise command submission and canonical giveaway rows in the compiled widget. */
@:access(FCMChatWidget)
class GiveawayScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    static function waitForPrivateReply(widget:FCMChatWidget, provider:String, command:String,
            expected:String, next:Void->Void):Void {
        var before = widget._records.length;
        widget.handleSubmittedText(command);
        var attempts = 0;
        var timer = new haxe.Timer(250);
        timer.run = function():Void {
            try {
                if (++attempts > 60) throw "giveaway reply timed out: " + command;
                if (MockXscal.lastGiveawayBody != "/" + command
                        || widget._outbox.entries.length > 0 || widget._records.length <= before
                        || !widget._feedLayer.visible) return;
                timer.stop();
                var reply = widget._records[widget._records.length - 1];
                check("reply stays in local feed: " + command + " body=" + reply.body
                    + " channel=" + reply.channel + " user=" + reply.user
                    + " local=" + reply.localSendId + " sender=" + reply.senderUserId
                    + " id=" + reply.messageId + " feed=" + widget._feedLayer.visible, reply.body.indexOf(expected) >= 0
                    && reply.channel == "global" && reply.user == "[Vault-Tec]"
                    && reply.messageId == "" && reply.senderUserId == ""
                    && StringTools.startsWith(reply.localSendId, "giveaway-private-")
                    && widget._feedLayer.visible);
                check("command is never echoed publicly", reply.body != "/" + command);
                next();
            } catch (error:Dynamic) {
                timer.stop();
                flash.Lib.trace("GIVEAWAY FAIL " + provider + " " + Std.string(error));
            }
        };
    }

    static function announceWinner(widget:FCMChatWidget, provider:String):Void {
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
                body:"🎉 Giveaway winner: Wastelander! Prize: Flux x10 [ABC234]",
                createdAt:resultAt, targetUserId:""}
        ]}));
        var cards = 0;
        for (record in widget._records) if (record.messageId == "giveaway-card-1"
                || record.messageId == "giveaway-winner-1") {
            cards++;
            check("winner is a channel bot message", record.channel == "global"
                && record.user == "[Vault-Tec]" && record.senderUserId == "giveaway-bot");
        }
        check("announcement and winner are retained", cards == 2);
        var orderAttempts = 0;
        var ordered = new haxe.Timer(100);
        ordered.run = function():Void {
            try {
                if (++orderAttempts > 20) throw "giveaway feed order timed out";
                var hudHelpIndex = -1;
                var helpIndex = -1;
                var joinedIndex = -1;
                var ownIndex = -1;
                var cardIndex = -1;
                var winnerIndex = -1;
                for (i in 0...widget._feedRows.length) {
                    var field = widget._feedRows[i].textField;
                    if (field == null) continue;
                    if (field.text.indexOf("HUD COMMANDS") >= 0) hudHelpIndex = i;
                    if (field.text.indexOf("GIVEAWAY COMMANDS") >= 0) helpIndex = i;
                    if (field.text.indexOf("You've entered giveaway") >= 0) joinedIndex = i;
                    if (field.text.indexOf("can't enter your own giveaway") >= 0) ownIndex = i;
                    if (field.text.indexOf("Flux x10 giveaway") >= 0) cardIndex = i;
                    if (field.text.indexOf("Giveaway winner: Wastelander") >= 0) winnerIndex = i;
                }
                if (winnerIndex < 0) return;
                ordered.stop();
                check("private replies and winner scroll chronologically", hudHelpIndex >= 0
                    && helpIndex > hudHelpIndex
                    && joinedIndex > helpIndex && ownIndex > joinedIndex
                    && cardIndex > ownIndex && winnerIndex > cardIndex);
                flash.Lib.trace("GIVEAWAY PASS " + provider);
            } catch (error:Dynamic) {
                ordered.stop();
                flash.Lib.trace("GIVEAWAY FAIL " + provider + " " + Std.string(error));
            }
        };
    }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var ready = new haxe.Timer(200);
        ready.run = function():Void {
            try {
                if (++attempts > 60) throw "giveaway setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                ready.stop();
                var beforeHudHelp = widget._records.length;
                widget.handleSubmittedText("/help");
                widget.handleSubmittedText("help");
                var hudLineCount = FcmCommand.hudHelp().split("\n").length;
                check("slash and native-stripped help stay on this HUD", MockXscal.lastGiveawayBody.length == 0
                    && widget._records.length == beforeHudHelp + 2 * hudLineCount);
                var hudHelp = widget._records[widget._records.length - 1];
                check("HUD help is a private feed record", hudHelp.user == "FCM Help"
                    && hudHelp.senderUserId == "" && hudHelp.messageId == ""
                    && hudHelp.body.indexOf("/mod help — staff commands") >= 0
                    && hudHelp.body.indexOf("/mod <name|#ref>") < 0
                    && widget._records[beforeHudHelp].body.indexOf("HUD COMMANDS") >= 0
                    && FcmCommand.hudHelp().indexOf("/giveaway join <id>") >= 0);
                var beforeHelp = widget._records.length;
                widget.handleSubmittedText("/giveaway");
                widget.handleSubmittedText("giveaway");
                var giveawayLineCount = FcmCommand.giveawayHelp().split("\n").length;
                check("help is local to this widget", MockXscal.lastGiveawayBody.length == 0
                    && widget._records.length == beforeHelp + 2 * giveawayLineCount);
                var localHelp = widget._records[widget._records.length - 1];
                check("help is a private feed record", localHelp.user == "FCM Help"
                    && localHelp.senderUserId == "" && localHelp.messageId == ""
                    && FcmCommand.giveawayHelp().indexOf("giveaway join <id>") >= 0);
                check("help has a sortable timestamp", localHelp.createdAt.length > 0
                    && FcmFeedPlan.compareChronology(localHelp.createdAt, localHelp.arrivalOrder,
                        FcmFeedPlan.utcTimestamp(Date.fromTime(Date.now().getTime() + 1000)),
                        localHelp.arrivalOrder + 1) < 0);
                waitForPrivateReply(widget, provider, "giveaway start Flux x10 5", "Giveaway started", function():Void {
                    check("command stays in selected General channel", MockXscal.lastGiveawayChannel == "global");
                    waitForPrivateReply(widget, provider, "giveaway join ABC234", "You've entered giveaway", function():Void {
                        waitForPrivateReply(widget, provider, "giveaway join OWN123", "can't enter your own giveaway",
                            function():Void { announceWinner(widget, provider); });
                    });
                });
            } catch (error:Dynamic) {
                ready.stop();
                flash.Lib.trace("GIVEAWAY FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
