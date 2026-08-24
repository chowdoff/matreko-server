import { Router, type RequestHandler } from 'express';
import { AdminRole } from '@prisma/client';
import { requireClientAuth } from '@/middlewares/clientAuth';
import { requireBackofficeAuth } from '@/middlewares/auth';
import { translationController } from '@/controllers/translation.controller';
import { translationKeyController } from '@/controllers/translationKey.controller';

/**
 * @swagger
 * /api/client/translate:
 *   post:
 *     tags: [Client]
 *     summary: 客户端翻译代理（T4-02 / P0-S-12 / P0-T-07）
 *     description: >
 *       一次翻译一条消息：服务端完成配额检查 → 双层选路（引擎 + Key）→ 调用引擎 →
 *       成功即计量并返回译文；超长消息自动分片合并。返回可区分错误码：
 *       QUOTA_EXHAUSTED / LANGUAGE_UNSUPPORTED / TRANSLATION_SERVICE_UNAVAILABLE /
 *       API_KEY_INVALID / CONTENT_REJECTED。
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
 *           schema:
 *             type: object
 *             required: [text, targetLang]
 *             properties:
 *               text: { type: string, description: 待翻译原文 }
 *               sourceLang: { type: string, description: 源语言（ISO 639-1，可选，不传则引擎自动识别） }
 *               targetLang: { type: string, description: 目标语言（ISO 639-1） }
 *               direction: { type: string, enum: [IN, OUT], description: 翻译方向（仅对账用） }
 *               stableMessageId: { type: string, description: 消息稳定标识（§9.2，幂等双保险） }
 *     responses:
 *       200:
 *         description: 翻译成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     translatedText: { type: string }
 *                     detectedSourceLang: { type: string }
 *                     engine: { type: string, enum: [GOOGLE, DEEPL] }
 *                     chars: { type: integer, description: 原文总字符数（计量口径） }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { $ref: '#/components/responses/Conflict' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 *       503: { $ref: '#/components/responses/BadRequest' }
 */
export const clientTranslateRouter = Router();

clientTranslateRouter.post('/translate', requireClientAuth, ...translationController.translate);

/**
 * @swagger
 * /api/platform/translation-keys:
 *   get:
 *     tags: [TranslationKey]
 *     summary: 翻译 Key 列表（T4-06 / P0-S-12）
 *     description: >
 *       返回各引擎下所有 Key（掩码展示）、状态、实时用量、近 24h 统计，以及引擎聚合与风险提示
 *       （单 Key / 单引擎风险，AC10/AC11）。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Key 列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items: { type: array, items: { type: object } }
 *                     engineAgg: { type: array, items: { type: object } }
 *                     riskHints: { type: array, items: { type: string } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [TranslationKey]
 *     summary: 新增翻译 Key（保存时连通性校验，AC1/AC4）
 *     description: >
 *       保存前用明文 Key 发起一次真实调用；仅 Key 无效（AUTH/QUOTA/CONTENT/PARAM）硬拒且不保存；
 *       网络/引擎侧异常放行并带 connectivityWarning。明文仅用于校验，存储时 AES-256-GCM 加密。
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [engine, name, apiKey]
 *             properties:
 *               engine: { type: string, enum: [GOOGLE, DEEPL] }
 *               name: { type: string, maxLength: 64 }
 *               apiKey: { type: string, description: 明文 API Key（仅本次返回掩码） }
 *               quotaLimit: { type: integer, nullable: true, description: 额度上限（字符），null=不限 }
 *     responses:
 *       201: { $ref: '#/components/responses/BadRequest' }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /api/platform/translation-keys/{id}:
 *   get:
 *     tags: [TranslationKey]
 *     summary: 单个 Key 详情
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   put:
 *     tags: [TranslationKey]
 *     summary: 修改 Key（名称 / 额度上限，AC16）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, maxLength: 64 }
 *               quotaLimit: { type: integer, nullable: true }
 *     responses:
 *       200: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /api/platform/translation-keys/{id}/status:
 *   post:
 *     tags: [TranslationKey]
 *     summary: 停用 / 启用 Key（无删除，AC14）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [ACTIVE, DISABLED] }
 *     responses:
 *       200: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /api/platform/translation-keys/{id}/usage:
 *   get:
 *     tags: [TranslationKey]
 *     summary: 单个 Key 近 24h 用量（T4-07 AC13）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /api/platform/engines/languages:
 *   get:
 *     tags: [TranslationKey]
 *     summary: 引擎语种支持列表（T4-04）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   post:
 *     tags: [TranslationKey]
 *     summary: 手动维护语种支持状态（P0-S-12 AC12）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [engine, languageCode, status]
 *             properties:
 *               engine: { type: string, enum: [GOOGLE, DEEPL] }
 *               languageCode: { type: string, description: ISO 639-1 }
 *               status: { type: string, enum: [SUPPORTED, UNSUPPORTED] }
 *     responses:
 *       200: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
export const translationKeyRouter = Router();

// 平台管理员专属（翻译引擎与 Key 是唯一由管理后台持有的界面，P0-S-12）
translationKeyRouter.get('/translation-keys', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.listKeys);
translationKeyRouter.post('/translation-keys', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.createKey as RequestHandler);
translationKeyRouter.get('/translation-keys/:id', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.getKey);
translationKeyRouter.put('/translation-keys/:id', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.updateKey as RequestHandler);
translationKeyRouter.post('/translation-keys/:id/status', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.setStatus as RequestHandler);
translationKeyRouter.get('/translation-keys/:id/usage', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.getUsage);
translationKeyRouter.get('/engines/languages', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.listLanguages);
translationKeyRouter.post('/engines/languages', requireBackofficeAuth([AdminRole.PLATFORM]), translationKeyController.setLanguage as RequestHandler);
