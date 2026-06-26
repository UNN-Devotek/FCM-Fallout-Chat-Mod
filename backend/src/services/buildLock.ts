/**
 * Golden-build version lock (dev-only). The dev backend blesses exactly ONE
 * active QA build version; any build that does not report exactly that version
 * is rejected. Fail-OPEN when no active version is configured (so flipping the
 * lock on before setting a version cannot brick every tester); fail-CLOSED on
 * mismatch or a missing client version.
 */
export function isBuildAllowed(
  clientVersion: string,
  activeVersion: string | null,
  lockEnabled: boolean,
): boolean {
  if (!lockEnabled) return true;
  if (!activeVersion) return true; // misconfig safety: lock can't function without a target
  return clientVersion === activeVersion;
}

/**
 * Reads the `x-client-version` request header and evaluates the lock. Pure given
 * its inputs (pass the active version + flag in). Header keys are lowercased by
 * Node's http layer.
 */
export function evaluateBuildGate(
  headers: Record<string, unknown>,
  activeVersion: string | null,
  lockEnabled: boolean,
): { allowed: boolean; clientVersion: string; reason?: string } {
  const raw = headers['x-client-version'];
  const clientVersion = typeof raw === 'string' ? raw : '';
  const allowed = isBuildAllowed(clientVersion, activeVersion, lockEnabled);
  return allowed
    ? { allowed: true, clientVersion }
    : { allowed: false, clientVersion, reason: `Outdated build: v${clientVersion || 'unknown'} (active v${activeVersion}).` };
}
