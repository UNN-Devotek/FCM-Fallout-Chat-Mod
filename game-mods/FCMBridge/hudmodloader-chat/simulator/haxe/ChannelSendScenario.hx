/** Channel destinations, tab selection and standalone navigation share the production submit path. */
@:access(FCMChatWidget)
@:access(MockXscal)
class ChannelSendScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    static function queued(widget:FCMChatWidget, body:String, channel:String):Void {
        var matching = [for (record in widget._records) if (record.body == body) record];
        check("one pending row for " + body, matching.length == 1 && matching[0].pending && matching[0].channel == channel);
        var entry = widget._outbox.get(matching[0].localSendId);
        check("queued destination " + body, entry != null && entry.channel == channel && entry.body == body);
    }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var ready = new haxe.Timer(250);
        ready.run = function():Void {
            try {
                if (++attempts > 60) throw "channel-send setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                ready.stop();
                widget.stopPollTimer();
                widget.selectChannel(0);
                widget.handleSubmittedText("/t keep-trading");
                queued(widget, "keep-trading", "trade");
                check("Trading send leaves General selected", widget._chanIdx == 0);
                widget.handleSubmittedText("/i keep-infests");
                queued(widget, "keep-infests", "infests");
                check("Infests send leaves General selected", widget._chanIdx == 0);
                widget.handleSubmittedText("plain-general");
                queued(widget, "plain-general", "global");
                widget.handleSubmittedText("t");
                check("bare token selects Trading", widget._chanIdx == 1);
                widget.handleSubmittedText("g");
                check("bare token selects General", widget._chanIdx == 0);
                widget.handleSubmittedText("t");
                check("standalone token selects Trading", widget._chanIdx == 1);
                widget.selectChannel(0);
                var records = widget._records.length;
                widget._serverSessionReady = false;
                widget.handleSubmittedText("/s unavailable-server");
                check("unavailable Server does not send or select another tab", widget._records.length == records && widget._chanIdx == 0);
                for (prefix in ["/", "."]) {
                    widget.handleSubmittedText(prefix + "t");
                    check("empty prefix sends nothing and does not select Trading", widget._records.length == records && widget._chanIdx == 0);
                }
                widget._serverSessionReady = true;
                widget.handleSubmittedText("s");
                check("bare s selects confirmed Server", widget._chanIdx == 5);
                widget.handleSubmittedText("g");
                check("bare g returns from Server to General", widget._chanIdx == 0);
                widget._serverSessionReady = false;
                widget.selectChannel(2); // Deferred sends must remain pinned despite later navigation.
                haxe.Timer.delay(function():Void {
                    try {
                        var expected = [{body:"keep-trading",channel:"trade"},
                            {body:"keep-infests",channel:"infests"}, {body:"plain-general",channel:"global"}];
                        for (send in expected) {
                            var delivered = [for (event in MockXscal.scenarioEvents)
                                if (event.kind == "chat.message" && event.body == send.body) event];
                            check("exactly one provider send to " + send.channel, delivered.length == 1 && delivered[0].channel == send.channel);
                        }
                        // The lightweight ZFE mock queues transport acceptance; model the relay's
                        // separate durable private receipt before publishing the authoritative echo.
                        if (provider == "zfe") {
                            for (event in MockXscal.scenarioEvents)
                                if (event.kind == "chat.send.accepted") widget.applyZfeAsyncCompletion(haxe.Json.stringify(event), true);
                            for (send in expected) {
                                var row = [for (record in widget._records) if (record.body == send.body) record][0];
                                var echo = [for (event in MockXscal.scenarioEvents)
                                    if (event.kind == "chat.message" && event.body == send.body) event][0];
                                var receipt = haxe.Json.stringify({success:true, messageId:echo.messageId,
                                    targetUserId:"FCMHUD/1;q=" + row.localSendId + ";m=" + echo.messageId});
                                widget.acceptOutboxReceipt("FCMACK/1;" + StringTools.urlEncode(receipt));
                            }
                        }
                        widget.parseAndRenderEvents(haxe.Json.stringify({success:true, events:MockXscal.scenarioEvents}));
                        for (send in expected) {
                            var reconciled = [for (record in widget._records) if (record.body == send.body) record];
                            check("echo reconciles once in original channel", reconciled.length == 1 && !reconciled[0].pending && reconciled[0].channel == send.channel);
                        }
                        check("echo does not change current tab", widget._chanIdx == 2);
                        flash.Lib.trace("CHANNEL-SEND PASS " + provider);
                    } catch (error:Dynamic) {
                        flash.Lib.trace("CHANNEL-SEND FAIL " + provider + " " + Std.string(error));
                    }
                }, 1000);
            } catch (error:Dynamic) {
                ready.stop();
                flash.Lib.trace("CHANNEL-SEND FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
