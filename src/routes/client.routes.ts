import { Router } from 'express';
import { clientController } from '@/controllers/client.controller';
import { requireClientAuth } from '@/middlewares/clientAuth';
import { activateRateLimiter, createRateLimitMiddleware } from '@/middlewares/rateLimit';
import { getClientIp } from '@/middlewares/auth';

/**
 * @swagger
 * /api/client/activate:
 *   post:
 *     tags: [Client]
 *     summary: 客户端激活（P0-A-01 AC1/AC3-AC13/AC16）
 *     description: >
 *       用密钥 + 本机硬件指纹激活客户端，激活成功即返回 access token 与 refresh token；
 *       同设备重复激活幂等返回「已激活」；未开多开且已绑定其他设备时按 AC8 拒绝并展示已绑定设备标识与时间；
 *       指纹变化一律按新设备走名额判定（AC12），激活成功后提示原设备仍占名额（AC16）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ActivateRequest' }
 *     responses:
 *       200:
 *         description: 激活成功（或该设备此前已激活）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ActivateResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401:
 *         description: 密钥无效
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       403:
 *         description: 密钥已禁用 / 团队不可用或已到期
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       409:
 *         description: 该密钥已在其他设备激活 / 已达设备数上限
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
export const clientRouter = Router();

clientRouter.post(
  '/activate',
  createRateLimitMiddleware(activateRateLimiter, (req) => `ip:${getClientIp(req) ?? 'unknown'}`),
  ...clientController.activate,
);

/**
 * @swagger
 * /api/client/auth/renew:
 *   post:
 *     tags: [Client]
 *     summary: 无缝续期（P0-A-02 AC2/AC3/AC12）
 *     description: >
 *       客户端在 access token 剩余有效期 ≤ 1/3 时用 refresh token 换取新凭据；
 *       校验 refresh 哈希 → 密钥/团队状态 → 指纹 → 原子轮换；
 *       旧 access jti 进入 60s 宽限期（保护在途请求），宽限期后旧凭据 401；
 *       refresh token 每次续期滑动重置（24h）。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema: { type: string }
 *         description: Bearer <refreshToken>
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *         description: 本机硬件指纹（与激活时一致）
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               oldAccessToken:
 *                 type: string
 *                 description: 旧 access token（可选），续期时撤销其 jti
 *     responses:
 *       200:
 *         description: 续期成功，返回新 access + 新 refresh
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     clientId: { type: string }
 *                     accessToken: { type: string }
 *                     accessTokenExpiresInMs: { type: integer }
 *                     refreshToken: { type: string }
 *                     refreshTokenExpiresInMs: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientRouter.post('/auth/renew', ...clientController.renew);

/**
 * @swagger
 * /api/client/auth/logout:
 *   post:
 *     tags: [Client]
 *     summary: 客户端登出
 *     description: 撤销本机凭据：refresh token 记录删除、access token jti 入撤销名单。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *         description: 本机硬件指纹
 *     responses:
 *       204: { $ref: '#/components/responses/NoContent' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientRouter.post('/auth/logout', requireClientAuth, clientController.logout);

/**
 * @swagger
 * /api/client/me:
 *   get:
 *     tags: [Client]
 *     summary: 当前密钥所属团队信息（T1-06）
 *     description: 返回团队名、状态、到期时刻；时间统一 Asia/Shanghai 标注。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 团队信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     keyId: { type: string }
 *                     team:
 *                       type: object
 *                       properties:
 *                         id: { type: string }
 *                         name: { type: string }
 *                         status: { type: string, enum: ['ACTIVE', 'DISABLED'] }
 *                         expiresAt: { type: string, format: date-time }
 *                     timezone: { type: string, example: 'Asia/Shanghai' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientRouter.get('/me', requireClientAuth, clientController.me);

/**
 * @swagger
 * /api/client/team/usage:
 *   get:
 *     tags: [Client]
 *     summary: 团队级用量汇总（T1-06 / P0-B-10 AC19）
 *     description: >
 *       端口「已占用/配额」与翻译「累计已用/配额总量」，与服务端记录同源；
 *       仅团队汇总数字，不包含其他客服的密钥/账号/分项用量。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 团队用量汇总
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     teamId: { type: string }
 *                     ports:
 *                       type: object
 *                       properties:
 *                         held: { type: integer, example: 0 }
 *                         quota: { type: integer, example: 10 }
 *                     translation:
 *                       type: object
 *                       properties:
 *                         used: { type: integer, example: 0 }
 *                         quota: { type: integer, example: 1500000 }
 *                     timezone: { type: string, example: 'Asia/Shanghai' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientRouter.get('/team/usage', requireClientAuth, clientController.teamUsage);

/**
 * @swagger
 * /api/client/dashboard:
 *   get:
 *     tags: [Client]
 *     summary: 客户端首页仪表板（一次性聚合）
 *     description: >
 *       返回首页所需的全部数据：服务端时间、团队信息（名/状态/到期/剩余天数）、
 *       顶部条团队端口占用、4 张统计卡片（我的账号、团队端口、翻译配额、翻译服务）、
 *       各渠道（Telegram/WhatsApp）的 5 项状态分布（在线/等待扫码/离线占端口/未启动），
 *       同时供侧栏「N/M 在线」角标使用。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 首页仪表板数据
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     serverTime: { type: string, format: date-time }
 *                     timezone: { type: string, example: 'Asia/Shanghai' }
 *                     team:
 *                       type: object
 *                       properties:
 *                         id: { type: string }
 *                         name: { type: string }
 *                         status: { type: string, enum: [ACTIVE, DISABLED] }
 *                         expiresAt: { type: string, format: date-time }
 *                         daysRemaining: { type: integer }
 *                     teamPortHeader:
 *                       type: object
 *                       properties:
 *                         held: { type: integer }
 *                         quota: { type: integer }
 *                     cards:
 *                       type: object
 *                       properties:
 *                         myAccounts:
 *                           type: object
 *                           properties:
 *                             total: { type: integer }
 *                             started: { type: integer }
 *                             portsHeld: { type: integer }
 *                         teamPorts:
 *                           type: object
 *                           properties:
 *                             held: { type: integer }
 *                             quota: { type: integer }
 *                             mine: { type: integer }
 *                             others: { type: integer }
 *                         translation:
 *                           type: object
 *                           properties:
 *                             used: { type: integer }
 *                             quota: { type: integer }
 *                             remaining: { type: integer }
 *                         translationService:
 *                           type: object
 *                           properties:
 *                             status: { type: string, enum: [OK, DEGRADED, OUTAGE] }
 *                             reason: { type: string, nullable: true }
 *                     channels:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           channel: { type: string, enum: [telegram, whatsapp] }
 *                           label: { type: string }
 *                           total: { type: integer }
 *                           online: { type: integer }
 *                           waitingQr: { type: integer }
 *                           offlineHeld: { type: integer }
 *                           notStarted: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientRouter.get('/dashboard', requireClientAuth, clientController.dashboard);
