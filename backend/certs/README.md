# backend/certs/

TLS certificates for the HUD push TCP listener (hudPushTcp.ts).

ZFE's Text Chat live transport wraps every `host:port` endpoint in **Schannel TLS 1.2**
and does **not** validate the certificate — a self-signed cert is sufficient.

## dev/ — local development cert

`dev/hud-push.crt` and `dev/hud-push.key` are **gitignored** (private key material).
They are referenced by `.env.local`:

```
HUD_PUSH_TCP_TLS_CERT=certs/dev/hud-push.crt
HUD_PUSH_TCP_TLS_KEY=certs/dev/hud-push.key
```

### Regenerate (run from `backend/`)

```bash
mkdir -p certs/dev
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/dev/hud-push.key \
  -out    certs/dev/hud-push.crt \
  -days 730 \
  -subj "/CN=fcm-hud-dev"
```

## Production

Use a real cert (e.g. Let's Encrypt via certbot/acme.sh) or any self-signed cert — ZFE
will connect either way.  Store the paths in the production env as absolute paths.

## See also

- `docs/overlay/zfe/realtime-socket.md` — Probe findings, ZFE env vars, wire protocol
