/** Cooldown receipts update only the sender's local prompt, never chat history. */
@:access(FCMChatWidget)
class CooldownScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var timer = new haxe.Timer(250);
        timer.run = function():Void {
            try {
                if (++attempts > 60) throw "cooldown setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                timer.stop();
                widget.stopPollTimer();
                var records = widget._records.length;
                var sends = MockXscal.ordinarySendCount;
                var id = "cooldown-fixture-local";
                widget._canRetryHudSend = true;
                check("sender queued", widget._outbox.add(id, "global", "fourth message",
                    widget._outboxIdentity, "", flash.Lib.getTimer()));
                var response = '{"success":false,"error":{"code":"rate_limited","retryAfterMs":35000},'
                    + '"targetUserId":"FCMHUD/1;q=' + id + '"}';
                var event = '{"success":true,"events":[{"id":700,"kind":"chat.message",'
                    + '"channel":"system","senderUserId":"system","body":"FCMACK/1;'
                    + StringTools.urlEncode(response) + '"}]}';
                widget.parseAndRenderEvents(event);
                check("private receipt explains cooldown", widget._promptTf.text.indexOf("You are in cooldown") >= 0
                    && widget._promptTf.text.indexOf("35 seconds") >= 0);
                check("rejected message remains queued", widget._outbox.get(id) != null);
                check("notice adds no public row or send", widget._records.length == records
                    && MockXscal.ordinarySendCount == sends);
                var previous = widget._promptTf.text;
                widget.acceptOutboxReceipt("FCMACK/1;" + StringTools.urlEncode(StringTools.replace(response, id, "other-user-send")));
                check("foreign receipt cannot change prompt", widget._promptTf.text == previous);
                widget._zfePendingSends.set(900, id);
                widget.applyZfeAsyncCompletion('{"kind":"chat.send.failed","requestId":900,'
                    + '"error":{"code":"rate_limited","retryAfterMs":34000}}', false);
                check("async completion explains cooldown", widget._promptTf.text.indexOf("34 seconds") >= 0);
                widget._canRetryHudSend = false;
                widget._zfePendingSends.set(901, id);
                widget.applyZfeAsyncCompletion('{"kind":"chat.send.failed","requestId":901,'
                    + '"error":{"code":"rate_limited","retryAfterMs":33000}}', false);
                check("legacy local notice", widget._promptTf.text.indexOf("33 seconds") >= 0
                    && widget._outbox.get(id) == null && widget._records.length == records);
                flash.Lib.trace("COOLDOWN PASS " + provider + " sender-only=true public-rows=0");
            } catch (error:Dynamic) {
                timer.stop();
                flash.Lib.trace("COOLDOWN FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
