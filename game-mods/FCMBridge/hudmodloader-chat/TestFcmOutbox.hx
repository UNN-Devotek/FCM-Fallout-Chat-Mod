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
        check(FcmReconnect.pendingAllowed(0, 59999), "pending startup grace");
        check(!FcmReconnect.pendingAllowed(0, 60000), "pending watchdog");
        check(FcmReconnect.validPoll('{"success":true,"events":[]}'), "quiet healthy poll");
        check(!FcmReconnect.validPoll('{"success":true,"events":[broken}'), "malformed response");
        check(!FcmReconnect.validPoll('false'), "invalid native result");
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
        trace("FcmOutbox tests passed");
    }
}
