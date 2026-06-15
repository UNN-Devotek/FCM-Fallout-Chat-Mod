# Theming

## CSS Custom Property System

The admin dashboard uses CSS custom properties (variables) as the theming layer.
They are declared in `admin-dashboard/src/index.css` and consumed both by
Tailwind utility classes (via `@theme` bridge tokens) and by inline styles in
components.

### Global Admin Dashboard Tokens (`index.css:20–37`)

These variables drive the **admin portal** (AdminLayout, all moderation pages,
navigation). They use the FO76 amber/gold palette:

| Variable | Default value | Purpose |
|----------|--------------|---------|
| `--phosphor-color` | `#d4b040` | Gold primary (brighter) |
| `--phosphor-dim` | `#b08838` | Dim gold |
| `--bg-dark` | `#1e1908` | Warm dark background |
| `--bg-panel` | `#28200e` | Panel background |
| `--bg-card` | `#322814` | Card background |
| `--border-color` | `#564418` | Amber border |
| `--text-primary` | `#f0e8cc` | Cream body text |
| `--text-secondary` | `#c0a870` | Medium tan |
| `--text-muted` | `#7a6438` | Muted dark |
| `--danger` | `#ff5555` | Error/danger |
| `--warning` | `#ffbb22` | Warning |
| `--info` | `#70b0ff` | Info |
| `--font-mono` | `"Courier New", Courier, monospace` | Monospace font |

Tailwind consumes these via the `@theme` block:
```css
@theme {
  --color-phosphor: var(--phosphor-color);
  --color-bg-panel: var(--bg-panel);
  /* ... */
}
```

This lets Tailwind utility classes like `text-phosphor` or `bg-bg-panel` resolve
to the live CSS variable value, enabling real-time theme updates without
re-renders in the admin pages.

## ChatOverlay Theme System

The **`ChatOverlay` component** has its own independent theme system, separate
from the admin dashboard tokens. Themes are defined as TypeScript objects
(`WebTheme` interface, `ChatOverlay.tsx:22–49`) and stored in the `THEMES` array
(`ChatOverlay.tsx:51–140`).

### Built-in Themes

| id | Display name | Primary colour | Glow | Scanlines |
|----|-------------|---------------|------|-----------|
| `fo76-wasteland` | Fallout 76 | `#F5CB5B` (gold) | off | off |
| `vault-tec-green` | Vault-Tec Green | `#18FF62` (Phosphor Green) | on | on |
| `amber` | Amber | `#FFB000` | on | on |
| `white` | White | `#F0F0F0` | off | off |

`vault-tec-green` is the classic Pip-Boy phosphor green default referenced
throughout the docs (`#18FF62`). The default theme on the web overlay is
`fo76-wasteland` (`ChatOverlay.tsx:265`).

### Real-Time Color Updates Without Re-Renders

The `ChatOverlay` component derives all colour values inline from the active
`WebTheme` object via helper functions (`hexToRgba`, `hexAlpha`) on every render.
It does **not** write CSS custom properties — instead it passes computed
`rgba(...)` strings directly as inline `style` props.

This means changing the theme (via the Settings modal) causes a single React
state update that flows synchronously through all derived colour values. No
separate CSS variable injection step is needed.

### Background / Text Opacity (Electron Shell)

The Electron shell writes two CSS custom properties on `document.documentElement`
to communicate user-controlled opacity without requiring React re-renders for
every slider drag:

| CSS variable | Set by | Consumed by |
|-------------|--------|------------|
| `--fcm-chrome-bg-alpha` | Electron shell | `ChatOverlay` MutationObserver (`ChatOverlay.tsx:1135`) |
| `--fcm-text-opacity` | Electron shell | `ChatOverlay` MutationObserver (`ChatOverlay.tsx:1135`) |

The `MutationObserver` watches `document.documentElement` for `style` attribute
changes and updates React state (`chromeBgAlpha`, `textOpacityOverride`) only
when the values actually change, keeping re-renders minimal.

On the website these variables are never set, so both default to `1.0` and
behaviour is identical to a fully-opaque overlay.

## Font Scaling

Monospace themes (`Courier New`) render noticeably wider/larger than the default
Segoe UI theme at the same pixel size. Each theme can declare a `fontScale`
property (default `1` for proportional fonts, `0.9` for monospace) and
`tabLetterSpacing`. The component derives:

```ts
const fontScale = theme.fontScale ?? (isMonoTheme ? 0.9 : 1);
const fontSize = Math.round(settings.fontSize * fontScale);
const lineH = Math.round(18 * fontScale);        // px line-height
const scaleGap = (px: number) => Math.round(px * fontScale);
```

`scaleGap` is used for all previously-hardcoded pixel gaps so the layout scales
consistently with the font. (`ChatOverlay.tsx:1106–1110`)

## Electron Client State Persistence

The Electron overlay persists all client-side state in a single JSON file:
`overlay-state.json` in the Electron `userData` directory.

This file is managed entirely by the Electron shell (`cross-platform-overlay/`)
and is not touched by any React code. It includes:

- Active theme id
- Window position, size, opacity
- Hotkey bindings
- Login / install-token state
- Blocked user list
- Channel filters

The React component's own web settings (`fcm_web_overlay_settings` in
`localStorage`) are used on the website only and include: `themeId`,
`windowOpacity`, `textOpacity`, `showHints`, `fontSize` (`ChatOverlay.tsx:255–269`).

See [../overlay/](../overlay/) for the Electron shell state management details.
