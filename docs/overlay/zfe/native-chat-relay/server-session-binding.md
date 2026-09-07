# SERVER session binding — widget v2.10.58

The desktop ZFE log for 2026-09-05 20:03–20:04 records v2.10.56 on a public world:
roster sends contained zero names, SERVER was selected with zero rows, and the widget logged
an acknowledgement before the native network request completed. This confirms native acceptance
was being mistaken for a relay binding. A regression also reproduced solo rooms retaining the
same key across LEAVE and a fresh roster, exposing old-world history after a hop.

## HUD observations

The shared xScal/ZFE widget reads only the game's exposed BSUIDataManager data. In addition
to the existing player/team/voice lists, it reads `MapMenuData.MarkerData` entries with
`markerType == "PlayerRemote"` and their `text`, and `PublicTeamsData.publicTeams[].members[]`
with `playerName`. It removes local names and title decorations and sends at most 24 names.
Non-player map markers are excluded. These interface shapes came from static interoperability
inspection; fresh logs must establish when they populate in the current game build.

`MenuStackData.menuStackA[].menuName == "MainMenu"` clears SERVER, sends LEAVE and resets
the session nonce. HUD recreation, a roster boundary, and reconnect also reset the nonce.
The widget logs provider counts and the opaque confirmed room key, never roster names.

## Protocol

Existing `FCMCTL/1/ROSTER`, WORLD and LEAVE bodies remain compatible. A new widget includes
`targetUserId: "FCMSESSION/1;<requestId>"` on ROSTER/WORLD controls. The request ID is bounded
to 1–64 lowercase alphanumeric/hyphen characters, identifies a HUD session, and is not an
authentication credential. The existing relay token remains the actor identity.

The relay stores the request ID with the roster. New/missing rosters or a changed request ID
receive a fresh server-generated session UUID; keepalives retain it. A connected component's
room uses the root member's session UUID rather than their permanent user ID. Legacy roster
entries lacking session metadata are replaced on their next heartbeat. Store failures propagate
instead of returning a successful membership acknowledgement.

After storing and rebinding membership, the relay sends a normal system `chat.message`:

```text
channel: system
senderUserId: system
body: FCMCTL/1/SERVER-READY:<requestId>|<roomKey>
```

This confirmation precedes the room's replay rows, including for an empty room. Rebind pub/sub
includes the request ID and source instance; other instances deliver the confirmation/replay to
their local subscribers. Local loopback is ignored. The widget intercepts this system control
before link-notice rendering and accepts only its current request ID. Native RPC acceptance is
logged as acceptance, never as proof of delivery. Pending binds retry every 10 seconds; confirmed
sessions refresh every 30 seconds and lose readiness after 60 seconds without confirmation.

The widget holds up to 64 early server rows until confirmation, then validates them before
rendering. This preserves live rows that arrive during the history read. It requires canonical message IDs prefixed
with `server:<confirmedRoomKey>:`. An outgoing SERVER message carries
`targetUserId: "FCMROOM/1;<confirmedRoomKey>"`; the relay rejects it if current membership differs.
These fields are control metadata, not whisper recipients. Legacy clients without these fields
retain their original protocol behavior.

## Limits and validation

This is **roster-derived grouping, not an authoritative Fallout server ID**. The inspected HUD
account data has no unique world ID. Mutual sightings are required to join two FCM users;
missing or unpopulated rosters can therefore leave same-world users in separate solo rooms.
Stale UI data remains a runtime concern. A solo room means no confirmed matching FCM user,
not an empty Fallout world. Cluster membership changes can change the ephemeral room key;
history continuity is not guaranteed after the last FCM participant leaves.

Automated tests cover both adapters, map/team shapes, main-menu detection, delayed confirmation
rejection, expiry, old-room row/send rejection, empty-room confirmation, replay order, solo hops,
storage failures and mutual-sighting isolation. They run in the existing Haxe and backend CI jobs.

For live acceptance, test two linked FCM users on the same public world, first before and then
after opening the map. Check that both report nonzero roster names and the same confirmed room,
then exchange SERVER messages. Move one user to another world twice: room keys must separate,
old rows must disappear, and neither user may receive the other's new SERVER messages. Repeat
with each extender. General/Trading/Events/Infests/Raids should retain static history throughout.
Deploy the updated Dev backend before installing v2.10.58; an older relay cannot confirm its tab.
