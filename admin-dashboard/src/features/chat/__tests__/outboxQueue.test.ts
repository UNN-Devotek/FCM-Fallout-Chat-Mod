import { describe, it, expect, vi } from 'vitest';
import { OutboxQueue } from '../outboxQueue';

const NOW = 1_000_000; // arbitrary fixed timestamp for deterministic tests

// ── enqueue ──────────────────────────────────────────────────────────────────
describe('OutboxQueue.enqueue', () => {
  it('returns an id and increments size', () => {
    const q = new OutboxQueue();
    const id = q.enqueue('{"type":"chat:send"}', NOW);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(q.size()).toBe(1);
  });

  it('preserves FIFO insertion order', () => {
    const q = new OutboxQueue();
    q.enqueue('A', NOW);
    q.enqueue('B', NOW + 1);
    q.enqueue('C', NOW + 2);
    const frames = q.peek().map(e => e.frame);
    expect(frames).toEqual(['A', 'B', 'C']);
  });

  it('stores queuedAt from the injected now', () => {
    const q = new OutboxQueue();
    q.enqueue('msg', 9999);
    expect(q.peek()[0].queuedAt).toBe(9999);
  });
});

// ── max-size cap ──────────────────────────────────────────────────────────────
describe('OutboxQueue max-size', () => {
  it('keeps size at 50 when the 51st entry is added (drops oldest)', () => {
    const q = new OutboxQueue();
    for (let i = 0; i < 50; i++) q.enqueue(`msg-${i}`, NOW + i);
    expect(q.size()).toBe(50);
    const oldestId = q.peek()[0].id;

    const newId = q.enqueue('msg-50', NOW + 50);
    expect(q.size()).toBe(50);

    const frames = q.peek().map(e => e.frame);
    // msg-0 dropped; msg-50 at end
    expect(frames[0]).toBe('msg-1');
    expect(frames[49]).toBe('msg-50');
    expect(q.peek().some(e => e.id === oldestId)).toBe(false);
    const peekResult = q.peek();
    expect(peekResult[peekResult.length - 1].id).toBe(newId);
  });
});

// ── flush — happy path ────────────────────────────────────────────────────────
describe('OutboxQueue.flush — happy path', () => {
  it('calls send for each entry in FIFO order, then empties the queue', () => {
    const q = new OutboxQueue();
    q.enqueue('A', NOW);
    q.enqueue('B', NOW + 1);
    q.enqueue('C', NOW + 2);

    const sent: string[] = [];
    const result = q.flush((f) => sent.push(f), NOW + 100);

    expect(sent).toEqual(['A', 'B', 'C']);
    expect(result).toEqual({ sent: 3, dropped: 0 });
    expect(q.size()).toBe(0);
  });

  it('returns sent=0 dropped=0 for an empty queue', () => {
    const q = new OutboxQueue();
    const result = q.flush(() => {}, NOW);
    expect(result).toEqual({ sent: 0, dropped: 0 });
  });
});

// ── flush — stale entries ─────────────────────────────────────────────────────
describe('OutboxQueue.flush — stale entries', () => {
  it('discards entries older than maxAgeMs and counts them as dropped', () => {
    const q = new OutboxQueue();
    q.enqueue('old-1', NOW);
    q.enqueue('old-2', NOW + 1_000);
    q.enqueue('fresh', NOW + 200_000);

    const sent: string[] = [];
    // old-1 age=310k > 300k → dropped; old-2 age=309k > 300k → dropped; fresh age=110k → sent
    const result = q.flush((f) => sent.push(f), NOW + 310_000, 300_000);

    expect(sent).toEqual(['fresh']);
    expect(result).toEqual({ sent: 1, dropped: 2 });
    expect(q.size()).toBe(0);
  });

  it('drops all entries when every entry is past maxAgeMs', () => {
    const q = new OutboxQueue();
    q.enqueue('A', NOW);
    q.enqueue('B', NOW);
    const result = q.flush(() => {}, NOW + 999_999, 5_000);
    expect(result).toEqual({ sent: 0, dropped: 2 });
    expect(q.size()).toBe(0);
  });
});

// ── flush — mid-failure recovery ──────────────────────────────────────────────
describe('OutboxQueue.flush — mid-failure', () => {
  it('stops on the first throwing send and keeps remaining entries (including failed)', () => {
    const q = new OutboxQueue();
    q.enqueue('A', NOW);
    q.enqueue('B', NOW);
    q.enqueue('C', NOW);

    const sent: string[] = [];
    let callCount = 0;
    const send = (f: string) => {
      callCount++;
      if (callCount === 2) throw new Error('ws closed');
      sent.push(f);
    };

    const result = q.flush(send, NOW + 1_000);

    // A sent; B threw; C never called
    expect(sent).toEqual(['A']);
    expect(result).toEqual({ sent: 1, dropped: 0 });
    // B and C remain for the next reconnect
    expect(q.size()).toBe(2);
    expect(q.peek().map(e => e.frame)).toEqual(['B', 'C']);
  });

  it('drain-from-front: entries are only removed after successful send', () => {
    // An exception mid-flush must leave all not-yet-sent entries in the queue.
    const q = new OutboxQueue();
    q.enqueue('X', NOW);
    q.enqueue('Y', NOW);
    q.enqueue('Z', NOW);

    let sendCount = 0;
    const throwingAtFirst = (_f: string) => {
      sendCount++;
      throw new Error('immediate failure');
    };

    const result = q.flush(throwingAtFirst, NOW + 100);

    // Nothing sent
    expect(sendCount).toBe(1);
    expect(result).toEqual({ sent: 0, dropped: 0 });
    // All three still queued
    expect(q.size()).toBe(3);
    expect(q.peek().map(e => e.frame)).toEqual(['X', 'Y', 'Z']);
  });

  it('drain-from-front: partial success + mid-throw leaves only unsent entries', () => {
    const q = new OutboxQueue();
    for (const f of ['A', 'B', 'C', 'D', 'E']) q.enqueue(f, NOW);

    const sent: string[] = [];
    let callCount = 0;
    const send = (f: string) => {
      callCount++;
      if (callCount === 3) throw new Error('closed');
      sent.push(f);
    };

    const result = q.flush(send, NOW + 100);

    expect(sent).toEqual(['A', 'B']);
    expect(result).toEqual({ sent: 2, dropped: 0 });
    // C threw, D and E never tried — all three remain
    expect(q.size()).toBe(3);
    expect(q.peek().map(e => e.frame)).toEqual(['C', 'D', 'E']);
  });

  it('drain-from-front: stale entries before a throw are dropped, fresh ones stay queued', () => {
    const q = new OutboxQueue();
    q.enqueue('stale', NOW);
    q.enqueue('fresh1', NOW + 400_000); // fresh relative to flush time
    q.enqueue('fresh2', NOW + 400_001);

    const send = (_f: string) => { throw new Error('closed'); };

    // stale (age=500k > 300k) dropped; fresh1 throws → fresh1 + fresh2 remain
    const result = q.flush(send, NOW + 500_000, 300_000);

    expect(result).toEqual({ sent: 0, dropped: 1 });
    expect(q.size()).toBe(2);
    expect(q.peek().map(e => e.frame)).toEqual(['fresh1', 'fresh2']);
  });
});

// ── peek / clear ──────────────────────────────────────────────────────────────
describe('OutboxQueue.peek', () => {
  it('returns a shallow copy — mutation does not affect the queue', () => {
    const q = new OutboxQueue();
    q.enqueue('X', NOW);
    const copy = q.peek();
    copy.pop();
    expect(q.size()).toBe(1);
  });
});

describe('OutboxQueue.clear', () => {
  it('empties the queue and size returns 0', () => {
    const q = new OutboxQueue();
    q.enqueue('A', NOW);
    q.enqueue('B', NOW);
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.peek()).toEqual([]);
  });
});
