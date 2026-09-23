# Retire the legacy HUD transport

The legacy `GET /api/game/hud-feed`, `/ws/hud`, and TCP 4001 listeners are removed
from the backend. The visible widget continues to use native `/relay`. The optional
Server bridge continues to read provider-scoped local exports and publish through
the desktop overlay's authenticated `/ws` connection. The active `FCMHUD/1;...`
native metadata carrier is unchanged. Historical `hud_identity_blocks` records
and historical message source values remain in the database.

Deploy to Hosted Dev first. Remove the remotely managed Cloudflare tunnel route
`dev-hud.falloutchatmod.com → tcp://backend-dev:4001` when applying the updated
compose file. Retire the old HUD TCP certificate/key and identity-secret values
from the Hosted Dev deployment configuration after the backend is healthy.
Confirm:

- `GET /api/game/hud-feed` returns 404.
- `/ws/hud` upgrades are rejected and port 4001 is closed.
- Native `/relay` and authenticated `/ws` still connect.
- The visible HUD and Server bridge share canonical rooms and history across
  HUD/ZFE ↔ bridge/ZFE, HUD/ZFE ↔ bridge/xScal, HUD/xScal ↔ bridge/ZFE,
  HUD/xScal ↔ bridge/xScal, HUD↔HUD, and bridge↔bridge.

Run backend, overlay, dashboard, and full Ruffle CI gates before deployment.
Complete manual two-client native acceptance after the Hosted Dev deploy.
Production deployment is a separate approval step. Repeat the endpoint and
native/Server checks after Prod deployment; roll back the backend deployment
if current clients regress.
