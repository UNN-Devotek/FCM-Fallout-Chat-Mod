/** One observation attempt; nested native callbacks cannot overwrite its phase. */
class FcmBridgeRead {
    public var step:String = "getter";
    public function new() {}
    /** Capped per-source delay; never lengthens observation or backend leases. */
    public static function retryDelay(failures:Int):Int {
        return failures <= 1 ? 2000 : failures == 2 ? 4000 : failures == 3 ? 8000 : failures == 4 ? 16000 : 30000;
    }
    /** Never stringify an exception or expose its message, stack, payload or names. */
    public static function errorCode(error:Dynamic):String return FcmRuntimeError.errorCode(error);
    /** Only the class identifier from the VM's exact E1014 template may leave
     * this boundary. Never render the message, stack, or arbitrary error text. */
    public static function missingClass(error:Dynamic):String return FcmRuntimeError.missingClass(error);
}
