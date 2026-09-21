/** File-boundary fake only; it never claims a backend room or supplies credentials. */
class MockBridgeStorage {
    public static var document:Dynamic = null;
    public static var writes:Int = 0;
    public static var fail:Bool = false;
    public static function save(text:String):Bool {
        writes++;
        if (fail) return false;
        document = haxe.Json.parse(text); return true;
    }
    public static function root():Dynamic return {version:{runtime:"xScal",value:"0.2.17",platform:"sim"},modStorage:{
        register:function(_:String):Bool return false,
        load:Reflect.makeVarArgs(function(_:Array<Dynamic>):Dynamic return false),
        save:Reflect.makeVarArgs(function(args:Array<Dynamic>):Dynamic {
            if (args.length != 2) return false;
            var name = Std.string(args[0]);
            if (name != "fcmserverbridge-prod" && name != "fcmserverbridge-dev") return false;
            return save(Std.string(args[1]));
        })
    }};
}
