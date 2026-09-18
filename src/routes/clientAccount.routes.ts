import { Router } from 'express';
import { clientAccountController } from '@/controllers/clientAccount.controller';
import { requireClientAuth } from '@/middlewares/clientAuth';

/**
 * 客户端侧渠道账号登记路由（P0-C-03 AC1 / P0-C-18 AC1/AC15）
 *
 * - PUT /api/client/accounts — 全量对账（客户端本地账号快照 → 服务端登记表）
 */
export const clientAccountRouter = Router();

/**
 * @swagger
 * /api/client/accounts:
 *   put:
 *     tags: [Account]
 *     summary: 渠道账号全量对账（P0-C-03 AC1 / P0-C-18 AC1/AC15）
 *     description: >
 *       客户端上报本机**全部未删除**账号构成的完整快照，服务端做全量对账：
 *       快照内 upsert（软删记录复位）、快照外未删除账号置软删；字段无变化则不写库。
 *       传空数组表示本机已无账号（全部软删）。
 *       只登记存在性元数据（渠道 / 别名 / 归属）—— 代理、指纹、数据目录不上报（P0-C-18 AC18）。
 *       天然幂等：重复提交同一快照返回 created=0 / updated=0 / deleted=0。
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
 *           schema: { $ref: '#/components/schemas/SyncChannelAccountsRequest' }
 *     responses:
 *       200:
 *         description: 对账结果（含当前账号列表与状态）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SyncChannelAccountsResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
clientAccountRouter.put('/accounts', requireClientAuth, ...clientAccountController.sync);
