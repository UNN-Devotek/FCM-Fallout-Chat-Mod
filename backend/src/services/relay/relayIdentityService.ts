/**
 * relayIdentityService.ts — thin shim for WT2 inter-agent dynamic import.
 *
 * WT2's /api/link/redeem does:
 *   import('../../src/services/relay/relayIdentityService').then(m => m.markRelayTokenLinked(...))
 *
 * This module re-exports markRelayTokenLinked from tokenService so the import
 * path resolves correctly once WT1 and WT2 are merged into the same deployment.
 * Solo-compile safe: WT2 wraps the import in a try/catch that gracefully no-ops
 * if this module is absent (MODULE_NOT_FOUND). Once both worktrees are merged,
 * the try/catch succeeds and the function is called.
 */

export { markRelayTokenLinked } from './tokenService';
// Push the "link complete" handshake to the user's live in-game subscriber (post-redeem),
// so an already-connected widget transitions from the link screen to chat immediately.
export { notifyLinkComplete } from './relayHandler';
