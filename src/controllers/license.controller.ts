import { Request, Response, NextFunction } from 'express';
import { licenseService } from '@/services/license.service';
import { supervisorDeviceService } from '@/services/deviceMgmt.service';
import { ApiResponse } from '@/utils/ApiResponse';
import { AppError } from '@/utils/AppError';
import { validate } from '@/middlewares/validate';
import { getClientIp } from '@/middlewares/auth';
import { createLicenseSchema, disableLicenseSchema, setMultiDeviceSchema } from '@/schemas/license.schema';

/** 主管必须归属团队（T2-01 创建主管时已绑定） */
function requireTeamId(req: Request): string {
  if (!req.account?.teamId) {
    throw AppError.forbidden('账号未关联团队', 'TEAM_UNAVAILABLE');
  }
  return req.account.teamId;
}

/** 读取路径参数（Express 5 类型为 string | string[]，统一转 string） */
function paramId(req: Request, name: string): string {
  return String(req.params[name]);
}

export class LicenseController {
  /** 生成密钥（AC1） */
  createLicense = [
    validate(createLicenseSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const teamId = requireTeamId(req);
        const result = await licenseService.createLicense(teamId, req.body, req.account!, getClientIp(req));
        ApiResponse.created(res, {
          licenseKey: result.licenseKey,
          plaintextCode: result.plaintextCode,
        });
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 密钥列表（AC2）—— 含顶部统计卡（总数 / 已激活 / 未激活 / 已禁用） */
  listLicenses = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const teamId = requireTeamId(req);
      const [licenses, topStats] = await Promise.all([
        licenseService.listLicenses(teamId),
        licenseService.getLicenseStats(teamId),
      ]);
      ApiResponse.success(res, { licenses, topStats });
    } catch (err) {
      next(err);
    }
  };

  /** 密钥统计：总数 / 已激活 / 未激活 / 已禁用 */
  licenseStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const teamId = requireTeamId(req);
      const stats = await licenseService.getLicenseStats(teamId);
      ApiResponse.success(res, stats);
    } catch (err) {
      next(err);
    }
  };

  /** 禁用密钥（AC3/AC7/AC8） */
  disableLicense = [
    validate(disableLicenseSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const teamId = requireTeamId(req);
        const result = await licenseService.disableLicense(
          paramId(req, 'id'),
          teamId,
          req.account!,
          req.body,
          getClientIp(req),
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 启用密钥（密钥可禁用/可启用；禁用态密钥激活会被拒绝） */
  enableLicense = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const teamId = requireTeamId(req);
      const result = await licenseService.enableLicense(paramId(req, 'id'), teamId, req.account!, getClientIp(req));
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /** 多开开关（AC5/AC9/AC10） */
  setMultiDevice = [
    validate(setMultiDeviceSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const teamId = requireTeamId(req);
        const result = await licenseService.setMultiDevice(
          paramId(req, 'id'),
          teamId,
          req.account!,
          req.body,
          getClientIp(req),
        );
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 设备解绑（AC4/AC11） */
  unbindDevice = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const teamId = requireTeamId(req);
      const result = await licenseService.unbindDevice(paramId(req, 'id'), teamId, req.account!, getClientIp(req));
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };

  /** 设备列表（主管端"设备管理"页：4 张统计卡 + 明细） */
  listDevices = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const teamId = requireTeamId(req);
      const result = await supervisorDeviceService.listDevices(teamId);
      ApiResponse.success(res, result);
    } catch (err) {
      next(err);
    }
  };
}

export const licenseController = new LicenseController();
