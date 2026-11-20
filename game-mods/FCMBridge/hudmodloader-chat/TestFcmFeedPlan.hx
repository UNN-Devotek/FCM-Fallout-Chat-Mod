class TestFcmFeedPlan {
    static function check(label:String, ok:Bool):Void {
        if (!ok) throw label;
    }

    static function main():Void {
        // needsEmojiPass prefilter.
        check("null body skips emoji", !FcmFeedPlan.needsEmojiPass(null));
        check("empty body skips emoji", !FcmFeedPlan.needsEmojiPass(""));
        check("plain ascii skips emoji", !FcmFeedPlan.needsEmojiPass("hello world 123!?"));
        check("shortcode colon needs pass", FcmFeedPlan.needsEmojiPass("hello :vaultboy:"));
        check("discord markup needs pass", FcmFeedPlan.needsEmojiPass("hi <:wave:123456789012345678>"));
        check("unicode emoji needs pass", FcmFeedPlan.needsEmojiPass("good morning \u{1F600}"));
        check("time-like colon is a safe false positive", FcmFeedPlan.needsEmojiPass("meet at 12:30"));

        // recordKey identity precedence.
        var durable = FcmFeedPlan.recordKey("global", "m-1", "txn-9", "user|body|ready");
        var sameDurable = FcmFeedPlan.recordKey("global", "m-1", "", "user|body|ready");
        check("durable id wins over transaction token", durable == sameDurable);
        var pendingTxn = FcmFeedPlan.recordKey("global", "", "txn-1", "user|body|queued");
        var ackedTxn = FcmFeedPlan.recordKey("global", "", "txn-1", "user|body|ready");
        check("delivery-state change changes transaction key", pendingTxn != ackedTxn);
        var durablePending = FcmFeedPlan.recordKey("global", "m-1", "", "user|body|queued");
        check("delivery-state change changes durable key", durablePending != sameDurable);
        var otherChannel = FcmFeedPlan.recordKey("trade", "m-1", "", "user|body|ready");
        check("channel scopes the key", durable != otherChannel);
        var beforeEdit = FcmFeedPlan.recordKey("global", "m-1", "", "user|hello|ready");
        var afterEdit = FcmFeedPlan.recordKey("global", "m-1", "", "user|hello edited|ready");
        check("in-place body edit changes the key", beforeEdit != afterEdit);
        var beforeLink = FcmFeedPlan.recordKey("global", "m-1", "", "user|see this||ready");
        var afterLink = FcmFeedPlan.recordKey("global", "m-1", "", "user|see this|https://example.com/x|ready");
        check("link resolution change changes the key", beforeLink != afterLink);
        var beforeCosmetics = FcmFeedPlan.recordKey("global", "m-1", "", "user|tag-a|gold|no-star|body|ready");
        var afterCosmetics = FcmFeedPlan.recordKey("global", "m-1", "", "user|tag-b|pink|star|body|ready");
        check("cosmetic change changes the key", beforeCosmetics != afterCosmetics);
        var beforeModeration = FcmFeedPlan.recordKey("global", "m-1", "", "user|body|moderation-off");
        var afterModeration = FcmFeedPlan.recordKey("global", "m-1", "", "user|body|moderation-on");
        check("moderation change changes the key", beforeModeration != afterModeration);
        var sameContent = FcmFeedPlan.recordKey("global", "m-1", "", "user|hello|ready");
        check("identical content reuses", beforeEdit == sameContent);

        // prefixReuseCount.
        var oldKeys = [durable, pendingTxn, FcmFeedPlan.recordKey("trade", "m-2", "", "row-2")];
        var appended = oldKeys.concat([FcmFeedPlan.recordKey("trade", "m-3", "", "row-3")]);
        check("tail append reuses the full prefix", FcmFeedPlan.prefixReuseCount(oldKeys, appended) == 3);
        var changedMiddle = [durable, ackedTxn, FcmFeedPlan.recordKey("trade", "m-2", "", "row-2")];
        check("pending flip stops reuse at the changed row",
            FcmFeedPlan.prefixReuseCount(oldKeys, changedMiddle) == 1);
        var prepended = [FcmFeedPlan.recordKey("global", "m-0", "", "row-0")].concat(oldKeys);
        check("prepend invalidates prefix reuse", FcmFeedPlan.prefixReuseCount(oldKeys, prepended) == 0);
        check("null inputs reuse nothing", FcmFeedPlan.prefixReuseCount(null, appended) == 0);
        var identityLess = [durable, FcmFeedPlan.recordKey("global", "", "", "identity-less")];
        check("identity-less rows never reuse",
            FcmFeedPlan.prefixReuseCount(identityLess, identityLess) == 1);

        // headTrimOffset / windowReuseCount: ring-buffer trim and changed tail rows.
        var k0 = FcmFeedPlan.recordKey("global", "m-10", "", "a");
        var k1 = FcmFeedPlan.recordKey("global", "m-11", "", "b");
        var k2 = FcmFeedPlan.recordKey("global", "m-12", "", "c");
        var k3pending = FcmFeedPlan.recordKey("global", "", "txn-5", "me|hi|queued");
        var k3ready = FcmFeedPlan.recordKey("global", "", "txn-5", "me|hi|ready");
        var k4 = FcmFeedPlan.recordKey("global", "m-14", "", "d");
        var before = [k0, k1, k2, k3pending];
        check("unchanged head has offset 0", FcmFeedPlan.headTrimOffset(before, [k0, k1, k2, k3ready]) == 0);
        check("acknowledged tail row keeps the rows before it",
            FcmFeedPlan.windowReuseCount(before, [k0, k1, k2, k3ready], 0) == 3);
        var trimmed = [k1, k2, k3pending, k4];
        check("one trimmed head row gives offset 1", FcmFeedPlan.headTrimOffset(before, trimmed) == 1);
        check("trim plus append keeps every surviving row",
            FcmFeedPlan.windowReuseCount(before, trimmed, 1) == 3);
        check("trim plus acknowledged tail keeps the unchanged rows",
            FcmFeedPlan.windowReuseCount(before, [k2, k3ready, k4], 2) == 1);
        check("unknown first row gives no offset",
            FcmFeedPlan.headTrimOffset(before, [FcmFeedPlan.recordKey("global", "m-9", "", "z"), k0]) == -1);
        check("identity-less first row gives no offset",
            FcmFeedPlan.headTrimOffset([FcmFeedPlan.recordKey("global", "", "", "x")],
                [FcmFeedPlan.recordKey("global", "", "", "x")]) == -1);
        check("empty new snapshot gives no offset", FcmFeedPlan.headTrimOffset(before, []) == -1);
        check("negative offset reuses nothing", FcmFeedPlan.windowReuseCount(before, trimmed, -1) == 0);
        check("offset past the end reuses nothing", FcmFeedPlan.windowReuseCount(before, trimmed, 4) == 0);

        // nextSliceSize adaptive bounds.
        check("cheap slice grows", FcmFeedPlan.nextSliceSize(6, 2.0) == 7);
        check("expensive slice shrinks", FcmFeedPlan.nextSliceSize(6, 20.0) == 5);
        check("nominal slice holds", FcmFeedPlan.nextSliceSize(6, 8.0) == 6);
        check("slice clamps at max", FcmFeedPlan.nextSliceSize(12, 1.0) == 12);
        check("slice clamps at min", FcmFeedPlan.nextSliceSize(4, 99.0) == 4);
        check("out-of-range input clamps first",
            FcmFeedPlan.nextSliceSize(99, 8.0) == FcmFeedPlan.MAX_SLICE_ROWS);

        // Server replay is stored completely, but General projects only the
        // chronological overlap with its loaded static history.
        check("older replay stays out of General",
            !FcmFeedPlan.replayVisibleInFeed("global", "server", true,
                "2026-09-16T11:00:00Z", "2026-09-16T12:00:00Z"));
        check("overlapping replay slots into General",
            FcmFeedPlan.replayVisibleInFeed("global", "server", true,
                "2026-09-16T12:05:00Z", "2026-09-16T12:00:00Z"));
        check("Server tab retains complete replay",
            FcmFeedPlan.replayVisibleInFeed("server", "server", true,
                "2026-09-16T11:00:00Z", "2026-09-16T12:00:00Z"));
        check("live Server row remains visible in General",
            FcmFeedPlan.replayVisibleInFeed("global", "server", false,
                "2026-09-16T11:00:00Z", "2026-09-16T12:00:00Z"));
        check("original timestamps order replay between static rows",
            FcmFeedPlan.compareChronology("2026-09-16T12:05:00Z", 3,
                "2026-09-16T12:10:00Z", 2) < 0
            && FcmFeedPlan.compareChronology("2026-09-16T12:05:00Z", 3,
                "2026-09-16T12:00:00Z", 1) > 0);
        check("missing timestamps retain arrival order",
            FcmFeedPlan.compareChronology("", 4, "", 5) < 0);
        var helpTime = FcmFeedPlan.utcTimestamp(Date.fromTime(1790364339640.0));
        check("local help uses relay-compatible UTC time", helpTime == "2026-09-25T19:25:39.640Z");
        check("later dated messages follow local help",
            FcmFeedPlan.compareChronology(helpTime, 10, "2026-09-25T19:25:40.000Z", 11) < 0);

        // A fast player clock must not pin event-command feedback under newer chat.
        var fastClock = Date.fromTime(1790364339640.0 + 10 * 60 * 1000.0);
        var noticeTime = FcmFeedPlan.localNoticeTimestamp("2026-09-25T19:25:39.640Z", fastClock);
        check("local notice anchors to newest relay time", noticeTime == "2026-09-25T19:25:39.640Z");
        check("announcement after a fast-clock notice sorts below it",
            FcmFeedPlan.compareChronology(noticeTime, 10, "2026-09-25T19:25:41.000Z", 11) < 0);
        check("notice follows the row it was anchored to",
            FcmFeedPlan.compareChronology("2026-09-25T19:25:39.640Z", 9, noticeTime, 10) < 0);
        check("empty feed notice falls back to UTC now",
            FcmFeedPlan.localNoticeTimestamp("", Date.fromTime(1790364339640.0)) == helpTime
            && FcmFeedPlan.localNoticeTimestamp(null, Date.fromTime(1790364339640.0)) == helpTime);

        // Scrolling with nothing selected: Up starts at newest, Down stays at newest.
        check("down with no selection stays pinned to newest", FcmFeedPlan.initialRowSelection(1, 20) == -1);
        check("up with no selection selects newest row", FcmFeedPlan.initialRowSelection(-1, 20) == 19);
        check("empty feed selects nothing", FcmFeedPlan.initialRowSelection(-1, 0) == -1);

        // Coalescer: bursts collapse into one tick.
        var coalescer = new FcmRenderCoalescer();
        check("first request schedules the tick", coalescer.request());
        check("tick is scheduled", coalescer.isScheduled());
        check("second burst request does not reschedule", !coalescer.request());
        check("dirty survives the burst", coalescer.isDirty());
        check("tick renders once", coalescer.consumeTick());
        check("tick clears scheduled flag", !coalescer.isScheduled());
        check("idle tick renders nothing", !coalescer.consumeTick());
        check("new burst after idle reschedules", coalescer.request());
        coalescer.reset();
        check("reset drops the pending render", !coalescer.isDirty() && !coalescer.isScheduled());

        Sys.println("FCM feed-plan tests passed");
    }
}
