import { Request, Response, NextFunction } from 'express';
import { ApiResponse } from '@/utils/ApiResponse';
import { translationService } from '@/services/translation/translation.service';
import { getKeyStatusWithCache } from '@/services/token.service';
import { validate } from '@/middlewares/validate';
import { translateSchema } from '@/schemas/translate.schema';

export class TranslationController {
  /** 客户端翻译代理（T4-02 / P0-T-07 AC10/AC13 / P0-S-12 AC3/7/8/9/12） */
  translate = [
    validate(translateSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { keyId } = req.auth!;
        const status = await getKeyStatusWithCache(keyId);
        const result = await translationService.translate({
          ...req.body,
          teamId: status!.teamId,
          clientKeyId: keyId,
        });
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];
}

export const translationController = new TranslationController();
