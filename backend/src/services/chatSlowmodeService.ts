import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

export const CHAT_SLOWMODE_WINDOW_MS = 60_000;
export const CHAT_SLOWMODE_COOLDOWN_MS = 35_000;
export const CHAT_SLOWMODE_BURST = 3;

export type ChatSlowmodeResult =
  | { allowed: true; remaining: number; retryAfterMs: 0 }
  | { allowed: false; remaining: 0; retryAfterMs: number };

/** One atomic operation across bot/backend instances. Redis time avoids clock skew.
 * A blocked attempt never extends the cooldown. Expiry starts a fresh burst.
 * Arrays preserve distinct messages arriving in the same millisecond.
 */
export const CHAT_SLOWMODE_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local window = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local raw = redis.call('GET', KEYS[1])
local state = raw and cjson.decode(raw) or {messages = {}}
if state.blockedUntil then
  if state.blockedUntil > now then return {0, 0, state.blockedUntil - now} end
  state = {messages = {}}
end
local messages = {}
for _, timestamp in ipairs(state.messages) do
  if timestamp > now - window then table.insert(messages, timestamp) end
end
if #messages >= burst then
  redis.call('SET', KEYS[1], cjson.encode({messages = {}, blockedUntil = now + cooldown}), 'PX', cooldown)
  return {0, 0, cooldown}
end
table.insert(messages, now)
redis.call('SET', KEYS[1], cjson.encode({messages = messages}), 'PX', window)
return {1, burst - #messages, 0}
`;

export function chatSlowmodeKey(actor: { id: string; discordId?: string | null }): string {
  return `chat_slowmode:${actor.discordId ? `discord:${actor.discordId}` : `account:${actor.id}`}`;
}

export function chatSlowmodeMessage(retryAfterMs: number): string {
  return `You are in cooldown. Please wait ${Math.ceil(retryAfterMs / 1000)} seconds before sending another message.`;
}

export async function checkChatSlowmode(actor: { id: string; discordId?: string | null }): Promise<ChatSlowmodeResult> {
  try {
    const redis = await getRedisClient();
    const result = await redis.eval(CHAT_SLOWMODE_SCRIPT, {
      keys: [chatSlowmodeKey(actor)],
      arguments: [String(CHAT_SLOWMODE_WINDOW_MS), String(CHAT_SLOWMODE_COOLDOWN_MS), String(CHAT_SLOWMODE_BURST)],
    });
    if (!Array.isArray(result) || result.length !== 3 || !result.every(value => typeof value === 'number')) {
      throw new Error('Invalid slowmode response');
    }
    return result[0] === 1
      ? { allowed: true, remaining: Number(result[1]), retryAfterMs: 0 }
      : { allowed: false, remaining: 0, retryAfterMs: Number(result[2]) };
  } catch (err) {
    logger.warn({ err }, '[chatSlowmode] shared limiter unavailable; rejecting send');
    // Never silently remove cross-client flood control during a Redis incident.
    return { allowed: false, remaining: 0, retryAfterMs: 5000 };
  }
}
