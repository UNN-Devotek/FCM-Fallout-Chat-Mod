/**
 * 2026-11-16 field log: xScal kept reporting "authenticated" and answering polls after its
 * relay link went quiet. Room renewals went unanswered and two sends got only a local ACK,
 * yet the HUD never reconnected and showed the sends as delivered.
 *
 * Step 1 (both providers): a confirmed Server room lapses while renewals were still being
 *         sent, so the HUD must reconnect instead of only closing the Server tab.
 * Step 2 (xScal): a real send against a silent relay, without the retry-capable outbox,
 *         must be marked [unconfirmed], explained, and trigger a reconnect.
 * Step 3 (both): no room was ever confirmed although requests kept going out (link died
 *         during a world hop): reconnect.
 * Step 4 (both): a retry-capable queued send whose retries get no relay answer: reconnect
 *         and keep the message queued for resend.
 * Step 5 (both): an accepted send that later echoes must never be flagged.
 */
@:access(FCMChatWidget)
class SilentRelayScenario {
    static inline var PHRASE:String = "SILENT-RELAY-SEND";

    static function fail(provider:String, error:Dynamic):Void {
        MockXscal.silentRelay = false;
        MockXscal.authCanRetry = true;
        MockXscal.hudReceipts = false;
        flash.Lib.trace("SILENT-RELAY FAIL " + provider + " " + Std.string(error));
    }

    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    static function rowText(widget:FCMChatWidget):String {
        var parts:Array<String> = [];
        for (row in widget._feedRows) if (row.textField != null) parts.push(row.textField.text);
        return parts.join("\n");
    }

    /** Run `next` once the widget is connected and authenticated again. */
    static function whenReady(widget:FCMChatWidget, provider:String, label:String, next:Void->Void):Void {
        var attempts = 0;
        var timer = new haxe.Timer(250);
        timer.run = function():Void {
            try {
                if (++attempts > 80) throw label + " timed out";
                if (!widget._connected || widget._authState != "authenticated"
                        || widget._relayUserId.length == 0) return;
                timer.stop();
                next();
            } catch (error:Dynamic) {
                timer.stop();
                fail(provider, error);
            }
        };
    }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        whenReady(widget, provider, "setup", function() stepRoomSilence(widget, provider));
    }

    static function stepRoomSilence(widget:FCMChatWidget, provider:String):Void {
        var now:Float = flash.Lib.getTimer();
        widget.stopPollTimer();
        widget._needsLink = false;
        widget._serverSession.begin("silent-req");
        check("room accepted", widget._serverSession.accept(
            "FCMCTL/1/SERVER-READY:silent-req|r:silent-room", now - 70000));
        widget.setServerSessionReady(true, "");
        // Renewals kept going out after the last confirmation and were never answered
        // (four in the field log).
        widget._unansweredRenewals = FcmReconnect.SILENT_RENEWALS;
        widget.tickRoster();
        check("room silence reconnects", !widget._connected);
        check("Server tab closed", !widget._serverSessionReady);
        whenReady(widget, provider, "room reconnect", function() {
            try {
                if (provider == "xscal") stepSilentSend(widget, provider);
                else stepJoinSilence(widget, provider, "room");
            } catch (error:Dynamic) fail(provider, error);
        });
    }

    static function stepSilentSend(widget:FCMChatWidget, provider:String):Void {
        widget.stopPollTimer();
        MockXscal.silentRelay = true;
        MockXscal.authCanRetry = false;
        widget.refreshAuthState();
        check("retry outbox disabled", !widget._canRetryHudSend);
        widget.setPrompt("");
        widget.handleSubmittedText("hello " + PHRASE);
        haxe.Timer.delay(function() {
            try {
                widget.stopPollTimer();
                var rec = null;
                for (candidate in widget._records) if (candidate.body.indexOf(PHRASE) >= 0) rec = candidate;
                check("optimistic row exists", rec != null);
                check("provider accepted the send", rec.pending && rec.sendAccepted);
                check("no outbox entry (no retry path)", widget._outbox.get(rec.localSendId) == null);
                check("not flagged inside the echo window", rec.unconfirmed != true);
                var connectsBefore = MockXscal.connectCount;
                // Ruffle's clock starts at zero; pendingAt=1 is the oldest valid send time,
                // so wait until the echo window has elapsed since then.
                var clock = new haxe.Timer(100);
                clock.run = function() {
                    if (flash.Lib.getTimer() <= FcmReconnect.SEND_CONFIRM_MS + 1) return;
                    clock.stop();
                    try {
                        rec.pendingAt = 1;
                        widget.runEventPollSafely();
                        check("row flagged", rec.unconfirmed == true);
                        check("reconnect started", !widget._connected);
                        widget.renderRecords();
                        haxe.Timer.delay(function() {
                            try {
                                check("row shows [unconfirmed]: " + rowText(widget).substr(0, 200),
                                    rowText(widget).indexOf(PHRASE + " [unconfirmed]") >= 0);
                                var prompt = widget._promptTf.text.toLowerCase();
                                check("reconnect notice shown: " + prompt.substr(0, 80),
                                    prompt.indexOf("reconnecting") >= 0);
                                MockXscal.silentRelay = false;
                                MockXscal.authCanRetry = true;
                                whenReady(widget, provider, "send reconnect", function() {
                                    try {
                                        check("transport reconnected", MockXscal.connectCount > connectsBefore);
                                        stepJoinSilence(widget, provider, "room,send");
                                    } catch (error:Dynamic) fail(provider, error);
                                });
                            } catch (error:Dynamic) fail(provider, error);
                        }, 400);
                    } catch (error:Dynamic) fail(provider, error);
                };
            } catch (error:Dynamic) fail(provider, error);
        }, 600);
    }

    static function stepJoinSilence(widget:FCMChatWidget, provider:String, paths:String):Void {
        widget.stopPollTimer();
        widget._needsLink = false;
        widget.setServerSessionReady(false, "");
        widget._unansweredRenewals = FcmReconnect.SILENT_JOINS;
        widget.tickRoster();
        check("unconfirmed join reconnects", !widget._connected);
        whenReady(widget, provider, "join reconnect", function() {
            try stepRetrySilence(widget, provider, paths + ",join") catch (error:Dynamic) fail(provider, error);
        });
    }

    static function stepRetrySilence(widget:FCMChatWidget, provider:String, paths:String):Void {
        widget.stopPollTimer();
        var id = "silent-retry-local";
        check("retry outbox", widget._outbox.add(id, "global", "retry " + PHRASE,
            widget._outboxIdentity, "", flash.Lib.getTimer()));
        widget.addOptimisticEcho("global", "retry " + PHRASE, "", "", false, "", "sim-linked-user", id);
        for (i in 0...FcmReconnect.SILENT_RETRIES) widget._outbox.attempted(id, flash.Lib.getTimer());
        // Keep the next resend in the future so this poll only judges the silence.
        widget._outbox.get(id).nextAt = flash.Lib.getTimer() + 600000;
        check("retry stall detected", widget.checkUnconfirmedSends());
        check("retry stall reconnects", !widget._connected);
        check("message stays queued for resend", widget._outbox.get(id) != null
            && widget._outbox.get(id).unanswered == 0);
        whenReady(widget, provider, "retry reconnect", function() {
            try {
                widget._outbox.remove(id);
                widget.removeOptimisticRecord(id);
                stepEchoedSend(widget, provider, paths + ",retry");
            } catch (error:Dynamic) fail(provider, error);
        });
    }

    /** A send whose echo arrived is confirmed and must never be flagged, however old. */
    static function stepEchoedSend(widget:FCMChatWidget, provider:String, paths:String):Void {
        try {
            widget.stopPollTimer();
            var id = "silent-echoed-local";
            widget.addOptimisticEcho("global", "echoed " + PHRASE, "", "", false, "",
                "sim-linked-user", id);
            var rec = null;
            for (candidate in widget._records) if (candidate.localSendId == id) rec = candidate;
            check("echoed row exists", rec != null);
            rec.sendAccepted = true;
            rec.pending = false; // the authoritative echo reconciled it
            rec.pendingAt = flash.Lib.getTimer() - 60000;
            check("confirmed row not flagged", !widget.checkUnconfirmedSends() && rec.unconfirmed != true);
            check("still connected", widget._connected);
            if (provider == "xscal") stepProvenRetry(widget, provider, paths + ",echoed");
            else flash.Lib.trace("SILENT-RELAY PASS " + provider + " paths=" + paths + ",echoed");
        } catch (error:Dynamic) fail(provider, error);
    }

    static function findRecord(widget:FCMChatWidget, body:String):Dynamic {
        for (candidate in widget._records) if (candidate.body == body) return candidate;
        return null;
    }

    /**
     * 2026-11-17 field test: xScal answers getAuthState itself without canRetryHudSend, so
     * a send its worker dropped could never be retried and stayed [unconfirmed] forever, and
     * the "Reconnecting to chat..." notice outlived the reconnect. One private relay receipt
     * proves the relay deduplicates retries; later sends must stay queued, be delivered once
     * after the reconnect, and the notice must clear.
     */
    static function stepProvenRetry(widget:FCMChatWidget, provider:String, paths:String):Void {
        widget.stopPollTimer();
        MockXscal.authCanRetry = false;
        MockXscal.hudReceipts = true;
        widget.refreshAuthState();
        check("relay permission absent", !widget._canRetryHudSend);
        var probe = "probe " + PHRASE;
        widget.handleSubmittedText(probe);
        haxe.Timer.delay(function() {
            try {
                widget.runEventPollSafely();
                check("receipt proves retry support", widget._relayReceiptsProven && widget.canRetrySends());
                var probeRec = findRecord(widget, probe);
                check("probe confirmed", probeRec != null && !probeRec.pending);
                MockXscal.silentRelay = true;
                var lost = "lost " + PHRASE;
                widget.handleSubmittedText(lost);
                haxe.Timer.delay(function() {
                    try {
                        widget.stopPollTimer();
                        var rec = findRecord(widget, lost);
                        check("lost row pending", rec != null && rec.pending && rec.sendAccepted);
                        check("lost send stays queued", widget._outbox.get(rec.localSendId) != null);
                        check("queued send never flagged", !widget.checkUnconfirmedSends() && rec.unconfirmed != true);
                        var sendsBefore = MockXscal.ordinarySendCount;
                        widget.forceReconnect("proven retry test");
                        check("reconnect notice shown", widget._promptTf.text.toLowerCase().indexOf("reconnecting") >= 0);
                        MockXscal.silentRelay = false;
                        whenReady(widget, provider, "proven retry reconnect", function() {
                            var waits = 0;
                            var timer = new haxe.Timer(250);
                            timer.run = function() {
                                try {
                                    widget.runEventPollSafely();
                                    var current = findRecord(widget, lost);
                                    if (current != null && current.pending) {
                                        if (++waits > 40) throw "lost send never delivered after reconnect";
                                        return;
                                    }
                                    timer.stop();
                                    check("resent exactly once", MockXscal.ordinarySendCount == sendsBefore + 1);
                                    var copies = 0;
                                    for (r in widget._records) if (r.body == lost) copies++;
                                    check("one row for the resent message (" + copies + ")", copies == 1);
                                    check("never flagged", current == null || current.unconfirmed != true);
                                    check("reconnect notice cleared: " + widget._promptTf.text.substr(0, 80),
                                        widget._promptTf.text.toLowerCase().indexOf("reconnecting") < 0);
                                    MockXscal.authCanRetry = true;
                                    MockXscal.hudReceipts = false;
                                    flash.Lib.trace("SILENT-RELAY PASS " + provider + " paths=" + paths + ",proven-retry");
                                } catch (error:Dynamic) { timer.stop(); fail(provider, error); }
                            };
                        });
                    } catch (error:Dynamic) fail(provider, error);
                }, 600);
            } catch (error:Dynamic) fail(provider, error);
        }, 600);
    }
}
