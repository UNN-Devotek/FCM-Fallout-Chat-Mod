# Dev supporter-star wire capture — 2026-09-02

This is a live capture from `wss://dev.falloutchatmod.com/relay` using a
`clientVersion` of `2.10.29`, a poll cursor of `1000546`, and `max: 1`. The
relay token is intentionally omitted. The captured message is historical Dev
data; the IDs and text below are evidence, not a test fixture to hard-code.

## Exact relay event frame

```json
{
  "op": "event",
  "cursor": 1000547,
  "event": {
    "id": 1000547,
    "kind": "chat.message",
    "messageId": "0aab0bad-ee80-4f1d-ba72-e29a48e0852f",
    "channel": "global",
    "senderUserId": "fab83731-27f0-4b75-a2a4-b7fd1425aafa",
    "senderDisplayName": "Devotek-",
    "body": "yes",
    "targetUserId": "FCMHUD/1;s=1;c=%23FD4DA6;t=X",
    "createdAt": "2026-06-30T16:24:55.709Z",
    "nameColor": "#FD5F1C",
    "effectId": "glitch",
    "tag": "X",
    "badges": [
      "overseer"
    ],
    "starColor": "#FD4DA6",
    "supporterStar": true
  }
}
```

## Exact poll response

The corresponding raw relay request was `{ "op": "poll", "cursor": 1000546,
"max": 1 }`; the bearer token is omitted here.

```json
{
  "success": true,
  "events": [
    {
      "id": 1000547,
      "kind": "chat.message",
      "messageId": "0aab0bad-ee80-4f1d-ba72-e29a48e0852f",
      "channel": "global",
      "senderUserId": "fab83731-27f0-4b75-a2a4-b7fd1425aafa",
      "senderDisplayName": "Devotek-",
      "body": "yes",
      "targetUserId": "FCMHUD/1;s=1;c=%23FD4DA6;t=X",
      "createdAt": "2026-06-30T16:24:55.709Z",
      "nameColor": "#FD5F1C",
      "effectId": "glitch",
      "tag": "X",
      "badges": [
        "overseer"
      ],
      "starColor": "#FD4DA6",
      "supporterStar": true
    }
  ]
}
```

## Boundary diagnosis

- **Confirmed:** neither `senderDisplayName` nor `body` contains `★`. This is
  not a Unicode glyph/font failure at the relay boundary.
- **Confirmed:** the supporter marker is a separate boolean and color field,
  and the native-known `targetUserId` carrier contains the same marker as
  `FCMHUD/1;s=1;c=%23FD4DA6;t=X`.
- **Confirmed:** `FCMChatWidget.hx` parses the additive fields and the carrier,
  then stores `supporterStar` and `starColor` in each `ChatRecord`.
- **Confirmed:** the v2.10.29 Dev renderer did not read those fields when it
  built the HTML row. Commit `d770c5b` removed the embedded bitmap renderer,
  the star HTML helper, and the star assets. The v2.10.29 behavior captured here
  was therefore tag-only by design, even when the wire data was correct. v2.10.30
  adds a guarded vector renderer; this capture remains the proof that the relay
  fields were already present.
- **Deduced:** ZFE normalization may still remove undeclared additive fields,
  but that is not the remaining blocker for a capable widget: the carrier is
  the intended fallback. The remaining blocker is the missing HUD render step.

The native `chat.v1.pollEvents` wrapper returns its value to the widget as
`rs`, but the current Dev widget logs only counters after parsing. Therefore
this document records the exact relay response; a literal post-ZFE `rs` capture
still requires a Dev diagnostic build that logs the raw return string before
parsing.

## Acceptance contract for the next Dev star build

1. Never put `★` into `senderDisplayName` or `body`.
2. Keep `supporterStar`, `starColor`, and the `FCMHUD/1;...` carrier additive
   and server-authoritative.
3. Restore one tested non-glyph renderer in the HUD (embedded bitmap, vector,
   or another proven Scaleform asset). Do not fall back to U+2605.
4. Test raw relay consumers and native HUD consumers separately, because ZFE
   may drop undeclared event members while preserving `targetUserId`.
5. The visual result must be exactly one colored supporter star beside the
   author, with no literal `★`, no `FCMHUD...` text leakage, no tofu blocks,
   and no duplicate on send acknowledgements/live echoes.
