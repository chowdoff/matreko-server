import { prisma } from '@/lib/prisma';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { writeAuditLog, AuditAction } from '@/services/audit.service';
import { tryDecryptLicenseCode } from '@/lib/crypto';
import { env } from '@/config/env';

/** 时区标注（PRD §2.6） */
const TIMEZONE = 'Asia/Shanghai';

export class PortService {
  /**
   * 端口申请（P0-C-20 AC1/AC10）：
   * 事务内校验团队 HELD 数 < 端口配额 → 建 PortLease(status=HELD)；
   * 并发防超卖 = 事务内 count + SQLite 写串行化；
   * 同 (clientId, channelAccountKey) 已有 HELD → 幂等返回已有 lease。
   */
  async acquire(teamId: string, keyId: string, clientId: string, channelAccountKey: string) {
    return prisma.$transaction(async (tx) => {
      // 1. 校验团队状态与配额
      const team = await tx.team.findUnique({
        where: { id: teamId },
        select: { id: true, name: true, portQuota: true, status: true, expiresAt: true },
      });
      if (!team) throw AppError.notFound('团队不存在');
      if (team.status === 'DISABLED') {
        throw AppError.forbidden('团队已不可用', ErrorCode.TEAM_UNAVAILABLE);
      }
      if (team.expiresAt.getTime() <= Date.now()) {
        throw AppError.forbidden('团队已到期', ErrorCode.TEAM_UNAVAILABLE);
      }

      // 2. 幂等：同 (clientId, channelAccountKey) 已有 HELD → 直接返回
      const existing = await tx.portLease.findFirst({
        where: { clientId, channelAccountKey, status: 'HELD' },
      });
      if (existing) {
        return {
          leaseId: existing.id,
          teamId: existing.teamId,
          keyId: existing.keyId,
          clientId: existing.clientId,
          channelAccountKey: existing.channelAccountKey,
          status: existing.status,
          acquiredAt: existing.acquiredAt.toISOString(),
          lastSeenAt: existing.lastSeenAt.toISOString(),
          alreadyHeld: true,
          timezone: TIMEZONE,
        };
      }

      // 3. 防超卖：count HELD < portQuota
      const heldCount = await tx.portLease.count({
        where: { teamId, status: 'HELD' },
      });
      if (heldCount >= team.portQuota) {
        throw AppError.conflict(
          '端口已用尽，请联系主管',
          ErrorCode.PORT_EXHAUSTED,
          { held: heldCount, quota: team.portQuota },
        );
      }

      // 4. 创建租约
      const lease = await tx.portLease.create({
        data: {
          teamId,
          keyId,
          clientId,
          channelAccountKey,
          status: 'HELD',
        },
      });

      return {
        leaseId: lease.id,
        teamId: lease.teamId,
        keyId: lease.keyId,
        clientId: lease.clientId,
        channelAccountKey: lease.channelAccountKey,
        status: lease.status,
        acquiredAt: lease.acquiredAt.toISOString(),
        lastSeenAt: lease.lastSeenAt.toISOString(),
        alreadyHeld: false,
        timezone: TIMEZONE,
      };
    });
  }

  /**
   * 心跳协议（P0-C-20 AC2/AC8/AC12）：
   * ① 刷新各 lease lastSeenAt；
   * ② 比对服务端记录，返回 revokedLeaseIds（已回收/已撤销/配额下调需关闭的占用）；
   * ③ 返回 overQuota 信息（配额下调后 held > quota 时触发）。
   */
  async heartbeat(
    teamId: string,
    clientId: string,
    leaseIds: string[],
  ) {
    const now = new Date();

    // 查询客户端上报的全部 lease 在服务端的实际状态
    const leases = await prisma.portLease.findMany({
      where: { id: { in: leaseIds } },
    });

    const heldLeaseIds: string[] = [];
    const revokedLeaseIds: string[] = [];

    for (const lease of leases) {
      if (lease.status === 'HELD') {
        // 仍 HELD → 刷新 lastSeenAt
        heldLeaseIds.push(lease.id);
      } else {
        // 已 RELEASED → 加入撤销清单
        revokedLeaseIds.push(lease.id);
      }
    }

    // 批量刷新 lastSeenAt（仅 HELD 且属于本 clientId 的）
    if (heldLeaseIds.length > 0) {
      await prisma.portLease.updateMany({
        where: { id: { in: heldLeaseIds }, clientId },
        data: { lastSeenAt: now },
      });
    }

    // 检测配额下调导致的 over-quota（P0-S-11 AC6/AC7）
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { portQuota: true },
    });
    const heldCount = await prisma.portLease.count({
      where: { teamId, status: 'HELD' },
    });
    const overQuota = heldCount > team!.portQuota;

    // 获取本客户端当前所有 HELD lease（供客户端展示「选择关闭」弹窗）
    let pendingCloseLeaseIds: string[] = [];
    if (overQuota) {
      const clientHeld = await prisma.portLease.findMany({
        where: { teamId, clientId, status: 'HELD' },
        select: { id: true, channelAccountKey: true },
      });
      pendingCloseLeaseIds = clientHeld.map((l) => l.id);
    }

    return {
      refreshedLeaseIds: heldLeaseIds.filter((id) =>
        leases.some((l) => l.id === id && l.clientId === clientId),
      ),
      revokedLeaseIds,
      overQuota,
      heldCount,
      portQuota: team!.portQuota,
      ...(overQuota ? { pendingCloseLeaseIds } : {}),
      timestamp: now.toISOString(),
    };
  }

  /**
   * 端口释放（P0-C-20 AC3）：
   * 客户端主动停止账号时调用，单个释放，置 RELEASED。
   */
  async release(clientId: string, leaseId: string) {
    const lease = await prisma.portLease.findUnique({ where: { id: leaseId } });
    if (!lease) throw AppError.notFound('端口租约不存在');
    if (lease.clientId !== clientId) {
      throw AppError.forbidden('无权释放他人端口租约');
    }
    if (lease.status === 'RELEASED') {
      return { alreadyReleased: true, leaseId };
    }

    await prisma.portLease.update({
      where: { id: leaseId },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });

    return { alreadyReleased: false, leaseId };
  }

  /**
   * 端口归零（P0-C-20 AC4/AC7）：
   * 客户端启动/强杀重启时调用，释放本机全部占用，不等 24h 超时。
   */
  async reset(clientId: string) {
    const result = await prisma.portLease.updateMany({
      where: { clientId, status: 'HELD' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });

    return {
      releasedCount: result.count,
      clientId,
    };
  }

  /**
   * 手动释放（P0-C-20 AC11）：
   * 主管/管理员在后台手动释放卡死的端口，立即回收。
   * 提交前提示「该客服可能仍在使用该账号」。
   */
  async manualRelease(
    leaseId: string,
    actor: { id: string; role: string },
    teamScope: string | null, // 主管=本团队 ID，管理员=null（全平台）
    input: { confirm?: boolean },
    ip?: string,
  ) {
    const lease = await prisma.portLease.findUnique({
      where: { id: leaseId },
      include: { team: { select: { id: true, name: true } } },
    });
    if (!lease) throw AppError.notFound('端口租约不存在');

    // 主管只能释放本团队端口
    if (teamScope && lease.teamId !== teamScope) {
      throw AppError.forbidden('无权释放其他团队的端口');
    }

    if (lease.status === 'RELEASED') {
      return { alreadyReleased: true, leaseId };
    }

    // AC11：提交前明确提示「该客服可能仍在使用该账号」
    if (!input.confirm) {
      throw AppError.conflict(
        '该客服可能仍在使用该账号，确认要手动释放吗？',
        ErrorCode.STATUS_CHANGED,
        {
          leaseId: lease.id,
          teamId: lease.teamId,
          teamName: lease.team.name,
          channelAccountKey: lease.channelAccountKey,
          acquiredAt: lease.acquiredAt.toISOString(),
          lastSeenAt: lease.lastSeenAt.toISOString(),
        },
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.portLease.update({
        where: { id: leaseId },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      await writeAuditLog({
        actorType: actor.role === 'PLATFORM' ? 'PLATFORM' : 'SUPERVISOR',
        actorId: actor.id,
        action: AuditAction.LEASE_RELEASED_MANUAL,
        detail: {
          leaseId,
          teamId: lease.teamId,
          channelAccountKey: lease.channelAccountKey,
          clientId: lease.clientId,
        },
        ip,
        tx,
      });
    });

    return {
      alreadyReleased: false,
      leaseId,
      teamId: lease.teamId,
      channelAccountKey: lease.channelAccountKey,
    };
  }

  /**
   * 租约回收扫描（P0-C-20 AC5/AC6）：
   * node-cron 按 LEASE_SCAN_INTERVAL 扫描 lastSeenAt + LEASE_TTL < now 且 status=HELD 的租约，
   * 置 RELEASED（不物理删除）。
   */
  async sweepExpiredLeases(): Promise<number> {
    const now = Date.now();
    const cutoff = new Date(now);
    const ttlBefore = new Date(now - env.leaseTtlMs);
    const result = await prisma.portLease.updateMany({
      where: {
        status: 'HELD',
        lastSeenAt: { lt: ttlBefore },
      },
      data: { status: 'RELEASED', releasedAt: cutoff },
    });

    if (result.count > 0) {
      // 审计日志（SYSTEM 级别）
      await writeAuditLog({
        actorType: 'SYSTEM',
        actorId: 'cron',
        action: AuditAction.LEASE_RELEASED_TIMEOUT,
        detail: { releasedCount: result.count, cutoff: cutoff.toISOString() },
      });
    }

    return result.count;
  }

  /**
   * 主管/管理员查询端口占用列表
   */
  async listLeases(teamId: string | null) {
    const where = teamId ? { teamId } : {};
    const leases = await prisma.portLease.findMany({
      where: { ...where, status: 'HELD' },
      include: {
        licenseKey: {
          select: { id: true, nickname: true, code: true },
        },
        team: { select: { id: true, name: true } },
      },
      orderBy: { acquiredAt: 'desc' },
    });

    return leases.map((l) => ({
      leaseId: l.id,
      teamId: l.teamId,
      teamName: l.team.name,
      keyId: l.keyId,
      keyNickname: l.licenseKey.nickname,
      // 完整密钥明文：AES-256-GCM 解密后返回
      licenseCode: l.licenseKey.code ? tryDecryptLicenseCode(l.licenseKey.code, env.licenseCodeEncKey) : null,
      clientId: l.clientId,
      channelAccountKey: l.channelAccountKey,
      status: l.status,
      acquiredAt: l.acquiredAt.toISOString(),
      lastSeenAt: l.lastSeenAt.toISOString(),
      releasedAt: l.releasedAt?.toISOString() ?? null,
      timezone: TIMEZONE,
    }));
  }

  /**
   * 端口管理 dashboard（P0-C-20 AC11 / T3-05）：
   * 返回 4 张顶部统计卡片 + 按团队汇总 + 端口占用明细。
   *
   * - 已占用/配额合计 = 全平台 HELD / 团队 portQuota 合计
   * - 可用端口 = 团队 portQuota 合计 - 已占用
   * - 离线仍占用 = HELD 且 lastSeenAt 距今 > 5 分钟（短期离线，不算活跃）
   * - 疑似卡死 = HELD 且 lastSeenAt 距今 > 60 分钟（即将被 cron 回收）
   */
  async getDashboard(teamScope: string | null = null) {
    const teams = await prisma.team.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, status: true, portQuota: true },
    });

    const allLeases = await prisma.portLease.findMany({
      where: { status: 'HELD', ...(teamScope ? { teamId: teamScope } : {}) },
      include: {
        team: { select: { id: true, name: true, status: true } },
        licenseKey: { select: { id: true, nickname: true, code: true } },
      },
      orderBy: { acquiredAt: 'desc' },
    });

    // 总配额 = 全平台 portQuota 合计
    const totalQuota = teams.reduce((s, t) => s + t.portQuota, 0);
    const totalHeld = allLeases.length;

    const now = Date.now();
    const offlineThresholdMs = 5 * 60 * 1000; // 5 分钟未上报视为离线
    const stuckThresholdMs = 60 * 60 * 1000; // 60 分钟未上报视为卡死

    const offlineLeases = allLeases.filter(
      (l) => now - l.lastSeenAt.getTime() > offlineThresholdMs,
    );
    const stuckLeases = allLeases.filter(
      (l) => now - l.lastSeenAt.getTime() > stuckThresholdMs,
    );

    // 按团队汇总
    const heldByTeam = new Map<string, number>();
    for (const l of allLeases) {
      heldByTeam.set(l.teamId, (heldByTeam.get(l.teamId) ?? 0) + 1);
    }
    const teamSummary = teams.map((t) => ({
      teamId: t.id,
      teamName: t.name,
      status: t.status,
      portQuota: t.portQuota,
      portsHeld: heldByTeam.get(t.id) ?? 0,
      available: Math.max(t.portQuota - (heldByTeam.get(t.id) ?? 0), 0),
    }));

    // 端口占用明细（带 team 信息以便管理员筛选）
    const items = allLeases.map((l) => {
      const lastSeenAgeSec = Math.floor((now - l.lastSeenAt.getTime()) / 1000);
      const isOffline = lastSeenAgeSec * 1000 > offlineThresholdMs;
      const isStuck = lastSeenAgeSec * 1000 > stuckThresholdMs;
      return {
        leaseId: l.id,
        teamId: l.teamId,
        teamName: l.team.name,
        teamStatus: l.team.status,
        keyId: l.keyId,
        keyNickname: l.licenseKey.nickname,
        clientId: l.clientId,
        channelAccountKey: l.channelAccountKey,
        status: l.status,
        acquiredAt: l.acquiredAt.toISOString(),
        lastSeenAt: l.lastSeenAt.toISOString(),
        lastSeenAgeSec,
        isOffline,
        isStuck,
        releasedAt: l.releasedAt?.toISOString() ?? null,
        timezone: TIMEZONE,
      };
    });

    return {
      topStats: {
        heldVsQuota: {
          held: totalHeld,
          quota: totalQuota,
          note: '以服务端记录为准',
        },
        available: Math.max(totalQuota - totalHeld, 0),
        offlineHeld: {
          count: offlineLeases.length,
          note: '离线不算被端口',
        },
        stuck: {
          count: stuckLeases.length,
          note: '超过 1 小时没有在线证明',
        },
      },
      teamSummary,
      items,
      timezone: TIMEZONE,
    };
  }

  /**
   * 主管端端口管理 dashboard（P0-C-20 AC11 / 主管侧）：
   * 单团队视角：返回 4 张统计卡 + 端口占用明细（按客服/密钥维度）。
   *
   * - 已占用/配额合计 = HELD / portQuota
   * - 可用端口 = portQuota - HELD（包括未启动账号）
   * - 离线仍占用 = HELD 且 lastSeenAt 距今 > 5 分钟
   * - 疑似卡死 = HELD 且 lastSeenAt 距今 > 60 分钟
   */
  async getTeamDashboard(teamId: string) {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true, status: true, portQuota: true, expiresAt: true },
    });
    if (!team) throw AppError.notFound('团队不存在');

    const leases = await prisma.portLease.findMany({
      where: { teamId, status: 'HELD' },
      include: {
        licenseKey: { select: { id: true, nickname: true } },
      },
      orderBy: { acquiredAt: 'desc' },
    });

    const now = Date.now();
    const offlineThresholdMs = 5 * 60 * 1000;
    const stuckThresholdMs = 60 * 60 * 1000;

    // 离线仍占用：5 分钟未上报但尚不足 60 分钟（未达卡死阈值）
    const offlineLeases = leases.filter((l) => {
      const age = now - l.lastSeenAt.getTime();
      return age > offlineThresholdMs && age <= stuckThresholdMs;
    });
    // 疑似卡死：超过 60 分钟没有在线证明
    const stuckLeases = leases.filter(
      (l) => now - l.lastSeenAt.getTime() > stuckThresholdMs,
    );

    function formatRelative(t: Date): string {
      const diff = now - t.getTime();
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
      return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
    }

    // 端口占用明细（含客服/账号状态/最后一次在线/手动释放按钮）
    const items = leases.map((l) => {
      const seenMs = now - l.lastSeenAt.getTime();
      // 账号状态以权威 channelStatus 为准（与 IM 账号页一致）；缺省时按心跳窗口兜底
      let accountStatus: 'ONLINE' | 'WAITING_QR' | 'OFFLINE';
      if (l.channelStatus === 'WAITING_QR') accountStatus = 'WAITING_QR';
      else if (l.channelStatus === 'OFFLINE') accountStatus = 'OFFLINE';
      else if (l.channelStatus === 'ONLINE') accountStatus = 'ONLINE';
      else accountStatus = seenMs <= offlineThresholdMs ? 'ONLINE' : 'OFFLINE';

      return {
        leaseId: l.id,
        keyId: l.keyId,
        keyNickname: l.licenseKey.nickname, // 客服 = 密钥昵称
        clientId: l.clientId,
        channelAccountKey: l.channelAccountKey,
        accountId: l.channelAccountKey.split(':').slice(1).join(':') || l.channelAccountKey,
        channel: l.channelAccountKey.split(':')[0],
        accountStatus,
        acquiredAt: l.acquiredAt.toISOString(),
        lastSeenAt: l.lastSeenAt.toISOString(),
        lastSeenRelative: formatRelative(l.lastSeenAt),
        proxyExit: l.proxyExit ?? '',
        canRelease: true,
      };
    });

    const heldCount = items.length;
    const portQuota = team.portQuota;

    return {
      team: {
        id: team.id,
        name: team.name,
        status: team.status,
      },
      topStats: {
        heldVsQuota: {
          held: heldCount,
          quota: portQuota,
          note: '以服务端记录为准',
        },
        available: Math.max(portQuota - heldCount, 0),
        offlineHeld: {
          count: offlineLeases.length,
          note: '离线不算被端口',
        },
        stuck: {
          count: stuckLeases.length,
          note: '超过 1 小时没有在线证明',
        },
      },
      items,
      timezone: TIMEZONE,
    };
  }
}

export const portService = new PortService();
