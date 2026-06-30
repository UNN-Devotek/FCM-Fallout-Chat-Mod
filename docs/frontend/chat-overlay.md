# ChatOverlay — One Component, Three Surfaces

**File:** `admin-dashboard/src/features/chat/ChatOverlay.tsx`

This is the single source of truth for the chat UI. It is rendered by all three
surfaces without forking. Any visual or behavioural change made here applies
everywhere simultaneously.

> The old `PublicChatOverlay.tsx` was deleted after it diverged from the main
> component. Never duplicate or fork this file.

## The Three Render Surfaces

### 1. Auth Dashboard — `/chat` route

- Rendered inside `AdminLayout` via React Router v6 (`App.tsx:91`).
- `user` is provided by `useOutletContext<{ user?: AuthUser }>()`.
- Connects to the backend over **WSS** immediately on mount.
- Full read/write: message input, slash commands, moderation controls for
  staff, party system, settings modal.
- Settings persist to `localStorage` (key `fcm_web_overlay_settings`).

### 2. Public Website — Landing page CHAT tab

- Rendered from `admin-dashboard/src/features/auth/LandingPage.tsx` (imports
  `ChatOverlay` directly, no `user` in outlet context, no Electron shell global).
- `isPublicMode` evaluates to `true` because:
  `const isPublicMode = !user && !getOverlayShell();` (`ChatOverlay.tsx:1087`)
- **Read-only REST polling** at 3-second intervals — no WebSocket is opened
  (`ChatOverlay.tsx:2340`).
- Channel messages fetched from `GET /api/messages/public?channelId=<id>&limit=300`.
- Public party messages fetched from `GET /api/parties/public/<id>/messages?limit=200`
  at 4-second intervals (`ChatOverlay.tsx:2764–2817`).
- All write actions and party join/invite actions are disabled (see Public Mode
  Lockdown below).

### 3. Electron Overlay

- Rendered by the Electron renderer process. The shell sets
  `window.__FCM_OVERLAY_SHELL__` (type `OverlayShell`) before React mounts
  (`ChatOverlay.tsx:152–165`).
- `getOverlayShell()` returns the shell object (`ChatOverlay.tsx:166–169`).
- `isPublicMode` is `false` — the overlay authenticates via an install-token
  session (anonymous UUID → 24h ephemeral token in Redis).
- Connects over WSS; `wsGameActive` / `wsOverlayVisible` gate the connection to
  avoid unnecessary traffic when the game is closed or the window is hidden.
- The Electron shell owns window chrome (drag, resize, minimize, close); the
  component's own gear icon routes to `overlayShell.onSettings()` when the shell
  is present, bypassing the built-in settings modal in favour of the shell's
  full settings panel.
- Background / text opacity are driven by CSS custom properties
  `--fcm-chrome-bg-alpha` and `--fcm-text-opacity` set by the shell; the
  component reads them via `MutationObserver` (`ChatOverlay.tsx:1135–1149`).
- Avatar and media URLs are prefixed with `overlayShell.relayBase` because the
  renderer origin differs from the backend origin (`ChatOverlay.tsx:182–213`).
- **Footer version + `[DEV]` indicator.** In the overlay the footer shows the
  **actual running app version** (from the shell bridge `getInfo().appVersion`,
  e.g. `1.3.91-dev`) rather than the latest-published `liveVersion` from
  `GET /api/version` — so a dev/QA build is never mislabelled with the relay's
  newest release. It appends `[DEV]` whenever the build is pointed at a non-prod
  relay, decided by the pure `isProdRelayHost(host)` helper against
  `getInfo().relayHost` (prod = `falloutchatmod.com` / `www.`). On the website
  (no shell) the footer keeps `liveVersion` and only shows `[DEV]` on
  `localhost`. See `isProdRelayHost` in [Key exported helpers](#key-exported-helpers).

## Surface Detection — How the Component Branches

```ts
// ChatOverlay.tsx:1087
const isPublicMode = !user && !getOverlayShell();

// ChatOverlay.tsx:1151
const overlayShell = getOverlayShell();
```

| Condition | Surface |
|-----------|---------|
| `user` truthy, `overlayShell` null | Auth dashboard |
| `user` falsy, `overlayShell` null | Public website (isPublicMode = true) |
| `user` falsy, `overlayShell` non-null | Electron overlay |

Everything shared (tab bar, message rendering, input box, scanlines, fonts,
spacing) is always rendered. The component only branches on `overlayShell`
(window chrome, settings routing, CSS-var opacity) and `isPublicMode` (lockdown
rules, data source, input visibility).

## Public Mode Lockdown Rules

Server enforcement is primary; these client-side checks are a backstop.

| Action | Behaviour in public mode |
|--------|--------------------------|
| Message input | Hidden entirely — no `<input>` rendered (`ChatOverlay.tsx:4067`) |
| Send message | Never called |
| Slash commands | Not available |
| Username context menu | Shows Copy items only; no moderation/account actions |
| Party tab (PARTY) | Public-only, read-only — lists `isPrivate=false` parties only; action is VIEW not JOIN |
| PM tab | Hidden entirely — no inbox, no PM conversation view, no `Message` context-menu item |
| Party join/invite | Disabled; clicking VIEW navigates to party browser |
| Party right-click | Suppressed (`ChatOverlay.tsx:4168`) |
| Combined feed party inclusion | Public parties only (`feedPartyIds = publicPartyIdKey.split(',')`, `ChatOverlay.tsx:3464`) |
| WebSocket | Never opened — `isPublicMode` is folded into the connect gate (`deriveWsShouldConnect`), so public mode can never open the authed socket and a **session expiry** (`user` → null flips `isPublicMode` true) immediately tears down an already-open socket via the gate rather than leaving it open. Pure helper unit-tested in `wsGate.test.ts`. |
| Authenticated REST endpoints | Never called |
| Tag click navigation | `target = isPublicMode ? null : ...` — tags are not clickable (`ChatOverlay.tsx:4904`) |

## Pip-Boy Two-Row Tab Bar

The tab bar has two rows, both rendered inside the overlay header:

**Row 1 — Main channels** (e.g. "FALLOUT 76", "GENERAL"): one tab per top-level
channel (`parentId === null`). Clicking a main tab shows the combined feed for
that main channel plus all its sub-channels.

**Row 2 — Sub-channels + special views**: sub-channel tabs (`children` of the
active main) or the PARTY browser/joined-party row. The **PM tab renders no
sub-tab row** (inbox is the default view; return-to-inbox lives in the
open-conversation header). The
active party tab can be right-clicked for context actions (Invite, Leave,
Delete). An overflow ellipsis (`…`) appears when joined-party tabs exceed the
available row width (`ChatOverlay.tsx:1260–1268`).

The special constant `PARTY_MAIN_ID = '__party__'` (`ChatOverlay.tsx:760`) is
used as the `activeMainId` sentinel when the PARTY main tab is selected.
`PM_MAIN_ID = '__pm__'` is the matching sentinel for private messages.

## Private messages

The shared `ChatOverlay.tsx` owns PM UI too — there is no separate DM panel or
forked component.

- **Top-level tab:** `PM` sits beside `FALLOUT 76` and `PARTY`.
- **Second row:** PM renders **no sub-tab row** at all (the old single `INBOX` sub-tab was removed as redundant). The inbox is the default view; per-user PM tabs are never added.
- **Inbox view:** search box (`Type to search...`), text-only conversation rows, no avatars, ordered by most-recent `lastMessageAt`, unread badge per row, and a sender-prefixed preview (`You: <message>` when the current user sent the latest PM, otherwise `<OtherUserDisplayName>: <message>`). Inbox filtering matches the participant name, raw preview text, and the sender-prefixed preview text.
- **Conversation view:** a `< BACK TO INBOX` row, then the other participant's display name as the header, followed by the normal shared message renderer plus the normal 255-character composer/counter.
- **Composer routing:** when `activeMainId === PM_MAIN_ID` and `pmView !== 'inbox'`, Enter sends `pm:send` only. PM content never reuses `chat:send` or `party:send`.
- **Context menu:** authenticated message rows add a `Message` item near the top. The label is exactly `Message`; it is hidden for self, missing `userId`, bots/system rows, and public mode.
- **WebSocket state:** on connect the overlay requests `pm:list`; opening a conversation requests `pm:history`; incoming `pm:message` frames update the inbox summary and active thread in place; active-thread receives trigger `pm:read`.
- **Isolation:** PM messages live only in `privateMessages` state. They never merge into the shared `messages` array, so they cannot leak into the combined feed, sub-channel views, party views, or public-mode REST polling.

## Party moderation visibility

Privileged users (role `owner`, `admin`, or `moderator`) see every party's messages **inline** in the main feed — the website **Feed** tab and the overlay **General** channel (both are `isMainFeedView`). There is no separate "All Parties" sub-tab.

- **Gate:** active only when `isMod && !isPublicMode` — completely inert in public mode, completely inert for regular users.
- **Mechanism:** the `visibleMessages` useMemo main-feed branch calls the exported pure helper `shouldShowInMainFeed`, which adds an extra inclusion rule: when `isMod && !isPublicMode`, any message with `source === 'party'` is included regardless of whether its `channelId` is in `feedPartyIds`. This means foreign-party messages (`_modObserver: true`) flow into the General/Feed view alongside the mod's own party messages.
- **Scope is General/Feed only:** mod-observed party messages appear **only** in the `isMainFeedView` branch. They never surface in individual sub-channel views (Trading, Events, Raids) or the party in-chat view. This is a deliberate restriction inside `shouldShowInMainFeed` — the party in-chat branch (`m.channelId === partyView`) and the single-sub-channel fallback (`m.channelId === activeSubId`) are unchanged.
- **Rendering:** party messages already carry `[PartyName]` tags via the existing tag logic (each `source === 'party'` message renders its party's name and colour as a prefix). No separate rendering path is needed.
- **Read/write:** the input bar remains active for the mod's own joined parties. Foreign-party messages are read-only by the nature of how party send works (requires membership — server-enforced).
- **Server-enforced visibility:** the backend controls which `chat:message` frames reach the client. Privileged users receive foreign-party frames with `_modObserver: true`; regular users never receive them. The client filter is defence-in-depth only.

### Key exported helpers

| Export | Signature | Purpose |
|--------|-----------|---------|
| `isPrivilegedRole` | `(role: string) => boolean` | Returns true for owner/admin/moderator. Single source of truth, backed by `MOD_ROLES`. |
| `shouldShowInMainFeed` | `(m, ctx) => boolean` | Pure: determines whether a message belongs in the main feed. Handles feedParent, child ids, joined party ids, and mod-observer inclusion. Testable without React. |
| `formatMessageTimestamp` | `(value, format, opts?) => string` | Pure: formats a message's UTC timestamp in the VIEWER's local time. `format` is `'12h'`/`'24h'`; `opts.timeZone`/`opts.locale` exist for tests only. Returns `''` for missing/unparseable input. |
| `isProdRelayHost` | `(host) => boolean` | Pure: true only for the prod relay host (`falloutchatmod.com`/`www.`), case-insensitive, port-ignored. Drives the footer `[DEV]` indicator so a build on any non-prod relay self-identifies. |

## Combined Feed

Clicking a **main tab** activates `isMainFeedView = true`. The visible message
set includes:

- Messages whose `channelId === feedParent.id` (the main channel itself)
- Messages in any child sub-channel of that main
- Messages from joined parties (auth mode) or public parties (public mode)
- **Privileged users only (auth mode):** all party messages (`source === 'party'`), including foreign parties observed via `_modObserver`. See [Party moderation visibility](#party-moderation-visibility).

Each message in the combined feed is prefixed with a coloured `[TagName]` label:

| Message source | Tag name | Tag colour |
|---------------|----------|-----------|
| Discord-relayed | `Discord` | `#B57AFF` (purple) |
| Server (dormant) | `Server` | `#FFB000` (amber) |
| Party | Party's `name` | Party's `color` field |
| Sub-channel (Trading) | `Trade` | Channel's `color` field |
| Any other sub-channel | Channel's `name` | Channel's `color` field |

The `Trading` → `Trade` abbreviation is hardcoded at `ChatOverlay.tsx:4868`.

Clicking a main tab shows the sub-channel in isolation (no combined-feed tag prefix).

## Display Name Priority

`ChatOverlay.tsx:1317–1322` (mention detection names) and the WS
`display:name-update` frame (`ChatOverlay.tsx:2653–2660`) show the resolution order:

1. `users.username` if set and not the default value `'Wanderer'`
2. `users.discord_username`
3. Raw username from the message frame

The component also maintains a live `knownDisplayNames` ref (Map of userId →
displayName) updated from `display:name-update` WS frames. On arrival, all
in-memory messages from that user are patched in place to stay current without a
refetch.

No `#XXXX` discriminator is ever appended.

## Message History

- In-memory cap: `MESSAGE_CAP = 2000` messages (`ChatOverlay.tsx:768`).
- Initial history batch: `HISTORY_PAGE = 300` per channel (`ChatOverlay.tsx:764`).
- History is requested for every sub-channel via `chat:history` WS frames
  on first connect (or when channels arrive before the WS opens).
- On WS **reconnect** (e.g. hide→show overlay visibility flip), channels tracked
  in `historyLoadedChsRef` are skipped — their existing messages are preserved in
  state and no visible "reload" flash occurs. Only channels with no existing data
  request history. The reconnect path logs `[ws-gate] reconnect — silent (N channels
  already loaded, state preserved)` to distinguish it from a genuine first-load.
  The exact set of channels re-requested is computed by the pure
  `reconnectHistoryChannelIds({ activeChannelId, alreadyLoaded, knownChannelIds })`
  helper (unit-tested in `wsGate.test.ts`).
- **Blank-after-show guard:** `reconnectHistoryChannelIds` ALWAYS includes the
  currently-active channel in the re-request set, even on a silent reconnect where
  it is already loaded. This fixes the in-game "blank chat after auto-hide" bug:
  when the socket flaps (the reconnect storm seen during gameplay), the `onopen`
  history burst can be cut off by the socket closing before the response arrives,
  leaving the visible pane blank until a stray live frame lands. Re-requesting the
  one active channel refills it; if its messages are already present the response
  is identical (no visible flash).
- **Visibility reconnect kick:** when the overlay becomes visible again
  (`onVisibility(true)`, e.g. the user pressed Insert after auto-hide) and the
  socket is not currently connected (`connectedRef`), the visibility handler bumps
  `wsReconnectTick` to force an immediate fresh connect instead of waiting out a
  long backoff or the 15 s watchdog. Logged as `[ws-gate] visible — forcing
  reconnect (was disconnected)`.
- On a **silent reconnect** (`alreadyLoaded.size > 0`), a transient dismissible
  notice is displayed in the message area: "Reconnected — you may have missed messages
  while offline." It auto-clears after 8 s. Only shown in auth mode (never in
  `isPublicMode`).
- Lazy load (scroll to top) fetches older pages until the returned batch is
  smaller than `HISTORY_PAGE`.

## Message Timestamps (optional, off by default)

Per-message timestamps are an **opt-in** appearance setting. Two
`WebOverlaySettings` fields drive them (persisted in `fcm_web_overlay_settings`):

| Field | Default | Meaning |
|-------|---------|---------|
| `showTimestamps` | `false` | Master toggle. When off, nothing renders. |
| `timestampFormat` | `'12h'` | `'12h'` ("3:07 PM") or `'24h'` ("15:07"). Only relevant when `showTimestamps` is on. |

**No per-user timezone is captured or broadcast.** Every message already carries a
UTC `createdAt`/`timestamp` (an ISO-8601 project convention). The renderer passes
it through `formatMessageTimestamp(msg.timestamp, settings.timestampFormat)`, which
uses `Date` + `toLocaleTimeString` **with no explicit `timeZone`** — so it renders
in each viewer's own local zone. The same instant therefore shows as the correct
local time for every reader, with zero extra wire data.

- **Placement:** rendered immediately to the right of the channel tag (before the
  username), dimmed (`0.45 × textAlpha`) with `tabular-nums`.
- **Both settings UIs expose it:** the component's built-in modal (website /
  dashboard) and the Electron shell's Appearance panel (`shell.ts`, mirrored into
  `WEB_SETTINGS_KEY` as `showTimestamps` / `timestampFormat`). The 12h/24h picker
  only appears while the toggle is on.

## Reconnect / Auth-Terminal Behavior

### Ticket-fetch retry backoff

`/auth/ws-ticket` retries use the same `backoffDelay(attempt)` full-jitter
exponential backoff (capped at 16 s) as the WS `onclose` path — not a flat
3000 ms delay. This prevents thundering-herd storms when many clients reconnect
after a backend restart.

### Terminal auth state

The component tracks consecutive 401/403 responses from `/auth/ws-ticket` in a
per-effect counter (`consecutiveAuthFailures`). After 3 consecutive auth failures,
the retry loop stops and the component enters **terminal auth state**
(`authTerminalState = true`). An amber banner is shown in the message area:
"Authentication expired — please refresh or sign in again."

- Non-auth failures (network errors, 5xx) reset the consecutive-auth counter and
  keep retrying with backoff — they do not count toward the threshold.
- A successful ticket fetch resets both the counter and the terminal state.
- Any manual reconnect trigger (gate change, `wsReconnectTick` bump) resets the
  terminal state and starts a fresh connect sequence.

Pure helpers exported for testing:
- `nextTicketRetryDelay(attempt, rand?)` — same formula as `backoffDelay`; delegates to it.
- `isAuthTerminal(consecutiveAuthFailures)` — returns true at ≥ 3.

## Dedup Ring

Client-side message-ID dedup ring cap: **1000 entries** (raised from 200). UUID strings,
negligible memory (~50–80 KB). The larger cap prevents a >200-message burst on
dual-socket reconnect from evicting an id and allowing a duplicate render.
(`seenMessageIdsRef` / `seenMessageIdQueueRef`, `ChatOverlay.tsx`)

## @Mention System

### Unread badges

`unreadMentions: Record<channelId, number>` is incremented in the WS `chat:message`
handler only when a live message mentions the current user AND the mentioning channel
is **not** currently in view (`viewCtxRef.current`). Per-tab badge counts are the
sum of the channel and all its sub-channels. Badges are clickable and call
`jumpToMainMention` / `jumpToSubMention`.

Dismissed mention IDs are persisted in `localStorage` (key `fcm-dismissed-mentions`)
so they do not re-appear across reloads.

### Central "Jump to mention" button

The central in-flow button (between the message list and the input) is shown
**only for cross-channel mentions** — i.e., an undismissed `@mention` that arrived
in a channel the user is NOT currently viewing. It is **never** shown for a mention
in the active channel (the user can already see those messages by scrolling).

| Condition | Button shown? |
|-----------|--------------|
| Undismissed @mention in active channel | No |
| Undismissed @mention in any other channel | Yes |

Clicking the button calls `jumpToMainMention` targeting `crossChannelJumpTarget`
(the main channel carrying the most cross-channel unread mentions). This switches
`activeMainId` / `activeSubId` to that channel, sets `pendingJumpRef`, and a
post-render `useEffect` fires `jumpToMention()` to scroll to the mentioning message.

Implementation state variables:
- `hasCrossChannelMention` — `useMemo` over `unreadMentions` filtered to non-active channels
- `crossChannelJumpTarget` — `useMemo` finding the main channel with the highest non-active unread count

### Auto-appear on @mention (Electron only)

The auto-appear trigger fires for **every** @mention of the current user —
**both** active-channel and cross-channel mentions. Rationale: when the overlay is
collapsed or hidden, the user cannot see even the active channel, so a mention there
must still pop the overlay out. (This is distinct from the jump button, which stays
cross-channel-only.)

When any @mention of the user arrives, the WS handler dispatches
`window.dispatchEvent(new CustomEvent('fcm-mention-appear', { detail: { chId } }))`
for every `mentionsMe` message (regardless of `inView`). The `unreadMentions` badge
and jump-button logic remain gated on `!inView` separately.

`shell.ts` listens for this event and:
1. Calls `markActivity()` — un-collapses the overlay if it is idle-collapsed to the header strip.
2. Calls `window.relayBridge.showForMention?.()` — asks main.js to show the window from the system tray if it is hidden.

When the overlay is already visible and on the active channel, this is effectively a
no-op: `markActivity()` only resets the idle timer, and `showForMention`'s
`canShowOverlay()` / already-visible path does nothing — no flicker, no focus steal.

`main.js` handles `overlay:show-for-mention` (IPC channel):
- Checks `canShowOverlay()` — does **not** show if FO76 is not running and the user is not privileged / force-visible.
- Clears `userHidden` so the overlay stays visible after the show (matching game-launch behavior).
- Calls `showWindowInactive()` so the overlay appears without stealing keyboard focus from the game.
- Logs a `[mention]`-tagged diagnostic line to `main.log` for debugging.

> **Device testing required:** the tray-unhide path (`showForMention` → `showWindowInactive`) cannot be verified without a real Electron overlay + game session. Mark as needing device testing before release.

## Tab Selection Persistence (Electron Only)

Module-level variables `lastSelectedMainId` / `lastSelectedSubId`
(`ChatOverlay.tsx:317–318`) survive React remounts caused by the Electron shell
bumping the component key on relay identity changes. The website route manages
its own selection state independently.

## Wiki Lookup Panel (P3)

The wiki lookup feature is implemented entirely inside `ChatOverlay.tsx` without forking.

### Entry points

| Surface | How to open |
|---------|-------------|
| Auth dashboard / Electron overlay | Type `/wiki <term>` and press Enter |
| Auth dashboard / Electron overlay | Type `/wiki ` then 2+ chars — autocomplete dropdown appears |

The wiki lookup is **auth-only** — it is not available on the logged-out public website (no chip/button/panel).

### Slash-command autocomplete (wiki mode)

Activates when `inputText` starts with `/wiki ` and has 2+ chars of term. Runs on separate state (`wikiAcItems / wikiAcOpen / wikiAcLoading`) so it is mutually exclusive with the slash-command autocomplete. Debounced 280ms, AbortController cancels in-flight requests. Each row shows: thumbnail (28×24, `object-fit:contain`, `?` on error), name (ellipsis), kind badge. Keyboard: `ArrowUp/Down` wraps, `Enter/Tab` selects, `Esc` clears.

### WikiPanel component

Inline component (not a separate file) portalled to `<body>` at `zIndex 20000`, mirroring the `SettingsModal` pattern. Right-drawer layout (`min(420px, 45vw)`).

**States:** `loading` (spinner) / `success` (full card with image + stats) / `no-infobox` (image + "no stat data") / `error` (message + Retry) / `not-found` (message + Close).

**Chrome bar:** Back `◄` (disabled when history empty, cap 10) · `◈ FALLOUT WIKI` title · Close `✕`. Esc closes. Backspace also goes back (when not typing). The `navigate(title)` helper pushes the current `wikiTitle` onto the history stack (cap 10) then calls `fetchEntry(title, pushHistory=true)`; after navigating, the Back button becomes enabled.

**Image area / carousel:** Derives the display image list from `entry.images` (primary first); falls back to a single-item list built from `entry.imageUrl` for back-compat. When `images.length > 1`, renders a carousel: `‹` / `›` arrow buttons (Pip-Boy styled), dot indicators (click to jump), and an `n / N` counter. Left/Right arrow keys cycle when the panel is open and no `<input>` or `<textarea>` is focused (carousel index resets to 0 on every new entry). Each image: `object-fit:contain`, transparent bg. Max-height per `imageAspect` (or `images[idx].aspect`): ultrawide 72px / portrait 200px / square 160px / unknown 140px. Loading shimmer while loading; broken-image fallback `?` + "IMAGE UNAVAILABLE". A `MAP` badge overlay appears on images where `isMap=true`. Panel skipped entirely when no images are available.

**Stat rows:** per-kind field subsets (spec §3.4). Absent fields omitted. Mono-weight labels (`font-family` forced to Courier New when the theme is sans-serif). `other/unknown` kind shows first 14 raw infobox pairs.

**Locations section:** When `entry.locations.length > 0`, rendered between the stat rows and the actions bar: a `LOCATIONS` subheading (monospace, dimmed, uppercase) followed by a bulleted `<ul>`. Each location is a clickable hyperlink (`primaryColor`, underlined and fully bright on focus/hover, cursor pointer). Clicking or pressing Enter/Space on a location calls `navigate(locationName)` to open that location's wiki entry (which typically has a map image). Location rows participate in the roving-focus system (see Keyboard Navigation below). The focused row has a subtle `primaryColor` background tint and `locationFocusIdx` stays in sync with `panelFocusIdx`.

**Actions bar:** Share to Chat (hidden in `isPublicMode`) · View Article `↗` (uses `relayBridge.openExternal` in Electron, `window.open` on web) · Copy Link (uses `relayBridge.writeClipboard` in Electron; 2s "COPIED!" flash). All action buttons show a `primaryColor` outline + faint background when keyboard-focused via the roving-focus system.

**Share-to-Chat modal:** Clicking "Share to Chat" opens a Pip-Boy-styled modal (portalled to `<body>`, `zIndex 9100`) instead of posting immediately. The modal contains a `<select>` listing the four FO76 built-in channels (General / Trade / Events / Raids) followed by a separator and then the user's joined parties. The Fallout 76 main channel is never listed. Confirming sends `chat:send` with `metadata.type = 'wiki_share'` to the chosen `channelId`. Cancel or clicking the backdrop closes without posting. `WIKI_SHARE_CHANNELS` constant holds the four seeded UUIDs. `handleWikiShareToChat(entry, channelId)` in the parent now accepts the target channel/party ID directly. The modal state is: `shareModalOpen` (bool) + `shareTargetId` (string, defaults to General UUID). Hidden entirely when `isPublicMode`.

**Keyboard hint footer:** A thin row below the actions bar always shows: `↑↓ navigate · ←→ images/move · Enter select · Backspace back · Del close`. Styled in `secondaryColor` at 45% opacity so it is visible but unobtrusive.

**Attribution footer:** `Fallout Wiki · CC-BY-SA 3.0` always visible (in the chrome bar title button).

### WikiPanel keyboard navigation

The panel uses a **roving focus** model — `panelFocusIdx` (integer, -1 = none) is an index into a derived `focusTargets` array that is recomputed from current render state. All keys fire only in the capture-phase keydown listener and are suppressed when `typing` is detected (active element is a non-empty input/textarea/contenteditable).

**Focus target order:**
1. Back button (chrome bar)
2. Close button (chrome bar)
3. Carousel prev `‹` (only when `carouselImages.length > 1`)
4. Carousel dot buttons × N (only when `carouselImages.length > 1`)
5. Carousel next `›` (only when `carouselImages.length > 1`)
6. Share to Chat (only when `!isPublicMode` and entry loaded)
7. View Article
8. Copy Link
9. Location link × M (one per `entry.locations` item)

**Key bindings:**

| Key | Behaviour |
|-----|-----------|
| `ArrowDown` | Move focus ring forward through all targets (wraps) |
| `ArrowUp` | Move focus ring backward through all targets (wraps) |
| `ArrowRight` | When focused on a carousel target → advance carousel image. Otherwise → move focus ring forward (same as Down) |
| `ArrowLeft` | When focused on a carousel target → retreat carousel image. Otherwise → move focus ring backward (same as Up) |
| `Tab` | Move focus ring forward (Shift+Tab = backward); prevents browser default |
| `Enter` | Activate the focused target (click its action) |
| `Backspace` | Go back a page (history pop); only when history is non-empty |
| `Delete` | Close the wiki panel |
| `Escape` | Close the wiki panel (fires even when typing) |

**Visual indicator:** Focused button gets `outline: 2px solid primaryColor; outlineOffset: 1px` and `background: primaryColor @ 12%` via `focusedStyle(targetId)` helper. Location rows additionally show a faint `primaryColor` tint on the row `<li>` background (synced via `locationFocusIdx`).

**Reset points:** `panelFocusIdx` resets to -1 on every navigation (`navigate()`, `goBack()`, `fetchEntry()`). The target list length is watched via `useEffect`; if the list shrinks below `panelFocusIdx`, it resets to -1 to avoid out-of-bounds activation.

### Chat embeds — the standard

Metadata-bearing messages render through two shared components in `components/`, with one shared stylesheet `components/chat-embeds.css` (the only chat code that uses CSS classes instead of inline styles — true responsiveness needs container queries). The rule that decides which to use:

- **Ephemeral / sender-only responses → boxed `ChatEmbedCard`** (`.fcm-embed*`). Used by `nuke_codes` and `server_status` (the private `/nukecodes` & `/serverstatus` replies). Distinct accent per type (nuke `#FF6B4A`, server `#55EFC4`/red), a `tag`, optional `title`/`badges`/`inlineMeta`/`actions`, and an auto-fitting label→value `fields` grid. Container-query responsive: one row when wide, wraps as it narrows. Each card sets `--fcm-accent` + font-size custom properties; layout lives in CSS.

- **Static, broadcast-to-everyone messages → inline `ChatInlineEmbed`** (`.fcm-inline*`). Used by `wiki_share` and `party_invite`. These DON'T render a box — they're built as the message **content** and returned via the `inlineContent` variable so the message falls through to the **normal message renderer**; the channel tag + sender name are therefore the exact same code as every other message. Composition: `[icon] [lead] [title (link+glow)] [badge] · [meta link] [action]`. Wiki: `◈ <name> [KIND] · Fallout Wiki ↗` (name opens the WikiPanel via `openWikiPanel`; the meta link opens the article externally for attribution). Party: `✦ invited everyone to <PartyName> [PARTY] [JOIN/JOINED]`.

Never `dangerouslySetInnerHTML`; the wiki share content carries no external URL itself (the bot bridges a hyperlink to Discord separately).

### Public mode

The wiki lookup is **not available** in logged-out public mode — there is no entry affordance (the input is hidden and no chip is shown). The feature is dashboard + Electron overlay only.

### Electron guards

- `relayBridge.openExternal` for View Article (keeps focus in the game window).
- `relayBridge.writeClipboard` for Copy Link.
- Panel closes on Esc (standard). No explicit idle-collapse or click-through guard added at component level (shell manages those).

### Colors and theming

All colors derive from the active `WebTheme` (uses `hexAlpha`, `menuBgColor`). Scanlines and glow honored for the chrome bar title. Kind badge colors are semantic constants (`WIKI_KIND_COLORS`) independent of the theme. Stat-row labels use a monospace stack regardless of theme font.

## Offline Outbox

When the WebSocket is down (disconnected, reconnecting), outgoing `chat:send` messages are queued
rather than silently dropped. The queue auto-flushes in FIFO order the moment the WS reconnects.

**Implementation:** `admin-dashboard/src/features/chat/outboxQueue.ts` — a pure, React-free
`OutboxQueue` class wired into `ChatOverlay` via `outboxRef` (`useRef<OutboxQueue>`).

**Limits:**
- Maximum **50** entries — the oldest is dropped when the cap is exceeded (newest intent is kept).
- Maximum **age 5 minutes** on flush — entries queued more than 5 minutes ago are discarded (not
  sent) to avoid delivering stale context to chat.

**Drain-from-front flush pattern:** `flush()` uses a `shift()`-based drain — each entry is
removed from the queue **only after a successful send**. A throw from `send()` (e.g. socket
closes mid-flush) leaves the failed entry and all subsequent entries intact in the queue for the
next reconnect. This prevents any un-sent entry from being silently lost if an exception occurs
anywhere in the flush loop.

**What is queued:**
- All `chat:send` user messages: direct channel sends, `/camp`, `/g /t /e /r /i` relay shortcuts,
  wiki shares, card shares from the CAMP/NukeCrypt/ServerStatus cards.

**What is NOT queued:**
- `party:send` — party state (membership, party ID) may be stale after a reconnect; silently
  discarded if the WS is down.
- `openSharedCard` re-runs — ephemeral; only relevant to the local session.
- `chat:typing`, keepalive/`client:status`, history requests — not user messages.

**Public mode:** the outbox is completely inert in `isPublicMode` (public mode uses REST polling
and never opens an authenticated WebSocket; `sendOrQueueChat` gates on `isPublicMode` before
enqueuing anything).

**Pending indicator:** while disconnected with queued entries, a small amber `N queued` label
appears next to the status dot in the overlay header (hidden in public mode).

**Tests:** `admin-dashboard/src/features/chat/__tests__/outboxQueue.test.ts` (Vitest, 14 tests —
includes drain-from-front invariant coverage).

## Electron WS Proxy Hardening (main.js)

The Electron main process owns `proxy:ws:open / proxy:ws:send / proxy:ws:close` IPC channels
that bridge the renderer's shimmed `WebSocket` to the upstream relay over an `X-Auth-Token`
session (install-token flow, no browser cookies).

### Token-ready gate (deferred open)

When `proxy:ws:open` arrives before `sessionToken` is set (race between registration and the
renderer's first connect attempt), the id is queued in `pendingWsOpens` (FIFO, capped at
`PROXY_OPEN_QUEUE_MAX = 8`) instead of immediately sending `proxy:ws:close { code: 4001 }`.
`flushPendingWsOpens()` is called at every point where `sessionToken` becomes non-null
(post-register, post-Discord-link, post-username-set). Once flushed, each pending open proceeds
through the normal `openRelaySocket()` path.

If the pending queue overflows (>8 entries), the oldest entry is evicted with a 4001 close and
the new id is accepted.

### CONNECTING-state send buffer

`proxy:ws:send` frames that arrive while the upstream socket is in `CONNECTING` state are buffered
in `relaySendBuffers` (per socket id, capped at `PROXY_SEND_BUF_MAX = 64` frames; oldest dropped
with a diag log on overflow). The buffer is flushed in order on the socket's `'open'` event.
Frames that arrive in `CLOSING`/`CLOSED` state are silently dropped (the renderer will receive
a `proxy:ws:close` event).

### Socket leak prevention

`proxy:ws:close` removes the socket from both `relaySockets` and `relaySendBuffers` and calls
`sock.close()` so the upstream relay connection is always torn down when the renderer's logical
socket closes.

## Related

- [theming.md](./theming.md) — theme system and CSS variable details
- [../overlay/](../overlay/) — Electron shell (window chrome, IPC, keybinds)
- [../realtime/](../realtime/) — WebSocket protocol and envelope format
