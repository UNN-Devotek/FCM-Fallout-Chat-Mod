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

- **FCMHUD/1** ([../realtime-socket.md](../realtime-socket.md), [../two-way-chat-implemented.md](../two-way-chat-implemented.md))
  is FCM's *own* line protocol (`color~channel~user~content` + M7 `HELLO/SEND/CHAN` verbs) riding
  ZFE's **generic** socket bridge, driven by FCM's custom `FCMBridge.swf`. FCM defines the wire
  format and ships the SWF.
- **`chat.v1`** (this folder) is a protocol **ZFE itself defines and drives** through its native
  chat client. A compliant relay needs **none** of FCM's custom SWF or wire code — just the JSON
  contract.

The strategic upside of `chat.v1`: FCM stops maintaining a bespoke SWF + wire format and keeps only
a compliant relay. The two can run in parallel during transition (both are additive front-ends onto
the same backend services). See
[fcm-integration.md → How this differs](fcm-integration.md#how-this-differs-from-the-existing-fcmhud1-bridge)
for the full side-by-side and the deprecation question.

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
