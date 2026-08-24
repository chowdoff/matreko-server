import { Router } from 'express';
import { AdminRole } from '@prisma/client';
import { portController } from '@/controllers/port.controller';
import { requireClientAuth } from '@/middlewares/clientAuth';
import { requireBackofficeAuth } from '@/middlewares/auth';

// ── 客户端侧端口接口（P0-C-20 AC1~AC12） ──

/**
 * @swagger
 * /api/client/ports/acquire:
 *   post:
 *     tags: [Port]
 *     summary: 端口申请（P0-C-20 AC1/AC10）
 *     description: >
 *       客户端启动账号前向服务端申请端口；
 *       事务内校验团队 HELD 数 < 端口配额，防超卖；
 *       同 (clientId, channelAccountKey) 已有 HELD → 幂等返回已有 lease；
 *       端口用尽返回 409 PORT_EXHAUSTED。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AcquirePortRequest' }
 *     responses:
 *       200:
 *         description: 申请成功（或已持有，幂等）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AcquirePortResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
export const clientPortRouter = Router();

clientPortRouter.post('/ports/acquire', requireClientAuth, ...portController.acquire);

/**
 * @swagger
 * /api/client/ports/heartbeat:
 *   post:
 *     tags: [Port]
 *     summary: 心跳协议（P0-C-20 AC2/AC8/AC12）
 *     description: >
 *       客户端每 2min 上报本机持有的全部 leaseId；
 *       服务端刷新 lastSeenAt，比对记录返回已撤销的 lease（已回收/已撤销）；
 *       配额下调导致 held > quota 时返回 overQuota 与 pendingCloseLeaseIds。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/HeartbeatRequest' }
 *     responses:
 *       200:
 *         description: 心跳成功
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HeartbeatResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientPortRouter.post('/ports/heartbeat', requireClientAuth, ...portController.heartbeat);

/**
 * @swagger
 * /api/client/ports/release:
 *   post:
 *     tags: [Port]
 *     summary: 端口释放（P0-C-20 AC3）
 *     description: 客户端主动停止账号时调用，单个释放置 RELEASED，团队可用端口实时 +1。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ReleasePortRequest' }
 *     responses:
 *       200:
 *         description: 释放成功（或已释放，幂等）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ReleasePortResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientPortRouter.post('/ports/release', requireClientAuth, ...portController.release);

/**
 * @swagger
 * /api/client/ports/reset:
 *   post:
 *     tags: [Port]
 *     summary: 端口归零（P0-C-20 AC4/AC7）
 *     description: >
 *       客户端启动/强杀重启时调用，释放本机全部 HELD 占用，不等 24h 超时（AC7）；
 *       服务端立即回收。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Device-Fingerprint
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 归零成功
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ResetPortsResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientPortRouter.post('/ports/reset', requireClientAuth, portController.reset);

// ── 主管侧端口管理接口 ──

/**
 * @swagger
 * /api/supervisor/ports:
 *   get:
 *     tags: [Port]
 *     summary: 端口占用列表（主管侧，P0-B-10 AC2）
 *     description: 本团队所有 HELD 端口租约：所属密钥/渠道账号/占用时间/最后心跳时间。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 占用列表
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PortLeaseListResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * @swagger
 * /api/supervisor/ports/{leaseId}/release:
 *   post:
 *     tags: [Port]
 *     summary: 手动释放端口（主管侧，P0-C-20 AC11）
 *     description: >
 *       主管手动释放卡死的端口，立即回收；
 *       首次调用（未 confirm）返回提示，确认后重试。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: leaseId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ManualReleaseRequest' }
 *     responses:
 *       200:
 *         description: 释放成功（或已释放）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ManualReleaseResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
export const supervisorPortRouter = Router();

supervisorPortRouter.get(
  '/ports',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  portController.listLeases,
);
supervisorPortRouter.get(
  '/ports/dashboard',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  portController.getTeamDashboard,
);
supervisorPortRouter.post(
  '/ports/:leaseId/release',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  ...portController.manualRelease,
);

// ── 管理员侧端口管理接口 ──

/**
 * @swagger
 * /api/platform/ports:
 *   get:
 *     tags: [Port]
 *     summary: 端口占用列表（管理员侧，全平台）
 *     description: 全平台所有 HELD 端口租约：所属团队/密钥/渠道账号/占用时间/最后心跳时间。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 占用列表
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PortLeaseListResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * @swagger
 * /api/platform/ports/{leaseId}/release:
 *   post:
 *     tags: [Port]
 *     summary: 手动释放端口（管理员侧，P0-C-20 AC11）
 *     description: 管理员可释放任意团队的卡死端口，首次调用（未 confirm）返回提示。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: leaseId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ManualReleaseRequest' }
 *     responses:
 *       200:
 *         description: 释放成功（或已释放）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ManualReleaseResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
export const platformPortRouter = Router();

platformPortRouter.get(
  '/ports',
  requireBackofficeAuth([AdminRole.PLATFORM]),
  portController.listLeases,
);
/**
 * @swagger
 * /api/platform/ports/dashboard:
 *   get:
 *     tags: [Port]
 *     summary: 端口管理 dashboard（P0-C-20 AC11）
 *     description: >
 *       顶部 4 张统计卡片 + 按团队汇总 + 端口占用明细。
 *       支持 ?teamId=xxx 筛选特定团队，不传则查看全平台。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: teamId
 *         in: query
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200: { description: dashboard 数据 }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
platformPortRouter.get(
  '/ports/dashboard',
  requireBackofficeAuth([AdminRole.PLATFORM]),
  portController.getDashboard,
);
platformPortRouter.post(
  '/ports/:leaseId/release',
  requireBackofficeAuth([AdminRole.PLATFORM]),
  ...portController.manualRelease,
);
