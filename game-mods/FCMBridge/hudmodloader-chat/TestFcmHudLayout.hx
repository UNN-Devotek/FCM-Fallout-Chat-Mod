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
        trace('HUD layout tests passed');
    }
}
