/**
 * Builds the DM sent to a Discord author whose bridged message was deleted for
 * being over-length (issue #384).
 *
 * Lives in utils/ rather than discordService so it can be unit-tested without
 * importing that module: discordService pulls in the BullMQ message queue (which
 * opens Redis sockets and keeps the test process alive), and its trailing
 * `module.exports = { ... }` shadows ES exports at runtime anyway.
 */

/** Discord's hard per-message character cap for a normal (non-Nitro) bot send. */
const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Build the DM sent to an author whose bridged message was deleted for being
 * over-length, echoing their original text back so they can copy-paste and trim
 * instead of retyping it (issue #384).
 *
 * The echoed text is wrapped in a fenced code block for two reasons:
 *   - @mentions and role pings inside it must NOT fire a second time in the DM.
 *   - markdown in the original stays literal, so what they see is what they typed.
 *
 * Any backtick run in the content would break out of the fence, so the fence is
 * chosen to be longer than the longest run present.
 *
 * If the notice + content would exceed Discord's 2000-char message limit the
 * content is truncated (never split across several DMs — a multi-DM burst reads
 * as spam, and `MAX_RELAY_CHARS` is 255, so anything near the limit is being
 * rewritten by the author anyway). Truncation is always signposted.
 */
export function buildOverLengthDm(content: string, maxRelayChars: number): string {
  const notice =
    `Your message in the in-game chat channel was too long and was not posted. ` +
    `Please keep it to ${maxRelayChars} characters or fewer (yours was ${content.length}).`;

  // Fence must be longer than the longest backtick run in the content.
  const longestTicks = (content.match(/`+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0);
  const fence = '`'.repeat(Math.max(3, longestTicks + 1));

  const header = `${notice}\n\nHere it is so you don't have to retype it:\n${fence}\n`;
  const footer = `\n${fence}`;
  const budget = DISCORD_MESSAGE_LIMIT - header.length - footer.length;

  // Degenerate case: no room for any content at all — send the notice alone
  // rather than an empty code block.
  if (budget <= 0) return notice.slice(0, DISCORD_MESSAGE_LIMIT);

  if (content.length <= budget) return header + content + footer;

  // The marker embeds `keep` itself, so its length depends on the value we are
  // solving for. Reserving space against a `{n}` placeholder would under-reserve
  // (a 4-digit count is longer than "{n}") and push the DM past the limit.
  // `keep` can never exceed `budget`, so sizing the reservation with `budget`
  // is a safe upper bound on the marker's final width.
  const markerFor = (n: number) =>
    `\n… [truncated — showing the first ${n} of ${content.length} characters]`;
  const keep = Math.max(0, budget - markerFor(budget).length);
  return header + content.slice(0, keep) + markerFor(keep) + footer;
}
