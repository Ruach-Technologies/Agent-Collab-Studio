import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { TokenRegistry } from '../src/tokens.js';
import { verifyToken } from '../src/auth.js';
import { EventBus } from '../src/events.js';
import { TokenBucketLimiter } from '../src/ratelimit.js';

afterEach(() => vi.useRealTimers());
describe('hub primitives', () => {
  it('stores only token hashes and supports idempotent revocation', () => {
    const db = openDb(':memory:');
    try {
      const registry = new TokenRegistry(db);
      const issued = registry.issue('agent', 'agent');
      const row = db.prepare('SELECT * FROM tokens').get();
      expect(JSON.stringify(row)).not.toContain(issued.token);
      expect(verifyToken(db, issued.token)?.id).toBe(issued.agent.id);
      expect(registry.revoke(issued.agent.id)).toBe(1);
      expect(registry.revoke(issued.agent.id)).toBe(0);
      expect(verifyToken(db, issued.token)).toBeNull();
    } finally { db.close(); }
  });
  it('persists and replays ordered events and unsubscribes listeners', () => {
    const db = openDb(':memory:');
    try {
      const events = new EventBus(db); const received: number[] = [];
      const unsubscribe = events.on((event) => received.push(event.id));
      const one = events.append({ type: 'server.started' });
      unsubscribe(); const two = events.append({ type: 'room.created', payload: { name: 'room' } });
      expect(received).toEqual([one.id]);
      expect(events.since(one.id).map((event) => event.id)).toEqual([two.id]);
      expect(events.since(null, 1).map((event) => event.id)).toEqual([two.id]);
    } finally { db.close(); }
  });
  it('isolates token buckets and refills at the configured rate', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 });
    expect(limiter.check('a').allowed).toBe(true); expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.check('b').allowed).toBe(true);
    vi.advanceTimersByTime(1000); expect(limiter.check('a').allowed).toBe(true);
  });
});
