import { prisma } from '@/lib/prisma';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { writeAuditLog, AuditAction } from '@/services/audit.service';
import { tryDecryptLicenseCode } from '@/lib/crypto';
import { normalizeChannelAccountId, normalizeChannel } from '@/lib/channelAccountKey';
import { env } from '@/config/env';

/** 时区标注（PRD §2.6） */
const TIMEZONE = 'Asia/Shanghai';

export class PortService {
  /**
   * 端口申请（P0-C-20 AC1/AC10）：
   * 事务内校验团队 HELD 数 < 端口配额 → 建 PortLease(status=HELD)；
   * 并发防超卖 = 事务内 count + SQLite 写串行化；
   * 同 (clientId, 规范化账号标识) 已有 HELD → 幂等返回已有 lease。
   *
   * 幂等键用**规范化后的账号标识**而非原始 `channelAccountKey`：
   * 客户端升级后由「传 portId」改为「传 channel + channelAccountId」时，
   * 若仍按原始 key 比对会判不出同账号 → 重复占端口。
   */
  async acquire(
    teamId: string,
    keyId: string,
    clientId: string,
    channelAccountKey: string,
    options?: { channelAccountId?: string; channel?: 'TELEGRAM' | 'WHATSAPP' },
  ) {
    const accountId = normalizeChannelAccountId(channelAccountKey, options?.channelAccountId);
    const channel = normalizeChannel(options?.channel, channelAccountKey);

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

      // 2. 幂等：同 (clientId, 规范化账号标识) 已有 HELD → 直接返回
      const clientHeld = await tx.portLease.findMany({
        where: { clientId, status: 'HELD' },
      });
      const existing = clientHeld.find(
        (l) => normalizeChannelAccountId(l.channelAccountKey, l.channelAccountId) === accountId,
      );
      if (existing) {
        return {
          leaseId: existing.id,
          teamId: existing.teamId,
          keyId: existing.keyId,
          clientId: existing.clientId,
          channelAccountKey: existing.channelAccountKey,
          channelAccountId: normalizeChannelAccountId(
            existing.channelAccountKey,
            existing.channelAccountId,
          ),
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
          channelAccountId: accountId,
          status: 'HELD',
        },
      });

      // 5. 顺带补登渠道账号（若客户端尚未走 /accounts 对账，保证主管端立刻可见）
      if (channel) {
        const registered = await tx.channelAccount.findUnique({
          where: { clientId_channelAccountId: { clientId, channelAccountId: accountId } },
        });
        if (registered) {
          if (registered.deletedAt !== null) {
            // 客户端已删除该账号却仍在申请端口 → 以启动动作为准，复位登记
            await tx.channelAccount.update({
              where: { id: registered.id },
              data: { deletedAt: null, channel },
            });
          }
        } else {
          await tx.channelAccount.create({
            data: {
              teamId,
              keyId,
              clientId,
              channelAccountId: accountId,
              channel,
              // 无别名来源，退化为标识本身；客户端下次对账会覆盖为真实别名
              accountName: accountId,
            },
          });
        }
      }

      return {
        leaseId: lease.id,
        teamId: lease.teamId,
        keyId: lease.keyId,
        clientId: lease.clientId,
        channelAccountKey: lease.channelAccountKey,
        channelAccountId: accountId,
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
   * ② 刷新本 clientId 的 ClientCredential.lastActiveAt（设备级保活，主管端设备在线判据）；
   * ③ 写入客户端上报的渠道业务状态 channelStatus（仅本人名下、仍 HELD 的租约）；
   * ④ 比对服务端记录，返回 revokedLeaseIds（已回收/已撤销/配额下调需关闭的占用）；
   * ⑤ 返回 overQuota 信息（配额下调后 held > quota 时触发）。
   */
  async heartbeat(
    teamId: string,
    clientId: string,
    leaseIds: string[],
    channelStatuses?: Array<{ leaseId: string; status: 'ONLINE' | 'WAITING_QR' | 'OFFLINE' }>,
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

    // ── 顺带做**设备级**保活（P0-C-20 AC2 心跳保活）──────────────────
    // 主管端「设备管理」页的设备在线判据是 ClientCredential.lastActiveAt，
    // 而刷新它的接口过去只有 /api/client/auth/renew —— access token 有效期 3 天，
    // 客户端几乎不会主动续期，于是设备激活 5 分钟后必然被判「离线」（假离线）。
    // 心跳是客户端唯一的周期性调用（默认 2 分钟 < 在线窗口 5 分钟），故在此一并刷新。
    // 即使 leaseIds 为空（本机未占用任何端口）也刷新：设备在线与是否跑账号无关。
    const deviceKeepAlive = await prisma.clientCredential.updateMany({
      where: { clientId },
      data: { lastActiveAt: now },
    });

    // 写入渠道业务状态（P0-C-03 AC4/AC8/AC9/AC10）：
    // 按归属过滤 —— 只更新「本 clientId 名下 + 仍 HELD」的租约，防越权写他人租约
    let channelStatusUpdated = 0;
    if (channelStatuses && channelStatuses.length > 0) {
      const ownedHeld = new Set(
        leases.filter((l) => l.status === 'HELD' && l.clientId === clientId).map((l) => l.id),
      );
      const byStatus = new Map<string, string[]>();
      for (const item of channelStatuses) {
        if (!ownedHeld.has(item.leaseId)) continue;
        const list = byStatus.get(item.status) ?? [];
        list.push(item.leaseId);
        byStatus.set(item.status, list);
      }
      for (const [status, ids] of byStatus) {
        const res = await prisma.portLease.updateMany({
          where: { id: { in: ids }, clientId, status: 'HELD' },
          data: { channelStatus: status },
        });
        channelStatusUpdated += res.count;
      }
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
      /** 本次写入 channelStatus 的租约数（未上报 channelStatuses 时恒为 0） */
      channelStatusUpdated,
      /**
       * 设备活跃时间（本次心跳已刷新，主管端「设备管理」页据此显示在线）；
       * 为 null 表示库中没有该 clientId 的凭据（已被撤销/删除）→ 客户端应重新激活。
       */
      deviceActiveAt: deviceKeepAlive.count > 0 ? now.toISOString() : null,
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
    // 在线判定窗口：统一取 env.onlineWindowMs（默认 5 分钟），与 IM 账号页 / 客户端仪表板一致
    const offlineThresholdMs = env.onlineWindowMs; // 超过窗口未上报视为离线
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
   * - 离线仍占用 = HELD 且 lastSeenAt 距今 > ONLINE_WINDOW（默认 5 分钟）
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
    // 在线判定窗口：统一取 env.onlineWindowMs（默认 5 分钟）
    const offlineThresholdMs = env.onlineWindowMs;
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
