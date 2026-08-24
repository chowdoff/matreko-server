import { Router } from 'express';
import { AdminRole } from '@prisma/client';
import { usageController } from '@/controllers/usage.controller';
import { requireBackofficeAuth } from '@/middlewares/auth';

/**
 * 主管侧用量查询路由（T5-04 / P0-B-10）
 *
 * - GET /api/supervisor/accounts — IM 账号列表（P0-B-10 AC1）
 * - GET /api/supervisor/translation-usage — 翻译用量汇总 + 按密钥分布（P0-B-10 AC4/AC8 / P1-B-16）
 *
 * 注：端口用量 GET /api/supervisor/ports 已在 port.routes.ts 实现（T3-05/T5-04 共用）。
 */
export const supervisorUsageRouter = Router();

/**
 * @swagger
 * /api/supervisor/accounts:
 *   get:
 *     tags: [Usage]
 *     summary: IM 账号列表（P0-B-10 AC1）
 *     description: 本团队所有密钥下已添加的渠道账号及渠道、状态、所属密钥；空态展示。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 账号列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           leaseId: { type: string }
 *                           channel: { type: string, description: "telegram/whatsapp" }
 *                           accountId: { type: string }
 *                           channelAccountKey: { type: string }
 *                           status: { type: string, enum: [HELD, RELEASED] }
 *                           online: { type: boolean }
 *                           keyId: { type: string }
 *                           keyNickname: { type: string }
 *                           acquiredAt: { type: string, format: date-time }
 *                           lastSeenAt: { type: string, format: date-time }
 *                           releasedAt: { type: string, format: date-time, nullable: true }
 *                     summary:
 *                       type: object
 *                       properties:
 *                         online: { type: integer }
 *                         offline: { type: integer }
 *                         total: { type: integer }
 *                     timezone: { type: string }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
supervisorUsageRouter.get(
  '/accounts',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  usageController.imAccounts,
);

/**
 * @swagger
 * /api/supervisor/translation-usage:
 *   get:
 *     tags: [Usage]
 *     summary: 翻译用量汇总（P0-B-10 AC4/AC8 / P1-B-16）
 *     description: >
 *       团队级翻译用量（累计已用/配额/剩余/是否耗尽）+ 按密钥分布 + 按引擎 Key 分布 + 近 24h 统计；
 *       已耗尽时展示阻断说明。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 用量汇总
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     team:
 *                       type: object
 *                       properties:
 *                         id: { type: string }
 *                         name: { type: string }
 *                         translationUsed: { type: integer }
 *                         translationQuota: { type: integer }
 *                         remaining: { type: integer }
 *                         isExhausted: { type: boolean }
 *                     usage24h:
 *                       type: object
 *                       properties:
 *                         calls: { type: integer }
 *                         chars: { type: integer }
 *                     perLicenseKey:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           keyId: { type: string }
 *                           keyNickname: { type: string }
 *                           chars: { type: integer }
 *                           calls: { type: integer }
 *                     perEngineKey:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           engine: { type: string }
 *                           name: { type: string }
 *                           status: { type: string }
 *                           quotaLimit: { type: integer, nullable: true }
 *                           quotaUsed: { type: integer }
 *                           remaining: { type: integer, nullable: true }
 *                           usage24h:
 *                             type: object
 *                             properties:
 *                               calls: { type: integer }
 *                               chars: { type: integer }
 *                     timezone: { type: string }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
supervisorUsageRouter.get(
  '/translation-usage',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  usageController.translationUsage,
);
