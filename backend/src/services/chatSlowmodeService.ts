import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

export const CHAT_SLOWMODE_WINDOW_MS = 30_000;
export const CHAT_SLOWMODE_COOLDOWN_MS = 35_000;
export const CHAT_SLOWMODE_BURST = 3;
export const CHAT_SLOWMODE_MAX_COOLDOWN_MS = 300_000;
export const CHAT_SLOWMODE_RESET_MS = 15 * 60_000;
export const CHAT_SLOWMODE_HARD_WINDOW_MS = 60_000;
export const CHAT_SLOWMODE_HARD_CAP = 60;

export type ChatSlowmodeResult =
  | { allowed: true; remaining: number; retryAfterMs: 0 }
  | { allowed: false; remaining: 0; retryAfterMs: number };

/** Atomic, bounded flood protection across bot/backend instances. Redis time
 * avoids clock skew; arrays count distinct sends within the same millisecond.
 * Only fresh flood violations escalate, with one extreme-flood escalation per
 * cooldown. Routine retries return the existing deadline without extending it.
 */
export const CHAT_SLOWMODE_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local window = tonumber(ARGV[1])
local cooldown = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local maximum = tonumber(ARGV[4])
local quietReset = tonumber(ARGV[5])
local hardWindow = tonumber(ARGV[6])
local hardCap = tonumber(ARGV[7])
local raw = redis.call('GET', KEYS[1])
local state = raw and cjson.decode(raw) or {}
-- Retire the old three-per-minute budget and its penalties on rollout.
if state.version ~= 2 then state = {version = 2, messages = {}, attempts = {}, strikes = 0} end
if state.lastViolationAt and now - state.lastViolationAt >= quietReset then
  state.strikes = 0
  state.lastViolationAt = nil
end
if state.blockedUntil and state.blockedUntil <= now then
  state.blockedUntil = nil
  state.hardLimited = nil
  state.messages = {}
end
local attempts = {}
for _, timestamp in ipairs(state.attempts) do
  if timestamp > now - hardWindow then table.insert(attempts, timestamp) end
end
if #attempts >= hardCap then table.remove(attempts, 1) end
table.insert(attempts, now)
state.attempts = attempts
local function save()
  local ttl = math.max(window, hardWindow,
    state.blockedUntil and state.blockedUntil - now or 0,
    state.lastViolationAt and quietReset - (now - state.lastViolationAt) or 0)
  redis.call('SET', KEYS[1], cjson.encode(state), 'PX', ttl)
end
-- A sustained flood can escalate an active short cooldown once. Continued
-- attempts within that hard cooldown cannot move its deadline indefinitely.
if #attempts >= hardCap and not state.hardLimited then
  state.strikes = 5
  state.lastViolationAt = now
  state.blockedUntil = now + maximum
  state.hardLimited = true
  state.messages = {}
  save()
  return {0, 0, maximum}
end
if state.blockedUntil then
  save()
  return {0, 0, state.blockedUntil - now}
end
local messages = {}
for _, timestamp in ipairs(state.messages) do
  if timestamp > now - window then table.insert(messages, timestamp) end
end
if #messages >= burst then
  state.strikes = math.min(5, state.strikes + 1)
  local wait = math.min(maximum, cooldown * 2 ^ (state.strikes - 1))
  state.lastViolationAt = now
  state.blockedUntil = now + wait
  state.messages = {}
  save()
  return {0, 0, wait}
end
table.insert(messages, now)
state.messages = messages
save()
return {1, burst - #messages, 0}
`;

function isSlowmodeReply(value: unknown): value is [0 | 1, number, number] {
  if (!Array.isArray(value) || value.length !== 3
      || !value.every(item => typeof item === 'number' && Number.isSafeInteger(item))) return false;
  const [allowed, remaining, retryAfterMs] = value;
  return (allowed === 1 && remaining >= 0 && remaining < CHAT_SLOWMODE_BURST && retryAfterMs === 0)
    || (allowed === 0 && remaining === 0 && retryAfterMs > 0 && retryAfterMs <= CHAT_SLOWMODE_MAX_COOLDOWN_MS);
}

export function chatSlowmodeKey(actor: { id: string; discordId?: string | null }): string {
  // Older backend replicas must not overwrite the new adaptive state on rollout.
  return `chat_slowmode:v2:${actor.discordId ? `discord:${actor.discordId}` : `account:${actor.id}`}`;
}

export function chatSlowmodeMessage(retryAfterMs: number): string {
  return `You are in cooldown. Please wait ${Math.ceil(retryAfterMs / 1000)} seconds before sending another message.`;
}

export async function checkChatSlowmode(actor: { id: string; discordId?: string | null }): Promise<ChatSlowmodeResult> {
  try {
    const redis = await getRedisClient();
    const result = await redis.eval(CHAT_SLOWMODE_SCRIPT, {
      keys: [chatSlowmodeKey(actor)],
      arguments: [CHAT_SLOWMODE_WINDOW_MS, CHAT_SLOWMODE_COOLDOWN_MS, CHAT_SLOWMODE_BURST,
        CHAT_SLOWMODE_MAX_COOLDOWN_MS, CHAT_SLOWMODE_RESET_MS, CHAT_SLOWMODE_HARD_WINDOW_MS,
        CHAT_SLOWMODE_HARD_CAP].map(String),
    });
    if (!isSlowmodeReply(result)) {
      throw new Error('Invalid slowmode response');
    }
    return result[0] === 1
      ? { allowed: true, remaining: result[1], retryAfterMs: 0 }
      : { allowed: false, remaining: 0, retryAfterMs: result[2] };
  } catch (err) {
    logger.warn({ err }, '[chatSlowmode] shared limiter unavailable; rejecting send');
    // Never silently remove cross-client flood control during a Redis incident.
    return { allowed: false, remaining: 0, retryAfterMs: 5000 };
  }
}
