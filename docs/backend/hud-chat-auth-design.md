# M6: HUD Chat Auth System — Design Document

**Status:** **Implemented** (2026-06-24, worktree `chatv1-auth`). Core auth gate, provider linking, device-code flow, /link page, and deny-list are in the working tree awaiting integration review. The §9 Open Decisions are resolved (OD-3/OD-6) or carried as recommendations.  
**Milestone:** M6 (production-exposure gate)  
**Author:** Design session 2026-06-11  
**Depends on:** existing Discord OAuth flow; ZFE `chat.v1` relay (epic #282); multi-provider identity (epic #163)

---

> ## Update (2026-06-23): chat.v1 transport + lockdown decisions
>
> This doc was written for the **FCMHUD/1** transport (`/ws/hud`, `tcp:4001`, the `HELLO~<token>~<char>`
> wire, `fcm.ini [FCMBridge] PairingToken`). That transport is the **active in-game transport we ship
> on now** (#302); the **ZFE `chat.v1` native chat relay**
> ([`docs/overlay/zfe/native-chat-relay/`](../overlay/zfe/native-chat-relay/README.md), epic #282)
> supersedes it **later** (re-sequenced). **Both flavors of this auth design apply:** the pairing-token
> `HELLO~<token>` gate ships on FCMHUD/1 now; the device-code refinement lands with chat.v1. The
> **core of this design is unchanged and still authoritative** — the multi-provider
> account model (§3.1 `linked_identities`), the provider **access gate** (§3.1: Discord **or** Nexus
> required), Nexus OAuth2 + PKCE (§5.2), collision/recovery (§6), migration (§7), and the security
> analysis (§8) all carry over. What changes is the **transport + pairing UX**, and the lockdown adds a
> hard access requirement:
>
> **Locked decisions (supersede the §9 recommendations where noted):**
> - **Mandatory gate (new).** Chat access **requires** a linked provider — **no anonymous chat**. A
>   bare chat.v1 `register` mints a **limited** identity that cannot `send` until linked (relay returns
>   `permission_denied`). Public-website read-only stays open; **sending requires auth**.
> - **OD-3 → IMPLEMENT (was "defer").** Ship the **device-authorization (short code)** UX. Under
>   chat.v1 there is **no token to paste at all**: the SWF does `register` (ZFE stores the token via
>   DPAPI), shows a short **link code**, the user signs in at `falloutchatmod.com/link` (Discord **or**
>   Nexus) and enters the code, and the relay **upgrades the existing token's account in place**.
> - **OD-6 → Nexus for the OVERLAY too (was "game-link only").** Nexus is a first-class login for the
>   **overlay** + in-game basic chat (Nexus **or** Discord). The **admin dashboard stays Discord-only**
>   — elevated/mod/dev roles require Discord (#168); linking Nexus never grants them.
>
> **chat.v1 mapping of the pairing model:**
>
> | This doc (FCMHUD/1) | chat.v1 equivalent |
> |---|---|
> | `HELLO~<pairingToken>~<char>` (§4.3) | chat.v1 `register` (anonymous, **limited**) → **device-code link** upgrades the token |
> | `fcm.ini [FCMBridge] PairingToken=` | **none** — ZFE holds the token (DPAPI); nothing is pasted |
> | "mint token → copy-paste" (§4.5) | "register → show link code → sign in (Discord/Nexus) → relay binds account" |
> | `identityHash = HMAC(secret, userId)` (§3.3) | **unchanged** — keyed on the authed account `userId` |
> | Access gate (§3.1: Discord **or** Nexus) | **unchanged** — required before `send` |
>
> Read §3–§8 as-is for the account model, Nexus OAuth, collision/recovery, and security; substitute the
> transport/UX per the table above. The §9 table is annotated inline (OD-3, OD-6).

## 1. Problem Statement

The in-game two-way chat system (`/ws/hud`, `tcp.falloutchatmod.com:4001`, `/api/game/hud-feed`) must be publicly reachable on the open internet. A distributed mod cannot use Cloudflare Access SSO — every user's PC connects directly. This creates an authentication gap with three concrete consequences:

1. **Identity is client-supplied.** The current `HELLO` handshake sends `HELLO~<accountName>~<characterName>`. The server derives `identityHash = HMAC-SHA256(HUD_IDENTITY_SECRET, accountName)` but `accountName` comes verbatim from the client. Anyone can send any name and impersonate any player. Account names are visible in the public feed; they are not a secret.

2. **The channel is not encrypted end-to-end.** TCP path uses TLS (Schannel) but the WebSocket path over a compromised proxy or MITM offers an attacker a window to inject `HELLO` lines before the real client can.

3. **No real person behind the socket.** The `hud` inbound path is currently fail-closed for rate-limits (SR-004) precisely because there is no trusted identity behind it. Automod, mute, and ban records are all keyed on `identityHash`, which an attacker can spoof by choosing the matching account name. This makes moderation actions based on that hash meaningless before real auth exists.

A secondary problem: the system has no multi-provider identity model. All existing auth is Discord-only. A user without Discord, or who wants to prove identity via Nexus Mods (the natural distribution platform for a Bethesda mod), has no path in.

**This document specifies a token-based auth system (the "pairing token" model) that closes the impersonation hole without requiring the SWF to perform OAuth or store secrets, and a multi-provider account model that allows Discord-only, Nexus-only, or dual-linked accounts to obtain a pairing token.**

The dev-only guard in `hudPushTcp.ts` / `hudPushWs.ts` (`NODE_ENV=production` refusal) must not be removed until this design is implemented and deployed.

---

## 2. Goals and Non-Goals

### Goals

- **G1.** A server-side credential (pairing token) replaces the client-supplied name in `HELLO`. Possession of a valid token proves the user authenticated in a browser at link time.
- **G2.** Tokens are per-account, high-entropy, revocable, and stored only as a hash server-side.
- **G3.** A user with no Discord account can authenticate via Nexus Mods OAuth and obtain a pairing token.
- **G4.** One FCM account = one FO76 character name (at any given time). Name squatting is deterred.
- **G5.** All existing moderation machinery (automod, mute, ban, `HudIdentityBlock`, rate-limit fail-closed, per-IP cap) stacks on top of auth rather than being replaced by it.
- **G6.** `identityHash` becomes a cryptographic derivative of the authenticated account ID rather than the client-supplied FO76 name.
- **G7.** The pairing flow requires only a one-time copy-paste into `fcm.ini`. No game restart required after the initial paste.
- **G8.** Name collisions (two users claiming the same FO76 name) are handled deterministically, with a recovery path that does not silently create duplicate accounts.

### Non-Goals

- **NG1.** Verifying that a user's claimed FO76 name is their *actual* Bethesda/Steam account name (Bethesda has no public API for this; presence cross-check is defence-in-depth only, not a hard gate).
- **NG2.** Full account merge (two existing accounts with different provider links joining into one). Deferred; the collision/recovery flow covers the most common case.
- **NG3.** Silent automatic re-pairing. The one-time paste is unavoidable; the browser UX polishes it but does not remove it.
- **NG4.** Offline token verification. Tokens require a backend lookup; the backend is required to play.

---

## 3. Account and Provider Model

### 3.1 Recommendation: `linked_identities` table

The existing `User` model carries inline Discord fields (`discordId`, `discordUsername`, `discordDisplayName`, `discordAvatar`, `discordAuthedAt`). Adding parallel inline Nexus fields (`nexusUserId`, `nexusUsername`, `nexusAuthedAt`) would work, but it creates a structural pattern that breaks as providers grow and it makes "does this account have at least one verified provider" a multi-column OR that must be maintained in sync.

**Recommendation: introduce a `linked_identities` table, keep the existing inline Discord columns as-is for the auth session flow (they are already wired to session cookies and the dashboard), and write Nexus data into both places at link time: a new row in `linked_identities` AND the inline Discord-equivalent columns for Nexus only if no existing inline storage exists.**

Actually — cleaner approach: **keep Discord inline** (it is load-bearing for session auth, admin panel, role sync, ban/unban Discord role restoration), and introduce `linked_identities` for Nexus (and any future providers). This avoids a disruptive migration of the Discord flow while providing a clean extensible model for providers that do not need deep session integration.

**Schema addition:**

```sql
-- linked_identities
-- One row per (user, provider) pair. Discord identity stays inline on users.
CREATE TABLE linked_identities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT        NOT NULL,          -- 'nexus' | future: 'steam', 'bethesda'
  provider_uid  TEXT        NOT NULL,          -- stable numeric/string ID from provider
  username      TEXT,                          -- display username at link time
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified TIMESTAMPTZ,                   -- last successful token refresh / re-verify

  UNIQUE (provider, provider_uid),             -- one FCM account per provider identity
  UNIQUE (user_id, provider)                   -- one provider link per account type
);
CREATE INDEX ON linked_identities (user_id);
```

**Prisma model:**

```prisma
model LinkedIdentity {
  id           String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId       String    @map("user_id") @db.Uuid
  provider     String    // 'nexus' | ...
  providerUid  String    @map("provider_uid")
  username     String?
  linkedAt     DateTime  @default(now()) @map("linked_at") @db.Timestamptz(6)
  lastVerified DateTime? @map("last_verified") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerUid])
  @@unique([userId, provider])
  @@index([userId])
  @@map("linked_identities")
}
```

**Chat access gate:** a pairing token may only be minted for a `User` where EITHER `discordId IS NOT NULL` OR a `linked_identities` row exists for that user. A user who has never authenticated with any provider cannot obtain a pairing token. This is enforced in `POST /api/link/pairing-token`.

**Ban deny-list (the inverse gate):** a permanent ban deny-lists the account's provider IDs in a `banned_identities` table (`provider` + `provider_uid`), checked at the **same gate** and at the device-code link / OAuth callbacks — a deny-listed Discord/Nexus ID cannot mint or upgrade a token **even on a fresh FCM account or after the original is deleted**. This is the durable, account-independent ban layer; see [moderation/kick-mute-ban.md §5](../moderation/kick-mute-ban.md) and #297.

### 3.2 FO76 name claim

The `fo76AccountName` field on `User` becomes the claimed FO76 display name, bound at pairing-token mint time. It is **self-asserted** — the system cannot verify it against Bethesda. What the provider link buys is a real, bannable identity: the Nexus account (with its mod-download history, reputation, and ban record) is tied to the FO76 name claim. Name squatting and abuse are attributable.

One active FO76 name per account. Renaming is allowed (old name logged to `user_aliases`). One FO76 name per account at any time.

### 3.3 `identityHash` rekey

Under this design, `identityHash` changes meaning:

- **Current (M7):** `HMAC-SHA256(HUD_IDENTITY_SECRET, fo76AccountName)` — name-derived, spoofable.
- **M6+:** `HMAC-SHA256(HUD_IDENTITY_HASH_SECRET, userId)` — account-derived, unforgeable without the server secret.

The server-side secret `HUD_IDENTITY_HASH_SECRET` is a new env var (distinct from `HUD_IDENTITY_SECRET`, which is retired when the production guard is lifted). The hash is recomputed on first login after migration and stored; existing `HudIdentityBlock` records keyed on old hashes are migrated (see Section 8).

---

## 4. Pairing Token Protocol

### 4.1 Token properties

| Property | Value |
|---|---|
| Entropy | 32 bytes (256 bits) from `crypto.randomBytes(32)` |
| Encoding | URL-safe base64 (43 chars, no padding) |
| Storage | Only the argon2id hash stored in DB (`hud_pairing_tokens.token_hash`) |
| Scope | Bound to (`userId`, `fo76AccountName`) at mint time |
| Expiry | No hard expiry; revocable by user at any time via the link page |
| Concurrency | At most one active token per user. Minting a new token revokes the previous one (soft-delete: `revoked_at` set) |

### 4.2 `hud_pairing_tokens` table

```sql
CREATE TABLE hud_pairing_tokens (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT        UNIQUE NOT NULL,   -- argon2id hash of the raw 32-byte token
  fo76_name      TEXT        NOT NULL,          -- FO76 name bound at mint time
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ                    -- NULL = active
);
CREATE INDEX ON hud_pairing_tokens (user_id);
CREATE INDEX ON hud_pairing_tokens (revoked_at) WHERE revoked_at IS NULL;
```

**Prisma model:**

```prisma
model HudPairingToken {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  tokenHash   String    @unique @map("token_hash")
  fo76Name    String    @map("fo76_name")
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  lastUsedAt  DateTime? @map("last_used_at") @db.Timestamptz(6)
  revokedAt   DateTime? @map("revoked_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([revokedAt])
  @@map("hud_pairing_tokens")
}
```

### 4.3 HELLO wire change

**Before (M7):**
```
HELLO~<fo76AccountName>~<characterName>
```

**After (M6+):**
```
HELLO~<pairingToken>~<characterName>
```

The `characterName` field remains display-only. The server resolves the user from the token, not from the name. Character name is reconciled on connect exactly as today (stored, renamed if changed).

`fcm.ini` configuration key:
```ini
[FCMBridge]
PairingToken=<base64url-43-chars>
```

The SWF reads `PairingToken` from the ini on startup and substitutes it into the `HELLO` line. There is no way for AS3 to write this value — the one-time user copy-paste is unavoidable. A "device-authorization" style pairing code (user enters a short code on a browser page) would polish the UX (no 43-char string to copy) but does not eliminate the paste into `fcm.ini`. Implementing that UX improvement is deferred; the base design simply shows the full token for copy.

### 4.4 Server-side HELLO processing (post-M6)

```
1. Parse HELLO~<token>~<charName>
2. Look up token candidate:
   a. Search hud_pairing_tokens WHERE revoked_at IS NULL
      - Use the first 8 chars of the token as a lookup hint (stored alongside hash as token_prefix)
        to avoid full-table argon2 verification — see performance note below.
   b. argon2.verify(row.token_hash, receivedToken)
   c. If no match or revoked → destroy socket (send ERROR~AUTH_FAILED\n first, then close)
3. Load user by token.user_id
4. Check user.isBanned + HudIdentityBlock (type='ban') → destroy socket if active
5. Reconcile fo76CharacterName (update if changed)
6. Update token.last_used_at
7. Compute identityHash = HMAC-SHA256(HUD_IDENTITY_HASH_SECRET, userId) — already stored on user
8. Attach user to socket session; allow SEND
```

**Performance note on argon2 lookup:** argon2id verification is intentionally slow (~100 ms). With many concurrent connections this creates a timing window. Mitigation: store the first 8 chars of the raw token as `token_prefix TEXT` alongside `token_hash`. Lookup: `WHERE token_prefix = $1 AND revoked_at IS NULL` — this narrows to O(1) rows before the expensive verify. The prefix leaks ~48 bits; argon2id still protects the remaining entropy. A constant-time index lookup on prefix + argon2 verify on the single candidate row is the right shape.

Update `hud_pairing_tokens` to add:
```sql
token_prefix TEXT NOT NULL  -- first 8 chars of the raw base64url token
```
With index: `CREATE INDEX ON hud_pairing_tokens (token_prefix) WHERE revoked_at IS NULL`.

### 4.5 Browser link flow

```
User visits /link/game  (requires active session cookie — Discord or Nexus OAuth)
  |
  +-- If no verified provider → 403 "Link Discord or Nexus first"
  |
  +-- Show claimed FO76 name (or name-claim form if not yet set)
  |
  +-- User confirms / enters FO76 name
  |
  POST /api/link/pairing-token
    → Mint token (crypto.randomBytes(32))
    → argon2id hash → store in hud_pairing_tokens
    → Revoke previous token (set revoked_at) if any
    → Return { token, fo76Name }
  |
  +-- Display token in copyable text box + QR code
  +-- Instructions: paste into Data/configuration/fcm.ini → [FCMBridge] PairingToken=...
  +-- "Rotate token" button → calls endpoint again, invalidates old token
```

**Endpoints:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/link/game` | session | Returns current link state: `{ fo76Name, hasToken, tokenCreatedAt, tokenLastUsedAt }` |
| `POST` | `/api/link/pairing-token` | session + provider gate | Mints (or rotates) a pairing token. Body: `{ fo76Name }`. Returns `{ token }` once only. |
| `DELETE` | `/api/link/pairing-token` | session | Revokes the active token. User must re-mint to reconnect. |

---

## 5. Provider Integrations

### 5.1 Discord (existing — no changes required)

Discord OAuth is already implemented in `backend/src/routes/auth.ts` and stores `discordId`, `discordUsername`, `discordDisplayName`, `discordAvatar`, `discordAuthedAt` on `User`. Sessions are cookie-based. This path is complete and wires directly into the chat access gate: `discordId IS NOT NULL` → eligible to mint a pairing token.

The 30-day re-auth expiry on `discordAuthedAt` applies to dashboard access only; it does not affect an already-minted pairing token's validity.

### 5.2 Nexus Mods OAuth 2.0 + PKCE

**Reference:** https://api-docs.nexusmods.com/ | https://modding.wiki/en/api/oauth2-guide

#### Client registration

Nexus requires a registered OAuth application. Registration via https://www.nexusmods.com/users/myaccount?tab=api. Obtain:
- `NEXUS_CLIENT_ID` — public, embed in frontend
- `NEXUS_CLIENT_SECRET` — server-side only, never exposed to client

Redirect URI: `https://falloutchatmod.com/auth/nexus/callback` (and dev: `http://localhost:7177/auth/nexus/callback`).

#### Authorization code + PKCE flow

```
Browser                         FCM Backend                    Nexus
  |                                |                              |
  | GET /auth/nexus                |                              |
  |------------------------------->|                              |
  |                                | generate code_verifier       |
  |                                | code_challenge=S256(verifier)|
  |                                | store verifier in session    |
  | 302 → nexusmods.com/oauth/...  |                              |
  |  ?client_id=...                |                              |
  |  &redirect_uri=...             |                              |
  |  &response_type=code           |                              |
  |  &code_challenge=...           |                              |
  |  &code_challenge_method=S256   |                              |
  |  &scope=openid profile         |                              |
  |<-------------------------------|                              |
  | User authorises on Nexus       |                              |
  |------------------------------------------------------>|      |
  |                                | GET /auth/nexus/callback     |
  |                                |  ?code=<authcode>            |
  |<-------------------------------|                              |
  | POST /auth/nexus/callback      |                              |
  |------------------------------->|                              |
  |                                | POST nexusmods.com/oauth/token
  |                                |  grant_type=authorization_code
  |                                |  code=<authcode>             |
  |                                |  code_verifier=<verifier>    |
  |                                |  client_id + client_secret   |
  |                                |----------------------------->`|
  |                                |         { access_token,      |
  |                                |           id_token, ...}     |
  |                                |<-----------------------------|
  |                                | GET /v1/users/validate.json  |
  |                                |  Authorization: Bearer <at>  |
  |                                |----------------------------->`|
  |                                |         { user_id, name, ... }
  |                                |<-----------------------------|
  |                                | Upsert linked_identities     |
  |                                | (provider='nexus',           |
  |                                |  provider_uid=user_id)       |
  |                                | Set session cookie           |
  | 302 → /link/game               |                              |
  |<-------------------------------|                              |
```

**Token storage:** Store the Nexus `access_token` and `refresh_token` in the `linked_identities` row (add encrypted columns `access_token_enc`, `refresh_token_enc`) or in a separate `nexus_tokens` Redis key (keyed by `userId`, short TTL). **Recommendation: Redis with TTL matching token expiry, using AES-256-GCM with a server-side key (`NEXUS_TOKEN_ENC_KEY`).** This avoids storing OAuth tokens in the primary DB, keeps the rotation logic simple, and auto-purges on expiry.

**Nexus userinfo:** `GET https://api.nexusmods.com/v1/users/validate.json` with `Authorization: Bearer <access_token>` returns `{ user_id: number, name: string, email: string, is_premium: bool, ... }`. Use `user_id` as `provider_uid`.

**Scope:** `openid profile` is sufficient; no mod-management scope needed.

**Endpoints to add:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/nexus` | Redirect to Nexus authorization with PKCE |
| `GET` | `/auth/nexus/callback` | Exchange code, store identity, redirect to `/link/game` |
| `DELETE` | `/auth/nexus` | Unlink Nexus identity (only if Discord is also linked; cannot remove last provider) |

---

## 6. Onboarding and Collision/Recovery Flows

### 6.1 Happy path — new user, no collision

```
1. User opens falloutchatmod.com, clicks "Link for in-game chat"
2. Authenticate with Discord or Nexus (existing OAuth flows)
3. /link/game — prompted to enter FO76 character name
4. Server checks: is this name already claimed by another user?
   → No → write User.fo76AccountName, recompute identityHash
5. POST /api/link/pairing-token
   → Mint token, return once
6. User copies token into Data/configuration/fcm.ini
7. Next game launch: FCMBridge reads PairingToken, sends HELLO~<token>~<charName>
8. Server resolves token → user → allows SEND
```

### 6.2 FO76 name collision — new Nexus user claims a name held by an existing Discord user

This is the most important edge case. The existing account has `fo76AccountName = "Devotek"` and a Discord link. A new user authenticates via Nexus and claims "Devotek".

```
POST /api/link/pairing-token { fo76Name: "Devotek" }
  → Server finds existing User.fo76AccountName = "Devotek" (different userId)
  → Return 409 { code: "NAME_CLAIMED", hint: "providers_on_existing_account": ["discord"] }

Browser shows:
  "This FO76 name is linked to another account.
   If this is your account, sign in with Discord to merge."

User clicks "Sign in with Discord to verify ownership"
  → Standard Discord OAuth flow; callback stores discordId on the SESSION (not yet persisted)

POST /api/link/pairing-token { fo76Name: "Devotek", mergeViaProvider: "discord" }
  → Server checks: session.pendingDiscordId === existing_user.discordId?
  → Yes → LINK the Nexus identity onto the EXISTING account
           (insert linked_identities row for provider='nexus' on the existing user_id)
           → DO NOT create a new User row
  → Revoke any pairing token the existing account had
  → Mint new token for the (now merged) account
  → Return { token }
```

**Security constraint:** The merge step requires the user to prove ownership of BOTH the Nexus account (via the OAuth flow that initiated the session) AND the Discord account linked to the existing FCM user. The server must verify that `session.pendingDiscordId === existing_user.discordId` before writing the link. This is a narrow, audited operation — log to `audit_logs`.

**Reverse case:** Nexus-linked existing account vs. new Discord user claiming the same name — symmetric; replace "discord" with "nexus" above.

### 6.3 Full account merge (two distinct FCM accounts, both with different providers, both claiming same name)

This case — where the person genuinely has two separate FCM accounts — is **deferred**. The system returns a support prompt: "Contact a moderator with both your Discord and Nexus account names to merge manually." Admin path: `POST /api/admin/users/:id/merge` (to be designed separately).

### 6.4 Name squatting

- **First-claim-wins.** The first authenticated user to claim a name owns it.
- **Admin override:** `PATCH /api/admin/users/:id` with `{ fo76AccountName: null }` releases the name; the user must re-claim via the link page. Logged to `audit_logs`.
- **Squatter detection heuristic:** if `User.fo76AccountName = "X"` but the user has sent zero messages and has no world-session history in the past 30 days, the name is flagged as potentially squatted in the admin dashboard. Not auto-released; requires human review.

### 6.5 Presence cross-check (defence-in-depth, not a gate)

When a user claims FO76 name "X" and the backend currently has a live world-session where `User.fo76CharacterName = "X"` (i.e., someone is online using that name right now), the link page displays a warning: "This name is currently active in a world session. If that is not you, contact a moderator." This is informational only — it does not block the claim, because the online user may be a squatter. Log the coincidence to `audit_logs` for manual review.

---

## 7. Migration Plan

### 7.1 New DB objects

All migrations must follow the idempotency rule (`IF NOT EXISTS`, `DO $$ … END $$` constraint guards, `ON CONFLICT DO NOTHING` seeds).

1. `linked_identities` table (Section 3.1)
2. `hud_pairing_tokens` table + `token_prefix` column (Section 4.2 / 4.4)
3. Column additions to `linked_identities`: `access_token_enc TEXT`, `refresh_token_enc TEXT`, `token_expires_at TIMESTAMPTZ` (if not using Redis for token storage — decide before implementation)

### 7.2 `identityHash` rekey

Existing users who connected via the old HMAC-name scheme have `identityHash = HMAC(secret, fo76AccountName)`. After M6:

- `identityHash` = `HMAC(HUD_IDENTITY_HASH_SECRET, userId)`.
- Migration script (one-off, run after deploy): for every `User` where `identityHash IS NOT NULL`, recompute from `userId` and write. Zero downtime: old value is replaced atomically.
- **`HudIdentityBlock` records:** these are keyed on the old `identityHash`. After rekey, old block hashes will not match any active user. Options:
  - **Option A (recommended):** Before rekey, for every active `HudIdentityBlock`, join to `User` on `identityHash`, resolve the `userId`, and insert a new `HudIdentityBlock` row with the new hash value. Then do the rekey. This preserves all active mutes/bans.
  - **Option B:** Accept that the small number of existing blocks (likely zero in prod at M6 time, since HUD auth was never production-enabled) will be orphaned. Add a one-time admin note to re-issue any active blocks manually after migration.
- Given that the production guard has never been lifted, **Option B is likely sufficient** — confirm with the operator before the migration run.

### 7.3 `HUD_IDENTITY_SECRET` retirement

Once M6 is deployed and the production guard is lifted:
- `HUD_IDENTITY_SECRET` is no longer read by `initHudPushTcp` / `initHudPushWs`.
- Keep the env var in Dokploy for one release cycle in case of rollback.
- Remove from `backend/.env.example` in the following release.
- The SR-003 fail-closed guard (`HUD_IDENTITY_SECRET` unset or dev default → refuse inbound path) is replaced by a new SR-003': `HUD_IDENTITY_HASH_SECRET` unset or dev default → refuse to start inbound path.

### 7.4 SWF changes required

- `FCMBridge.hx`: read `PairingToken` from `fcm.ini` on startup; use it as the first field of `HELLO` instead of account name.
- No other SWF change. Character name second field is unchanged. Server-side parsing change is purely additive (swap what field 1 means).

### 7.5 Rollback path

If M6 must be rolled back to M7 wire protocol:
- Token-based HELLO: if the server receives a field-1 value that looks like a 43-char base64url string (no spaces, matches `^[A-Za-z0-9_-]{43}$`), treat it as a token. Otherwise, treat it as an account name (M7 behaviour). This gives a transition window where old and new SWF versions can coexist.
- Remove the compat shim once the SWF is confirmed deployed everywhere.

---

## 8. Security Analysis

### 8.1 Threats closed by M6

| Threat | M7 status | M6 status |
|---|---|---|
| Player impersonation via crafted HELLO | Open — attacker sends `HELLO~Devotek~X` | Closed — token required; name field is display-only |
| Client-side name-hash forgery | Open — attacker knows the HMAC key from traffic analysis | Closed — token is 256-bit random; hash is argon2id |
| Moderation evasion via name change | Partial — identityHash persists across renames but is name-derived at provision | Closed — identityHash is userId-derived; rename does not change identity |
| Account-less spam (no identity link) | Open | Closed — provider auth gate before token mint |
| Token replay after revocation | N/A | Closed — `revoked_at` check on every HELLO; no caching of token validity |

### 8.2 Residual risks

| Risk | Severity | Mitigation |
|---|---|---|
| FO76 name is still self-asserted | Low-medium | Presence cross-check (Section 6.5) + one-name-per-account enforcement + admin override. Full Bethesda account verification is out of scope (no API). |
| Token exfiltration from `fcm.ini` | Medium | Token is local plaintext in a config file. Attacker with filesystem access can steal it. Mitigation: token is per-account and revocable; user can invalidate via the link page. The threat model already assumes the mod runs on a user-controlled machine. |
| argon2id timing side-channel on HELLO | Low | `token_prefix` lookup narrows to one row first; only one argon2 verify per connection. HELLO rate is bounded by the 10 s HELLO timeout + per-IP connection cap. |
| Provider OAuth state CSRF | Closed | PKCE + `state` param (nonce stored in session, verified on callback) for both Discord and Nexus flows. |
| Nexus account sharing / token delegation | Low | Nexus `user_id` is account-scoped; mod creators cannot spoof another account. If a Nexus account is banned on Nexus Mods, the `validate.json` call will fail at re-verify time. |
| Old name-hash `HudIdentityBlock` entries orphaned post-migration | Low | Covered by migration path Option A (Section 7.2). |

### 8.3 Existing guards that stack on top of M6 auth

All of the following are unmodified by M6. They apply **after** successful token verification:

- Rate-limit fail-closed for `hud` source (SR-004): Redis unreachable → drop message, keep socket.
- `DIAG` verb disk-write gated on `HUD_PUSH_DIAG_LOG` (SR-005).
- Per-IP connection cap: 3 concurrent connections (TCP), 3 (WS).
- `HudIdentityBlock` ban → socket destroy on HELLO.
- `HudIdentityBlock` mute → silent message drop on SEND.
- `User.isMuted` / `User.isBanned` checks in `ingestMessage`.
- Automod rules applied to `hud` source messages.
- `MAX_LINE_BYTES = 2048` per-line inbound cap; lines exceeding dropped without disconnect.
- `HUD_IDENTITY_HASH_SECRET` unset → refuse inbound path (SR-003 replacement).

---

## 9. Open Decisions

| # | Question | Options | Recommendation |
|---|---|---|---|
| OD-1 | Token hash algorithm: argon2id vs bcrypt | argon2id: winner of PHC, better memory-hardness; bcrypt: widely supported, simpler | **argon2id** (use `@node-rs/argon2` or `argon2` npm package). bcrypt is fine but argon2id is the current standard. |
| OD-2 | Nexus OAuth token storage: Redis vs encrypted DB columns | Redis: auto-expiry, no migration, simpler rotation; DB: survives Redis flush, easier audit | **Redis** with AES-256-GCM encryption, TTL = Nexus token expiry. Add `nexus_token_enc` Redis key `user:<userId>:nexus_token`. |
| OD-3 | Pairing-code UX (device-authorization style short code) | Implement now vs defer | ~~Defer~~ → **RESOLVED 2026-06-23: IMPLEMENT.** Under chat.v1 there is no token to paste — the SWF `register`s and shows a short link code; the user signs in (Discord/Nexus) and enters it; the relay upgrades the token in place. See the Update banner. |
| OD-4 | `token_prefix` length: 6, 8, or 10 chars | Shorter = less entropy leaked; longer = fewer false positives before argon2 | **8 chars** (48 bits leaked; 208 bits remain; with argon2id protecting the hash, risk is negligible). |
| OD-5 | Retroactive `HudIdentityBlock` migration: Option A (re-derive blocks) vs Option B (accept orphan) | See Section 7.2 | **Option B** if prod has never had HUD auth enabled; **Option A** if any blocks were issued in dev/staging. Confirm with operator. |
| OD-6 | Nexus as sole provider (no Discord) — game-link only, or also overlay/dashboard? | Dashboard currently requires Discord for role sync, embed management, etc. | ~~Game-link only~~ → **RESOLVED 2026-06-23.** Nexus is a first-class login for the **overlay + in-game basic chat** (Nexus **or** Discord), per the lockdown. The **admin dashboard stays Discord-only** — elevated/mod/dev roles require Discord (#168); a Nexus-only account is a basic user and never holds elevated roles. |

---

## 10. Implementation Notes (2026-06-24)

Implemented in worktree `chatv1-auth` (branch `feat/ingame-chatv1-auth`). Awaiting integration review.

### Schema additions (3 additive idempotent migrations)

| Migration | Table | Purpose |
|---|---|---|
| `20260624000000_auth_linked_identities` | `linked_identities` | Non-Discord provider links per user (Nexus, future providers). Discord stays inline on `users`. |
| `20260624000001_auth_hud_link_codes` | `hud_link_codes` | 8-char Crockford base32 device-auth codes. Issued by the relay per `relay_user_id` (chat.v1 identity). TTL 10 min, single-use, <=5 attempts, one active per relay identity. `redeemed_by_user_id` is set by `POST /api/link/redeem` to the authed FCM user. |
| `20260624000002_auth_banned_identities` | `banned_identities` | Provider-level deny-list (#297). Checked at OAuth callback and code redemption. |

Prisma models: `LinkedIdentity`, `HudLinkCode`, `BannedIdentity`. `User` gains `redeemedLinkCodes HudLinkCode[]` (optional FK on `redeemed_by_user_id`).

### New env vars

| Var | Default | Purpose |
|---|---|---|
| `NEXUS_OAUTH_CLIENT_ID` | `''` | Nexus OAuth client ID (confidential client). Feature-flag: Nexus routes return 503 when empty. |
| `NEXUS_OAUTH_CLIENT_SECRET` | `''` | Nexus OAuth client secret. Sent via `client_secret_post` alongside PKCE verifier. |
| `NEXUS_OAUTH_REDIRECT_URI` | derived from request host | Nexus OAuth redirect URI. Falls back to `${proto}://${host}/auth/nexus/callback`. |
| `HUD_IDENTITY_HASH_SECRET` | `''` | HMAC-SHA256 key for M6+ `identityHash = HMAC(secret, userId)`. Required before lifting production guard. |

### New endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/link/game` | requireAuth | Current link state: `{ hasLinkedProvider, fo76AccountName, providers[] }` |
| `POST` | `/api/link/redeem` | requireAuth | Redeem relay-issued code; provider gate required; binds authed FCM user to relay identity via `markRelayTokenLinked` (rate: 10/min/IP). Returns `{ success: true }`. |
| `POST` | `/api/link/pairing-token` | requireAuth + provider gate | Mint/rotate FCMHUD/1 pairing token. Body: `{ fo76Name }`. Returns `{ token }` once. (503 until relay WT1 merges `hud_pairing_tokens` + argon2.) |
| `DELETE` | `/api/link/pairing-token` | requireAuth | Revoke active pairing token. (503 until relay WT1 merges.) |
| `DELETE` | `/api/link/provider/:provider` | requireAuth | Unlink a non-Discord provider (refuses if last remaining, 409). |
| `GET` | `/auth/nexus` | none | Nexus OAuth2+PKCE initiation. `scope=openid public`, S256, `client_secret_post`. 503 when `NEXUS_OAUTH_CLIENT_ID`/`NEXUS_OAUTH_CLIENT_SECRET` absent. |
| `GET` | `/auth/nexus/callback` | none | Nexus OAuth2+PKCE callback. Token endpoint: `https://users.nexusmods.com/oauth/token`. Userinfo: `https://users.nexusmods.com/oauth/userinfo` (`sub` = stable providerUid). Binds state to the initiating session, provisions/links a lightweight FCM user, and stores only the provider UID in the session for `/link`. |
| `DELETE` | `/auth/nexus` | requireAuth | Unlink Nexus identity (refuses if last provider). |

Note: `POST /api/link/code` does **not exist**. Code issuance is relay-driven — the relay calls `issueLinkCode(relayUserId)` from `linkCodeService.ts` directly. There is no HTTP issuance endpoint.

### Integration seam for relay agent (WT1)

**Code issuance (relay → auth gate):**
The relay calls `issueLinkCode(relayUserId: string): Promise<string>` (exported from `backend/src/services/linkCodeService.ts`). `relayUserId` is the chat.v1 identity string minted by `register`. The returned raw code is shown in-game as `XXXX-XXXX`. One active code per `relayUserId` — a new call supersedes the old.

**Code redemption (auth gate → relay):**
1. User signs in at `/link` (Discord or Nexus OAuth), enters the code.
2. `POST /api/link/redeem` (requireAuth) runs provider gate, calls `redeemLinkCode(code, fcmUserId)`, which sets `hud_link_codes.used_at = NOW()` and `redeemed_by_user_id = fcmUserId`.
3. Auth gate immediately calls `markRelayTokenLinked(relayUserId, fcmUserId)` via dynamic import of `relay/relayIdentityService` (WT1). If that module is absent (WT1 not yet merged), logs a warning and continues — the relay's own poll is the fallback.
4. Writes audit log: `action = 'hud_link_code_redeemed'`, `metadata.relayUserId`.

**Relay fallback poll contract:**
```sql
SELECT relay_user_id, redeemed_by_user_id
FROM hud_link_codes
WHERE code = $1 AND used_at IS NOT NULL
```
Or call `validateAndConsume(rawCode)` from `linkCodeService.ts` (exported read-only seam) — returns `{ ok: true, relayUserId, redeemedByUserId }` or `{ ok: false, reason }`.

Once the relay has `redeemedByUserId`, it checks `users.discord_id IS NOT NULL OR EXISTS linked_identities WHERE user_id = $redeemedByUserId` to confirm at least one provider, then upgrades the relay identity from `limited` to `linked` (allows `send`).

### Discord vs Nexus status

- **Discord OAuth**: testable now using existing `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.
- **Nexus OAuth2+PKCE**: fully scaffolded. OIDC issuer: `https://users.nexusmods.com`. Confidential client — `client_secret_post` at token endpoint alongside PKCE. `scope=openid public`. Identity: `sub` claim as `providerUid`, `name` as `username`. Feature-flagged (503) when `NEXUS_OAUTH_CLIENT_ID` / `NEXUS_OAUTH_CLIENT_SECRET` absent. Testable once OAuth app is registered at `nexusmods.com/users/myaccount?tab=api`.

### Frontend

`admin-dashboard/src/features/link/LinkPage.tsx` — public route `/link`. Pip-Boy terminal aesthetic (matches `LoginPage.tsx`). States: loading, need-auth (Discord + Nexus sign-in buttons), ready (code entry form — user enters the code shown in-game), submitting, result (success/error). URL params: `?error=`, `?linked=nexus`.

### Test results

```
backend/tests/authLink.test.js    — 18 tests, all passing
  (generateLinkCode ×3, normalizeLinkCode ×3, isBannedIdentity ×2,
   unlinkProviderIdentity ×2, redeemLinkCode ×5, validateAndConsume ×3)
admin-dashboard/src/features/link/__tests__/LinkPage.test.tsx — 8 tests, all passing
```
