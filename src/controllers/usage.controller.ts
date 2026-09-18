import { Request, Response, NextFunction } from 'express';
import { usageService } from '@/services/usage.service';
import { channelAccountService } from '@/services/channelAccount.service';
import { ApiResponse } from '@/utils/ApiResponse';

/** 时区标注 */
const TIMEZONE = 'Asia/Shanghai';

/**
 * 用量查询控制器（T5-04 / P0-B-10 AC1~AC5 / P1-B-16）
 *
 * - 主管侧（team-scoped）：只能看本团队数据
 * - 管理员侧（全平台）：可看全部团队（此控制器仅主管侧；管理员侧通过 team.service.listTeams 覆盖）
 */
export class UsageController {
  /**
   * IM 账号列表（P0-B-10 AC1）：本团队所有密钥下**已添加的**渠道账号及状态。
   * GET /api/supervisor/accounts
   *
   * 数据源为 `channel_accounts` 登记表（主）+ 当前 HELD 租约（运行态），
   * 因此「已添加但从未启动」的账号也会出现，状态为 NOT_STARTED。
   */
  imAccounts = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = req.account!;
      const teamId = account.teamId!;
      const result = await channelAccountService.listTeamAccounts(teamId);
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * 翻译用量汇总（P0-B-10 AC4/AC8 / P1-B-16）：
   * 团队级用量 + 按密钥分布 + 按引擎 Key 分布 + 近 24h 统计。
   * GET /api/supervisor/translation-usage
   */
  translationUsage = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = req.account!;
      const teamId = account.teamId!;
      const result = await usageService.getTranslationUsage(teamId);
      if (!result) {
        ApiResponse.success(res, {
          team: null,
          message: '团队不存在',
          timezone: TIMEZONE,
        });
        return;
      }
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };
}

export const usageController = new UsageController();
