class TestFcmBridgeExport {
    static var count = 0;
    static function check(ok:Bool, label:String):Void { count++; if (!ok) throw label; }
    static function storageDiagnostics():Void {
        FcmBridgeStorage.discover({}, "dev");
        check(FcmBridgeStorage.diagnostic == "no callable API", "absent API is distinct from rejected probe");
        for (sample in [
            {answer:"private invalid response", expected:"BRG_OBJ parse error"},
            {answer:'{"success":false}', expected:"BRG_OBJ rejected"},
            {answer:'{"success":true}', expected:"BRG_OBJ capabilities invalid"},
            {answer:'{"success":true,"capabilities":[]}', expected:"BRG_OBJ storage absent"},
            {answer:'{"success":true,"capabilities":["zfe-storage-v1"]}', expected:"BRG_OBJ ready"}
        ]) {
            FcmBridgeStorage.discover({BRG_OBJ:{call:function(_:String, _:String):String return sample.answer}}, "dev");
            check(FcmBridgeStorage.diagnostic == sample.expected, "probe phase is privacy-safe and precise");
        }
        FcmBridgeStorage.discover({BRG_OBJ:{call:function(_:String, _:String):String {
            throw {errorID:1014, message:"private credential and roster"};
        }}}, "dev");
        check(FcmBridgeStorage.diagnostic == "BRG_OBJ call E1014", "native exception exposes numeric code only");
        FcmBridgeStorage.discover({}, "dev");
        check(FcmBridgeStorage.diagnostic == "no callable API", "next discovery clears stale diagnostics");
    }
    static function legacyDiscovery():Void {
        var writes = 0;
        var probes = 0;
        var raw = {call:function(verb:String, payload:String):String {
            if (verb == "getRuntimeInfo") { probes++; return '{"success":true,"capabilities":["zfe-storage-v1"]}'; }
            check(verb == "writeStorage", "legacy fallback never enters native chat/auth");
            var args:Dynamic = haxe.Json.parse(payload);
            check(args.vendor == "FCMServerBridge" && args.path == "dev-state.json" && args.text == "{}",
                "legacy fallback preserves scoped storage arguments");
            writes++; return '{"success":true,"status":"saved"}';
        }};
        var scopes:Array<Dynamic> = [{BRG_OBJ:raw}, {parent:{BRG_OBJ:raw}}, {root:{BRG_OBJ:raw}}];
        for (scope in scopes) {
            var api = FcmBridgeStorage.discover(scope, "dev");
            check(api != null && api.provider == "zfe" && api.route == "BRG_OBJ", "BRG_OBJ-only storage is discovered on scope/parent/root");
            check(api.save("{}"), "legacy capability-checked storage can write");
        }
        check(writes == 3 && probes == 3, "each legacy scope is probed before its write");
        for (answer in ['{"success":true,"capabilities":[]}', '{"success":false,"capabilities":["zfe-storage-v1"]}',
                '{"success":true,"capabilities":"zfe-storage-v1"}', 'not json']) {
            var rejected = {call:function(verb:String, _:String):String {
                check(verb == "getRuntimeInfo", "rejected legacy API only receives capability probe"); return answer;
            }};
            check(FcmBridgeStorage.discover({BRG_OBJ:rejected}, "dev") == null, "unsupported/malformed legacy storage rejected");
        }
        check(FcmBridgeStorage.discover({BRG_OBJ:{call:function(_:String, _:String):String { throw "probe failure"; }}}, "dev") == null,
            "throwing legacy capability probe fails closed");
        var legacyCalls = 0;
        var unused = {call:function(_:String, _:String):String { legacyCalls++; return ""; }};
        check(FcmBridgeStorage.discover({BRG_OBJ:unused, parent:{__ZFE:raw}}, "dev") != null && legacyCalls == 0,
            "modern API on parent wins before local legacy fallback");
        var preferred = FcmBridgeStorage.discover({__SFCodeObj:{version:{runtime:"xScal"},modStorage:{
            register:function(_:String):Bool return true, save:function(_:String):Bool return true
        }}}, "dev");
        check(preferred != null && preferred.provider == "xscal", "single xScal provider is accepted");
        var conflict = FcmBridgeStorage.discover({BRG_OBJ:raw,__SFCodeObj:{version:{runtime:"xScal"},modStorage:{
            register:function(_:String):Bool return true, save:function(_:String):Bool return true
        }}}, "dev");
        check(conflict == null && FcmBridgeStorage.diagnostic == "provider conflict",
            "simultaneous ZFE and xScal providers fail closed");

    }
    static function main():Void {
        boundedResponses();
        storageDiagnostics();
        legacyDiscovery();
        var state = new FcmBridgeState(function() return "world-1");
        state.menu(FcmHudRosterReader.menu({dataReady:true,isTest:false,data:{menuStackA:[]}}));
        var observation = new FcmHudRosterReader.FcmRosterObservation("PlayerListData", 1000, "");
        observation.names = ["Peer"];
        observation.revision = 1;
        state.observe(observation); state.settle(1000);
        var exporter = new FcmBridgeExport("movie-1", "dev");
        var documents:Array<Dynamic> = [];
        var succeed = true;
        var save = function(text:String):Bool { documents.push(haxe.Json.parse(text)); return succeed; };
        check(exporter.update(1000, state, "Self", "xscal", save), "initial snapshot written");
        check(documents[0].state == "active" && documents[0].observationAgeMs == 0, "active evidence age");
        check(!exporter.update(1500, state, "Changed", "xscal", save), "changed writes rate limited");
        check(!exporter.update(5999, state, "Self", "xscal", save), "no unnecessary write");
        check(exporter.update(6000, state, "Self", "xscal", save), "five second heartbeat");
        check(documents[1].sequence == 2 && documents[1].observationSequence == 2
            && documents[1].observationAgeMs == 5000, "heartbeat does not refresh observation");
        state.menu(FcmHudRosterReader.menu({dataReady:true,isTest:false,data:{menuStackA:[{menuName:"LoadingMenu"}]}}));
        exporter.update(7000, state, "Self", "xscal", save);
        check(documents[2].state == "holding" && documents[2].worldGeneration == "world-1", "loading holds generation");
        exporter.update(31000, state, "Self", "xscal", save);
        check(documents[3].state == "inactive" && documents[3].names.length == 0, "expiry emits no roster");
        check(documents[3].ownName == "", "inactive export removes private evidence");
        succeed = false;
        check(exporter.update(36000, state, "Self", "xscal", save) && !exporter.lastSuccess, "failed save tracked");
        check(!exporter.update(36500, state, "Self", "xscal", save), "failed writes still rate limited");
        succeed = true;
        check(exporter.update(37000, state, "Self", "xscal", save) && exporter.lastSuccess, "retry recovers");
        for (doc in documents) for (key in Reflect.fields(doc))
            check(["token", "password", "code", "room", "accountId"].indexOf(key) < 0, "export is not authentication");
        var registered = "";
        var stored = "";
        var api = FcmBridgeStorage.xscal({version:{runtime:"xScal"}, modStorage:{
            register:function(name:String):Bool { registered = name; return true; },
            save:function(text:String):Bool { stored = text; return true; }
        }}, "dev");
        check(api != null && registered == "fcmserverbridge-dev" && api.save("{}") && stored == "{}", "xScal direct storage contract");
        var namedName = "";
        var namedDocument = "";
        var namedApi = FcmBridgeStorage.xscal({version:{runtime:"xScal",value:"0.2.17"}, modStorage:{
            load:function(_:String):Dynamic return false,
            save:function(name:String, text:String):Bool { namedName = name; namedDocument = text; return true; }
        }}, "prod");
        check(namedApi != null && namedApi.route == "namedModStorage"
            && namedApi.save("{\"ok\":true}") && namedName == "fcmserverbridge-prod"
            && namedDocument == "{\"ok\":true}",
            "xScal 0.2.17 named storage works without a registration function");
        var oldRegistered = 0;
        var oldApi = FcmBridgeStorage.xscal({version:{runtime:"xScal",value:"0.2.16"}, modStorage:{
            register:function(_:String):Bool { oldRegistered++; return true; },
            load:function():Dynamic return false,
            save:function(_:String):Bool return true
        }}, "prod");
        check(oldApi != null && oldApi.route == "modStorage" && oldRegistered == 1,
            "xScal 0.2.16 retains legacy registered storage behavior");
        check(FcmBridgeStorage.xscal({modStorage:{}}, "dev") == null, "unidentified API rejected");
        check(FcmBridgeStorage.xscal({version:{runtime:"xScal"},modStorage:{register:function(_:String):Bool return false,save:function(_:String):Bool return true}}, "dev") == null,
            "failed registration rejected");
        var result = true;
        var zfe = FcmBridgeStorage.zfe({call:function(verb:String, payload:String):String {
            if (verb == "getRuntimeInfo") return '{"success":true,"capabilities":["zfe-storage-v1"]}';
            var args:Dynamic = haxe.Json.parse(payload);
            check(verb == "writeStorage" && args.vendor == "FCMServerBridge" && args.path == "prod-state.json", "ZFE scoped path");
            return result ? '{"success":true,"status":"saved"}' : '{"success":false}';
        }}, "prod");
        check(zfe != null && zfe.save("{}"), "ZFE storage success validated");
        result = false;
        check(!zfe.save("{}"), "ZFE failure respected");
        check(!api.save(StringTools.lpad("", "x", 8193)), "oversized payload never crosses native boundary");
        check(FcmBridgeStorage.zfe({call:function(_:String, _:String):String return '{"success":true,"capabilities":[]}'}, "dev") == null, "missing capability rejected");
        var elapsed = 1010.0;
        var timed = new FcmBridgeExport("movie-2", "dev", function() return elapsed);
        timed.update(1000, state, "Self", "zfe", save);
        check(!timed.update(2000, state, "Other", "zfe", save), "serialization/native time cannot compress write interval");
        elapsed = 2010;
        check(timed.update(2010, state, "Other", "zfe", save), "write budget measured from completion");
        var pending = new FcmBridgeExport("movie-3", "dev");
        pending.update(1000, state, "Self", "zfe", save, true);
        var oldSequence:Int = documents[documents.length - 1].observationSequence;
        state.reset();
        state.menu(FcmHudRosterReader.menu({dataReady:true,isTest:false,data:{menuStackA:[]}}));
        observation.at = 2000; observation.revision++;
        state.observe(observation); state.settle(2000);
        pending.update(2000, state, "Self", "zfe", save);
        check(documents[documents.length - 1].observationSequence > oldSequence, "first active export advances past initial inactive sequence");
        observation.names = ["UnsettledPeer"]; observation.at = 3000; observation.revision++;
        state.observe(observation);
        pending.heartbeat(7000, "zfe", save);
        check(documents[documents.length - 1].names[0] == "Peer", "heartbeat only exports last settled copied batch");
        var selected = new FcmBridgeState(function() return "world-map");
        selected.menu(FcmHudRosterReader.menu({dataReady:true,isTest:false,data:{menuStackA:[]}}));
        var map = new FcmHudRosterReader.FcmRosterObservation("MapMenuData", 1000, "");
        map.names = ["MapPeer"]; map.revision = 1; selected.observe(map); selected.settle(1000);
        var selectedExport = new FcmBridgeExport("movie-map", "dev");
        selectedExport.update(1000, selected, "Self", "zfe", save);
        var selectedSequence = documents[documents.length - 1].observationSequence;
        var auxiliary = new FcmHudRosterReader.FcmRosterObservation("TeamMarkers", 21000, "");
        auxiliary.names = []; auxiliary.revision = 1; selected.observe(auxiliary); selected.settle(21000);
        selectedExport.update(21000, selected, "Self", "zfe", save);
        var selectedDocument = documents[documents.length - 1];
        check(selectedDocument.names[0] == "MapPeer" && selectedDocument.observationAgeMs == 20000,
            "fresh auxiliary data cannot renew selected older map evidence");
        check(selectedDocument.observationSequence == selectedSequence, "auxiliary heartbeat is not fresh primary observation");
        selected.menu(FcmHudRosterReader.menu({dataReady:true,isTest:false,data:{menuStackA:[{menuName:"LoadingMenu"}]}}));
        selectedExport.update(31000, selected, "Self", "zfe", save);
        check(documents[documents.length - 1].state == "inactive", "loading cannot preserve map beyond actual observation expiry");
        Sys.println("PASS FcmBridgeExport: " + count + " checks");
    }
    static function boundedResponses():Void {
        var accepted = ' { "success" : true, "capabilities" : ["other", "zfe-storage-v1"], "extra":{"v":null} } ';
        var response:Dynamic = StringTools.rpad(accepted, " ", 262145);
        var acknowledgement:Dynamic = '{ "success":true, "status":"saved" }';
        var raw = {call:function(verb:String, _:String):Dynamic return verb == "getRuntimeInfo" ? response : acknowledgement};
        check(FcmBridgeStorage.zfe(raw, "dev") == null, "oversized runtime response rejected before decoding");
        response = accepted;
        var api = FcmBridgeStorage.zfe(raw, "dev");
        check(api != null && api.save("{}"), "formatted capability and save acknowledgement accepted");
        for (bad in ['{"success":true,"status":"saved"} trailing', '{"success":true,"status":"saved",}',
                '{"nested":{"success":true,"status":"saved"}}', '{"success":false,"status":"saved"}',
                '{"success":true,"status":"pending"}', StringTools.rpad(acknowledgement, " ", 262145)]) {
            acknowledgement = bad;
            check(!api.save("{}"), "malformed or nonterminal save acknowledgement rejected");
        }
        var deep = '"zfe-storage-v1"'; for (_ in 0...40) deep = '[' + deep + ']';
        response = '{"success":true,"capabilities":[' + deep + ']}';
        check(FcmBridgeStorage.zfe(raw, "dev") == null, "deep runtime response fails closed");
    }
}
