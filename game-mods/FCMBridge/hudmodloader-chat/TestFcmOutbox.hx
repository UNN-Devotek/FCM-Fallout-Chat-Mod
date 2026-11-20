class TestFcmOutbox {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }
    static function main():Void {
        var q = new FcmOutbox();
        check(q.add("1", "general", "hello", "a", "", 0), "enqueue");
        q.attempted("1", 0);
        check(q.next("a", "", false, 2999) == null, "backoff");
        check(q.next("a", "", false, 600000).id == "1", "survives minutes offline");
        check(q.next("b", "", false, 600000) == null, "identity isolation");
        q.add("2", "server", "world", "a", "old", 0);
        check(q.prune("a", "new", true, 10000).join(",") == "2", "world isolation");
        check(q.prune("b", "", false, 10000).join(",") == "1", "account switch clears");
        for (i in 0...FcmOutbox.MAX) check(q.add(Std.string(i), "general", "x", "a", "", 0), "capacity");
        check(!q.add("overflow", "general", "x", "a", "", 0), "bounded");
        check(q.prune("a", "", false, FcmOutbox.TTL).length == FcmOutbox.MAX, "expiry");
        check(FcmOutbox.receipt("FCMHUD/1;m=msg;q=send-1") == "send-1", "receipt");
        check(FcmOutbox.target("send-1", "a:b") == "FCMOUT/1;i=send-1;r=a%3Ab", "target");
        check(!FcmOutbox.retryable("message_blocked"), "terminal denial");
        check(FcmOutbox.rejectionNotice("message_blocked", 200) == "Message blocked by the chat filter.", "automod notice");
        check(FcmOutbox.rejectionNotice("message_too_long", 200) == "Message too long (max 200).", "length notice");
        check(FcmOutbox.rejectionNotice("", 200) == "Message not sent.", "empty code notice");
        check(FcmOutbox.rejectionNotice("weird_code", 200) == "Message not sent: weird_code", "unknown code notice");
        check(FcmReconnect.pendingAllowed(0, 59999), "pending startup grace");
        check(!FcmReconnect.pendingAllowed(0, 60000), "pending watchdog");
        check(FcmReconnect.validPoll('{"success":true,"events":[]}'), "quiet healthy poll");
        check(!FcmReconnect.validPoll('{"success":true,"events":[broken}'), "malformed response");
        check(!FcmReconnect.validPoll('false'), "invalid native result");
        // 2026-11-16 field log: renewals kept going out for 60 s after the last relay
        // confirmation while xScal still reported authenticated.
        check(FcmReconnect.relaySilent(true, false, 4), "four unanswered renewals mean a silent relay");
        check(FcmReconnect.relaySilent(true, false, FcmReconnect.SILENT_RENEWALS), "threshold");
        check(!FcmReconnect.relaySilent(true, false, 0), "no renewal sent (loading) is not silence");
        check(!FcmReconnect.relaySilent(true, false, 1), "one missed reply is restored by the next renewal");
        check(!FcmReconnect.relaySilent(true, true, 4), "fresh confirmation is healthy");
        check(!FcmReconnect.relaySilent(false, false, 4), "no Server session, nothing to judge");
        check(FcmReconnect.joinSilent(false, FcmReconnect.SILENT_JOINS), "room never confirmed after a minute of requests");
        check(!FcmReconnect.joinSilent(false, FcmReconnect.SILENT_JOINS - 1), "join still within its retry minute");
        check(!FcmReconnect.joinSilent(true, 10), "confirmed rooms use the renewal rule");
        var silent = new FcmOutbox();
        silent.add("s1", "global", "hello", "account", "", 0);
        silent.add("s2", "global", "cooling", "account", "", 0);
        for (i in 0...FcmReconnect.SILENT_RETRIES) { silent.attempted("s1", i); silent.attempted("s2", i); }
        silent.answered("s2");
        var stalled = silent.takeUnanswered(FcmReconnect.SILENT_RETRIES);
        check(stalled.length == 1 && stalled[0] == "s1", "only retries with no relay answer prove silence");
        check(silent.get("s1") != null && silent.get("s1").attempts == FcmReconnect.SILENT_RETRIES,
            "stalled send stays queued with its attempts");
        check(silent.takeUnanswered(FcmReconnect.SILENT_RETRIES).length == 0, "count restarts after a reconnect");
        check(FcmReconnect.sendUnconfirmed(true, true, false, "", 1000, 16000), "accepted send without echo is unconfirmed");
        check(!FcmReconnect.sendUnconfirmed(true, true, false, "", 1000, 15999), "echo window still open");
        check(!FcmReconnect.sendUnconfirmed(true, true, true, "", 1000, 60000), "outbox-tracked sends use their retry path");
        check(!FcmReconnect.sendUnconfirmed(true, false, false, "", 1000, 60000), "not yet accepted by the provider");
        check(!FcmReconnect.sendUnconfirmed(false, true, false, "", 1000, 60000), "echoed send is confirmed");
        check(!FcmReconnect.sendUnconfirmed(true, true, false, "msg-1", 1000, 60000), "relay message id proves delivery");
        var retry = new FcmOutbox();
        retry.add("stable-send", "general", "same payload", "account", "", 0);
        check(!FcmOutbox.canCorrelate(retry.get("stable-send"), "", false), "unsent draft cannot match history");
        retry.attempted("stable-send", 0);
        check(!FcmOutbox.canCorrelate(retry.get("stable-send"), "", true), "retry waits for exact receipt");
        check(FcmOutbox.canCorrelate(retry.get("stable-send"), "server-id", true), "receipt enables exact match");
        retry.attempted("stable-send", 600000);
        check(retry.get("stable-send").body == "same payload", "retry identity and payload unchanged");
        retry.remove(FcmOutbox.receipt("FCMHUD/1;q=stable-send;m=server-id"));
        check(retry.next("account", "", false, 700000) == null, "authoritative receipt stops retry");
        var ack = '{"success":true,"targetUserId":"FCMHUD/1;m=server-id;q=stable-send"}';
        check(FcmOutbox.privateReceipt("FCMACK/1;" + StringTools.urlEncode(ack)) == ack, "asynchronous receipt envelope");
        check(FcmOutbox.privateReceipt("FCMACK/1;garbage") == "", "malformed private receipt");
        check(FcmOutbox.privateReceipt("FCMACK/1;" + StringTools.urlEncode('{"success":true}')) == "", "unbound receipt rejected");
        check(FcmOutbox.cooldownNotice('{"error":{"retryAfterMs":35000}}') ==
            "You are in cooldown. Please wait 35 seconds before sending another message.", "private cooldown notice");
        check(FcmOutbox.cooldownNotice('{"error":{"retryAfterMs":34001}}').indexOf("35 seconds") >= 0, "wait rounds up");
        for (wait in [70000, 140000, 280000, 300000]) {
            check(FcmOutbox.cooldownNotice('{"error":{"retryAfterMs":' + wait + '}}').indexOf(
                Std.string(Math.ceil(wait / 1000)) + " seconds") >= 0, "adaptive cooldown notice");
        }
        var cooling = new FcmOutbox();
        cooling.add("chat", "general", "hello", "a", "", 0);
        cooling.add("queued", "trading", "trade", "a", "", 0);
        cooling.add("private", "general", "/giveaway list", "a", "", 0);
        cooling.add("other", "general", "hello", "b", "", 0);
        cooling.deferCooldown("chat", '{"error":{"retryAfterMs":140000}}', 500);
        check(cooling.get("chat").nextAt == 140500 && cooling.get("queued").nextAt == 140500,
            "shared cooldown pauses all existing chat retries for the sender");
        check(cooling.get("private").nextAt == 0 && cooling.get("other").nextAt == 0,
            "private command and account isolation");
        cooling.remove("private");
        check(cooling.next("a", "", false, 140499) == null, "no early automatic retry");
        check(cooling.next("a", "", false, 140500).id == "chat", "retry resumes at deadline");
        cooling.deferCooldown("chat", '{"error":{"retryAfterMs":35000}}', 1000);
        check(cooling.get("chat").nextAt == 140500, "shorter receipt cannot erase an existing wait");
        cooling.deferCooldown("unknown", '{"error":{"retryAfterMs":300000}}', 1000);
        cooling.deferCooldown("chat", '{"error":{"retryAfterMs":300001}}', 1000);
        check(cooling.get("chat").nextAt == 140500, "malformed or unrelated receipt cannot delay retries");
        var fallback = "You are in cooldown. Please wait before sending another message.";
        for (raw in ["bad json", '{"error":{}}', '{"error":{"retryAfterMs":0}}',
                '{"error":{"retryAfterMs":-1}}', '{"error":{"retryAfterMs":300001}}',
                '{"error":{"retryAfterMs":1e309}}', '{"error":{"retryAfterMs":999999999}}',
                '{"error":{"retryAfterMs":"<b>fake</b>","message":"<b>fake</b>"}}']) {
            check(FcmOutbox.cooldownNotice(raw) == fallback, "bounded safe notice " + raw);
        }
        trace("FcmOutbox tests passed");
    }
}
