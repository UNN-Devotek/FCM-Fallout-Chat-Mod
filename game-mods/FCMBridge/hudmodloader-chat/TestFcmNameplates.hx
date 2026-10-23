class TestFcmNameplates {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    static function reply(lease:FcmNameplates, request:String, ttl:Dynamic = 10000, names:Dynamic = null, context:String = null):String {
        var req = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
        return FcmNameplates.EVENT + haxe.Json.stringify({version:1,requestId:req.requestId,
            context:context == null ? lease.context : context, ttlMs:ttl,names:names == null ? ["peer"] : names});
    }
    static function main():Void {
        check("HUD can classify shared VM errors without bridge-only classes", FcmRuntimeError.errorCode({errorID:1014}) == "E1014");
        check("shared class parser accepts only the VM identifier", FcmRuntimeError.missingClass({errorID:1014,
            message:"Class fixture.Missing could not be found."}) == "fixture.Missing");
        check("shared class parser rejects appended private text", FcmRuntimeError.missingClass({errorID:1014,
            message:"Class fixture.Missing could not be found. private-fixture"}) == "not reported");
        overlappingRequests();
        independentPollOrdering();
        renewalCadence();
        sourceSelection();
        observations();
        currentAdmission();
        generations();
        nativeProbe();
        receiverBoundaries();
        var diagnostics = new FcmNameplates("private-client");
        var privateRequest = diagnostics.request(100, "private-world");
        check("diagnostic request count", diagnostics.requestCount == 1);
        check("request phase records successful bounded encoding", diagnostics.requestPhase == "ready");
        diagnostics.request(200, "private-world");
        check("throttled request has a fixed phase", diagnostics.requestPhase == "throttled");
        check("throttled request not counted", diagnostics.requestCount == 1);
        check("diagnostic accepts valid lease", diagnostics.accept(reply(diagnostics, privateRequest, 10000, ["private-peer"]), 200));
        check("diagnostic distinguishes rejected replay", !diagnostics.accept(reply(diagnostics, privateRequest), 300)
            && diagnostics.acceptedCount == 1 && diagnostics.rejectedCount == 1);
        var safe = diagnostics.diagnostic(400);
        check("diagnostic reports live count and deadline", safe.indexOf("names=1") >= 0 && safe.indexOf("leaseMs=9700") >= 0);
        for (privateValue in ["private-client", "private-world", "private-peer", "requestId", "context"])
            check("diagnostic excludes private data", safe.indexOf(privateValue) < 0);
        check("diagnostic never reports expired names", diagnostics.diagnostic(10100).indexOf("names=0") >= 0
            && diagnostics.diagnostic(10100).indexOf("leaseMs=0") >= 0);
        diagnostics.reset();
        check("reset retires request phase", diagnostics.requestPhase == "retired");
        check("reset clears lease and preserves lifetime diagnostic counts", diagnostics.names.length == 0
            && diagnostics.requestCount == 1 && diagnostics.acceptedCount == 1 && diagnostics.rejectedCount == 1);
        var lease = new FcmNameplates("test");
        var request = lease.request(100, "world-a");
        check("HUD context", lease.context == "hud:world-a");
        check("request cadence", lease.request(200, "world-a") == "");
        check("reject other world", !lease.accept(reply(lease, request, 10000, null, "hud:world-b"), 200));
        check("accept current world", lease.accept(reply(lease, request), 200));
        check("color while lease fresh", lease.current(10099).join(",") == "peer");
        check("cannot replay", !lease.accept(reply(lease, request), 10099));
        check("expires from submission", lease.current(10100).length == 0);
        request = lease.request(11000, "world-a");
        check("delayed response cannot revive", lease.accept(reply(lease, request), 21000) && lease.current(21000).length == 0);
        request = lease.request(22000, "world-a");
        lease.request(22100, "world-b");
        check("hop fences old request", !lease.accept(reply(lease, request, 10000, null, "hud:world-a"), 22200));
        for (invalid in ["Peer", " peer", "<peer>", "peer\n", ""]) {
            request = lease.request(30000, "new-" + invalid.length);
            check("reject invalid matching name", !lease.accept(reply(lease, request, 10000, [invalid]), 30001));
            lease.reset();
        }
        for (ttl in [-1.0, 10001.0, 0.5]) {
            request = lease.request(31000, "valid");
            check("bounded integer lifetime", !lease.accept(reply(lease, request, ttl), 31001)); lease.reset();
        }
        request = lease.request(32000, "", "movie-a", "world-a");
        check("bridge context", lease.context == "bridge:movie-a/world-a");
        check("bounded roster", !lease.accept(reply(lease, request, 10000, [for (_ in 0...25) "peer"]), 32001));
        check("empty response clears", lease.accept(reply(lease, request, 0, []), 32002) && lease.current(32002).length == 0);
        check("name/title normalization", FcmNameplates.clean(" Peer<font>title") == "peer");
        check("invalid request resets", lease.request(33000, "BAD") == "" && lease.context == "");
        var calls:Array<String> = []; var state = "connecting"; var events:Array<Dynamic> = [];
        var receiverLease = new FcmNameplates("receiver");
        var transport = new FcmBridgeNameplates(function(verb:String, body:String):Dynamic {
            calls.push(verb);
            if (verb == "chat.v1.connect") return '{"success":true,"status":"connecting"}';
            if (verb == "chat.v1.getAuthState") return haxe.Json.stringify({success:true,state:state});
            if (verb == "chat.v1.pollEvents") { var rows = events; events = []; return haxe.Json.stringify({success:true,events:rows}); }
            if (verb == "chat.v1.sendMessage") {
                var payload = FcmJson.parse(body);
                check("only cosmetic control", payload.channel == "server" && StringTools.startsWith(payload.body, FcmNameplates.CONTROL));
                events.push({id:1,kind:"chat.message",channel:"system",senderUserId:"system",body:reply(receiverLease, payload.body)});
                return '{"success":true}';
            }
            throw "unexpected native call";
        }, receiverLease);
        transport.tick(0, "movie", "world", true);
        transport.tick(1000, "movie", "world", true);
        check("queued connect not repeated", calls.filter(function(v) return v == "chat.v1.connect").length == 1);
        check("connecting cannot send", calls.indexOf("chat.v1.sendMessage") < 0);
        state = "limited";
        transport.tick(2000, "movie", "world", true);
        transport.tick(3000, "movie", "world", true);
        check("limited native receiver accepts desktop-owned cosmetics", receiverLease.current(3000).join(",") == "peer");
        transport.tick(3100, "movie", "new-world", true);
        check("world change clears immediately", receiverLease.current(3100).length == 0);
        transport.tick(3200, "movie", "new-world", false);
        check("inactive clears", receiverLease.context == "");
        transport.shutdown(); var count = calls.length;
        transport.tick(3300, "movie", "new-world", true);
        check("unload stops native calls", calls.length == count);
        var fault = new FcmBridgeNameplates(function(verb:String, _:String):Dynamic {
            if (verb == "chat.v1.connect") return '{"success":true}';
            throw {errorID:1014,message:"Private native payload"};
        }, new FcmNameplates("fault"));
        fault.tick(0, "movie", "world", true);
        check("native receiver failure has a numeric privacy-safe probe", fault.probe == "failure"
            && fault.lastError == "E1014" && fault.diagnostic == "presence unavailable");
        fault.shutdown();
        Sys.println("FcmNameplates + cosmetic receiver PASS");
    }
    static function receiverBoundaries():Void {
        for (boundary in ["chat.v1.connect", "chat.v1.getAuthState", "chat.v1.pollEvents", "chat.v1.sendMessage"]) {
            for (unload in [false, true]) {
                var lease = new FcmNameplates("boundary");
                var calls:Array<String> = [];
                var receiver:FcmBridgeNameplates = null;
                receiver = new FcmBridgeNameplates(function(verb:String, _:String):Dynamic {
                    calls.push(verb);
                    if (verb == boundary) {
                        if (unload) receiver.shutdown();
                        else throw {errorID:1014,message:"Private native boundary payload"};
                    }
                    return verb == "chat.v1.getAuthState" ? '{"success":true,"state":"limited"}'
                        : verb == "chat.v1.pollEvents" ? '{"success":true,"events":[]}' : '{"success":true}';
                }, lease);
                receiver.tick(0, "movie", "world", true);
                check("native boundary stops later work " + boundary, calls[calls.length - 1] == boundary);
                check("native boundary retires cosmetic evidence " + boundary, lease.context == "" && lease.current(0).length == 0);
                if (!unload) check("native boundary catches numeric failure " + boundary,
                    receiver.probe == "failure" && receiver.lastError == "E1014");
                var count = calls.length;
                receiver.tick(1000, "movie", "world", true);
                check("fault backs off or disposed receiver stays stopped " + boundary, calls.length == count);
                if (!unload) check("backoff preserves the caught boundary diagnosis " + boundary,
                    receiver.probe == "failure" && receiver.lastError == "E1014");
                receiver.shutdown();
            }
        }
        var connects = 0;
        var pending = new FcmBridgeNameplates(function(verb:String, _:String):Dynamic {
            if (verb == "chat.v1.connect") connects++;
            return verb == "chat.v1.getAuthState" ? '{"success":false,"state":"connecting"}' : '{"success":true}';
        }, new FcmNameplates("pending"));
        pending.tick(0, "movie", "world", true);
        pending.tick(30000, "movie", "world", true);
        check("pending auth response never restarts accepted transport", connects == 1);
        pending.shutdown();
        Sys.println("Cosmetic receiver native boundary isolation PASS");
    }
    static function currentAdmission():Void {
        var rows = [{id:11.0,name:"peer",eligible:true}];
        check("current eligibility corroborates the exact private identity", FcmNameplateObservation.matches(rows, 11, "peer", ["peer"]));
        check("a private withdrawal retires current admission", !FcmNameplateObservation.matches(rows, 11, "peer", []));
        check("a removed row retires current admission", !FcmNameplateObservation.matches([], 11, "peer", ["peer"]));
        check("an absent source retires current admission", !FcmNameplateObservation.matches(null, 11, "peer", ["peer"]));
        check("a recycled entity cannot inherit current admission", !FcmNameplateObservation.matches(rows, 12, "peer", ["peer"]));
        check("a renamed entity cannot inherit current admission", !FcmNameplateObservation.matches(rows, 11, "other", ["other"]));
        check("ineligible current disposition retires admission", !FcmNameplateObservation.matches([{id:11.0,name:"peer",eligible:false}], 11, "peer", ["peer"]));
        check("ambiguous current IDs cannot retain admission", !FcmNameplateObservation.matches(rows.concat(rows), 11, "peer", ["peer"]));
        var before = haxe.Json.stringify(rows);
        FcmNameplateObservation.matches(rows, 11, "peer", ["peer"]);
        check("corroboration never changes source evidence", haxe.Json.stringify(rows) == before);
    }
    static function overlappingRequests():Void {
        var lease = new FcmNameplates("overlap");
        var first = lease.request(0, "world"), firstReply = reply(lease, first);
        var second = lease.request(5000, "world"), secondReply = reply(lease, second, 10000, ["newer"]);
        check("new submission retains an unexpired prior reply in the same context", lease.accept(firstReply, 5001));
        check("late prior reply keeps its own original deadline", lease.current(9999).join(",") == "peer"
            && lease.current(10000).length == 0);
        check("newer reply can supersede an accepted prior reply", lease.accept(secondReply, 10001)
            && lease.current(14999).join(",") == "newer" && lease.current(15000).length == 0);
        check("consumed prior reply cannot replay", !lease.accept(firstReply, 10002));
        lease.reset();
        first = lease.request(20000, "world"); firstReply = reply(lease, first);
        second = lease.request(25000, "world"); secondReply = reply(lease, second, 0, []);
        check("newest empty reply withdraws presence", lease.accept(secondReply, 25001) && lease.current(25001).length == 0);
        check("older positive reply cannot overwrite a newer empty reply", !lease.accept(firstReply, 25002));
        lease.reset();
        first = lease.request(30000, "world"); firstReply = reply(lease, first);
        second = lease.request(35000, "world"); secondReply = reply(lease, second);
        lease.reset(); lease.request(36000, "world");
        check("same-context reset fences every outstanding reply", !lease.accept(firstReply, 36001)
            && !lease.accept(secondReply, 36001) && lease.current(36001).length == 0);
        lease.reset();
        for (now in [0,3000,6000,9000,12000,15000]) {
            check("stalled receiver still schedules bounded requests", lease.request(now, "world") != "");
            var outstanding:Dynamic = Reflect.field(lease, "pending");
            check("outstanding requests remain bounded", Std.isOfType(outstanding, Array) && outstanding.length <= 4);
        }
        var outstanding:Array<Dynamic> = cast Reflect.field(lease, "pending");
        check("only unexpired requests remain outstanding", outstanding.length == 4 && outstanding[0].sentAt == 6000);
        lease.request(40000, "world");
        outstanding = cast Reflect.field(lease, "pending");
        check("a long stall prunes the entire expired window", outstanding.length == 1 && outstanding[0].sentAt == 40000);
    }
    static function independentPollOrdering():Void {
        for (worldFirst in [false,true]) for (phase in [0,100,1000,4900]) {
            var lease = new FcmNameplates("ordering");
            var queued:Array<{at:Int,body:String}> = [];
            var steadyFrames = 0, liveFrames = 0;
            for (step in 0...601) {
                var now = step * 100;
                function world():Void {
                    if (now % 5000 != 0) return;
                    var req = lease.request(now, "world");
                    if (req != "") queued.push({at:now+100,body:reply(lease,req)});
                }
                function poll():Void {
                    if (now < phase || (now-phase) % 5000 != 0) return;
                    var arrived = queued.filter(function(item) return item.at <= now);
                    queued = queued.filter(function(item) return item.at > now);
                    for (item in arrived) check("independent poll accepts current unexpired replies", lease.accept(item.body,now));
                }
                if (worldFirst) { world(); poll(); } else { poll(); world(); }
                if (now >= 15000) { steadyFrames++; if (lease.current(now).length > 0) liveFrames++; }
            }
            check("private presence stays active for both timer orders and poll phases", liveFrames == steadyFrames
                && lease.acceptedCount == 12 && lease.rejectedCount == 0);
        }
    }
    static function renewalCadence():Void {
        var cadence = new FcmNameplates("cadence");
        var last:Float = -1, maximumGap:Float = 0;
        var continuous = true, submissions = 0;
        // Real five-second ticks can alternate just before/after a deadline.
        for (now in [0.0,5001.0,10000.0,15001.0,20000.0,25001.0,30000.0,35001.0]) {
            if (now > 0 && cadence.current(now).length == 0) continuous = false;
            var request = cadence.request(now, "cadence-world");
            if (request == "") continue;
            submissions++;
            if (last >= 0) maximumGap = Math.max(maximumGap, now - last);
            last = now;
            check("delayed renewal reply keeps original bounded TTL", cadence.accept(reply(cadence, request), now + 1000));
        }
        check("timer jitter cannot turn five-second cosmetic polling into ten-second renewal", submissions == 8 && maximumGap <= 5001);
        check("renewals overlap without extending private TTL", continuous);
        var bounded = new FcmNameplates("bounded");
        var old = bounded.request(0, "bounded-world");
        check("renewal headroom still throttles fast callers", bounded.request(2999, "bounded-world") == "");
        check("renewal becomes due before the next HUD tick", bounded.request(3000, "bounded-world") != "");
        check("adjacent callbacks cannot burst", bounded.request(3001, "bounded-world") == "");
        check("new request retains an unexpired prior queued reply", bounded.accept(reply(bounded, old), 3001));
        var afterStall = bounded.request(30000, "bounded-world");
        check("long stalls produce one request without catch-up bursts", afterStall != ""
            && bounded.request(30000, "bounded-world") == "" && bounded.requestCount == 3);
        check("late reply retains submission deadline", bounded.accept(reply(bounded, afterStall), 39999)
            && bounded.current(39999).length == 1 && bounded.current(40000).length == 0);
    }
    static function sourceSelection():Void {
        var payloadReads = 0;
        function manager():Dynamic return {
            GetDataFromClient:function(_:String):Dynamic { payloadReads++; return null; },
            Subscribe:function(_:String, _:Dynamic):Void {},
            Unsubscribe:function(_:String, _:Dynamic):Void {}
        };
        var child = manager(), live = manager();
        var domain:Dynamic = {getDefinition:function(name:String):Dynamic {
            check("only public BSUI definition", name == "Shared.AS3.Data.BSUIDataManager"); return live;
        }};
        var host:Dynamic = {loaderInfo:{applicationDomain:domain}};
        var resolved = FcmNameplateSource.resolve(host, child);
        check("host movie manager has priority over child manager", resolved.manager == live
            && resolved.scope == "host-domain" && resolved.relation == "different");
        check("shared domain does not invent a new manager", FcmNameplateSource.resolve(host, live).relation == "same");
        check("source selection never reads or creates a provider", payloadReads == 0);
        check("host root supplies missing loaderInfo", FcmNameplateSource.resolve({root:host}, child).manager == live);
        check("absent host preserves fallback", FcmNameplateSource.resolve(null, child).manager == child);
        check("absent domain preserves fallback", FcmNameplateSource.resolve({}, child).relation == "missing");
        domain.getDefinition = function(_:String):Dynamic return {GetDataFromClient:function(_:String):Dynamic return null};
        resolved = FcmNameplateSource.resolve(host, child);
        check("incomplete manager preserves fallback", resolved.manager == child && resolved.relation == "not-callable");
        domain.getDefinition = function(_:String):Dynamic throw {errorID:1065,message:"Private domain payload"};
        resolved = FcmNameplateSource.resolve(host, child);
        check("definition failure preserves fallback and numeric diagnostic", resolved.manager == child
            && resolved.relation == "unavailable" && resolved.error == 1065);
        domain.getDefinition = function(_:String):Dynamic throw {errorID:1.5};
        check("noninteger diagnostic rejected", FcmNameplateSource.resolve(host, child).error == 0);
        Sys.println("Nameplate host-domain source selection PASS");
    }
    static function marker(id:Dynamic = 11, name:Dynamic = "PrivatePeer"):Dynamic return {
        entityID:id,displayName:name,isLocalPlayer:false,isHostile:false,
        playerState:"teammate",wantedState:"notWanted"
    };
    static function observations():Void {
        var row = marker();
        var payload:Dynamic = {Markers:[row]};
        var provider:Dynamic = {data:payload,dataReady:false,isTest:true};
        var event:Dynamic = {fromClient:provider,data:payload};
        check("legacy source still rejects placeholder flags", !FcmNameplateObservation.isLive(provider));
        check("exact host event can preserve separately corroborated evidence",
            FcmNameplateObservation.isHostEvent(provider, event, provider));
        check("snapshot alone cannot corroborate source", !FcmNameplateObservation.isHostEvent(provider, null, provider));
        check("different envelope with same payload cannot corroborate source",
            !FcmNameplateObservation.isHostEvent(provider, event, {data:payload,dataReady:false,isTest:true}));
        check("different event owner cannot corroborate source",
            !FcmNameplateObservation.isHostEvent(provider, {fromClient:{data:payload},data:payload}, provider));
        check("different event payload cannot corroborate source",
            !FcmNameplateObservation.isHostEvent(provider, {fromClient:provider,data:{Markers:[]}}, provider));
        check("missing payload cannot corroborate source", !FcmNameplateObservation.isHostEvent(
            {dataReady:false,isTest:true}, {data:null}, null));
        var invalidFlags:Array<Dynamic> = [
            {dataReady:true,isTest:false}, {dataReady:false,isTest:false},
            {dataReady:true,isTest:true}, {dataReady:null,isTest:true},
            {dataReady:false,isTest:null}, {dataReady:"false",isTest:true},
            {dataReady:false,isTest:"true"}, {dataReady:0,isTest:1}
        ];
        for (flags in invalidFlags) {
            var candidate:Dynamic = {data:payload,dataReady:flags.dataReady,isTest:flags.isTest};
            check("only exact anomaly flags qualify", !FcmNameplateObservation.isHostEvent(candidate,
                {fromClient:candidate,data:payload}, candidate));
        }
        provider.dataReady = true; provider.isTest = false;
        check("explicit ready non-test provider stays live", FcmNameplateObservation.isLive(provider));
        check("numeric ready flag is not live", !FcmNameplateObservation.isLive({dataReady:1,isTest:false}));
        check("numeric test flag is not live", !FcmNameplateObservation.isLive({dataReady:true,isTest:0}));
        check("missing or throwing flags cannot become live", !FcmNameplateObservation.isLive({dataReady:true})
            && !FcmNameplateObservation.isLive(new ThrowingObservationProvider()));
        var throwing:Dynamic = new ThrowingObservationProvider();
        check("throwing flags cannot corroborate host source", !FcmNameplateObservation.isHostEvent(throwing,
            {fromClient:throwing,data:payload}, throwing));
        provider.dataReady = false; provider.isTest = true;
        var copied = FcmNameplateObservation.copy(payload);
        check("complete scalar copy normalizes eligible row", copied != null && copied.length == 1
            && copied[0].id == 11 && copied[0].name == "privatepeer" && copied[0].eligible);
        row.displayName = "ChangedPrivatePeer"; row.entityID = 12; row.isHostile = true;
        check("copy retains no mutable native row", copied[0].id == 11
            && copied[0].name == "privatepeer" && copied[0].eligible);
        check("normalization retains title contract", FcmNameplateObservation.copy({Markers:[marker(1," Peer<title>")]})[0].name == "peer");
        for (id in [0.0, 2147483647.0, 2147483648.0, 4294967294.0]) {
            copied = FcmNameplateObservation.copy({Markers:[marker(id)]});
            check("full unsigned entity range is preserved", copied != null && copied[0].id == id);
        }
        for (id in [-1.0, 0.5, 4294967295.0, 4294967296.0, Math.NaN, Math.POSITIVE_INFINITY])
            check("invalid numeric or sentinel entity rejects complete list", FcmNameplateObservation.copy({Markers:[marker(id)]}) == null);
        var invalidIds:Array<Dynamic> = [null, "11", true];
        for (id in invalidIds) {
            var candidate = marker(); candidate.entityID = id;
            check("non-numeric entity rejects complete list", FcmNameplateObservation.copy({Markers:[candidate]}) == null);
        }
        var invalidNames:Array<Dynamic> = [null, 1, "", " ", "<title>", "Private\x00Peer", [for (_ in 0...65) "p"].join("")];
        for (name in invalidNames) {
            var candidate = marker(); candidate.displayName = name;
            check("empty non-string or invalid normalized name rejects list", FcmNameplateObservation.copy({Markers:[candidate]}) == null);
        }
        check("duplicate ID rejects ambiguous eligibility", FcmNameplateObservation.copy({Markers:[marker(11),marker(11,"OtherPrivatePeer")]}) == null);
        check("malformed row invalidates complete list", FcmNameplateObservation.copy({Markers:[marker(11),null]}) == null
            && FcmNameplateObservation.copy({Markers:[marker(11),{entityID:12}]}) == null);
        check("partial declared native list cannot become complete", FcmNameplateObservation.copy({Markers:{length:2,"0":marker()}}) == null);
        var invalidLists:Array<Dynamic> = [null, "", "private", true, 1, function():Void {},
            {length:-1}, {length:0.5}, {length:129}, {length:"1"}, {length:Math.NaN}, {length:Math.POSITIVE_INFINITY}];
        for (list in invalidLists)
            check("malformed or unbounded native list rejected", FcmNameplateObservation.copy({Markers:list}) == null);
        check("missing marker list rejects", FcmNameplateObservation.copy(null) == null && FcmNameplateObservation.copy({}) == null);
        check("empty complete list is valid evidence", FcmNameplateObservation.copy({Markers:[]}).length == 0);
        check("maximum complete list is bounded and valid", FcmNameplateObservation.copy({Markers:[for (i in 0...128) marker(i)]}).length == 128);
        for (state in ["teammate","eventgroupmate","nonhostile","friend","potentialHostile"]) {
            var candidate = marker(); candidate.playerState = state;
            check("allowlisted friendly disposition eligible", FcmNameplateObservation.copy({Markers:[candidate]})[0].eligible);
        }
        var excludedDispositions:Array<Dynamic> = [
            {key:"isLocalPlayer",value:true}, {key:"isLocalPlayer",value:null}, {key:"isLocalPlayer",value:0},
            {key:"isHostile",value:true}, {key:"isHostile",value:null}, {key:"isHostile",value:0},
            {key:"playerState",value:"hostile"}, {key:"playerState",value:"hostileGroup"},
            {key:"playerState",value:null}, {key:"playerState",value:"unknown"},
            {key:"wantedState",value:"wanted"}, {key:"wantedState",value:"mostWanted"}, {key:"wantedState",value:null},
            {key:"wantedState",value:0}, {key:"wantedState",value:"NotWanted"}
        ];
        for (change in excludedDispositions) {
            var candidate = marker(); Reflect.setField(candidate, change.key, change.value);
            copied = FcmNameplateObservation.copy({Markers:[candidate]});
            check("other or missing disposition remains copied but ineligible", copied != null && copied.length == 1 && !copied[0].eligible);
        }
        copied = FcmNameplateObservation.copy({Markers:[{entityID:11,displayName:"PrivatePeer"}]});
        check("missing disposition fields fail eligibility", copied != null && !copied[0].eligible);
        check("freshness boundary is exclusive and never accepts reverse time", FcmNameplateObservation.fresh(100,100)
            && FcmNameplateObservation.fresh(100,30099) && !FcmNameplateObservation.fresh(100,30100)
            && !FcmNameplateObservation.fresh(100,99) && !FcmNameplateObservation.fresh(-1,100)
            && !FcmNameplateObservation.fresh(Math.NaN,100) && !FcmNameplateObservation.fresh(100,Math.POSITIVE_INFINITY));
        check("observation reads do not change provider flags", provider.dataReady == false && provider.isTest == true);
        Sys.println("Nameplate bounded host-event observation PASS");
    }
    static function generations():Void {
        var lease = new FcmNameplates("generation");
        var original = lease.request(100, "same-world");
        var context = lease.context, epoch = lease.generation;
        lease.request(200, "same-world");
        check("same-context request preserves source epoch", lease.generation == epoch);
        lease.setContext(context);
        check("same-context assignment preserves source epoch", lease.generation == epoch);
        lease.reset();
        check("reset invalidates source without depending on context string", lease.generation > epoch && lease.context == "");
        var resetEpoch = lease.generation;
        lease.request(300, "same-world");
        check("reacquiring identical world cannot reuse previous source epoch", lease.context == context
            && lease.generation > resetEpoch && lease.generation > epoch);
        check("same-world reply from previous epoch remains fenced", !lease.accept(reply(lease, original), 301));
        epoch = lease.generation;
        lease.request(400, "new-world");
        check("world context change retires source epoch", lease.generation > epoch);
        epoch = lease.generation;
        lease.request(500, "BAD");
        check("invalid world resets source epoch", lease.generation > epoch && lease.context == "");
        Sys.println("Nameplate source-generation fences PASS");
    }
    static function nativeProbe():Void {
        var payload = {Markers:[{entityID:11,displayName:"PrivatePeer<title>",isLocalPlayer:false,
            isHostile:false,playerState:"teammate",wantedState:"notWanted"}]};
        var provider:Dynamic = {data:payload,dataReady:false,isTest:true};
        var reads = 0, mutations = 0;
        var manager:Dynamic = {
            GetDataFromClient:function(key:String, create:Bool = true):Dynamic {
                check("probe only reads existing TeamMarkers", key == "TeamMarkers" && !create); reads++;
                return provider;
            },
            RemoveWatchFromDataConnector:function(_:String):Void { mutations++; }
        };
        var host = {TeammateMarkerBase:{TeamNameplates:[
            {entityID:11,visible:true,Name_tf:{text:"PrivatePeer"}},
            {entityID:12,visible:true,Name_tf:{text:"OtherPrivatePeer"}}
        ]}};
        var probe = FcmNameplateProbe.sample(host, manager, provider, {fromClient:provider,data:payload});
        check("probe separates populated native evidence from ready/test flags", probe.rows == 1
            && probe.eligible == 1 && probe.plateMatches == 1);
        check("probe corroborates event and existing getter payload ownership", probe.eventPayload == "same"
            && probe.getterPayload == "same");
        check("probe observes public method shape without invoking mutation", probe.nativeApi && mutations == 0 && reads == 1);
        check("probe never manufactures readiness", provider.dataReady == false && provider.isTest == true);
        var diagnostic = FcmNameplateProbe.diagnostic(probe);
        for (secret in ["PrivatePeer", "entityID", "displayName", "<title>", "CharacterInfoData", "characterPayload"])
            check("probe diagnostic excludes private payloads", diagnostic.indexOf(secret) < 0);
        var other = {Markers:[]};
        provider.data = other;
        probe = FcmNameplateProbe.sample(host, manager, {data:payload}, {data:other});
        check("probe reports divergent event and cached getter independently", probe.eventPayload == "different"
            && probe.getterPayload == "different" && probe.rows == 1);
        var emptyPayload = {Markers:[marker(11,"<title>")]};
        host.TeammateMarkerBase.TeamNameplates[0].Name_tf.text = "";
        probe = FcmNameplateProbe.sample(host, manager, {data:emptyPayload});
        check("empty normalized names cannot corroborate a native plate", probe.plateMatches == 0 && probe.eligible == 0);
        probe = FcmNameplateProbe.sample(null, null, {data:{Markers:{length:129}}});
        check("probe bounds rows and tolerates absent host/manager", probe.rows == -1 && probe.plateMatches == 0
            && probe.getterPayload == "missing");
        manager.GetDataFromClient = function(_:String, _:Bool):Dynamic throw {errorID:1014,message:"Private failed payload"};
        probe = FcmNameplateProbe.sample(host, manager, provider);
        check("probe failure only records a numeric code", probe.error == 1014
            && FcmNameplateProbe.diagnostic(probe).indexOf("Private") < 0);
        Sys.println("Nameplate count-only native contract probe PASS");
    }
}
private class ThrowingObservationProvider {
    public var dataReady(get, never):Bool;
    public var isTest(get, never):Bool;
    public function new() {}
    function get_dataReady():Bool throw "Private observation accessor payload";
    function get_isTest():Bool return true;
}
