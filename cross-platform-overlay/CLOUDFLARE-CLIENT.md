# Cloudflare Client Identity — Electron Overlay

This document describes exactly what the Fallout Chat Mod cross-platform Electron
overlay sends to `falloutchatmod.com` so the infra agent can configure WAF
allowlist rules that prevent the app from being challenged or blocked.

---

## User-Agent

Every outbound request from the Electron main process (`main.js`) carries:

```
FalloutChatMod-Overlay/<version> (Electron <electron_version>; +https://falloutchatmod.com)
```

Example (app v1.3.56, Electron 31):

```
FalloutChatMod-Overlay/1.3.56 (Electron 31.7.7; +https://falloutchatmod.com)
```

The token `FalloutChatMod-Overlay/` is stable and safe to match on as a WAF
condition. The `+https://falloutchatmod.com` contact URL follows RFC 9309 convention.

---

## Auth Headers

| Header | Present on | Value |
|--------|-----------|-------|
| `X-App-Client-Key` | `POST /api/users` (register) only | Shared client key from `APP_CLIENT_KEY` env var |
| `X-Auth-Token` | All authed HTTP requests (`/api/*`, `/auth/ws-ticket`) and WebSocket upgrade | Session token issued by the backend `POST /api/users` |
| `Origin` | All requests | `https://falloutchatmod.com` |

There is no cookie-based session. The app authenticates by presenting one of the
two headers above on every request. The register call always carries
`X-App-Client-Key`; every subsequent call carries `X-Auth-Token`.

---

## Paths the App Hits

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/api/users` | Register / re-register; sends `X-App-Client-Key`. One call per app launch. |
| `GET`  | `/api/*`     | All API calls proxied from the renderer. Bearer-authed with `X-Auth-Token`. |
| `GET`  | `/auth/ws-ticket` | Answered synthetically by main.js; not actually forwarded to the backend. |
| `GET`  | `/api/auth/discord-status/:installToken` | Discord link status check. |
| `WSS`  | `/ws` | WebSocket upgrade. `X-Auth-Token` + `User-Agent` in the handshake headers. |
| `GET`  | `/downloads/electron/*` | Auto-update feed and installer download (`electron-updater`). |

---

## Recommended WAF Allow Rule

Create a **skip** (bypass challenge) rule that matches ANY of the following
conditions. All three are stable, non-spoofable signals the app always presents:

```
(http.user_agent contains "FalloutChatMod-Overlay/")
OR
(http.request.headers["x-app-client-key"] ne "")
OR
(http.request.headers["x-auth-token"] ne "")
```

Scope: apply this rule to the relevant hostname and paths. If you want to be
narrower, restrict to:

```
http.host eq "falloutchatmod.com"
AND (
  starts_with(http.request.uri.path, "/api/")
  OR starts_with(http.request.uri.path, "/ws")
  OR starts_with(http.request.uri.path, "/downloads/electron/")
)
AND (
  http.user_agent contains "FalloutChatMod-Overlay/"
  OR http.request.headers["x-app-client-key"] ne ""
  OR http.request.headers["x-auth-token"] ne ""
)
```

Action: **Skip → WAF managed rules** (and optionally skip Bot Fight Mode for the
UA match, since the app is a non-browser client and will fail JS challenges).

---

## Rate-Limit Interaction

The backend has its own rate-limiter on `POST /api/users` (register). CF may also
apply a rate-limit rule on top. The desktop client:

- Calls `POST /api/users` **once per app launch** (not per WebSocket reconnect).
- On a `429` response it waits **10 seconds** before retrying, up to 3 automatic
  retries. After 3 retries it surfaces an error to the user who can manually retry.
- On a `403`/`503` with `cf-mitigated` header or HTML body (CF challenge/WAF
  block) it waits **5 seconds** before retrying, up to 3 retries.

Recommended CF rate-limit for `/api/users`: allow at least 5 requests per 60
seconds per IP (covers rapid dev restarts). Tighter limits risk false-positives on
shared NATs.

---

## Notes for infra agent

1. **WebSocket**: CF proxies WebSocket on `wss://falloutchatmod.com/ws`. The
   `ws` npm library sends the upgrade with `X-Auth-Token`, `User-Agent`, and
   `Origin` headers in the HTTP handshake — these are visible to CF WAF rules.

2. **No JS challenge**: the Electron main process is NOT a browser. It cannot
   solve CF JS/Turnstile challenges. Any managed rule that issues a JS challenge
   to this UA will permanently block the app until the rule is adjusted. Use
   "skip" or "allow" actions only for requests matching the above criteria.

3. **`X-App-Client-Key` on register**: this header is only ever sent on
   `POST /api/users`. Matching on its presence (non-empty) is sufficient to
   identify a legitimate app registration attempt without needing to know the
   secret value in the WAF rule.

4. **Updater requests**: `electron-updater` fetches `/downloads/electron/` with
   its own UA (electron-builder-based). The download URLs served are standard
   HTTPS — CF CDN caching is fine for these.
