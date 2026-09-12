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

    /** Every delayed slice needs its own exception boundary; the scheduler's catch has ended. */
    public function runCurrent(token:Int, work:Void->Void, failed:Dynamic->Void):Void {
        if (!isCurrent(token)) return;
        try {
            work();
        } catch (error:Dynamic) {
            // A re-entrant rebuild owns the new feed even if the old work then fails.
            if (isCurrent(token)) failed(error);
        }
    }

    public function current():Int {
        return _value;
    }
}
