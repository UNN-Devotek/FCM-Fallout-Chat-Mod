/**
 * Generation guard for delayed Scaleform work.
 *
 * Timer callbacks can outlive a render/reload. A callback may mutate the widget
 * only while its captured generation is still current.
 */
class FcmRenderGeneration {
    var _value:Int = 0;

    public function new() {}

    /** Start a new render generation and return its token. */
    public function begin():Int {
        _value++;
        return _value;
    }

    /** Invalidate all callbacks from the current generation. */
    public function invalidate():Int {
        _value++;
        return _value;
    }

    public function isCurrent(token:Int):Bool {
        return token == _value;
    }

    public function current():Int {
        return _value;
    }
}
