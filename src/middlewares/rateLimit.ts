import { RequestHandler, Request } from 'express';
import { TokenBucketRateLimiter } from '@/lib/rateLimiter';
import { ErrorCode } from '@/constants/errorCodes';
import { ApiResponse } from '@/utils/ApiResponse';
import { env } from '@/config/env';

/**
 * 限流中间件工厂（P0-A-02 AC10）
 *
 * 超限返回 429 + `Retry-After` 响应头 + 响应体 `{ retryAfterMs }`，
 * 客户端据此延后重试，不得立即重发。
 */
export function createRateLimitMiddleware(
  limiter: TokenBucketRateLimiter,
  keyFn: (req: Request) => string,
): RequestHandler {
  return (req, res, next) => {
    const key = keyFn(req);
    const { allowed, retryAfterMs } = limiter.tryAcquire(key);
    if (!allowed) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return ApiResponse.error(
        res,
        '请求过于频繁，请稍后重试',
        429,
        ErrorCode.RATE_LIMITED,
        { retryAfterMs },
      );
    }
    next();
  };
}

// ── 共享令牌桶实例（backend §4.5；维度均为单客户端，绝不按团队/全局聚合 AC11） ──

/** 其余客户端接口：50 / 50s */
export const clientOtherRateLimiter = new TokenBucketRateLimiter(
  env.rateLimitOtherCap,
  env.rateLimitOtherRate,
);

/** 翻译接口 `/api/client/translate`：20 / 20s（M2/M3 接入，桶先建好） */
export const clientTranslateRateLimiter = new TokenBucketRateLimiter(
  env.rateLimitTranslateCap,
  env.rateLimitTranslateRate,
);

/** 激活接口 `/api/client/activate`：5 / 1s（激活低频，防爆破） */
export const activateRateLimiter = new TokenBucketRateLimiter(
  env.rateLimitActivateCap,
  env.rateLimitActivateRate,
);

/** 后台登录接口：每账号 10 次 / 30 分钟（与 P0-A-19 AC7 锁定策略联动） */
export const backofficeLoginRateLimiter = new TokenBucketRateLimiter(10, 10 / 1800);
