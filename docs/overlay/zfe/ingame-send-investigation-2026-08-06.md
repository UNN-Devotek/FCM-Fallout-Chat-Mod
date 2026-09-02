# In-Game Send Failure — Investigation Log (2026-08-05 → 2026-08-06)

Working record of the "**That channel is not available**" / "**never joins server chat**"
investigation on the MSI native-Windows rig. Written in the same spirit as
[windows-nsis-ci-fixes.md](../../testing/windows-nsis-ci-fixes.md): the failures **in order**,
including the wrong turns, so nobody re-walks them.

**Status: UNRESOLVED.** Several real bugs were found and fixed along the way, but the original
symptom — sends to GENERAL rejected `invalid_channel` — is still present. A diagnostic widget
build (v2.9.9) is staged to read ZFE's actual error, which has never been legible.

---

## 1. Current state at a glance

| Thing | State |
| ----- | ----- |
| Send to GENERAL | **BROKEN** — `invalid_channel`, rejected locally in ~1 ms |
| Receive | **WORKS** — verified with a probe message, landed in 1 s |
| SERVER tab / world binding | **WORKS** — roster controls acknowledged |
| Relay-stored character name | **FIXED** — was 337 chars of garbage, now `Abderaan` |
| Link prompt reachability | **FIXED** (v2.9.7 sticky gate) |
| ZFE WSS connection on Windows | **FIXED** by ZFE 0.12.1 (upstream) |

### Rig / versions

| Component | Value |
| --------- | ----- |
| Host | `msi` (ssh-manager), `C:\Program Files (x86)\Steam\steamapps\common\Fallout76` |
| FO76 | 1.7.25.39 |
| ZFE `dxgi.dll` | **0.12.1**, md5 `d6edf4d33029da6d8d9d24a9d05f01b6`, sha256 `8b1882c9…fad083`, 2,010,624 B |
| `HUDModLoader.ba2` | md5 `833021a71770d5fef5c28fe5de11eeea` (unchanged all session) |
| Widget installed | **v2.9.8**, `FCMChatWidget.ba2` md5 `3692a936d2d44f2fbfd8406cab7c3f17` |
| Widget staged (diag) | **v2.9.9**, md5 `5edd32830084581b74a077980f6607e9` |
| Relay identity | `user_81de7fe31d8db858678737d9e47aefe1` (linked) |

---

## 2. What was actually fixed

### 2.1 ZFE 0.12.1 install (upstream fix for the WSS blocker)

The 125-second handshake stall documented in the ZFE memory is **gone**. TLS + WS upgrade to
`dev.falloutchatmod.com/relay` now succeed natively on Windows.

> **Note on the "different drive" premise.** The install had *not* moved. The MSI has a single
> 930 GB `C:` and exactly one FO76 install (depth-4 sweep confirmed). `libraryfolders.vdf` lists
> a stale `B:\SteamLibrary` entry for appid 1151340, last verified 2026-05-08 vs 2026-07-21 for
> the C: copy, and `B:` is not attached.

Backups: in-place `dxgi.dll.0.12.0.bak`, durable `C:\ZFE-backups\dxgi.dll.zfe-0.12.1-d6edf4d3`,
ledger updated at `~/ZFE-backups/README.md`.

### 2.2 Widget v2.9.7 — sticky link gate

The relay's link-code notice is a **one-shot push** (`relayHandler.pushLinkNotice`, fired on
register / hello / subscribe). v2.7.0–v2.9.6 cleared `_needsLink` on *every* reconnect and waited
for a fresh notice to re-raise it, so a missed push read as "this account is linked" — the widget
fell through to the chat feed and the link screen became unreachable without deleting
`Data/ZFE/chat-auth.bin`.

Observed 2026-08-05: prompt at 14:17:19, reconnect at 15:51:57, prompt never returned.

Fix: the gate is sticky, cleared only by `clearLinkGate()` on proof of linking (a `LINK COMPLETE`
notice or a successful send). A pinned code older than `LINK_CODE_REFRESH_MS` (9 min, against the
relay's 10-min TTL) triggers one reconnect so the relay issues a fresh code.

### 2.3 Widget v2.9.8 — double-escaped display name

`readDisplayName()` called `jsonEscape()` on the raw `BSUIDataManager` value, and `startConnect()`
escaped it **again** when building the payload. The game returns names UTF-16 NUL-padded, so
`Abderaan` became `A\0b\0d…` at read and `A\\u0000b\\u0000d…` on the wire.

Fix: **sanitize on read, escape exactly once at serialization.** `readDisplayName()` returns
`fcmClean(n)`; `fcmClean` strips real NULs/unit separators *and* the already-escaped `\u0000` and
bare `u0000` text forms; `bareName()` sanitizes roster names before they reach the ROSTER control
body.

Verified: the widget now logs `displayName=Abderaan`.

### 2.4 Relay `wireSanitize` — PR #466, merged as `1b58974`

**Proof the wire mangles clean strings** (this is the load-bearing evidence):

| | |
|---|---|
| Widget log, v2.9.8 | `displayName=Abderaan` — 8 clean ASCII chars |
| `hud_pairing_tokens.fo76_name` | `Au0000bu0000du0000eu0000ru0000au0000au0000n` — 43 chars |

A provably clean ASCII string went into `_api.call` and came out with the literal text `u0000`
after **every character**. Decoded transform: `C -> C + "u0000"`, final character bare.

Independently confirmed by probing the relay with a clean Node `ws` client:

- clean **unlinked** client → `channel:"global"` → `permission_denied` (correct)
- clean **linked** client → `channel:"global"` → **`success`**
- clean linked client → printable `FCMCTL/1/ROSTER:` on slug `server` → **acknowledged**
- replaying a NUL-interleaved slug → `invalid_channel: "Unknown channel: g\0l\0o\0b\0a\0l\0"`

So the relay, channel rows, and slug map were never at fault.

Fix: `backend/src/services/relay/wireSanitize.ts` — `readWireString()` applied to the mod-supplied
`channel`, `body`, and `displayName` frame fields. Only repairs a string mangled **end to end**;
ordinary text containing `u0000` is untouched. 15 new Jest cases; `relayHandler.test.js` 79/79
unchanged.

Post-deploy verification against the live dev relay, feeding it exactly what ZFE emits:

| Sent | Result |
|---|---|
| `displayName` = mangled `ProbeVerify` | stored clean, 11 chars |
| `channel` = `gu0000lu0000ou0000bu0000au0000l` | **success** |
| mangled `server` + mangled `FCMCTL/1/ROSTER:` body | **success** |

This fixed the stored name, the roster controls, and the SERVER tab. **It did not fix sending**,
for the reason in §4.

---

## 3. Wrong turns — do not repeat these

Four hypotheses were pursued and killed. Each is recorded because the *evidence that killed it* is
reusable.

### H1 — "ZFE 0.12.1 introduced a logging regression" — WRONG

The `cu0000ou0000nu0000…` log rendering predates 0.12.1. It is a **cosmetic ZFE logging defect**:
ZFE parses the mod's JSON envelope correctly and only mis-encodes the extracted value when writing
it to `zfe.log`.

> **Rule: never treat mangled log output as evidence that the wire is corrupt.** Check
> `hud_pairing_tokens.fo76_name` or probe the relay directly instead.

### H2 — "NUL string constants in the SWF poison the ZFE boundary" — WRONG

This is the documented v2.9.4/2.9.5 failure mode, and the source comments describe it well, so it
looked like a match. v2.9.7 removed **every** control-byte literal and the mangling persisted
completely unchanged. Disproved by its own fix.

Kept anyway as hygiene: control bytes are built at runtime via a **non-inline** `ctrlChar(code:Int)`
helper, because a direct `String.fromCharCode(0)` is **constant-folded by Haxe straight back into a
NUL literal** — verified, the compiled SWF then contains no `fromCharCode` at all. A Vitest guard
greps the `.hx` for control-byte literals and for the `inline` regression.

### H3 — "the relay never sees the send" — RIGHT CONCLUSION, INVALID EVIDENCE (then re-proved)

First attempt used a container-side patch that never ran: the compiled relay references
`logger_1.default.warn(...)`, the patch used bare `logger.warn(...)`, and because it was wrapped in
`try/catch` the resulting `ReferenceError` was swallowed silently. Absence of `[DIAG]` lines meant
nothing.

> **Rule: prove instrumentation fires before trusting its silence.** The corrected hook was
> validated by deliberately tripping it (`permission_denied` → `[DIAG2] reject` logged).

### H4 — "ZFE's `AllowedChannels` isn't loaded / is remotely overridden" — WRONG

`Data/ZFE/TextChat/fragments/FCMChatWidget.ini` already lists
`AllowedChannels=global,trade,events,raids,infests,server`, but `[RemoteData] FragmentSources=yes`
allows a remote source to override it, and ZFE logs nothing about fragment resolution.

Forced explicitly in `Data/configuration/zfe.ini` `[TextChat]` (which the fragment header says wins
over the fragment), game relaunched at 18:57:03 — send at 19:01:02 **still failed identically**.
Backup: `zfe.ini.bak-20260806`.

---

## 4. The live finding — the rejection is LOCAL

```
18:51:09.619  [send]: payload ch=global len=4
18:51:09.620  [send]: relay rejected code=invalid_channel raw={\      <- 1 ms later
```

Two independent lines of evidence:

1. **Timing.** ~1 ms. Round-trip to `dev.falloutchatmod.com` measures ~130 ms in the same log.
   A remote rejection is physically impossible at that latency.
2. **Relay silence.** No `[DIAG2]` hit, from a hook proved working minutes earlier.

Reinforcing detail: no `chat.v1 WSS` activity is logged for the send at all, while `server`-channel
frames **do** reach the relay (`[relayHandler] roster room assigned`).

**Conclusion: ZFE synthesizes `invalid_channel` itself and never contacts the relay.** `server`
frames go out, `global` frames do not. This is why every relay-side fix left the symptom untouched.

Caveat held honestly: *why* ZFE rejects `global` is not yet known. `invalid_channel` is our relay's
vocabulary, not a documented ZFE error (`dispatch_failed` / `RelayRejected` / `not_connected`),
which is itself unexplained and may matter.

---

## 5. Next step — v2.9.9 diagnostic build (staged, not yet installed)

Every hypothesis above died for the same reason: **ZFE's logger truncates every value at the first
backslash**, so `raw=` has never shown more than `{\`.

v2.9.9 logs, on every send:

- `SENTPAYLOAD=` — the exact JSON handed to ZFE, backslashes swapped for `/`
- `RSLEN=` / `RSSAFE=` — the full response, same treatment, 300 chars

Staged at `C:\fcm-stage\FCMChatWidget-2.9.9-diag.ba2`; scheduled task **`FCM-InstallDiag299`** is
armed and installs within ~5 s of FO76 exiting, logging to `C:\fcm-stage\install-diag.log`.

Then: relaunch → load into a world → send one message on GENERAL → read `SENTPAYLOAD` / `RSSAFE`.

---

## 6. Infrastructure found broken along the way

### 6.1 GitHub Actions is not creating workflow runs

- Three `ci-approved` label events fired on PR #466 → **zero** runs created.
- A push to the branch did not trigger `pr-gate-delabel.yml` either (the label survived).
- `CI` workflow is `active`, Actions `enabled`, `allowed_actions: all`.
- Runs that *are* created never start: a Dependabot run on the sibling `Fallout-Chat-Mod` repo has
  been `queued` since 2026-08-05T19:25Z.
- Last CI run of any kind: **2026-08-03**.

Most consistent with an **Actions spending/minutes limit**. Unconfirmed — the billing API needs the
`user` scope, unavailable in a non-interactive session. Check github.com/settings/billing.

**Consequence: PR #466 was merged with `--admin`, so `CI Summary` never ran on it.** Locally
verified: 94/94 backend tests. Not verified: overlay/dashboard Vitest, lint/typecheck, gamemod
anchors. Worth a re-run once Actions is alive.

### 6.2 Self-hosted runners were wedged for 12 days — fixed

```
fcm-1: 2026-07-25 12:15:33Z Runner connect error: Failed to get job message.
       https://broker.actions.githubusercontent.com/message -> InternalServerError
fcm-2: 2026-07-25 12:17:59Z (same)
```

Both retried a broker call that never recovered, while the GitHub API still reported them
`online` — which is why it stayed invisible. Restarted; both `Listening for Jobs` since 19:00:32.

Not the cause of §6.1 — CI targets `ubuntu-latest`, so these were never in the path. Routing CI to
them via `CI_RUNNER` changed nothing (run *creation* precedes runner selection). Both variables
were reverted; no drift left.

`runner-1/2/3` show `Registration <uuid> was not found` — ephemeral registrations expiring,
self-healing, shared with other repos, unrelated to FCM.

---

## 7. Useful techniques discovered this session

**Probe the dev relay with a clean client** — the single most decisive tool here. Register over WS,
link the token via SQL, send, observe. It isolates client-side corruption from relay-side faults in
one step. Revoke the token and delete its test messages afterwards.

**Dev stack access** (read-only checks):

```bash
# ssh mothership — Dokploy's generated project name for fcm-dev:
#   compose-reboot-back-end-hard-drive-q7s37s   (composeId iWO0FprKUe9j0CXg7k5yq)
docker exec compose-reboot-back-end-hard-drive-q7s37s-postgres-dev-1 \
  psql -U fo76_dev_user -d fo76_chat_dev -c "SELECT ..."

# The DEPLOYED JS — grep this rather than trusting the branch:
docker exec compose-reboot-back-end-hard-drive-q7s37s-backend-dev-1 \
  cat /app/dist/services/relay/channelMap.js
```

**Verify SWF checks on the DECOMPRESSED file.** `haxe build.hxml` emits CWS (zlib); byte greps are
meaningless until `patch.py` converts to FWS.

**The `.ba2` is locked while FO76 runs.** Never kill the game — stage the file and arm a scheduled
task that installs on exit (pattern used twice here, see `C:\fcm-stage\install-*.ps1`).

---

## 8. Outstanding items

1. **Install v2.9.9 and read the real ZFE error** — the actual next step (§5).
2. **Widget work is uncommitted** in the main tree: v2.9.7 sticky gate, v2.9.8 sanitize, `ctrlChar`,
   guard tests, doc updates. Needs its own PR. Note the tree is ~18 commits behind `origin/dev` —
   cut any branch from `origin/dev`, not from the local tip (see the stale-base hazard).
3. **Two log-only diagnostic patches are live in the dev backend container**
   (`/app/dist/services/relay/relayHandler.js`, original at `/tmp/relayHandler.js.bak`). They
   vanish on the next deploy; strip them once this is closed.
4. **Report the ZFE defect upstream** (Nexus 4065 / Collective Modding Discord): mod-supplied string
   values emitted with `u0000` after every character; broke between 0.9.11 and 0.9.21. Our
   `wireSanitize` is explicitly a workaround with a removal condition.
5. **Unblock GitHub Actions** (§6.1) and re-run CI over `1b58974`.
6. Stale `B:\SteamLibrary` entry in the MSI's `libraryfolders.vdf` — harmless, but it misled the
   initial "moved drive" premise and could mislead again.
