import { Request, Response, NextFunction } from 'express';
import { ApiResponse } from '@/utils/ApiResponse';
import { translationKeyService } from '@/services/translation/translationKey.service';
import { validate } from '@/middlewares/validate';
import {
  createTranslationKeySchema,
  updateTranslationKeySchema,
  setKeyStatusSchema,
  setLanguageSupportSchema,
} from '@/schemas/translate.schema';
import { AdminAccount, TranslationKeyStatus } from '@prisma/client';

export class TranslationKeyController {
  /** Key 列表 + 引擎聚合 + 风险提示 + 顶部统计（T4-06 AC2/AC10/AC11/AC13/AC16 / 管理后台 §3.4） */
  listKeys = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = typeof req.query.status === 'string' ? (req.query.status as TranslationKeyStatus) : undefined;
      const result = await translationKeyService.listTranslationKeys(
        status ? { status } : undefined,
      );
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /** 新增 Key（保存时连通性校验；失败不保存，AC4） */
  createKey = [
    validate(createTranslationKeySchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req.account as AdminAccount;
        const result = await translationKeyService.createTranslationKey(req.body, actor, req.ip);
        ApiResponse.success(res, result, 201);
      } catch (err) {
        next(err);
      }
    },
  ] as unknown as (req: Request, res: Response, next: NextFunction) => void;

  /** 单个 Key 详情 */
  getKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await translationKeyService.getTranslationKey(req.params.id as string);
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /** 修改 Key（名称 / 额度上限） */
  updateKey = [
    validate(updateTranslationKeySchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req.account as AdminAccount;
        const result = await translationKeyService.updateTranslationKey(req.params.id as string, req.body, actor, req.ip);
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ] as unknown as (req: Request, res: Response, next: NextFunction) => void;

  /** 停用 / 启用 Key（无删除，AC14） */
  setStatus = [
    validate(setKeyStatusSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req.account as AdminAccount;
        const result = await translationKeyService.setKeyStatus(
          req.params.id as string,
          req.body.status as TranslationKeyStatus,
          actor,
          req.ip,
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ] as unknown as (req: Request, res: Response, next: NextFunction) => void;

  /** 单个 Key 近 24h 用量（T4-07 AC13） */
  getUsage = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await translationKeyService.getKeyUsage(req.params.id as string);
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /** 语种支持列表（T4-04 维护页） */
  listLanguages = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await translationKeyService.listLanguageSupport();
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /** 手动维护语种支持状态（T4-04 / P0-S-12 AC12） */
  setLanguage = [
    validate(setLanguageSupportSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req.account as AdminAccount;
        const result = await translationKeyService.setLanguageSupportStatus(
          req.body.engine,
          req.body.languageCode,
          req.body.status,
          actor,
          req.ip,
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ] as unknown as (req: Request, res: Response, next: NextFunction) => void;
}

export const translationKeyController = new TranslationKeyController();
