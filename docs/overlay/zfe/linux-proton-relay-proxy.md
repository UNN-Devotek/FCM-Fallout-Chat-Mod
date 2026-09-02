# Linux/Proton relay stability — loopback TLS proxy

**Problem.** Under Wine/Proton, ZFE's Schannel TLS handshake to the network relay
(`dev-relay-direct.falloutchatmod.com:443`) intermittently times out (`recv failed with WSA
error 10060`), especially on the long-lived **subscribe (receive)** connection — so the in-game
feed shows nothing / "relay unreachable". The relay itself is fine (verified by host-side WS
probes); it's Wine's *network* TLS that's flaky. Root fix is upstream (ZFE Zig-0.14 TLS rebuild,
#326). This doc is the **client-side workaround** that makes Linux/Proton stable today.

> Windows users do **not** need this — native Schannel handshakes are reliable. This is
> Linux/Steam-Deck only, and it lives entirely at the OS layer, **not** in the `.ba2` (a game-UI
> asset can't run a daemon, edit `/etc/hosts`, or touch the trust store — nor should it).

## Architecture
```
ZFE (Wine/Schannel)
   │  wss to dev-relay-direct:443  ── /etc/hosts maps it to 127.0.0.1
   ▼
socat OPENSSL-LISTEN 127.0.0.1:443   ← terminates TLS LOCALLY (loopback never times out)
   │  wss (host OpenSSL, reliable)
   ▼
real relay  67.222.144.10:443  (SNI dev-relay-direct → Traefik → backend)
```
Wine's flaky network TLS is replaced by a reliable **loopback** handshake; the genuinely-flaky
network leg is handled by the host's solid OpenSSL. Upstream blips (deploys/restarts) just cause
an instant loopback re-handshake instead of the slow Wine network retry.

## Components (on the tester's Linux box, under `~/.config/fcm-relay-proxy/`)
- Local 10-year CA + a loopback cert for `dev-relay-direct.falloutchatmod.com` (no LE private-key
  exfil, no 90-day renewal). The CA is added to the **system trust store** so Wine/Schannel (which
  reads `/etc/ssl/certs`) accepts the loopback cert.
- `fcm-relay-proxy.service` — systemd unit running `socat` on `127.0.0.1:443`.
- `install.sh` / `uninstall.sh` — distro-aware CA trust (Arch `trust`/`update-ca-trust`,
  Debian `update-ca-certificates`), `/etc/hosts` entry, service enable.

## Install / verify / revert
```bash
# install (needs root; pkexec pops a GUI auth prompt, or use sudo)
pkexec bash ~/.config/fcm-relay-proxy/install.sh

# verify
systemctl status fcm-relay-proxy                         # active (running), enabled
getent hosts dev-relay-direct.falloutchatmod.com          # -> 127.0.0.1
echo | openssl s_client -connect dev-relay-direct.falloutchatmod.com:443 \
      -servername dev-relay-direct.falloutchatmod.com 2>/dev/null | grep "Verify return"
                                                          # -> Verify return code: 0 (ok)
journalctl -u fcm-relay-proxy -f                          # per-connection activity

# in-game: zfe.log should stop showing `schannel.connect.failed ... WSA error 10060`
#          and the feed should load + hold.

# revert
pkexec bash ~/.config/fcm-relay-proxy/uninstall.sh        # back to dialing the relay directly
```

## Notes
- `socat` upstream uses `verify=0` (dev rig; the upstream is the known relay over the host network).
- If Wine still rejects the cert in-game, import `ca.crt` into the FO76 Proton prefix
  (`compatdata/1151340/pfx`) via `wine certutil -addstore Root ca.crt` — but the system-store path
  above is the primary and verified-working one.
- Distribution to QA testers = this one-time installer (or a packaged `.deb`/AUR helper), **never**
  bundled into the `.ba2`. See [README.md](README.md) and #326.
