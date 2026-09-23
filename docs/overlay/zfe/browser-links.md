# HUD browser links

The FCM client targets the supplied [ZFE browser-v1 contract](zfe-browser-links-v1-author-spec.md).
ZFE's implementation is forthcoming; a compiled client or passing mock does not establish native support.
The selected chat provider must be ZFE and its general `getRuntimeInfo` must report
`success:true` and the exact `zfe-browser-v1` capability. Chat capability alone is insufficient.
Current xScal builds retain readable links; the [xScal proposal](../../archive/overlay/zfe/xscal-browser-links-proposal.md)
is a separate maintainer handoff, not an implemented API.

## Player interaction

Open chat, select a message with Up/Down, then press the configured `activateLinkKey`
(default Enter with an empty draft). The row displays the literal complete URL, including
transport-provided destinations behind friendly labels; its text is selectable. Selection previews
the URL with escaped markup. URLs remain in the feed after rejection or cancellation.
Incoming messages, history, echoes, rendering and editor cancellation never initiate browser requests.
The first text URL is selected; structured transport URLs retain their exact query and fragment.
HTTP links remain readable but ZFE accepts only valid HTTPS destinations on effective port 443.

FCM synchronously begins a URL-bound action from its activation handler, immediately requests it,
and retains the opaque request ID only while pending. Polling runs every 250 ms; terminal, unknown,
malformed and error responses stop it. There are no retries or fallback launchers. `handed_off`
means the OS accepted the handoff, not that the page loaded; `launch_unknown` is inconclusive.
A defensive 45-second client deadline cancels and stops a provider that never terminates.
Reconnect (including delayed retries), bridge rediscovery, panel rebuild/hide and widget shutdown cancel using the original bridge,
stop the timer and discard state. Normal editor close does not destroy the owning widget.
ZFE owns foreground-loss handling, consent and held-input release.

Command-result links require a later explicit selection/activation. This implementation does not
mint origin-scoped actions for asynchronous slash-command results, infer their correlation from
chat text, or auto-open them. The native text-input fallback delivers submission by polling;
ZFE must verify that route's genuine player activation or reject it. No timer creates authority.

## Configure site allowances

Edit the source `game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.ini` to choose packaged
defaults, or the installed `Data/ZFE/TextChat/fragments/FCMChatWidget.ini` while the game is closed:

```ini
[BrowserLinks.Sites]
https://discord.com=allow
https://discord.gg=allow
https://www.falloutbuilds.com=allow
https://falloutbuilds.com=allow
https://fallout.wiki=allow
https://nukacrypt.com=allow
https://steamcommunity.com=allow
https://store.steampowered.com=allow
```

These eight exact origins are bundled at the user's request: Discord channels/events/invites,
Fallout Builds builds/Minerva guides, Fallout Wiki articles, NukaCrypt game data, and Steam
profiles/community/store pages. “Fallout Wiki” means the independent `fallout.wiki`; Fandom and
other subdomains are not implicitly allowed. Steam custom-protocol links are not HTTPS and remain
unsupported. The list is identical in dev and prod packages and does not grant local dev origins.
Disclose the purpose of every additional bundled origin. Use exact HTTPS origins, not wildcard
domains: `www.example.org` and `example.org` are separate sites. No paths, query strings,
fragments, credentials, IP/local hosts or non-default ports. Limits are 128 origins and 16 KiB per
fragment. Packaging preserves this section in the active ZFE fragment (or the ZFE example for
other provider/distribution combinations); xScal-only installs gain no ZFE service.

This is an allowance list, **not** a strict deny-everything-else list. ZFE may prompt for an
unlisted site after player activation. FCM does not implement a competing permission engine.
In remembered mode, an inherited allowance can skip the prompt after deliberate local activation.
Defaults apply across supported ZFE mods in that session. The player remains in control:

- Player JSON rules override site rules in `zfe.ini`, which override active fragment allowances.
- `Mode=off` disables opening; `Mode=ask` prompts except for effective blocks.
- `Mode=allow_all` is an explicit player-only override of site rules, including blocks.
- `UseModDefaults=false` ignores mod allowances. A player `ask` rule revokes inherited auto-approval;
  deleting a player rule restores inheritance. Changes to files take effect at the next launch.

FCM never writes `zfe.ini` or the player's BrowserPermissions JSON. See the supplied contract for
corrupt-file handling, persistent consent, precedence and exact validation rules.

## Verification and native acceptance

`test-browser.hxml` exercises the request state machine and `test-link.hxml` covers link helpers;
both run in `gamemod-anchors`. The full `hud-ruffle` suite includes `browser-links` scenarios for
both providers: passive rendering, literal destination, cancellation, activation, unsupported
xScal, reconnect and unload, plus compiled state-machine cases. Native dialogs and OS dispatch are
mocked, never launched by the harness.

Before declaring native support, test the actual capability-bearing ZFE release on Steam and
Game Pass, keyboard/mouse/controller, fullscreen/windowed/borderless: fresh press versus held input,
empty Enter versus Escape, shared editor versus native fallback, URL query/anchor preservation,
all consent modes and precedence, focus loss, unload/reconnect, denial, rate limit, absent browser,
and uncertain handoff. Check that cancelled input never opens and that the full host remains
readable before activation at supported HUD sizes. Keep the build native-unverified until these pass.

Local verification (2026-09-18): all widget `test-*.hxml` suites, native adapter/auth suites,
background bridge state/export/package checks, source anchors, BA2-tool tests, package tests,
Haxe diagnostics and FWS v32 validation passed. Final full Ruffle run: **56 passed (4.2m)**,
including both browser scenarios. New pure tests are wired into CI; hosted CI was not run.
Generated test SWFs are not a release package. No BA2 release or game installation was performed;
ZFE capability-bearing native acceptance remains outstanding.
