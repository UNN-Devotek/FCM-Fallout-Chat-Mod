/**
 * A send the relay's automod rejects must never stay on screen: the optimistic row,
 * its outbox entry and any feed row disappear, the sender sees why, and the feed
 * keeps rendering newer chat (the explanation must not replace or freeze the feed).
 * Covers the synchronous send response, the private outbox receipt and the ZFE
 * asynchronous completion.
 */
@:access(FCMChatWidget)
class AutomodBlockScenario {
    static inline var PHRASE:String = "AUTOMOD-BLOCKED-PHRASE";
    static var nextPeer:Int = 0;

    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    static function peer(widget:FCMChatWidget, body:String):Void {
        nextPeer++;
        widget.parseAndRenderEvents(haxe.Json.stringify({success:true, events:[
            {id:0, kind:"chat.message", channel:"global", messageId:"automod-peer-" + nextPeer,
                senderUserId:"peer-1", senderDisplayName:"Peer", body:body,
                createdAt:FcmFeedPlan.utcTimestamp(Date.now()), targetUserId:""}
        ]}));
    }

    static function rowText(widget:FCMChatWidget):String {
        var parts:Array<String> = [];
        for (row in widget._feedRows) if (row.textField != null) parts.push(row.textField.text);
        return parts.join("\n");
    }

    static function state(widget:FCMChatWidget):String {
        return " logVisible=" + widget._logTf.visible + " log=" + widget._logTf.text.substr(0, 60)
            + " feedVisible=" + widget._feedLayer.visible + " rows=" + widget._feedRows.length
            + " prompt=" + widget._promptTf.text.substr(0, 60);
    }

    /** Assert the blocked send left nothing behind and the feed is intact and explained. */
    static function verifyCleared(widget:FCMChatWidget, path:String, localSendId:String, anchor:String):Void {
        for (rec in widget._records) check(path + ": blocked row removed", rec.body.indexOf(PHRASE) < 0);
        if (localSendId.length > 0) check(path + ": outbox entry removed", widget._outbox.get(localSendId) == null);
        var rows = rowText(widget);
        check(path + ": no blocked text in feed rows" + state(widget), rows.indexOf(PHRASE) < 0);
        check(path + ": feed still shows chat" + state(widget),
            widget._feedLayer.visible && !widget._logTf.visible && rows.indexOf(anchor) >= 0);
        var prompt = widget._promptTf.text.toLowerCase();
        check(path + ": sender sees why" + state(widget), prompt.indexOf("blocked") >= 0);
    }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var ready = new haxe.Timer(250);
        ready.run = function():Void {
            try {
                if (++attempts > 60) throw "automod setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                ready.stop();
                widget.stopPollTimer();
                peer(widget, "peer before the filter");
                stepSync(widget, provider);
            } catch (error:Dynamic) {
                ready.stop();
                flash.Lib.trace("AUTOMOD FAIL " + provider + " " + Std.string(error));
            }
        };
    }

    /** xScal answers the send synchronously; ZFE only exercises the async paths below. */
    static function stepSync(widget:FCMChatWidget, provider:String):Void {
        if (provider != "xscal") { stepReceipt(widget, provider); return; }
        MockXscal.blockedPhrase = PHRASE;
        widget.setPrompt("");
        widget.handleSubmittedText("you are " + PHRASE);
        haxe.Timer.delay(function() {
            try {
                check("sync: relay saw the blocked send", MockXscal.lastChatBody.indexOf(PHRASE) >= 0);
                verifyCleared(widget, "sync", "", "peer before the filter");
                stepReceipt(widget, provider);
            } catch (error:Dynamic) {
                flash.Lib.trace("AUTOMOD FAIL " + provider + " " + Std.string(error));
            }
        }, 400);
    }

    static function stepReceipt(widget:FCMChatWidget, provider:String):Void {
        try {
            widget.setPrompt("");
            var id = "automod-receipt-local";
            check("receipt: outbox", widget._outbox.add(id, "global", "receipt " + PHRASE,
                widget._outboxIdentity, "", flash.Lib.getTimer()));
            widget.addOptimisticEcho("global", "receipt " + PHRASE, "", "", false, "",
                "sim-linked-user", id);
            var response = '{"success":false,"error":{"code":"message_blocked",'
                + '"message":"Message blocked by the chat filter"},"targetUserId":"FCMHUD/1;q=' + id + '"}';
            widget.acceptOutboxReceipt("FCMACK/1;" + StringTools.urlEncode(response));
        } catch (error:Dynamic) {
            flash.Lib.trace("AUTOMOD FAIL " + provider + " " + Std.string(error));
            return;
        }
        haxe.Timer.delay(function() {
            try {
                verifyCleared(widget, "receipt", "automod-receipt-local", "peer before the filter");
                stepAsync(widget, provider);
            } catch (error:Dynamic) {
                flash.Lib.trace("AUTOMOD FAIL " + provider + " " + Std.string(error));
            }
        }, 400);
    }

    static function stepAsync(widget:FCMChatWidget, provider:String):Void {
        try {
            widget.setPrompt("");
            var id = "automod-async-local";
            check("async: outbox", widget._outbox.add(id, "global", "async " + PHRASE,
                widget._outboxIdentity, "", flash.Lib.getTimer()));
            widget.addOptimisticEcho("global", "async " + PHRASE, "", "", false, "",
                "sim-linked-user", id);
            widget._zfePendingSends.set(902, id);
            widget.applyZfeAsyncCompletion('{"kind":"chat.send.failed","requestId":902,'
                + '"error":{"code":"message_blocked","message":"Message blocked by the chat filter"}}', false);
        } catch (error:Dynamic) {
            flash.Lib.trace("AUTOMOD FAIL " + provider + " " + Std.string(error));
            return;
        }
        haxe.Timer.delay(function() {
            try {
                verifyCleared(widget, "async", "automod-async-local", "peer before the filter");
                // Newer chat must keep rendering after the rejection.
                peer(widget, "peer after the filter");
                haxe.Timer.delay(function() {
                    try {
                        var rows = rowText(widget);
                        check("feed keeps updating after a block" + state(widget),
                            widget._feedLayer.visible && rows.indexOf("peer after the filter") >= 0
                            && rows.indexOf(PHRASE) < 0);
                        MockXscal.blockedPhrase = "";
                        flash.Lib.trace("AUTOMOD PASS " + provider + " paths="
                            + (provider == "xscal" ? "sync,receipt,async" : "receipt,async"));
                    } catch (error:Dynamic) {
                        flash.Lib.trace("AUTOMOD FAIL " + provider + " " + Std.string(error));
                    }
                }, 400);
            } catch (error:Dynamic) {
                flash.Lib.trace("AUTOMOD FAIL " + provider + " " + Std.string(error));
            }
        }, 400);
    }
}
