import { Router } from 'express';
import { AdminRole } from '@prisma/client';
import { monitoringController } from '@/controllers/monitoring.controller';
import { requireBackofficeAuth } from '@/middlewares/auth';

/**
 * @swagger
 * /api/platform/monitoring/overview:
 *   get:
 *     tags: [Monitoring]
 *     summary: 平台运行监控 overview（P1-S-17 AC1）
 *     description: >
 *       顶部 4 张统计卡片（启用中团队 / 在线渠道账号 / 端口占用-总配额 / 翻译成功率） +
 *       各团队运行状态 + 翻译失败原因分布（近 24h，全平台）。
 *       失败原因分布按 PRD §4.4 / backend §7.4 枚举（接口超时 / 5xx / 429 / 语种不支持 / 内容被拒 / Key 无效）。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: overview 数据
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
export const platformMonitoringRouter = Router();

platformMonitoringRouter.get(
  '/monitoring/overview',
  requireBackofficeAuth([AdminRole.PLATFORM]),
  monitoringController.getOverview,
);
