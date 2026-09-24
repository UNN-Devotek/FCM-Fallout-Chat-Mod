/** Provider-aware input routing for the one shared widget build. */
class FcmInputRoute {
    public static inline var NATIVE:String = "native";
    public static inline var OWNED:String = "owned";
    public static inline var XSCAL_SESSION:String = "xscal-session";
    public static inline var SHARED:String = "shared";

    /** Current ZFE and xScal can own text; older builds retain the host editor. */
    public static function preferred(provider:String, ownedUsable:Bool, xscalSessionUsable:Bool = false):String {
        if (provider == FcmNativeApi.ZFE && ownedUsable) return OWNED;
        if (provider == FcmNativeApi.XSCAL && xscalSessionUsable) return XSCAL_SESSION;
        return SHARED;
    }

    public static function mayUseNativeFallback(provider:String, nativeUsable:Bool):Bool {
        return provider == FcmNativeApi.ZFE && nativeUsable;
    }
}
