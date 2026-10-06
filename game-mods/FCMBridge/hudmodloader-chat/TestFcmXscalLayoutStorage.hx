class TestFcmXscalLayoutStorage {
    static function check(label:String, value:Bool):Void if (!value) throw label;

    static function main():Void {
        var document:String = "";
        var loadCalls:Int = 0;
        var saveCalls:Int = 0;
        var registrationCalls:Int = 0;
        var storage:Dynamic = {
            register:function(_:String):Bool { registrationCalls++; return false; },
            load:function(name:String):Dynamic {
                loadCalls++;
                check("named load uses FCM namespace", name == FcmXscalLayoutStorage.NAME);
                return document.length > 0 ? document : false;
            },
            save:function(name:String, data:String):Bool {
                saveCalls++;
                check("named save uses FCM namespace", name == FcmXscalLayoutStorage.NAME);
                document = data;
                return true;
            }
        };
        var api = FcmXscalLayoutStorage.fromRoot({version:{runtime:"xScal",value:"0.2.20"},modStorage:storage});
        check("0.2.20 named storage available", api != null);
        var cfg = new FcmConfig();
        check("missing document leaves defaults", api.load(cfg) == "missing" && cfg.x == 10);
        cfg.x = 77;
        cfg.openKey = "HOME";
        cfg.hideKey = "END";
        check("save succeeds", api.save(cfg) && saveCalls == 1);
        check("only appearance is stored", document.indexOf("openKey") < 0
            && document.indexOf("hideKey") < 0 && document.indexOf("linkUrl") < 0);
        var next = new FcmConfig();
        next.openKey = "PERIOD";
        next.hideKey = "DELETE";
        check("saved appearance restored", api.load(next) == "loaded" && next.x == 77);
        check("INI keybinds remain authoritative", next.openKey == "PERIOD" && next.hideKey == "DELETE");
        check("named calls never claim MovieRoot registration", registrationCalls == 0 && loadCalls == 2);
        document = "{invalid";
        check("malformed document does not change config", api.load(next) == "invalid" && next.x == 77);
        var old = FcmXscalLayoutStorage.fromRoot({version:{runtime:"xScal",value:"0.2.16"},modStorage:storage});
        check("legacy storage avoids shared registration slot", old == null);
        check("ZFE object rejected", FcmXscalLayoutStorage.fromRoot({version:{runtime:"ZFE",value:"0.2.20"},modStorage:storage}) == null);
        Sys.println("FCM xScal named layout storage tests passed");
    }
}
