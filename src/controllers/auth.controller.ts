import { Request, Response, NextFunction } from 'express';
import { AdminRole } from '@prisma/client';
import { authService } from '@/services/auth.service';
import { ApiResponse } from '@/utils/ApiResponse';
import { AppError } from '@/utils/AppError';
import { validate } from '@/middlewares/validate';
import { getClientIp } from '@/middlewares/auth';
import {
  loginSchema,
  changePasswordSchema,
  resetPasswordSchema,
  disableAccountSchema,
} from '@/schemas/auth.schema';

export class AuthController {
  /**
   * 后台登录（P0-A-19 AC3/AC6-AC9/AC11/AC12）
   * 由路由按前缀传入 role（supervisor / platform）
   */
  login(role: AdminRole) {
    return [
      validate(loginSchema),
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { email, password } = req.body;
          const result = await authService.login(role, email, password, getClientIp(req));
          ApiResponse.success(res, result);
        } catch (err) {
          next(err);
        }
      },
    ];
  }

  /** 登出（AC4） */
  logout = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.session!.id;
      const account = req.account!;
      await authService.logout(sessionId, account, getClientIp(req));
      ApiResponse.noContent(res);
    } catch (err) {
      next(err);
    }
  };

  /** 修改密码（AC5/AC10） */
  changePassword = [
    validate(changePasswordSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = req.account!;
        const sessionId = req.session!.id;
        const { oldPassword, newPassword } = req.body;

        // 密码强度校验（AC10）
        const weakReason = authService.validatePasswordStrength(newPassword);
        if (weakReason) throw AppError.badRequest(weakReason);

        await authService.changePassword(account, sessionId, oldPassword, newPassword, getClientIp(req));
        ApiResponse.noContent(res);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 管理员重置主管密码（AC13）：后端随机生成，仅此一次返回 */
  resetPassword = [
    validate(resetPasswordSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { accountId } = req.body;
        const result = await authService.resetPassword(accountId, req.account!, getClientIp(req));
        ApiResponse.success(res, result);
      } catch (err) {
        next(err);
      }
    },
  ];

  /** 禁用后台账号（AC14/AC15） */
  disableAccount = [
    validate(disableAccountSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await authService.disableAccount(req.body.accountId, req.account!, getClientIp(req));
        ApiResponse.noContent(res);
      } catch (err) {
        next(err);
      }
    },
  ];
}

export const authController = new AuthController();
