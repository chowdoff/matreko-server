import { AdminAccount, Team } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hashPassword, generateInitialPassword } from '@/lib/crypto';
import { teamStatusCache } from '@/lib/caches';

import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { writeAuditLog, AuditAction } from '@/services/audit.service';
import { CreateTeamInput, UpdateTeamQuotaInput, DisableTeamInput } from '@/schemas/team.schema';

/** 翻译配额默认值（P0-S-11 AC1：默认 150 万字符） */
export const DEFAULT_TRANSLATION_QUOTA = 1_500_000;

export interface CreateTeamResult {
  team: Team;
  supervisor: AdminAccount;
  /** 主管初始密码，仅此一次返回（P0-A-19 AC2） */
  initialPassword: string;
}

export class TeamService {
  /**
   * 创建团队（P0-S-11 AC1 / P0-A-19 AC2）：
   * 事务内同时创建 Team + AdminAccount(SUPERVISOR)，任一子操作失败整体回滚。
   */
  async createTeam(input: CreateTeamInput, actor: AdminAccount, ip?: string): Promise<CreateTeamResult> {
    const { name, supervisorEmail, portQuota, translationQuota } = input;

    // 到期时刻必须晚于当前（P0-S-11：管理员配置到期时刻）
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw AppError.badRequest('到期时刻必须晚于当前时间');
    }

    // 主管邮箱全局唯一（AdminAccount.email unique）
    const emailExists = await prisma.adminAccount.findUnique({
      where: { email: supervisorEmail },
    });
    if (emailExists) {
      throw AppError.conflict('该邮箱已被使用', ErrorCode.CONFLICT);
    }

    const initialPassword = generateInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const result = await prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          name,
          expiresAt,
          portQuota,
          translationQuota: translationQuota ?? DEFAULT_TRANSLATION_QUOTA,
        },
      });

      const supervisor = await tx.adminAccount.create({
        data: {
          role: 'SUPERVISOR',
          email: supervisorEmail,
          passwordHash,
          teamId: team.id,
        },
      });

      await writeAuditLog({
        actorType: 'PLATFORM',
        actorId: actor.id,
        action: AuditAction.TEAM_CREATED,
        detail: {
          teamId: team.id,
          teamName: team.name,
          supervisorAccountId: supervisor.id,
          supervisorEmail: supervisor.email,
          portQuota,
          translationQuota: translationQuota ?? DEFAULT_TRANSLATION_QUOTA,
          expiresAt: expiresAt.toISOString(),
        },
        ip,
        tx,
      });

      return { team, supervisor };
    });

    return { ...result, initialPassword };
  }

  /**
   * 团队列表（P0-S-11 AC2）：
   * 启用状态、创建时刻、到期时刻、端口占用、累计翻译用量与配额总量；
   * 时间统一 Asia/Shanghai 渲染。
   */
  async listTeams() {
    const teams = await prisma.team.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        portQuota: true,
        translationQuota: true,
        translationUsed: true,
      },
    });

    // 批量查询各团队当前端口占用数
    const heldCounts = await prisma.portLease.groupBy({
      by: ['teamId'],
      where: { status: 'HELD' },
      _count: { teamId: true },
    });
    const heldMap = new Map(heldCounts.map((g) => [g.teamId, g._count.teamId]));

    // 批量查询各团队主管账号（每团队唯一，P0-A-19）
    const supervisors = await prisma.adminAccount.findMany({
      where: { role: 'SUPERVISOR' },
      select: { id: true, email: true, teamId: true, status: true },
    });
    const supervisorMap = new Map(supervisors.map((s) => [s.teamId!, s]));

    return teams.map((t) => {
      const supervisor = supervisorMap.get(t.id);
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
        portQuota: t.portQuota,
        portsHeld: heldMap.get(t.id) ?? 0,
        translationQuota: t.translationQuota,
        translationUsed: t.translationUsed,
        supervisor: supervisor
          ? {
              accountId: supervisor.id,
              email: supervisor.email,
              status: supervisor.status,
            }
          : null,
        timezone: 'Asia/Shanghai',
      };
    });
  }

  /**
   * 配额与到期时刻修改（P0-S-11 AC3～AC5/AC10～AC13 / P0-B-10 AC15～AC17）：
   * - 延长到期只改 expiresAt，创建时刻与累计用量不变（AC4）
   * - 改到未来恢复可用且用量延续（AC5）
   * - 改到过去 = 立即到期，需 confirm=true 提示影响范围（AC11）
   * - 创建时刻不可修改（AC12）
   * - 配额非负整数校验（AC13，Zod 层已覆盖）
   * - 修改后写进程内缓存并主动失效 → ≤1min 生效（AC3）
   */
  async updateQuotas(
    teamId: string,
    input: UpdateTeamQuotaInput,
    actor: AdminAccount,
    ip?: string,
  ) {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw AppError.notFound('团队不存在');

    const changes: Record<string, unknown> = {};
    const data: { portQuota?: number; translationQuota?: number; expiresAt?: Date } = {};

    if (input.portQuota !== undefined && input.portQuota !== team.portQuota) {
      data.portQuota = input.portQuota;
      changes.portQuota = { from: team.portQuota, to: input.portQuota };
    }
    if (input.translationQuota !== undefined && input.translationQuota !== team.translationQuota) {
      data.translationQuota = input.translationQuota;
      changes.translationQuota = { from: team.translationQuota, to: input.translationQuota };
    }

    let expiresChanged = false;
    let willExpireImmediately = false;
    if (input.expiresAt !== undefined) {
      const newExpiresAt = new Date(input.expiresAt);
      if (newExpiresAt.getTime() !== team.expiresAt.getTime()) {
        // AC11：改到过去 = 立即到期，须确认影响范围
        if (newExpiresAt.getTime() <= Date.now()) {
          willExpireImmediately = true;
          if (!input.confirm) {
            const impact = await this.getTeamImpact(teamId);
            throw AppError.conflict(
              '将到期时刻改为过去会立即使团队到期，在线客服将被强制下线，请确认后重试',
              ErrorCode.STATUS_CHANGED,
              { impact, newExpiresAt: newExpiresAt.toISOString() },
            );
          }
        }
        data.expiresAt = newExpiresAt;
        changes.expiresAt = {
          from: team.expiresAt.toISOString(),
          to: newExpiresAt.toISOString(),
          willExpireImmediately,
        };
        expiresChanged = true;
      }
    }

    if (Object.keys(data).length === 0) {
      return {
        team: {
          id: team.id,
          name: team.name,
          status: team.status,
          createdAt: team.createdAt.toISOString(),
          expiresAt: team.expiresAt.toISOString(),
          portQuota: team.portQuota,
          translationQuota: team.translationQuota,
          translationUsed: team.translationUsed,
        },
        noChange: true,
      };
    }

    const updated = await prisma.$transaction(async (tx) => {
      const t = await tx.team.update({ where: { id: teamId }, data });
      await writeAuditLog({
        actorType: 'PLATFORM',
        actorId: actor.id,
        action: AuditAction.QUOTA_CHANGED,
        detail: { teamId: t.id, teamName: t.name, changes },
        ip,
        tx,
      });
      return t;
    });

    // 主动失效缓存 → 鉴权链路 / 客户端 ≤1min 感知（AC3）
    teamStatusCache.delete(teamId);
    // keyStatusCache 条目内含 teamStatus + teamExpiresAt 快照，也需失效
    // 逐个 key 不现实（需遍历），靠 TTL 60s 自然过期兜底即可满足 ≤1min 承诺

    return {
      team: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
        expiresAt: updated.expiresAt.toISOString(),
        portQuota: updated.portQuota,
        translationQuota: updated.translationQuota,
        translationUsed: updated.translationUsed,
      },
      changes,
      expiresChanged,
      willExpireImmediately,
    };
  }

  /**
   * 团队禁用（P0-S-11 AC8～AC9）：
   * - 提交前返回影响范围（在线客服数、已启动账号数）
   * - 禁用后全团队凭据按鉴权链路拒绝
   * - 无删除能力，数据保留可查
   */
  async disableTeam(
    teamId: string,
    input: DisableTeamInput,
    actor: AdminAccount,
    ip?: string,
  ) {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw AppError.notFound('团队不存在');
    if (team.status === 'DISABLED') {
      const impact = await this.getTeamImpact(teamId);
      return { alreadyDisabled: true, impact };
    }

    const impact = await this.getTeamImpact(teamId);
    // AC8：提交前明确提示影响范围
    if (!input.confirm) {
      throw AppError.conflict(
        '禁用团队将导致该团队所有客服在 5 分钟内下线、主管无法登录，请确认后重试',
        ErrorCode.STATUS_CHANGED,
        impact,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.team.update({
        where: { id: teamId },
        data: { status: 'DISABLED' },
      });
      await writeAuditLog({
        actorType: 'PLATFORM',
        actorId: actor.id,
        action: AuditAction.TEAM_DISABLED,
        detail: { teamId: team.id, teamName: team.name, impact },
        ip,
        tx,
      });
    });

    // 主动失效缓存 → 客户端鉴权链路 ≤60s 感知团队已禁用
    teamStatusCache.delete(teamId);

    return { impact };
  }

  /**
   * 团队启用（P0-B-10 AC17：禁用后恢复启用，累计用量延续原值继续累加，不清零、不重置）：
   * - DISABLED → ACTIVE，主管可重新登录、密钥与凭据恢复可用；
   * - 若 expiresAt 已过期，团队仍按到期处理（需另行修改到期时刻到未来，AC5）；
   * - 幂等：已启用返回 alreadyEnabled，不重复写审计。
   */
  async enableTeam(teamId: string, actor: AdminAccount, ip?: string) {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw AppError.notFound('团队不存在');

    if (team.status !== 'DISABLED') {
      return {
        alreadyEnabled: true,
        team: {
          id: team.id,
          name: team.name,
          status: team.status,
          expiresAt: team.expiresAt.toISOString(),
        },
        expired: team.expiresAt.getTime() <= Date.now(),
      };
    }

    const expired = team.expiresAt.getTime() <= Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      const t = await tx.team.update({
        where: { id: teamId },
        data: { status: 'ACTIVE' },
      });
      await writeAuditLog({
        actorType: 'PLATFORM',
        actorId: actor.id,
        action: AuditAction.TEAM_ENABLED,
        detail: { teamId: t.id, teamName: t.name, expired },
        ip,
        tx,
      });
      return t;
    });

    // 主动失效缓存 → 鉴权链路 ≤60s 感知团队已恢复
    teamStatusCache.delete(teamId);

    return {
      alreadyEnabled: false,
      team: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        expiresAt: updated.expiresAt.toISOString(),
      },
      expired,
    };
  }

  /**
   * 获取团队影响范围（在线客服数 = 活跃密钥数，已启动账号数 = HELD 端口数）
   */
  private async getTeamImpact(teamId: string) {
    const [activeKeys, heldPorts] = await Promise.all([
      prisma.licenseKey.count({
        where: { teamId, status: { in: ['UNUSED', 'ACTIVE'] } },
      }),
      prisma.portLease.count({
        where: { teamId, status: 'HELD' },
      }),
    ]);
    return { activeKeys, heldPorts };
  }
}

export const teamService = new TeamService();
