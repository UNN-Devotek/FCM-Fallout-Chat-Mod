/**
 * Staff moderation helpers for ChatOverlay's message and member menus.
 *
 * Pure (or fetch-only) so the endpoint selection and the result text can be
 * unit tested without rendering the whole overlay. Every request here goes
 * through the global fetch: on the website that carries the dashboard session
 * cookie; in the Electron overlay the bridge shim proxies it through the main
 * process, which attaches the install X-Auth-Token. The backend accepts either
 * on these specific routes (requireStaffRole).
 */

export interface StaffDeleteTarget {
  id: string;
  source?: string;
  channelId?: string | null;
}

export interface StaffRoles {
  isMod: boolean;
  isAdmin: boolean;
}

/**
 * Which REST route deletes this message for staff, or null when staff deletion
 * of this kind of message is not supported:
 *  - channel/feed messages  -> DELETE /api/messages/:id (moderator+)
 *  - party messages         -> DELETE /api/admin/parties/:partyId/messages/:id (admin+)
 *  - private messages (pm)  -> unsupported: there is no staff PM delete route
 *  - Server-room messages   -> unsupported: relay history has no delete route
 */
export function staffDeleteRoute(msg: StaffDeleteTarget): { path: string; minRole: 'moderator' | 'admin' } | null {
  if (!msg.id) return null;
  const id = encodeURIComponent(msg.id);
  if (msg.source === 'pm') return null;
  if (msg.source === 'server' || (msg.channelId?.startsWith('server:') ?? false)) return null;
  if (msg.source === 'party') {
    if (!msg.channelId) return null;
    return { path: `/api/admin/parties/${encodeURIComponent(msg.channelId)}/messages/${id}`, minRole: 'admin' };
  }
  return { path: `/api/messages/${id}`, minRole: 'moderator' };
}

/** True when the viewer's role may delete this message (menu visibility). */
export function canStaffDelete(msg: StaffDeleteTarget, roles: StaffRoles): boolean {
  const route = staffDeleteRoute(msg);
  if (!route) return false;
  return route.minRole === 'admin' ? roles.isAdmin : roles.isMod;
}

/**
 * Full request path for a staff delete, carrying the optional reason as a query
 * parameter (the dashboard API client sends no DELETE body). Null when the
 * message kind is not deletable by staff.
 */
export function staffDeletePath(msg: StaffDeleteTarget, reason = ''): string | null {
  const route = staffDeleteRoute(msg);
  if (!route) return null;
  const trimmed = reason.trim();
  return trimmed ? `${route.path}?reason=${encodeURIComponent(trimmed.slice(0, 500))}` : route.path;
}

/**
 * Human-readable failure text from an RFC 7807 problem body. Prefers the
 * server's own detail (e.g. the protected-staff refusal) over a bare status.
 */
export function moderationErrorText(status: number, body: unknown): string {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const detail = typeof b.detail === 'string' && b.detail.trim() ? b.detail.trim() : null;
  const code = typeof b.code === 'string' && b.code ? b.code : null;
  if (code === 'ProtectedTarget') return detail ? `Cannot moderate staff: ${detail}` : 'Cannot moderate a staff member.';
  if (status === 401) return detail ?? 'Not signed in as staff.';
  if (status === 403) return detail ?? 'Your role cannot perform this action.';
  return detail ?? (code ? `${code} (HTTP ${status})` : `HTTP ${status}`);
}

// Both members declare both keys so the union narrows under the overlay tsconfig (no strictNullChecks) too.
export type ModerationResult = { ok: true; message: string; error?: undefined } | { ok: false; error: string; message?: undefined };

async function send(path: string, method: string, body: unknown, success: string): Promise<ModerationResult> {
  try {
    const res = await fetch(path, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}));
      return { ok: false, error: moderationErrorText(res.status, parsed) };
    }
    return { ok: true, message: success };
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message ? err.message : 'Network error' };
  }
}

export function submitKick(target: { userId: string; username: string }, reason: string): Promise<ModerationResult> {
  return send('/api/moderation/kicks', 'POST', { userId: target.userId, reason },
    `Kicked ${target.username} for 5 minutes`);
}

export function submitMute(
  target: { userId: string; username: string },
  minutes: number,
  category: string,
  reason: string,
): Promise<ModerationResult> {
  return send('/api/moderation/mutes', 'POST', { userId: target.userId, durationMinutes: minutes, category, reason },
    `Muted ${target.username}`);
}

export function submitUnmute(target: { userId: string; username: string }): Promise<ModerationResult> {
  return send(`/api/moderation/mutes/${encodeURIComponent(target.userId)}`, 'DELETE', undefined,
    `Mute cleared for ${target.username}`);
}
