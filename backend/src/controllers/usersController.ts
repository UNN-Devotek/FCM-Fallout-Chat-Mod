import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/prisma';
import { Prisma } from '@prisma/client';
import { getRedisClient } from '../config/redis';
import { createError } from '../middleware/errorHandler';
import { paramStr, paramsOf } from '../utils/reqParams';
import env from '../config/environment';
import logger from '../config/logger';
import { computeDiscriminator } from '../utils/discriminator';
import { constantTimeEquals } from '../utils/constantTimeEquals';
import { SHORT_ALPHA_BLACKLIST, LOOKS_LIKE_PROVIDER, LOOKS_LIKE_CAMELCASE_METHOD } from '../utils/nameBlacklist';
import { setSpamImmunity, findProhibitedPhrase } from '../services/autoModService';
import { buildAvatarUrl } from '../services/avatarService';
import { refreshClientIdentity } from '../websocket/handlers';
import { mergeUserInto } from '../utils/mergeUser';
import { setChatName } from '../services/chatNameService';

// 24 hours — ephemeral overlay session; the overlay silently re-registers via its install
// token on reconnect. Discord re-auth enforced separately by the 30-day window (discordAuthedAt).
const SESSION_TTL_SECONDS = 24 * 60 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(id: string): boolean { return UUID_RE.test(id); }

/**
 * GET /api/users -- moderator+
 * Supports ?search= (username or steamId prefix) and pagination (?limit=&offset=)
 */
async function listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
  const rawSearch = (req.query.search as string) || '';

  try {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let users;
    if (uuidPattern.test(rawSearch)) {
      // UUID search -- exact match on install_token
      users = await prisma.user.findMany({
        where: { installToken: rawSearch },
        select: {
          id: true, username: true, steamId: true,
          discordId: true, discordUsername: true, discordAvatar: true,
          isBanned: true, isMuted: true, muteExpiresAt: true, banReason: true, createdAt: true,
        },
        take: limit,
        skip: offset,
      });
    } else {
      // Name/steamId prefix search
      users = await prisma.user.findMany({
        where: rawSearch ? {
          OR: [
            { username: { startsWith: rawSearch, mode: 'insensitive' } },
            { steamId: { startsWith: rawSearch, mode: 'insensitive' } },
          ],
        } : undefined,
        select: {
          id: true, username: true, steamId: true,
          discordId: true, discordUsername: true, discordAvatar: true,
          isBanned: true, isMuted: true, muteExpiresAt: true, banReason: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
    }
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/mention-search?q=<query>
 * Public — no auth required. Returns the public display name for @ mention
 * autocomplete plus the user's Discord ID (when linked), so clients can attach
 * the unambiguous Discord ID to a message at send time — backend then swaps
 * `@name` → `<@discordId>` on the Discord relay without fuzzy matching.
 *
 * Discord IDs are not secret (anyone in a server can copy them via Discord
 * itself), but we intentionally do NOT return our internal user UUIDs here.
 * SR-011: still skip internal username slugs (discord:<id>) so a Discord ID
 * can never leak as a DISPLAY NAME via that field.
 */
export async function mentionSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = (req.query.q as string) ?? '';
  const q = raw.replace(/[<>"'&;\\]/g, '').trim().slice(0, 32);
  if (q.length < 2) {
    res.json({ data: [] });
    return;
  }
  try {
    const users = await prisma.user.findMany({
      where: {
        isBanned: false,
        ...(q.length > 0 && {
          OR: [
            { chatName: { contains: q, mode: 'insensitive' } },
            { username: { contains: q, mode: 'insensitive' } },
            { discordUsername: { contains: q, mode: 'insensitive' } },
            { discordDisplayName: { contains: q, mode: 'insensitive' } },
          ],
        }),
      },
      select: { chatName: true, username: true, discordUsername: true, discordDisplayName: true, discordId: true },
      take: 8,
    });
    const seen = new Set<string>();
    const data: { displayName: string; discordId: string | null }[] = [];
    for (const u of users) {
      const isFo76Name = u.username && u.username !== 'Wanderer'
        && !u.username.startsWith('discord:')
        && !u.username.startsWith('pending-')
        && !/^overlay\d+$/i.test(u.username);
      const name = u.chatName ?? (isFo76Name
        ? u.username!
        : (u.discordDisplayName ?? u.discordUsername ?? null));
      if (!name) continue;
      if (!seen.has(name)) { seen.add(name); data.push({ displayName: name, discordId: u.discordId ?? null }); }
    }
    res.json({ data });
  } catch (err) { next(err); }
}

/**
 * POST /api/users
 * Register / re-authenticate game client.
 * Requires X-App-Client-Key header matching APP_CLIENT_KEY env var.
 * Returns { data: { userId, token } }
 */
async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { username, steamId, installToken } = req.body;

  // ── Device-keypair auth gate ────────────────────────────────────────────────
  // An install authenticates to register by EITHER:
  //   (a) signing the request with its enrolled device key, OR
  //   (b) presenting the shared X-App-Client-Key (legacy / not-yet-enrolled).
  // Per-install ratchet: once an install has an enrolled, non-revoked device
  // key, path (b) is REJECTED for it — it MUST sign (prevents downgrade).
  // A `publicKey` field on the (b) path triggers trust-on-first-use enrolment.
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { extractSignatureHeaders, verifySignedRequest, isValidP256Spki } = require('../services/deviceAuthService');
    const sigHdrs = extractSignatureHeaders(req.headers as Record<string, unknown>);

    // Resolve enrolment state once — it decides whether a signature FAILURE may
    // fall back to the client key. An enrolled install MUST sign correctly; a
    // bad/replayed/stale signature from it is rejected outright (no downgrade).
    const enrolled = (typeof installToken === 'string' && installToken)
      ? await prisma.device.findUnique({ where: { installToken }, select: { revokedAt: true } })
      : null;
    const enrolledActive = !!enrolled && !enrolled.revokedAt;

    let signedOk = false;
    if (sigHdrs) {
      const path = (req.originalUrl || req.url).split('?')[0];
      const rawBody: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
      const r = await verifySignedRequest(req.method, path, rawBody, sigHdrs);
      if (r.ok) {
        signedOk = true;
      } else if (enrolledActive) {
        // Signature present + install enrolled, but verification failed (replay,
        // tamper, stale, key mismatch). Reject with the real reason — do NOT
        // fall through to the shared-key path. Closes the "enrolled install
        // replays a sig + sends client key → succeeds" gap directly, instead of
        // relying on the M2 client-key block as a backstop.
        return next(createError(r.status, `Device auth failed: ${r.reason}`));
      } else if (r.status === 403) {
        // revoked key — never fall through
        return next(createError(403, `Device auth failed: ${r.reason}`));
      }
      // not enrolled + bad/no sig → fall through to client-key TOFU path (M1)
    }

    if (!signedOk) {
      // An enrolled, active install may not fall back to the shared-key path.
      if (enrolledActive) {
        return next(createError(403, 'This install is enrolled for signed auth; client-key path is disabled for it.'));
      }
      const expectedKey = env.APP_CLIENT_KEY;
      if (!expectedKey) return next(createError(503, 'Registration unavailable: server misconfigured'));
      const clientKey = req.headers['x-app-client-key'] as string | undefined;
      if (!clientKey || !constantTimeEquals(clientKey, expectedKey)) {
        return next(createError(403, 'Invalid or missing client key'));
      }
      // TOFU enrolment: client-key path may carry a publicKey to enrol now.
      const pk = (req.body as { publicKey?: unknown }).publicKey;
      if (typeof pk === 'string' && pk && typeof installToken === 'string' && installToken) {
        if (!isValidP256Spki(pk)) return next(createError(422, 'publicKey must be a P-256 SPKI DER (base64)'));
        await prisma.device.upsert({
          where: { installToken },
          create: { installToken, publicKey: pk },
          update: { publicKey: pk, revokedAt: null, enrolledAt: new Date() },
        });
      }
    }
  }

  // Accept optional Discord identity fields so the overlay can keep the DB in
  // sync with its locally-stored OAuth result. Only applied when non-empty —
  // we never clear Discord fields via register() (the link callback owns that).
  const discordIdRaw            = typeof req.body.discordId            === 'string' ? req.body.discordId.trim()            : '';
  const discordUsernameRaw      = typeof req.body.discordUsername      === 'string' ? req.body.discordUsername.trim()      : '';
  const discordAvatarRaw        = typeof req.body.discordAvatar        === 'string' ? req.body.discordAvatar.trim()        : '';
  const discordDisplayNameRaw   = typeof req.body.discordDisplayName   === 'string' ? req.body.discordDisplayName.trim()   : '';
  const discordPatch: {
    discordId?: string; discordUsername?: string; discordAvatar?: string; discordDisplayName?: string;
  } = {};
  if (discordIdRaw          && /^\d{15,22}$/.test(discordIdRaw)) discordPatch.discordId          = discordIdRaw;
  if (discordUsernameRaw)                                        discordPatch.discordUsername    = discordUsernameRaw;
  if (discordAvatarRaw)                                          discordPatch.discordAvatar      = discordAvatarRaw;
  if (discordDisplayNameRaw)                                     discordPatch.discordDisplayName = discordDisplayNameRaw;

  try {
    // ── Discord-gate: desktop overlay installs MUST have a linked Discord account ──
    // An installToken that has no row yet, or has a row with no discordId, is
    // treated as unlinked. We return 403 with a discord_auth_required signal so the
    // overlay renderer shows a blocking login wall instead of creating an anonymous
    // user. The user-creation path runs at /auth/discord/link (just before the
    // OAuth redirect) so the first call here after linking finds an existing row
    // with a real discordId and proceeds normally.
    //
    // Skip this gate when:
    //  (a) The installToken already belongs to a Discord-linked row → allow (existing users).
    //  (b) discordId is supplied in the request body (re-register right after OAuth) → allow.
    {
      const existingRow = await prisma.user.findUnique({
        where: { installToken },
        select: { discordId: true, discordAuthedAt: true },
      });
      const incomingDiscordId = discordIdRaw && /^\d{15,22}$/.test(discordIdRaw) ? discordIdRaw : null;
      // Linked for this load = JUST completed OAuth (incoming discordId) OR an
      // existing Discord link whose last auth is still inside the 30-day re-auth
      // window. After 30 days the link goes stale -> 403 -> the overlay shows the
      // login wall -> a fresh OAuth resets discordAuthedAt. Existing linked users
      // were grandfathered to now() in the add_discord_authed_at migration, so this
      // does NOT force a mass re-auth on deploy.
      const REAUTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
      const freshAuth = !!(
        existingRow?.discordId
        && existingRow.discordAuthedAt
        && (Date.now() - new Date(existingRow.discordAuthedAt).getTime()) < REAUTH_WINDOW_MS
      );
      const isLinked = !!incomingDiscordId || freshAuth;
      if (!isLinked) {
        // No row yet, or row exists but no Discord link. Reject with a clear signal.
        // HTTP 403 + discord_auth_required flag so the client can show the login wall.
        res.status(403).json({
          type: 'about:blank',
          title: 'Discord Authentication Required',
          status: 403,
          detail: 'You must link a Discord account before using the overlay.',
          discord_auth_required: true,
        });
        return;
      }
    }

    // Check if another user already has this username
    const existing = await prisma.user.findFirst({
      where: { username, NOT: { installToken } },
      select: { id: true, discordId: true, discordUsername: true },
    });
    if (existing) {
      // Allow self-reclaim: same Discord user registering from a new install.
      // The link/callback transfers installToken but if it didn't complete, we
      // detect it here and finish the transfer so the user can recover their account.
      //
      // Self-reclaim matches ONLY on discordId (the OAuth-anchored, server-verified
      // identity). Matching on discordUsername was an account-takeover vector —
      // Discord usernames are public and changeable; they are not an auth factor.
      const requestingUser = await prisma.user.findUnique({
        where: { installToken },
        select: { discordId: true },
      });
      const isSelfReclaim =
        existing.discordId != null &&
        requestingUser?.discordId != null &&
        existing.discordId === requestingUser.discordId;

      // Also allow reclaim when the conflicting row is unlinked (no discordId):
      // an anonymous row can't prove ownership, but a Discord-linked requesting
      // user can legitimately claim any name that has no Discord anchor.
      const conflictingRowIsUnlinked = existing.discordId == null;
      const requestingUserIsLinked = requestingUser?.discordId != null;
      const isUnlinkedReclaim = conflictingRowIsUnlinked && requestingUserIsLinked;

      if (!isSelfReclaim && !isUnlinkedReclaim) {
        return next(createError(409, 'That Fallout 76 name is already registered by another user.'));
      }

      // Complete the installToken transfer: merge the placeholder into the canonical
      // existing row (re-points ALL FK tables via mergeUserInto), then claim the
      // installToken. Sequential transaction so the unique install_token is never
      // doubly held.
      const placeholder = await prisma.user.findUnique({ where: { installToken }, select: { id: true } });
      await prisma.$transaction(async (tx) => {
        if (placeholder && placeholder.id !== existing.id) {
          await mergeUserInto(existing.id, placeholder.id, tx);
        }
        await tx.user.update({ where: { id: existing.id }, data: { installToken } });
      });
    }

    // Decide what Discord fields to apply safely. Rules:
    //  - Discord profile fields (username/avatar/displayName) always sync from the overlay.
    //  - discordId is the identity anchor and only gets set if (a) this row has no
    //    discordId yet AND (b) no other row already claims that discordId.
    //    This prevents client-provided payloads from overwriting Discord links
    //    established via the OAuth callback or impersonating another user.
    const safePatch: typeof discordPatch = { ...discordPatch };
    if (safePatch.discordId) {
      const currentRow = await prisma.user.findUnique({
        where: { installToken },
        select: { discordId: true },
      });
      if (currentRow?.discordId) {
        delete safePatch.discordId; // already linked via callback — never overwrite
      } else {
        const conflict = await prisma.user.findFirst({
          where: { discordId: safePatch.discordId, NOT: { installToken } },
          select: { id: true },
        });
        if (conflict) delete safePatch.discordId; // another row owns this id
      }
    }

    // Name stickiness: once a real FO76 name was detected for this install,
    // never allow a later re-register with pending-* to overwrite it. The
    // memory-marker name scanner is fragile (markers are only resident in
    // specific FO76 states: login, social menu, friends list). Without this
    // guard, any re-register when markers aren't resident would revert a
    // healthy row back to pending-XXXXX.
    //
    // Priority when deciding what username to store:
    //   1. If incoming `username` is a real name -> always use it (latest scan wins).
    //   2. If incoming is pending-* AND existing row has a real name -> keep existing.
    //   3. If existing row is also pending-* OR absent -> use the pending-* (fresh install).
    let effectiveUsername = username;
    // Reject Scaleform-data-provider identifier leaks (e.g. "ScreenResolutionData",
    // "CharacterProfileTextureBuffer"). These are internal FO76 UI identifier
    // strings that end up in memory adjacent to the character-name anchor and
    // the client memory scanner can misextract them as the "name". They have
    // a distinctive shape (PascalCase, no spaces, specific suffixes) that real
    // player names never share. Treat them like pending-* — keep existing row.
    // LOOKS_LIKE_PROVIDER, LOOKS_LIKE_CAMELCASE_METHOD, SHORT_ALPHA_BLACKLIST
    // are imported from ../utils/nameBlacklist — shared with unit tests.
    const looksLikeProviderLeak =
      typeof username === 'string' &&
      (LOOKS_LIKE_PROVIDER.test(username)
        || LOOKS_LIKE_CAMELCASE_METHOD.test(username)
        || username.startsWith('m_')
        || username === 'characterName' || username === 'accountId' || username === 'avatarId'
        || SHORT_ALPHA_BLACKLIST.has(username)
      );

    // Predicate for stored usernames — must mirror the incoming-value check above.
    const isBadStoredUsername = (s: string) =>
      s.startsWith('pending-')
      || LOOKS_LIKE_PROVIDER.test(s)
      || LOOKS_LIKE_CAMELCASE_METHOD.test(s)
      || s.startsWith('m_')
      || s === 'characterName' || s === 'accountId' || s === 'avatarId'
      || SHORT_ALPHA_BLACKLIST.has(s);

    // DB-backed name blacklist (admin-editable). Catches FO76 item/menu strings
    // that the memory reader latches onto when the character-name region shifts
    // (e.g. "Basic Repair Kit"). The hardcoded checks above catch Scaleform
    // identifier leaks; the DB blacklist catches everything else admins flag at runtime.
    let dbBlacklistHit: { pattern: string; matchType: string } | null = null;
    if (typeof username === 'string') {
      try {
        const { findBlacklistMatch } = await import('../services/nameBlacklistService.js');
        const m = findBlacklistMatch(username);
        if (m) dbBlacklistHit = { pattern: m.pattern, matchType: m.matchType };
      } catch { /* non-fatal — predicate returns false on init failure */ }
    }

    if (typeof username === 'string' && (username.startsWith('pending-') || looksLikeProviderLeak || dbBlacklistHit)) {
      const existingRow = await prisma.user.findUnique({
        where: { installToken },
        select: { username: true },
      });
      if (existingRow?.username && !isBadStoredUsername(existingRow.username)) {
        effectiveUsername = existingRow.username;
      } else if (looksLikeProviderLeak || dbBlacklistHit) {
        effectiveUsername = `pending-${installToken.slice(0, 8)}`;
        logger.warn({
          installToken, leaked: username, prevStored: existingRow?.username,
          rejectReason: dbBlacklistHit ? `db-blacklist:${dbBlacklistHit.pattern}` : 'scaleform-leak',
        }, '[register] rejected username — using pending placeholder');
      }
      if (dbBlacklistHit) {
        // Set a header so the desktop client can trigger an immediate rescan
        // instead of waiting for the next periodic memory walk.
        res.setHeader('X-Name-Rescan-Required', '1');
        res.setHeader('X-Name-Rejected-Pattern', dbBlacklistHit.pattern);
        // Also push WS event to any already-connected sessions for this
        // user, so the desktop can react even when register is just a
        // periodic refresh (not a fresh connect).
        try {
          const { pushToUser } = await import('../websocket/handlers.js');
          const userRow = await prisma.user.findUnique({ where: { installToken }, select: { id: true } });
          if (userRow?.id) {
            pushToUser(userRow.id, {
              type: 'name:rescan-required',
              payload: { rejectedPattern: dbBlacklistHit.pattern, matchType: dbBlacklistHit.matchType },
            });
          }
        } catch (err) {
          logger.warn({ err }, '[register] WS push for rescan-required failed (non-fatal)');
        }
      }
    }

    // Prohibited-content check: reject usernames that contain hate speech, slurs,
    // or explicit terms — the same zero-tolerance filter used for party names.
    // Only apply to real names (not pending-* placeholders) so FO76 name scans
    // that resolve to a real string get checked before being persisted.
    if (
      typeof effectiveUsername === 'string' &&
      !effectiveUsername.startsWith('pending-') &&
      effectiveUsername !== 'Wanderer'
    ) {
      try {
        const prohibitedPhrase = await findProhibitedPhrase(effectiveUsername);
        if (prohibitedPhrase) {
          logger.warn(
            { installToken, username: effectiveUsername, phrase: prohibitedPhrase },
            '[register] rejected username — contains prohibited phrase',
          );
          // Replace with a pending placeholder so the user still gets a session
          // but their prohibited name is never persisted as a visible display name.
          effectiveUsername = `pending-${installToken.slice(0, 8)}`;
          res.setHeader('X-Name-Rejected-Reason', 'prohibited-content');
        }
      } catch (err) {
        // Non-fatal: log and continue — better to allow the name than 500 the user.
        logger.warn({ err }, '[register] findProhibitedPhrase failed (non-fatal)');
      }
    }

    // Fetch the current row before upsert so we can detect a username rename
    // and record the old name in user_aliases.
    const preUpsertRow = await prisma.user.findUnique({
      where: { installToken },
      select: { username: true },
    });

    // Upsert user by install token.
    const user = await prisma.user.upsert({
      where: { installToken },
      update: {
        username: effectiveUsername,
        steamId: steamId || undefined,
        ...safePatch,
      },
      create: {
        username: effectiveUsername,
        steamId: steamId || null,
        installToken,
        ...safePatch,
      },
      select: { id: true, username: true, chatName: true, isBanned: true, discordId: true, discordUsername: true, discordDisplayName: true, discordAvatar: true },
    });

    // Record previous username in alias history when it changes to a new real name.
    // Only record if the old name was a real name (not a placeholder).
    const isPlaceholder = (n: string) =>
      n === 'Wanderer'
      || n.startsWith('pending-')
      || n.startsWith('discord:')     // discord:<id> placeholder set by link callback
      || /^overlay\d+$/i.test(n);    // Overlay<digits> auto-generated default
    if (
      preUpsertRow?.username &&
      !isPlaceholder(preUpsertRow.username) &&
      preUpsertRow.username !== effectiveUsername
    ) {
      // Use raw query so the call compiles before `prisma generate` has been run
      // in the deployment pipeline (the Prisma client is regenerated at startup).
      (prisma as any).$executeRaw`
        INSERT INTO user_aliases (user_id, alias)
        VALUES (${user.id}::uuid, ${preUpsertRow.username})
        ON CONFLICT (user_id, alias) DO NOTHING
      `.catch(() => { /* non-fatal */ });
    }

    if (Object.keys(safePatch).length > 0) {
      logger.info({
        userId: user.id, installToken, applied: Object.keys(safePatch),
      }, '[register] synced discord identity from overlay payload');
    }


    // Nickname sync: when the user has a linked Discord account and a genuine FO76
    // name, ask the bot to update their guild nickname. Fire-and-forget — never fail
    // registration on a nickname error.
    //
    // Skip when the name is a placeholder, matches an auto-generated handle pattern
    // (word + digits, e.g. "overlay8329"), or equals the user's Discord display/username
    // (i.e. it is the onboarding prefill, not a typed FO76 name). Be conservative.
    const looksLikeAutoHandle = (n: string) => {
      const t = n.trim();
      // Case-insensitive: "Overlay<digits>" is the overlay's own auto-generated default.
      if (/^overlay\d+$/i.test(t)) return true;
      // Generic auto-handle shape: a word followed by digits with no spaces.
      return /^[a-z]+\d{2,}$/i.test(t);
    };
    const equalsDiscordIdentity = (n: string) => {
      const lc = n.trim().toLowerCase();
      return (
        (!!user.discordUsername && lc === user.discordUsername.toLowerCase()) ||
        (!!user.discordDisplayName && lc === user.discordDisplayName.toLowerCase())
      );
    };
    const isGenuineFo76Name =
      !!effectiveUsername &&
      !isPlaceholder(effectiveUsername) &&
      !looksLikeAutoHandle(effectiveUsername) &&
      !equalsDiscordIdentity(effectiveUsername);

    if (user.discordId && isGenuineFo76Name) {
      try {
        const { syncSupporterNickname } = require('../services/supporterNicknameService');
        syncSupporterNickname(user.discordId).catch((err: Error) => {
          logger.warn({ err, userId: user.id, discordId: user.discordId }, '[register] setMemberNickname fire-and-forget error (non-fatal)');
        });
      } catch (err) {
        logger.warn({ err, userId: user.id }, '[register] failed to import discordService for nickname sync (non-fatal)');
      }
    } else if (user.discordId && isPlaceholder(effectiveUsername)) {
      // User has no real FO76 name yet — clear any stale Discord nickname that
      // may have been set by a previous bug (discord:<id> or pending-* as nick).
      try {
        const { setMemberNickname } = require('../services/discordService');
        setMemberNickname(user.discordId, '').catch(() => { /* non-fatal */ });
      } catch { /* non-fatal */ }
    } else if (user.discordId && effectiveUsername && !isPlaceholder(effectiveUsername)) {
      // Real-looking but ambiguous (auto-handle or matches Discord identity) —
      // log why we declined so future false-skips can be triaged.
      logger.debug({
        userId: user.id, effectiveUsername,
        reason: looksLikeAutoHandle(effectiveUsername) ? 'auto-handle' : 'equals-discord-identity',
      }, '[register] skipped Discord nickname sync — not a genuine FO76 name');
    }

    // Push the freshly-saved name onto any live WebSocket sessions for this
    // user so an already-connected overlay renders the new FO76 name
    // immediately. Defensive: if the websocket module isn't yet initialized
    // (circular-import race, cold boot), skip silently rather than 500 the
    // register call — the WS refresh is a nice-to-have, not a hard dep.
    try {
      if (typeof refreshClientIdentity === 'function') {
        const touched = refreshClientIdentity(user.id, user.username, user.discordUsername, user.discordDisplayName, installToken, user.chatName);
        if (touched > 0) {
          logger.info({ userId: user.id, username: user.username, touched }, '[register] refreshed WS identity cache');
        }
      }
    } catch (err) {
      logger.warn({ err, userId: user.id }, '[register] refreshClientIdentity failed (non-fatal)');
    }

    if (user.isBanned) {
      return next(createError(403, 'This account is banned.'));
    }

    // Discriminator returned for back-compat but no longer appended to displayed names.
    const discriminator = computeDiscriminator(installToken);
    const displayName = username;

    // Issue a new session token
    const token = uuidv4();
    const redis = await getRedisClient();
    await redis.set(`session:${token}`, user.id, { EX: SESSION_TTL_SECONDS });

    // Persist session record to DB (best-effort, non-blocking)
    prisma.session.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) },
    }).catch((err: Error) => logger.warn({ err }, 'Failed to persist session to DB'));

    // Resolve admin/mod role (if any) for the overlay tray menu. Additive — older clients ignore it.
    let userRole: string | null = null;
    if (user.discordId) {
      try {
        const adminRow = await prisma.adminUser.findUnique({
          where: { discordId: user.discordId },
          select: { role: true },
        });
        if (adminRow?.role) userRole = adminRow.role;
      } catch { /* non-fatal — regular user if lookup fails */ }
    }

    const discordAvatarUrl =
      user.discordId && user.discordAvatar
        ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.discordAvatar}.png?size=128`
        : null;

    // Server-stored avatar URL served from our domain (GET /avatars/<discordId>).
    // Same `avatarUrl` field used in chat messages + party members for consistency.
    const avatarUrl =
      user.discordId && user.discordAvatar ? buildAvatarUrl(user.discordId) : null;

    // Real FO76 name, or null if still a placeholder.
    const fo76Username = isPlaceholder(user.username) ? null : user.username;

    res.status(201).json({
      data: {
        userId: user.id,
        token,
        discriminator,
        displayName,
        username: fo76Username,       // FO76 in-game name, or null if still a placeholder
        discordLinked: !!user.discordId,
        discordUsername: user.discordUsername ?? null,
        discordDisplayName: user.discordDisplayName ?? null,
        discordAvatarUrl,             // Discord CDN avatar URL, or null
        avatarUrl,                    // Server-stored avatar served from our domain, or null
        role: userRole,               // 'owner'|'admin'|'moderator', or null for regular users
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/auth/session -- graceful logout, purge Redis session immediately
 */
async function deleteSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(`session:${req.sessionToken}`);
    await prisma.session.delete({ where: { token: req.sessionToken! } }).catch(() => {});
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id -- moderator+
 */
async function getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  try {
    const user = await prisma.user.findUnique({
      where: { id: paramStr(req, 'id') },
      select: {
        id: true, username: true, steamId: true,
        discordId: true, discordUsername: true, discordAvatar: true,
        isBanned: true, isMuted: true, muteExpiresAt: true, banReason: true, createdAt: true,
      },
    });

    if (!user) return next(createError(404, 'User not found'));
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/profile -- any authenticated user
 * Returns a safe subset of user fields for public profile display.
 * Joins with admin_users by discord_id to surface the role if any.
 * Excludes: steam_id, ban_reason, install_token, server_endpoint (moderator-only concerns).
 */
async function getUserProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  // The dashboard session stores the Discord snowflake as user.id; the
  // desktop client and internal admin rows use a UUID. Accept either and
  // look up by whichever format the caller sent.
  const raw = paramStr(req, 'id');
  const byUuid   = validateUuid(raw);
  const byDiscord = /^\d{15,22}$/.test(raw); // Discord snowflakes are 17-19 digits; allow a little slack
  if (!byUuid && !byDiscord) return next(createError(400, 'Invalid user ID format'));

  try {
    const where = byUuid ? { id: raw } : { discordId: raw };
    const user = await prisma.user.findFirst({
      where,
      select: {
        id: true, username: true, chatName: true, createdAt: true,
        discordId: true, discordUsername: true, discordDisplayName: true, discordAvatar: true,
        isBanned: true, isMuted: true, muteExpiresAt: true,
      },
    });
    if (!user) return next(createError(404, 'User not found'));

    let role: string = 'user';
    if (user.discordId) {
      const adminRow = await prisma.adminUser.findUnique({
        where: { discordId: user.discordId },
        select: { role: true },
      });
      if (adminRow?.role) role = adminRow.role;
    }

    res.json({ data: { ...user, role } });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/users/:id/chat-name -- self only
 *
 * This is an account identity setting, deliberately outside the supporter feature
 * flag and cosmetics table. `null` restores the normal FO76/Discord-derived name.
 */
export async function updateChatName(req: Request, res: Response, next: NextFunction): Promise<void> {
  const targetId = paramStr(req, 'id');
  if (!validateUuid(targetId)) return next(createError(400, 'Invalid user ID format'));

  const discordId = req.dashboardUser?.discordId;
  if (!discordId) return next(createError(401, 'Sign in with Discord first.'));

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(body, 'chatName')) {
    return next(createError(400, 'Body must include chatName.'));
  }
  const chatName = body.chatName;
  if (chatName !== null && typeof chatName !== 'string') {
    return next(createError(400, 'chatName must be a string or null.'));
  }

  try {
    const caller = await prisma.user.findFirst({ where: { discordId }, select: { id: true } });
    if (!caller || caller.id !== targetId) {
      return next(createError(403, 'You can only change your own chat name.'));
    }

    const result = await setChatName({ userId: targetId, chatName, source: 'website' });
    if (!result.ok) return next(createError(result.reason === 'not_found' ? 404 : 400, result.message, { code: result.reason, detail: result.code }));
    res.json({ data: { chatName: result.chatName, changed: result.changed } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/messages -- moderator+
 */
async function getUserMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
  const offset = Math.min(Math.max(parseInt(req.query.offset as string, 10) || 0, 0), 10000);

  try {
    const messages = await prisma.message.findMany({
      where: { userId: paramStr(req, 'id'), isDeleted: false },
      select: { id: true, content: true, channelId: true, source: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    res.json({ data: messages });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/users/:id/mute -- moderator+
 */
async function muteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  const { duration, reason } = req.body;
  const muteExpiresAt = new Date(Date.now() + duration * 60 * 1000);

  try {
    await prisma.user.update({
      where: { id: paramStr(req, 'id') },
      data: { isMuted: true, muteExpiresAt },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'mute',
        targetId: paramStr(req, 'id'),
        targetType: 'user',
        reason,
      },
    });
    res.json({ data: { muted: true, expiresAt: muteExpiresAt } });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/users/:id/mute -- moderator+ (unmute)
 * Reverses a mute and grants 60-minute spam immunity window.
 */
async function unmuteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  try {
    await prisma.user.update({
      where: { id: paramStr(req, 'id') },
      data: { isMuted: false, muteExpiresAt: null },
    });
    // Grant spam immunity so the user isn't immediately re-flagged
    await setSpamImmunity(paramStr(req, 'id'));
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'unmute',
        targetId: paramStr(req, 'id'),
        targetType: 'user',
        reason: 'Moderator reversed mute -- spam immunity granted',
      },
    });
    res.json({ data: { unmuted: true, immunityMinutes: 60 } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/users/:id/kick -- moderator+
 */
async function kickUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  try {
    // Invalidate all active Redis sessions for this user
    const redis = await getRedisClient();
    const sessions = await prisma.session.findMany({
      where: { userId: paramStr(req, 'id'), expiresAt: { gt: new Date() } },
      select: { token: true },
    });
    await Promise.all(sessions.map((s) => redis.del(`session:${s.token}`)));
    await prisma.session.deleteMany({ where: { userId: paramStr(req, 'id') } });
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'kick',
        targetId: paramStr(req, 'id'),
        targetType: 'user',
      },
    });
    res.json({ data: { kicked: true, sessionsInvalidated: sessions.length } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/users/:id/ban -- admin+
 */
async function banUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  const { reason } = req.body;
  try {
    await prisma.user.update({
      where: { id: paramStr(req, 'id') },
      data: { isBanned: true, banReason: reason },
    });
    // Kick active sessions
    const redis = await getRedisClient();
    const sessions = await prisma.session.findMany({
      where: { userId: paramStr(req, 'id') },
      select: { token: true },
    });
    await Promise.all(sessions.map((s) => redis.del(`session:${s.token}`)));
    await prisma.session.deleteMany({ where: { userId: paramStr(req, 'id') } });
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'ban',
        targetId: paramStr(req, 'id'),
        targetType: 'user',
        reason,
      },
    });
    res.json({ data: { banned: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/users/:id/ban -- owner+
 */
async function unbanUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  try {
    await prisma.user.update({
      where: { id: paramStr(req, 'id') },
      data: { isBanned: false, banReason: null },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'unban',
        targetId: paramStr(req, 'id'),
        targetType: 'user',
      },
    });
    res.json({ data: { unbanned: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/users/:id/wipe -- owner only (soft anonymization, FR73)
 * Clears PII in users table; message content is preserved for context.
 */
async function wipeUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  try {
    // Use raw query for gen_random_uuid() in the update
    await prisma.$executeRaw`
      UPDATE users
      SET username = 'Anonymized User', steam_id = NULL, install_token = gen_random_uuid()::text,
          is_banned = TRUE, ban_reason = 'Account wiped by admin', updated_at = NOW()
      WHERE id = ${paramStr(req, 'id')}::uuid`;

    // Purge all active Redis sessions immediately so wiped user cannot continue chatting
    const redis = await getRedisClient();
    const sessions = await prisma.session.findMany({
      where: { userId: paramStr(req, 'id') },
      select: { token: true },
    });
    await Promise.all(sessions.map((s) => redis.del(`session:${s.token}`)));
    await prisma.session.deleteMany({ where: { userId: paramStr(req, 'id') } });

    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'wipe',
        targetId: paramStr(req, 'id'),
        targetType: 'user',
        reason: 'Data erasure request',
      },
    });
    res.json({ data: { wiped: true } });
  } catch (err) {
    next(err);
  }
}

async function deleteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = paramsOf(req);
    if (!validateUuid(id)) { next(createError(400, 'Invalid user ID')); return; }

    // Delete all related data first (messages, reports, sessions)
    await prisma.message.deleteMany({ where: { userId: id } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterUserId: id }, { targetUserId: id }] } });
    await prisma.session.deleteMany({ where: { userId: id } });

    // Purge Redis sessions
    const redis = await getRedisClient();
    const keys = await redis.keys('session:*');
    for (const key of keys) {
      const val = await redis.get(key);
      if (val === id) await redis.del(key);
    }

    const deleted = await prisma.user.delete({ where: { id } }).catch(() => null);
    if (!deleted) { next(createError(404, 'User not found')); return; }

    // Audit log
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || 'api-key',
        action: 'user_deleted',
        targetId: id,
        targetType: 'user',
        metadata: { username: deleted.username },
      },
    }).catch(() => {});

    logger.info({ userId: id, username: deleted.username, actor: req.adminUser?.username }, 'User deleted');
    res.json({ data: { deleted: true, id, username: deleted.username } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/aliases — moderator+
 * Returns the alias history (previous FO76 names) for a user, newest-first.
 */
async function getUserAliases(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validateUuid(paramStr(req, 'id'))) return next(createError(400, 'Invalid user ID format'));
  try {
    const rows = await (prisma as any).$queryRaw`
      SELECT alias, created_at AS "createdAt"
      FROM user_aliases
      WHERE user_id = ${paramStr(req, 'id')}::uuid
      ORDER BY created_at DESC
    ` as Array<{ alias: string; createdAt: Date }>;
    res.json({ data: { aliases: rows.map((a: { alias: string; createdAt: Date }) => ({ alias: a.alias, createdAt: a.createdAt.toISOString() })) } });
  } catch (err) {
    next(err);
  }
}

export {
  listUsers,
  register,
  deleteSession,
  getUser,
  getUserProfile,
  getUserMessages,
  muteUser,
  unmuteUser,
  kickUser,
  banUser,
  unbanUser,
  wipeUser,
  deleteUser,
  getUserAliases,
};
module.exports = {
  listUsers,
  mentionSearch,
  register,
  deleteSession,
  getUser,
  getUserProfile,
  updateChatName,
  getUserMessages,
  muteUser,
  unmuteUser,
  kickUser,
  banUser,
  unbanUser,
  wipeUser,
  deleteUser,
  getUserAliases,
};
