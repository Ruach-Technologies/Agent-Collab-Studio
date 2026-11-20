// Per-token token-bucket rate limiter.
// Identity key = authenticated agent id, else client IP (pre-auth requests
// such as failed bearer attempts still cost the attacker, not the hub).
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventBus } from './events.js';
import { requestSource } from './security.js';

export interface RateLimiterOptions {
  capacity: number;
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private opts: RateLimiterOptions) {}

  check(key: string, cost = 1): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    if (this.buckets.size > 10_000) {
      for (const [identity, candidate] of this.buckets) {
        if (now - candidate.updatedAt > 60_000) this.buckets.delete(identity);
      }
      if (this.buckets.size > 10_000) return { allowed: false, retryAfterMs: 1000 };
    }
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.opts.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      this.opts.capacity,
      bucket.tokens + elapsedSec * this.opts.refillPerSecond,
    );
    bucket.updatedAt = now;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, retryAfterMs: 0 };
    }
    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.opts.refillPerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  }
}

/** onRequest hook factory; applied after bearerGuard so req.auth is populated. */
export function makeRateLimitHook(limiter: TokenBucketLimiter, events?: EventBus) {
  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const identity = request.auth?.agent.id ?? request.ip;
    const { allowed, retryAfterMs } = limiter.check(identity);
    if (!allowed) {
      events?.append({ type: 'ratelimit.hit', actor_id: request.auth?.agent.id ?? null, payload: { path: request.url.split('?')[0], source: requestSource(request) } });
      reply.header('retry-after', Math.ceil(retryAfterMs / 1000));
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } });
    }
  };
}
