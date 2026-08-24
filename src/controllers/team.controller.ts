import { Request, Response, NextFunction } from 'express';
import { teamService } from '@/services/team.service';
import { ApiResponse } from '@/utils/ApiResponse';
import { validate } from '@/middlewares/validate';
import { getClientIp } from '@/middlewares/auth';
import { createTeamSchema, updateTeamQuotaSchema, disableTeamSchema } from '@/schemas/team.schema';

export class TeamController {
  /** 创建团队 + 主管账号（P0-S-11 AC1 / P0-A-19 AC2） */
  createTeam = [
    validate(createTeamSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = req.account!;
        const result = await teamService.createTeam(req.body, account, getClientIp(req));
        ApiResponse.created(res, {
          team: result.team,
          supervisor: {
            id: result.supervisor.id,
            email: result.supervisor.email,
            role: result.supervisor.role,
          },
          initialPassword: result.initialPassword,
        });
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 团队列表（P0-S-11 AC2）：状态/创建时刻/到期时刻/端口占用/翻译用量与配额 */
  listTeams = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const teams = await teamService.listTeams();
      ApiResponse.success(res, teams);
    } catch (err) {
      next(err);
    }
  };

  /** 配额与到期时刻修改（P0-S-11 AC3～AC5/AC10～AC13 / P0-B-10 AC15～AC17） */
  updateQuotas = [
    validate(updateTeamQuotaSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = req.account!;
        const result = await teamService.updateQuotas(String(req.params.id), req.body, account, getClientIp(req));
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 团队禁用（P0-S-11 AC8～AC9） */
  disableTeam = [
    validate(disableTeamSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = req.account!;
        const result = await teamService.disableTeam(String(req.params.id), req.body, account, getClientIp(req));
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 团队启用（P0-B-10 AC17：禁用后恢复启用，用量延续不清零） */
  enableTeam = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = req.account!;
      const result = await teamService.enableTeam(String(req.params.id), account, getClientIp(req));
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };
}

export const teamController = new TeamController();
