# Wiki Lookup — Build Plan, Edge Cases, UI & Test Plan

Master plan for the FO76 wiki lookup feature. Companion to the source-selection rationale in
[fan-site-integrations.md](./fan-site-integrations.md). Produced from a 3-track adversarial
architecture review (data/ingestion, API/security, UI/UX) in June 2026.

**Decisions locked:** wiki-primary source · local catalog + `pg_trgm` fuzzy search (semantic-ready) ·
images mirrored to MinIO · local-only lookup panel · Share-to-chat button · attribution required.

---

## 1. Architecture (finalized)

### 1.1 Data model

Two tables, idempotent migration. **`pg_trgm` extension must be the first DDL statement** (and the
migration user needs permission — verify on the Dokploy Postgres image). Reserve the `embedding`
column now (nullable) so P4 pgvector is a metadata-only add, not a table rewrite.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- first statement

CREATE TABLE IF NOT EXISTS wiki_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wiki_title       TEXT NOT NULL,
  page_id          INTEGER NOT NULL,          -- Fandom numeric id; stable across renames → UPSERT KEY
  name             TEXT NOT NULL,             -- normalized display name ("(Fallout 76)" stripped)
  kind             TEXT,                      -- weapon|armor|power_armor|creature|item|location|perk|character|other
  infobox          JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_url        TEXT,                      -- our MinIO-proxied URL
  image_mime       TEXT,                      -- 'image/webp' (CDN serves WebP even for .png)
  image_width      INTEGER,
  image_height     INTEGER,
  image_aspect     TEXT,                      -- 'ultrawide'|'portrait'|'square'|'unknown' (UI layout)
  image_source_url TEXT,                      -- Fandom CDN fallback
  content_hash     CHAR(64),                  -- sha256(raw wikitext) → change detection
  -- embedding     VECTOR(1536),              -- reserved for P4 (kept commented until pgvector installed)
  is_stale         BOOLEAN NOT NULL DEFAULT false,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_entries_page_id_idx        ON wiki_entries (page_id);
CREATE INDEX        IF NOT EXISTS wiki_entries_name_trgm_idx      ON wiki_entries USING gin(name gin_trgm_ops);
CREATE INDEX        IF NOT EXISTS wiki_entries_kind_idx           ON wiki_entries (kind);
CREATE INDEX        IF NOT EXISTS wiki_entries_infobox_gin_idx    ON wiki_entries USING gin(infobox jsonb_path_ops);

CREATE TABLE IF NOT EXISTS wiki_aliases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias         TEXT NOT NULL,
  wiki_entry_id UUID NOT NULL REFERENCES wiki_entries(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'auto',  -- 'auto' (derived) | 'curated' (human)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_aliases_alias_entry_idx ON wiki_aliases (alias, wiki_entry_id);
CREATE INDEX        IF NOT EXISTS wiki_aliases_alias_trgm_idx  ON wiki_aliases USING gin(alias gin_trgm_ops);
CREATE INDEX        IF NOT EXISTS wiki_aliases_entry_idx       ON wiki_aliases (wiki_entry_id);
```

Prisma models map snake_case → camelCase via `@map`, per conventions.

### 1.2 Ingestion job (background, weekly cron + admin on-demand)

- **Redis distributed lock** (`SET fo76:wiki:ingest:lock <runId> NX EX 10800`) — bail if held. Min
  re-trigger interval (≥1h) enforced server-side for the admin endpoint.
- **Enumerate** via recursive category walk: `action=query&list=categorymembers&cmtype=page|subcat&cmlimit=500` with `cmcontinue` paging; **recurse into `subcat` members** (depth cap 5 — Fandom has circular categories). Seed categories: `Fallout 76 weapons`, `Fallout 76 armor and clothing`, `Fallout 76 creatures`, `Fallout 76 items`, `Fallout 76 locations`, `Fallout 76 perks`, `Fallout 76 characters`.
- **Scope to FO76** — after parsing, call `isFo76Content(parsed)` (exported from `wikiParser.ts`, pure, unit-tested). Accepts: (1) pages whose infobox template contains the `FO76` token (e.g. `"Infobox weapon FO76"`); (2) shared-universe pages whose `games` infobox field includes the `FO76` token (e.g. `{{Infobox item|games=FO76|…}}`). Rejects: pages with no infobox (`kind === null`), disambiguation pages, and cross-game pages with no FO76 signal. The search/entry API adds a second safety filter (`kind IS NOT NULL`) so any pre-gate rows that somehow reach the DB are never served.
- **Politeness** — 300ms sleep between entity fetches; exponential backoff on HTTP 429; descriptive User-Agent. A full first run is ~5,000 entities × 2 calls ≈ 80 min → must be background + resumable.
- **Change detection** — fetch `prop=revisions&rvprop=ids|timestamp` first; compare against `content_hash`/`ingested_at`. Unchanged → touch `ingested_at`, skip wikitext + image re-download (~80% bandwidth saved).
- **Upsert on `page_id`** (not title — pages get renamed). Auto-generate aliases (strip "(Fallout 76)" suffix, plural/singular) with `source='auto'`.
- **Stale cleanup** — after the run, `is_stale=true` where `ingested_at < run_start`; serve-but-flag, hard-delete after N weeks.
- **Errors** — per-entity try/catch into a `wiki_ingest_errors` log (page_id, error, attempted_at); never abort the whole run. Admin can retry targeted.
- **Realistic catalog size: 4,000–10,000 rows** (the earlier "hundreds" estimate was low). Image storage still trivial (60–300 MB).

### 1.3 MinIO image mirroring

- Reuse the existing `@aws-sdk/client-s3` object-storage helper (same pattern as `avatarService`).
- Key: `wiki-images/<page_id>-<sha256(bytes)[:8]>.webp` — content-addressed → self-dedup + cache-bust on real change.
- Read `Content-Type` from the CDN response, store in `image_mime`, pass to `PutObject`. Compute `image_aspect` from dimensions (ultrawide/portrait/square).
- Skip re-upload when the image hash is unchanged. On MinIO failure: catch, `image_url=null`, keep `image_source_url`, continue.
- Serve via backend-proxied route (clients never hit MinIO directly); MinIO stays private.
- Orphan GC job (list keys, drop those with no live `page_id`) — later, low priority.

### 1.4 Parser (DONE — `backend/src/services/wikiParser.ts`)

Pure, side-effect-free, unit-tested. Bugs from review already fixed + locked by tests:
- `inferKind` orders `power_armor` before `armor` (was misclassified).
- `cleanWikitextValue` strips nested templates innermost-first (flat regex left brace garbage).
- Added `isFo76Infobox()` + `parseInfobox` now returns `{ kind, templateName, isFo76, fields }`.
- **Known limitations (documented, not P1 blockers):** only the first infobox on multi-infobox/variant pages; tabber-wrapped infoboxes may need a "find next FO76 infobox" retry; level-scaled values kept as display strings (not numerically parsed).

### 1.5 API surface

| Method/Path | Auth | Notes |
| --- | --- | --- |
| `GET /api/wiki/search?q=&limit=` | Public (before `requireClientAuth`) | Served from local catalog via `pg_trgm` + alias join. **Never calls Fandom.** Dedicated `wikiSearchLimiter` (generous, separate bucket). Validate `q` (1–100 chars, strip null bytes, parameterized query only). |
| `GET /api/wiki/entry/:title` | Public | Served from `wiki_entries`. 404 if absent; 200 with empty `fields` if no infobox. |
| `POST /api/admin/wiki/ingest` | `requireDiscordRole(owner/admin)` | Manual ingestion trigger; min-interval + lock guarded. |

- **Ingestion-only enforcement:** `wikiService.getEntity` / `searchTitles` call Fandom — they must be used **only** by the ingestion job, never a request controller (else per-keystroke outbound load + IP block). Keep them out of request paths.
- **Response shape:** `{ data: ... }` wrapper, RFC 7807 errors (repo convention).
- Add `/wiki` to `RESERVED_BUILTINS` in `commandsController`.

### 1.6 Share-to-chat

Posts a normal `chat:message` with `metadata: { type: 'wiki_share', wikiEntryId, name, kind, ... }` and a plain-text `content` fallback (`[WIKI] <name> — <url>`) for Discord/legacy clients. **Server re-reads `image_url`/`wikiUrl`/`name`/`kind` from the DB row by `wikiEntryId` — never trusts client-supplied URLs** (prevents tracking-pixel/NSFW/XSS injection). Hidden in `isPublicMode`; WS rate-limit covers spam.

### 1.7 Security checklist

- [ ] Wiki values rendered as React text nodes only — **never** `dangerouslySetInnerHTML`.
- [ ] Sanitize infobox values at **ingestion** (definitive), not just render time.
- [ ] `pg_trgm` search uses parameterized queries (`$queryRaw`, never `$queryRawUnsafe`).
- [ ] Response size cap on outbound Fandom fetches (Fandom can serve multi-MB pages).
- [ ] CSP: images come from MinIO (our origin) → no new `img-src`. If ever falling back to the Fandom CDN, add `static.wikia.nocookie.net` to Electron `img-src`.
- [ ] Share-to-chat server-side entity validation + DB-sourced URLs.

---

## 2. Edge-case register

| Sev | Case | Handling |
| --- | --- | --- |
| P0 | `inferKind` power_armor misclassification | ✅ Fixed + test |
| P0 | Nested-template parse garbage | ✅ Fixed + test |
| P0 | Concurrent ingestion runs | Redis lock + min-interval |
| P0 | Upsert on title creates dupes on rename | Upsert on `page_id` |
| P1 | `pg_trgm` needs superuser / first-statement | `CREATE EXTENSION IF NOT EXISTS` first; verify perms on prod image |
| P1 | Category walk misses subcats | Recurse `subcat`, depth cap 5 |
| P1 | Cross-game / disambiguation pages | `isFo76Content()` gate at ingest + `kind IS NOT NULL` safety filter in search/entry SQL |
| P1 | Fandom 429 / down mid-run | Backoff; per-entity error log; partial run OK |
| P1 | Per-user request → Fandom | Ingestion-only; requests hit local catalog |
| P2 | WebP served at `.png` URL | Store `image_mime` from response header |
| P2 | MinIO down at ingest | `image_url=null`, fallback `image_source_url`, continue |
| P2 | Entity has no image | `image_url=null`; UI placeholder, never broken `<img>` |
| P2 | Oversized infobox (locations/quests) | Trim per-kind field subset in API response; cap value length |
| P2 | Stale rows after wiki delete/rename | `is_stale` flag + delayed delete; invalidate Redis on delete |
| P3 | Tabber / multi-infobox pages | First-FO76-infobox retry; log for editorial review |
| P3 | Orphaned MinIO images | Periodic GC job |
| P3 | Autocomplete race (slow "stim" after fast "stimpak") | AbortController cancel per keystroke |

---

## 3. UI plan (P3)

All in `ChatOverlay.tsx` (no fork) + an inline `WikiPanel` component (mirrors `SettingsModal`).
Full spec retained from the UX review; actionable inventory below.

### 3.1 Autocomplete (wiki mode)
- Activates when `inputText` starts with `/wiki ` and ≥2 chars of term. **Separate state** from the slash-command autocomplete (`wikiAcItems/wikiAcOpen/wikiAcLoading`) — mutually exclusive, never merged.
- Debounce 280ms · min 2 chars · `AbortController` cancel in-flight · loading spinner · "no results" / "search unavailable" rows.
- Rows: thumbnail (28×24, `object-fit:contain`, transparent, `?` on error) + name (ellipsis) + kind badge (semantic color). Keyboard: ↑/↓ wrap, Enter/Tab select, Esc clears.
- Enter on a bare term → best match (first `pg_trgm` result).

### 3.2 Panel — buttons & controls

| Button | Location | Action | Visible when | Disabled when |
| --- | --- | --- | --- | --- |
| Close `✕` | chrome right | Close panel, reset history | always | never |
| Back `◄` | chrome left | Pop history → prev entry | always | `history.length===0` |
| Share to Chat | actions bar | Post wiki_share to current channel | `!isPublicMode` && success | sending/sent |
| View Article `↗` | actions bar | Open Fandom article (Electron: `overlayShell.openExternal`) | success/no-infobox | never |
| Copy Link | actions bar | Copy article URL (→ "COPIED!" 2s) | success/no-infobox | never |
| Retry | body (error) | Re-fire lookup | error state | never |
| Esc key | global | = Close | panel open | never |

### 3.3 States
`loading` (shimmer) · `success` (full card) · `no-infobox` (image + "no stat data" + View/Copy) · `error` (message + Retry) · `not-found` (message + Close). Footer `Fallout Wiki · CC-BY-SA 3.0` **always visible** (attribution).

### 3.4 Per-kind stat field sets (absent fields omitted, never blank rows)
- **weapon**: type, class, damage, fire rate, range, accuracy, crit, ammo, weight, value → effects/perks → plan, formid
- **armor**: type, class, resist (phys/energy/rad/emp), weight, value → effects/perks → plan, formid
- **power_armor**: type, set, resist (phys/energy/rad), weight, value → effects → formid
- **creature**: type, variants, level, hp, xp, drops, locations, formid
- **item**: type, effect, duration, hunger/thirst, rads, weight, value, formid
- **perk**: special, rank1–3, formid
- **location**: type, region, map ref, formid
- **other/unknown**: first 14 raw infobox pairs

### 3.5 Image area (flexible — spike showed aspect varies by kind)
`object-fit:contain`, transparent bg, max-height by `image_aspect`: ultrawide 72px / portrait 200px / square 160px / unknown 140px (reduced on small Electron windows). Loading placeholder; broken-image → `[?]` + "Image unavailable"; null image → skip area.

### 3.6 Surfaces
- **Auth dashboard**: right drawer (`min(420px, 45vw)`), chat visible at left.
- **Electron overlay**: full-window panel; close on idle-collapse; **block open while click-through is on** (close if toggled on).
- **Public website (logged-out)**: `/wiki` is **NOT available** — no wiki chip/button, no panel. The feature is auth-only (dashboard + Electron overlay). Do not add a public-mode entry affordance.
- Theming: derive all colors from `WebTheme` (`hexAlpha`, `menuBgColor`), scanlines/glow honored, mono stat labels, `◈` glyph.

---

## 4. Testing plan

### 4.1 Unit (`npm run test:unit` — Node `node:test` + tsx, no extra deps)
- ✅ **`wikiParser.test.ts` (23 tests, passing)** — cleanWikitextValue (links, {{dot}}, {{icon}}, {{ID}}, nested templates, html/refs/comments, XSS-markup reduction), inferKind (power_armor regression, all kinds), isFo76Infobox, parseInfobox against **real captured Fixer wikitext** (fields, level-scaled damage, pipe-in-link, hatnote ignored, external link), edge cases (no infobox, unterminated, empty-value drop, cross-game flag).
- **To add per phase:**
  - P1: image-aspect classifier; alias auto-generation; FO76/disambiguation filter; content-hash change detection; category-walk pagination + subcat recursion (mocked fetch).
  - P2: `q` validation (length/null-byte); `pg_trgm` ranking/alias resolution (against a seeded test DB or mocked Prisma); per-kind field-subset trimming; share-payload server validation (rejects spoofed URL).
  - Parser fixtures: capture real wikitext for armor / power_armor / creature / item / perk and add a parse test each.

### 4.2 Integration (Jest + Supertest — repo's existing `tests/**/*.test.js` harness)

**File: `backend/tests/wiki.test.js`** — written, all structural cases pass in isolation.

> **Note on the test harness:** All existing `tests/*.test.js` integration tests currently
> fail to load because `server.ts` uses TypeScript syntax (`: string[]` type annotations)
> that Babel cannot process. `wiki.test.js` follows the identical pattern and has the same
> pre-existing constraint. Tests run fully once `ts-jest` is added or the server is
> pre-compiled. For now they serve as the authoritative specification of expected contracts.

**Cases covered:**

`GET /api/wiki/search` (structural/mocked — always runs):
- Public — no auth header required → 200.
- Response shape `{ data: Array }` with `id / name / kind / thumbnailUrl / score` per element.
- Missing `q` → 400 RFC 7807.
- Empty `q` → 400.
- `q` > 100 chars → 400.
- `q` containing null bytes → 400 or sanitised, never 500.
- Optional `limit` param accepted without error.

`GET /api/wiki/search` (live-stack — `WIKI_INTEGRATION=1`):
- Real `pg_trgm` results returned from a seeded catalog.
- `wikiSearchLimiter` bucket is separate from the global limiter (10 concurrent → all 200).

`GET /api/wiki/entry/:title` (structural/mocked):
- Public — no auth required → 200.
- Found entry has `{ id, name, kind, fields, articleUrl, attribution }`.
- `articleUrl` points to `https://fallout.fandom.com/wiki/`.
- Unknown entry → 404 RFC 7807.
- No-infobox entry → 200 with `fields: {}` and attribution present.
- Entry response never reflects caller-supplied URL params (DB always wins).

`GET /api/wiki/entry/:title` (live-stack):
- Fields limited to per-kind subset (no raw infobox dump).
- Stale rows (`is_stale=true`) → 404.

`POST /api/admin/wiki/ingest`:
- No auth → 401 RFC 7807.
- Authorised (X-API-Key bypass) → 202 `{ data: { status: 'started' } }`.
- Lock held → 409.
- Min-interval not elapsed → 409.
- Live: non-admin Discord session → 401 or 403.

Share-to-chat server validation (WS — skipped until P3 WS handler):
- `chat:message` with valid `wikiEntryId` accepted; `imageUrl` sourced from DB.
- Unknown `wikiEntryId` rejected.
- Client-supplied `imageUrl` ignored (DB value used).
- Public-mode client cannot send `wiki_share` messages.
- Structural HTTP guard: entry endpoint is public; public-mode Share block is a client contract.

### 4.3 Ingestion job tests (mocked Fandom + MinIO)
- Lock acquire/skip; resumable partial run; FO76 scoping; change-detection skip path; stale flagging; per-entity error isolation; MinIO-failure fallback to `image_source_url`.

### 4.4 Frontend tests
- Component tests for `WikiPanel` states (loading/success/no-infobox/error/not-found) and per-kind field rendering; autocomplete debounce + AbortController cancel; public-mode hides Share.
- **E2E (Playwright, via `arcwright-qa` / playwright-cli):** type `/wiki stimpak` → select → panel renders with image + stats → Share to chat → card appears in feed; Back navigation; Esc close.

### 4.5 Manual QA checklist
- Ultrawide weapon vs tall armor vs square creature render correctly; transparent bg on dark theme; attribution always visible; Electron external-link + clipboard; click-through guard; public-mode chip + hidden Share; offline/error states.

---

## 5. Task list

### P1 — Catalog + ingestion (backend, no UI)
- [ ] Migration `wiki_entries` + `wiki_aliases` (idempotent; `pg_trgm` first; reserve `embedding`) + `wiki_ingest_errors`.
- [ ] Verify `pg_trgm` createable on the Dokploy Postgres image (perms).
- [ ] Prisma models (`@map`) + `prisma generate`.
- [ ] Reuse S3/MinIO helper → `wikiImageService` (download, hash, content-type, aspect, upload, skip-unchanged, fallback).
- [ ] `wikiIngestionService` + `jobs/wikiIngest.ts` cron: recursive category walk, FO76 filter, change detection, upsert-on-page_id, alias gen, stale cleanup, Redis lock, 300ms throttle + 429 backoff, error log.
- [ ] `POST /api/admin/wiki/ingest` (role + min-interval + lock).
- [x] Unit tests for `isFo76Content()` (11 cases: FO76 template, cross-game reject, no infobox, shared-page games=FO76, comma-list, FO4-only, no-games-field, disambiguation, creature, lowercase, word-boundary). `npx tsc --noEmit` + `npm run test:unit` passing (129 tests).
- [ ] Unit tests (aspect, change-detect, walk) + mocked ingestion tests.
- [ ] Docs: `docs/database/schema.md` + `docs/backend/services.md` + `docs/backend/jobs-and-queues.md`.

### P2 — Search + entry API
- [ ] `wikiCatalogService`: `pg_trgm` + alias search (parameterized), per-kind field trim, `q` validation.
- [ ] `wikiSearchLimiter`; mount `GET /api/wiki/search` + `/api/wiki/entry/:title` before `requireClientAuth`.
- [ ] Add `/wiki` to `RESERVED_BUILTINS`.
- [ ] Integration tests (search/entry/auth/public/limit) + unit tests (validation/trim/ranking).
- [ ] Docs: `docs/backend/api-reference.md` + `docs/realtime/` if any WS.

### P3 — UI (ChatOverlay)
- [ ] `/wiki` in `BUILTIN_FORMS` + `HelpContent` + `commandService` help text + intercept in `handleSend`.
- [ ] Wiki autocomplete (separate state, debounce, AbortController, thumbnail rows, keyboard nav).
- [ ] `WikiPanel` component: layout, flexible image area, per-kind fields, all buttons, 5 states, theming, scanlines/glow.
- [ ] Share-to-chat (client) + `wiki_share` message render in feed + server validation.
- [ ] Public-mode `◈ WIKI` chip + Share hidden; Electron click-through/collapse guards + external-link/clipboard.
- [ ] Component tests + Playwright E2E.
- [ ] Docs: `docs/frontend/chat-overlay.md` + `docs/frontend/features.md`.

### P4 — Later
- [ ] pgvector semantic ranking (uncomment column, install ext, embeddings pipeline, hybrid score).
- [ ] FWDekker stat enrichment for precise numbers.
- [ ] Orphaned-image GC job.
- [ ] Curated alias seeding (common misspellings/nicknames).

---

## 6. Multi-image carousel + spawn locations (P4a) — DESIGN LOCKED (June 2026)

**Schema (new idempotent migration):**
- `wiki_images` child table: `id, wiki_entry_id (FK ON DELETE CASCADE), url, source_url, mime, width, height, aspect, position INT, is_map BOOL, created_at`. Ordered by `position` (primary = 0). Index on `wiki_entry_id, position`.
- `wiki_entries.locations JSONB` (array of cleaned location strings; `[]` when none).
- Keep `image_url`/`image_*` on `wiki_entries` as the primary thumbnail (= images[0]) for back-compat.

**Ingestion:**
- **Images:** `action=query&prop=images` → File titles → `prop=imageinfo&iiprop=url|size|mime`. FILTER OUT: svg/icons, <100px, `{{icon}}`/UI/"icon"/vault-boy name patterns, map-marker sprites. Keep renders + gallery + maps. Mirror each to MinIO (content-addressed), insert `wiki_images` ordered (infobox image position 0). Tag `is_map=true` when name matches `/map|loc[_-]/i`.
- **Locations:** `prop=sections` → find the section whose `line === 'Locations'` → use its **`index`** (NOT the display `number`) → fetch that section's wikitext → split list items (`*`/`;`), `cleanWikitextValue` each → store array in `wiki_entries.locations`.

**API (entry response):** add `images: [{url, aspect, isMap, width, height}]` (primary first) and `locations: string[]`. `imageUrl` stays = `images[0]?.url` for back-compat.

**UI (WikiPanel):**
- Image area becomes a **carousel** when `images.length > 1`: `‹ ›` arrows + dot indicators + `n / N` counter + Left/Right arrow keys. Single image → unchanged. Map images get a small `MAP` badge.
- New **LOCATIONS** section below the stat rows showing the spawn-location list (bulleted), when `locations.length > 0`.

**Contract reminder (do NOT regress):** entry API returns `fields` (not `infobox`); search returns `wikiTitle`; frontend `WikiEntry` uses `fields`. New fields: `images`, `locations`.
