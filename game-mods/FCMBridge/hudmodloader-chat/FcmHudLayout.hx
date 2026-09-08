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
        return 'FCMCTL/1/LAYOUT/' + (loaded ? 'SET' : 'GET') + ';' + seed + '-' + revision
            + (loaded ? ';' + haxe.Json.stringify({x:cfg.x,y:cfg.y,width:cfg.width,height:cfg.height}) : '');
    }
    public function accept(body:String, cfg:FcmConfig):Bool {
        var prefix = 'FCMLAYOUT/1;' + seed + '-' + revision + ';';
        if (!StringTools.startsWith(body, prefix)) return false;
        var data:Dynamic;
        try { data = haxe.Json.parse(body.substr(prefix.length)); } catch (_:Dynamic) { return false; }
        if (data != null) {
            for (key in ['x','y','width','height']) {
                var n:Dynamic = Reflect.field(data,key);
                if ((!Std.isOfType(n,Int) && !Std.isOfType(n,Float))
                    || !Math.isFinite(n) || Math.floor(n) != n) return false;
            }
            if (data.x < 0 || data.y < 0 || data.width < 200 || data.height < 120
                || data.x + data.width > FcmConfig.VIEW_W || data.y + data.height > FcmConfig.VIEW_H) return false;
        }
        if (loaded) { if (data != null) dirty = false; return false; }
        loaded = true;
        nextAttempt = 0;
        if (dirty || data == null) return false;
        cfg.x = data.x; cfg.y = data.y; cfg.width = data.width; cfg.height = data.height;
        cfg.clamp();
        return true;
    }
}
