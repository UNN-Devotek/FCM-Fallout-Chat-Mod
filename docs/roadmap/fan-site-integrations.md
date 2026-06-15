# Fan-Site & Wiki Integrations

Researched options for pulling Fallout 76 data from community fan sites and wikis into the
chat/overlay app. Compiled June 2026 from a multi-agent research sweep covering Nukes &
Dragons, Nuka Crypt, the Fandom/Nukapedia wiki, and the broader FO76 tool ecosystem.

> **Architecture rule for all of these:** proxy every external call through the backend
> with short-TTL Redis caching. Never call these endpoints directly from the Electron
> renderer — it protects us from CORS surprises and from undocumented endpoints flaking.
> The two "real" APIs below (nuke codes, server status) are both **undocumented**, so build
> graceful fallbacks and consider a courtesy heads-up to the site owners before depending on
> them in production.

---

## Shipped / In progress

### ✅ Server status — `/serverstatus`
- **Source:** `GET https://api.bethesda.net/status/ext-server-status?product_id=8` (semi-official, no auth)
- **Response:** `{ platform: { response: { fallout76: "UP" } } }`
- **Surface:** baked-in slash command `/serverstatus` (also `/server-status`), in-feed bot reply.
- **Cache:** Redis, ~60s TTL.
- **Risk:** Low-Med (undocumented but read-only, widely used by community tools).

### ✅ Nuke codes — `/nukecodes`
- **Source:** `GET https://api.nukacrypt.com/api/codes` (undocumented, no auth)
- **Response:** `{ date, since_epoch, ALPHA, BRAVO, CHARLIE }`
- **Surface:** baked-in slash command `/nukecodes` (also `/codes`), in-feed bot reply.
- **"Valid until":** `since_epoch + 604800s` (weekly rotation).
- **Cache:** Redis, ~30 min TTL.
- **Risk:** Low-Med. Community precedent exists (a Nexus overlay mod does exactly this).
  **Action item:** ping NukaCrypt's owner (Echsarah) for a blessing + agree attribution
  before we lean on it in production. Keep an HTML-scrape fallback in mind if the endpoint moves.

---

## Candidates (researched, feasible, not yet scheduled)

### 🔵 Nukes & Dragons build cards
No public API (`/api/` is robots-blocked), but **every shared build is fully encoded in the
share URL** query string (`s=` SPECIAL, `d=` perks, `lp=` legendary perks, `m=` mutations).
No server lookup needed to reconstruct a build.
- **Phase 1 (Easy/Low risk):** detect N&D URLs in chat → rich link card with build name + "Open Build" button.
- **Phase 2 (Medium/Low risk):** parse the encoded params + a one-time-scraped perk-ID lookup
  table (`/db/` pages are crawl-allowed) → render an inline build summary card. **Highest-value
  build integration** — players share N&D links constantly. Refresh the perk lookup table each FO76 season.

### 🟡 `/wiki <term>` lookup + smart search (Fandom / Nukapedia) — DESIGN LOCKED

> **Full build plan, edge-case register, UI spec, and task list:** [wiki-lookup-build-plan.md](./wiki-lookup-build-plan.md).

**Decision (June 2026):** wiki-primary source · fuzzy+alias search (semantic-ready) · images shown with attribution.

**Why the wiki over the GitHub dumps:** verified live, the only actively-maintained dump
(`FWDekker/fo76-dumps`, pushed within days, 37★) has **no images** — it's tabular form-data.
The only dump *with* images (`deucebucket/fo76-data`) is stale (~2.5mo) and low-bus-factor (2★),
so it's the least reliable option for an image feature. The Fandom MediaWiki API is always
current, never abandoned, ~20yr-stable, and has an image for nearly every entity. The dumps
win only on precise numeric stats — revisit a FWDekker enrichment pass later if we need exact
damage/weight numbers.

**Source:** `https://fallout.fandom.com/api.php` (MediaWiki Action API, anonymous).
The Fandom `/api/v1/` REST endpoints are **dead** (403/CORS) — ignore them.

**Spike findings (June 2026, verified against live API):**
- `prop=pageimages&piprop=thumbnail|original&pithumbsize=300` → clean **transparent-background**
  renders, both a sized thumbnail and a hi-res original. CDN auto-serves **WebP** despite `.png` URLs.
- **`prop=extracts` is EMPTY for items/weapons/armor** — those pages lead with an infobox, not prose.
  Do not rely on extracts for item summaries.
- **The data lives in the infobox.** `action=parse&prop=wikitext&section=0` returns the
  `{{Infobox weapon FO76 | ... }}` (or `armor`/`item`/`creature` FO76 variants) block, which is rich:
  type, class, level-scaled damage, weight, value, ammo, fire rate, range, accuracy, crit, legendary
  effects, perks, crafting plan, form ID. **Parse the infobox into key→value pairs** (strip `[[a|b]]`→b,
  `{{dot}}`→·, `{{icon|…}}`→'', `<small>`, comments) — this is the display payload.
- **Image aspect ratio varies by type** — weapons are ultrawide (~300×64), armor/PA are tall
  portraits (~210×300), creatures ~square. Display needs a **flexible image area** (`object-fit:
  contain`, max-height cap, transparent bg), NOT a fixed box.
- Cross-game disambiguation: opensearch returns generic + `(Fallout 76)`/`(Nuclear Winter)` suffixed
  pages. **Scope ingestion to FO76** (category walk / suffix + infobox-type filtering).

**Display:** a themed **Pip-Boy stat card** — transparent render beside infobox-derived stat rows
(field subset chosen per infobox type) + "Fallout Wiki · CC-BY-SA 3.0 · View article" footer.
NOT a prose blurb.

**Architecture — local catalog + smart search (live API alone can't do typo-tolerant/semantic):**
1. **Ingest** — scheduled job mirrors a catalog of entity names → `{ name, wiki title, summary,
   thumbnail URL, kind }` into our DB (`wiki_entries` table). Refreshed on a schedule (e.g. weekly
   + on-demand). Keeps search instant, offline-resilient, and decoupled from wiki latency.
2. **Search** — backend matches with Postgres **`pg_trgm`** trigram similarity + an **alias/synonym
   table** (`wiki_aliases`: "stimpac"/"stim pack"→Stimpak, nicknames, plurals). Schema designed so a
   **`pgvector` embedding column can be layered on later** for true semantic ("healing needle"→Stimpak)
   with no rework.
3. **Surface** — a `/wiki <term>` baked-in command (same plumbing as `/serverstatus`/`/nukecodes`)
   **and** typo-tolerant entries in the chat **autocomplete dropdown**: matches render with thumbnail,
   clicking one fires the lookup card. Card shows summary + image + "Fallout Wiki — CC-BY-SA 3.0" credit
   + article link.

**Licensing:** content is **CC-BY-SA 3.0** → attribute on every card. Game-art images are Bethesda
assets under the wiki's fair-use rationale; we display them **with attribution + link-back** (standard
community-tool practice, low practical risk).

**Images — mirror to MinIO (decided June 2026):** the ingestion job downloads each entity image once
into our existing **MinIO** store and the catalog holds **our own** URL. Chosen over hotlinking the
Fandom CDN and over a live proxy because it's self-contained, fast from our infra, and immune to CDN
URL churn / hotlink protection. Cost is trivial — spike images were 8–32 KB each (~hundreds of MB for
thousands of entities). `wiki_entries.image_url` stores a plain string, so we could fall back to a CDN
hotlink without schema change if ever needed. CDN auto-serves WebP; we store what we fetch.

**UX (decided):** lookup opens a **panel** over the chat area (reusing the Settings/Party panel
pattern), **local-only** (nothing posted to chat). Type `/wiki <term>` → fuzzy **autocomplete with
thumbnails** → select to load the stat card; Enter on a bare term opens the best match directly.
Panel navigation is **replace + back-button** (lightweight history stack). A **"Share to chat"**
button posts a compact preview (name + thumbnail + wiki link) to the current channel. Close via X / Esc.

**Build phases:**
- **P1:** `wiki_entries` + `wiki_aliases` migration (idempotent) + ingestion job (seed from a curated
  starter set, expand via `action=query` category walks).
- **P2:** backend search service (`pg_trgm` + alias resolution) + `GET /api/wiki/search` and `/api/wiki/:title`.
- **P3:** `/wiki` command + autocomplete integration in `ChatOverlay` (clickable thumbnail results) + result card.
- **P4 (later):** optional `pgvector` semantic ranking; optional FWDekker stat enrichment.

### 🔵 Trading-channel item/plan autocomplete
- **Sources (static JSON/CSV, GitHub, no auth):**
  - `deucebucket/fo76-data` — 458 perks, 171 legendary effects, 152 weapons, curve tables
  - `FWDekker/fo76-dumps` — per-patch item/location dumps
  - `suglasp/fallout76_plans_and_recipes` — plans/recipes CSV
- **Use:** item/plan name autocomplete in the Trading channel; bundle a snapshot, refresh on game patches.
- **Risk:** Medium — all are Bethesda IP under "fair use research" framing. Displaying item names/stats
  is universally tolerated in community tools but not formally licensed.
- **Reliability check (June 2026):** `FWDekker/fo76-dumps` is the reliable one — pushed within days,
  37★, per-patch releases — but it's **CSV form-data with no images**. `deucebucket/fo76-data` has
  images + clean JSON but is **stale (~2.5mo) and low bus-factor (2★)**. If we later want precise
  numeric stats, enrich the wiki feature (above) from FWDekker rather than depending on deucebucket.

---

## Parked (no API / high risk / low value)

### 🔴 Fed76 legendary pricing
**No API at all** — only works via the Modus Discord bot (`>fed ...`). For trading prices,
either add Modus to our Discord, drop a "check fed76.info" link, or build our own crowd-sourced
price store. Hard / Medium risk.

### 🔴 Nuka Crypt item/plan/price DB
`/api/codes` is the **only** working endpoint; item/plan/history endpoints all 404. No DB API.

### 🔴 Nuka Knights / Atomic Shop / challenges / Minerva / CAMP DB
No APIs anywhere — HTML only. **Deep-link, don't scrape.**

---

## Source ratings summary

| Source | Data | Feasibility | Risk | Status |
| ------ | ---- | ----------- | ---- | ------ |
| `api.nukacrypt.com/api/codes` | Nuke codes | Easy | Low-Med | ✅ Shipped |
| `api.bethesda.net/.../ext-server-status` | Server up/down | Easy | Low-Med | ✅ Shipped |
| Nukes & Dragons share URLs | Build cards | Easy → Med | Low | 🔵 Candidate |
| `fallout.fandom.com/api.php` | Wiki lookup + smart search + images | Med | Low (CC-BY-SA) | 🟡 Planned (design locked) |
| `FWDekker/fo76-dumps` | Precise stats (no images) | Med | Med | 🔵 Candidate (wiki enrichment) |
| `deucebucket/fo76-data` | Stats + images, one repo | Easy | Med | 🔴 Parked (stale, low bus-factor) |
| Fed76 | Legendary pricing | Hard | Med | 🔴 Parked (no API) |
| Nuka Crypt item DB | Items/plans | Hard | Med | 🔴 Parked (no API) |
| Nuka Knights / Atomic Shop / CAMP | Events/shop/CAMP | Hard | Med | 🔴 Parked (HTML only) |
