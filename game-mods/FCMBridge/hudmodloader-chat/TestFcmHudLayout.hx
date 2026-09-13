class TestFcmHudLayout {
    static function check(ok:Bool, s:String):Void { if (!ok) throw s; }
    static function main():Void {
        var cfg = new FcmConfig();
        var state = new FcmHudLayout('test');
        check(state.request(0,cfg) == 'FCMCTL/1/LAYOUT/GET;test-0','initial read');
        check(state.request(1,cfg) == '', 'bounded retries');
        check(state.accept('FCMLAYOUT/1;test-0;{"x":20,"y":40,"width":400,"height":200}',cfg), 'restore');
        check(cfg.x == 20 && cfg.width == 400,'restored geometry');
        state.changed(); cfg.x = 60;
        check(StringTools.startsWith(state.request(2,cfg),'FCMCTL/1/LAYOUT/SET;test-1;'),'save');
        state.changed(); cfg.x = 80;
        state.accept('FCMLAYOUT/1;test-1;{"x":60,"y":40,"width":400,"height":200}',cfg);
        check(state.dirty && cfg.x == 80,'ignore stale save acknowledgement');
        var early = new FcmHudLayout('early');
        early.request(0,cfg); early.changed(); cfg.x = 100;
        early.accept('FCMLAYOUT/1;early-0;null',cfg);
        check(!early.loaded,'ignore stale read');
        early.accept('FCMLAYOUT/1;early-1;{"x":20,"y":40,"width":400,"height":200}',cfg);
        check(early.loaded && early.dirty && cfg.x == 100,'keep move made before restore');
        check(StringTools.startsWith(early.request(1,cfg),'FCMCTL/1/LAYOUT/SET;early-1;'),'save early move');
        var settings = new FcmHudLayout('settings');
        var configured = new FcmConfig();
        check(settings.accept('FCMLAYOUT/1;settings-0;{"x":20,"y":40,"width":400,"height":200,"fontSize":18,"inputHeight":48,"inputFontSize":24,"autoHideEnabled":false,"autoHideSec":95}', configured), 'restore input settings');
        check(configured.fontSize == 18 && configured.inputHeight == 48 && configured.inputFontSize == 24, 'all sizes restored');
        check(!configured.autoHideActive() && configured.autoHideSec == 95, 'restore separate auto-hide state');
        settings.changed();
        var request = settings.request(0, configured);
        var saved:Dynamic = FcmJson.parse(request.substr(request.lastIndexOf(';') + 1));
        check(saved.inputHeight == 48 && saved.inputFontSize == 24 && saved.fontSize == 18, 'save input settings');
        check(saved.autoHideEnabled == false && saved.autoHideSec == 95, 'save separate auto-hide state');
        var invalid = new FcmHudLayout('invalid');
        check(!invalid.accept('FCMLAYOUT/1;invalid-0;{"x":20,"y":40,"width":400,"height":200,"inputFontSize":4}',configured), 'reject invalid optional size');
        check(!invalid.loaded && configured.inputFontSize == 24, 'invalid reply does not mutate state');
        var legacy = new FcmHudLayout('legacy');
        check(legacy.accept('FCMLAYOUT/1;legacy-0;{"x":20,"y":40,"width":400,"height":200}',configured), 'old geometry reply supported');
        check(configured.inputFontSize == 24, 'old reply retains INI settings');
        var appearance = new FcmHudLayout('appearance');
        var appearanceCfg = new FcmConfig();
        var values:Dynamic = {x:10,y:10,width:400,height:260,bgAlpha:0.3};
        for (field in FcmConfig.COLOR_FIELDS) Reflect.setField(values,field,0x123456);
        check(appearance.accept('FCMLAYOUT/1;appearance-0;' + haxe.Json.stringify(values),appearanceCfg), 'restore colors and opacity');
        check(appearanceCfg.bgAlpha == 0.3 && appearanceCfg.inputTextColor == 0x123456, 'restored input color and alpha');
        appearance.changed();
        var wire = appearance.request(0,appearanceCfg);
        var appearanceSaved:Dynamic = FcmJson.parse(wire.substr(wire.lastIndexOf(';') + 1));
        for (field in FcmConfig.COLOR_FIELDS) check(Reflect.field(appearanceSaved,field) == 0x123456, 'color round trip ' + field);
        check(wire.length <= 1024 && appearanceSaved.bgAlpha == 0.3, 'bounded appearance save');
        var invalidColor = new FcmHudLayout('badcolor');
        values.inputTextColor = -1;
        check(!invalidColor.accept('FCMLAYOUT/1;badcolor-0;' + haxe.Json.stringify(values),appearanceCfg), 'invalid color rejected');
        trace('HUD layout tests passed');
    }
}
