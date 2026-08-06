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
| Custom display name | yes | yes | yes |
| Curated palette | 12 colours | 12 + 11 | 12 + 11 |
| Bounded HSL picker | yes | yes | yes |
| Name-change cooldown | 30 days | 7 days | 24 hours |
| Static effects | — | Soft/Hard Glow, Heavy Outline, Chroma Split | same |
| Chat badge | — | yes | yes |
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
| Display name | yes | yes | yes |
| Name colour | yes | yes | yes |
| Tag | yes | yes | yes |
| Badge | yes | yes | as a text prefix |
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
  "currently holds the role" signal, and nothing on the hot path calls the Discord API.

Cosmetics are gated at **read** time as well as write. That is what makes
lapse-and-restore work: a lapsed supporter's stored preset rows are left untouched but
stop being served, so re-subscribing restores their exact previous look.

### One write path

Every surface calls `cosmeticsService.applyCosmetics()`. All validation, tier gating,
cooldown, blacklist, cache busting, live push and audit logging live inside it; the REST
controller and the Discord command only marshal input and translate the returned
`reason`. The two surfaces are structurally incapable of drifting.

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
| REST | `backend/src/routes/cosmetics.ts`, `controllers/cosmeticsController.ts` |
| Effect CSS | `admin-dashboard/src/features/chat/nameEffects.css` |
| Editor UI | `admin-dashboard/src/features/profile/CosmeticsPanel.tsx` |

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
| `SUPPORTER_TIER_ENABLED` | Master switch. Keep `false` until go-live |
| `DISCORD_SERVER_SHOP_URL` | Web purchase URL for the CTA |

Production **refuses to boot** if the tier is enabled while the role IDs or shop URL are
unset — otherwise Discord would take a subscriber's money while no role could ever
match. Guard: `collectSupporterTierProductionErrors()`.

Requires the **`GuildMembers` privileged intent**, enabled per Discord application —
dev and prod are separate apps, so twice.

## Go-live checklist

1. Dev sign-off across website, Discord, overlay, and in-game.
2. Create both roles in the prod guild; set the env vars.
3. Enable the `GuildMembers` intent on the prod application.
4. Discord monetization eligibility + payout/tax onboarding.
5. Publish the rewritten ToS and privacy policy; link them in-app.
6. Send the [Nexus disclosure](../legal/nexus-disclosure-supporter-tier.md).
7. Set `SUPPORTER_TIER_ENABLED=true`.
