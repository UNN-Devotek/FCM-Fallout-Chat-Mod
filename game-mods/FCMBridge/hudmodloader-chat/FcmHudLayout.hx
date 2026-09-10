/** Device layout restore/save state. Late replies must never undo a newer local move. */
class FcmHudLayout {
    var seed:String;
    var revision:Int = 0;
    var nextAttempt:Int = 0;
    public var loaded(default, null):Bool = false;
    public var dirty(default, null):Bool = false;
    public function new(seed:String) { this.seed = seed; }
    public function changed():Void { dirty = true; revision++; nextAttempt = 0; }
    public function request(now:Int, cfg:FcmConfig):String {
        if ((loaded && !dirty) || now < nextAttempt) return "";
        nextAttempt = now + 10000;
        var settings:Dynamic = {x:cfg.x,y:cfg.y,width:cfg.width,height:cfg.height,
            fontSize:cfg.fontSize,inputHeight:cfg.inputHeight,inputFontSize:cfg.inputFontSize,
            autoHideSec:cfg.autoHideSec,autoHideEnabled:cfg.autoHideEnabled,bgAlpha:cfg.bgAlpha};
        for (field in FcmConfig.COLOR_FIELDS) Reflect.setField(settings,field,Reflect.field(cfg,field));
        return 'FCMCTL/1/LAYOUT/' + (loaded ? 'SET' : 'GET') + ';' + seed + '-' + revision
            + (loaded ? ';' + haxe.Json.stringify(settings) : '');
    }
    public function accept(body:String, cfg:FcmConfig):Bool {
        var prefix = 'FCMLAYOUT/1;' + seed + '-' + revision + ';';
        if (!StringTools.startsWith(body, prefix)) return false;
        var data:Dynamic;
        try { data = FcmJson.parse(body.substr(prefix.length)); } catch (_:Dynamic) { return false; }
        if (data != null) {
            for (key in ['x','y','width','height']) {
                var n:Dynamic = Reflect.field(data,key);
                if ((!Std.isOfType(n,Int) && !Std.isOfType(n,Float))
                    || !Math.isFinite(n) || Math.floor(n) != n) return false;
            }
            for (key in ['fontSize','inputHeight','inputFontSize','autoHideSec']) {
                if (!Reflect.hasField(data, key)) continue;
                var n:Dynamic = Reflect.field(data,key);
                var min = key == 'autoHideSec' ? 0 : (key == 'inputHeight' ? 28 : 8);
                var max = key == 'autoHideSec' ? 600 : (key == 'inputHeight' ? 120 : 47);
                if ((!Std.isOfType(n,Int) && !Std.isOfType(n,Float)) || !Math.isFinite(n)
                    || Math.floor(n) != n || (n < min && !(key == 'inputFontSize' && n == 0)) || n > max) return false;
            }
            for (field in FcmConfig.COLOR_FIELDS) {
                if (!Reflect.hasField(data,field)) continue;
                var n:Dynamic = Reflect.field(data,field);
                if ((!Std.isOfType(n,Int) && !Std.isOfType(n,Float)) || !Math.isFinite(n)
                    || Math.floor(n) != n || n < 0 || n > 0xFFFFFF) return false;
            }
            if (Reflect.hasField(data,'bgAlpha')) {
                var alpha:Dynamic = data.bgAlpha;
                if ((!Std.isOfType(alpha,Int) && !Std.isOfType(alpha,Float))
                    || !Math.isFinite(alpha) || alpha < 0 || alpha > 1) return false;
            }
            if (Reflect.hasField(data,'autoHideEnabled') && !Std.isOfType(data.autoHideEnabled,Bool)) return false;
            if (data.x < 0 || data.y < 0 || data.width < 200 || data.height < 120
                || data.x + data.width > FcmConfig.VIEW_W || data.y + data.height > FcmConfig.VIEW_H) return false;
        }
        if (loaded) { if (data != null) dirty = false; return false; }
        loaded = true;
        nextAttempt = 0;
        if (dirty || data == null) return false;
        cfg.x = data.x; cfg.y = data.y; cfg.width = data.width; cfg.height = data.height;
        for (key in ['fontSize','inputHeight','inputFontSize','autoHideSec'])
            if (Reflect.hasField(data,key)) Reflect.setField(cfg,key,Reflect.field(data,key));
        if (Reflect.hasField(data,"autoHideEnabled")) cfg.autoHideEnabled = data.autoHideEnabled;
        for (field in FcmConfig.COLOR_FIELDS.concat(['bgAlpha']))
            if (Reflect.hasField(data,field)) Reflect.setField(cfg,field,Reflect.field(data,field));
        cfg.clamp();
        return true;
    }
}
