class TestFcmBridgeNativePrototype {
    static function check(ok:Bool, label:String):Void { if (!ok) throw label; }
    public static function run():Void {
        var writes = 0, sends = 0, connects = 0;
        var state = "connecting";
        var last:Dynamic = null;
        var session = "np-123456789-123456789-123456789-123456789";
        var p = new FcmBridgeNativePrototype(session, function(verb:String, payload:String):Dynamic {
            if (verb == "chat.v1.connect") { connects++; return '{"success":true}'; }
            if (verb == "chat.v1.getAuthState") return {success:true, state:state};
            if (verb == "chat.v1.pollEvents") return {success:true, events:[]};
            check(verb == "chat.v1.sendMessage", "only sanctioned native chat methods");
            last = haxe.Json.parse(payload); sends++;
            return '{"success":true}';
        }, function(doc:String):Bool {
            var c:Dynamic = haxe.Json.parse(doc);
            check(c.schemaVersion == "native-prototype-1" && c.sessionId == session, "bounded discovery capsule");
            check(Reflect.fields(c).length == 4, "capsule contains no roster or credentials");
            writes++; return true;
        }, function() return 1234567890000.0);
        p.tick(0); p.tick(5000);
        check(connects == 1 && writes == 0, "pending auth does not reconnect or write");
        check(!p.save("{}"), "unlinked observations do not send");
        state = "authenticated"; p.tick(10000); p.tick(15000);
        check(writes == 1, "only one capsule write");
        var doc = haxe.Json.stringify({sessionId:session, environment:"dev", sequence:1});
        check(p.save(doc) && p.save(doc) && sends == 2 && writes == 1, "native sends do not touch storage");
        check(StringTools.startsWith(last.body, "FCMCTL/1/NATIVE-PROTOTYPE:") && last.channel == "server", "reserved native control");
        check(!p.save('{"sessionId":"other","environment":"dev"}'), "foreign session denied");
        p.close(); p.tick(20000);
        check(!p.save(doc) && writes == 1 && sends == 2, "unload closes transport callbacks");
    }
    static function main():Void { run(); trace("native prototype checks passed"); }
}
