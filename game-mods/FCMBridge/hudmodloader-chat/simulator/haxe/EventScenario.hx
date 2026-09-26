/** Event command, private help, and physical feed-row navigation regression. */
@:access(FCMChatWidget)
class EventScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var ready = new haxe.Timer(200);
        ready.run = function():Void {
            try {
                if (++attempts > 60) throw "event setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                ready.stop();
                var before = widget._records.length;
                widget.handleSubmittedText("/help");
                widget.handleSubmittedText("event help"); // Native editor can consume '/'.
                var eventLines = FcmEventCommands.help().split("\n");
                var hudLines = FcmCommand.hudHelp().split("\n");
                check("guides are private individual records",
                    widget._records.length == before + hudLines.length + eventLines.length
                    && MockXscal.lastEventBody == "");
                var first = widget._records[widget._records.length - eventLines.length];
                var last = widget._records[widget._records.length - 1];
                check("all event names are feed line items",
                    first.body.indexOf("EVENT COMMANDS") >= 0
                    && last.body.indexOf("/uf — Uranium Fever") >= 0
                    && first.messageId == "" && first.senderUserId == "");

                var rendered = new haxe.Timer(150);
                var renderAttempts = 0;
                rendered.run = function():Void {
                    try {
                        if (++renderAttempts > 20) throw "event help render timed out";
                        if (widget._feedRows.length < hudLines.length + eventLines.length) return;
                        rendered.stop();
                        widget._inputOpen = true;
                        for (i in 0...eventLines.length) {
                            check("up arrow handled", widget.handleUserEvent("ArrowUp", true));
                            widget.handleUserEvent("ArrowUp", false);
                        }
                        check("arrow keys reached first event line",
                            widget._feedRows[widget._selectedRowIndex].textField.text.indexOf("EVENT COMMANDS") >= 0
                            && widget._feedScrollY < widget._feedMaxScrollY);
                        widget._inputOpen = false;
                        widget.handleSubmittedText("/sbq");
                        waitForAnnouncement(widget, provider);
                    } catch (error:Dynamic) {
                        rendered.stop();
                        flash.Lib.trace("EVENT FAIL " + provider + " " + Std.string(error));
                    }
                };
            } catch (error:Dynamic) {
                ready.stop();
                flash.Lib.trace("EVENT FAIL " + provider + " " + Std.string(error));
            }
        };
    }

    static function waitForAnnouncement(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var timer = new haxe.Timer(200);
        timer.run = function():Void {
            try {
                if (++attempts > 30) {
                    var tail = [];
                    for (i in Std.int(Math.max(0, widget._records.length - 3))...widget._records.length) {
                        var row = widget._records[i];
                        tail.push(row.channel + ":" + row.body + ":" + row.messageId);
                    }
                    throw "event announcement timed out body=" + MockXscal.lastEventBody
                        + " channel=" + MockXscal.lastEventChannel + " rows=" + widget._records.length
                        + " outbox=" + widget._outbox.entries.length + " tail=" + tail.join("|");
                }
                var posted = false;
                var feedback = false;
                for (row in widget._records) {
                    if (row.channel == "events" && row.body == "Scorched Earth event on this server.")
                        posted = true;
                    if (row.body == "Event announced in Events." && row.messageId == ""
                            && row.senderUserId == "") feedback = true;
                }
                if (!posted || !feedback) return;
                timer.stop();
                check("event shortcut sent from General",
                    MockXscal.lastEventBody == "/sbq" && MockXscal.lastEventChannel == "global");
                widget.handleSubmittedText("/t");
                var before = widget._records.length;
                widget.handleSubmittedText("/sbq");
                check("other channels get local policy feedback",
                    widget._records.length == before + 1
                    && widget._records[widget._records.length - 1].body.indexOf("General") >= 0
                    && MockXscal.lastEventChannel == "global");
                flash.Lib.trace("EVENT PASS " + provider);
            } catch (error:Dynamic) {
                timer.stop();
                flash.Lib.trace("EVENT FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
