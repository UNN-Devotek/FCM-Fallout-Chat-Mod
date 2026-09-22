# Overlay channel layout and bridge review

Status: local implementation; scoped regression checks pass, full backend and native
acceptance remain incomplete. No installation,
deployment, commit or push. Native Windows/Linux acceptance and CPU/frame-time
measurements remain pending.

## Desktop channel preferences

Fresh/reset settings show **all available channels**. General → Server → Trading is
the default order; Server remains absent until the existing backend-confirmed bridge
state supplies it. Users may reorder it. No website/dashboard/HUD controls change.

Drag channel tabs within their parent, or right-click for Hide channel, Set as default,
Move left/right and Channel layout settings. Shift+F10 opens the menu from a focused
tab. Escape cancels; a drop commits. Tab buttons are not window-drag handles.

Settings → Appearance → Channel layout and hidden channels opens visibility checkboxes and a
default selector, including Server while unavailable. The sub-tab row's ellipsis
opens the same panel. Selecting a hidden default explicitly makes it visible.
Reset shows all channels, clears custom order, and restores General/first-visible
startup. The panel also offers the combined feed, including when all tabs are hidden.

Hiding excludes messages from the combined feed, not ingestion, retained history,
room membership or authorization. Navigation skips hidden channels. Existing explicit
hidden-channel settings are imported for the first account on that backend when no
account-scoped record exists. A migration-owner marker prevents another account from
inheriting those legacy choices; subsequent accounts start with all channels visible.

Preferences use `fcm-subtabs-v1:<encoded backend origin>:<encoded account ID>` in local
storage, with version, per-parent ordering, hidden keys and default key. No token is
stored. Server uses a logical `server` key rather than a room ID. Unknown newly added
channels remain visible and append after saved ordering. Storage failure falls back
to in-memory operation. No preference synchronization API was added.

Startup selects the default once. Default Server waits on General/first visible and
switches on unavailable → available transitions, not heartbeat/history refreshes.
Existing world-hop following is preserved when already viewing Server. Hiding an
explicit default selects General and unhides it; hiding General instead uses the
first visible channel, then the combined feed when none remain.

## Review boundary and findings

The review traces `FcmBridgeExport`/`FcmBridgeStorage` → local file reader → main-process
`LocalBridgeRelay` → authenticated WebSocket handlers → `LocalExportBridge` →
`BridgeConnection` and canonical room/publication services.

- Confirmed privacy issue corrected: the generic chat-send receipt log included
  account/name, destination and the first 32 message characters before authorization.
  It now records only content length. This is data minimization, not a demonstrated
  unauthenticated log-read exploit. A regression guard checks the diagnostic fields.
- Desktop bridge controls require the current header-authenticated socket; browser
  tickets and public/admin-observer sockets cannot submit bridge observations.
  Backend resolution checks session ownership, ban/kick state and current socket
  generation. Room/binding matches are rechecked before history delivery and sends.
- Exports have a strict 8 KiB schema, at most 24 roster entries and 64-character
  names. Unknown fields (including credentials and requested room IDs) are rejected.
  Files are bounded asynchronous reads with path/symlink, file-type and before/after
  descriptor checks. Main-process renderer controls cannot inject observations.
- Writer advancement, observation age, retired generations, game lifetime and
  logout/replacement invalidate stale authority. Heartbeats cannot renew evidence.
  Observation requests are account-limited to 12 per 10 seconds; watch requests to
  4 per 10 seconds. Connection work queues are bounded at 128 entries.
- The common rate-limit helper currently fails open on Redis errors; room ownership
  and authorization still depend on successful Redis operations. This is a review
  limitation, not evidence that failed Redis grants membership.

**Residual trust limitation:** authenticated users control their local client and
export. These files are not attestation of genuine gameplay or world membership.
Mutual roster matching reduces accidental cross-world assignment but cannot prove
honesty against forged/colluding clients. Authentication identifies the submitting
account, not the roster's truth. Do not market Server chat as a cryptographically
private world boundary. Stronger attestation would require a separately approved
trust-model change; no HUD authentication/protocol redesign was made here.

## Provider performance and verification

Source-confirmed existing bounds, shared by ZFE and xScal: 500 ms driver tick,
2-second world sampling, 5-second missing-storage discovery retry, provider read
failure backoff from 2 to 30 seconds, changed writes at least 1 second apart measured
from completion, and 5-second unchanged heartbeats. Overlay reads never overlap;
discovery retries every 10 seconds. Initial attachment requires advancing snapshots;
an established writer expires at its nonrenewable 30-second observation deadline. No new per-frame
tab polling or game-native calls were introduced by channel customization.

If that deadline expires, the desktop reports the fixed `observation_timeout` leave reason. The backend
immediately revokes chat authority while retaining room affinity for one nonrenewable 30-second recovery
window. Explicit inactive exports, game exit, account/socket replacement, invalid exports, provider
conflicts, and real generation changes remain immediate hard boundaries.

The pure bridge tests passed 58 state checks and 141 export checks; 5 package tests
passed. All 50 Ruffle scenarios passed, including both provider contracts, storage
failures/recovery, unload during getters/subscriptions, delayed auth and fast travel.
These tests validate control flow and rate bounds, **not native call duration or
game-thread CPU**. Native calls remain synchronous and require fresh in-game timing.

Focused backend tests passed 56 cases across local-export, connection and socket
authorization suites, including all four HUD/provider ↔ bridge/provider pairings,
HUD↔HUD and bridge↔bridge, shared history/exactly-once delivery, isolation, stale
authority and observation flooding. These use isolated mocks, not hosted accounts.

The full backend suite is not accepted: running from the repository imported local
environment overrides (120 suites passed, 3 failed); running without those overrides
encountered an unauthenticated local Redis dependency. A subsequent owned Redis
container isolated that dependency but still left 8 app/integration suites failing
(115 passed). No full-suite success is claimed; no local environment file was edited.
The owned Redis container was removed after the run.

Dashboard unit coverage: 430 tests across 39 suites. Overlay unit coverage: 1,221
tests across 49 suites. Dashboard type checking and both renderer builds pass.
Electron coverage includes five complete cycles across General, Trading, Events,
Infests and Raids: hide all/restore all, drag in both directions, add a channel,
rename it, remove it, and retain drafts/socket state. It also checks keyboard reorder,
Escape cancellation, unchanged window position, restart defaults, unavailable Server
fallback, and ten reconnects retaining the visible message anchor. Every standard tab
is keyboard-reachable at 320/520/800px widths and 9/14/22px font scales. Removing the
active ordinary channel falls back; a new Server room follows the existing Server
selection without being overridden by missing-channel recovery.

Native HTML drag-and-drop reproduced a later browser-driven reading-position jump;
equivalent keyboard/menu reorder did not. The implementation uses pointer capture
and a five-pixel drag threshold instead, commits only on release, and cancels on
Escape, pointer cancellation or account boundary. The full reconnect regression
passed with that implementation. No recurring drag/layout timer was introduced.

Existing CI discovers the added Vitest and Jest tests; the existing Electron
interaction gate runs the expanded usability script. Native two-client acceptance,
actual ZFE/xScal call timing and reference-host CPU comparisons remain required before
claiming native performance or release readiness.

The final Electron interaction run passed after making narrow-window assertions
wait for the current viewport rather than compare with a pre-resize width. All owned
Electron profiles, mock relays, simulator servers and the temporary Redis container
were torn down. No installed overlay or game files were changed.

An isolated Linux QA-channel package is retained at
`cross-platform-overlay/test-results/subtab-build/linux-unpacked/`.
`resources/app.asar` SHA-256:
`26a4a39be3c858b90377dba57c68301e5ab352a36865377268a04e66cbdc3487`.
The renderer was exercised in the Electron harness; the packaged candidate has not
been installed or accepted in-game, and no release/scan/publication is claimed.
