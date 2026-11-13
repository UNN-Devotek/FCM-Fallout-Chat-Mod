/**
 * Stable, machine-readable errors raised by moderationActionsService.
 *
 * Every surface that drives moderation (REST controllers, the Discord
 * `/moderate` command, the /ws and chat.v1 relay handlers, MCP adapters) maps
 * these by `code` instead of parsing messages. `httpStatusForModerationError`
 * gives the REST status used for RFC 7807 Problem Details.
 */
export type ModerationErrorCode =
  | 'ProtectedTarget'        // target holds a staff role (admin_users row, role cache or Discord staff role)
  | 'ProtectionCheckFailed'  // staff-role lookup failed; action refused (fail closed)
  | 'TargetNotFound'         // no users row for the target id
  | 'AlreadyBanned'          // target already has an active ban
  | 'NotBanned'              // unban requested but the target has no active ban
  | 'BanNotFound'            // ban id does not exist
  | 'BanAlreadyReversed'     // ban was already reversed
  | 'InvalidInput';          // missing reason / evidence

const STATUS: Record<ModerationErrorCode, number> = {
  ProtectedTarget: 409,
  ProtectionCheckFailed: 503,
  TargetNotFound: 404,
  AlreadyBanned: 409,
  NotBanned: 409,
  BanNotFound: 404,
  BanAlreadyReversed: 409,
  InvalidInput: 400,
};

export class ModerationError extends Error {
  constructor(public readonly code: ModerationErrorCode, message: string) {
    super(message);
    this.name = 'ModerationError';
  }
}

/**
 * Kept as a subclass (and keeps its historical `name`) because the /ws and
 * relay handlers match `err.name === 'ProtectedTargetError'`.
 */
export class ProtectedTargetError extends ModerationError {
  constructor(public role: string) {
    super('ProtectedTarget', `target holds protected role "${role}" — remove role in Discord first`);
    this.name = 'ProtectedTargetError';
  }
}

export function isModerationError(err: unknown): err is ModerationError {
  return err instanceof ModerationError;
}

export function httpStatusForModerationError(err: ModerationError): number {
  return STATUS[err.code] ?? 400;
}
