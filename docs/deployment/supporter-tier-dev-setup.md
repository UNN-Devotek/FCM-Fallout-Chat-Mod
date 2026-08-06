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

The dev bot already holds **Manage Roles** in the dev guild only. Create:

| Role | Purpose |
| --- | --- |
| `Supporter` | Supporter tier |
| `Overseer's Circle` | Top tier |

Colours must not collide with the reserved set (`backend/src/services/cosmetics/reservedColors.ts`)
— in particular **not** Discord blurple `#5865F2`, moderator green `#50C878`, or the
owner/admin golds. Anything in the blue-grey or teal range is safe.

Prefer extending `backend/scripts/clone-discord-layout.ts` over clicking through the UI,
so the same script provisions prod later and prints the role-ID mapping.

Record both role IDs (Discord → right-click role → Copy ID, with Developer Mode on).

## Step 2 — Enable the `GuildMembers` privileged intent

Discord Developer Portal → the **dev** application → Bot → Privileged Gateway Intents →
enable **Server Members Intent**.

This is required for `guildMemberUpdate` / `guildMemberRemove`, which is how the backend
learns a tier role was granted or removed. **Without it the gateway connection is
rejected outright**, not silently degraded — the bot will fail to start.

Dev and prod are **separate Discord applications**, so this has to be done twice. Doing
it on dev now does nothing for prod later.

## Step 3 — Set the dev environment variables

In the Dokploy `fcm-dev` compose stack environment:

```bash
SUPPORTER_ROLE_ID=<dev Supporter role id>
OVERSEER_CIRCLE_ROLE_ID=<dev Overseer's Circle role id>
SUPPORTER_TIER_ENABLED=true
# No Discord shop on dev — leave empty. The purchase CTA is hidden when it is unset,
# which is exactly what we want while testing with hand-assigned roles.
DISCORD_SERVER_SHOP_URL=
```

Note the production boot guard (`collectSupporterTierProductionErrors`) only fires when
`NODE_ENV=production`, so an empty shop URL is fine on dev.

## Step 4 — Deploy

The dev stack tracks the `dev` branch and **auto-deploys on push**, so merging the
supporter-tier branch into `dev` deploys it. The migration is idempotent and runs
through `baseline-migrations.sh` as usual.

Verify in the backend-dev logs:

```
[supporterSync] registered (GuildMemberUpdate + periodic reconcile)
[cosmetics] /cosmetics registered
```

If you instead see `[supporterSync] disabled (tier switched off, or no tier roles
configured)`, the flag or the role IDs did not land.

---

## Test matrix

Work through all four surfaces before promoting to prod.

### Website — `dev.falloutchatmod.com`

1. Profile → **Chat appearance** panel is visible.
2. Set a display name; confirm the counter, validation, and the three preview rows.
3. Pick a free colour; confirm it applies immediately in chat.
4. Supporter and Overseer colours/effects are **visible but frosted**, not hidden.
5. Clicking a locked one is rejected and names the required tier.
6. SYSTEM → **APPEARANCE** on the landing page renders the guide.

### Discord — dev guild

7. `/cosmetics help` returns an ephemeral embed.
8. `/cosmetics color` autocomplete lists free colours first, locked ones marked.
9. `/cosmetics name` opens a modal; submitting applies.
10. `/cosmetics show` embed's colour strip matches the chosen colour.
11. Locked preset → ephemeral reply naming the tier.
12. A name that trips the blacklist is rejected **without naming the pattern**.

### Grant a tier (the important one)

13. Assign the dev `Supporter` role to a test account.
14. Backend logs `[supporterSync] tier changed via GuildMemberUpdate`.
15. Supporter colours and effects unlock — **without reconnecting**.
16. The supporter badge renders in chat.
17. Assign `Overseer's Circle`; animated effects and the tag unlock.

### Lapse and restore (#230's hard rule)

18. Remove the tier role. Cosmetics revert to default within one reconcile cycle
    (15 min) or immediately via the gateway event.
19. The `supporter_entitlements` row still exists with `status='lapsed'` — **not
    deleted**.
20. Re-add the role. The user's **exact previous look** returns with no reconfiguration.

### Overlay

21. Point the DEV overlay at dev (`npm run dev:local` → `electron`). Never touch the
    packaged `Fallout Chat Mod` process, and never `Fallout76`.
22. Colours, effects, tags and badges render.
23. Settings → Appearance → **Disable animated name effects** collapses animated
    effects to their static form.

### Regression

24. A user with no `user_cosmetics` row renders exactly as before.
25. Public-mode chat still leaks no private data.

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

Do not carry the dev config across. Prod needs its own roles, its own intent toggle, and
the full go-live checklist at the bottom of
[docs/product/supporter-tier.md](../product/supporter-tier.md) — including Discord
monetization eligibility, payout/tax onboarding, publishing the rewritten Terms and
privacy policy, and sending the
[Nexus disclosure](../legal/nexus-disclosure-supporter-tier.md).
