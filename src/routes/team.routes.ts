import { Router } from 'express';
import { AdminRole } from '@prisma/client';
import { teamController } from '@/controllers/team.controller';
import { requireBackofficeAuth } from '@/middlewares/auth';

/**
 * @swagger
 * /api/platform/teams:
 *   post:
 *     tags: [Team]
 *     summary: 创建团队（P0-S-11 AC1 / P0-A-19 AC2）
 *     description: >
 *       事务内同时创建团队与唯一主管账号，主管初始密码仅在本次响应返回一次；
 *       配置到期时刻（日期+时分秒）、端口配额、翻译配额（默认 150 万字符）；
 *       任一子操作失败整体回滚。
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateTeamRequest' }
 *     responses:
 *       201:
 *         description: 创建成功（含仅此一次的主管初始密码）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CreateTeamResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *
 *   get:
 *     tags: [Team]
 *     summary: 团队列表（P0-S-11 AC2）
 *     description: >
 *       展示各团队启用状态、创建时刻、到期时刻、端口占用、累计翻译用量与配额总量；
 *       时间统一按 Asia/Shanghai 渲染。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 团队列表
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/TeamListResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /api/platform/teams/{id}/quotas:
 *   put:
 *     tags: [Team]
 *     summary: 修改配额与到期时刻（P0-S-11 AC3～AC5/AC10～AC13）
 *     description: >
 *       修改端口配额 / 翻译配额 / 到期时刻；所有字段可选，仅传需修改项；
 *       创建时刻不可修改（AC12）；配额非负整数（AC13）；
 *       改到过去 = 立即到期，需 confirm=true（AC11）；
 *       修改后 ≤1min 生效（AC3）；延长到期只改 expiresAt（AC4）；
 *       改到未来恢复可用且用量延续（AC5）。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateTeamQuotaRequest' }
 *     responses:
 *       200:
 *         description: 修改成功
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UpdateTeamQuotaResponse' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *
 * /api/platform/teams/{id}/disable:
 *   post:
 *     tags: [Team]
 *     summary: 禁用团队（P0-S-11 AC8～AC9）
 *     description: >
 *       禁用后全团队凭据在 5 分钟内失效、主管无法登录；
 *       无删除能力，数据保留可查；
 *       首次调用（未 confirm）返回影响范围提示，确认后重试。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/DisableTeamRequest' }
 *     responses:
 *       200:
 *         description: 禁用成功（或已禁用）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/DisableTeamResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *
 * /api/platform/teams/{id}/enable:
 *   post:
 *     tags: [Team]
 *     summary: 启用团队（P0-B-10 AC17）
 *     description: >
 *       将已禁用团队恢复为启用态：主管可重新登录、密钥与凭据恢复可用；
 *       累计用量延续原值继续累加，不清零、不重置；
 *       若到期时刻已过，团队仍按到期处理（需另行修改到期时刻到未来，AC5）；
 *       已启用团队幂等返回 alreadyEnabled=true。
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 启用成功（或已启用）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/EnableTeamResponse' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
export const teamRouter = Router();

teamRouter.post('/teams', requireBackofficeAuth([AdminRole.PLATFORM]), ...teamController.createTeam);
teamRouter.get('/teams', requireBackofficeAuth([AdminRole.PLATFORM]), teamController.listTeams);
teamRouter.put('/teams/:id/quotas', requireBackofficeAuth([AdminRole.PLATFORM]), ...teamController.updateQuotas);
teamRouter.post('/teams/:id/disable', requireBackofficeAuth([AdminRole.PLATFORM]), ...teamController.disableTeam);
teamRouter.post('/teams/:id/enable', requireBackofficeAuth([AdminRole.PLATFORM]), teamController.enableTeam);
