import { Router, Request } from 'express';
import { AdminRole } from '@prisma/client';
import { authController } from '@/controllers/auth.controller';
import { requireBackofficeAuth, getClientIp } from '@/middlewares/auth';
import { backofficeLoginRateLimiter, createRateLimitMiddleware } from '@/middlewares/rateLimit';

/** 登录限流 key：按账号（email 归一化）维度；body 缺失时降级为 IP */
function loginRateLimitKey(req: Request): string {
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (email) return `login:${email}`;
  return `login:ip:${getClientIp(req) ?? 'unknown'}`;
}

/**
 * @swagger
 * /api/supervisor/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: 主管登录（P0-A-19 AC3）
 *     description: 主管以邮箱+密码登录用户后台，签发后台会话凭据；连续失败 10 次锁定 30 分钟（AC7/AC8）；单账号 30 分钟内最多登录 10 次（超限 429）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/LoginRequest' }
 *     responses:
 *       200:
 *         description: 登录成功
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LoginResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       423: { $ref: '#/components/responses/AccountLocked' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
export const supervisorAuthRouter = Router();

supervisorAuthRouter.post(
  '/login',
  createRateLimitMiddleware(backofficeLoginRateLimiter, loginRateLimitKey),
  ...authController.login(AdminRole.SUPERVISOR),
);

/**
 * @swagger
 * /api/supervisor/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: 主管登出（P0-A-19 AC4）
 *     description: 当前会话凭据立即失效。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204: { $ref: '#/components/responses/NoContent' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
supervisorAuthRouter.post('/logout', requireBackofficeAuth([AdminRole.SUPERVISOR]), authController.logout);

/**
 * @swagger
 * /api/supervisor/auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: 修改密码（P0-A-19 AC5/AC10）
 *     description: 修改成功后其余已登录会话全部失效，当前会话保留；新密码需 ≥8 位且含字母与数字。
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ChangePasswordRequest' }
 *     responses:
 *       204: { $ref: '#/components/responses/NoContent' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
supervisorAuthRouter.post(
  '/change-password',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  ...authController.changePassword,
);

/**
 * @swagger
 * /api/platform/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: 平台管理员登录（P0-A-19 AC3）
 *     description: 管理员以邮箱+密码登录管理后台，签发后台会话凭据；连续失败 10 次锁定 30 分钟（AC7/AC8）；单账号 30 分钟内最多登录 10 次（超限 429）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/LoginRequest' }
 *     responses:
 *       200:
 *         description: 登录成功
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/LoginResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       423: { $ref: '#/components/responses/AccountLocked' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
export const platformAuthRouter = Router();

platformAuthRouter.post(
  '/login',
  createRateLimitMiddleware(backofficeLoginRateLimiter, loginRateLimitKey),
  ...authController.login(AdminRole.PLATFORM),
);

/**
 * @swagger
 * /api/platform/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: 平台管理员登出（P0-A-19 AC4）
 *     description: 当前会话凭据立即失效。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204: { $ref: '#/components/responses/NoContent' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
platformAuthRouter.post('/logout', requireBackofficeAuth([AdminRole.PLATFORM]), authController.logout);

/**
 * @swagger
 * /api/platform/auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: 修改密码（P0-A-19 AC5/AC10）
 *     description: 修改成功后其余已登录会话全部失效，当前会话保留；新密码需 ≥8 位且含字母与数字。
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ChangePasswordRequest' }
 *     responses:
 *       204: { $ref: '#/components/responses/NoContent' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
platformAuthRouter.post(
  '/change-password',
  requireBackofficeAuth([AdminRole.PLATFORM]),
  ...authController.changePassword,
);

/**
 * @swagger
 * /api/platform/auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: 重置主管密码（P0-A-19 AC13）
 *     description: >
 *       管理员重置主管密码，密码由后端随机生成（与创建团队时同样方式）；
 *       重置后该主管所有已登录会话立即失效；
 *       临时密码仅此一次在响应中返回，系统不提供自助找回密码。
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ResetPasswordRequest' }
 *     responses:
 *       200:
 *         description: 重置成功，返回临时密码（仅此一次）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ResetPasswordResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
platformAuthRouter.post(
  '/reset-password',
  requireBackofficeAuth([AdminRole.PLATFORM]),
  ...authController.resetPassword,
);

/**
 * @swagger
 * /api/platform/auth/disable-account:
 *   post:
 *     tags: [Auth]
 *     summary: 禁用后台账号（P0-A-19 AC14/AC15）
 *     description: 仅可禁用主管账号；平台管理员账号不可禁用；禁用后该账号全部会话立即失效。
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/DisableAccountRequest' }
 *     responses:
 *       204: { $ref: '#/components/responses/NoContent' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
platformAuthRouter.post(
  '/disable-account',
  requireBackofficeAuth([AdminRole.PLATFORM]),
  ...authController.disableAccount,
);
