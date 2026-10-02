/** xScal 0.2.17+ named modStorage for local appearance only. */
class FcmXscalLayoutStorage {
    public static inline var NAME:String = "fcmchatwidget-layout-v1";
    static inline var MAX_DOCUMENT_BYTES:Int = 40960;
    var storage:Dynamic;

    function new(storage:Dynamic) this.storage = storage;

    public static function fromRoot(root:Dynamic):FcmXscalLayoutStorage {
        if (root == null) return null;
        try {
            var version:Dynamic = Reflect.field(root, "version");
            if (version == null || Reflect.field(version, "runtime") != "xScal"
                    || !versionAtLeast(Std.string(Reflect.field(version, "value")), 0, 2, 17)) return null;
            var storage:Dynamic = Reflect.field(root, "modStorage");
            if (storage == null || !Reflect.isFunction(Reflect.field(storage, "load"))
                    || !Reflect.isFunction(Reflect.field(storage, "save"))) return null;
            return new FcmXscalLayoutStorage(storage);
        } catch (_:Dynamic) { return null; }
    }

    static function versionAtLeast(raw:String, major:Int, minor:Int, patch:Int):Bool {
        var parts = raw.split(".");
        if (parts.length < 3) return false;
        var found = [Std.parseInt(parts[0]), Std.parseInt(parts[1]), Std.parseInt(parts[2])];
        if (found[0] == null || found[1] == null || found[2] == null) return false;
        if (found[0] != major) return found[0] > major;
        if (found[1] != minor) return found[1] > minor;
        return found[2] >= patch;
    }

    /** Returns loaded, missing, or invalid; the native API reports unreadable as false. */
    public function load(cfg:FcmConfig):String {
        try {
            var result:Dynamic = Reflect.callMethod(storage, Reflect.field(storage, "load"), [NAME]);
            if (result == false || result == null) return "missing";
            if (!Std.isOfType(result, String)) return "invalid";
            var document:String = cast result;
            if (haxe.io.Bytes.ofString(document).length > MAX_DOCUMENT_BYTES) return "invalid";
            return FcmHudLayout.restoreLocal(document, cfg) ? "loaded" : "invalid";
        } catch (_:Dynamic) { return "unavailable"; }
    }

    public function save(cfg:FcmConfig):Bool {
        var document = FcmHudLayout.snapshotJson(cfg);
        if (haxe.io.Bytes.ofString(document).length > MAX_DOCUMENT_BYTES) return false;
        try {
            return Reflect.callMethod(storage, Reflect.field(storage, "save"), [NAME, document]) == true;
        } catch (_:Dynamic) { return false; }
    }
}
