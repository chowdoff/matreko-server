import { Request, Response, NextFunction } from 'express';
import { channelAccountService } from '@/services/channelAccount.service';
import { getKeyStatusWithCache } from '@/services/token.service';
import { ApiResponse } from '@/utils/ApiResponse';
import { validate } from '@/middlewares/validate';
import { syncChannelAccountsSchema } from '@/schemas/channelAccount.schema';

/** 客户端侧渠道账号登记控制器（P0-C-03 AC1 / P0-C-18 AC1/AC15） */
export class ClientAccountController {
  /** 渠道账号全量对账：客户端本地库 → 服务端登记表（投影同步） */
  sync = [
    validate(syncChannelAccountsSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { keyId, clientId } = req.auth!;
        const status = await getKeyStatusWithCache(keyId);
        const teamId = status!.teamId;
        const result = await channelAccountService.syncAccounts(
          teamId,
          keyId,
          clientId,
          req.body.accounts,
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];
}

export const clientAccountController = new ClientAccountController();
