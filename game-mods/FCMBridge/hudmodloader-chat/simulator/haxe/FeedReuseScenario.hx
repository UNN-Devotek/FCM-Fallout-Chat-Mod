/**
 * 2.10.154 responsiveness: unchanged feed rows survive an acknowledged/echoed send
 * and a ring-buffer trim (same display objects, correct positions), and xScal polls
 * on xscalPollMs while ZFE keeps pollMs.
 */
@:access(FCMChatWidget)
class FeedReuseScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    static function views(widget:FCMChatWidget):Array<Dynamic> {
        return [for (row in widget._feedRows) row.view];
    }

    static function positionsConsistent(widget:FCMChatWidget):Bool {
        // Display-object coordinates snap to twips (1/20 px), so allow that rounding.
        for (row in widget._feedRows) if (Math.abs(row.view.y - row.contentY) > 0.06) return false;
        return widget._feedRows.length == 0 || widget._feedRows[0].contentY == 0;
    }

    static function renderNow(widget:FCMChatWidget, label:String):Void {
        widget.renderRecords();
        check(label + ": render stayed incremental", !widget._renderPending);
        check(label + ": row positions match their layout", positionsConsistent(widget));
    }

    static var nextEventId:Int = 900000;

    static function incoming(widget:FCMChatWidget, messageId:String, body:String):Void {
        nextEventId++;
        widget.parseAndRenderEvents('{"success":true,"events":[{"id":' + nextEventId + ','
            + '"kind":"chat.message","channel":"global","messageId":"' + messageId + '",'
            + '"senderUserId":"sim-other-user","senderDisplayName":"Other76","body":"' + body + '"}]}');
    }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts:Int = 0;
        var step:Int = 0;
        var ready = new haxe.Timer(250);
        ready.run = function():Void {
            try {
                if (++attempts > 80) throw "feed reuse setup timed out at step " + step;
                if (!widget._connected || widget._authState != "authenticated") return;
                if (widget._renderPending) return;
                if (step == 0) {
                    var expected:Int = provider == "xscal" ? widget._cfg.xscalPollMs : widget._cfg.pollMs;
                    check("poll timer running", widget._pollTimer != null);
                    check("poll interval " + widget._pollTimer.delay + " for " + provider,
                        widget._pollTimer.delay == expected);
                    check("xScal default is 1 s", widget._cfg.xscalPollMs == 1000);
                    for (i in 0...4) incoming(widget, "reuse-seed-" + i, "seed " + i);
                    widget.renderRecords();
                    step = 1;
                    return;
                }
                ready.stop();

                // Acknowledged then echoed own send: only the changed row is rebuilt.
                var before = views(widget);
                var n:Int = before.length;
                check("seeded feed has rows", n >= 4);
                var localSendId = "reuse-own-local";
                check("fixture outbox", widget._outbox.add(localSendId, "global", "own message",
                    widget._outboxIdentity, "", flash.Lib.getTimer()));
                widget._outbox.attempted(localSendId, flash.Lib.getTimer());
                widget.addOptimisticEcho("global", "own message", "reuse-own-message", "", false, "",
                    "sim-linked-user", localSendId);
                renderNow(widget, "optimistic row");
                var afterSend = views(widget);
                check("optimistic row appended", afterSend.length == n + 1);
                for (i in 0...n) check("row " + i + " kept on send", afterSend[i] == before[i]);
                var pendingView:Dynamic = afterSend[n];

                widget.parseAndRenderEvents('{"success":true,"events":[{"id":' + (++nextEventId) + ','
                    + '"kind":"chat.message","channel":"global","messageId":"reuse-own-message",'
                    + '"senderUserId":"sim-linked-user","senderDisplayName":"Simulator76",'
                    + '"body":"own message"}]}');
                renderNow(widget, "echo");
                var afterEcho = views(widget);
                check("echo kept one row", afterEcho.length == n + 1);
                for (i in 0...n) check("row " + i + " kept on echo", afterEcho[i] == before[i]);
                check("confirmed row was rebuilt", afterEcho[n] != pendingView);

                // Ring-buffer trim: the oldest record leaves, the rest shift up and are kept.
                widget._cfg.maxMessages = widget._records.length;
                var beforeTrim = views(widget);
                incoming(widget, "reuse-trim-new", "after trim");
                renderNow(widget, "trim");
                var afterTrim = views(widget);
                var rebuilt:Int = 0;
                for (view in afterTrim) if (beforeTrim.indexOf(view) < 0) rebuilt++;
                check("head row trimmed", afterTrim.indexOf(beforeTrim[0]) < 0);
                check("only the new row was built after trim (built=" + rebuilt + ")", rebuilt == 1);
                check("trimmed feed keeps its length", afterTrim.length == beforeTrim.length);
                check("survivors shifted up in order", afterTrim[0] == beforeTrim[1]);
                flash.Lib.trace("FEED-REUSE PASS " + provider + " rows=" + afterTrim.length);
            } catch (error:Dynamic) {
                ready.stop();
                flash.Lib.trace("FEED-REUSE FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
