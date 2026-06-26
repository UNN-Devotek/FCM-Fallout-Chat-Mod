# chat.v1 under Proton / Wine — BLOCKED (upstream Zig TLS bug)

**Status (2026-06-26): BLOCKED, upstream-only. Tracked in issue #326.**

ZFE's `chat.v1` native chat relay works end-to-end on **native Windows** (ZFE 0.9.9+), but
**crashes the game under Proton/Wine** (Linux / Steam Deck) on connect. The crash is in ZFE's
bundled Zig TLS client, not in FCM's relay or the CA bundle, and there is **no client-side
workaround**. The fix is upstream: ZFE rebuilt on **Zig >= 0.14.0**.

Until that build ships, **Linux / Steam Deck users use the native desktop overlay** (no ZFE) for
chat — see [../../README.md](../../README.md) (Electron overlay) and
[../README.md](README.md) (chat.v1 relay overview).

---

## Symptom

`chat.v1.connect` panics the game under Proton/Wine — a Zig panic / `__fastfail`. The host CA
bundle loads fine first; the crash happens later, during the first TLS read.

## Root cause — Zig `std.crypto.tls.Client.readvAdvanced` partial-read panic

ZFE's chat.v1 transport is a Zig TLS client. The crash is a known Zig standard-library bug:
`std.crypto.tls.Client.readvAdvanced` does an out-of-bounds `@memcpy` on a **partial socket read**
(when a TLS record arrives split across multiple `read()` calls). Upstream Zig issues:
**#15226 / #15673 / #14573**. The sibling error type `TlsConnectionTruncated` is present in the
binary.

Why it is **deterministic under Proton but intermittent on native Windows:** Wine's socket layer
fragments reads more aggressively, and Cloudflare's TLS 1.3 record padding makes the fragmented,
partial-read code path hit on essentially every connection. On native Windows the reads usually
arrive whole, so the bug rarely triggers.

## Confirming evidence (ZFE 0.9.11 logging)

ZFE 0.9.10 added Wine detection (`wine_get_version`), the Zig TLS client, and system CA-bundle
loading from the Wine `Z:` paths; chat still crashed. ZFE 0.9.11 added explicit TLS CA logging that
confirms the CA bundle is **not** the cause:

- `chat.v1 TLS CA source: wine_pem_bundle` — under Wine the CA comes from the host PEM bundle (the
  Windows certificate store path `windows_store` is used on native Windows).
- `chat.v1 TLS Wine PEM CA bundle loaded: path=… certBytes=… certs=149` — the bundle **loads
  successfully** (149 certs), **then** the crash occurs in the TLS read.

So the CA bundle is ruled out: `CertificateAuthorityBundleTooBig` only trips near a ~4 GB `u32`
overflow, nowhere near a normal ~150-cert bundle.

0.9.11 also corrected misleading logging: the `Schannel/Winsock` line is the **legacy Text Chat**
(SFE-compat) transport — now labeled `Legacy Text Chat transport backend` — **not** chat.v1.
chat.v1 uses its own Zig TLS client + the host PEM CA bundle.

## Why there is no client-side workaround

- **Plaintext `ws://` loopback is refused.** ZFE will not `autoRegister` over an insecure endpoint
  even with `[TextChat] AllowLocalhostDevelopment=yes` (that flag enables the localhost endpoint, not
  insecure autoRegister).
- **A local `wss://` proxy doesn't help** — it still runs ZFE's buggy Zig TLS client to reach the
  proxy.
- **No escape hatch in config/env** — there is no environment variable or `zfe.ini` setting to skip
  certificate verification or override the CA path. See
  [../env-vars.md](../env-vars.md).

## The fix (upstream)

The ZFE author rebuilds ZFE with **Zig >= 0.14.0**, which includes **Zig PR #20587** — the fix for
the `readvAdvanced` partial-read panic. Zig 0.14.0 is a released toolchain on `ziglang.org/download`.
(Zig development has since moved to `codeberg.org/ziglang/zig`; the old GitHub issue/PR references
above remain readable.)

## ZFE version history (chat.v1-relevant)

| Version | chat.v1 behavior |
|---------|------------------|
| 0.9.8 | `chat.v1.sendMessage` → `dispatch_failed` (ZFE-side; the send never dispatched to the relay). |
| 0.9.9 | Dispatch fixed → **send works on native Windows.** This is the build the working Windows path needs. |
| 0.9.10 | Added Wine detection + a Zig TLS client + system CA-bundle loading (Wine `Z:` paths); chat still crashed under Wine. |
| 0.9.11 | Corrected the misleading `Schannel/Winsock` log line (it is the legacy transport); added the chat.v1 TLS CA-source / PEM-bundle logging that confirmed the CA bundle is not the cause. |

## Linux install notes

- **No Steam launch option is required** on CachyOS — ZFE's `dxgi.dll` proxy loads without
  `WINEDLLOVERRIDES`. The usual `WINEDLLOVERRIDES="dxgi=n,b" %command%` is harmless but unnecessary
  here.
- **Interim Linux chat path:** the native **desktop overlay** (Electron, no ZFE) — it is unaffected by
  this bug. Use it on Linux / Steam Deck until ZFE ships the Zig-0.14.0 build.

## See also

- [README.md](README.md) — chat.v1 relay overview and current status
- [../README.md](../README.md) — ZFE / FCMBridge integration index
- [../env-vars.md](../env-vars.md) — ZFE env-var surface (and why there is no TLS-skip / CA-override)
- Issue **#326** — the upstream Proton/Wine tracking issue
