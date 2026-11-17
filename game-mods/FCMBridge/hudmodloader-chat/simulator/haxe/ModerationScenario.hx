/**
 * Staff /mod parsing, Server-row account targets, error mapping, provider support and
 * relay-delivered deletions. Commands run through the real widget handlers and provider
 * adapter; only the relay's moderation reply is scripted.
 */
@:access(FCMChatWidget)
class ModerationScenario {
    static inline var ACCOUNT = "22222222-2222-4222-8222-222222222222";
    static inline var ROOM = "r:00000000-0000-4000-8000-000000000001";
    static inline var GLOBAL_ID = "33333333-3333-4333-8333-333333333333";

    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    static function logText(widget:FCMChatWidget):String {
        return widget._logTf == null ? "" : widget._logTf.text;
    }

    static function run(widget:FCMChatWidget, command:String):String {
        check("command consumed: " + command, widget.handleModerationCommand(command));
        return logText(widget);
    }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var timer = new haxe.Timer(250);
        timer.run = function():Void {
            try {
                if (++attempts > 60) throw "moderation setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                timer.stop();
                widget._canModerate = true;
                widget._chanIdx = 0; // General shows the Global and Server rows together.

                // One player posts in Global (account UUID sender) and Server (relay id + a=).
                var session = new FcmServerSession();
                session.begin("moderation-fixture");
                check("fixture room", session.accept(FcmServerSession.READY_PREFIX + "moderation-fixture|" + ROOM, flash.Lib.getTimer()));
                widget._serverSession = session;
                widget._serverSessionReady = true;
                var serverId = "server:" + ROOM + ":4242";
                widget.parseAndRenderEvents('{"success":true,"events":['
                    + '{"id":9001,"kind":"chat.message","channel":"global","messageId":"' + GLOBAL_ID + '",'
                    + '"senderUserId":"' + ACCOUNT + '","senderDisplayName":"Alice","body":"global row","targetUserId":""},'
                    + '{"id":9002,"kind":"chat.message","channel":"server","messageId":"' + serverId + '",'
                    + '"senderUserId":"user_0123456789abcdef0123456789abcdef","senderDisplayName":"Alice","body":"server row",'
                    + '"targetUserId":"FCMHUD/1;m=' + StringTools.urlEncode(serverId) + ';a=' + ACCOUNT + '"}]}');
                var serverRecord = null;
                for (rec in widget._records) if (rec.messageId == serverId) serverRecord = rec;
                check("server row stored", serverRecord != null);
                check("server row carries the account id", serverRecord.accountId == ACCOUNT);

                // A provider without moderationAction is reported, not silently ignored.
                MockXscal.moderationSupported = false;
                check("unsupported provider", run(widget, "/mod Alice kick rude")
                    .indexOf("not supported by this chat provider") >= 0);
                MockXscal.moderationSupported = true;

                var calls = MockXscal.moderationCount;
                check("ban 0 refused locally", run(widget, "/mod Alice ban 0 spam").indexOf("Ban duration") >= 0);
                check("ban without duration refused", run(widget, "/mod Alice ban spamming links")
                    .indexOf("Ban needs a duration") >= 0);
                check("mute garbage refused", run(widget, "/mod Alice mute 5x spam").indexOf("Mute duration") >= 0);
                check("parse errors never reach the relay", MockXscal.moderationCount == calls);

                // Same account in Global and Server is one target, not "matches multiple players".
                var submitted = run(widget, "/mod Alice ban 1d spam");
                check("ban submitted: " + submitted, submitted.indexOf("submitted") >= 0);
                var payload = MockXscal.lastModerationPayload;
                check("ban targets the account", payload.indexOf('"targetUserId":"' + ACCOUNT + '"') >= 0);
                check("ban duration survives in the ZFE-safe envelope", payload.indexOf("FCMMOD/1;d=1440") >= 0
                    && payload.indexOf('"durationMinutes":1440') >= 0);
                run(widget, "/mod Alice ban perm repeat offender");
                check("perm ban is explicit", MockXscal.lastModerationPayload.indexOf("FCMMOD/1;p=1") >= 0
                    && MockXscal.lastModerationPayload.indexOf('"permanent":true') >= 0);
                run(widget, "/mod #S0004242 mute 2h flooding");
                check("server reference resolves", MockXscal.lastModerationPayload.indexOf("FCMMOD/1;d=120") >= 0
                    && MockXscal.lastModerationPayload.indexOf(ACCOUNT) >= 0);

                calls = MockXscal.moderationCount;
                check("server delete explained", run(widget, "/mod #S0004242 delete spam")
                    .indexOf("cannot be deleted") >= 0 && MockXscal.moderationCount == calls);

                MockXscal.moderationReply = {success:false, error:{code:"protected_target", message:"protected"}};
                check("protected target text", run(widget, "/mod Alice kick rude")
                    .indexOf("Staff members cannot be moderated") >= 0);
                MockXscal.moderationReply = {success:false, error:{code:"future_code", message:"Relay detail"}};
                check("unknown code falls back", run(widget, "/mod Alice kick rude").indexOf("Relay detail") >= 0);
                MockXscal.moderationReply = null;

                // Banned players have no visible row; unban resolves an exact name on the relay.
                run(widget, "/mod \"Ghost Player\" unban appeal accepted");
                check("unban by name", MockXscal.lastModerationPayload.indexOf("FCMMOD/1;n=Ghost%20Player") >= 0
                    && MockXscal.lastModerationPayload.indexOf('"targetUserId":""') >= 0);
                calls = MockXscal.moderationCount;
                check("kick still needs a visible row", run(widget, "/mod Ghost kick rude")
                    .indexOf("not visible") >= 0 && MockXscal.moderationCount == calls);

                // A delete made elsewhere removes the row for every capable HUD.
                widget.parseAndRenderEvents('{"success":true,"events":[{"id":9003,"kind":"chat.message",'
                    + '"channel":"system","messageId":"del-fixture","senderUserId":"system","senderDisplayName":"FCM",'
                    + '"body":"FCMDEL/1;m=' + GLOBAL_ID + '","targetUserId":""}]}');
                var remaining = 0;
                for (rec in widget._records) if (rec.messageId == GLOBAL_ID) remaining++;
                check("remote delete removed the row", remaining == 0);
                check("delete event is not a link notice", !widget._needsLink);

                flash.Lib.trace("MODERATION PASS " + provider
                    + " durations=parsed server-target=account errors=mapped delete=removed");
            } catch (error:Dynamic) {
                timer.stop();
                flash.Lib.trace("MODERATION FAIL " + provider + " " + Std.string(error));
            }
        };
    }
}
