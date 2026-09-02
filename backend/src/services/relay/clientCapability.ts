import { createHash } from 'node:crypto';

/**
 * In-game client version handshake and capability gating.
 *
 * WHY THIS EXISTS
 *
 * Until now the relay had no idea what version of the in-game widget it was talking to.
 * `VERSION` in FCMChatWidget.hx only ever reached the local ZFE log file, and the
 * connect payload carried nothing but `displayName` / `autoRegister`. That is fine
 * while the wire format never changes — and a serious problem the moment it does.
 *
 * The `.ba2` is distributed as a MANUAL FILE COPY: the user downloads it, exits the
 * game completely, drops it into Data/, and restarts. There is no auto-update and no
 * way to retire an old build. BUILD.md documents older widgets coexisting with newer
 * relays for exactly this reason. So any new field the relay starts emitting will reach
 * clients that have no idea what it is, indefinitely.
 *
 * For supporter cosmetics specifically, the plan is to carry a per-user name colour to
 * the widget. If that rides in-band (a sentinel suffix on `senderDisplayName`, issue
 * #300) and the relay enables it unconditionally, every player still on an older `.ba2`
 * would see raw sentinel characters inside other users' usernames — forever, with no
 * way to push a fix.
 *
 * Hence: the widget now reports `clientVersion` at register/hello, the relay records it
 * per connection, and any wire-format evolution is gated on it. The native-known
 * FCMHUD/1 cosmetics carrier has a separate minimum from the older additive cosmetics
 * capability because the carrier requires a newer parser in the BA2.
 *
 * This module is PURE (no sockets, no Prisma) so the comparison logic is unit-testable.
 */

/**
 * First widget build that reports `clientVersion` at all, and therefore the first that
 * can be trusted to understand any post-handshake wire additions.
 *
 * Anything older reports nothing, and `parseClientVersion` returns null for it — which
 * is the whole point: absence is treated as "assume the oldest possible client".
 */
export const MIN_COSMETICS_VERSION = '2.10.0';
/** First widget build that understands the native-known targetUserId carrier. */
export const MIN_HUD_COSMETICS_TRANSPORT_VERSION = '2.10.16';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a `major.minor.patch` string. Tolerates a leading `v` and trailing suffixes
 * (e.g. `2.10.0-dev`). Returns null for anything unparseable, INCLUDING undefined —
 * an old client sends no version at all, and that must not be mistaken for a new one.
 */
export function parseClientVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** -1 / 0 / 1, comparing major then minor then patch. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** True when `raw` parses and is >= `minimum`. */
export function versionAtLeast(raw: unknown, minimum: string): boolean {
  const parsed = parseClientVersion(raw);
  const floor = parseClientVersion(minimum);
  if (!parsed || !floor) return false;
  return compareVersions(parsed, floor) >= 0;
}

/**
 * Whether this client can be sent per-user cosmetic data on the wire.
 *
 * FAILS CLOSED. An unknown, missing, or unparseable version means "no" — the cost of
 * being wrong in that direction is that a supporter's colour does not show in-game
 * until they update, which is invisible and harmless. The cost of being wrong the other
 * way is permanent visible garbage in usernames for everyone on an old build.
 */
export function supportsCosmetics(clientVersion: unknown): boolean {
  return versionAtLeast(clientVersion, MIN_COSMETICS_VERSION);
}

/** True only for widgets that decode the FCMHUD/1 carrier in targetUserId. */
export function supportsHudCosmeticsTransport(clientVersion: unknown): boolean {
  return versionAtLeast(clientVersion, MIN_HUD_COSMETICS_TRANSPORT_VERSION);
}

// ── Per-connection registry ───────────────────────────────────────────────────

/**
 * WeakMap so entries disappear with the socket — no disconnect bookkeeping, and no
 * chance of leaking a growing map of dead connections.
 */
const versions = new WeakMap<object, string>();

// `chat.v1.connect` and the long-lived `chat.v1.subscribe` may be separate
// WebSocket connections inside ZFE. Keep the capability beside the opaque relay
// token as well, so the subscriber can receive the same additive fields as the
// connection that negotiated the widget version. Store only a digest — never the
// bearer token itself — and expire entries so a long-running backend cannot retain
// one entry for every token ever issued.
const TOKEN_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
const tokenVersions = new Map<string, { version: string; expiresAt: number }>();

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function pruneTokenVersions(now = Date.now()): void {
  for (const [key, entry] of tokenVersions) {
    if (entry.expiresAt <= now) tokenVersions.delete(key);
  }
}

/** Record the version a client reported at register/hello. */
export function rememberClientVersion(ws: object, raw: unknown): void {
  if (typeof raw === 'string' && raw.trim()) versions.set(ws, raw.trim());
}

/** The version this connection reported, or null if it reported none (old client). */
export function getClientVersion(ws: object): string | null {
  return versions.get(ws) ?? null;
}

/** Convenience: may this specific connection receive cosmetic fields? */
export function connectionSupportsCosmetics(ws: object): boolean {
  return supportsCosmetics(getClientVersion(ws));
}

/** Remember the widget version across ZFE's separate connect/subscribe sockets. */
export function rememberTokenClientVersion(token: unknown, raw: unknown): void {
  if (typeof token !== 'string' || !token || typeof raw !== 'string' || !raw.trim()) return;
  const now = Date.now();
  pruneTokenVersions(now);
  tokenVersions.set(tokenKey(token), { version: raw.trim(), expiresAt: now + TOKEN_VERSION_TTL_MS });
}

/** True only when the token negotiated a widget build that understands cosmetics. */
export function tokenSupportsCosmetics(token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const entry = tokenVersions.get(tokenKey(token));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) tokenVersions.delete(tokenKey(token));
    return false;
  }
  return supportsCosmetics(entry.version);
}

/** True only when a token negotiated a widget that understands the native carrier. */
export function tokenSupportsHudCosmeticsTransport(token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const entry = tokenVersions.get(tokenKey(token));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) tokenVersions.delete(tokenKey(token));
    return false;
  }
  return supportsHudCosmeticsTransport(entry.version);
}

export default {
  MIN_COSMETICS_VERSION,
  MIN_HUD_COSMETICS_TRANSPORT_VERSION,
  parseClientVersion,
  compareVersions,
  versionAtLeast,
  supportsCosmetics,
  supportsHudCosmeticsTransport,
  rememberClientVersion,
  getClientVersion,
  connectionSupportsCosmetics,
  rememberTokenClientVersion,
  tokenSupportsCosmetics,
  tokenSupportsHudCosmeticsTransport,
};
module.exports = {
  MIN_COSMETICS_VERSION,
  MIN_HUD_COSMETICS_TRANSPORT_VERSION,
  parseClientVersion,
  compareVersions,
  versionAtLeast,
  supportsCosmetics,
  supportsHudCosmeticsTransport,
  rememberClientVersion,
  getClientVersion,
  connectionSupportsCosmetics,
  rememberTokenClientVersion,
  tokenSupportsCosmetics,
  tokenSupportsHudCosmeticsTransport,
};
module.exports.default = module.exports;
