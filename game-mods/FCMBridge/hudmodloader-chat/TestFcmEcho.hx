/** Unit tests for the single-row self-echo transaction reducer. Run: haxe test-echo.hxml */
class TestFcmEcho {
    static var failures:Int = 0;

    static function check(name:String, cond:Bool):Void {
        if (cond) Sys.println("ok   - " + name);
        else { Sys.println("FAIL - " + name); failures++; }
    }

    static function pending(index:Int, id:String, sender:String, name:String,
            channel:String, body:String, accepted:Bool = true, at:Float = 1000):FcmEcho.FcmPendingEcho {
        return {
            recordIndex: index, messageId: id, senderUserId: sender, displayName: name,
            channel: channel, body: body, accepted: accepted, createdAt: at
        };
    }

    static function main():Void {
        var exact = [pending(4, "m-1", "relay-1", "Devotek", "global", "hello")];
        var idDecision = FcmEcho.choose("m-1", "unknown", "Other", "global", "hello",
            exact, 1001, "relay-1", "native-1", "linked-1");
        check("stable transport id selects the canonical row", idDecision.recordIndex == 4
            && idDecision.mode == "id");

        var identity = [pending(7, "", "relay-1", "Devotek", "global", "hello")];
        var identityDecision = FcmEcho.choose("event-1", "linked-1", "Devotek", "global", "hello",
            identity, 1001, "relay-1", "native-1", "linked-1");
        check("linked sender identity selects the canonical row", identityDecision.recordIndex == 7
            && identityDecision.mode == "identity");

        var legacy = [pending(2, "", "relay-1", "Devotek", "global", "hello")];
        var legacyDecision = FcmEcho.choose("event-1", "fcm-account-1", "Devotek", "global", "hello",
            legacy, 1001, "relay-1", "native-1", "");
        check("old Dev event falls back to one accepted display-name transaction",
            legacyDecision.recordIndex == 2 && legacyDecision.mode == "legacy-name");

        var wrongName = FcmEcho.choose("event-1", "fcm-account-1", "SomeoneElse", "global", "hello",
            legacy, 1001, "relay-1", "native-1", "");
        check("legacy fallback does not consume a different display name", wrongName.recordIndex < 0);

        var unaccepted = [pending(2, "", "relay-1", "Devotek", "global", "hello", false)];
        var unacceptedDecision = FcmEcho.choose("event-1", "fcm-account-1", "Devotek", "global", "hello",
            unaccepted, 1001, "relay-1", "native-1", "");
        check("an event cannot consume a send that was not ACK-accepted",
            unacceptedDecision.recordIndex < 0);

        var late = [pending(2, "", "relay-1", "Devotek", "global", "hello")];
        var lateDecision = FcmEcho.choose("event-1", "fcm-account-1", "Devotek", "global", "hello",
            late, 16001, "relay-1", "native-1", "");
        check("late legacy events do not consume a newer transaction", lateDecision.recordIndex < 0);

        var ambiguous = [
            pending(1, "", "relay-1", "Devotek", "global", "hello"),
            pending(2, "", "relay-1", "Devotek", "global", "hello")
        ];
        var ambiguousDecision = FcmEcho.choose("event-1", "fcm-account-1", "Devotek", "global", "hello",
            ambiguous, 1001, "relay-1", "native-1", "");
        check("identical simultaneous sends remain ambiguous", ambiguousDecision.recordIndex < 0
            && ambiguousDecision.mode == "ambiguous");

        var foreign = [pending(1, "", "relay-1", "Devotek", "global", "hello")];
        var foreignDecision = FcmEcho.choose("event-1", "foreign-1", "Devotek", "global", "hello",
            foreign, 1001, "relay-1", "native-1", "linked-1");
        check("known linked sessions reject a foreign same-named sender", foreignDecision.recordIndex < 0);

        var preAck = [pending(9, "", "relay-1", "Devotek", "global", "fast", false)];
        var preAckRejected = FcmEcho.choose("event-2", "fcm-account-1", "Devotek", "global", "fast",
            preAck, 1001, "relay-1", "native-1", "", false);
        check("pre-ACK events stay gated without the explicit race allowance",
            preAckRejected.recordIndex < 0);
        var preAckDecision = FcmEcho.choose("event-2", "fcm-account-1", "Devotek", "global", "fast",
            preAck, 1001, "relay-1", "native-1", "", true);
        check("a stable live event can complete a row before its ACK",
            preAckDecision.recordIndex == 9 && preAckDecision.mode == "legacy-name");

        var placement = FcmStarLayout.row(74.0, 18.0, 13.0, 5.0, 4.0, true, 2.0);
        check("star starts after the measured channel field plus the visual nudge", placement.markerX == 79.0);
        check("star is vertically centered in the author line plus the visual nudge", placement.markerY == 4.5);
        check("message content starts after the reserved star slot", placement.contentX == 96.0);

        if (failures > 0) Sys.exit(1);
    }
}
