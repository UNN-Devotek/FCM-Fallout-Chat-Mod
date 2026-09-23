# Proposal: xScal Browser Links v1

Status: **proposed maintainer handoff; not implemented in xScal or enabled in FCM**.
Prepared 2026-09-18 against public upstream commit
[`2c073777b8399960122c4971694f5b6e8be2a8ba`](https://github.com/DCHoaxer/xScal/tree/2c073777b8399960122c4971694f5b6e8be2a8ba).
This proposal concerns a sanctioned extender API, not a change to FCM's desktop overlay or a
request to add another injected component. FCM must never launch through shell scripts, the relay,
another provider, or Flash navigation when this service rejects a request.

## Evidence and gaps

[Confirmed] Upstream's
[callback table and runtime handler](https://github.com/DCHoaxer/xScal/blob/2c073777b8399960122c4971694f5b6e8be2a8ba/src/api/scaleform_callbacks.cpp)
register `GetXSRuntimeInfo`; that handler returns JSON with `runtime`, `version`, and `platform`.
It does **not** currently return `success` or a browser capability. The public tree is not proof of
the interfaces shipped in a separately maintained xScal chat build.

[Confirmed] The
[callback registry](https://github.com/DCHoaxer/xScal/blob/2c073777b8399960122c4971694f5b6e8be2a8ba/src/api/callback_registry.hpp)
supports Boolean/string return values. `ScaleformCall` carries argument storage, count, and result,
with no verified player-action or originating-UI identity. The
[native handler](https://github.com/DCHoaxer/xScal/blob/2c073777b8399960122c4971694f5b6e8be2a8ba/src/scaleform/native_handler.cpp)
decodes the first argument as the callback name and dispatches synchronously. Existing callbacks
read their data argument at index 1. The
[bridge construction](https://github.com/DCHoaxer/xScal/blob/2c073777b8399960122c4971694f5b6e8be2a8ba/src/scaleform/bridge.cpp)
already works with `MovieRootContext`.

[Deduced] JSON request/response callbacks fit this transport, but a simple callback invoking
`ShellExecute` is insufficient. Trusted movie/UI lifetime and actual input provenance must reach
the service through native-owned context. A mod-supplied `isUserAction`, movie ID or timestamp
cannot establish authority. The existing callback registry's global userData is not per-call UI identity.

[Confirmed] [runtime shutdown](https://github.com/DCHoaxer/xScal/blob/2c073777b8399960122c4971694f5b6e8be2a8ba/src/runtime/runtime.cpp)
restores the controller. Browser-service cleanup would need to be integrated into that lifecycle
and into individual movie/UI teardown, with no worker retaining destroyed GFx objects.

## Proposed API

Expose these methods on xScal's positively identified general dispatcher, independently of
`chatInterface`. Do not rename existing callbacks or make browser support a chat requirement.
Suggested AS3 call shape:

```actionscript
var info:Object = JSON.parse(String(api.call("GetXSRuntimeInfo")));
// Require runtime == "xScal", success === true and exact "xscal-browser-v1" capability.
var action:Object = JSON.parse(String(api.call("browser.v1.beginAction",
    JSON.stringify({url:"https://fallout.wiki/wiki/Fallout_76"}))));
// Only from a genuine local activation; validate success and opaque actionId first.
var result:Object = JSON.parse(String(api.call("browser.v1.request",
    JSON.stringify({actionId:action.actionId,url:"https://fallout.wiki/wiki/Fallout_76"}))));
```

Extend runtime JSON additively with `success:true` and `capabilities:[...,"xscal-browser-v1"]`
only after implementation and native acceptance. Retain existing runtime/version/platform fields.
Use the same verb names, JSON fields, limits, states, errors and ownership semantics as the
[supplied ZFE browser-v1 contract](../../../overlay/zfe/zfe-browser-links-v1-author-spec.md), with xScal-specific discovery
and configuration paths. Consumers validate types, not truthy strings, and branch on codes, never
messages. A browser callback has exactly one string payload after its name; reject extra arguments.

| Method | Payload | Result |
| --- | --- | --- |
| `browser.v1.beginAction` | Exactly `{url}` or `{origin}` | `{success:true,actionId,expiresInMs:15000}` |
| `browser.v1.request` | Exactly `{actionId,url}` | `{success:true,requestId,state,terminal}` |
| `browser.v1.poll` | Exactly `{requestId}` | Stable request snapshot |
| `browser.v1.cancel` | Exactly `{requestId}` | Cancelled snapshot, immutable terminal snapshot, or `cancel_too_late` |

No permission setter, arbitrary executable, browser selector, navigation target, callback URL,
or command-line argument is exposed. `beginAction` never prompts or launches.

## Native service and ownership

Implement a dedicated `BrowserService` with pure URL/policy/state modules and injectable clock,
consent, persistence and OS-dispatch interfaces. Suggested new files live under `src/browser/`;
register thin adapters in `src/api/scaleform_callbacks.cpp`, add them to CMake, and pass a trusted
owner context from the existing native handler/bridge lifecycle. These paths are proposals.
Do not copy unrelated existing unrestricted file-writer callbacks as a security boundary.

Before advertising the capability, establish a sanctioned, native-verifiable link between actual
mouse/keyboard/controller activation and the specific originating UI flow. A received event,
script call, relay result, focus alone, or polling timer is insufficient. Native integration must
support FCM's HUDModLoader shared editor and any supported native text-input completion route;
if provenance cannot be verified, return `user_action_required`, including in `allow_all` mode.
The precise input integration is an implementation prerequisite, not something proven by the
public callback code. Do not solve it by adding game-memory reads or a separate injector.

Use native-owned, unforgeable owner and generation handles for game lifetime, movie, bridge and
originating UI. The parent HUD movie alone may outlive a child widget: child removal/replacement
must invalidate its authority. Do not trust an AS3-declared owner token without native binding.
Generate opaque unpredictable action/request IDs; never persist or transfer them. Invalidate on
UI removal, bridge replacement, reconnect or external foreground loss before dispatch. Losing
focus to the service's own consent dialog is allowed. Editor close after normal submission is
not equivalent to removing its owner. Focus return never replays work.

One UI flow has at most one unused action, at most four exist globally, and they expire after
15 seconds. Repeat admission for the same physical activation/scope returns the same ID without
extending it; changed scope conflicts. Held keys cannot create fresh activations. A later genuine
activation replaces that flow's unused action. Immediate actions bind byte-for-byte URL text;
deferred actions bind a normalized origin. FCM may request a deferred result only when locally
correlated to the originating command within that expiry. All other results remain readable links.

Accept and consume an action atomically. Capacity, validation, binding and rate rejections do not
consume a valid unused action. Once accepted, denial/failure/expiry/cancellation never restore it.
An identical action+URL request during retention returns the same snapshot; changed URL conflicts.
After forgetting an action, never interpret its old ID as new authority.

## URL validation and dispatch

Require strict JSON, reject unknown/duplicate fields and wrong types, and enforce 32768 UTF-8
bytes per JSON payload and 4096 per decoded URL. Parse absolute HTTPS with effective port 443.
Reject userinfo, IP literals including unusual numeric forms, single-label/local hosts, malformed
ASCII/Punycode DNS names, trailing dots, controls, direction-control characters, backslashes,
malformed escapes, other protocols and ambiguous authorities. Do not repair, truncate or upgrade.
Canonical origin is lowercase `https://` plus validated lowercase host, omitting default port and
root slash. Subdomains are distinct. Preserve accepted path, query and fragment exactly.

Run confirmation, filesystem persistence and OS dispatch away from the Scaleform frame. Never
block native callback processing waiting for a player, disk, network or OS shell. Worker results
are plain immutable data; publish snapshots safely on the service side without calling GFx from
worker threads. Define cancellation versus dispatch with a single synchronized transition and
recheck owner generation, foreground, mode, policy and deadline immediately before dispatch.
Release initiating held controls before OS handoff, balancing only the owned input session.

Use the Windows registered default browser via a validated URL shell association (for example
`ShellExecuteExW` with fixed `open` verb, URL as `lpFile`, no command parameters). Never run a
command shell or executable from input and never alter browser preference. Bound unresolved OS
work: after 10 seconds publish immutable `launch_unknown`; retain the unresolved dispatch lock
until completion even when the public record expires. A late result cannot rewrite the snapshot.
`handed_off` means OS acceptance only. Permission covers the initial destination, not redirects.

## Bounded state and errors

Nonterminal states: `accepted`, `pending_confirmation`, `launching`. Terminal states:
`handed_off`, `denied`, `cancelled`, `expired`, `failed`, `launch_unknown`.
`success:true` means API success, including failed terminal snapshots with an `error` object.
Immediate errors use `{success:false,error:{code,message}}`.

One active request globally, no queue; overlaps return `busy`. Throttle until five seconds after
the later of acceptance or dispatch start; cancel does not reset it. Pre-dispatch requests expire
30 seconds after acceptance, including time in confirmation. Retain immutable terminal snapshots
60 seconds; capacity 16 total records, rejecting new work rather than evicting retained records.
Poll no faster than 250 ms. Wrong-owner, expired-retention or unknown request IDs return
`request_not_found`, which cannot prove whether opening occurred.

Use the ZFE error set: `invalid_request`, `invalid_url`, `user_action_required`, `invalid_action`,
`action_expired`, `action_conflict`, `disabled`, `busy`, `rate_limited`, `unavailable`, `no_browser`,
`launch_failed`, `request_not_found`, `cancel_too_late`. Rate limits include positive integer
`retryAfterMs` without authorizing retries. Cancellation before dispatch dismisses the prompt;
once launching it cannot promise prevention. Terminal cancellation returns the original snapshot.

## Permissions and configuration

Proposed xScal paths (confirm with maintainer before release): global `[BrowserLinks]` and
`[BrowserLinks.Sites]` in the player's existing `xscal.ini` beside the executable; author defaults
in `Data/xScal/BrowserLinks/fragments/<HMLModName>.ini`; player decisions under resolved Windows
Documents `My Games/Fallout 76/xScal/BrowserPermissions/<installation-id>.json`. Do not read or
modify ZFE permission files. Resolve redirected/OneDrive Documents and stable installation identity.

Adopt the ZFE contract's modes `off`, `ask`, default `remembered`, and explicit player-only
`allow_all`, plus `UseModDefaults=true` by default. In `ask` and `remembered`, session blocks from
failed saves precede player JSON, then global site rules, then active fragment allowances, then
ask. `ask` prompts even for allowed sites; `off` rejects; valid explicit `allow_all` overrides site
rules including blocks while preserving all validation and action requirements.

Accept only exact-origin `allow` from fragments matched to active HUDModLoader entries; fragments
cannot set mode, disable defaults or weaken validation. Limits: 16 KiB/128 origins per fragment,
64 active fragments and 1024 unique fragment origins globally. Invalid browser section contributes
no allowances from that file; aggregate overflow disables fragment allowances for the launch.
Unsafe/ambiguous/inactive mod names contribute none. Preserve unrelated settings. FCM's proposed
bundle is [the disclosed origin list](../../../overlay/zfe/browser-links.md#configure-site-allowances); names are
configuration selectors, not authentication. Defaults may affect other supported mods that session.

Player JSON contains schema version, installation ID and exact-origin `allow|ask|block` rules;
no browsing history or full URLs. Normalize before duplicate detection. Load files at launch;
manual edits apply on restart, successfully saved consent immediately. Atomic saves must not
clobber an externally edited file. Invalid/unreadable/mismatched player files suppress inherited
automatic allowances for that launch, retaining known global blocks. Invalid global modes fall
back to ask; invalid/duplicate UseModDefaults disables defaults. Invalid/duplicate site values
become ask rather than falling through to fragments; unparseable browser-site sections suppress
inherited automatic allowances. Valid explicit allow_all remains independent of rule-file failures.

Consent presents canonical host prominently, complete literal URL, permission-file location and
remaining decision time. Cancel is default; Escape/close cancels without changing rules. Wait for
initiating controls to release before a separate approval. Remembered mode offers Open once,
Always allow, Block and Cancel; ask mode omits Always allow. Failed allow persistence cannot grant
permanent approval: explain and offer an explicit Open once. Failed block persistence still blocks
that origin for the session and explains it will not survive restart. Never relocate or overwrite a
corrupt policy. Removing a rule restores inheritance; use ask to revoke a bundled allowance.

## Acceptance and FCM follow-up

Unit-test parser fuzz/boundaries, normalization and byte-preserving requests, every precedence
combination, malformed/duplicate files, save races/failures, monotonic deadlines, immutable terminal
states, cross-owner rejection, replay/idempotency, overlapping calls, dispatch/cancel race and late
OS completion. Fake clock/files/dialog/shell enable deterministic tests; never open a browser in CI.
Run address/thread sanitizers where supported and verify no GFx calls from worker threads.

Use the full deterministic matrix in the supplied ZFE document, adapted only for provider discovery
and paths. Add Steam/Game Pass and fullscreen/windowed/borderless native checks with keyboard,
mouse and controller. Include two mods/child movies, unload/reload, reconnect, external focus loss,
held Enter, cancelled editor, unknown capability, no default browser and a stalled OS response.
Do not publish the capability while native action provenance or UI lifetime remains unverified.

After the maintainer ships and accepts the API, a separate FCM change can add xScal browser
discovery on its general callback, preserve xScal chat priority, map discovery to the shared
request client, package the xScal fragment and add native/provider tests. Do not probe nonexistent
browser methods or fall back to ZFE from an xScal-selected session. This task implements no
xScal native code and enables no speculative xScal browser API.
