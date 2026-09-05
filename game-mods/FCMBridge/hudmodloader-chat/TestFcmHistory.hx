class TestFcmHistory {
    static function check(label:String, ok:Bool):Void {
        if (!ok) throw label;
    }

    static function main():Void {
        TestFcmRoster.main();
        for (provider in [FcmNativeApi.ZFE, FcmNativeApi.XSCAL]) {
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
