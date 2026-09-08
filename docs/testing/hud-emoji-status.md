# HUD styling and emoji test status

Last updated: 2026-09-08. Last confirmed desktop test: **2.10.72**, connected to Prod.
The **2.10.73** compatibility candidate is installed on the desktop against Prod
and awaits in-game confirmation. Installed BA2 SHA-256:
`f70d61320189e8619f781d22d3e4418abf24aef801d673fa1629b74fbce85467`.
This record covers the optional in-game HUD, not the desktop overlay renderer.

## Confirmed observations

- The user reports the styling is correct in 2.10.72. The supplied screenshot shows
  a colored General label, a separate colored supporter star/name, and emoji blocks.
- Emoji sends reach Discord and the desktop overlay. The `/emoji` command can send
  successfully even when the HUD cannot display the result.
- The desktop xScal log identifies `chatv1-widget-v2.10.72` and repeatedly reports
  `kept styled row; step=emoji-plan: TypeError: Error #1014`.
- The optional processing failure retains the styled baseline. Emoji images are
  **not working in the observed HUD test**; placeholders remain visible.
- Haxe/JavaScript tests, SWF linkage checks, packaging checks, and offline FFDec
  sprite previews passed. Those checks do not establish Fallout runtime support.

The screenshot alone does not establish the behavior of every Unicode sequence or
custom Discord emoji. It does not verify ZFE, laptop behavior, every resize setting,
or every theme. Both providers share source code, but runtime verification is separate.

## Diagnosis boundary

The recorded error occurs at `emoji-plan`, before native sprite decoration. The exact
missing runtime class/dependency is unknown. Do not treat BitmapData, font coverage,
letter spacing, or sprite linkage as the established root cause of this latest error.
Fallback raw Unicode can show missing-glyph blocks; the presence of those blocks does
not prove that the sprite renderer ran or that its artwork is corrupt.

The 2.10.69/70 BitmapData/TextFieldEx substitution implementation is superseded.
The native sprite implementation replaced it in 2.10.71. That build still fell into
the plain emergency feed. In 2.10.72 the earlier styled renderer builds a complete
baseline before optional emoji work, restoring styling without rolling back commands,
queued sends, reconnects or other transport updates.

## 2.10.73 candidate

- Replaces the planner's map/interface and generic string-conversion paths with an
  array-based binary lookup and direct strings. The earlier exact missing class
  remains unconfirmed; this is a compatibility change based on decompiled dependencies.
- Checks every catalog sequence (5,273, including custom IDs) in Haxe and JavaScript,
  exercising the different string ordering and UTF-16 offsets.
- Retains the styled baseline and uses readable emoji names if planning succeeds
  but optional sprite decoration fails. A planner failure can still retain raw glyphs.
- Separates planning, catalog initialization, layout, and sprite-placement diagnostics.
- Uses the same renderer for xScal and ZFE. A subsequent desktop xScal log identifies
  build 2.10.73 and reports `native sprites placed`, with no recorded planner or
  decoration fallback errors. This confirms that path executed, not visual correctness.
- Desktop switched to the locally preserved pre-xScal ZFE loader for the next test;
  HUD 2.10.73 and the Prod endpoint are unchanged. ZFE runtime verification is pending.
  The previous xScal loader/config are preserved in the game directory under
  `FCM-extender-backup-before-zfe-20260908-154747`.

## Remaining verification

1. Identify the class/dependency behind the `emoji-plan` error in the actual runtime.
2. Verify Unicode and custom emoji pictures in-game, separately on xScal and ZFE.
3. Check adjacent emoji, skin tones, flags, joined sequences, mixed text, narrow/wide
   resizing, clipping, and continued independent channel/name/body/star colors.
4. Confirm unknown/unsupported emoji have readable fallbacks rather than blocks.
5. Recheck `/emoji` sending and reconciliation through disconnect/reconnect and history.

Animated custom artwork is currently bundled as static images; animation is not
implemented. Public website/Nexus HUD downloads were not replaced by these local tests.
No runtime completion or release claim should be based solely on a passing build.

## ZFE user result and 2.10.74 diagnostic

The user confirms emojis worked with ZFE on 2.10.73, but reports chosen name colors
missing on their own and other users. Version 2.10.74 adds aggregate reception and
rendering color counts to locate the loss; it is not a confirmed color fix.

## ZFE endpoint mismatch identified

The 2.10.74 log shows the pending local name color disappearing on a live echo
with `wireNameColors=0` / `carrierNameColors=0`. Read-only database checks found
those test messages in Dev, not Prod. The sending Dev account had cosmetics enabled
but neither a chosen preset nor a custom name color. This is an environment/account
mismatch, not evidence that ZFE stripped a supplied name color.

The active `Data/configuration/zfe.ini` `[TextChat] Endpoint` still targeted Dev,
although `Data/ZFE/TextChat/fragments/FCMChatWidget.ini` targeted Prod. Earlier claims
that the ZFE tests were connected to Prod were based on checking only the fragment
and were incorrect. The global endpoint is now corrected to Prod with a backup.
Restart and verify actual Prod delivery before marking this resolved in-game.

## Final user confirmation

After correcting the global ZFE endpoint to Prod, the user confirmed 2.10.74 works.
Chosen name colors and emoji rendering are confirmed for this desktop ZFE test.
Earlier diagnostic and failure records above are historical, not current limitations.
