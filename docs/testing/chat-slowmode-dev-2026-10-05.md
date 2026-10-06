# Shared slowdown — hosted Dev acceptance, 2026-10-05

Tested the uncommitted slowdown candidate based on `86a363f438ded2b88505f508c6e1d29550c51332`
in the isolated hosted Dev environment. Backend archive SHA-256:
`609c79ad04b655084547362421c6d0779af9aaefb879d1843d3ac6d6a291a088`.
Running backend image: `sha256:42b1e39df6c289e154ac7c155f08ba3b9387a3a11646e6960a68b25cd6cf5461`.

Only `backend-dev` was rebuilt/recreated in the existing Compose project,
with `--no-deps --pull never`. Storage/tunnel containers stayed running.
The customized Compose checksum stayed
`193c6f88e4d113bc4f68d9e4531f567fa369be2296138ad74b176c74d90025b7`.
Rollback image: `fcm-dev-backend:pre-slowmode-20261005`.
Health reported connected database, Redis and Discord.

The unpackaged Linux Electron overlay used an isolated staged copy and
`/home/devotek/.fcm/hosted-dev`, pointed at `dev.falloutchatmod.com`.
Its test version was set to the existing active QA version `1.4.0` in that
staged copy only. The repository version and server build lock were unchanged.
Initial synthetic-persona checks were followed by the normal QA Discord OAuth
flow with the signed-in human account for the shared-client test.
No production processes, installs or data were changed.

## Observed results

- Discord human messages: three accepted in a rolling minute; fourth (`SD4`)
  deleted and absent from relayed history. The bot sent its cooldown notice in
  the user's direct message conversation, not the channel.
- Electron overlay: fourth attempt returned private `rate:status` with
  `retryAfterMs: 35000` and displayed “You are in cooldown. Please wait 35 seconds
  before sending another message.”
- Switching the overlay from General to Trading did not escape cooldown.
  A retry 15.416 seconds later returned `retryAfterMs: 19593`, proving that it
  did not restart the cooldown. A subsequent post after expiry succeeded.
- Real linked account: three overlay Trading messages
  (`SLOWMODE-SHARED-20261005-1` through `-3`) were accepted. Its fourth attempt
  in Discord General (`SH4`) was deleted. Discord sent another private
  35-second DM. An immediate overlay retry received `retryAfterMs: 34823`,
  sharing the cooldown initiated by Discord.
- Reverse direction: three human Discord Trading messages (`RV1`–`RV3`)
  were accepted; the fourth attempt in overlay General returned a private
  35-second cooldown instead of publishing. A subsequent Discord General
  retry (`RV5`) was deleted and received a private 10-second remaining-time DM.
  Dev database verification found `RV1`–`RV3` under the same account ID as
  the three overlay messages, with no rejected fourth/retry rows. After
  expiry, Discord `RV6` appeared in the overlay and exactly once in the database.
- Read-only Dev database verification found exactly those three shared test
  messages, no `SH4`/`SD4` or rejected shared retry, and zero public message
  rows beginning “You are in cooldown.”

Test messages remain in Dev as acceptance evidence. This is live Discord and
Linux Electron verification; it does not certify packaged Windows or native
in-game HUD acceptance. HUD private-notice behavior has separate automated
ZFE/xScal Ruffle coverage.
