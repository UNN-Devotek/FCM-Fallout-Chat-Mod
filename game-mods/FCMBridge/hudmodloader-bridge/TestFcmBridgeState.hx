class TestFcmBridgeState {
    static var checks = 0;
    static function check(value:Bool, label:String):Void { checks++; if (!value) throw label; }
    static function ready(data:Dynamic):Dynamic { return {isTest:false, dataReady:true, data:data}; }
    static var readers:Array<{state:FcmBridgeState, reader:FcmHudRosterReader}> = [];
    static function menu(state:FcmBridgeState, provider:Dynamic):Void {
        state.menu(FcmHudRosterReader.menu(provider));
    }
    static function observe(state:FcmBridgeState, key:String, provider:Dynamic, local:String, at:Float, pushed:Bool = false):Void {
        var reader = null;
        for (entry in readers) if (entry.state == state) reader = entry.reader;
        if (reader == null) { reader = new FcmHudRosterReader(); readers.push({state:state, reader:reader}); }
        if (state.rosterGate() != "") state.observe(new FcmHudRosterReader.FcmRosterObservation(key, at, state.rosterGate()));
        else state.observe(reader.provider(key, provider, local, at, pushed));
    }
    static function main():Void {
        var aliases = new FcmBridgeState(function() return "alias-world");
        menu(aliases, ready({menuStackA:[]}));
        observe(aliases, "PlayerListData", ready([
            {isLocalPlayer:true,displayName:"CharacterLabel"}, {displayName:"PrivatePeer"}
        ]), "AccountLabel", 1000, true);
        aliases.settle(1000);
        check(aliases.rosterSelfName(1000, "AccountLabel") == "CharacterLabel", "selected self row supplies the bridge label");
        check(aliases.rosterAliases(1000, "CharacterLabel", "AccountLabel").join("|") == "accountlabel",
            "only observed self/account names become aliases, never peer rows");
        check(aliases.rosterSource(1000) == "PlayerListData", "export diagnostic identifies the selected roster source");
        observe(aliases, "PlayerListData", ready([]), "AccountLabel", 2000, true);
        check(aliases.rosterAliases(2000, "AccountLabel", "AccountLabel").join("|") == "characterlabel",
            "an empty UI snapshot does not immediately discard a still-fresh self label");
        observe(aliases, "PlayerListData", ready([]), "AccountLabel", 30000);
        check(aliases.rosterAliases(31000, "AccountLabel", "AccountLabel").length == 0,
            "cached polling and empty pushes never renew retained self-label evidence");
        aliases.reset();
        check(aliases.rosterAliases(1001, "AccountLabel", "AccountLabel").length == 0,
            "a generation boundary blocks cached self aliases");
        check(FcmBridgeRead.retryDelay(1) == 2000 && FcmBridgeRead.retryDelay(2) == 4000
            && FcmBridgeRead.retryDelay(5) == 30000 && FcmBridgeRead.retryDelay(99) == 30000,
            "repeated source exceptions back off within a fixed ceiling");
        var diagnosticState = new FcmBridgeState(function() return "diagnostic-private-nonce");
        check(diagnosticState.diagnostics(0).indexOf("Menu - not observed") >= 0,
            "diagnostics distinguish a menu that has not been observed");
        menu(diagnosticState, {dataReady:true, isTest:true, data:{menuStackA:[]}});
        check(diagnosticState.diagnostics(0).indexOf("Menu - test provider") >= 0,
            "diagnostics explain rejected test menu providers");
        menu(diagnosticState, {dataReady:false, data:{menuStackA:[]}});
        check(diagnosticState.diagnostics(0).indexOf("Menu - not ready") >= 0,
            "diagnostics explain unready menu providers");
        menu(diagnosticState, ready({}));
        check(diagnosticState.diagnostics(0).indexOf("Menu - missing list") >= 0,
            "diagnostics distinguish a missing menu list");
        menu(diagnosticState, ready({menuStackA:[{menuName:"LoadingMenu"}]}));
        observe(diagnosticState, "MapMenuData", ready({MarkerData:[]}), "PrivateName", 0);
        check(diagnosticState.diagnostics(0).indexOf("Menu - loading") >= 0
            && diagnosticState.diagnostics(0).indexOf("Map - world gate") >= 0,
            "diagnostics identify startup loading without changing readiness");
        menu(diagnosticState, ready({menuStackA:[]}));
        observe(diagnosticState, "MapMenuData", ready({MarkerData:{length:4096}}), "PrivateName", 0);
        check(diagnosticState.diagnostics(0).indexOf("Map - invalid list") >= 0,
            "diagnostics explain rejected roster shapes");
        observe(diagnosticState, "MapMenuData", ready({MarkerData:[{markerType:"PlayerRemote",text:"PrivatePeer"}]}), "PrivateName", 10);
        check(diagnosticState.diagnostics(10).indexOf("Map - accepted") >= 0
            && diagnosticState.diagnostics(10).indexOf("Roster - fresh") >= 0,
            "accepted observation diagnostics are accurate");
        check(diagnosticState.diagnostics(30010).indexOf("Roster - expired") >= 0,
            "diagnostics do not renew freshness");
        check(diagnosticState.diagnostics(10).join(" ").indexOf("Private") < 0
            && diagnosticState.diagnostics(10).join(" ").indexOf("diagnostic-private") < 0,
            "diagnostics never include private data or nonce");
        diagnosticState.readProblem("MapMenuData", true);
        diagnosticState.readProblem("PublicTeamsData");
        check(diagnosticState.diagnostics(10).indexOf("Map - expired push") >= 0
            && diagnosticState.diagnostics(10).indexOf("Public teams - read failed") >= 0,
            "diagnostics distinguish expired pushes from throwing reads");
        diagnosticState.readException("MapMenuData", new FcmBridgeRead(), {errorID:1014, message:"PrivatePeer payload"});
        check(diagnosticState.diagnostics(10).indexOf("Map - getter E1014") >= 0,
            "getter errors retain only phase and numeric error ID");
        var processing = new FcmBridgeRead();
        processing.step = "processor entry";
        diagnosticState.readException("PublicTeamsData", processing, {errorID:1034, message:"PrivatePeer"});
        check(diagnosticState.diagnostics(10).indexOf("Public teams - processor entry E1034") >= 0,
            "processor-entry errors cannot masquerade as failed getters");
        check(FcmBridgeRead.errorCode({errorID:-1}) == "error"
            && FcmBridgeRead.errorCode({errorID:1.5}) == "error"
            && FcmBridgeRead.errorCode({errorID:100000}) == "error"
            && FcmBridgeRead.errorCode({errorID:"PrivatePeer"}) == "error"
            && FcmBridgeRead.errorCode("PrivatePeer") == "error",
            "invalid error IDs and free-text exceptions are never displayed");
        for (message in ["Class haxe.iterators::ArrayIterator could not be found.",
                "Error #1014: Class haxe.iterators::ArrayIterator could not be found."]) {
            check(FcmBridgeRead.missingClass({errorID:1014, message:message}) == "haxe.iterators::ArrayIterator",
                "E1014 exposes only the missing qualified class identifier");
        }
        for (message in ["PrivatePeer payload", "Class Private Peer could not be found.",
                "Class https://private.example could not be found.",
                "Class Array could not be found.\nPrivatePeer stack", "Class Array;PrivatePeer could not be found.",
                "Class Array,PrivatePeer could not be found.", "Class <PrivatePeer> could not be found.",
                "Class 12345 could not be found.", "Class " + StringTools.lpad("A", "A", 81) + " could not be found."]) {
            check(FcmBridgeRead.missingClass({errorID:1014, message:message}) == "not reported",
                "noncanonical text, delimiters, and overlong identifiers are not rendered");
        }
        check(FcmBridgeRead.missingClass({errorID:1009, message:"Class Array could not be found."}) == ""
            && FcmBridgeRead.missingClass({errorID:1014, message:{name:"PrivatePeer"}}) == "not reported",
            "class parsing neither coerces objects nor interprets other error codes");
        diagnosticState.readException("MapMenuData", processing,
            {errorID:1014, message:"Class FcmRoster could not be found."});
        check(diagnosticState.missingClass == "FcmRoster", "latest class diagnostic is cached");
        diagnosticState.reset();
        check(diagnosticState.missingClass == "not reported", "reset clears a prior missing class diagnostic");
        var nonce = 0;
        var state = new FcmBridgeState(function() return "nonce-" + ++nonce);
        menu(state, {data:{menuStackA:[]}, isTest:true, dataReady:true});
        observe(state, "PlayerListData", ready([]), "Self", 0);
        check(!state.fresh(0), "test provider is not world evidence");
        menu(state, ready({menuStackA:[]}));
        observe(state, "PlayerListData", {data:[], dataReady:false}, "Self", 0);
        check(!state.fresh(0), "unready arrays cannot seed rooms");
        var data = [{displayName:"Other<title>"}, {displayName:"Self", isLocal:true}, {displayName:"Other<title>"}];
        observe(state, "PlayerListData", ready(data), "Self", 10);
        state.settle(10);
        check(state.fresh(10) && state.names(10).join("|") == "Other", "roster normalized and bounded to unique peers");
        check(state.rosterSelfName(10, "AccountSelf") == "Self",
            "same-source local roster name overrides account handle for grouping evidence");
        check(!state.session.accept("FCMCTL/1/SERVER-READY:stale|r:old", 10), "stale room confirmation rejected");
        check(state.session.accept("FCMCTL/1/SERVER-READY:nonce-1|r:one", 10), "matching room confirmation accepted");
        menu(state, ready({menuStackA:[{menuName:"LoadingMenu"}]}));
        check(state.inWorld && state.session.room == "r:one" && state.session.requestId == "nonce-1",
            "same-server loading must retain the confirmed room and nonce");
        menu(state, ready({menuStackA:[]}));
        observe(state, "TeamMarkers", ready({Markers:[{displayName:"Other"}]}), "Self", 11);
        observe(state, "TeamMarkers", ready({Markers:[{displayName:"DifferentNearbyPeer"}]}), "Self", 11);
        state.settle(11);
        check(state.session.requestId == "nonce-1", "nearby list changes cannot reset a stable primary roster");
        menu(state, ready({menuStackA:[{menuName:"MainMenu"}]}));
        check(!state.fresh(11) && state.session.room == "", "main menu invalidates room immediately");
        menu(state, ready({menuStackA:[]}));
        observe(state, "PlayerListData", ready(data), "Self", 12);
        check(!state.fresh(12), "cached old-world provider cannot re-seed a new world");
        observe(state, "PlayerListData", ready(data), "Self", 13, true);
        state.settle(13);
        check(state.fresh(13), "fresh provider push can confirm an unchanged roster");
        var previous = state.session.requestId;
        observe(state, "TeamMarkers", ready({Markers:[{displayName:"StalePeer"}]}), "Self", 14);
        observe(state, "PlayerListData", ready([{displayName:"NewPeer"}]), "Self", 15);
        state.settle(15);
        check(state.session.requestId != previous && state.names(15).join("|") == "NewPeer", "disjoint roster resets other providers");
        check(!state.fresh(30015), "observations expire at 30 seconds");
        var connectedNonce = state.session.requestId;
        state.reconnect();
        check(state.session.requestId != connectedNonce && state.names(16).join("|") == "NewPeer", "transport reconnect preserves current-world observations with a fresh nonce");
        menu(state, ready({menuStackA:[{menuName:"LoadingMenu"}]}));
        state.settle(17);
        check(state.holding(17), "loading pauses controls without retiring a fresh world");
        observe(state, "PlayerListData", ready([{displayName:"DuringLoading"}]), "Self", 30014, true);
        check(state.names(30014).join("|") == "NewPeer", "loading callbacks cannot refresh stale world evidence");
        state.settle(30015);
        check(!state.holding(30015) && !state.fresh(30015) && state.session.room == "", "long loading expires instead of renewing old world");

        var travel = new FcmBridgeState(function() return "travel-" + ++nonce);
        menu(travel, ready({menuStackA:[{menuName:"LoadingMenu"}]}));
        observe(travel, "PlayerListData", ready(data), "Self", 0);
        check(!travel.inWorld && !travel.fresh(0), "initial loading cannot invent an in-world session");
        menu(travel, ready({menuStackA:[]}));
        var map = {MarkerData:[{markerType:"PlayerRemote", text:"PeerA"}, {markerType:"PlayerRemote", text:"PeerB"}]};
        observe(travel, "MapMenuData", ready(map), "Self", 100);
        observe(travel, "PlayerListData", ready(data), "Self", 100);
        travel.settle(100);
        var travelNonce = travel.session.requestId;
        check(travel.names(100).join("|") == "PeerA|PeerB", "map takes precedence over other lists");
        travel.session.accept("FCMCTL/1/SERVER-READY:" + travelNonce + "|r:travel", 100);
        observe(travel, "MapMenuData", ready({MarkerData:[]}), "Self", 200);
        travel.settle(200);
        check(travel.holding(200) && travel.session.requestId == travelNonce, "empty primary holds nonce even with stale auxiliary names");
        observe(travel, "MapMenuData", ready(map), "Self", 500);
        travel.settle(500);
        check(!travel.holding(500) && travel.session.requestId == travelNonce && travel.session.room == "r:travel", "same roster after empty preserves confirmation");
        observe(travel, "MapMenuData", ready({MarkerData:[{markerType:"PlayerRemote", text:"PeerB"}, {markerType:"PlayerRemote", text:"PeerC"}]}), "Self", 600);
        travel.settle(600);
        check(travel.session.requestId == travelNonce, "overlapping roster churn is not a world hop");
        observe(travel, "MapMenuData", ready({MarkerData:[]}), "Self", 700);
        travel.settle(700);
        observe(travel, "MapMenuData", ready({MarkerData:[]}), "Self", 30699);
        travel.settle(30699);
        check(travel.holding(30699), "repeated empty remains bounded to original grace");
        observe(travel, "MapMenuData", ready({MarkerData:[]}), "Self", 30700);
        travel.settle(30700);
        check(!travel.holding(30700) && travel.session.requestId != travelNonce && travel.session.room == "", "empty grace expires at exactly 30 seconds and retires old nonce");
        check(!travel.fresh(30700), "unchanged empty getter wrappers cannot establish a fresh solo world after expiry");
        observe(travel, "MapMenuData", ready({MarkerData:[]}), "Self", 30701, true);
        travel.settle(30701);
        check(travel.fresh(30701) && travel.names(30701).length == 0,
            "fresh solo push does not revive old player-list names");
        var publicTravel = new FcmBridgeState(function() return "public-" + ++nonce);
        menu(publicTravel, ready({menuStackA:[]}));
        observe(publicTravel, "MapMenuData", ready(map), "Self", 100);
        observe(publicTravel, "PublicTeamsData", ready({publicTeams:[{members:[
            {playerName:"PeerA"}, {playerName:"PeerB"}]}]}), "Self", 100);
        publicTravel.settle(100);
        var publicNonce = publicTravel.session.requestId;
        publicTravel.session.accept("FCMCTL/1/SERVER-READY:" + publicNonce + "|r:public", 100);
        observe(publicTravel, "MapMenuData", ready({MarkerData:[]}), "Self", 200);
        publicTravel.settle(200);
        check(!publicTravel.holding(200) && publicTravel.names(200).join("|") == "PeerA|PeerB"
            && publicTravel.session.requestId == publicNonce, "empty map must not hold or reset populated public-team membership");
        var collector = new FcmHudRosterReader();
        var isolated = new FcmBridgeState(function() return "copied-session");
        menu(isolated, ready({menuStackA:[]}));
        var nativeRows = [{displayName:"CopiedPeer"}];
        var copied = collector.provider("PlayerListData", ready(nativeRows), "Self", 100);
        isolated.observe(copied);
        copied.names[0] = "MutatedObservation";
        nativeRows[0].displayName = "MutatedNative";
        check(isolated.names(100).join("|") == "CopiedPeer", "policy retains neither native data nor caller-owned arrays");
        isolated.observe(collector.provider("PartyMenuList", ready([]), "Self", 0));
        check(isolated.observedAt == 100, "an older auxiliary cache cannot age a newer observation backwards");
        var stableRows = [{displayName:"StablePeer"}];
        isolated.observe(collector.provider("PlayerListData", ready(stableRows), "Self", 200));
        isolated.observe(collector.provider("PlayerListData", ready(stableRows), "Self", 30200));
        check(!isolated.fresh(30200), "polling unchanged native cache cannot keep world fresh forever");
        isolated.observe(collector.provider("PlayerListData", ready(stableRows), "Self", 30201, true));
        check(isolated.fresh(30201), "fresh validated push can renew unchanged membership");
        Sys.println("PASS FcmBridgeState: " + checks + " checks");
    }
}
