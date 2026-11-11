interface Bucket {
  tokens: number;
  at: number;
}

export interface Decision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until one more request is allowed; 0 when allowed. */
  retryAfter: number;
}

/** Token bucket per key: holds up to `perMinute` requests and refills evenly, so there is no burst at a window edge. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private now: () => number = Date.now) {}

  take(key: string, perMinute: number): Decision {
    const t = this.now();
    const rate = perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + (t - b.at) * rate);
    b.at = t;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, limit: perMinute, remaining: Math.floor(b.tokens), retryAfter: 0 };
    }
    return { allowed: false, limit: perMinute, remaining: 0, retryAfter: Math.ceil((1 - b.tokens) / rate / 1000) };
  }

  /** Drops buckets that have been idle long enough to be full again. */
  private prune(t: number) {
    for (const [k, b] of this.buckets) if (t - b.at > 60_000) this.buckets.delete(k);
  }
}
