# Supporter tier and chat cosmetics

Design record for the paid supporter tier (epic #223). User-facing documentation lives
in the website's Cosmetics guide and in `/cosmetics help`, not here.

**Binding constraints:** [monetization policy](../legal/monetization-policy.md).
**Terms:** [`docs/TERMS.md`](../TERMS.md) §11. **Privacy:** [`docs/PRIVACY.md`](../PRIVACY.md).

---

## Tiers

| | Vault Dweller (free) | Supporter | Overseer's Circle |
| --- | --- | --- | --- |
| Price (web) | $0 | $4/mo | $10/mo |
| Curated palette | 12 colours | 12 + 11 | 12 + 11 |
| Bounded HSL picker | yes | yes | yes |
| Static effects | — | Soft/Hard Glow, Heavy Outline, Chroma Split | same |
| Chat badge | — | `★` (hover: Supporter), color selectable in Appearance | `★` (hover: Overseer's Circle), color selectable in Appearance |
| Animated effects | — | — | Pulse Glow, CRT Phosphor, Glitch, Shimmer |
| Custom tag | — | — | yes |
| **Every functional feature** | yes | yes | yes |

The supporter palette has **11** colours, not 12: the vivid-violet band has nothing that
clears the contrast floor while staying clear of the reserved Discord tag purple
(`#B57AFF`). A near-miss violet would be either hard to read or indistinguishable from
channel chrome, so the slot is left empty rather than filled badly.

## Where each cosmetic renders

| | Dashboard | Overlay | In-game |
| --- | --- | --- | --- |
| Free chat name | yes | yes | yes |
| Name colour | yes | yes | yes |
| Tag | yes | yes | yes |
| Badge | yes | yes | as a text prefix |
| Star colour | yes | yes | yes, via the same solid HUD color path |
| Effects | yes | yes | **never** |

Effects can never render in-game. Scaleform crashes *Fallout 76* on any `.filters`
assignment (`FCMChatWidget.hx` crash rule #1 — "violations crashed the game in
production") and bans `StyleSheet`. This is a permanent platform limit. Every surface
that offers an effect says so before purchase.

---

## Architecture

### Entitlement is orthogonal to `EffectiveRole`

`SupporterTier` (`utils/supporterTier.ts`) is a separate axis from `EffectiveRole`.
Entitlements live in `supporter_entitlements`, keyed by `discord_id`, never in
`admin_users` — that table is reserved for elevated staff and `isPrivilegedRole()` must
keep returning false for supporters. This is a deliberate deviation from the wording of
issue #230.

### Entitlement vs privileges (#230's hard rule)

- The `supporter_entitlements` row is the **entitlement**. It survives the user leaving
  the Discord — they keep what they paid for.
- **Privileges** follow the live Discord role. `supporterSyncService` flips `status` to
  `lapsed` when the role disappears, so cosmetics revert; re-adding it restores them with
  no re-purchase.
- Because sync keeps `status` in lockstep with the role, `status === 'active'` *is* the
  "currently holds the role" signal. Gateway events and the periodic reconcile normally
  maintain it; authenticated HUD sends additionally refresh the linked member's Discord
  roles at most once per minute across the deployment via a Redis distributed slot, before
  message cosmetics are resolved. Transient Discord failures preserve the last known state.

Cosmetics are gated at **read** time as well as write. That is what makes
lapse-and-restore work: a lapsed supporter's stored preset rows are left untouched but
stop being served, so re-subscribing restores their exact previous look.

### One write path

Every cosmetic surface calls `cosmeticsService.applyCosmetics()`. All validation, tier gating,
blacklist, cache busting, live push and audit logging live inside it; the REST
controller and the Discord command only marshal input and translate the returned
`reason`. The website Profile → **Chat appearance** panel and the native overlay
Settings → **Appearance** editor are equivalent self-service surfaces. The overlay
uses its install-bound `X-Auth-Token` and a self-only `/api/overlay/cosmetics` route;
it never sends a target user id. The two surfaces are structurally incapable of drifting.

The chat name is deliberately not a cosmetic or a supporter feature. It lives on
`users.chat_name`, has no tier gate or calendar cooldown, and is changed through
`chatNameService.setChatName()` from Profile → **Chat name** or the Discord `/name`
modal. `null` restores the normal Fallout 76 / Discord-derived name.

Historical messages resolve the current appearance at delivery time rather than storing a
cosmetic snapshot. That makes a colour/effect selection persist across channel switches,
reconnects and history reloads, while keeping the original message content unchanged.

The supporter marker is guarded separately from user text. `SUPPORTER_STAR_GLYPH` is the
only rendered glyph and the client rejects non-hex star colors at the final render boundary.
`starColorPresetId` stores an optional catalog choice; when it is absent, invalid, or no
longer entitled, the effective tier default is used. Website Profile → **Chat appearance**
and overlay Settings → **Appearance** expose the same free and supporter color catalog.

### Appearance command contract

The Discord `/cosmetics` command mirrors the website and overlay appearance controls:

| Command | Rule |
| --- | --- |
| `/cosmetics color` | Select a catalog color for the username. |
| `/cosmetics star` | Select a catalog color for the supporter marker; the rendered glyph is always `★`. |
| `/cosmetics effect` | Select a desktop/web-only effect; never an in-game effect. |
| `/cosmetics tag` | Set an Overseer's Circle tag shown before the name, including in-game. |
| `/cosmetics clear field:star` | Restore the tier-default star color without changing the other fields. |

`/cosmetics clear` with no field resets every appearance field, including the star color.
The star color is an independent catalog selection, is tier-gated by the same validator as
username colors, and is only rendered when the account has an active Supporter or
Overseer's Circle entitlement. A lapsed entitlement keeps its saved selection and restores
it when the role returns.

### Payment provider

**Discord Server Subscriptions.** Discord is merchant of record (handles VAT/sales tax
worldwide) and grants the tier role natively, so no payment webhook endpoint exists.
`supporter_entitlements.source` (`discord_sub | patreon | stripe | manual`) keeps a
future provider change an adapter rather than a rewrite.

---

## Files

| Area | Path |
| --- | --- |
| Pure tier rules | `backend/src/utils/supporterTier.ts` |
| Contrast + HSL maths | `backend/src/utils/colorContrast.ts` |
| Catalog | `backend/src/services/cosmetics/presets.ts` |
| Reserved colours | `backend/src/services/cosmetics/reservedColors.ts` |
| Validation (pure) | `backend/src/services/cosmetics/validation.ts` |
| Write path | `backend/src/services/cosmetics/cosmeticsService.ts` |
| Entitlements | `backend/src/services/supporterService.ts` |
| Discord role sync | `backend/src/services/supporterSyncService.ts` |
| `/cosmetics` command | `backend/src/services/cosmeticsCommandService.ts` |
| Free `/name` command | `backend/src/services/chatNameCommandService.ts` |
| Free chat-name write path | `backend/src/services/chatNameService.ts` |
| REST | `backend/src/routes/cosmetics.ts`, `controllers/cosmeticsController.ts` |
| Effect CSS | `admin-dashboard/src/features/chat/nameEffects.css` |
| Editor UI | `admin-dashboard/src/features/profile/CosmeticsPanel.tsx` |
| Native overlay editor | `cross-platform-overlay/src/supporterAppearance.ts` (mounted in Settings → Appearance) |
| Star marker contract | `backend/src/services/cosmetics/star.ts`, `admin-dashboard/src/features/chat/supporterBadge.ts` |

## Catalog gates (enforced in CI)

`presets.test.ts` fails the build if any colour:

- drops below **WCAG 4.5** worst-case contrast across all four surfaces a name renders
  on, or
- comes within **70 RGB units** of a role, theme, or channel colour (impersonation), or
- is within 40 units of another colour in the same tier (indistinguishable in the picker).

Two findings worth preserving:

- Checking contrast against a mid-grey "because the overlay is transparent" is the naive
  model and rejects nearly every usable colour. Every surface paints a multi-layer black
  outline behind the glyph, so **that outline** is what the colour is read against.
- A flat lightness floor for the custom picker cannot work: luminance weights blue at
  0.0722 versus green at 0.7152, so saturated blue needs ~76% lightness while green
  clears the bar far lower. `minLightnessForHue()` computes the floor per hue, so the
  guarantee holds without washing out warm hues.

## Animation strategy

Per-message effects are **pure CSS**, driven by `--fcm-name-color` and
`--fcm-name-outline` set inline plus a static `.fcm-name-fx--<id>` class. The feed is
virtualized and memoized, and the Electron overlay draws on top of a running game —
JS-driven animation would take frames from *Fallout 76* and break memoization.

Motion is used **only** in `CosmeticsPanel`. `noMotionInOverlay.test.ts` walks the real
ChatOverlay import graph transitively and fails CI if Motion ever becomes reachable
from it.

Effects **compose with** the outline rather than replacing it, which is why the outline
is handed to CSS via a custom property — an inline `text-shadow` would win the cascade
and silently flatten every effect to a plain name.

## Configuration

| Var | Purpose |
| --- | --- |
| `SUPPORTER_ROLE_ID` | Discord role for the Supporter tier |
| `OVERSEER_CIRCLE_ROLE_ID` | Discord role for Overseer's Circle |
| `SUPPORTER_TIER_ENABLED` | **Master kill switch. Defaults to `false`, including in production.** |
| `DISCORD_SERVER_SHOP_URL` | Web purchase URL for the CTA |

### The kill switch

`SUPPORTER_TIER_ENABLED` gates the WHOLE feature, not just the purchase CTA. With it
off — the default everywhere, including production — the feature is completely inert:

- no cosmetics are attached to any chat message (chat renders byte-identically to
  before the feature existed), and `resolveCosmetics` returns without touching Redis
  or Postgres, so it costs nothing
- `applyCosmetics` refuses writes
- every `/api/cosmetics/*` and `/api/supporter/*` route 404s
- the `/cosmetics` Discord command is never registered and its listener never attaches
- the supporter role-sync listeners and the reconcile job never start
- the Profile editor and the Appearance guide render nothing (the catalog fetch 404s)

Stored rows are never touched while off, so flipping it on restores everyone's previous
look exactly. This means the branch can be merged and deployed to production with zero
observable change, and the commercial launch is a separate, deliberate act.

`supporterKillSwitch.test.js` asserts all of the above, plus one regression: the route
guard must be applied PER ROUTE, never as `router.use()`. This router is mounted at
`/api` because it owns several unrelated sub-paths, so a router-level guard ran for
every request under `/api` and 404'd the entire API whenever the tier was off. The
integration suites caught it (23 failures across health, mcp and wiki).

Production **refuses to boot** if the tier is enabled while the role IDs or shop URL are
unset — otherwise Discord would take a subscriber's money while no role could ever
match. Guard: `collectSupporterTierProductionErrors()`.

Requires the **`GuildMembers` privileged intent**, enabled per Discord application —
dev and prod are separate apps, so twice.

## Enabling on dev

See [docs/deployment/supporter-tier-dev-setup.md](../deployment/supporter-tier-dev-setup.md)
for the runbook and full test matrix. The short version: Server Subscriptions cannot be
enabled on the throwaway dev guild, so the roles are assigned by hand — and because the
entitlement is role-derived, every downstream path is identical to the paid one. **No
money has to move to test this feature.**

## Go-live checklist

1. Dev sign-off across website, Discord, overlay, and in-game.
2. Create both roles in the prod guild; set the env vars.
3. Enable the `GuildMembers` intent on the prod application.
4. Discord monetization eligibility + payout/tax onboarding.
5. Publish the rewritten ToS and privacy policy; link them in-app.
6. Send the [Nexus disclosure](../legal/nexus-disclosure-supporter-tier.md).
7. Set `SUPPORTER_TIER_ENABLED=true`.
