# Marketing assets

Source-controlled tooling for the Fallout Chat Mod marketing imagery and promo
video. Everything is generated from one [Remotion](https://www.remotion.dev/)
project so the look stays consistent and is trivial to re-render after edits.

> **Theme:** matches the desktop overlay's default `fo76-wasteland` Pip-Boy
> theme — amber chrome (`#C8A840`), cream text (`#E8DFC0`), warm near-black
> background. All colors live in `promo/src/theme.ts`.

## What it produces

| Asset | Composition id | Size | Nexus slot |
|-------|----------------|------|------------|
| Header banner | `Header` | 1300×372 | **Header** (recommended 1300×372) |
| Gallery still — General feed | `StillGeneral` | 1920×1080 | **Images** (recommended 1920×1080) |
| Gallery still — Trading board | `StillTrade` | 1920×1080 | **Images** |
| Promo video | `FcmPromo` | 1280×720 MP4 | **Videos** / gallery |
| Promo GIF | `FcmPromo` | 960×540 GIF (~2 MB) | **Images** (animated) |

All stills/the GIF are ≤ 8 MB so they fit Nexus's upload limit. Gallery shots
use fake chat featuring our **real Discord custom emojis**.

## Render

```bash
cd marketing/promo
npm install          # one-time (uses public npm registry via local .npmrc)
npm run render:all   # video + gif + both stills → out/
# or individually:
npm run render:video
npm run render:gif
npm run render:still-general
npm run render:still-trade
npm run studio       # interactive preview/editor in the browser
```

The header is rendered with:

```bash
npx remotion still src/index.ts Header out/header.png
```

Outputs land in `marketing/promo/out/` (git-ignored). Copy the ones you want to
upload wherever you keep release assets.

## Editing (this is the part you'll touch)

- **Chat text, usernames, channels, which emoji** → `promo/src/content.ts`.
  Each message is `{ tag, user, text, emoji? }`. `tag` is one of
  `General | Trade | Events | Raids | Discord`. `emoji` is a filename in
  `promo/public/emojis/`.
- **Taglines / kicker / site** → also `promo/src/content.ts` (`TAGLINE`, `KICKER`, `SITE`).
- **Colors / theme** → `promo/src/theme.ts`.
- **Layout of the overlay window** → `promo/src/OverlayWindow.tsx`.
- **Banner layout** → `promo/src/Header.tsx`. **Hero/gallery layout** → `promo/src/OverlayStill.tsx`.
- **Video timing / finale card** → `promo/src/FcmPromo.tsx`.

### Adding more custom emojis

Download the PNG from Discord's CDN into `promo/public/emojis/` (animated ones
also serve a static `.png` frame), then reference the filename in `content.ts`:

```bash
curl -s "https://cdn.discordapp.com/emojis/<EMOJI_ID>.png?size=64" \
  -o promo/public/emojis/<name>.png
```

Get `<EMOJI_ID>` by typing `\:emojiname:` in Discord and copying the
`<:name:id>` token. (The full current list is documented in
`~/Downloads/discord-custom-emojis.md`.)

## Notes

- No EULA messaging and no keybind-hint bar in the marketing assets (by design).
- `node_modules/` and `out/` are git-ignored — only the source is tracked.
- Want a change? Just say e.g. "redo the header with these messages" or "make a
  Raids gallery still" and it's a content edit + re-render.
