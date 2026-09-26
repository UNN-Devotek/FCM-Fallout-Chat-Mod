# HUD text input: ZFE and xScal contracts

This describes the current `FCMChatWidget` 2.10.129 source and the locally tested ZFE 0.15.0
and xScal 0.2.18 paths. One provider-neutral BA2 contains both routes. The widget requires
**one active extender**; if it detects both, it shows a provider-conflict message and stops
discovery. [Provider discovery](../../../game-mods/FCMBridge/FcmNativeApi.hx) and
[route selection](../../../game-mods/FCMBridge/hudmodloader-chat/FcmInputRoute.hx) are the
source of truth. The chat relay transport is separate from keyboard capture; see
[FCM relay integration](native-chat-relay/fcm-integration.md).

## Choose the editor

| Provider | Open-key detection | Text editor | Gameplay-key ownership | When opening fails |
| --- | --- | --- | --- | --- |
| ZFE | Owner-scoped `hotkeys.v1` where supported, plus numeric `Input.*` polling for physical Insert; the legacy chat-key watcher is a compatibility route | Host `SharedHUDTools.TextEdit`, including when `zfe-input-v1` is advertised | HUDTools owns the balanced Fallout ControlMap text lock | Refuse the editor if HUDTools cannot open; do not start an unlocked native draft |
| xScal 0.2.18, default `xscalInputMode=native` | Numeric `Input.RegisterKey` / `Input.IsKeyPressed` | Native `Input.BeginInput` / `PollInput` / `EndInput` session | xScal owns keyboard capture during its session | Native refusal: report unavailable; if the physical open key is held, retry once on release within two seconds. Unsupported session API: use the host editor. Malformed ownership or unconfirmed release: block reopening until reload |
| xScal with `xscalInputMode=shared` | Same numeric open-key polling | `SharedHUDTools.TextEdit` | HUDTools owns the ControlMap lock | Refuse entry if the host editor cannot open; controller text entry is unsupported |
| Older xScal without the session API | Same numeric open-key polling | `SharedHUDTools.TextEdit` fallback | HUDTools owns the ControlMap lock | Refuse entry if the host editor cannot open; controller-mode physical typing on this fallback is best effort |

The configured `openKey` comes from `Data/FCMChat.ini` on both providers. Registration and
polling through `Input.*` detect a physical key edge; **registration does not suppress Fallout's
gameplay action**. ZFE keeps its owner hotkey and numeric open-key registration together so
physical Insert can arrive with a controller active. The widget checks HUD-mode and modal
ownership before opening either editor and uses edge latches to avoid opening twice. See
[`FCMChatWidget.openInput`](../../../game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx)
and the [keybind guide](../../../game-mods/FCMBridge/hudmodloader-chat/KEYBINDS.txt).

`Data/FCMChat.ini` also selects the xScal editor. The native typing failure
reproduced on the tested Windows laptop; native xScal input worked in the
Linux/Steam Proton test with xScal 0.2.18. `xscalInputMode=shared` is a
temporary Windows workaround while xScal's native refusal is diagnosed.
`xscalInputMode=native` remains the default for the working Proton path. On a
Windows install where `Input.BeginInput` repeatedly returns
`input_unavailable`, set
`xscalInputMode=shared` and restart the game. This explicitly skips xScal's
native text session and uses the HUDModLoader host editor. It does not change
any of the eight configurable action keys or ZFE's editor. The widget keeps
this environment setting when it restores saved appearance settings. There is
no automatic switch on `input_unavailable`, because that same response can
mean another native editor owns the session.

The Windows laptop test with xScal 0.2.18 and HUDModLoader v70 confirmed that
`xscalInputMode=shared` opened the host editor, accepted typed characters,
submitted through xScal, and received one matching relay echo. The user reported
that typing worked. The log does not measure gameplay-key suppression directly;
controller text entry remains unsupported in this mode.

## ZFE: host editor and ControlMap lock

The automatic ZFE route calls the public HUDTools methods in order:

1. `FormatTextEdit(x, y, width, height, font, fontSize, textColor, backgroundColor, alpha)`
   places and styles the visible host entry field.
2. `FormatOnScreenKeyboard(0, -300)` satisfies the host editor's setup contract while keeping
   its 300×180 controller keyboard outside the viewport.
3. `TextEdit(callback, "")` opens the host editor. Enter calls back with a string; Escape or
   Tab calls back with `null`. The widget never mirrors the same text into a second input field.
4. On cancellation, menu handoff, reconnect, failure, or unload, `EndTextEdit()` releases the
   host editor. The widget invalidates its callback generation before requesting that close.

HUDTools owns `ControlMap::StartEditText` and the matching `EndEditText`. The child widget must
not dispatch either event. When a controller is active, HUDTools may initially focus an
off-screen controller field. FCM finds the **visible host entry** through the public display
list and focuses it for physical keyboard typing, including after a delayed host focus handoff.
The host ControlMap lock remains in force. The widget also watches for a lost submit callback:
it recovers an armed Enter draft once and cancels other stale focus loss without logging text.
Implementation: [host editor and focus](../../../game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx).

The ZFE `input.v1.begin/poll/end` decoder is retained for explicit diagnostics. Its
`zfe-input-v1` and `zfe-input-release-v1` capabilities name **owner-scoped text sessions**,
not the `Input.*` physical-key callbacks or the HUDTools ControlMap lock. The local 0.15.0
trial opened such a session while gameplay still responded to M/W. Therefore
[`FcmInputRoute.preferred`](../../../game-mods/FCMBridge/hudmodloader-chat/FcmInputRoute.hx)
selects HUDTools for ZFE even when those capabilities are advertised; the legacy ZFE native
chat-input buffer is not an automatic fallback either. `hotkeys.v1.*` is a third, separate
contract for owned key chords and edge-count polling, not text editing or gameplay suppression.

## xScal: native text session

The xScal `chatInterface` handles chat transport. Text capture uses the **separate generic
callback** exposed through `__SFCodeObj.call` on the tested build. The adapter calls it with
these exact argument shapes, not ZFE-style JSON payload strings:

```text
call("Input.BeginInput")
call("Input.PollInput", sessionId)
call("Input.EndInput", sessionId)
```

[`FcmNativeApi`](../../../game-mods/FCMBridge/FcmNativeApi.hx) makes those calls;
[`FcmXscalInput`](../../../game-mods/FCMBridge/hudmodloader-chat/FcmXscalInput.hx)
validates their replies. Begin must return a JSON string with `success:true` and a numeric,
integer `sessionId` from 1 through 4,294,967,295. Poll must return a JSON string with
`success:true`, the same session ID, a nondecreasing integer `revision`, bounded `text`, and
`state` of `active`, `submitted`, or `cancelled`. The widget polls every 40 ms and accepts at
most 512 UTF-16 units. The text is a complete native-edited snapshot; the widget never
synthesizes characters from physical key codes. A changed text with an unchanged revision,
wrong session ID, malformed reply, or reversed revision ends and disables the route.

`submitted` dispatches the trimmed nonempty snapshot once; `cancelled` discards it. Both
states end the session. Every successful begin must receive an end on terminal input, modal
handoff, failure, or widget shutdown. `EndInput` has an undocumented return shape on the
tested 0.2.18 DLL. If it does not return Boolean `true`, FCM polls the old ID once and accepts
only `{"success":false,"error":"invalid_session"}` as release confirmation. An unconfirmed
release blocks another open rather than risking two native owners. A validated submitted poll
can still dispatch its message even if cleanup cannot confirm release. See
[`openXscalSessionInput` and `closeXscalSessionInput`](../../../game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx).

`{"success":false,"error":"input_unavailable"}` means xScal refused the native
session. Static inspection of the public 0.2.18 DLL found that it can result
from an existing provider session, failure to locate the foreground game
window, failure to install its window subclass, a changed previously selected
window, or failure to produce the initial session snapshot. The reply
does not identify which condition occurred. Do not open a competing HUDTools
editor; the player may retry. FCM now shows a visible unavailable message.
For the physical open-key path, the diagnostic BA2 also makes one bounded
`BeginInput` attempt after that key's release if the first attempt returned
`input_unavailable` while it was held. It logs the phase, elapsed time, and
acceptance without recording typed text. This tests whether the native refusal
depends on key dispatch timing; repeated idle polls do not retry. Modal
ownership, an expired two-second window, or a provider change skips the probe.
A `null` or Boolean `false` begin reply
means the session API is unsupported, so FCM disables that route and uses HUDTools. Other
malformed begin replies make ownership uncertain and block reopening until reload. This
fallback distinction is implemented in
[`openInput`](../../../game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx).

## Keep the APIs separate

| API | Argument and result shape | Purpose |
| --- | --- | --- |
| ZFE `chat.v1.*` | Command plus JSON string | Chat relay transport, not keyboard capture |
| xScal `chatInterface` | ActionScript object or no argument, depending on method | Chat relay transport, not its native text session |
| ZFE `hotkeys.v1.*` | Owner-scoped JSON registration/polling | Configured key chords; does not promise gameplay suppression |
| Provider `Input.RegisterKey` / `Input.IsKeyPressed` / `Input.UnregisterKey` | Numeric Windows virtual-key code; xScal requires Boolean success, ZFE has compatibility reply decoding | Physical key detection/navigation; no ControlMap lock |
| ZFE `input.v1.*` | JSON owner/session payloads | Diagnostic owner-scoped capture; not selected for FCM's visible editor |
| xScal `Input.BeginInput` / `PollInput` / `EndInput` | No begin argument; numeric session ID for poll/end; bounded JSON replies | Native text capture and editing on the tested 0.2.18 provider |
| `SharedHUDTools.TextEdit` / `EndTextEdit` | Host method and callback | Visible host editor and its balanced ControlMap lock |

The same corrected BA2 passed the 75-case Ruffle suite for both providers. In the local
controller-active trial, the tester reported that physical Insert, `MIW` typing without a
controller keyboard, inactive map/movement while editing, and Escape recovery worked on both
ZFE 0.15.0 and xScal 0.2.18. The ZFE log recorded off-screen keyboard placement and host-field
focus in its initial run; the xScal log recorded provider selection, a physical Insert edge,
and `invalid_session` release confirmation. This is evidence for those tested artifacts, not
a blanket guarantee for other extender or HUDModLoader versions.

The fresh Windows laptop test on 2026-09-25 used xScal 0.2.18, HUDModLoader v70,
and the exact 2.10.129 keybind diagnostic BA2. `openKey=PERIOD` registered as
VK 190 and reached FCM twice, but both native begins returned
`input_unavailable`; there was no FCM-owned session or uncertain release.
Typing still failed. The complete 78-case Ruffle suite, including ZFE editor
and rebind flows, passed before installing that BA2. Ruffle exercises the
caller contract; the Windows result shows that xScal's native refusal still
requires provider-side diagnosis.

The follow-up `xscal-native-begin-probe-2` BA2 also failed on the laptop:
`BeginInput` returned `input_unavailable` both while Period was held and
78–80 ms after release on two separate presses. No xScal session was accepted.
This rules out a simple key-release timing fix for that run. The public native
reply gives no reason beyond `input_unavailable`.
An independent interactive-session probe captured three more Period presses
while Fallout 76 remained the foreground process and the same HWND/window-owner
thread throughout. The corresponding native begins were still refused. This
removes a simple focus-loss explanation for that run, but does not identify
the xScal callback thread or its internal refusal branch.

The exact public `dxgi.dll` installed on the laptop (SHA-256
`78cb91d6e9e53bcf97f55dd82a60931aec94cc4cc2b6dc74da198d6b9dd311e4`)
has a `BeginInput` handler at RVA `0x26728`. It returns the same
`input_unavailable` string after either a failed native begin helper (RVA
`0x28a70`) or a failed initial snapshot helper (RVA `0x28bc0`). The begin
helper rejects a nonzero active session, missing/foreign foreground HWND,
`SetWindowSubclass` returning false, or a different previously subclassed
HWND. Its foreground helper (RVA `0x28294`) calls `GetForegroundWindow`,
`GetWindowThreadProcessId`, and `GetCurrentProcessId`. The laptop's actual
`comctl32.dll` exports the imported ordinal 410 as `SetWindowSubclass`; 412
and 413 are `RemoveWindowSubclass` and `DefSubclassProc`. These are static
binary observations, not a live trace through a specific refusal. The
foreground probe makes subclass failure the leading hypothesis for the
laptop, but an xScal callback thread ID or native branch code is still needed
to prove it. The fresh-session path clears the initial text before making its
snapshot, so snapshot failure is unlikely without a race or corruption.
The failure jump after `SetWindowSubclass` does not capture `GetLastError`
or emit a native diagnostic, so the existing log cannot supply the missing
return value.
[Microsoft's `SetWindowSubclass` contract](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/nf-commctrl-setwindowsubclass)
forbids cross-thread subclassing.
