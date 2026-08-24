import { Request, Response, NextFunction } from 'express';
import { prisma } from '@/lib/prisma';
import { activateService } from '@/services/activate.service';
import { renewClientCredential, logoutClientCredential, getKeyStatusWithCache } from '@/services/token.service';
import { getClientDashboard } from '@/services/clientDashboard.service';
import { ApiResponse } from '@/utils/ApiResponse';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { validate } from '@/middlewares/validate';
import { getClientIp } from '@/middlewares/auth';
import { activateSchema, renewSchema } from '@/schemas/client.schema';
import { extractBearerToken } from '@/services/auth.service';

/** 展示层统一标注时区（PRD §2.6：存储 UTC，展示 Asia/Shanghai） */
const TIMEZONE = 'Asia/Shanghai';

export class ClientController {
  /** 客户端激活（P0-A-01 AC1/AC3-AC13/AC16） */
  activate = [
    validate(activateSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await activateService.activate(req.body, getClientIp(req));
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 无缝续期（P0-A-02 AC2/AC3/AC12）：refresh token 换取新 access + 新 refresh */
  renew = [
    validate(renewSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const refreshToken = extractBearerToken(req.headers.authorization);
        if (!refreshToken) {
          throw AppError.unauthorized('缺少 refresh token', ErrorCode.UNAUTHORIZED);
        }
        const fingerprint = req.headers['x-device-fingerprint'];
        if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
          throw AppError.unauthorized('缺少设备指纹', ErrorCode.FINGERPRINT_MISMATCH);
        }
        const result = await renewClientCredential(
          {
            refreshToken,
            fingerprint,
            oldAccessToken: req.body.oldAccessToken,
          },
          getClientIp(req),
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 客户端登出：撤销本机凭据（refresh 删除 + access jti 入撤销名单） */
  logout = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { keyId, clientId, jti } = req.auth!;
      await logoutClientCredential(clientId, keyId, jti, getClientIp(req));
      ApiResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  };

  /** 当前密钥所属团队信息（T1-06，仅团队汇总，不含他人明细） */
  me = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { keyId } = req.auth!;
      const status = await getKeyStatusWithCache(keyId);
      const team = await prisma.team.findUnique({
        where: { id: status!.teamId },
        select: { id: true, name: true, status: true, expiresAt: true },
      });
      ApiResponse.success(res, {
        keyId,
        team: {
          id: team!.id,
          name: team!.name,
          status: team!.status,
          expiresAt: team!.expiresAt.toISOString(),
        },
        timezone: TIMEZONE,
      });
    } catch (err) {
      next(err);
    }
  };

  /** 团队级用量汇总（T1-06 / P0-B-10 AC19）：端口占用 + 翻译用量，与服务端记录同源 */
  teamUsage = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { keyId } = req.auth!;
      const status = await getKeyStatusWithCache(keyId);
      const teamId = status!.teamId;
      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { portQuota: true, translationQuota: true, translationUsed: true },
      });
      const heldPorts = await prisma.portLease.count({
        where: { teamId, status: 'HELD' },
      });
      ApiResponse.success(res, {
        teamId,
        ports: { held: heldPorts, quota: team!.portQuota },
        translation: { used: team!.translationUsed, quota: team!.translationQuota },
        timezone: TIMEZONE,
      });
    } catch (err) {
      next(err);
    }
  };
  /** 客户端首页仪表板（一次性聚合，避免多次请求） */
  dashboard = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { keyId, clientId } = req.auth!;
      const data = await getClientDashboard(keyId, clientId);
      ApiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  };
}

export const clientController = new ClientController();
