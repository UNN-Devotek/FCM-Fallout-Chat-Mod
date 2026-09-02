export interface BoundOAuthState {
  sessionId: string;
  intent?: string;
  codeVerifier?: string;
}

export function serializeBoundOAuthState(state: BoundOAuthState): string {
  return JSON.stringify(state);
}

/**
 * Parse a one-time OAuth state value and require the initiating session to
 * match. Returning null for malformed data keeps callbacks fail-closed.
 */
export function parseBoundOAuthState(value: string | null | undefined, sessionId: string): BoundOAuthState | null {
  if (!value || !sessionId) return null;
  try {
    const parsed = JSON.parse(value) as Partial<BoundOAuthState>;
    if (!parsed || typeof parsed !== 'object' || parsed.sessionId !== sessionId) return null;
    return {
      sessionId: parsed.sessionId,
      ...(typeof parsed.intent === 'string' ? { intent: parsed.intent } : {}),
      ...(typeof parsed.codeVerifier === 'string' ? { codeVerifier: parsed.codeVerifier } : {}),
    };
  } catch {
    return null;
  }
}
