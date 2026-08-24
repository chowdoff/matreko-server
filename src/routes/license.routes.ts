import { Router } from 'express';
import { AdminRole } from '@prisma/client';
import { licenseController } from '@/controllers/license.controller';
import { requireBackofficeAuth } from '@/middlewares/auth';

/**
 * @swagger
 * /api/supervisor/licenses:
 *   post:
 *     tags: [License]
 *     summary: 生成密钥（P0-B-09 AC1）
 *     description: >
 *       生成 `MTRK-` + 4 组 × 4 位 Base32 格式密钥；
 *       密钥明文仅在本次响应返回一次，库中仅存哈希与前 6 位前缀；
 *       必须指定昵称；可选开启多设备激活（默认关闭）；密钥数量不受配额限制（AC6）。
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateLicenseRequest' }
 *     responses:
 *       201:
 *         description: 生成成功（含仅此一次的密钥明文）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CreateLicenseResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * @swagger
 * /api/supervisor/licenses:
 *   get:
 *     tags: [License]
 *     summary: 密钥列表（P0-B-09 AC2）
 *     description: 本团队全部密钥：状态 / 创建时间 / 多开开关 / 绑定设备列表与各设备激活时间。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 密钥列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     licenses:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/LicenseItem' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export const licenseRouter = Router();

licenseRouter.post('/licenses', requireBackofficeAuth([AdminRole.SUPERVISOR]), ...licenseController.createLicense);
licenseRouter.get('/licenses', requireBackofficeAuth([AdminRole.SUPERVISOR]), licenseController.listLicenses);

/**
 * @swagger
 * /api/supervisor/licenses/stats:
 *   get:
 *     tags: [License]
 *     summary: 密钥统计
 *     description: 返回本团队密钥的总数、已激活数、未激活数、已禁用数。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 密钥统计
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total: { type: integer, example: 10 }
 *                     active: { type: integer, example: 6 }
 *                     unused: { type: integer, example: 3 }
 *                     disabled: { type: integer, example: 1 }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
licenseRouter.get('/licenses/stats', requireBackofficeAuth([AdminRole.SUPERVISOR]), licenseController.licenseStats);

/**
 * @swagger
 * /api/supervisor/licenses/{id}/disable:
 *   post:
 *     tags: [License]
 *     summary: 禁用密钥（P0-B-09 AC3/AC7/AC8）
 *     description: >
 *       密钥不可删除、只能禁用；禁用后不能再用于新激活，已激活客户端在 5 分钟内失效；
 *       正在被使用的密钥须携带 confirm=true 确认影响范围（提交前提示），
 *       否则返回 409 且 details 含影响范围。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: 密钥 ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/DisableLicenseRequest' }
 *     responses:
 *       200:
 *         description: 禁用成功（或已处于禁用态）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     alreadyDisabled: { type: boolean }
 *                     impact:
 *                       type: object
 *                       properties:
 *                         boundDevices: { type: integer }
 *                         onlineClients: { type: integer }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
licenseRouter.post(
  '/licenses/:id/disable',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  ...licenseController.disableLicense,
);

/**
 * @swagger
 * /api/supervisor/licenses/{id}/enable:
 *   post:
 *     tags: [License]
 *     summary: 启用密钥（禁用后可恢复）
 *     description: >
 *       密钥支持禁用/启用：将已禁用密钥恢复为可用。
 *       有绑定设备时恢复为 ACTIVE（设备可重新激活并自动补发新凭据），
 *       无绑定设备时恢复为 UNUSED；已处于可用态的密钥幂等返回。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: 密钥 ID
 *     responses:
 *       200:
 *         description: 启用成功（或已处于可用态）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     alreadyEnabled: { type: boolean }
 *                     status: { type: string, enum: [UNUSED, ACTIVE, DISABLED] }
 *                     boundDevices: { type: integer }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
licenseRouter.post(
  '/licenses/:id/enable',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  licenseController.enableLicense,
);

/**
 * @swagger
 * /api/supervisor/licenses/{id}/multi-device:
 *   post:
 *     tags: [License]
 *     summary: 多开开关（P0-B-09 AC5/AC9/AC10）
 *     description: >
 *       开启多开后最多绑定 5 台设备；
 *       关闭多开时必须指定 keepDeviceBindingId 选择保留哪一台，其余设备自动按解绑流程下线（AC9/AC10）；
 *       并发操作后设备列表已变化时返回 409「状态已变更」（AC12）。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: 密钥 ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/MultiDeviceRequest' }
 *     responses:
 *       200:
 *         description: 多开状态已更新
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     multiDeviceEnabled: { type: boolean }
 *                     deviceLimit: { type: integer }
 *                     keptDevice: { type: string }
 *                     offlineDevices:
 *                       type: array
 *                       items: { type: string }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
licenseRouter.post(
  '/licenses/:id/multi-device',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  ...licenseController.setMultiDevice,
);

/**
 * @swagger
 * /api/supervisor/devices/{id}/unbind:
 *   post:
 *     tags: [License]
 *     summary: 设备解绑（P0-B-09 AC4/AC11）
 *     description: >
 *       删除设备绑定记录与对应凭据，该设备在 5 分钟内退出登录；
 *       解绑次数不受限制；被解绑设备对应的密钥可在新设备重新激活。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: 设备绑定 ID
 *     responses:
 *       200:
 *         description: 解绑成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     unbound: { type: boolean, example: true }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409: { $ref: '#/components/responses/Conflict' }
 */
licenseRouter.post(
  '/devices/:id/unbind',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  licenseController.unbindDevice,
);

/**
 * 主管端"设备管理"页：GET /api/supervisor/devices
 */
licenseRouter.get(
  '/devices',
  requireBackofficeAuth([AdminRole.SUPERVISOR]),
  licenseController.listDevices,
);
