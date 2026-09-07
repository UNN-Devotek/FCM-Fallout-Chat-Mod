# ZFE Modder Guide

Starting point for Fallout 76 UI mod authors calling ZFE from ActionScript/Scaleform.

## Related Guides

- [ZFE API Reference](api-reference.md) — Remote Data, Storage, Events, Imports, and Legacy Compatibility in one doc
- [ZFE Environment Variables](env-vars.md) — variables useful while testing your mod
- [ZFE Logs and Troubleshooting](logs-troubleshooting.md)

## What ZFE Exposes

ZFE exposes a local API bridge. Preferred call shape:

```as3
__ZFE.call(command:String, payloadJson:String):String
```

New mods should look for `__ZFE` first. ZFE also installs compatibility objects for older roots, so the same ZFE commands may be available through `ZFECodeObj.call(...)` or `__SFCodeObj.call(...)`. However, xScal also installs a generic `__SFCodeObj.call` on the movie root, so that name alone is not proof of ZFE; require a successful capability response before using it.

## Finding the Bridge

`api` is **not** an ActionScript import. ZFE injects bridge objects into the live UI at runtime. Find one at startup:

```as3
function bridgeOn(container:Object, name:String):Object {
    if (container != null && container[name] != null && container[name].call != null) {
        return container[name];
    }
    return null;
}

function findZfeApi(scope:Object):Object {
    var parent:Object = scope != null ? scope.parent : null;
    var root:Object   = scope != null ? scope.root   : null;

    var api:Object = bridgeOn(scope,  "__ZFE");      if (api != null) return api;
        api        = bridgeOn(parent, "__ZFE");      if (api != null) return api;
        api        = bridgeOn(root,   "__ZFE");      if (api != null) return api;
        api        = bridgeOn(root,   "ZFECodeObj"); if (api != null) return api;
    var legacy:Object = bridgeOn(root, "__SFCodeObj");
    if (legacy != null) {
        // xScal uses this same property for a different callback registry.
        // Identify that registry before sending any ZFE chat command.
        var xscalInfo:String = String(legacy.call("GetXSRuntimeInfo", "{}"));
        if (xscalInfo.indexOf('"runtime":"xScal"') >= 0 ||
            xscalInfo.indexOf('"runtime": "xScal"') >= 0) return null;
        var legacyInfo:String = String(legacy.call("chat.v1.getRuntimeInfo", "{}"));
        if (legacyInfo.indexOf('"success":true') >= 0 &&
            legacyInfo.indexOf("zfe-chat-online-v1") >= 0) return legacy;
    }
    return null;
}

var api:Object = findZfeApi(this);
```

All examples in ZFE guides assume `api` is a bridge object returned by a lookup like this.

## getRuntimeInfo

```as3
var result:String = String(api.call("getRuntimeInfo", "{}"));
```

Parse the returned JSON and check `success:true`. Contains: `runtime`, `version`, `protocol`, `mode`, `capabilities`, `limits`, `remoteData`.

Useful capability names:

| Capability | Feature |
|---|---|
| `zfe-general-api-v1` | General API |
| `zfe-storage-v1` | Local storage |
| `zfe-import-v1` | Allow-listed import files |
| `zfe-log-v1` | ZFE log API |
| `zfe-events-v1` | In-process events |
| `zfe-remote-data-v1` | HTTPS remote data fetch |

For HUDModLoader AS3 mods, search order:
1. `this.__ZFE`, `parent.__ZFE`, `root.__ZFE`
2. `ZFECodeObj` at the same locations
3. `__SFCodeObj` for legacy compatibility, but accept it only after a positive ZFE capability probe (xScal uses the same property name for a different callback registry)
4. First-level children of root if hosted inside another menu

## Result Shape

Success:
```json
{"success":true}
```

Failure:
```json
{"success":false,"error":{"code":"invalid_vendor","message":"Vendor must be 1..64 ASCII letters, digits, dot, dash, or underscore"}}
```

**Always parse JSON and check `success`. Never treat a non-empty string as success.**

## Safe Names

Most commands require a `vendor` field. Use a stable vendor name for your mod or family.

Vendor names, event topics, and log categories: 1–64 ASCII letters, digits, `.`, `-`, `_`.

Good examples: `MyMod`, `MyMod.UI`, `FCMBridge`, `PerkLoadoutManager`

## Logging

```as3
api.call("log",
    "{\"vendor\":\"FCMBridge\",\"level\":\"info\",\"category\":\"startup\",\"message\":\"loaded\"}");
```

Levels: `trace`, `info`, `warn`, `error`. Result: `{"success":true,"status":"logged"}`.

Keep messages short. Do not log private player data.

## Current Limits

| Resource | Limit |
|---|---|
| Storage write/read | 1 MiB |
| Import read | 2 MiB |
| Log message | 4096 bytes |
| Event data JSON | 8192 bytes |
| Retained events | 128 |
| Poll batch | 1–64 (default 16) |

## Safety Boundary

The local ZFE API does **not** inspect game memory, attach to another process, bypass anti-cheat, scrape player/vendor/container state, or automate trade.

Use it for: local UI-mod coordination, local mod settings, allow-listed imports, logs, and documented ZFE APIs only.

## Testing Checklist

1. Call `getRuntimeInfo` — confirm `success:true`, version, and the capability you need.
2. Parse every command result and check `success`.
3. Inspect `zfe.log` for your vendor's Mod API lines.
4. Test Steam and Game Pass separately if claiming support for both.
