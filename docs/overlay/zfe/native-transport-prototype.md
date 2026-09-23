# Local xScal native transport prototype

Status: experimental source and local test build. No production deployment or native acceptance.

The storage diagnostic measured 927 ms around a synchronous xScal save while later sampled saves
took 11–12 ms. This prototype tests an FCM-only alternative: a single discovery capsule write,
then roster snapshots through the existing xScal `chatInterface.sendMessage` route. It does not
change xScal, use raw SWF sockets, or read memory. The first capsule save can still stall.

## Explicit scope

This is an opt-in deviation from the published file-only bridge architecture. Production behavior
remains file-only. The native prototype requires `bridge_native_prototype` and `bridge_dev` at
compile time. The backend requires `FCM_NATIVE_BRIDGE_PROTOTYPE=1` and nonproduction NODE_ENV;
the desktop requires the same flag, an unpackaged app, and a localhost relay HTTP endpoint.
Do not deploy, publish, or install over the current production setup as part of this experiment.

The first prototype deliberately requires a pre-existing xScal native identity linked to the same
local development account as the desktop. It neither auto-registers nor implements a new sign-in
screen. The existing native identity is an observation source, not the desktop session authority.
Before a native test, establish an isolated local test identity without overwriting production
provider credentials. Native credential isolation has not yet been demonstrated for this machine.

## Flow

1. The invisible child generates a per-movie `np-` session nonce. After native authentication it
   writes `{schemaVersion:"native-prototype-1", environment:"dev", provider:"xscal", sessionId}`
   once to the existing dev export path. No account credential or roster is in that capsule.
2. Existing bridge observation/freshness logic generates snapshots. The prototype wraps each with
   a send timestamp and sends a reserved `FCMCTL/1/NATIVE-PROTOTYPE:` control on native `server`.
   The native relay intercepts it before chat persistence, publication, or native room membership.
3. The local backend validates the native token and linked account, size, provider, environment,
   sequence, age and clock bound. Two advancing observations are needed for initial pairing.
4. The desktop main process reads exactly one bounded capsule, without following symlinks, and
   requests `bridge:native-pair`. Renderer IPC cannot submit this request or observations.
5. The authenticated in-game desktop claims that exact session only if its account matches. One
   socket owns the claim. No account-wide search or fallback is involved.
6. The backend feeds snapshots into the existing LocalExportBridge coordinator. Membership,
   history, moderation, exactly-once delivery and stale confirmation rules remain there.
   Main-process-only metadata precedes ready/history frames; names never enter that metadata.

The source rendezvous is deliberately process-local and capped at 64 movie sessions until
restart. It is not suitable for replicated deployment. Sequence watermarks persist in memory;
expired observations need two new advances to pair again. Account changes, revocation, socket
replacement, game exit and observation expiry clear ownership or deny admission. Credentials
are rechecked during consumption as well as ingestion. Ordinary leases do not renew observation age.

Transport queuing time and a two-second forward-clock allowance are included in observation age.
Future timestamps beyond two seconds and observations at least 30 seconds old are rejected.
Clock synchronization is a prerequisite, not something the client silently compensates for.

## Build and local validation

From `game-mods/FCMBridge/hudmodloader-bridge`:

`python3 package.py --target dev --native-prototype --output /path/to/FCM-native-prototype.zip`

Run `haxe test-state.hxml`, `haxe test-export.hxml`, package/source checks, the full simulator suite,
backend Jest and overlay/dashboard unit suites before installation. Existing CI discovers the new
Jest/Vitest suites, the export suite invokes the pure native transport checks, and the complete
Ruffle suite exercises the exact packaged child. The package rejects a production target.

The package's INSTALL.txt covers the local endpoint, flags and rollback.
For the local backend, use `FCM_NATIVE_BRIDGE_PROTOTYPE=1 NODE_ENV=development npm run dev`
from `backend/` after configuring local-only dependencies and port 7177.
For the desktop, run `npm run build:renderer` from `cross-platform-overlay/`, then:

```sh
env -u ELECTRON_RUN_AS_NODE -u RENDERER_URL \
  FCM_NATIVE_BRIDGE_PROTOTYPE=1 RELAY_HTTP=http://localhost:7177 \
  RELAY_WS=ws://localhost:7177/ws \
  ./node_modules/.bin/electron --user-data-dir="$HOME/.fcm/native-bridge-prototype" \
  . --ozone-platform=x11
```

This uses a separate desktop profile. It does not isolate xScal credentials automatically;
establish that isolation before changing the provider endpoint. Do not use the existing
`dev:local` launcher for this experiment because its endpoint defaults differ.

Validation on 2026-09-22: complete backend Jest passed (128 suites, 1654 tests, 9 skipped)
with isolated test Redis and clean test configuration; complete Ruffle passed (70 tests);
overlay passed (1281 tests), followed by the updated four-test prototype suite; dashboard
passed (475 tests). Haxe state/export/native checks, package checks and TypeScript build
also passed. Native credential isolation and hitch/room acceptance remain pending.

Keep Improved HUD, xScal and HUDModLoader fixed during comparisons. Confirm capsule mtime stays
fixed after startup while roster traffic advances. Require F10, raid transitions, a real world hop,
Main Menu, overlay reconnect and two-client message/history acceptance. Ruffle tests do not prove
native send latency, native auth isolation, or that game hitches are eliminated.

## Before this could become a product feature

Native acceptance must establish actual method latency and queue behavior. Replace the local-only
rendezvous with coordinated bounded state before any replicated deployment. Design onboarding
that preserves overlay-owned authentication without requiring a prior visible HUD install. Review
credential isolation, endpoint switching, clock skew behavior and replay recovery with native
evidence. The experiment is not permission to change production account linking or room rules.
