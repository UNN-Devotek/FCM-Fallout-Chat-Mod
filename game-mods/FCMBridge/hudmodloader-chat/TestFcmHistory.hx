class TestFcmHistory {
    static function check(label:String, ok:Bool):Void {
        if (!ok) throw label;
    }

    static function main():Void {
        TestFcmRoster.main();
        var replayHistory = new FcmHistory();
        var retained = [];
        // Default widget capacity: 200 visible records and 400 cached identity keys.
        for (id in 1...201) {
            var messageId = "message-" + id;
            check("seed retained message", replayHistory.accept("global", id, messageId, 400));
            retained.push({channel:"global", messageId:messageId, pending:false});
        }
        // Two replays add fresh event IDs, evicting message-1's cached identity.
        check("first replay rejected", !replayHistory.accept("global", 201, "message-200", 400, retained));
        check("second replay rejected", !replayHistory.accept("global", 202, "message-200", 400, retained));
        check("retained row survives dedup-cache eviction",
            !replayHistory.accept("global", 203, "message-1", 400, retained));

        check("new durable identity still accepted", replayHistory.accept("global", 204, "new-message", 400, retained));
        check("message identities stay channel-scoped", replayHistory.accept("trade", 205, "message-1", 400, retained));
        var pendingHistory = new FcmHistory();
        var pending = [{channel:"global", messageId:"pending-id", pending:true}];
        check("pending echo is not silently discarded", pendingHistory.accept("global", 1, "pending-id", 256, pending));
        var emptyIds = [{channel:"global", messageId:"", pending:false}];
        check("missing IDs do not match retained rows", pendingHistory.accept("global", 2, "", 256, emptyIds));
        check("fresh edit cursor remains accepted", replayHistory.accept("global", 206, "", 400));
        var cleared = new FcmHistory();
        check("seed old world row", cleared.accept("server", 1, "world-message", 256));
        cleared.clearServer();
        check("removed world row can be restored", cleared.accept("server", 1, "world-message", 256, []));
        var broadcastHistory = new FcmHistory();
        check("speculative broadcast is initially accepted",
            broadcastHistory.accept("events", 0, "world:activity-1", 512));
        broadcastHistory.release("events", 0, "world:activity-1");
        check("rejected broadcast can be retried",
            broadcastHistory.accept("events", 0, "world:activity-1", 512));
        broadcastHistory.clearWorldBroadcasts();
        check("world reset releases synthetic event identities",
            broadcastHistory.accept("events", 0, "world:activity-1", 512));
        replayHistory.startConnection();
        check("retained canonical row protected after reconnect", !replayHistory.accept("global", 1, "message-1", 400, retained));

        for (provider in [FcmNativeApi.ZFE, FcmNativeApi.XSCAL]) {
            var session = new FcmServerSession();
            session.begin("first");
            session.defer("old queue");
            check(provider + " queued success is not membership", !session.accept('{"success":true}'));
            check(provider + " confirmed first room", session.accept("FCMCTL/1/SERVER-READY:first|r:one"));
            session.begin("next");
            check(provider + " world hop clears deferred rows", session.takePending().length == 0);
            session.defer("live row before confirmation");
            check(provider + " world hop clears confirmed room", session.room == "");
            check(provider + " delayed old confirmation rejected", !session.accept("FCMCTL/1/SERVER-READY:first|r:one"));
            check(provider + " empty room rejected", !session.accept("FCMCTL/1/SERVER-READY:next|"));
            check(provider + " new room confirmed", session.accept("FCMCTL/1/SERVER-READY:next|r:two") && session.room == "r:two");
            check(provider + " early live row survives until confirmed", session.takePending().join("") == "live row before confirmation");
            check(provider + " deferred rows are taken once", session.takePending().length == 0);
            for (i in 0...70) session.defer(Std.string(i));
            var buffered = session.takePending();
            check(provider + " deferred native queue is bounded", buffered.length == 64 && buffered[0] == "6");
            check(provider + " current room message accepted", session.acceptsMessage("server:r:two:42"));
            check(provider + " queued old room message rejected", !session.acceptsMessage("server:r:one:43"));
            check(provider + " unscoped server message rejected", !session.acceptsMessage("unknown"));
            check(provider + " confirmation expires", session.fresh(59999) && !session.fresh(60000));
            check(provider + " supports retained-subscriber recovery",
                FcmNativeApi.widgetMustRequestHistoryResync(provider));
            var history = new FcmHistory();
            check("async auth must finish before recovery", !history.needsRecovery(false));
            history.observe("server");
            history.observe("system");
            check("server/link events cannot hide missing static history", history.needsRecovery(true));
            history.observe("global");
            check("normal subscribe snapshot suppresses recovery", !history.needsRecovery(true));
            history.dropped = true;
            check("queue loss requires recovery even after a partial snapshot", history.needsRecovery(true));
            history.attempted(0);
            check("accepted recovery is bounded", !history.needsRecovery(true));

            check("accepted call retries without delivered completion", history.needsRecovery(true, 10000));
            history.observe("trade");
            check("partial replay still needs completion", history.needsRecovery(true, 10000));
            history.attempted(10000);
            check("retry interval enforced", !history.needsRecovery(true, 19999));
            history.attempted(20000);
            check("failed recovery bounded to three attempts", !history.needsRecovery(true, 30000));
            history.finish();
            check("completion stops recovery including empty history", !history.needsRecovery(true, 40000));

            for (channel in ["global", "trade", "events", "infests", "raids"])
                check("seed static " + channel, history.accept(channel, 10, channel + "-row", 256));
            check("seed server", history.accept("server", 20, "server-row", 256));
            for (hop in 0...3) {
                history.clearServer();
                check("rejoin restores removed server history", history.accept("server", 20, "server-row", 256));
                check("replayed server row appears once", !history.accept("server", 21, "server-row", 256));
                for (channel in ["global", "trade", "events", "infests", "raids"])
                    check("hop preserves static deduplication", !history.accept(channel, 30 + hop, channel + "-row", 256));
            }
            history.startConnection();
            check("a new widget connection can recover again", history.needsRecovery(true));
            check("restarted native IDs do not discard new messages", history.accept("global", 10, "new-row", 256));
            check("durable IDs still prevent reconnect duplicates", !history.accept("global", 100, "global-row", 256));
            check("legacy server row", history.accept("server", 50, "", 256));
            history.clearServer();
            check("legacy replay works without message IDs", history.accept("server", 50, "", 256));
        }
        Sys.println("FCM history recovery and repeated world-transition tests passed");
    }
}
