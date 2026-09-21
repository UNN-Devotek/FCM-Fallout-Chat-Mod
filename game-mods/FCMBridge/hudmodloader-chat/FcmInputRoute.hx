/** Provider-aware input routing for the one shared widget build. */
class FcmInputRoute {
    public static inline var NATIVE:String = "native";
    public static inline var OWNED:String = "owned";
    public static inline var SHARED:String = "shared";

    /** Current ZFE owns keyboard text directly; older ZFE and xScal use the host editor. */
    public static function preferred(provider:String, ownedUsable:Bool):String {
        if (provider == FcmNativeApi.ZFE && ownedUsable) return OWNED;
        return SHARED;
    }

    public static function mayUseNativeFallback(provider:String, nativeUsable:Bool):Bool {
        return provider == FcmNativeApi.ZFE && nativeUsable;
    }
}
