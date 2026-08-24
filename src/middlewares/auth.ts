import { RequestHandler, Request } from 'express';
import { AdminRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { sha256 } from '@/lib/crypto';
import { env } from '@/config/env';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { extractBearerToken } from '@/services/auth.service';

/** 提取客户端来源 IP */
export function getClientIp(req: Request): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.ip;
}

/**
 * 后台会话鉴权中间件（P0-A-19 AC17 / backend §2）
 *
 * - 校验 BackofficeSession（tokenHash + revokedAt + expiresAt）
 * - 校验账号状态与角色
 * - 主管额外校验团队状态（AC12）
 * - 两套凭据隔离：后台路由强制 backoffice 会话，客户端凭据(token_type=client)一律 401
 * - 滑动续期：每次通过鉴权的 API 调用都把 expiresAt 刷新为 now + backofficeSessionTtlMs
 *   （默认 30 分钟）。即 30 分钟内无任何 API 调用则凭据失效、需重新登录。
 */
export function requireBackofficeAuth(
  roles: AdminRole[] = [AdminRole.PLATFORM, AdminRole.SUPERVISOR],
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        throw AppError.unauthorized('缺少身份凭据', ErrorCode.UNAUTHORIZED);
      }

      const tokenHash = sha256(token);
      const session = await prisma.backofficeSession.findUnique({
        where: { tokenHash },
        include: { account: { include: { team: true } } },
      });

      if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
        throw AppError.unauthorized('会话无效或已过期', ErrorCode.AUTH_INVALID);
      }
      if (!roles.includes(session.account.role)) {
        throw AppError.unauthorized('无权访问该后台', ErrorCode.TOKEN_TYPE_MISMATCH);
      }
      if (session.account.status === 'DISABLED') {
        throw AppError.forbidden('账号不可用，请联系管理员', ErrorCode.ACCOUNT_DISABLED);
      }
      // 主管所属团队不可用 → 拒绝（P0-A-19 AC12）
      if (session.account.role === AdminRole.SUPERVISOR) {
        const team = session.account.team;
        if (!team) {
          throw AppError.forbidden('账号未关联团队，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
        }
        if (team.status === 'DISABLED') {
          throw AppError.forbidden('团队已不可用，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
        }
        if (team.expiresAt.getTime() <= Date.now()) {
          throw AppError.forbidden('团队已到期，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
        }
      }

      // 滑动续期：每次通过鉴权的 API 调用都把过期时间刷新为「now + 有效期」
      // —— 即 30 分钟内无任何调用则凭据失效，需重新登录（需求 1 & 2）
      await prisma.backofficeSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() + env.backofficeSessionTtlMs) },
      });

      req.session = session;
      req.account = session.account;
      next();
    } catch (err) {
      next(err);
    }
  };
}
