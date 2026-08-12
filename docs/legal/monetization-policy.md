# Monetization policy (internal, binding)

This is the rule set the Supporter tier is built to. It exists because the project sits
inside two policy regimes that both restrict monetization — Nexus Mods' terms and the
Bethesda EULA — and because "we'll just gate one small feature" is exactly how projects
lose their Nexus listing.

**These rules are not aspirational. They are enforced in code and in CI.**

---

## The rules

### 1. Cosmetics only. Never functionality.

The Supporter tier may gate **only** how a user's name appears in chat: colour, visual
effect, tag, badge.

It may **never** gate, restrict, degrade, rate-limit, or delay:

- chat, channels, parties, private messages, or message history
- moderation tools, reporting, or appeals
- the desktop overlay or any of its features
- the in-game HUD mods
- wiki/CAMP lookups, giveaways, or any other utility
- update availability or download speed

If a proposed perk would make a non-paying user's experience *worse* in any functional
respect, it is out of scope. The test is not "does the free tier still work" — it is
"is the free tier unchanged".

### 2. Nexus-hosted files stay free and fully functional

Anything published on Nexus Mods must work completely without payment, with no
supporter-only code paths, no nag prompts, and no degraded behaviour. The `.ba2` HUD
mods render supporter colours for *other* users, but a non-supporter installing them
loses nothing.

### 3. No early access

No build, feature, fix, or download may be released to supporters first. Nexus Mods
policy treats timed exclusivity as paid-mod content, and it is the most common way
projects fall foul of it.

### 4. No advantage inside Fallout 76

Nothing purchasable may confer any in-game benefit. Cosmetics apply to the FCM chat
layer, which is the Developer's own service, not to the game.

### 5. Say what renders where, up front

Effects cannot render in-game (Scaleform bans `.filters` — see below). The pricing page,
the Profile panel, the `/cosmetics` autocomplete and the user guide all state this
before purchase, rather than in fine print afterwards. Selling something a user
reasonably expects to see where they play, and then not delivering it there, is a
consumer-fairness problem independent of any platform policy.

---

## Where these rules are enforced

| Rule | Enforcement |
| --- | --- |
| Cosmetics only | The tier gate is only ever consulted in `cosmeticsService`. No functional code path reads `SupporterTier`. |
| Supporter ≠ privilege | `isPrivilegedRole()` returns false for supporters; entitlements live in `supporter_entitlements`, never in `admin_users`. Asserted in tests. |
| Effects are never claimed in-game | `presets.test.ts` asserts `inGameSupported === false` for every effect. |
| Free tier is not shrunk to sell the paid one | `presets.test.ts` asserts the free palette is not smaller than the paid palette. |
| No impersonation of staff via colour | `presets.test.ts` asserts every preset stays clear of role colours. |

---

## Why effects cannot render in-game (permanent)

`FCMChatWidget.hx` documents this as crash rule #1: *"violations crashed the game in
production"*. Any `.filters` assignment in Scaleform crashes *Fallout 76* outright, and
`StyleSheet` is banned as well. Glow, gradient, and animation are therefore
**permanently** impossible in the in-game HUD — this is a platform limit, not a backlog
item. In-game supports solid `#RRGGBB` name colours and text tags, and that is the
complete set.

---

## Disclosure posture

The project has an existing precedent: auto-update was removed for Nexus Mods ToS
compliance, and that position was disclosed proactively to Nexus support
(`docs/overlay/auto-update.md`). The Supporter tier follows the same posture — see
`docs/legal/nexus-disclosure-supporter-tier.md`.

If Nexus Mods asks for a change, the change gets made. Keeping the listing matters more
than any individual perk.

---

## Changing this policy

Any proposal to relax rule 1, 2, or 3 requires an explicit written decision from the
project owner recorded in this file, plus a fresh disclosure to Nexus Mods **before**
shipping. Do not treat a passing CI run as permission.
