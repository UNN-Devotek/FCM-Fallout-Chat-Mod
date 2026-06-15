import type { IncomingMessage } from 'http';
import env from '../config/environment';

/**
 * Resolve the true client IP behind the proxy chain (Traefik, and later
 * Cloudflare). Only trusts forwarded headers when TRUST_PROXY is on — otherwise
 * a direct client could spoof them. Preference order:
 *   1. CF-Connecting-IP   (set by Cloudflare; client-supplied copies are stripped)
 *   2. left-most X-Forwarded-For entry (the original client per Traefik)
 *   3. the raw socket peer (no proxy / TRUST_PROXY off)
 *
 * Works for both Express requests and the raw WS upgrade request (both are
 * IncomingMessage). Used for per-IP WebSocket caps and rate-limit keys so every
 * user isn't collapsed into the single proxy IP.
 */
export function clientIp(req: IncomingMessage): string {
  if (env.TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length > 0) return cf.trim();

    const xff = req.headers['x-forwarded-for'];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    if (typeof xffStr === 'string' && xffStr.length > 0) {
      const first = xffStr.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}
