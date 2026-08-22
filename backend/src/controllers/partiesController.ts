import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import { paramStr, paramsOf } from '../utils/reqParams';
import logger from '../config/logger';
import { PARTIES_ENABLED } from '../config/features';
import { findProhibitedPhrase } from '../services/autoModService';
import { buildAvatarUrl } from '../services/avatarService';
import { persistMessage } from '../services/messageService';
import { getBlockedIds } from '../services/blockService';
import { getEffectiveRole, isPrivilegedRole } from '../services/userRoleService';

// A user may belong to at most this many (non-deleted) parties at once; they
// must leave one before joining or creating another.
const MAX_PARTIES_PER_USER = 8;
const PARTY_CAP_MESSAGE = `You can be in at most ${MAX_PARTIES_PER_USER} parties at once — leave one to join another.`;
async function atPartyCap(userId: string): Promise<boolean> {
  const count = await prisma.partyMember.count({ where: { userId, party: { isDeleted: false } } });
  return count >= MAX_PARTIES_PER_USER;
}

// A user may own at most this many (non-deleted) parties at once; they must
// delete or transfer ownership of one before creating another.
const MAX_OWNED_PARTIES_PER_USER = 3;
const OWNED_PARTY_CAP_MESSAGE = `You can own at most ${MAX_OWNED_PARTIES_PER_USER} parties at once — delete or transfer ownership of one before creating another.`;
async function atOwnedPartyCap(userId: string): Promise<boolean> {
  const count = await prisma.party.count({ where: { ownerId: userId, isDeleted: false } });
  return count >= MAX_OWNED_PARTIES_PER_USER;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Party category allow-list
const PARTY_CATEGORIES = ['General', 'Trading', 'Raids', 'Events', 'PvP', 'Casual', 'Help', 'Social'] as const;
type PartyCategory = typeof PARTY_CATEGORIES[number];

function parseCategory(raw: unknown, defaultValue: PartyCategory = 'General'): { ok: true; value: PartyCategory } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: defaultValue };
  if (typeof raw !== 'string') return { ok: false };
  const found = PARTY_CATEGORIES.find(c => c === raw);
  if (!found) return { ok: false };
  return { ok: true, value: found };
}

// Per-party member-limit bounds. null/undefined = unlimited.
const MAX_MEMBERS_MIN = 2;
const MAX_MEMBERS_MAX = 50;
const MAX_MEMBERS_MESSAGE = 'maxMembers must be 2–50';
const PARTY_FULL_MESSAGE = 'Party is full';

/**
 * Atomically add `userId` to `partyId`, enforcing the per-party capacity limit
 * against concurrent joins.
 *
 * The naive "count then insert" pattern has a TOCTOU race: under READ COMMITTED
 * (Postgres default) `count()` takes no lock and cannot see another in-flight
 * transaction's uncommitted insert, so two concurrent joins can both observe a
 * count below the cap and both insert — leaving the party over `maxMembers`.
 * Simply wrapping count+insert in a transaction does NOT fix this (READ
 * COMMITTED still gives each tx its own snapshot for the count).
 *
 * The fix: serialize concurrent joins for the SAME party on the party row.
 * Inside the transaction we first take `SELECT id FROM parties WHERE id = ?
 * FOR UPDATE`, which blocks any other transaction that has locked (or tries to
 * lock) the same party row. Only after acquiring the lock do we count and
 * insert — so the second caller waits for the first to commit, then re-counts
 * and sees the now-full party and is rejected with 409 PARTY_FULL.
 *
 * Both joinParty and acceptInvite route through this helper so they share the
 * guarded pattern. Throws a 409 createError when the party is full.
 */
async function joinPartyWithCapacityGuard(
  partyId: string,
  userId: string,
  maxMembers: number | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Row-lock the party so concurrent joins for this party serialize. The
    // tagged-template form parameterizes partyId (no SQL injection). The lock
    // is held until the surrounding transaction commits/rolls back.
    await tx.$queryRaw`SELECT id FROM parties WHERE id = ${partyId}::uuid FOR UPDATE`;

    if (maxMembers != null) {
      const currentCount = await tx.partyMember.count({ where: { partyId } });
      if (currentCount >= maxMembers) {
        throw createError(409, PARTY_FULL_MESSAGE);
      }
    }
    await tx.partyMember.create({
      data: { id: uuidv4(), partyId, userId, role: 'member' },
    });
  });
}

/**
 * Validate an optional maxMembers value from a request body.
 * Returns { ok:true, value } where value is the normalized number|null,
 * or { ok:false } when the value is present but invalid (caller rejects 400).
 * null/undefined/absent → unlimited (value === null).
 */
function parseMaxMembers(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false };
  if (raw < MAX_MEMBERS_MIN || raw > MAX_MEMBERS_MAX) return { ok: false };
  return { ok: true, value: raw };
}

/**
 * Import handlers module via require() for reliable CJS interop in both tsx (dev)
 * and compiled (prod) contexts. Dynamic import() wraps module.exports in {default:…}
 * under tsx, making named exports unreachable; require() returns the raw object directly.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
function importHandlers(): typeof import('../websocket/handlers') {
  return require('../websocket/handlers') as typeof import('../websocket/handlers');
}

// Defensively resolve the per-user online checker from the WS handlers module.
// Prefers isUserConnected, falls back to isUserInGame, then constant-false so the
// member list always renders even if the handlers module is not yet fully loaded.
function resolveOnlineCheck(): (userId: string) => boolean {
  const h = importHandlers() as Partial<typeof import('../websocket/handlers')>;
  if (typeof h.isUserConnected === 'function') return h.isUserConnected;
  if (typeof h.isUserInGame === 'function') return h.isUserInGame;
  logger.warn('[parties] online-check unavailable from handlers — members shown as offline');
  return () => false;
}

function featureGate(_req: Request, res: Response, next: NextFunction): void {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  next();
}

/**
 * Get online counts for a set of parties. Reads the global `clients` map
 * via the exported helper from handlers.ts.
 */
async function getOnlineCountsForParties(partyIds: string[], membershipsByParty: Map<string, string[]>): Promise<Map<string, number>> {
  try {
    const { getOnlinePartyCounts } = importHandlers();
    return getOnlinePartyCounts(membershipsByParty);
  } catch {
    return new Map();
  }
}

/** Helper: resolve the caller's userId from req.user (set by requireClientAuth). */
function resolveCallerId(req: Request): string {
  return (req.user as any)?.id;
}

/**
 * GET /api/parties?search=&sort=online|active
 */
export async function listParties(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    featureGate(req, res, () => {});
    if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
    const callerId = resolveCallerId(req);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

    // Get caller's memberships for visibility filter
    const callerMemberships = await prisma.partyMember.findMany({
      where: { userId: callerId },
      select: { partyId: true, role: true },
    });
    const callerPartyIds = new Set(callerMemberships.map(m => m.partyId));

    // Privileged users (owner/admin/moderator) see ALL parties including private
    // ones they are not members of, so they can resolve party names for moderation.
    // Regular users only see public parties, parties they're in, or parties they're invited to.
    const callerRole = await getEffectiveRole(callerId);
    const callerIsPrivileged = isPrivilegedRole(callerRole);

    const parties = await prisma.party.findMany({
      where: {
        isDeleted: false,
        ...(callerIsPrivileged ? {} : {
          OR: [
            { isPrivate: false },                                                // public → everyone
            { id: { in: Array.from(callerPartyIds) } },                          // member
            { invites: { some: { inviteeId: callerId, status: 'pending' } } },   // pending-invitee
          ],
        }),
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      include: {
        members: { select: { userId: true, role: true } },
        invites: {
          where: { inviteeId: callerId, status: 'pending' },
          select: { id: true },
        },
      },
      orderBy: [{ lastMessageAt: 'desc' }],
    });

    // Build member-by-party map for online count lookup
    const membershipsByParty = new Map<string, string[]>();
    for (const p of parties) {
      membershipsByParty.set(p.id, p.members.map((m: any) => m.userId));
    }

    const onlineCounts = await getOnlineCountsForParties(parties.map(p => p.id), membershipsByParty);

    const result = parties.map(p => {
      const callerMember = callerMemberships.find(m => m.partyId === p.id);
      const onlineCount = onlineCounts.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        description: (p as any).description ?? null,
        color: p.color,
        category: p.category,
        isPrivate: p.isPrivate,
        reapPolicy: p.reapPolicy,
        ownerId: p.ownerId,
        maxMembers: p.maxMembers,
        memberCount: p.members.length,
        onlineCount,
        recentMsgCount: p.recentMsgCount,
        lastMessageAt: p.lastMessageAt?.toISOString() ?? null,
        isMember: callerPartyIds.has(p.id),
        role: callerMember?.role ?? null,
        pendingInvite: p.invites.length > 0,
      };
    });

    // Sort: onlineCount desc, recentMsgCount desc, lastMessageAt desc
    result.sort((a, b) => {
      if (b.onlineCount !== a.onlineCount) return b.onlineCount - a.onlineCount;
      if (b.recentMsgCount !== a.recentMsgCount) return b.recentMsgCount - a.recentMsgCount;
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });

    res.json({ data: { parties: result } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties { name, color?, isPrivate, reapPolicy }
 */
export async function createParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const { name, color, isPrivate, reapPolicy, maxMembers, category, description } = req.body ?? {};

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 24) {
    return next(createError(400, 'name is required (1–24 chars)'));
  }
  if (!['persistent', 'ephemeral'].includes(reapPolicy)) {
    return next(createError(400, 'reapPolicy must be persistent or ephemeral'));
  }
  const maxMembersParsed = parseMaxMembers(maxMembers);
  if (!maxMembersParsed.ok) {
    return next(createError(400, MAX_MEMBERS_MESSAGE));
  }
  const categoryParsed = parseCategory(category);
  if (!categoryParsed.ok) {
    return next(createError(400, `Invalid category. Must be one of: ${PARTY_CATEGORIES.join(', ')}`));
  }

  // description: optional, max 300 chars
  let cleanDescription: string | null = null;
  if (description !== undefined && description !== null && description !== '') {
    if (typeof description !== 'string' || description.trim().length > 300) {
      return next(createError(400, 'description must be a string of at most 300 characters'));
    }
    cleanDescription = description.trim();
  }

  const cleanName = name.trim();

  // Profanity: party names get ZERO tolerance — block on ANY word-filter match,
  // including phrases that are only test-mode (allowed) in chat.
  const badPhrase = await findProhibitedPhrase(cleanName);
  if (badPhrase) {
    return next(createError(400, 'Party name contains prohibited language'));
  }

  // Profanity check on description too.
  if (cleanDescription) {
    const badDescPhrase = await findProhibitedPhrase(cleanDescription);
    if (badDescPhrase) {
      return next(createError(400, 'Party description contains prohibited language'));
    }
  }

  // Uniqueness: no two live parties may share a name (case-insensitive).
  const duplicate = await prisma.party.findFirst({
    where: { name: { equals: cleanName, mode: 'insensitive' }, isDeleted: false },
    select: { id: true },
  });
  if (duplicate) {
    return next(createError(409, 'A party with that name already exists'));
  }

  // Creating a party makes you a member, so it counts toward the per-user cap.
  if (await atPartyCap(callerId)) {
    return next(createError(409, PARTY_CAP_MESSAGE));
  }

  // Separate cap on owned parties to prevent spam/clutter from solo-owned abandoned parties.
  if (await atOwnedPartyCap(callerId)) {
    return next(createError(409, OWNED_PARTY_CAP_MESSAGE));
  }

  try {
    const partyId = uuidv4();
    const memberId = uuidv4();

    const party = await prisma.$transaction(async (tx) => {
      // Serialize concurrent creates by this owner so the owned-party cap holds
      // atomically: lock the owner's user row (same FOR UPDATE idiom as the join/
      // accept capacity guards) and re-count owned parties inside the lock before
      // inserting. The pre-transaction atOwnedPartyCap() check above is a fast path;
      // this is the authoritative guard that closes the count-then-create race.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${callerId}::uuid FOR UPDATE`;
      const ownedCount = await tx.party.count({ where: { ownerId: callerId, isDeleted: false } });
      if (ownedCount >= MAX_OWNED_PARTIES_PER_USER) {
        const err: any = new Error(OWNED_PARTY_CAP_MESSAGE);
        err.status = 409;
        throw err;
      }
      const p = await tx.party.create({
        data: {
          id: partyId,
          name: name.trim(),
          color: typeof color === 'string' && color.trim() ? color.trim() : '#18FF62',
          isPrivate: isPrivate === true,
          reapPolicy: reapPolicy as 'persistent' | 'ephemeral',
          maxMembers: maxMembersParsed.value,
          category: categoryParsed.value,
          description: cleanDescription,
          ownerId: callerId,
        },
      });
      await tx.partyMember.create({
        data: { id: memberId, partyId, userId: callerId, role: 'owner' },
      });
      return p;
    });

    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_create',
        targetId: partyId,
        targetType: 'party',
        metadata: { name: party.name, isPrivate: party.isPrivate, reapPolicy: party.reapPolicy, maxMembers: party.maxMembers },
      },
    });

    res.status(201).json({ data: { party } });
  } catch (err: any) {
    // The in-transaction owned-cap guard throws a 409 to roll back the insert.
    if (err?.status === 409) return next(createError(409, err.message));
    next(err);
  }
}

/**
 * PATCH /api/parties/:id { maxMembers }
 *
 * Edit a party's member limit. Owner OR co-mod only. maxMembers is null
 * (unlimited) or an integer 2–50. Lowering the limit below the current member
 * count is allowed — it only blocks future joins, nobody is kicked.
 */
export async function updateParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));

  // At least one editable field must be present.
  if (!req.body || (!('maxMembers' in req.body) && !('category' in req.body) && !('name' in req.body) && !('description' in req.body))) {
    return next(createError(400, 'Provide at least one field to update: maxMembers, category, name, or description'));
  }

  // Party rename: validate + profanity-check the new name if provided.
  let cleanRename: string | undefined;
  if ('name' in req.body) {
    const rawName = req.body.name;
    if (!rawName || typeof rawName !== 'string' || rawName.trim().length === 0 || rawName.trim().length > 24) {
      return next(createError(400, 'name is required (1–24 chars)'));
    }
    cleanRename = rawName.trim();
    const badPhrase = await findProhibitedPhrase(cleanRename);
    if (badPhrase) {
      return next(createError(400, 'Party name contains prohibited language'));
    }
  }
  const maxMembersParsed = parseMaxMembers(req.body.maxMembers);
  if (!maxMembersParsed.ok) {
    return next(createError(400, MAX_MEMBERS_MESSAGE));
  }
  const categoryParsed = 'category' in req.body
    ? parseCategory(req.body.category)
    : { ok: true as const, value: undefined };
  if (!categoryParsed.ok) {
    return next(createError(400, `Invalid category. Must be one of: ${PARTY_CATEGORIES.join(', ')}`));
  }

  // description update: null clears it; string sets it (max 300 chars, prohibited-content check)
  let cleanDescriptionUpdate: string | null | undefined;
  if ('description' in req.body) {
    const rawDesc = req.body.description;
    if (rawDesc === null || rawDesc === '') {
      cleanDescriptionUpdate = null; // explicit clear
    } else if (typeof rawDesc !== 'string' || rawDesc.trim().length > 300) {
      return next(createError(400, 'description must be a string of at most 300 characters'));
    } else {
      cleanDescriptionUpdate = rawDesc.trim();
      const badDescPhrase = await findProhibitedPhrase(cleanDescriptionUpdate);
      if (badDescPhrase) {
        return next(createError(400, 'Party description contains prohibited language'));
      }
    }
  }

  try {
    const [party, callerMembership] = await Promise.all([
      prisma.party.findUnique({ where: { id: partyId, isDeleted: false } }),
      prisma.partyMember.findFirst({ where: { partyId, userId: callerId } }),
    ]);
    if (!party) return next(createError(404, 'Party not found'));
    if (!callerMembership || !['owner', 'comod'].includes(callerMembership.role)) {
      return next(createError(403, 'Owner or co-mod only'));
    }

    const updateData: Record<string, unknown> = {};
    if ('maxMembers' in req.body) updateData.maxMembers = maxMembersParsed.value;
    if ('category' in req.body && categoryParsed.value !== undefined) updateData.category = categoryParsed.value;
    if (cleanDescriptionUpdate !== undefined) updateData.description = cleanDescriptionUpdate;
    if (cleanRename !== undefined) {
      // Uniqueness: no two live parties may share a name (case-insensitive).
      const duplicate = await prisma.party.findFirst({
        where: { name: { equals: cleanRename, mode: 'insensitive' }, isDeleted: false, NOT: { id: partyId } },
        select: { id: true },
      });
      if (duplicate) {
        return next(createError(409, 'A party with that name already exists'));
      }
      updateData.name = cleanRename;
    }

    const updated = await prisma.party.update({
      where: { id: partyId },
      data: updateData,
    });

    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_update',
        targetId: partyId,
        targetType: 'party',
        metadata: updateData as Record<string, string | number | boolean | null>,
      },
    });

    res.json({ data: { party: updated } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parties/invites — caller's pending invites
 */
export async function listInvites(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  try {
    const invites = await prisma.partyInvite.findMany({
      where: { inviteeId: callerId, status: 'pending' },
      include: {
        party: { select: { name: true } },
        inviter: { select: { username: true, discordUsername: true, discordDisplayName: true, installToken: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const { resolveDisplayName } = importHandlers();
    const result = invites.map(inv => ({
      id: inv.id,
      partyId: inv.partyId,
      partyName: inv.party.name,
      inviterName: resolveDisplayName(inv.inviter),
      createdAt: inv.createdAt.toISOString(),
    }));
    res.json({ data: { invites: result } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/invites/:id/accept
 */
export async function acceptInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const inviteId = paramStr(req, 'id');
  if (!UUID_RE.test(inviteId)) return next(createError(400, 'Invalid invite ID'));

  try {
    const invite = await prisma.partyInvite.findUnique({
      where: { id: inviteId },
      include: { party: true },
    });
    if (!invite || invite.inviteeId !== callerId || invite.status !== 'pending') {
      return next(createError(404, 'Invite not found or already responded'));
    }

    // Check user not banned/muted
    const callerUser = await prisma.user.findUnique({
      where: { id: callerId },
      select: { isBanned: true, isMuted: true },
    });
    if (callerUser?.isBanned) return next(createError(403, 'You are banned'));

    // Accepting adds a membership — enforce the per-user cap unless they're
    // already in this party (idempotent re-accept).
    const alreadyIn = await prisma.partyMember.findFirst({
      where: { partyId: invite.partyId, userId: callerId }, select: { id: true },
    });
    if (!alreadyIn && await atPartyCap(callerId)) {
      return next(createError(409, PARTY_CAP_MESSAGE));
    }

    // Per-party capacity is enforced INSIDE the transaction, guarded by a row
    // lock on the party (FOR UPDATE), so concurrent accepts cannot both pass a
    // stale count and overfill the party — the same TOCTOU fix used by
    // joinParty (see joinPartyWithCapacityGuard). A pre-transaction count would
    // race exactly like the old joinParty did. The idempotent re-accept of an
    // existing membership is exempt from the cap (it doesn't grow the party).
    const party = await prisma.$transaction(async (tx) => {
      // Row-lock the party so concurrent accepts for this party serialize.
      await tx.$queryRaw`SELECT id FROM parties WHERE id = ${invite.partyId}::uuid FOR UPDATE`;

      await tx.partyInvite.update({
        where: { id: inviteId },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      // Upsert membership (idempotent). Re-check membership inside the tx — the
      // earlier pre-tx `alreadyIn` read is only a fast path; the authoritative
      // check happens here under the row lock.
      const existing = await tx.partyMember.findFirst({
        where: { partyId: invite.partyId, userId: callerId },
      });
      if (!existing) {
        // Genuinely new join: enforce the per-party capacity now that we hold
        // the row lock and a snapshot that reflects committed members.
        if (invite.party.maxMembers != null) {
          const currentCount = await tx.partyMember.count({ where: { partyId: invite.partyId } });
          if (currentCount >= invite.party.maxMembers) {
            throw createError(409, PARTY_FULL_MESSAGE);
          }
        }
        await tx.partyMember.create({
          data: { id: uuidv4(), partyId: invite.partyId, userId: callerId, role: 'member' },
        });
      }
      return tx.party.findUnique({ where: { id: invite.partyId } });
    });

    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_join',
        targetId: invite.partyId,
        targetType: 'party',
        metadata: { via: 'invite', inviteId },
      },
    });

    // Broadcast member-update to party
    await emitMemberUpdate(invite.partyId);

    res.json({ data: { party } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/invites/:id/decline
 */
export async function declineInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const inviteId = paramStr(req, 'id');
  if (!UUID_RE.test(inviteId)) return next(createError(400, 'Invalid invite ID'));

  try {
    const invite = await prisma.partyInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.inviteeId !== callerId || invite.status !== 'pending') {
      return next(createError(404, 'Invite not found or already responded'));
    }
    await prisma.partyInvite.update({
      where: { id: inviteId },
      data: { status: 'declined', respondedAt: new Date() },
    });
    res.json({ data: { declined: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parties/:id
 */
export async function getParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));

  try {
    const party = await prisma.party.findUnique({
      where: { id: partyId, isDeleted: false },
      include: { members: { select: { userId: true, role: true } } },
    });
    if (!party) return next(createError(404, 'Party not found'));

    const isMember = party.members.some((m: any) => m.userId === callerId);
    if (party.isPrivate && !isMember) {
      // Check staff
      const isStaff = await checkIsStaff(callerId);
      if (!isStaff) return next(createError(404, 'Party not found'));
    }

    res.json({ data: { party } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parties/:id/members
 */
export async function getPartyMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));

  try {
    const party = await prisma.party.findUnique({
      where: { id: partyId, isDeleted: false },
      select: { isPrivate: true, maxMembers: true },
    });
    if (!party) return next(createError(404, 'Party not found'));

    const isMember = !!(await prisma.partyMember.findFirst({ where: { partyId, userId: callerId } }));
    if (party.isPrivate && !isMember) {
      const isStaff = await checkIsStaff(callerId);
      if (!isStaff) return next(createError(404, 'Party not found'));
    }

    const members = await prisma.partyMember.findMany({
      where: { partyId },
      include: {
        user: { select: { id: true, username: true, discordId: true, discordUsername: true, discordDisplayName: true, installToken: true } },
      },
    });

    const { resolveDisplayName } = importHandlers();
    const isOnline = resolveOnlineCheck();

    // Block enforcement: blocked users are invisible to the requester — exclude
    // them from the member panel. The requester themself is never filtered.
    let blockedIds = new Set<string>();
    try {
      blockedIds = await getBlockedIds(callerId);
    } catch (err) {
      logger.warn({ err, callerId }, '[getPartyMembers] getBlockedIds failed (non-fatal) — no member filtering');
    }

    const result = members
      .filter(m => !blockedIds.has(m.userId))
      .map(m => ({
        userId: m.userId,
        username: resolveDisplayName(m.user),
        role: m.role,
        online: isOnline(m.userId),
        avatarUrl: buildAvatarUrl(m.user.discordId),
      }));

    res.json({ data: { members: result, maxMembers: party.maxMembers } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/:id/join — public party only
 */
export async function joinParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));

  try {
    const [party, callerUser] = await Promise.all([
      prisma.party.findUnique({ where: { id: partyId, isDeleted: false } }),
      prisma.user.findUnique({ where: { id: callerId }, select: { isBanned: true, isMuted: true } }),
    ]);
    if (!party) return next(createError(404, 'Party not found'));
    if (party.isPrivate) return next(createError(403, 'Party is private — use an invite'));
    if (callerUser?.isBanned) return next(createError(403, 'You are banned'));

    // Idempotent
    const existing = await prisma.partyMember.findFirst({ where: { partyId, userId: callerId } });
    if (existing) {
      res.json({ data: { party } });
      return;
    }

    if (await atPartyCap(callerId)) {
      return next(createError(409, PARTY_CAP_MESSAGE));
    }

    // Per-party capacity and member insert are wrapped in a transaction AND
    // serialized on the party row. Under READ COMMITTED (Postgres default),
    // partyMember.count() takes no lock and cannot see another transaction's
    // uncommitted insert, so two concurrent joins could both read a count below
    // the cap and both insert — overfilling the party. We first take a row lock
    // on the party (SELECT ... FOR UPDATE) so concurrent joins for the SAME
    // party serialize: the second waits until the first commits, then re-counts
    // and sees the new member. The count + create then run inside the same tx.
    await joinPartyWithCapacityGuard(partyId, callerId, party.maxMembers);
    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_join',
        targetId: partyId,
        targetType: 'party',
        metadata: { via: 'join' },
      },
    });
    await emitMemberUpdate(partyId);
    res.json({ data: { party } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/:id/leave
 */
export async function leaveParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));

  try {
    const membership = await prisma.partyMember.findFirst({ where: { partyId, userId: callerId } });
    if (!membership) return next(createError(404, 'Not a member'));

    await prisma.partyMember.delete({ where: { id: membership.id } });
    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_leave',
        targetId: partyId,
        targetType: 'party',
        metadata: {},
      },
    });

    const remaining = await prisma.partyMember.count({ where: { partyId } });
    let deleted = false;

    if (remaining === 0) {
      // Last member left — soft-delete regardless of reapPolicy
      await prisma.party.update({ where: { id: partyId }, data: { isDeleted: true } });
      deleted = true;
      await emitPartyDeleted(partyId);
      await prisma.auditLog.create({
        data: {
          actorId: callerId,
          action: 'party_delete',
          targetId: partyId,
          targetType: 'party',
          metadata: { reason: 'last-member-left' },
        },
      });
    } else {
      // If the leaver was the owner, transfer ownership to a comod or random member
      if (membership.role === 'owner') {
        const newOwner = await prisma.partyMember.findFirst({
          where: { partyId, role: 'comod' },
        }) ?? await prisma.partyMember.findFirst({ where: { partyId } });
        if (newOwner) {
          await prisma.partyMember.update({ where: { id: newOwner.id }, data: { role: 'owner' } });
          await prisma.party.update({ where: { id: partyId }, data: { ownerId: newOwner.userId } });
        }
      }
      await emitMemberUpdate(partyId);
    }

    res.json({ data: { left: true, ...(deleted ? { deleted: true } : {}) } });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/parties/:id — owner only
 */
export async function deleteParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));

  try {
    const party = await prisma.party.findUnique({ where: { id: partyId, isDeleted: false } });
    if (!party) return next(createError(404, 'Party not found'));
    if (party.ownerId !== callerId) return next(createError(403, 'Owner only'));

    await prisma.party.update({ where: { id: partyId }, data: { isDeleted: true } });
    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_delete',
        targetId: partyId,
        targetType: 'party',
        metadata: { reason: 'owner-deleted' },
      },
    });
    await emitPartyDeleted(partyId);

    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/:id/invite { userId }
 */
export async function inviteToParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  const { userId: inviteeId } = req.body ?? {};

  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));
  if (!inviteeId || !UUID_RE.test(inviteeId)) return next(createError(400, 'userId must be a UUID'));

  try {
    const [party, callerMembership] = await Promise.all([
      prisma.party.findUnique({ where: { id: partyId, isDeleted: false } }),
      prisma.partyMember.findFirst({ where: { partyId, userId: callerId } }),
    ]);
    if (!party) return next(createError(404, 'Party not found'));
    if (!callerMembership || !['owner', 'comod'].includes(callerMembership.role)) {
      return next(createError(403, 'Owner or co-mod only'));
    }

    // Check invitee exists
    const invitee = await prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true } });
    if (!invitee) return next(createError(404, 'Target user not found'));

    // Already a member?
    const alreadyMember = await prisma.partyMember.findFirst({ where: { partyId, userId: inviteeId } });
    if (alreadyMember) return next(createError(409, 'User is already a member'));

    // Upsert pending invite
    const invite = await prisma.partyInvite.upsert({
      where: { partyId_inviteeId: { partyId, inviteeId } },
      update: { status: 'pending', inviterId: callerId, respondedAt: null },
      create: {
        id: uuidv4(),
        partyId,
        inviteeId,
        inviterId: callerId,
        status: 'pending',
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_invite',
        targetId: partyId,
        targetType: 'party',
        metadata: { inviteeId },
      },
    });

    // Push party:invite WS notification to invitee
    const { resolveDisplayName } = importHandlers();
    const inviterUser = await prisma.user.findUnique({
      where: { id: callerId },
      select: { username: true, discordUsername: true, discordDisplayName: true, installToken: true },
    });
    const inviterName = inviterUser ? resolveDisplayName(inviterUser) : 'Someone';

    try {
      const pushFn = (global as any).pushToUser as ((userId: string, payload: any) => number) | undefined;
      if (pushFn) {
        pushFn(inviteeId, {
          type: 'party:invite',
          payload: {
            inviteId: invite.id,
            partyId,
            partyName: party.name,
            inviterName,
          },
        });
      }
    } catch (err) {
      logger.warn({ err, inviteeId }, 'party invite WS push failed (non-fatal)');
    }

    res.status(201).json({ data: { invite } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parties/:id/invite-search?q=<query>
 *
 * Autocomplete for the direct-invite flow. Owner/co-mod only. Returns up to ~8
 * users (userId + displayName + avatarUrl) whose username / discord username /
 * discord display name contains `q` (case-insensitive), EXCLUDING existing party
 * members, the caller, and banned users.
 *
 * Distinct from mention-search (which omits userId): the invite flow needs the
 * userId to POST /invite.
 */
export async function inviteSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));

  try {
    const [party, callerMembership] = await Promise.all([
      prisma.party.findUnique({ where: { id: partyId, isDeleted: false }, select: { id: true } }),
      prisma.partyMember.findFirst({ where: { partyId, userId: callerId } }),
    ]);
    if (!party) return next(createError(404, 'Party not found'));
    if (!callerMembership || !['owner', 'comod'].includes(callerMembership.role)) {
      return next(createError(403, 'Owner or co-mod only'));
    }

    // Sanitize query (same hygiene as mention-search).
    const raw = (req.query.q as string) ?? '';
    const q = raw.replace(/[<>"'&;\\]/g, '').trim().slice(0, 32);

    // Current members to exclude.
    const members = await prisma.partyMember.findMany({ where: { partyId }, select: { userId: true } });
    const excludeIds = new Set<string>(members.map(m => m.userId));
    excludeIds.add(callerId);

    const users = await prisma.user.findMany({
      where: {
        isBanned: false,
        id: { notIn: Array.from(excludeIds) },
        ...(q.length > 0 && {
          OR: [
            { username: { contains: q, mode: 'insensitive' as const } },
            { discordUsername: { contains: q, mode: 'insensitive' as const } },
            { discordDisplayName: { contains: q, mode: 'insensitive' as const } },
          ],
        }),
      },
      select: { id: true, username: true, discordId: true, discordUsername: true, discordDisplayName: true, installToken: true },
      take: 8,
    });

    const { resolveDisplayName } = importHandlers();
    const results = users.map(u => ({
      userId: u.id,
      displayName: resolveDisplayName(u),
      avatarUrl: buildAvatarUrl(u.discordId),
    }));

    res.json({ data: { results } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/:id/invite-public { channelId }
 *
 * Owner/co-mod posts a "join my party" embed into a real public channel. The
 * party must be PUBLIC. The embed is carried in messages.metadata so the overlay
 * renders it with a Join button; the join itself reuses POST /parties/:id/join.
 */
export async function invitePublic(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  const body = req.body ?? {};

  // Accept the new multi-channel shape `{ channelIds: string[] }` while still
  // accepting the legacy single `{ channelId }` for backward compat.
  const rawIds: unknown[] = Array.isArray(body.channelIds)
    ? body.channelIds
    : (body.channelId != null ? [body.channelId] : []);
  // De-dupe while preserving order.
  const channelIds = [...new Set(rawIds.map((v) => String(v)))];

  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));
  if (channelIds.length === 0) return next(createError(400, 'At least one channelId is required'));
  if (channelIds.some((id) => !UUID_RE.test(id))) {
    return next(createError(400, 'Each channelId must be a UUID'));
  }

  // Per-user public-invite cooldown (5 minutes). Computed from the most recent
  // `party_invite_public` audit_logs row for this actor — no schema change, and
  // it survives restarts because audit_logs is durable. ONE cooldown consumption
  // covers the whole multi-channel post.
  const PUBLIC_INVITE_COOLDOWN_MS = 5 * 60 * 1000;

  try {
    const [party, callerMembership] = await Promise.all([
      prisma.party.findUnique({ where: { id: partyId, isDeleted: false } }),
      prisma.partyMember.findFirst({ where: { partyId, userId: callerId } }),
    ]);
    if (!party) return next(createError(404, 'Party not found'));
    if (!callerMembership || !['owner', 'comod'].includes(callerMembership.role)) {
      return next(createError(403, 'Owner or co-mod only'));
    }
    if (party.isPrivate) {
      return next(createError(400, 'Only public parties can be posted publicly'));
    }

    // Cooldown gate — reject early (before any posting) if the actor posted a
    // public invitation within the last 5 minutes.
    const lastPost = await prisma.auditLog.findFirst({
      where: { actorId: callerId, action: 'party_invite_public' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (lastPost) {
      const elapsed = Date.now() - new Date(lastPost.createdAt).getTime();
      const remaining = PUBLIC_INVITE_COOLDOWN_MS - elapsed;
      if (remaining > 0) {
        const totalSec = Math.ceil(remaining / 1000);
        const mm = Math.floor(totalSec / 60);
        const ss = totalSec % 60;
        const human = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
        res.status(429).json({
          type: 'about:blank',
          title: 'Too Many Requests',
          status: 429,
          detail: `You can post another public invitation in ${human}.`,
          retryAfterMs: remaining,
        });
        return;
      }
    }

    // Each channelId must be a real, non-archived channel (General/Trading/Events/Raids
    // set) — never a party id or unknown id.
    const channels = await prisma.channel.findMany({
      where: { id: { in: channelIds }, isArchived: false },
      select: { id: true, parentId: true },
    });
    const channelById = new Map(channels.map((c) => [c.id, c]));
    const missing = channelIds.filter((id) => !channelById.has(id));
    if (missing.length > 0) {
      return next(createError(400, 'Each channelId must be an existing public channel'));
    }

    // Resolve the inviter's display name for the friendly content.
    const { resolveDisplayName, broadcast } = importHandlers();
    const inviterUser = await prisma.user.findUnique({
      where: { id: callerId },
      select: { username: true, discordId: true, discordUsername: true, discordDisplayName: true, installToken: true },
    });
    const inviterName = inviterUser ? resolveDisplayName(inviterUser) : 'Someone';
    const inviterAvatarUrl = buildAvatarUrl(inviterUser?.discordId ?? null);

    const createdAt = new Date().toISOString();
    const content = `📣 ${inviterName} invited everyone to join the party "${party.name}"`;
    const metadata = {
      type: 'party_invite' as const,
      partyId: party.id,
      partyName: party.name,
      color: party.color,
      isPrivate: false as const,
    };

    // Post the embed into every selected channel.
    const postedMessages: Array<{ id: string; channelId: string }> = [];
    for (const id of channelIds) {
      const channel = channelById.get(id)!;
      const messageId = uuidv4();

      // Persist (with metadata) — direct persist so we can include the embed.
      await persistMessage({
        id: messageId,
        content,
        userId: callerId,
        channelId: id,
        parentChannelId: channel.parentId ?? null,
        source: 'game',
        metadata,
        createdAt,
      });

      // Broadcast as a normal chat:message WITH metadata so the overlay renders the embed.
      broadcast({
        type: 'chat:message',
        payload: {
          id: messageId,
          content,
          username: inviterName,
          userId: callerId,
          channelId: id,
          source: 'game',
          timestamp: createdAt,
          avatarUrl: inviterAvatarUrl,
          metadata,
        },
      });

      postedMessages.push({ id: messageId, channelId: id });
    }

    // ONE audit row covers the whole multi-channel post (one cooldown consumption).
    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_invite_public',
        targetId: partyId,
        targetType: 'party',
        metadata: { channelIds, messageIds: postedMessages.map((m) => m.id) },
      },
    });

    const first = postedMessages[0];
    res.status(201).json({
      data: {
        messages: postedMessages.map((m) => ({
          id: m.id,
          content,
          username: inviterName,
          userId: callerId,
          channelId: m.channelId,
          source: 'game',
          createdAt,
          metadata,
        })),
        // Back-compat: keep the single `message` field pointing at the first post.
        message: first ? {
          id: first.id,
          content,
          username: inviterName,
          userId: callerId,
          channelId: first.channelId,
          source: 'game',
          createdAt,
          metadata,
        } : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/:id/kick { userId }
 */
export async function kickMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  const { userId: targetId } = req.body ?? {};

  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));
  if (!targetId || !UUID_RE.test(targetId)) return next(createError(400, 'userId must be a UUID'));

  try {
    const [callerMembership, targetMembership] = await Promise.all([
      prisma.partyMember.findFirst({ where: { partyId, userId: callerId } }),
      prisma.partyMember.findFirst({ where: { partyId, userId: targetId } }),
    ]);
    if (!callerMembership || !['owner', 'comod'].includes(callerMembership.role)) {
      return next(createError(403, 'Owner or co-mod only'));
    }
    if (!targetMembership) return next(createError(404, 'Target is not a member'));
    if (targetMembership.role === 'owner') return next(createError(403, 'Cannot kick the owner'));
    if (callerMembership.role === 'comod' && targetMembership.role === 'comod') {
      return next(createError(403, 'Co-mods cannot kick other co-mods'));
    }

    await prisma.partyMember.delete({ where: { id: targetMembership.id } });
    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: 'party_kick',
        targetId: partyId,
        targetType: 'party',
        metadata: { kickedUserId: targetId },
      },
    });
    await emitMemberUpdate(partyId);
    res.json({ data: { kicked: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parties/:id/promote { userId }
 */
export async function promoteMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  await changeMemberRole(req, res, next, 'promote');
}

/**
 * POST /api/parties/:id/demote { userId }
 */
export async function demoteMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  await changeMemberRole(req, res, next, 'demote');
}

async function changeMemberRole(
  req: Request, res: Response, next: NextFunction,
  direction: 'promote' | 'demote',
): Promise<void> {
  const callerId = resolveCallerId(req);
  const partyId = paramStr(req, 'id');
  const { userId: targetId } = req.body ?? {};

  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));
  if (!targetId || !UUID_RE.test(targetId)) return next(createError(400, 'userId must be a UUID'));

  try {
    const [party, callerMembership, targetMembership] = await Promise.all([
      prisma.party.findUnique({ where: { id: partyId, isDeleted: false }, select: { ownerId: true } }),
      prisma.partyMember.findFirst({ where: { partyId, userId: callerId } }),
      prisma.partyMember.findFirst({ where: { partyId, userId: targetId } }),
    ]);
    if (!party) return next(createError(404, 'Party not found'));
    if (!callerMembership || callerMembership.role !== 'owner') return next(createError(403, 'Owner only'));
    if (!targetMembership) return next(createError(404, 'Target is not a member'));

    const newRole: 'comod' | 'member' = direction === 'promote' ? 'comod' : 'member';
    if (direction === 'promote' && targetMembership.role === 'comod') {
      return next(createError(409, 'Already a co-mod'));
    }
    if (direction === 'demote' && targetMembership.role === 'member') {
      return next(createError(409, 'Already a member'));
    }
    if (targetMembership.role === 'owner') {
      return next(createError(403, 'Cannot demote the owner'));
    }

    const updated = await prisma.partyMember.update({
      where: { id: targetMembership.id },
      data: { role: newRole },
    });
    await prisma.auditLog.create({
      data: {
        actorId: callerId,
        action: direction === 'promote' ? 'party_promote' : 'party_demote',
        targetId: partyId,
        targetType: 'party',
        metadata: { targetUserId: targetId, newRole },
      },
    });
    await emitMemberUpdate(partyId);
    res.json({ data: { member: updated } });
  } catch (err) {
    next(err);
  }
}

// ── Admin endpoints ──────────────────────────────────────────────────────────

/** GET /api/admin/parties — all parties (incl. private), for staff */
export async function adminListParties(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
    const parties = await prisma.party.findMany({
      where: {
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      include: {
        _count: { select: { members: true, messages: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: { parties } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/parties/:id */
export async function adminGetParty(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));
  try {
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, discordUsername: true } },
          },
        },
      },
    });
    if (!party) return next(createError(404, 'Party not found'));
    res.json({ data: { party } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/parties/:id/messages */
export async function adminListPartyMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));
  try {
    const limit = Math.min(300, Math.max(1, parseInt((req.query.limit as string) ?? '100', 10) || 100));
    const offset = Math.max(0, parseInt((req.query.offset as string) ?? '0', 10) || 0);
    const messages = await prisma.partyMessage.findMany({
      where: { partyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true, content: true, username: true, userId: true, partyId: true,
        source: true, isDeleted: true, createdAt: true,
      },
    });
    res.json({ data: { messages: messages.reverse() } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parties/public
 * PUBLIC, unauthenticated, read-only. Returns ONLY public (isPrivate=false),
 * non-deleted parties with safe browse fields — no membership, invite, owner,
 * or private data. Used by the website's logged-out overlay to browse public
 * parties. NEVER exposes private parties.
 */
export async function listPublicParties(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
    const parties = await prisma.party.findMany({
      where: {
        isDeleted: false,
        isPrivate: false, // hard filter — public parties only
        ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      include: { members: { select: { userId: true } } },
      orderBy: [{ lastMessageAt: 'desc' }],
    });

    const membershipsByParty = new Map<string, string[]>();
    for (const p of parties) membershipsByParty.set(p.id, p.members.map((m: any) => m.userId));
    const onlineCounts = await getOnlineCountsForParties(parties.map(p => p.id), membershipsByParty);

    const result = parties.map(p => ({
      id: p.id,
      name: p.name,
      description: (p as any).description ?? null,
      color: p.color,
      category: p.category,
      isPrivate: false as const,
      reapPolicy: p.reapPolicy,
      maxMembers: p.maxMembers,
      memberCount: p.members.length,
      onlineCount: onlineCounts.get(p.id) ?? 0,
      recentMsgCount: p.recentMsgCount,
      lastMessageAt: p.lastMessageAt?.toISOString() ?? null,
    }));

    result.sort((a, b) => {
      if (b.onlineCount !== a.onlineCount) return b.onlineCount - a.onlineCount;
      if (b.recentMsgCount !== a.recentMsgCount) return b.recentMsgCount - a.recentMsgCount;
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });

    res.json({ data: { parties: result } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parties/public/:id/messages?limit=
 * PUBLIC, unauthenticated, read-only. Returns recent non-deleted messages for a
 * PUBLIC party only. Rejects (404) if the party is private, deleted, or missing —
 * so no private party chat can ever leak through this endpoint.
 */
export async function listPublicPartyMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const partyId = paramStr(req, 'id');
  if (!UUID_RE.test(partyId)) return next(createError(400, 'Invalid party ID'));
  try {
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { isPrivate: true, isDeleted: true },
    });
    // Treat private/deleted/missing identically — never reveal existence of a private party.
    if (!party || party.isDeleted || party.isPrivate) {
      return next(createError(404, 'Party not found'));
    }

    const limit = Math.min(300, Math.max(1, parseInt((req.query.limit as string) ?? '200', 10) || 200));
    const messages = await prisma.partyMessage.findMany({
      where: { partyId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, content: true, username: true, userId: true, partyId: true,
        source: true, createdAt: true,
      },
    });

    const transformed = messages.reverse().map((m) => ({
      id: m.id,
      content: m.content,
      username: m.username,
      userId: m.userId,
      channelId: m.partyId,
      source: m.source || 'party',
      createdAt: m.createdAt,
    }));
    res.json({ data: { messages: transformed } });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/admin/parties/:partyId/messages/:messageId
 * Admin message deletion — soft-deletes a PartyMessage and broadcasts the deletion.
 */
export async function adminDeletePartyMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!PARTIES_ENABLED) { res.status(404).json({ error: 'Not found' }); return; }
  const { partyId, messageId } = paramsOf(req);
  if (!UUID_RE.test(partyId) || !UUID_RE.test(messageId)) return next(createError(400, 'Invalid ID'));
  try {
    const msg = await prisma.partyMessage.findFirst({ where: { id: messageId } });
    if (!msg || msg.partyId !== partyId) return next(createError(404, 'Message not found'));
    await prisma.partyMessage.updateMany({ where: { id: messageId }, data: { isDeleted: true } });
    // Broadcast deletion to party members
    const members = await prisma.partyMember.findMany({
      where: { partyId },
      select: { userId: true },
    });
    const memberIds = members.map(m => m.userId);
    const { broadcastToPartyMembers } = importHandlers();
    broadcastToPartyMembers(
      { type: 'chat:delete', payload: { messageId } },
      memberIds,
    ).catch((err: unknown) => logger.warn({ err }, 'admin party message delete broadcast failed'));
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

async function checkIsStaff(userId: string): Promise<boolean> {
  try {
    const { getEffectiveRole } = await import('../services/userRoleService.js');
    const role = await getEffectiveRole(userId);
    return ['owner', 'admin', 'moderator'].includes(role);
  } catch {
    return false;
  }
}

async function emitMemberUpdate(partyId: string): Promise<void> {
  try {
    const members = await prisma.partyMember.findMany({
      where: { partyId },
      include: {
        user: { select: { id: true, username: true, discordId: true, discordUsername: true, discordDisplayName: true, installToken: true } },
      },
    });
    const { resolveDisplayName, broadcastToPartyMembers } = importHandlers();
    const isOnline = resolveOnlineCheck();
    const memberIds = members.map(m => m.userId);
    const memberList = members.map(m => ({
      userId: m.userId,
      username: resolveDisplayName(m.user),
      role: m.role,
      online: isOnline(m.userId),
      avatarUrl: buildAvatarUrl(m.user.discordId),
    }));
    const onlineCount = memberList.filter(m => m.online).length;
    await broadcastToPartyMembers(
      {
        type: 'party:member-update',
        payload: {
          partyId,
          members: memberList,
          memberCount: memberList.length,
          onlineCount,
        },
      },
      memberIds,
    );
  } catch (err) {
    logger.warn({ err, partyId }, 'emitMemberUpdate failed (non-fatal)');
  }
}

async function emitPartyDeleted(partyId: string): Promise<void> {
  try {
    const members = await prisma.partyMember.findMany({
      where: { partyId },
      select: { userId: true },
    });
    const memberIds = members.map(m => m.userId);
    const { broadcastToPartyMembers } = importHandlers();
    await broadcastToPartyMembers(
      { type: 'party:deleted', payload: { partyId } },
      memberIds,
    );
  } catch (err) {
    logger.warn({ err, partyId }, 'emitPartyDeleted failed (non-fatal)');
  }
}
