import { TranslationEngine } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuditAction } from '@/services/audit.service';

/** 时区标注 */
const TIMEZONE = 'Asia/Shanghai';
/** 近 24h 统计窗口 */
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

/**
 * 翻译失败原因（与 PRD §4.4 / backend §7.4 一致）。
 * 注意：TIMEOUT / 5xx / 429 是引擎侧瞬态错误；其余为确定性失败。
 */
export const FAILURE_REASONS = [
  { code: 'TIMEOUT', label: '接口超时', retryable: true, action: '自动重试，总耗时 ≤ 40 秒（P0-T-08 AC1）' },
  { code: 'ENGINE_5XX', label: '引擎 5xx', retryable: true, action: '自动重试；耗尽后标记失败并提供手动重试（AC4）' },
  { code: 'RATE_LIMIT_429', label: '限流 429', retryable: true, action: '按渠道重试，不同同一条消息并发触发多次（P0-T-07 AC6）' },
  { code: 'LANG_UNSUPPORTED', label: '两个引擎均不支持该语种', retryable: false, action: '直接拒绝（P0-T-08 AC2）' },
  { code: 'CONTENT_REJECTED', label: '内容被引擎拒绝', retryable: false, action: '直接拒绝（安全审计）' },
  { code: 'API_KEY_INVALID', label: 'API Key 无效', retryable: false, action: '直接拒绝，管理员介入（P0-S-12）' },
] as const;

export type FailureReasonCode = (typeof FAILURE_REASONS)[number]['code'];

/** 翻译失败原因分布的一行（含无法识别的 OTHER 兜底项） */
export type FailureReasonRow = {
  code: FailureReasonCode | 'OTHER';
  label: string;
  count: number;
  percentage: number;
  retryable: boolean;
  action: string;
};

export class MonitoringService {
  /**
   * 平台级运行监控 overview（P1-S-17 AC1）：
   * 4 张顶部统计卡 + 各团队运行状态 + 翻译失败原因分布。
   */
  async getOverview() {
    const [teams, leases, since24h] = await Promise.all([
      prisma.team.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          status: true,
          portQuota: true,
          translationQuota: true,
          translationUsed: true,
        },
      }),
      prisma.portLease.findMany({
        where: { status: 'HELD' },
        select: { teamId: true, lastSeenAt: true, id: true },
      }),
      new Date(Date.now() - WINDOW_24H_MS),
    ]);

    // ── 4 张统计卡片 ──
    const activeTeamCount = teams.filter((t) => t.status === 'ACTIVE').length;
    const onlineLeaseCount = leases.filter(
      (l) => Date.now() - l.lastSeenAt.getTime() < 5 * 60 * 1000,
    ).length;
    const totalPortsHeld = leases.length;
    const totalPortsQuota = teams.reduce((s, t) => s + t.portQuota, 0);

    // 翻译成功率（24h）
    const [successAgg, failureLogs] = await Promise.all([
      prisma.translationUsageLog.aggregate({
        where: { createdAt: { gte: since24h } },
        _sum: { chars: true },
        _count: { _all: true },
      }),
      prisma.auditLog.findMany({
        where: {
          action: AuditAction.TRANSLATION_FAILED,
          createdAt: { gte: since24h },
        },
        select: { detail: true, createdAt: true },
      }),
    ]);
    const successCount = successAgg._count._all;
    const totalCalls = successCount + failureLogs.length;
    const successRate = totalCalls === 0 ? null : (successCount / totalCalls) * 100;

    // ── 各团队运行状态 ──
    const heldByTeam = new Map<string, number>();
    const onlineByTeam = new Map<string, number>();
    for (const l of leases) {
      heldByTeam.set(l.teamId, (heldByTeam.get(l.teamId) ?? 0) + 1);
      if (Date.now() - l.lastSeenAt.getTime() < 5 * 60 * 1000) {
        onlineByTeam.set(l.teamId, (onlineByTeam.get(l.teamId) ?? 0) + 1);
      }
    }

    const teamRuntime = await Promise.all(
      teams.map(async (t) => {
        const held = heldByTeam.get(t.id) ?? 0;
        const online = onlineByTeam.get(t.id) ?? 0;
        // 团队级 24h 成功率
        const [teamSuccess, teamFail] = await Promise.all([
          prisma.translationUsageLog.aggregate({
            where: { teamId: t.id, createdAt: { gte: since24h } },
            _count: { _all: true },
          }),
          prisma.auditLog.count({
            where: {
              action: AuditAction.TRANSLATION_FAILED,
              createdAt: { gte: since24h },
              detail: { contains: `"teamId":"${t.id}"` },
            },
          }),
        ]);
        const total = teamSuccess._count._all + teamFail;
        const teamSuccessRate = total === 0 ? null : (teamSuccess._count._all / total) * 100;

        const isQuotaExhausted = t.translationUsed >= t.translationQuota;

        let status: 'ACTIVE' | 'QUOTA_FULL' | 'DISABLED' = t.status as 'ACTIVE' | 'DISABLED';
        if (status === 'ACTIVE' && isQuotaExhausted) status = 'QUOTA_FULL';

        return {
          teamId: t.id,
          teamName: t.name,
          status,
          onlineAccounts: online,
          portsHeld: held,
          portQuota: t.portQuota,
          translationUsed: t.translationUsed,
          translationQuota: t.translationQuota,
          successRate: teamSuccessRate,
        };
      }),
    );

    // ── 翻译失败原因分布（近 24h，全平台） ──
    const reasonDistribution = this.computeReasonDistribution(failureLogs);

    return {
      topStats: {
        activeTeams: activeTeamCount,
        onlineAccounts: onlineLeaseCount,
        ports: { used: totalPortsHeld, quota: totalPortsQuota },
        translation: {
          successRate: successRate,
          totalCalls,
          successCount,
          failureCount: failureLogs.length,
        },
      },
      teamRuntime,
      reasonDistribution,
      timezone: TIMEZONE,
      windowHours: 24,
      asOf: new Date().toISOString(),
    };
  }

  /**
   * 翻译失败原因分布聚合：按 detail.reason 字段分组。
   */
  private computeReasonDistribution(
    failureLogs: { detail: string | null }[],
  ): FailureReasonRow[] {
    const counts = new Map<string, number>();
    let unknownCount = 0;
    for (const log of failureLogs) {
      let code = 'OTHER';
      if (log.detail) {
        try {
          const detail = JSON.parse(log.detail) as { reason?: string };
          code = detail.reason ?? 'OTHER';
        } catch {
          // ignore
        }
      }
      if (code === 'OTHER') unknownCount++;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const total = failureLogs.length || 1;
    const result: FailureReasonRow[] = FAILURE_REASONS.map((r) => {
      const count = counts.get(r.code) ?? 0;
      return {
        code: r.code,
        label: r.label,
        count,
        percentage: Math.round((count / total) * 100),
        retryable: r.retryable,
        action: r.action,
      };
    });
    if (unknownCount > 0) {
      result.push({
        code: 'OTHER',
        label: '其它',
        count: unknownCount,
        percentage: Math.round((unknownCount / total) * 100),
        retryable: false,
        action: '人工排查',
      });
    }
    return result;
  }
}

export const monitoringService = new MonitoringService();
