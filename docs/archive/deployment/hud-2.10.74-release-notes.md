# FCM HUD Mod 2.10.74

HUD-only release. Desktop overlay versions and downloads are unchanged.

- Fixed message wrapping across the full chat box width, including after resizing.
- Restored separate channel colors, chosen name colors, standard message text colors,
  and the independently colored supporter star.
- Added inline Unicode and bundled custom Discord emoji artwork while preserving
  the styled layout. Animated custom emojis display a static image.
- Send emojis using `/emoji <name>`, such as `/emoji smile`, `/emoji heart`, or an
  exact custom Discord emoji name.
- Includes automatic reconnect, queued-send recovery, and shared online presence
  improvements introduced since the previous public HUD package.
- One HUD file supports both xScal and ZFE, with configuration examples for each.

Installation: close Fallout 76, replace the HUD file, and follow the included
instructions for your extender. For xScal, enable `[Chat] enabled=true`. For ZFE,
check both the fragment and `Data/configuration/zfe.ini` so the endpoint targets
Prod (`wss://falloutchatmod.com/relay`).

Please test wrapping at different sizes, chosen name colors and stars, Unicode and
custom emojis, channel switching, and reconnecting after leaving/joining a world.
Report bugs with your extender/version, HUD version, and reproduction steps.

Scope: no desktop overlay installer, AppImage, .deb, version, or download is replaced.
