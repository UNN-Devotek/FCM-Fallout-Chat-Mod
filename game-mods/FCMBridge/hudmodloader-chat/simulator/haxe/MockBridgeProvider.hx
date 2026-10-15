/** Sealed AS3-style accessors, matching the upstream UIDataFromClient surface. */
@:keep
class MockBridgeProvider {
    var payload:Dynamic;
    var live:Bool;
    var ready:Bool;
    public function new(data:Dynamic, isTest:Bool = false, dataReady:Bool = true) {
        payload = data; live = !isTest; ready = dataReady;
    }
    @:getter(data) public function readData():Dynamic return payload;
    @:getter(dataReady) public function readReady():Bool return ready;
    @:getter(isTest) public function readTest():Bool return !live;
    public function SetReady(dispatch:Bool):Void throw new flash.errors.Error("Probe must not change readiness", 1014);
}

@:keep
class MockBridgeEvent {
    var provider:Dynamic;
    public function new(value:Dynamic) { provider = value; }
    @:getter(fromClient) public function readProvider():Dynamic return provider;
    @:getter(data) public function readData():Dynamic return FcmRoster.field(provider, "data");
}
