# HUD Mod Compatibility — FCMBridge / FCMChatWidget

This document covers how `FCMBridge` and the two-way chat patch coexist (or conflict) with
HUDModLoader and the most common FO76 HUD mods. It is primarily a **user-facing shipping decision
guide** and an **internal engineering reference** for when and how to build each variant.

---

## Summary

- **HUDModLoader ships its own `hudmenu.swf`** — it replaces the vanilla file with a bootstrapped
  version that can dynamically load widget SWFs listed in `hudmodloader.ini`. Installing
  HUDModLoader means HUDModLoader **owns** `hudmenu.swf`.
- **Our standalone patch also owns `hudmenu.swf`** — the two-way-chat variant patches the base HUD
  SWF and repacks it into a `.ba2`. A user cannot install both a standalone-patched `.ba2` and
  HUDModLoader without one silently winning based on `sResourceArchive2List` load order.
- **Our HUDModLoader variant patches HUDModLoader's `hudmenu.swf` base** — this is the correct
  approach: patch the HUDModLoader base (from `HUDModLoader.ba2.fcmbak`) so the widget loader
  survives and all other HUDModLoader widgets (BuffsMeter, Server Player List, etc.) keep working.
- **Merging multiple `hudmenu.swf` replacements without a loader framework is not practical** —
  SWF files are compiled binaries; binary merging is not supported. HUDModLoader is the established
  solution for the ecosystem.
- **`sResourceArchive2List` is last-loaded-wins** for conflicting filenames; whichever `.ba2` is
  listed last in `Fallout76Custom.ini` takes precedence for `Interface/HUDMenu.swf`.

---

## HUDModLoader Mechanism

**Source:** [HUD Mod Loader on Nexus Mods](https://www.nexusmods.com/fallout76/mods/3144) /
[fallout76mods.com mirror](https://www.fallout76mods.com/hud-mod-loader-v60-4-1/)

HUDModLoader is the standard widget framework for FO76 HUD modding (actively maintained as of
May 2025, currently v60.4.1).

### How it works

1. **It ships its own `hudmenu.swf`** inside `HUDModLoader.ba2`, added to the end of
   `sResourceArchive2List`. This file bootstraps a dynamic SWF loader (ActionScript 3) on top of
   the vanilla HUD code.
2. **`hudmodloader.ini`** (in `Fallout76/Data/`) is the widget registry. Each widget SWF that opts
   into the framework is listed here. HUDModLoader reads this file at runtime and loads each SWF
   into the HUD.
3. **Widget SWFs do NOT touch `hudmenu.swf` themselves.** They ship as separate `.swf` files
   inside their own `.ba2` archives. HUDModLoader orchestrates their lifecycle. This is what allows
   many mods to coexist.
4. **Mods that bypass the framework** (shipping their own `hudmenu.swf` replacement inside a `.ba2`)
   will conflict with HUDModLoader if that archive loads after `HUDModLoader.ba2` in the list —
   or conversely silence HUDModLoader if it loads later.

### Load order (sResourceArchive2List)

FO76 resolves conflicting filenames by **last-entry-wins**: whichever `.ba2` appears latest in
`sResourceArchive2List` provides the winning file. Because HUDModLoader instructs users to add
`HUDModLoader.ba2` at the **end** of the list, it typically wins. Any other mod that also ships a
`hudmenu.swf` replacement and is appended after HUDModLoader will overwrite it (and vice versa),
silently breaking whichever loaded earlier.

Source: [BA2 Archive Load Order tool (Nexus Mods)](https://www.nexusmods.com/site/mods/1581)

---

## HUD-Editing Mod Survey

The table below covers the most common FO76 HUD mods relevant to FCMBridge deployment decisions.

| Mod | Approach | Replaces `hudmenu.swf`? | HUDModLoader widget? | Notes |
|-----|----------|------------------------|---------------------|-------|
| **HUDModLoader** | Framework — ships its own bootstrapped `hudmenu.swf` | Yes — it IS the replacement | N/A (is the loader) | v60.4.1, May 2025. All other widget mods depend on it. |
| **HUDEditor / iHUD** | Customizable HUD layout editor | Yes — ships as a HUDModLoader-loaded widget (after framework update) | Yes | Originally a direct replacer; now officially supported through HUDModLoader. Source: [Nexus](https://www.nexusmods.com/fallout76/mods/953) |
| **BuffsMeter** | Active effects display widget | No (standalone SWF) | Yes | Compatible with TextChat, HUDModLoader, HUD Condition, Challenges, Server Player List, etc. Updated Jan 2025. Source: [Nexus](https://www.nexusmods.com/fallout76/mods/2821) |
| **Server Player List** | Server population overlay | No (standalone SWF) | Yes | Tested working with BuffsMeter, Perk Loadout Manager, HudEditor, Improved Health Bars. Source: [Nexus](https://www.nexusmods.com/fallout76/mods/2811) |
| **Improved Bars and HUD** | Health/AP/weight bar redesign | No (standalone SWF) | Yes | Integrated with HUDModLoader. Source: [Nexus](https://www.nexusmods.com/fallout76/mods/3106) |
| **Keretus' Improved Health Bars** | Health bar reskin | No (standalone SWF) | Yes | HUD notification jam fix included; works with HUDModLoader. Source: [Nexus](https://www.nexusmods.com/fallout76/mods/2966) |
| **HUD Challenges and Events** | Season/event tracker widget | No (standalone SWF) | Yes | Compatible with overlay HUDModLoader, Improved Social Menu. Updated Jan 2025. Source: [Nexus](https://www.nexusmods.com/fallout76/mods/2860) |
| **HUD Condition** | Armor/weapon condition display | No (standalone SWF) | Yes | Source: [Nexus](https://www.nexusmods.com/fallout76/mods/3114) |
| **HudBar Percent Widgets** | Bar-percentage labels | No (standalone SWF) | Yes | Source: [Nexus](https://www.nexusmods.com/fallout76/mods/3124) |
| **Custom Crosshair** | Crosshair replacement | No (standalone SWF) | Yes (via framework) | Basis for HUDEditor's codebase. Dev stopped 2020; HUDModLoader handles loading. Source: [Nexus](https://www.nexusmods.com/fallout76/mods/551) |
| **RR HUD** | Full HUD visual overhaul | **Yes** — direct `hudmenu.swf` replacer | No | Explicitly states: "not compatible with any mod that modifies hudmenu.swf." Cannot coexist with HUDModLoader or our standalone. Source: [fallout76mods.com](https://www.fallout76mods.com/rr-hud/) |

**Key insight from the survey:** the ecosystem has largely migrated to the HUDModLoader widget
model. RR HUD is the only common mod surveyed that still ships a direct `hudmenu.swf` replacement
and explicitly documents the incompatibility.

---

## Coexistence Analysis

### FCMBridge (polling/push feed widget — `FCMChatWidget.swf`)

`FCMChatWidget.swf` is a **pure HUDModLoader widget** — it ships as a separate SWF listed in
`hudmodloader.ini` and does not touch `hudmenu.swf`. It is therefore:

- **Compatible with HUDModLoader**: yes, by design.
- **Compatible with all other HUDModLoader widgets** (BuffsMeter, Server Player List, etc.): yes —
  they share the same loader and have no interaction with each other's code.
- **Compatible with RR HUD or any other direct `hudmenu.swf` replacer**: **no**. If a user
  installs RR HUD (or any non-HUDModLoader `hudmenu.swf` replacer) after HUDModLoader in the load
  order, HUDModLoader's bootstrap is silenced and the widget loader never runs — neither
  `FCMChatWidget.swf` nor any other widget loads.

### Two-Way Chat patch (patched `HUDMenu.swf`)

Two variants are built by `apply-patch.py`:

| Variant | Base SWF | `hudmenu.swf` owner | Coexists with HUDModLoader? | Coexists with vanilla HUD users? |
|---------|----------|--------------------|-----------------------------|----------------------------------|
| **HUDModLoader variant** | `HUDModLoader.ba2.fcmbak` (HUDModLoader's base) | HUDModLoader | **Yes** — patch preserves HUDModLoader's widget loader intact | No — requires HUDModLoader installed |
| **Standalone variant** | `SeventySix - Interface.ba2` (vanilla) | FCMBridge mod | **No** — overwrites or is overwritten by HUDModLoader depending on load order | Yes |

### Can the two variants be merged into one?

No — not without choosing which base to patch. The two bases are different compiled SWF binaries.
Patching vanilla produces a file that has no widget loader; patching HUDModLoader's base produces
a file that does. There is no third binary that covers both.

### Is binary SWF merging a general solution?

**No.** SWF files are compiled ActionScript bytecode + asset tables. There is no supported tooling
in the FO76 mod ecosystem for merging two `hudmenu.swf` replacements into one output. (A tool
called `SWFMerge` exists for Fallout 4 but is not applicable to FO76's engine version and SWF
format.) The correct FO76 pattern — which the ecosystem standardized on — is to patch the
HUDModLoader base and ship only HUDModLoader-targeted files.

---

## Recommendation

### For FCMBridge feed display (no two-way chat)

**Ship `FCMChatWidget.swf` as a HUDModLoader widget.** This is the current production approach.
It requires no `hudmenu.swf` involvement and is compatible with the entire HUDModLoader widget
ecosystem. Users without HUDModLoader must install it — treat HUDModLoader as a required
dependency, like ZFE.

### For two-way chat

**Ship only the HUDModLoader variant** as the primary release. The rationale:

1. The HUDModLoader user base is the target audience (they are already modding their HUD).
2. Patching HUDModLoader's base preserves the widget loader — other widgets (BuffsMeter, etc.)
   continue working alongside FCMChat.
3. HUDModLoader is actively maintained (May 2025) and handles engine-version HUD changes, reducing
   our maintenance burden.

**The standalone variant** (patches vanilla) should be built and offered as an explicit
"no-HUDModLoader" alternative, clearly documented as:
- Incompatible with HUDModLoader.
- Incompatible with any other mod that ships a `hudmenu.swf` replacement (RR HUD, etc.).
- The user's only HUD mod — they must remove all other `hudmenu.swf` sources.

### Hybrid standalone: patch HUDModLoader's base without requiring HUDModLoader?

A "hybrid standalone" would mean shipping the HUDModLoader-base-patched SWF but without the user
having HUDModLoader installed. **This is viable only if** the patched SWF is self-contained — i.e.,
the HUDModLoader widget-loader code in the base doesn't crash or hang when no widgets are listed /
no `hudmodloader.ini` is present.

In practice: HUDModLoader's `hudmenu.swf` is designed to gracefully no-op when no widgets are
configured (the ini is empty or absent). So a user who installs only our patched
`HUDModLoader.ba2` (without installing HUDModLoader separately) would get the patched HUD and
no other widgets — which is functionally equivalent to the standalone. **This is the preferred
approach**: maintain a single HUDModLoader-base build and document it as working both with and
without other HUDModLoader widgets. Drop the vanilla-base standalone variant once confirmed stable.

This eliminates the two-variant maintenance overhead and gives future users the cleanest upgrade
path (they can add more HUDModLoader widgets later without rebuilding FCMChat's SWF).

---

## Open Questions

1. **Does HUDModLoader's `hudmenu.swf` no-op cleanly when `hudmodloader.ini` is absent or empty?**
   Needs one smoke-test: install only the FCMChat-patched `HUDModLoader.ba2`, no `hudmodloader.ini`,
   launch game, confirm no crash and that FCMChat works. If it does, drop the vanilla-base variant.

2. **Load-order fragility when `FCMChatWidget.swf` + HUDModLoader coexist with other HUDModLoader
   widgets that have their own socket usage.** No known conflict today, but undocumented.

3. **RR HUD users.** We cannot support them without an RR-HUD-base patched variant, which would
   require RR HUD's consent and would be fragile (they change their `hudmenu.swf` with every
   game patch). Not recommended — document it as a hard conflict.

4. **Future game updates breaking HUDModLoader's `hudmenu.swf`.** When Bethesda updates the base
   HUD, HUDModLoader releases a new version. We must re-apply our patch to the new HUDModLoader
   base. The `apply-patch.py` anchors are written to match both vanilla and HUDModLoader arg styles
   (`two-way-chat-implemented.md §7`), so re-patching should be mechanical — but it requires a
   human each time HUDModLoader updates.

5. **Source of truth for HUDModLoader's architecture.** The HUDModLoader GitHub repo
   (`GitCrazy-wc/hudmodloader`) returned 404 during research; the Nexus page is not crawlable
   without authentication. The mechanism described here is inferred from mod documentation,
   community descriptions, and direct experimentation (§7 of `two-way-chat-implemented.md`).
   If the repo becomes public or accessible, confirm the widget-loading internals.
