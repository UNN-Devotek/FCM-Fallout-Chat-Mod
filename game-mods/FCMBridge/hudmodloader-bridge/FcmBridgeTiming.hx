/** Test-build-only, privacy-safe elapsed-time counters. No names or native payloads. */
class FcmBridgeTiming {
    public var pollLast(default, null):Int = 0;
    public var pollPeak(default, null):Int = 0;
    public var encodeLast(default, null):Int = 0;
    public var encodePeak(default, null):Int = 0;
    public var saveLast(default, null):Int = 0;
    public var savePeak(default, null):Int = 0;

    static function bounded(value:Float):Int {
        return !Math.isFinite(value) || value < 0 ? 0 : Std.int(Math.min(9999, value));
    }
    public function new() {}
    public function poll(ms:Float):Void { pollLast = bounded(ms); pollPeak = Std.int(Math.max(pollPeak, pollLast)); }
    public function encode(ms:Float):Void { encodeLast = bounded(ms); encodePeak = Std.int(Math.max(encodePeak, encodeLast)); }
    public function save(ms:Float):Void { saveLast = bounded(ms); savePeak = Std.int(Math.max(savePeak, saveLast)); }

    /** Fits the existing 64-character build label; each pair is last/peak milliseconds. */
    public function label():String {
        return "-perf:p" + pollLast + "/" + pollPeak
            + ":e" + encodeLast + "/" + encodePeak
            + ":s" + saveLast + "/" + savePeak;
    }
}
