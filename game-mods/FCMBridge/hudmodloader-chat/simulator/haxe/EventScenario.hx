/** Event command, private help, and physical feed-row navigation regression. */
@:access(FCMChatWidget)
class EventScenario {
    static var _serverNow:Float = 0;

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
                check("main help links event guide without event names",
                    FcmCommand.hudHelp().indexOf("/event help") >= 0
                    && FcmCommand.hudHelp().indexOf("/sbq — Scorched Earth") < 0
                    && FcmCommand.hudHelp().indexOf("/gu — Gearing Up") < 0);
                check("main help links moderation guide without staff actions",
                    FcmCommand.hudHelp().indexOf("/mod help") >= 0
                    && FcmCommand.hudHelp().indexOf("/mod <name|#ref>") < 0
                    && widget.moderationHelp().indexOf("/mod #ref ban") >= 0);
                check("guides are private individual records",
                    widget._records.length == before + hudLines.length + eventLines.length
                    && MockXscal.lastEventBody == "");
                check("sos guide identifies Swarm of Suitors",
                    FcmEventCommands.help().indexOf("/sos — Swarm of Suitors") >= 0
                    && FcmEventCommands.help().indexOf("/sos — Surface to Air") < 0
                    && FcmEventCommands.help().indexOf("/sts — Surface to Air") >= 0);
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
                        // Down with nothing selected must stay on the newest rows, not jump
                        // to the oldest row (reported as "scrolled up to the beginning").
                        widget.scrollToBottom();
                        check("down arrow handled", widget.handleUserEvent("ArrowDown", true));
                        widget.handleUserEvent("ArrowDown", false);
                        check("down with no selection stays at newest",
                            widget._selectedRowIndex == -1
                            && widget._feedScrollY == widget._feedMaxScrollY);
                        widget._inputOpen = false;
                        // Relay rows carry server time. Date the latest one a minute behind the
                        // player's clock to reproduce a PC clock that runs fast.
                        var serverNow = Date.now().getTime() - 60000;
                        widget.parseAndRenderEvents(haxe.Json.stringify({success:true, events:[
                            {id:0, kind:"chat.message", channel:"global",
                                messageId:"event-clock-seed", senderUserId:"peer-1",
                                senderDisplayName:"Peer", body:"before the announcement",
                                createdAt:FcmFeedPlan.utcTimestamp(Date.fromTime(serverNow)),
                                targetUserId:""}
                        ]}));
                        _serverNow = serverNow;
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
                // A relay row newer (server time) than the notice must follow it, even
                // though it is older than the player's fast clock.
                widget.parseAndRenderEvents(haxe.Json.stringify({success:true, events:[
                    {id:0, kind:"chat.message", channel:"global",
                        messageId:"event-clock-after", senderUserId:"peer-1",
                        senderDisplayName:"Peer", body:"after the announcement",
                        createdAt:FcmFeedPlan.utcTimestamp(Date.fromTime(_serverNow + 5000)),
                        targetUserId:""}
                ]}));
                var notice:Dynamic = null;
                var after:Dynamic = null;
                for (row in widget._records) {
                    if (row.body == "Event announced in Events.") notice = row;
                    if (row.messageId == "event-clock-after") after = row;
                }
                check("newer chat follows event feedback despite a fast player clock"
                    + (notice == null ? " notice=missing" : " notice=" + notice.createdAt + "#" + notice.arrivalOrder)
                    + (after == null ? " after=missing" : " after=" + after.createdAt + "#" + after.arrivalOrder),
                    notice != null && after != null
                    && FcmFeedPlan.compareChronology(notice.createdAt, notice.arrivalOrder,
                        after.createdAt, after.arrivalOrder) < 0);
                widget.handleSubmittedText("t");
                var before = widget._records.length;
                widget.handleSubmittedText("/sbq");
                check("other channels get local policy feedback",
                    widget._records.length == before + 1
                    && widget._records[widget._records.length - 1].body.indexOf("Enter g to switch to General") >= 0
                    && MockXscal.lastEventChannel == "global");
                flash.Lib.trace("EVENT PASS " + provider);
            } catch (error:Dynamic) {
                timer.stop();
                flash.Lib.trace("EVENT FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
