/**
 * Persistence timing policy for message producers.
 *
 * The native chat.v1 relay is synchronous. Its queue is durable once accepted,
 * so the relay must not wait for a worker completion before sending its ack and
 * broadcast. Ordinary web producers retain the persist-before-broadcast fence.
 */
export function shouldWaitForPersistence(source: string): boolean {
  return source !== 'relay';
}
