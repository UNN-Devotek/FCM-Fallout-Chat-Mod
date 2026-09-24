/** Test-only driver of the real widget and native-provider mocks; never linked into production. */
@:access(FCMChatWidget)
@:access(FcmRoster)
@:access(FcmServerSession)
class RosterScenario {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }

    public static function start(widget:FCMChatWidget, provider:String):Void {
        var attempts = 0;
        var timer = new haxe.Timer(250);
        timer.run = function():Void {
            try {
                if (++attempts > 80) throw "authenticated roster setup timed out";
                if (!widget._connected || widget._authState != "authenticated") return;
                widget.checkWorldId();
                drain(widget);
                if (!widget._serverSessionReady) return;
                timer.stop();
                check("actual native adapter matches requested provider", widget._api.provider == provider);
                check("roster control carries local UI identity as separate evidence",
                    MockXscal.lastRosterBody.indexOf("@self:VisibleSimulator") >= 0
                    && MockXscal.lastRosterBody.indexOf("HarnessPeer") >= 0);
                check("authenticated room diagnostic is fixed-schema and privacy safe",
                    MockXscal.roomDiagnosticCount > 0
                    && MockXscal.lastRoomDiagnosticBody.indexOf("event=roster_send") >= 0
                    && MockXscal.lastRoomDiagnosticBody.indexOf("build=" + FCMChatWidget.VERSION) >= 0
                    && MockXscal.lastRoomDiagnosticBody.indexOf("HarnessPeer") < 0
                    && MockXscal.lastRoomDiagnosticBody.indexOf("VisibleSimulator") < 0);
                var diagnosticCount = MockXscal.roomDiagnosticCount;
                widget.sendRoomDiagnostic("roster_send", "MapMenuData", 1);
                check("identical consecutive room diagnostics are suppressed",
                    MockXscal.roomDiagnosticCount == diagnosticCount);
                run(widget);
                flash.Lib.trace("ROSTER-SCENARIO PASS " + provider + " preserved=tab,history,nonce controls=unchanged diagnostic=bounded transcript=session hop=rebind expiry=leave mainMenu=leave");
            } catch (error:Dynamic) {
                timer.stop();
                flash.Lib.trace("ROSTER-SCENARIO FAIL " + provider + " " + Std.string(error));
            }
        };
    }

    static function drain(widget:FCMChatWidget):Void {
        // Exercise native max-16 polling, including ZFE's queued control completion frames.
        for (_ in 0...8) if (widget.runEventPollSafely() == 0) break;
    }

    static function map(names:Array<String>):Void {
        MockGameData.publish("MapMenuData", {MarkerData:[for (name in names)
            {markerType:"PlayerRemote", text:name, playerLevel:50}]});
    }

    static function serverRows(widget:FCMChatWidget):Int {
        var count = 0;
        for (record in widget._records) if (record.channel == "server") count++;
        return count;
    }

    static function run(widget:FCMChatWidget):Void {
        restoredReader(widget);
        MockGameData.publish("TeamMarkers", {Markers:[{name:"HarnessPeer"}]});
        widget.checkWorldId();
        drain(widget);
        MockXscal.enqueueServerHistory(widget._serverSession.room);
        drain(widget);
        widget.selectChannel(5);
        check("confirmed room renders SERVER in attached tab field", widget._subTf != null
            && widget._subTf.parent == widget && widget._subTf.visible && widget._subTf.text.indexOf("SERVER") >= 0);
        check("setup has one Server history row", serverRows(widget) == 1);
        check("setup selected Server tab", widget._chanIdx == 5);
        var nonce = widget._serverSession.target();
        var room = widget._serverSession.room;
        var controls = MockXscal.serverControlCount;
        var leaves = MockXscal.leaveControlCount;
        var records = widget._records.copy();

        var snapshots = haxe.Json.stringify(widget._rosterSnapshots.entries);
        var observations = haxe.Json.stringify(widget._rosterSourceObservations);
        var observationAt = widget._lastRosterObservationAt;
        var confirmationAt = widget._serverSession.confirmedAt;
        widget._rosterReadPhase = "decoder call";
        FcmRoster.readPhase = "decoder entry";
        MockXscal.SimLog.recent = [];
        widget.rosterReadFailed("PlayerListData", "snapshot", new flash.errors.Error("PRIVATE-ROSTER-ERROR", 1014));
        var warningAt = widget._rosterReadWarnings[0].at;
        widget.rosterReadFailed("PlayerListData", "snapshot", new flash.errors.Error("PRIVATE-ROSTER-ERROR", 1014));
        check("synthetic diagnostics are one-shot and restore the failing phase", widget._rosterRuntimeProbed
            && FcmRoster.readPhase == "decoder entry" && widget._rosterReadWarnings.length == 1
            && widget._rosterReadWarnings[0].at == warningAt);
        var diagnosticLog = MockXscal.SimLog.recent.join("\n");
        check("diagnostics emit numeric error and fixed phases without exception text",
            diagnosticLog.indexOf("snapshot phase=decoder call decoder=decoder entry errorID=1014") >= 0
            && diagnosticLog.indexOf("PRIVATE-ROSTER-ERROR") < 0);
        for (probe in ["type-int", "type-number", "finite", "empty", "player", "map", "teams"])
            check("local probe passes exactly once: " + probe, diagnosticLog.split(probe + " ok=true").length == 2);
        check("duplicate errors do not repeat diagnostic logs", MockXscal.SimLog.recent.length == 8);
        check("synthetic diagnostics cannot alter world evidence, leases, history or transport",
            haxe.Json.stringify(widget._rosterSnapshots.entries) == snapshots
            && haxe.Json.stringify(widget._rosterSourceObservations) == observations
            && widget._lastRosterObservationAt == observationAt && widget._serverSession.confirmedAt == confirmationAt
            && widget._serverSession.target() == nonce && widget._serverSession.room == room
            && widget._records.length == records.length && MockXscal.serverControlCount == controls
            && MockXscal.leaveControlCount == leaves);
        flash.Lib.trace("ROSTER-DIAGNOSTICS PASS probes=local-only repeated-error=throttled evidence=unchanged");
        flash.Lib.trace("ROSTER-PROBES PASS count=7 error=numeric-only phases=fixed private-error=omitted");

        MockGameData.setHudMode("Loading");
        MockGameData.publish("TeamMarkers", {Markers:[]});
        widget.checkWorldId();
        MockGameData.setHudMode("All");
        widget.checkWorldId();
        check("same world preserves Server tab", widget._chanIdx == 5);
        check("same world preserves history objects", widget._records.length == records.length
            && widget._records[widget._records.length - 1] == records[records.length - 1]);

        MockGameData.publish("TeamMarkers", {Markers:[{name:"DifferentNearbyPeer"}]});
        widget.checkWorldId();
        check("nearby change preserves history", serverRows(widget) == 1);
        map([]);
        widget.checkWorldId();
        widget.checkWorldId();
        check("temporary empty primary preserves history", serverRows(widget) == 1);
        map(["HarnessPeer"]);
        widget.checkWorldId();
        check("recovered primary preserves binding", widget._serverSessionReady
            && widget._serverSession.target() == nonce && widget._serverSession.room == room);
        check("same world keeps SERVER rendered", widget._subTf.text.indexOf("SERVER") >= 0);
        check("no leave or redundant roster for fast travel", MockXscal.serverControlCount == controls);

        // Native xScal capture: the map stayed empty beyond the grace period while
        // public-team membership remained populated. Nearby lists changed independently.
        MockGameData.publish("PublicTeamsData", {publicTeams:[{members:[{playerName:"HarnessPeer"}]}]});
        map([]);
        MockGameData.setHudMode("Loading");
        widget.checkWorldId();
        MockGameData.setHudMode("All");
        widget._rosterSnapshots.emptySince = flash.Lib.getTimer() - 60000;
        widget.checkWorldId();
        check("empty map with populated public teams preserves Server beyond empty grace",
            widget._serverSessionReady && widget._serverSession.target() == nonce
            && widget._serverSession.room == room && serverRows(widget) == 1 && widget._chanIdx == 5
            && MockXscal.serverControlCount == controls);

        // Repeat the actual transition, including source recovery. Check each cycle so a
        // transient clear/rebind cannot be hidden by an eventually healthy final state.
        for (cycle in 0...3) {
            map(["HarnessPeer"]);
            widget.checkWorldId();
            check("recovered map takes priority cycle=" + cycle,
                widget._rosterSnapshots.sessionSource(flash.Lib.getTimer(), 30000,
                    widget._lastRosterSent) == "MapMenuData");
            MockGameData.setHudMode("Loading");
            map([]);
            MockGameData.publish("TeamMarkers", {Markers:[]});
            widget.checkWorldId();
            MockGameData.setHudMode("All");
            MockGameData.publish("PublicTeamsData", {publicTeams:[{members:[{playerName:"HarnessPeer"}]}]});
            widget._rosterSnapshots.emptySince = flash.Lib.getTimer() - 60000;
            widget.checkWorldId();
            drain(widget);
            check("overlapping public teams selected cycle=" + cycle,
                widget._rosterSnapshots.sessionSource(flash.Lib.getTimer(), 30000,
                    widget._lastRosterSent) == "PublicTeamsData"
                && widget._rosterSnapshots.emptySince == -1);
            check("repeated travel preserves attached selected tab and original rows cycle=" + cycle,
                widget._serverSessionReady && widget._serverSession.target() == nonce
                && widget._serverSession.room == room && widget._chanIdx == 5
                && widget._subTf.parent == widget && widget._subTf.visible
                && widget._subTf.text.indexOf("SERVER") >= 0 && serverRows(widget) == 1
                && widget._records.length == records.length
                && widget._records[widget._records.length - 1] == records[records.length - 1]
                && MockXscal.serverControlCount == controls && MockXscal.leaveControlCount == leaves);
            flash.Lib.trace("ROSTER-CYCLE PASS " + cycle + " source=PublicTeamsData history=preserved controls=unchanged");
        }

        // An old auxiliary name must not mask an actually disjoint full roster.
        MockGameData.publish("TeamMarkers", {Markers:[{name:"HarnessPeer"}]});
        map(["NewWorldPeer"]);
        widget.checkWorldId();
        check("world hop leaves exactly once", MockXscal.leaveControlCount == leaves + 1);
        check("world hop retains old rows but rotates nonce", serverRows(widget) == 1
            && widget._serverSession.target() != nonce && !widget._serverSessionReady);
        widget.checkWorldId();
        drain(widget);
        check("world hop binds again", widget._serverSessionReady);
        check("world hop controls are bounded", MockXscal.serverControlCount == controls + 2);

        MockXscal.enqueueServerHistory(widget._serverSession.room);
        drain(widget);
        check("new room history joins the session transcript count=" + serverRows(widget), serverRows(widget) == 2);
        map([]);
        widget.checkWorldId();
        check("empty grace initially keeps the session transcript", serverRows(widget) == 2);
        // Advance only test-owned observation/confirmation timestamps, not a game clock.
        widget._rosterSnapshots.emptySince = flash.Lib.getTimer() - 60000;
        widget._serverSession.confirmedAt = flash.Lib.getTimer() - 60000;
        widget.checkWorldId();
        check("expired grace and lease leave membership but retain the transcript", serverRows(widget) == 2
            && !widget._serverSessionReady && MockXscal.leaveControlCount == leaves + 2);
        widget.checkWorldId();
        drain(widget);
        check("empty solo room can rebind after expiry", widget._serverSessionReady);
        MockXscal.enqueueServerHistory(widget._serverSession.room);
        drain(widget);
        // Replay authorization crosses the actual native adapter and carrier decoder.
        var replayRoom = "r:00000000-0000-4000-8000-000000000002";
        MockXscal.enqueueServerReady(widget._serverSession.requestId, replayRoom);
        MockXscal.enqueueRetainedHistory("", 101);
        MockXscal.enqueueRetainedHistory("r:stale", 102);
        MockXscal.enqueueRetainedHistory(replayRoom, 103);
        MockXscal.enqueueRetainedHistory(replayRoom, 103);
        drain(widget);
        check("only authorized retained row rendered once count=" + serverRows(widget)
            + " room=" + widget._serverSession.room, serverRows(widget) == 4);
        check("retained message identity preserved", widget._records[widget._records.length - 1].messageId
            == "server:r:00000000-0000-4000-8000-000000000001:103");
        flash.Lib.trace("RETAINED-HISTORY PASS authorized=once stale=rejected unmarked=rejected id=preserved");
        MockGameData.publish("MenuStackData", {menuStackA:[{menuName:"MainMenu"}]});
        widget.checkWorldId();
        widget.checkWorldId();
        check("main menu leaves once but keeps the session transcript", !widget._serverSessionReady
            && serverRows(widget) == 4 && MockXscal.leaveControlCount == leaves + 3);
    }

    static function restoredReader(widget:FCMChatWidget):Void {
        var savedSnapshots = widget._rosterSnapshots;
        var savedSources = widget._rosterSourceObservations;
        var savedAt = widget._lastRosterObservationAt;
        widget._rosterSnapshots = new FcmRoster();
        widget._rosterSourceObservations = [];
        var controls = MockXscal.serverControlCount;
        for (key in ["PlayerListData", "PartyMenuList", "TeamMarkers", "VoiceChatAreaData", "MapMenuData", "PublicTeamsData"]) {
            var data:Dynamic = switch key {
                case "TeamMarkers": {Markers:[{name:"Peer"}, {name:widget._displayName, isLocal:true}]};
                case "VoiceChatAreaData": {participants:[{name:"Peer"}, {name:widget._displayName, isSelf:true}]};
                case "MapMenuData": {MarkerData:[{markerType:"PlayerRemote", text:"Peer<title>"}, {markerType:"Location", text:"Not a player"}]};
                case "PublicTeamsData": {publicTeams:[{members:[{playerName:"Peer"}, {playerName:widget._displayName}]}]};
                default: [{displayName:"Peer"}, {displayName:widget._displayName, isLocalPlayer:true}];
            };
            widget.collectRoster(key, data);
            var matched = false;
            for (entry in widget._rosterSnapshots.entries) if (entry.key == key)
                matched = entry.names.join("|") == "Peer";
            check("restored native path decodes " + key, matched);
        }
        var source = widget._rosterSourceObservations[0];
        source.at = 1;
        widget.collectRoster("PlayerListData", [{displayName:"Peer"}]);
        check("unchanged pull cannot refresh old observation", source.at == 1);
        for (entry in widget._rosterSnapshots.entries) if (entry.key == "PlayerListData")
            check("stored snapshot keeps old pull time", entry.at == 1);
        widget.collectRoster("PlayerListData", [{displayName:"Peer"}], true);
        check("fresh push can refresh observation", source.at > 1);
        var before = haxe.Json.stringify(widget._rosterSnapshots.entries);
        var observationAt = widget._lastRosterObservationAt;
        widget.collectRoster("PlayerListData", {length:"1"});
        widget.collectRoster("PublicTeamsData", {publicTeams:[{members:{length:"1"}}]});
        widget.collectRoster("MapMenuData", {MarkerData:[{markerType:"PlayerRemote", text:new ThrowingWidgetRosterName()}]});
        widget.collectRoster("PlayerListData", [{displayName:new ThrowingWidgetRosterName()}]);
        check("malformed and damaged lists cannot replace or refresh evidence",
            haxe.Json.stringify(widget._rosterSnapshots.entries) == before
            && widget._lastRosterObservationAt == observationAt);
        check("reading a roster never sends transport directly", MockXscal.serverControlCount == controls);
        widget._rosterSnapshots = savedSnapshots;
        widget._rosterSourceObservations = savedSources;
        widget._lastRosterObservationAt = savedAt;
        flash.Lib.trace("RESTORED-READER PASS sources=6 cached-pull=stale fresh-push=accepted damaged=rejected");
    }
}

private class ThrowingWidgetRosterName {
    public function new() {}
    public function toString():String { throw new flash.errors.Error("PRIVATE-ROSTER-NAME", 1010); }
}
