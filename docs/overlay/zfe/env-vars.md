# HUD environment and extender configuration

The modern FCMChatWidget uses native ZFE/xScal chat. No legacy socket/remote-data environment
variable is required to activate it. Follow the [build/install guide](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md)
and the selected provider's current author instructions.

## Native chat target

ZFE reads the modern `FCMChatWidget.ini` TextChat fragment, with per-key overrides in
`Data/configuration/zfe.ini` `[TextChat]`. Check that global file even when the packaged fragment
has the correct endpoint. Keep `OpenChatKey` aligned with `Data/FCMChat.ini` `openKey`.
xScal uses `[Chat] enabled=true` and `relayEndpoint` in `xscal.ini` beside the game executable;
do not add ZFE `OpenChatKey` to that file. Both providers use `wss://<target>/relay`.

Restart the game after native configuration changes. FCM's backend `RELAY_PRODUCTION_ENABLED`
flag is a server-side deployment setting, not a player environment variable. A build/ZIP does
not establish live deployment state.

## Diagnostic and historical variables

The [ZFE author's environment guide](https://www.nexusmods.com/fallout76/articles/247) documents
`ZFE_LOG_DIRECTORY` for directing logs to a writable folder. `ZFE_REMOTE_DATA_ALLOW_LOCALHOST_DEVELOPMENT`
and `ZFE_DISABLE_REMOTE_DATA` concern the separate remote-data API; they do not select FCM's
native chat endpoint or repair its authentication.

Older FCM notes mention `ZFE_ENABLE_TEXT_CHAT_LIVE_BACKEND`, `ZFE_TEXT_CHAT_ENDPOINT`, and
`ZFE_DISABLE_TEXT_CHAT_LIVE_BACKEND` for the retired generic socket transport. Do not add them
for the modern widget or infer that they configure `chat.v1`. Preserve historical details in
[the old socket guide](realtime-socket.md), not in current installation steps.

For a temporary PowerShell log-directory override:

```powershell
$env:ZFE_LOG_DIRECTORY = "D:\Temp\ZFELogs"
```

It affects that process and children launched from it. Use a folder, not a full log filename.
Clear it after testing:

```powershell
Remove-Item Env:\ZFE_LOG_DIRECTORY -ErrorAction SilentlyContinue
```

A persistent User environment change requires restarting the launcher/game to take effect.
Do not use undocumented hook switches, certificate bypasses, proxy daemons, or trust-store
changes as a routine HUD setup step. See [logs](logs-troubleshooting.md) and
[historical Proton status](native-chat-relay/proton-status.md).
