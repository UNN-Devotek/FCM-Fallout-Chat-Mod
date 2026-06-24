# ZFE Native Chat Relay (`chat.v1`)

A future ZFE update ships a **first-class native chat client** inside Fallout 76 with a
**standardized, relay-agnostic JSON-over-WebSocket contract**. This sub-topic captures (1) that
upstream contract verbatim-in-substance, and (2) a design proposal for making FCM's existing relay
speak it.

> **Status: forward-looking.** The protocol is an **upstream spec for a not-yet-live ZFE update**;
> the FCM integration is a **design proposal**, not shipped code. Treat both as planning references.

## Contents

| Doc | What it is |
|---|---|
| [**protocol-spec.md**](protocol-spec.md) | The upstream ZFE `chat.v1` relay contract — SWF flow, packaged config, the full WebSocket op set (`register`/`hello`/`send`/`poll`/`subscribe`/`report`/`moderationAction`), channels, limits, identity/bans, the loopback test |
| [**fcm-integration.md**](fcm-integration.md) | How FCM's backend would expose a compliant `/relay` endpoint — op→service mapping, identity/token bridge, channel mapping, the net-new monotonic cursor, error-code mapping, permissions, phased rollout, tests, open questions |

## How this differs from the existing FCMHUD/1 bridge

FCM **already** ships in-game chat — but via a **bespoke** path, not this standard:

In both cases **FCM owns the in-game chat UI — our own SWF.** What changes is the *plumbing*:

- **FCMHUD/1** ([../realtime-socket.md](../realtime-socket.md), [../two-way-chat-implemented.md](../two-way-chat-implemented.md))
  — our SWF rides ZFE's **generic** socket bridge and does its own networking + a *bespoke* line
  protocol (`color~channel~user~content` + M7 `HELLO/SEND/CHAN`). FCM defines and maintains the wire.
- **`chat.v1`** (this folder) — a protocol **ZFE itself defines and drives**. ZFE provides the native
  chat **engine** (transport, token, reconnect, input); **our same SWF** just calls the `chat.v1.*`
  API and renders. FCM stops maintaining a custom wire/transport, **not** the UI.

**Decision (re-sequenced 2026-06-24): ship on FCMHUD/1 now; `chat.v1` is a *later* transport swap.**
Because ZFE's chat.v1 publish date is unknown, FCMHUD/1 (which we own and works today) is the **active
shipping transport** for the in-game HUD mod (epic #302; prod exposure #139). `chat.v1` supersedes it
**later** — a wire swap, with the feature layer (commands, customization, server chat) built
transport-agnostic so it carries over unchanged. FCMHUD/1 retires (#291) **only after** chat.v1 ships
AND is validated. The in-game chat SWF (the UI we built) is kept either way. See
[fcm-integration.md → How this differs](fcm-integration.md#how-this-differs-from-the-existing-fcmhud1-bridge).

## At a glance — the integration shape

```
ZFE native chat SWF ──(chat.v1 JSON)──▶ NEW /relay adapter ──▶ existing FCM services
                          wss://…/relay      (proposed)           ingestMessage / moderation /
                                                                  channels / Redis pub/sub / ws_rate
```

The adapter is a **thin translation layer**. The only net-new infrastructure is a **durable
monotonic cursor** (for `poll`/`subscribe` dedup) and a **persistent relay token** identity; every
other concern reuses an existing FCM service. FCM's custom channels (Events / Raids / Infests) are
carried by ZFE's **`AllowedChannels`** config — no protocol gap. Full detail in
[fcm-integration.md](fcm-integration.md).

## See also

- [../README.md](../README.md) — ZFE / FCMBridge integration index
- [../../../realtime/README.md](../../../realtime/README.md) — FCM's `/ws` relay protocol, presence, pub/sub
- [../../../backend/README.md](../../../backend/README.md) — REST API, services, auth model
