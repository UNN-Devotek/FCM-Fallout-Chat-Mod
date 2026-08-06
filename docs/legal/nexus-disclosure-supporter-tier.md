# Nexus Mods disclosure — Supporter tier (DRAFT, not yet sent)

**Status:** draft for the project owner to review and send.
**Must be sent before** `SUPPORTER_TIER_ENABLED=true` in production.

## Why send this

The project has an existing precedent for proactive disclosure: auto-update was removed
for Nexus Mods ToS compliance and that position was disclosed to Nexus support rather
than waiting to be asked (`docs/overlay/auto-update.md`). Introducing any paid element
to a project with a Nexus listing is exactly the kind of change worth raising first —
the downside of asking is a clarifying reply, and the downside of not asking is losing
the listing.

Send via the same Nexus support channel used for the auto-update disclosure, so the
correspondence stays on one thread.

---

## Draft message

> Subject: Proactive disclosure — optional supporter subscription for Fallout Chat Mod (mod 4082)
>
> Hello,
>
> I maintain Fallout Chat Mod (Fallout 76, mod ID 4082). I previously contacted support
> to disclose that I had removed the mod's auto-updater to comply with your terms. I am
> writing again, proactively, about a change I want to check with you before it goes
> live.
>
> I am adding an **optional supporter subscription** to the project's own chat service.
> I want to be explicit about what it does and does not touch, because I would rather
> adjust the design now than find out later that it crosses a line.
>
> **What the subscription unlocks:** cosmetic personalisation of a user's name inside my
> own chat application — extra name colours, visual effects on the name, a short tag,
> and a badge. That is the complete list.
>
> **What it does not touch:**
>
> - Every functional feature of the mod and the chat service remains free: chat,
>   channels, parties, moderation, the desktop overlay, and the in-game HUD mods.
> - The files hosted on Nexus are fully functional with no paid component, no
>   supporter-only code paths, and no prompts to pay.
> - There is no early access. No build, feature, fix, or download is released to
>   subscribers ahead of anyone else.
> - There is no in-game advantage of any kind. The cosmetics apply to my chat layer, not
>   to Fallout 76.
>
> **How it is billed:** through Discord's built-in server subscription system. Discord is
> the merchant of record; I do not process payments myself. The subscription is presented
> as supporting the project's hosting and development costs.
>
> I have written these constraints into an internal policy document that the code is
> tested against, so the "cosmetics only" boundary is enforced rather than merely
> intended.
>
> If any part of this conflicts with your terms, please tell me and I will change it
> before launch — keeping the listing in good standing matters more to me than any
> individual feature. If it is fine as described, a short confirmation would let me
> proceed with confidence.
>
> Thank you,
> [name] — Fallout Chat Mod

---

## After sending

1. Record the date sent and any reply in this file.
2. If Nexus requests changes, apply them and update
   `docs/legal/monetization-policy.md` before launch.
3. Only then flip `SUPPORTER_TIER_ENABLED=true` in production.

| Event | Date | Notes |
| --- | --- | --- |
| Draft written | 2026-08-06 | |
| Sent | _pending_ | |
| Reply received | _pending_ | |
