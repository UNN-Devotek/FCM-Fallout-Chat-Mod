# Enabling the supporter tier on dev

Runbook for switching the supporter cosmetics feature on in the hosted dev environment
so it can be tested end to end.

Design record: [docs/product/supporter-tier.md](../product/supporter-tier.md).
Binding rules: [docs/legal/monetization-policy.md](../legal/monetization-policy.md).

---

## The useful property: no money has to move

Discord Server Subscriptions **cannot** be enabled on the throwaway dev guild —
eligibility requires a Community server in good standing. That is fine, and it is a
genuine strength of the role-derived design.

Because the entitlement is derived from a Discord **role**, on dev we assign the roles
by hand and every downstream code path is byte-identical to the paid path:
`guildMemberUpdate` fires, the entitlement upserts, the tier resolves, the cache busts,
the WS push goes out, cosmetics gate, lapse and restore work.

**Only the purchase hand-off itself is untested until prod.** Everything else can be
fully verified without a payment processor.

---

## Step 1 — Create the two roles in the dev guild

The dev bot already holds **Manage Roles** in the dev guild only. The maintainer
provisioning script now creates these roles when missing (and is safe to rerun), or
they can be created manually:

| Role | Purpose |
| --- | --- |
| `Supporter` | Supporter tier |
| `Overseer's Circle` | Top tier |

Colours must not collide with the reserved set (`backend/src/services/cosmetics/reservedColors.ts`)
— in particular **not** Discord blurple `#5865F2`, moderator green `#50C878`, or the
owner/admin golds. Anything in the blue-grey or teal range is safe.

Run `backend/scripts/clone-discord-layout.ts` after the base guild layout is available;
it provisions missing tier and appearance roles and prints the target-guild IDs for the
tier roles alongside the staff role mapping. The same script can provision prod later.

Record both role IDs (Discord → right-click role → Copy ID, with Developer Mode on).

### Appearance roles

The bot mirrors saved appearance selections to Discord. Create one role for every
catalog colour label and these eight effect labels:

`Soft Glow`, `Hard Glow`, `Heavy Outline`, `Chroma Split`, `Pulse Glow`, `CRT Phosphor`,
`Glitch`, and `Shimmer`.

Do not create a role for `None`. A user gets only their selected colour role and only
their selected effect role; clearing a selection removes that family role. Keep all
appearance roles below the bot's highest role and grant the bot **Manage Roles**.
The role names are matched to the catalog labels, so no additional role IDs are added
to the stack environment.

## Step 2 — Enable the `GuildMembers` privileged intent

Discord Developer Portal → the **dev** application → Bot → Privileged Gateway Intents →
enable **Server Members Intent**.

This is required for `guildMemberUpdate` / `guildMemberRemove`, which is how the backend
learns a tier role was granted or removed. **Without it the gateway connection is
rejected outright**, not silently degraded — the bot will fail to start.

Dev and prod are **separate Discord applications**, so this has to be done twice. Doing
it on dev now does nothing for prod later.

## Step 2b — Enable nickname mirroring for the bot

The supporter star/tag is mirrored into the FCM **guild nickname** as `★ Name` or
`★ [TAG] Name`. In the dev guild, give the bot role **Manage Nicknames** and place that
role above `Supporter`, `Overseer's Circle`, and every non-owner account whose nickname
should be changed. This is independent from Manage Roles.

Discord never permits a bot to rename the **guild owner**, regardless of permission or
role position. Test this behavior with a non-owner dev supporter account; an owner will
continue to have the correct chat badge/tag but keeps their Discord nickname unchanged.

## Step 3 — Set the dev environment variables

In the Dokploy `fcm-dev` compose stack environment:

```bash
SUPPORTER_ROLE_ID=<dev Supporter role id>
OVERSEER_CIRCLE_ROLE_ID=<dev Overseer's Circle role id>
# Optional: this role receives the full Overseer cosmetics catalog for testing.
ADMIN_ROLE_ID=<dev admin role id>
SUPPORTER_TIER_ENABLED=true
# No Discord shop on dev — leave empty. The purchase CTA is hidden when it is unset,
# which is exactly what we want while testing with hand-assigned roles.
DISCORD_SERVER_SHOP_URL=
```

Note the production boot guard (`collectSupporterTierProductionErrors`) only fires when
`NODE_ENV=production`, so an empty shop URL is fine on dev.

`backend-dev` deliberately does not use `env_file`; `deploy/dev/docker-compose.yml`
explicitly forwards the supporter variables, including the `ADMIN_ROLE_ID` forwarded with
the staff-role block above. Keep that wiring with any future
compose refactor, or the dev stack will silently fall back to the disabled defaults.

## Step 4 — Deploy

The dev stack tracks the `dev` branch and **auto-deploys on push**, so merging the
supporter-tier branch into `dev` deploys it. The migration is idempotent and runs
through `baseline-migrations.sh` as usual.

Verify in the backend-dev logs:

```
[supporterSync] registered (GuildMemberUpdate + periodic reconcile)
[cosmetics] /cosmetics registered
```

If you instead see `[supporterSync] disabled (tier switched off, or no tier/admin
cosmetics roles configured)`, the flag or the role IDs did not land.

---

## Test matrix

Work through all four surfaces before promoting to prod.

### Website — `dev.falloutchatmod.com`

1. Profile → **Chat appearance** panel is visible.
2. Set a free **Chat name** in the panel above it; confirm it immediately updates the
   three appearance preview rows. Clear it and confirm FCM returns to the Fallout 76 /
   Discord-derived name.
3. Pick a free colour; confirm it applies immediately in chat.
4. Supporter and Overseer colours/effects are **visible but frosted**, not hidden.
5. Clicking a locked one is rejected and names the required tier.
6. SYSTEM → **APPEARANCE** on the landing page renders the guide.

### Discord — dev guild

7. `/cosmetics help` returns an ephemeral embed.
8. `/cosmetics color` autocomplete lists free colours first, locked ones marked.
9. `/cosmetics star` uses the same colour catalog and reports that the marker remains `★`.
10. `/cosmetics clear field:star` clears only the selected star colour.
11. `/name` opens a modal; submitting applies the same free chat name as the website.
12. `/cosmetics show` reports the effective star colour and its colour strip matches the name colour.
13. Locked preset → ephemeral reply naming the tier.
14. A name that trips the blacklist is rejected **without naming the pattern**.

### Grant a tier (the important one)

15. Assign the dev `Supporter` role to a test account.
16. Backend logs `[supporterSync] tier changed via GuildMemberUpdate`.
17. Supporter colours and effects unlock — **without reconnecting**.
18. The supporter badge renders in chat.
19. Assign `Overseer's Circle`; animated effects and the tag unlock.
20. On a **non-owner** test supporter, set a tag through `/cosmetics tag` and confirm
    their dev-guild nickname becomes `★ [TAG] Name`. Edit the tag on the website and
    confirm it changes there too. Clearing/removing the tier role restores the bare name.

### Lapse and restore (#230's hard rule)

21. Remove the tier role. Cosmetics revert to default within one reconcile cycle
    (15 min) or immediately via the gateway event.
22. The `supporter_entitlements` row still exists with `status='lapsed'` — **not
    deleted**.
23. Re-add the role. The user's **exact previous look** returns with no reconfiguration.

### Overlay

24. Point the DEV overlay at dev (`npm run dev:local` → `electron`). Never touch the
    packaged `Fallout Chat Mod` process, and never `Fallout76`.
25. Colours, effects, tags and badges render.
26. Settings → Appearance → **Disable animated name effects** collapses animated
    effects to their static form.

### Regression

27. A user with no `user_cosmetics` row renders exactly as before.
28. Public-mode chat still leaks no private data.

### In-game

Not yet applicable — in-game colour rendering is still gated on the ZFE field-passthrough
probe. See [docs/overlay/zfe/README.md](../overlay/zfe/README.md#client-version-handshake-clientversion).

---

## Turning it back off

Set `SUPPORTER_TIER_ENABLED=false` and redeploy. The feature goes completely inert and
**no stored data is touched**, so switching it back on restores every user's previous
look exactly.

---

## Before prod

Do not carry the dev config across. Prod needs its own roles, its own intent toggle, its
own **Manage Nicknames** permission and role hierarchy for the bot, and
the full go-live checklist at the bottom of
[docs/product/supporter-tier.md](../product/supporter-tier.md) — including Discord
monetization eligibility, payout/tax onboarding, publishing the rewritten Terms and
privacy policy, and sending the
[Nexus disclosure](../legal/nexus-disclosure-supporter-tier.md).
