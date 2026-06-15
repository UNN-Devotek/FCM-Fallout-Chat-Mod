# Marketing Assets (Remotion)

Promotional GIFs and stills are generated with **Remotion** from `marketing/promo/`. Rendered
assets live in `admin-dashboard/public/promo/` and are served as `/promo/<file>` by the Vite dev
server and the production build. The **ABOUT → FEATURES** tab in `LandingPage.tsx`
(`AboutFeaturesPanel`) references them by URL — no import needed.

The tooling overview lives in [`marketing/README.md`](../../marketing/README.md); this doc is the
canonical reference for the compositions and how to re-export them.

## Compositions (`marketing/promo/src/`)

| ID | File | Canvas | Type |
|----|------|--------|------|
| `ChatFeedGif` | `ChatFeedGif.tsx` | 480×490 | GIF — live feed, messages arriving |
| `WikiFlowGif` | `WikiFlowVideo.tsx` | 480×610 | GIF — /wiki & /camp search flow |
| `CommandsGif` | `CommandsGif.tsx` | 480×490 | GIF — /nukecodes /serverstatus /camp loop |
| `PartyGif` | `PartyGif.tsx` | 480×490 | GIF — party create/join/manage |
| `InfestGif` | `InfestGif.tsx` | 480×430 | GIF — /i infestation coordination |
| `ChatFeedStill` | `ChatFeedStill.tsx` | 480×530 | PNG still |
| `AutocompleteStill` | `AutocompleteStill.tsx` | 480×530 | PNG still |
| `WikiPageStill` | `WikiPageStill.tsx` | 480×690 | PNG still |
| `InfestStill` | `InfestStill.tsx` | 480×430 | PNG still |
| `CoverImage` | `CoverImage.tsx` | 1920×1080 | PNG cover |
| `Header` | `Header.tsx` | 1300×372 | PNG header banner |

## Re-exporting (run from `marketing/promo/`)

```bash
# GIFs
npx remotion render src/index.ts ChatFeedGif   ../admin-dashboard/public/promo/chat-feed.gif --codec=gif
npx remotion render src/index.ts WikiFlowGif   ../admin-dashboard/public/promo/wiki-flow.gif --codec=gif
npx remotion render src/index.ts CommandsGif   ../admin-dashboard/public/promo/commands.gif  --codec=gif
npx remotion render src/index.ts PartyGif      ../admin-dashboard/public/promo/party.gif     --codec=gif
npx remotion render src/index.ts InfestGif     ../admin-dashboard/public/promo/infest.gif    --codec=gif

# Stills
npx remotion still src/index.ts ChatFeedStill    ../admin-dashboard/public/promo/chat-feed.png
npx remotion still src/index.ts AutocompleteStill ../admin-dashboard/public/promo/autocomplete.png
npx remotion still src/index.ts WikiPageStill    ../admin-dashboard/public/promo/wiki-page.png
npx remotion still src/index.ts InfestStill      ../admin-dashboard/public/promo/infest.png
npx remotion still src/index.ts CoverImage       ../admin-dashboard/public/promo/cover.png
npx remotion still src/index.ts Header           ../admin-dashboard/public/promo/header.png
```

## Design conventions

- All GIFs use the Pip-Boy amber theme (`PRIMARY = #F5CB5B`, `CHROME = #0C0A08`,
  `DISPLAY_FONT_FAMILY` = Georgia serif).
- Each composition has a title callout above the overlay and is 480px wide with no black side padding.
- `OverlayWindow` chrome: 23px main tab row + 22px sub tab row = 45px total. Input bar: 32px.
  Content = H − 45 − 32.
- Remotion Studio: `npm run studio` from `marketing/promo/`.
