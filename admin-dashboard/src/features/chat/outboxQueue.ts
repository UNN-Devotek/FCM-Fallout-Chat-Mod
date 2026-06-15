/**
 * OutboxQueue — pure, React-free module for queuing outgoing chat:send frames
 * while the WebSocket is disconnected and flushing them on reconnect.
 *
 * Design constraints:
 *  - Max 50 entries (oldest dropped when exceeded — newest intent matters most).
 *  - Max age 5 minutes on flush (stale messages are silently discarded).
 *  - `now` is always injected so tests are fully deterministic.
 *  - party:send and all non-user-chat frames are NEVER queued here.
 *  - Inert in public mode (caller must gate on isPublicMode before enqueueing).
 */

export interface OutboxEntry {
  /** Unique ID (crypto.randomUUID()) */
  id: string;
  /** The exact JSON string to pass to ws.send() */
  frame: string;
  /** Timestamp when the entry was queued (Date.now()) */
  queuedAt: number;
}

const MAX_SIZE = 50;

export class OutboxQueue {
  private queue: OutboxEntry[] = [];

  /**
   * Add a frame to the queue. If the queue is already at MAX_SIZE, the oldest
   * entry is removed first (newest intent is kept). Returns the new entry's id.
   */
  enqueue(frame: string, now: number): string {
    if (this.queue.length >= MAX_SIZE) {
      this.queue.shift(); // drop oldest
    }
    const id = crypto.randomUUID();
    this.queue.push({ id, frame, queuedAt: now });
    return id;
  }

  /**
   * Send all queued entries in FIFO order, discarding entries older than
   * `maxAgeMs`. Uses a drain-from-front pattern: each entry is removed from the
   * queue only *after* it is successfully sent, so an unexpected throw anywhere
   * in flush cannot lose un-sent entries — they remain at the front of the queue
   * for the next reconnect.
   *
   * Behavior:
   *  - FIFO order preserved.
   *  - Entries older than maxAgeMs are counted as dropped (and removed).
   *  - On send-throw, processing stops; all not-yet-sent entries stay queued.
   *  - Returns `{ sent, dropped }` counts.
   */
  flush(
    send: (frame: string) => void,
    now: number,
    maxAgeMs = 5 * 60 * 1000,
  ): { sent: number; dropped: number } {
    let sent = 0;
    let dropped = 0;

    while (this.queue.length > 0) {
      const entry = this.queue[0];
      if (now - entry.queuedAt > maxAgeMs) {
        // Stale — remove from front and count as dropped.
        this.queue.shift();
        dropped++;
        continue;
      }
      try {
        send(entry.frame);
        // Only remove from queue after successful send.
        this.queue.shift();
        sent++;
      } catch {
        // Leave the failed entry (and everything behind it) in the queue so
        // the next reconnect can retry them.
        return { sent, dropped };
      }
    }

    return { sent, dropped };
  }

  /** Current number of queued entries. */
  size(): number {
    return this.queue.length;
  }

  /** Returns a shallow copy of the queue in FIFO order. */
  peek(): OutboxEntry[] {
    return [...this.queue];
  }

  /** Discard all queued entries. */
  clear(): void {
    this.queue = [];
  }
}
