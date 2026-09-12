class TestFcmBridgeState {
    static var checks = 0;
    static function check(value:Bool, label:String):Void { checks++; if (!value) throw label; }
    static function ready(data:Dynamic):Dynamic { return {isTest:false, dataReady:true, data:data}; }
    static function main():Void {
        var nonce = 0;
        var state = new FcmBridgeState(function() return "nonce-" + ++nonce);
        state.menu({data:{menuStackA:[]}, isTest:true, dataReady:true});
        state.observe("PlayerListData", ready([]), "Self", 0);
        check(!state.fresh(0), "test provider is not world evidence");
        state.menu(ready({menuStackA:[]}));
        state.observe("PlayerListData", {data:[], dataReady:false}, "Self", 0);
        check(!state.fresh(0), "unready arrays cannot seed rooms");
        var data = [{displayName:"Other<title>"}, {displayName:"Self", isLocal:true}, {displayName:"Other<title>"}];
        state.observe("PlayerListData", ready(data), "Self", 10);
        check(state.fresh(10) && state.names(10).join("|") == "Other", "roster normalized and bounded to unique peers");
        check(state.target() == "FCMBRIDGE/1;nonce-1", "background control carries an explicit nonce");
        check(!state.session.accept("FCMCTL/1/SERVER-READY:stale|r:old", 10), "stale room confirmation rejected");
        check(state.session.accept("FCMCTL/1/SERVER-READY:nonce-1|r:one", 10), "matching room confirmation accepted");
        state.menu(ready({menuStackA:[{menuName:"MainMenu"}]}));
        check(!state.fresh(11) && state.session.room == "", "main menu invalidates room immediately");
        state.menu(ready({menuStackA:[]}));
        state.observe("PlayerListData", ready(data), "Self", 12);
        check(!state.fresh(12), "cached old-world provider cannot re-seed a new world");
        state.observe("PlayerListData", ready(data), "Self", 13, true);
        check(state.fresh(13), "fresh provider push can confirm an unchanged roster");
        var previous = state.session.requestId;
        state.observe("TeamMarkers", ready({Markers:[{displayName:"StalePeer"}]}), "Self", 14);
        state.observe("PlayerListData", ready([{displayName:"NewPeer"}]), "Self", 15);
        check(state.session.requestId != previous && state.names(15).join("|") == "NewPeer", "disjoint roster resets other providers");
        check(!state.fresh(30015), "observations expire at 30 seconds");
        var connectedNonce = state.session.requestId;
        state.reconnect();
        check(state.session.requestId != connectedNonce && state.names(16).join("|") == "NewPeer", "transport reconnect preserves current-world observations with a fresh nonce");
        state.menu(ready({menuStackA:[{menuName:"LoadingMenu"}]}));
        check(!state.inWorld, "loading screen retires a potentially changing world");
        check(FcmBridgeState.linkCode("LINK REQUIRED - visit example/link, sign in, and enter code: ABCD-1234 (expires 10m)") == "ABCD-1234", "link code reads only the canonical notice");
        check(FcmBridgeState.linkCode("chat contains code: ABCD-1234 (expires 10m)") == "", "chat cannot spoof the link notice");
        check(!FcmBridgeState.terminal("connecting", "auth.connecting"), "asynchronous connect is not terminal");
        check(FcmBridgeState.terminal("limited", "auth_token_revoked"), "revocation stops automatic reconnect");
        check(FcmBridgeState.authenticated({state:"authenticated"}), "ZFE state confirms auth");
        check(FcmBridgeState.authenticated({status:"authenticated"}), "xScal status confirms auth");
        check(!FcmBridgeState.authenticated({success:false, state:"authenticated"}), "failed stale auth snapshot cannot authorize");
        check(!FcmBridgeState.authenticated({status:"connecting", success:true}), "transport acceptance alone cannot authorize");
        Sys.println("PASS FcmBridgeState: " + checks + " checks");
    }
}
