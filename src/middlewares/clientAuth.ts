import { RequestHandler } from 'express';
import { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';
import { hashFingerprint } from '@/lib/crypto';
import { verifyClientAccessToken, TokenTypeMismatchError } from '@/lib/jwt';
import { getKeyStatusWithCache } from '@/services/token.service';
import { writeAuditLog, AuditAction } from '@/services/audit.service';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { env } from '@/config/env';
import { extractBearerToken } from '@/services/auth.service';
import { getClientIp } from '@/middlewares/auth';
import { clientOtherRateLimiter, clientTranslateRateLimiter } from '@/middlewares/rateLimit';

/**
 * 客户端鉴权中间件（P0-A-02 AC1/AC4-AC9/AC17，backend §4.3 鉴权链）：
 * ① JWT 签名与有效期 → ② token_type=client → ③ jti 撤销名单（60s 宽限期）
 * → ④ 密钥状态 → ⑤ 团队状态 → ⑥ ClientCredential 有效性 + 指纹比对 → 注入 req.auth
 */
export const requireClientAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw AppError.unauthorized('缺少身份凭据', ErrorCode.UNAUTHORIZED);
    }

    // ① JWT 签名与有效期（AC5/AC6：区分 invalid / expired）
    let verified;
    try {
      verified = verifyClientAccessToken(token);
    } catch (err) {
      if (err instanceof TokenExpiredError || (err as Error).name === 'TokenExpiredError') {
        throw AppError.unauthorized('凭据已过期', ErrorCode.AUTH_EXPIRED);
      }
      if (err instanceof TokenTypeMismatchError) {
        // AC17：JWT 有效但 token_type 非 client（后台类型凭据 → 客户端接口）→ 401
        throw AppError.unauthorized('凭据类型不符', ErrorCode.TOKEN_TYPE_MISMATCH);
      }
      if (err instanceof JsonWebTokenError || (err as Error).name === 'JsonWebTokenError') {
        // AC5：签名无效/被篡改 → 审计
        await writeAuditLog({
          actorType: 'CLIENT',
          actorId: 'unknown',
          action: AuditAction.CREDENTIAL_TAMPERED,
          detail: { reason: (err as Error).message },
          ip: getClientIp(req),
        });
      }
      throw AppError.unauthorized('凭据无效', ErrorCode.AUTH_INVALID);
    }

    const { payload, expiresInMs } = verified;

    // ② token_type=client（后台凭据调用客户端接口 → 401，P0-A-19 AC17）
    if (payload.token_type !== 'client') {
      throw AppError.unauthorized('凭据类型不符', ErrorCode.TOKEN_TYPE_MISMATCH);
    }

    // ③ jti 撤销名单：命中且超宽限期 → 401（宽限期内放行，保护在途请求 AC12）
    const revoked = await prisma.revokedToken.findUnique({ where: { jti: payload.jti } });
    if (revoked) {
      const revokedAgo = Date.now() - revoked.revokeAt.getTime();
      if (revokedAgo > env.tokenRenewGraceMs) {
        throw AppError.unauthorized('凭据已失效', ErrorCode.CREDENTIAL_REVOKED);
      }
    }

    // ④⑤ 密钥/团队状态（TTL 60s 缓存 + 主动失效）
    const status = await getKeyStatusWithCache(payload.keyId);
    if (!status) {
      throw AppError.unauthorized('凭据已失效', ErrorCode.CREDENTIAL_REVOKED);
    }
    if (status.keyStatus !== 'UNUSED' && status.keyStatus !== 'ACTIVE') {
      // AC8：密钥禁用后 ≤60s 内断权（缓存主动失效 + TTL）
      throw AppError.forbidden('密钥已禁用，请联系主管', ErrorCode.KEY_DISABLED);
    }
    if (status.teamStatus === 'DISABLED') {
      throw AppError.forbidden('团队已不可用，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
    }
    if (status.teamExpiresAt <= Date.now()) {
      throw AppError.forbidden('团队已到期', ErrorCode.TEAM_UNAVAILABLE);
    }

    // ⑥ ClientCredential 有效性（解绑/下线后凭据已删除）+ 指纹比对（AC9）
    const credential = await prisma.clientCredential.findUnique({
      where: { clientId: payload.sub },
    });
    if (!credential || credential.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized('凭据已失效', ErrorCode.CREDENTIAL_REVOKED);
    }

    const fingerprintHeader = req.headers['x-device-fingerprint'];
    if (typeof fingerprintHeader !== 'string' || fingerprintHeader.length === 0) {
      throw AppError.unauthorized('缺少设备指纹', ErrorCode.FINGERPRINT_MISMATCH);
    }
    const fingerprintHash = hashFingerprint(fingerprintHeader, payload.keyId);
    if (credential.deviceFingerprintHash !== fingerprintHash) {
      await writeAuditLog({
        actorType: 'CLIENT',
        actorId: payload.sub,
        action: AuditAction.FINGERPRINT_MISMATCH,
        detail: { keyId: payload.keyId },
        ip: getClientIp(req),
      });
      throw AppError.forbidden('设备指纹不匹配', ErrorCode.FINGERPRINT_MISMATCH);
    }

    // ⑦ 单客户端限流（P0-A-02 AC10/AC11，backend §4.5：按 client_id 维度，绝不按团队/全局聚合）
    const isTranslate = req.path.startsWith('/api/client/translate');
    const limiter = isTranslate ? clientTranslateRateLimiter : clientOtherRateLimiter;
    const { allowed, retryAfterMs } = limiter.tryAcquire(payload.sub);
    if (!allowed) {
      throw AppError.tooManyRequests('请求过于频繁，请稍后重试', retryAfterMs);
    }

    req.auth = {
      keyId: payload.keyId,
      clientId: payload.sub,
      deviceFingerprintHash: credential.deviceFingerprintHash,
      jti: payload.jti,
    };
    // 注入剩余有效期，供续期判断（≤1/3 时客户端续期）
    req.authExpiresInMs = expiresInMs;
    next();
  } catch (err) {
    next(err);
  }
};
