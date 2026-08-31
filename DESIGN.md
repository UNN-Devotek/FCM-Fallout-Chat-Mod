---
version: alpha
name: Fallout Chat Mod
description: A Fallout 76 community chat UI styled as a readable retro terminal.
colors:
  primary: "#F5CB5B"
  secondary: "#C9A84E"
  accent-green: "#18FF62"
  surface: "#0A0907"
  surface-chrome: "#0C0A08"
  text: "#FAF4DA"
  muted-text: "#C0A870"
  error: "#FF4444"
  star-supporter: "#7EA8F7"
  star-overseer: "#FD4DA6"
typography:
  heading:
    fontFamily: "Fira Code, Consolas, monospace"
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 1px
  body:
    fontFamily: "Fira Code, Consolas, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: 0
  label:
    fontFamily: "Fira Code, Consolas, monospace"
    fontSize: 10px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 1px
rounded:
  none: 0px
  sm: 2px
  md: 4px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  chat-identity:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    badgeGap: 4px
    badgeVerticalAlign: baseline
  supporter-star:
    glyph: "★"
    supporterColor: "{colors.star-supporter}"
    overseerColor: "{colors.star-overseer}"
    fontWeight: 700
    lineHeight: 1
  appearance-swatch:
    rounded: "{rounded.sm}"
    size: 30px
  overlay-window:
    minWidth: 320px
    minHeight: 280px
    topEdgeGuard: 0px
---

## Overview

Fallout Chat Mod uses the Fallout 76 Pip-Boy and a 1970s military terminal as its
visual reference: compact monospace text, phosphor colors, hard-edged borders, and
quiet CRT glow. The UI should feel like an instrument panel that stays readable while
the game is visible behind it.

## Colors

Warm gold is the primary system color, with muted wheat for secondary copy and bright
green for activity or success. The near-black surfaces remain translucent in the
desktop overlay. Supporter and Overseer stars use their own explicit colors, selected
from the shared appearance catalog when a user customizes them.

## Typography

Monospace text is used throughout chat and controls to preserve the terminal reference.
Headings and labels are bold with measured letter spacing; message copy stays compact
and readable rather than decorative.

## Layout

Chat identity rows use baseline alignment so tags, the immutable star, the username,
and the message body share one text rhythm. Gaps are small and explicit. The Electron
window is clamped to the display work area, with a hard top-edge guard so its top
remains visible after launch, drag, resize, restore, or animation.

## Elevation & Depth

The interface is mostly flat. Borders, low-alpha chrome fills, and restrained text
shadows separate controls from the game scene. Effects must not change layout or move
identity text.

## Shapes

Use square or very small radii. Swatches and compact controls use 2px to 4px corners;
the overlay itself remains frameless.

## Components

The shared ChatOverlay owns identity rendering on the website and Electron overlay.
The supporter badge is a fixed star glyph, never user-controlled text. Its color is a
separate appearance value, while the existing name color continues to control the
username and tag. Website and overlay appearance editors expose the same catalog and
write through the same API.

## Do's and Don'ts

- Do preserve a clear baseline between the star and the username.
- Do validate star values server-side and fall back to the tier default.
- Do keep appearance controls usable at narrow widths.
- Do keep the top of the desktop overlay inside its monitor work area.
- Don't allow message payloads to replace the star glyph.
- Don't use a different chat identity renderer for the overlay.
- Don't use large rounded cards, unbounded glow, or animation that shifts text.
