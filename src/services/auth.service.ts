import { AdminRole, AdminAccount, Team } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { hashPassword, sha256, generateSecret, verifyPassword, generateInitialPassword } from '@/lib/crypto';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { writeAuditLog, AuditAction } from '@/services/audit.service';

type AdminWithTeam = AdminAccount & { team?: Team | null };

function actorTypeOf(role: AdminRole) {
  return role === AdminRole.PLATFORM ? 'PLATFORM' : 'SUPERVISOR';
}

/** 从 Authorization: Bearer <token> 提取 token */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1] : null;
}

export class AuthService {
  /**
   * 部署初始化（P0-A-19 AC1）：
   * 服务启动时若不存在 PLATFORM 账号，用 PLATFORM_EMAIL / PLATFORM_INITIAL_PASSWORD 创建。
   * 系统不提供新增管理员入口。
   */
  async ensurePlatformAdmin(): Promise<void> {
    const existing = await prisma.adminAccount.findFirst({
      where: { role: AdminRole.PLATFORM },
    });
    if (existing) return;

    const passwordHash = await hashPassword(env.platformInitialPassword);
    await prisma.adminAccount.create({
      data: {
        role: AdminRole.PLATFORM,
        email: env.platformEmail,
        passwordHash,
      },
    });
    await writeAuditLog({
      actorType: 'SYSTEM',
      actorId: 'system',
      action: AuditAction.LOGIN_SUCCESS,
      detail: { event: 'platform_admin_initialized', email: env.platformEmail },
    });
    console.log(`[init] 平台管理员已初始化: ${env.platformEmail}`);
  }

  /**
   * 后台登录（P0-A-19 AC3/AC6-AC9/AC11/AC12）
   * 统一失败提示「邮箱或密码错误」防枚举（AC6）
   */
  async login(role: AdminRole, email: string, password: string, ip?: string) {
    const account = await prisma.adminAccount.findUnique({
      where: { email },
      include: { team: true },
    });

    const invalidErr = () =>
      AppError.unauthorized('邮箱或密码错误', ErrorCode.EMAIL_OR_PASSWORD_INVALID);

    // 角色不匹配也统一错误，避免暴露账号存在性
    if (!account || account.role !== role) throw invalidErr();

    const now = Date.now();

    // 锁定检查（AC7/AC8：锁定期内重试不延长锁定）
    if (account.lockedUntil && account.lockedUntil.getTime() > now) {
      throw AppError.locked(
        '账号已锁定，请稍后重试',
        account.lockedUntil.getTime() - now,
      );
    }
    // 锁定期满，清零（AC8）
    if (account.lockedUntil && account.lockedUntil.getTime() <= now) {
      await prisma.adminAccount.update({
        where: { id: account.id },
        data: { lockedUntil: null, failedLoginCount: 0 },
      });
    }

    const ok = await verifyPassword(password, account.passwordHash);
    if (!ok) {
      const newCount = account.failedLoginCount + 1;
      // 连续失败达到阈值 → 锁定（AC7）
      if (newCount >= env.loginLockThreshold) {
        const lockedUntil = new Date(now + env.loginLockMs);
        await prisma.adminAccount.update({
          where: { id: account.id },
          data: { failedLoginCount: newCount, lockedUntil },
        });
        await writeAuditLog({
          actorType: actorTypeOf(role),
          actorId: account.id,
          action: AuditAction.LOGIN_LOCKED,
          detail: { email, failedLoginCount: newCount },
          ip,
        });
        throw AppError.locked('连续失败次数过多，账号已锁定', env.loginLockMs);
      }
      await prisma.adminAccount.update({
        where: { id: account.id },
        data: { failedLoginCount: newCount },
      });
      await writeAuditLog({
        actorType: actorTypeOf(role),
        actorId: account.id,
        action: AuditAction.LOGIN_FAILED,
        detail: { email, failedLoginCount: newCount },
        ip,
      });
      throw invalidErr();
    }

    // 账号禁用（AC11）
    if (account.status === 'DISABLED') {
      throw AppError.forbidden('账号不可用，请联系管理员', ErrorCode.ACCOUNT_DISABLED);
    }

    // 团队状态（AC12）
    this.assertTeamAvailable(account);

    // 成功：清零失败计数（AC9）并签发会话
    await prisma.adminAccount.update({
      where: { id: account.id },
      data: { failedLoginCount: 0 },
    });

    const token = generateSecret();
    const tokenHash = sha256(token);
    await prisma.backofficeSession.create({
      data: {
        accountId: account.id,
        tokenHash,
        expiresAt: new Date(now + env.backofficeSessionTtlMs),
      },
    });

    await writeAuditLog({
      actorType: actorTypeOf(role),
      actorId: account.id,
      action: AuditAction.LOGIN_SUCCESS,
      detail: { email },
      ip,
    });

    return {
      token,
      expiresAt: new Date(now + env.backofficeSessionTtlMs),
      account: {
        id: account.id,
        email: account.email,
        role: account.role,
        teamId: account.teamId,
      },
    };
  }

  /** 团队状态断言：主管所属团队被禁用或到期 → 拒绝（P0-A-19 AC12） */
  private assertTeamAvailable(account: AdminWithTeam): void {
    if (account.role !== AdminRole.SUPERVISOR) return;
    if (!account.team) {
      throw AppError.forbidden('账号未关联团队，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
    }
    if (account.team.status === 'DISABLED') {
      throw AppError.forbidden('团队已不可用，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
    }
    if (account.team.expiresAt.getTime() <= Date.now()) {
      throw AppError.forbidden('团队已到期，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
    }
  }

  /** 登出（AC4）：revokedAt 置位，会话立即失效 */
  async logout(sessionId: string, account: AdminAccount, ip?: string) {
    await prisma.backofficeSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await writeAuditLog({
      actorType: actorTypeOf(account.role),
      actorId: account.id,
      action: AuditAction.LOGOUT,
      ip,
    });
  }

  /**
   * 修改密码（AC5/AC10）：
   * 成功后其余已登录会话全部失效、当前会话保留。
   */
  async changePassword(
    account: AdminAccount,
    sessionId: string,
    oldPassword: string,
    newPassword: string,
    ip?: string,
  ) {
    const ok = await verifyPassword(oldPassword, account.passwordHash);
    if (!ok) throw AppError.badRequest('原密码不正确');

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.adminAccount.update({
        where: { id: account.id },
        data: { passwordHash },
      });
      // 使其余会话失效（当前会话保留）
      await tx.backofficeSession.updateMany({
        where: { accountId: account.id, revokedAt: null, id: { not: sessionId } },
        data: { revokedAt: new Date() },
      });
    });

    await writeAuditLog({
      actorType: actorTypeOf(account.role),
      actorId: account.id,
      action: AuditAction.PASSWORD_CHANGED,
      ip,
    });
  }

  /** 管理员重置主管密码（AC13）：密码由后端随机生成，该主管全部会话立即失效 */
  async resetPassword(
    accountId: string,
    actor: AdminAccount,
    ip?: string,
  ): Promise<{ temporaryPassword: string }> {
    const target = await prisma.adminAccount.findUnique({ where: { id: accountId } });
    if (!target) throw AppError.notFound('账号不存在');
    if (target.role !== AdminRole.SUPERVISOR) {
      throw AppError.badRequest('仅支持重置主管账号密码');
    }

    const temporaryPassword = generateInitialPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await prisma.$transaction(async (tx) => {
      await tx.adminAccount.update({
        where: { id: target.id },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
      await tx.backofficeSession.updateMany({
        where: { accountId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await writeAuditLog({
      actorType: 'PLATFORM',
      actorId: actor.id,
      action: AuditAction.ACCOUNT_RESET,
      detail: { targetAccountId: target.id, email: target.email },
      ip,
    });

    return { temporaryPassword };
  }

  /** 后台账号禁用（AC14：不能删除只能禁用；AC15：平台管理员不可禁用） */
  async disableAccount(accountId: string, actor: AdminAccount, ip?: string) {
    const target = await prisma.adminAccount.findUnique({ where: { id: accountId } });
    if (!target) throw AppError.notFound('账号不存在');
    if (target.role === AdminRole.PLATFORM) {
      throw AppError.badRequest('平台管理员账号不可禁用');
    }
    if (target.status === 'DISABLED') return;

    await prisma.$transaction(async (tx) => {
      await tx.adminAccount.update({
        where: { id: target.id },
        data: { status: 'DISABLED' },
      });
      // 已签发会话在 5 分钟内失效：立即撤销
      await tx.backofficeSession.updateMany({
        where: { accountId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await writeAuditLog({
      actorType: 'PLATFORM',
      actorId: actor.id,
      action: AuditAction.KEY_DISABLED,
      detail: { event: 'admin_account_disabled', targetAccountId: target.id },
      ip,
    });
  }

  /** 校验密码规则（AC10）：≥8 位且同时含字母与数字 */
  validatePasswordStrength(password: string): string | null {
    if (password.length < 8) return '密码长度不能少于 8 位';
    if (!/[a-zA-Z]/.test(password)) return '密码必须包含字母';
    if (!/[0-9]/.test(password)) return '密码必须包含数字';
    return null;
  }

  /** 创建主管账号（供团队创建 T2-01 使用），返回初始密码 */
  async createSupervisorAccount(
    teamId: string,
    email: string,
    initialPassword: string,
  ): Promise<AdminAccount> {
    const passwordHash = await hashPassword(initialPassword);
    return prisma.adminAccount.create({
      data: {
        role: AdminRole.SUPERVISOR,
        email,
        passwordHash,
        teamId,
      },
    });
  }
}

export const authService = new AuthService();
