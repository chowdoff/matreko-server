import { Request, Response, NextFunction } from 'express';
import { portService } from '@/services/port.service';
import { getKeyStatusWithCache } from '@/services/token.service';
import { ApiResponse } from '@/utils/ApiResponse';
import { validate } from '@/middlewares/validate';
import { getClientIp } from '@/middlewares/auth';
import {
  acquirePortSchema,
  heartbeatSchema,
  releasePortSchema,
  manualReleaseSchema,
} from '@/schemas/port.schema';

/** 客户端侧端口控制器（P0-C-20） */
export class PortController {
  /** 端口申请（P0-C-20 AC1/AC10） */
  acquire = [
    validate(acquirePortSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { keyId, clientId } = req.auth!;
        const status = await getKeyStatusWithCache(keyId);
        const teamId = status!.teamId;
        const result = await portService.acquire(
          teamId,
          keyId,
          clientId,
          req.body.channelAccountKey,
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 心跳协议（P0-C-20 AC2/AC8/AC12） */
  heartbeat = [
    validate(heartbeatSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { keyId, clientId } = req.auth!;
        const status = await getKeyStatusWithCache(keyId);
        const teamId = status!.teamId;
        const result = await portService.heartbeat(teamId, clientId, req.body.leaseIds);
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 端口释放（P0-C-20 AC3） */
  release = [
    validate(releasePortSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { clientId } = req.auth!;
        const result = await portService.release(clientId, req.body.leaseId);
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 端口归零（P0-C-20 AC4/AC7） */
  reset = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientId } = req.auth!;
      const result = await portService.reset(clientId);
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /** 后台手动释放（P0-C-20 AC11）— 主管/管理员共用 */
  manualRelease = [
    validate(manualReleaseSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = req.account!;
        const actor = { id: account.id, role: account.role };
        // 主管只能操作本团队，管理员可操作任意团队
        const teamScope = account.role === 'SUPERVISOR' ? account.teamId! : null;
        const result = await portService.manualRelease(
          String(req.params.leaseId),
          actor,
          teamScope,
          req.body,
          getClientIp(req),
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 后台端口占用列表 — 主管看本团队，管理员看全平台 */
  listLeases = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = req.account!;
      const teamScope = account.role === 'SUPERVISOR' ? account.teamId! : null;
      const leases = await portService.listLeases(teamScope);
      ApiResponse.success(res, leases);
    } catch (err) {
      next(err);
    }
  };

  /**
   * 端口管理 dashboard（P0-C-20 AC11 / T3-05）：
   * 返回顶部 4 张统计卡片 + 按团队汇总 + 端口占用明细。
   * 管理员可按 ?teamId=xxx 筛选特定团队。
   */
  getDashboard = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = req.account!;
      const teamScope =
        account.role === 'SUPERVISOR'
          ? account.teamId!
          : typeof req.query.teamId === 'string'
            ? req.query.teamId
            : null;
      const data = await portService.getDashboard(teamScope);
      ApiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  };

  /**
   * 主管团队端口管理 dashboard（主管端"端口管理"页 4 张统计卡 + 端口占用明细）。
   */
  getTeamDashboard = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = req.account!;
      if (!account.teamId) {
        return ApiResponse.success(res, { error: '账号未关联团队' });
      }
      const data = await portService.getTeamDashboard(account.teamId);
      ApiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  };
}

export const portController = new PortController();
