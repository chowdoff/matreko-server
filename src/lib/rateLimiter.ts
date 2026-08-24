/**
 * 令牌桶限流器（backend §4.5）
 *
 * 抽象 `RateLimiter` 接口，未来多实例可换 Redis 实现。
 * 维度：单客户端（client_id）或按调用方传入的 key 提取函数。
 */
export interface RateLimitResult {
  allowed: boolean;
  /** 下次可重试的等待时间（毫秒） */
  retryAfterMs: number;
}

export interface RateLimiter {
  tryAcquire(key: string): RateLimitResult;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class TokenBucketRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly cap: number,
    private readonly refillRatePerSec: number,
  ) {}

  tryAcquire(key: string): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.cap, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // 补 token（满桶封顶）
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.cap, bucket.tokens + elapsedSec * this.refillRatePerSec);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }

    // 剩余额度补满到 1 个 token 所需时间
    const retryAfterMs = Math.ceil(((1 - bucket.tokens) / this.refillRatePerSec) * 1000);
    return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
  }
}
