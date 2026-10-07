class TestFcmNameplates {
    static function check(label:String, ok:Bool):Void { if (!ok) throw label; }
    static function reply(lease:FcmNameplates, request:String, ttl:Dynamic = 10000, names:Dynamic = null, context:String = null):String {
        var req = FcmJson.parse(request.substr(FcmNameplates.CONTROL.length));
        return FcmNameplates.EVENT + haxe.Json.stringify({version:1,requestId:req.requestId,
            context:context == null ? lease.context : context, ttlMs:ttl,names:names == null ? ["peer"] : names});
    }
    static function main():Void {
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
        Sys.println("FcmNameplates + cosmetic receiver PASS");
    }
}
