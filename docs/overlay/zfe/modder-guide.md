# Provider APIs used by the FCM HUD

This guide separates FCM's implemented adapter from upstream APIs that may be available to new
mods. It was checked against local source and the authors' public guides on 2026-09-12. Always
check the running provider's capabilities; an article's version or a familiar object name is not
a compatibility guarantee.

## FCM adapter

Use [`FcmNativeApi.hx`](../../../game-mods/FCMBridge/FcmNativeApi.hx) instead of introducing a
second provider-discovery implementation. It walks already-exposed movie/parent/root surfaces.
It does not inspect DLLs, read game memory, or scan files/ports to choose an extender.

| Surface | How FCM uses it |
| --- | --- |
| ZFE `__ZFE.call` / `ZFECodeObj.call` | Canonical verb plus JSON string; positive native-chat capability response required |
| Legacy call-only `__SFCodeObj` / `BRG_OBJ` | Ambiguous until positively identified; avoid sending ZFE probes to a known xScal registry |
| xScal `chatInterface` | Required `connect`, `pollEvents`, `sendMessage`; positive optional runtime response when exposed; selected first if both providers are present |
| xScal generic callback | Logging and physical `Input.*`, separate from chat transport |

xScal chat payloads are ActionScript objects, parsed from FCM's canonical JSON input. Runtime,
connection-state, disconnect, logout, and credential-clear methods take no arguments in the
adapter. `report` maps to `reportMessage`; auth-state lookup has its supported connection-state
fallback. Do not pass JSON strings or extra `{}` arguments indiscriminately.

ZFE general runtime discovery uses `getRuntimeInfo`; FCM's existing chat gate checks
`chat.v1.getRuntimeInfo` for `zfe-chat-online-v1`. The author's current general capability is
`zfe-chat-v1`. These are different discovery surfaces; do not silently replace one gate with the
other without adapter tests and a runtime trace. The
[ZFE API overview](https://www.nexusmods.com/fallout76/articles/255) is the upstream starting point;
the [chat relay guide](https://www.nexusmods.com/fallout76/articles/256) owns the current wire contract.

## Three distinct input contracts

1. **Current FCM input:** SharedHUDTools' host editor first, with a legacy ZFE native-editor
   fallback. The child widget does not send its own ControlMap lock events.
2. **Physical `Input.*` compatibility:** xScal documents numeric Windows VK arguments and Boolean
   results for registration, polling, and unregistration. FCM requires true Boolean success for
   xScal. Its ZFE compatibility decoder also supports older return shapes. An accepted register
   call is not proof that polling or keyboard suppression works. See the
   [xScal Input guide](https://www.nexusmods.com/fallout76/articles/268).
3. **Public ZFE owner-scoped APIs:** `zfe-input-v1` names `input.v1.*` text sessions; it is not
   evidence for legacy `Input.RegisterKey` or chat-editor calls. `zfe-hotkeys-v1` names a separate
   hotkey API. Neither is implemented by merely renaming FCM's compatibility methods.

The detailed [ZFE hotkey guide](https://www.nexusmods.com/fallout76/articles/270) is available,
superseding older “payload contract unavailable” notes. It describes vendor-owned registrations,
exact chords, edge-count polling, and explicit unregistration; abandoned registrations expire
after five seconds. It does not guarantee blocking a gameplay binding. Its key list does not
include arrows, so it cannot replace every feed-navigation key unchanged. Migration remains
separate work requiring ownership, idle/typing, repeat, timeout, and unload tests.

The [ZFE text-input guide](https://www.nexusmods.com/fallout76/articles/260) documents session
ownership, heartbeat, and release behavior. Keep that lifecycle distinct from the old chat-input
fallback. Refer to the author's current API for new work rather than copying the historical API
snapshot in this folder.

## Results, timing, and security

Parse successful JSON explicitly and reject malformed/unsupported results. A successful xScal
`connecting` response is pending transport, not linked authentication. Keep native calls bounded;
a timer defers a synchronous call but does not make it asynchronous. Preserve session-scoped
cursors, durable message identities, replay-before-echo ordering, and capability-gated retries.

Native credentials stay provider-owned. Use only documented storage/import APIs for allowed
UI settings; never use vendor storage to edit a credential container. Preserve per-provider
argument shapes and error handling. The HUD may consume data the game already publishes to its
UI, but the desktop overlay must not inherit that access.

## Further references

- [FCM integration](native-chat-relay/fcm-integration.md): actual relay operations, controls, and permissions.
- [Scaleform engineering](scaleform-ui-guide.md): rendering/input/artifact evidence.
- [API snapshot](api-reference.md): historical general/remote-data APIs, not a complete current contract.
- [Environment notes](env-vars.md), [logs and troubleshooting](logs-troubleshooting.md): diagnostic scope.
- [xScal callback source](https://github.com/DCHoaxer/xScal/blob/main/src/api/scaleform_callbacks.cpp):
  generic callback implementation, separate from the chat interface.
