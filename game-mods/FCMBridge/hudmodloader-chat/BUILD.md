# FCMChatWidget build, install, and verification

**Widget version:** 2.10.78. Local review candidate, audited 2026-09-12.
This is the explicit opt-in HUD-mod track. The desktop overlay never installs or modifies it.

## Status and scope

The source and local SWF/BA2 include combined General, retained-message replay protection,
stricter own-echo matching, delayed-render failure recovery, and configurable scroll bindings.
Local Haxe, backend relay, Python packaging/anchor, SWF, and decoded BA2 checks passed during
review. The candidate has not been installed, tested in-game, or published by this review;
hosted CI is still required for promotion. Earlier desktop ZFE colors/emoji confirmation is
recorded separately in [styling history](../../../docs/testing/hud-emoji-status.md).

[README.md](README.md) describes behavior. [BUILD-HISTORY.md](BUILD-HISTORY.md) preserves dated
investigations and superseded runbooks; it is not a source for current install steps.

## Requirements

- Haxe and Python 3 for compilation, normalization, and packaging; these run on Linux CI.
- Node for the JavaScript/UTF-16 emoji checks and the existing backend/overlay suites.
- A validated HUDModLoader installation and one selected ZFE/xScal provider for in-game testing.
- The provider's required native-chat methods/capabilities, verified at runtime. A version number
  alone is not sufficient. Use the [provider guide](../../../docs/overlay/zfe/modder-guide.md).

Modern widget builds do not require Bethesda's HUDMenu or FFDec recompilation. If FFDec or an
archive skill/tool is unavailable, identify that limit and use the repository's tested format
checks; do not claim those tools ran. The standalone HUDMenu path is a separate legacy build.

## Build the archive

From `game-mods/FCMBridge/hudmodloader-chat/`:

```bash
haxe build.hxml
python3 normalize_swf.py FCMChatWidget.swf
python3 ../tools/validate_swf.py FCMChatWidget.swf --require-signature FWS --require-version 32
python3 emoji/test_embedded.py
```

Normalization embeds the bundled emoji sprites for the widget and emits the required FWS v32
artifact. It is more than a version-byte edit. Validate declared length, frame rectangle, tags,
ABC blocks, and final End tag. For the reviewed candidate the stage is 400×300 at 30 fps; do not
substitute a guessed 1920×1080 SWF rectangle for the widget's actual contract.

Fingerprint an existing archive before changing it. The checked-in widget is **BTDX v1 GNRL**,
with exactly `interface/FCMChatWidget.swf`. Preserve that verified container's entry metadata:

```bash
python3 ../hudmenu-chat/ba2tool.py blobswap FCMChatWidget.ba2 /tmp/FCMChatWidget-rebuilt.ba2 \
  interface/FCMChatWidget.swf=FCMChatWidget.swf
python3 ../hudmenu-chat/ba2tool.py extract /tmp/FCMChatWidget-rebuilt.ba2 \
  interface/FCMChatWidget.swf /tmp/FCMChatWidget-extracted.swf
cmp FCMChatWidget.swf /tmp/FCMChatWidget-extracted.swf
```

Inspect the entry set/header/index metadata as well as exact decoded payload equality before
replacing the local generated BA2 with the rebuilt file. `ba2tool.py create` is available for a
new verified v1 GNRL widget archive; neither command is a universal BA2-format conversion tool.
Version-string presence alone does not prove the BA2 matches the compiled source.

## Required checks and CI

The repository's `.github/workflows/ci.yml` `gamemod-anchors` job covers the widget's Haxe logic,
source anchors, config/packaging, native adapter/auth, emoji catalogs/embedded assets, and SWF
compile validation. Run the same affected checks locally. From the widget directory:

```bash
for suite in test-*.hxml; do haxe "$suite" || exit 1; done
python3 emoji/generate.py --check
haxe -main TestFcmEmojiLayout -js /tmp/fcm-emoji-layout.js
node /tmp/fcm-emoji-layout.js
haxe -main TestFcmEmojiCommand -js /tmp/fcm-emoji-command-test.js
node /tmp/fcm-emoji-command-test.js
haxe -main TestFcmEmoji -js /tmp/fcm-emoji-test.js
node /tmp/fcm-emoji-test.js
python3 test_package.py
python3 ../hudmenu-chat/test_anchors.py
python3 ../hudmenu-chat/test_ba2tool.py
python3 ../tools/test_validate_swf.py
```

From `game-mods/FCMBridge/`, run `haxe test-native-api.hxml` and `haxe test-auth-flow.hxml`.
After Haxe edits, run available compiler diagnostics; the local fallback is
`haxe build.hxml --no-output --display FCMChatWidget.hx@0@diagnostics` in the widget directory.
From `backend/`, run `npm test -- --runTestsByPath tests/relayHandler.test.js` for relay behavior.
From `cross-platform-overlay/`, the existing `__tests__/fcm-chat-widget-logic.test.js` suite covers
JSON event boundaries. Run additional suites when their owning behavior changes.

Local success is not hosted CI success. PR CI is maintainer-label gated as described in
[the CI guide](../../../docs/testing/ci-cd-pipeline.md); follow that review process for promotion.

## Target-specific packages

After validating and selecting the rebuilt local `FCMChatWidget.ba2`:

```bash
python3 package.py --print-version
python3 package.py --target dev --provider unified --distribution website --output /tmp/FCMChatWidget-dev.zip
python3 package.py --target dev --provider unified --distribution nexus --output /tmp/FCMChatWidget-dev-nexus.zip
python3 test_package.py
```

`--target prod` stamps the production endpoint/link host. `--provider zfe|xscal` makes a
provider-specific ZIP; the default unified ZIP contains examples for either provider. Production
configuration is not deployment authorization or proof that the endpoint is enabled.

The packager checks the embedded version and target stamps. Validate the ZIP's BA2 against the
reviewed BA2 bytes and inspect its install files. Nexus distribution omits executable/script
files and rejects executable magic. Website ZIPs may contain optional Windows xScal setup helpers;
xScal/unified Nexus variants get a helper-download note; ZFE-only variants do not need it. No extender DLL is redistributed.

## Configuration and install layout

All variants include `Data/FCMChatWidget.ba2`, `Data/FCMChat.ini`, a root-level
`FCMChatWidget.hudmodloader.ini` append snippet, version stamp, manual installation, F11 menu,
keybind, customization, and emoji-license files. They do not replace `Data/hudmodloader.ini`.

| Provider package | Configuration |
| --- | --- |
| Unified | `examples/ZFE/FCMChatWidget.ini.example`, `examples/ZFE/zfe.ini.example`, `xscal.ini.example`; install only the selected provider's settings |
| ZFE | `Data/ZFE/TextChat/fragments/FCMChatWidget.ini` |
| xScal | `xscal.ini.example`, merged into `[Chat]` beside `Fallout76.exe` |

The modern ZFE fragment name matches the `FCMChatWidget` loader entry. The legacy `FCM.ini`
fragment is not its replacement. `Data/configuration/zfe.ini` `[TextChat]` overrides fragment
keys, including endpoint and `OpenChatKey`. Keep `Data/FCMChat.ini` `openKey` aligned. xScal uses
`[Chat] enabled=true` and `relayEndpoint=wss://<target>/relay`; it has no `OpenChatKey` config.
The route is `/relay`, never `/zfe-relay`.

Follow the generated `INSTALL.txt`: exit the game, merge the loader line exactly once, and append
the archive to the existing `[Archive] sResourceArchive2List`. If starting an otherwise empty
list with HUDModLoader, the relevant entries are:

```ini
[Archive]
sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2
```

Preserve all existing archives and settings. Windows normally uses Documents/My Games/Fallout 76;
Proton uses the game's prefix Documents path. Restart after changing BA2/native configuration.
Reload alone can refresh widget settings but does not reload the extender's configuration.

## Input, fonts, and customization

Both providers use SharedHUDTools first; its host editor owns the balanced game-control lock.
A legacy ZFE fallback is separate from public `input.v1.*`. Named HUD actions and physical key
polling share navigation handling, with guards keyed by normalized action name. Different aliases
can have separate latch keys; validate simultaneous named/physical delivery in-game. The shipped
navigation map is `NextPage`/`PrevPage` for Page Up/Down, `Up`/`Down` for feed scrolling, and
explicit blank values for `scrollBottomKey` and `hideKey`; feed scrolling requires a visible owned
editor. See [KEYBINDS.txt](KEYBINDS.txt).

The widget uses runtime-proven Fallout font aliases with embedded-font mode; that is not proof
that arbitrary fonts/glyphs work. Rows use plain text plus formatting ranges, with row-local
vector decorations. See [appearance](../../../docs/overlay/zfe/ingame-chat-appearance.md) and
[CUSTOMIZATION.txt](CUSTOMIZATION.txt) for supported settings and persistence precedence.
xScal persistence needs a matching relay capability/payload implementation; deployment must be
verified separately. ZFE uses vendor-scoped settings storage.

### Staff moderation commands

A linked Discord moderator/admin/owner sees message references and the F11 moderation help.
Use an exact visible name (quote multi-word names), or a short visible `[#XXXXXXXX]` reference.
Duplicate names require a reference. The widget resolves immutable target IDs locally; the relay
repeats permission, protected-target, duration, and reason checks.

```text
/mod Alice mute <minutes> <reason>
/mod "Alice Smith" kick <reason>
/mod #XXXXXXXX delete <reason>
/mod #XXXXXXXX kick <reason>
/mod #XXXXXXXX mute <minutes> <reason>
/mod #XXXXXXXX unmute <reason>
/mod #XXXXXXXX ban <minutes|permanent> <reason>
/mod #XXXXXXXX unban <reason>
```

Every action requires a nonempty reason. Mute/temporary ban accept 1–43,200 minutes; permanent
ban must be explicit. Slow mode is not implemented. `/relink` uses a supported provider reset
operation and must not claim success on a rejected reset. Credentials remain extender-owned.

## In-game acceptance checklist

1. Record game distribution/version, provider version/probe, loader registration, archive order,
   effective endpoint, and actual `chatv1-widget-v2.10.78` startup marker. Compare the installed
   BA2's decoded SWF with the reviewed build. Do not infer target from a fragment alone.
2. Confirm exactly one FCM renderer. Test linked and limited states, late account data, correct
   public account handle, invalid-token recovery, and relink failure/success.
3. Send on all six allowed channels. General shows each once with its original tag; other tabs
   filter correctly; General sends only to `global`. Private/system/wrong-room SERVER content
   must not enter the view. Hop worlds and check old SERVER history clears.
4. Send identical messages intentionally, replay old history while a new send awaits ACK, and
   reconnect after retained-ID cache eviction. Distinct messages survive; old replays cannot
   consume a newer pending row. Exercise negotiated retry and ambiguous failure behavior.
5. Test Page Up/Down while idle and editing, arrows before/after input ownership, reversed/aliased
   bindings, blank newest binding, cancel, Pip-Boy transitions, rapid edges, and unload/reload.
6. Test short/wrapped/localized names, supporter stars, known/custom/unsupported emoji, independent
   colors, narrow/wide resize, clipped history, and new-message count while scrolled.
7. Exercise delayed render failure and stale callbacks across rebuild/reload; fallback stays
   readable and old work cannot overwrite the new feed. Confirm settings persistence separately
   on each provider with the matching backend.

Use [HUD recovery checks](../../../docs/testing/hud-recovery.md) for expanded scenarios.
Do not log tokens, message bodies, names, or stable account IDs. Record sanitized status/counts,
errors, timings, artifact hashes, and which behaviors were actually observed.

## Production rollout

Building or packaging does not deploy the relay, modify a game install, or publish downloads.
The backend defaults `RELAY_PRODUCTION_ENABLED` to false; verify deployment configuration and
an authenticated target handshake before a release. Keep backend permissions/migrations and
widget capability negotiation aligned. Complete hosted CI, target/provider runtime acceptance,
and the applicable release/distribution checks before publishing. This documentation audit
performed no deployment, installed-game change, or publication.
