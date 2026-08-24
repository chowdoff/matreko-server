import { TranslationEngine } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { tryDecryptSecret } from '@/lib/crypto';
import { getProvider } from '@/services/translation/providerRegistry';

/** 时区标注（PRD §2.6） */
const TIMEZONE = 'Asia/Shanghai';

/** 近 24h 统计窗口 */
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

export class UsageService {
  // ── T5-03: KeyDailyUsage 每小时聚合任务 ──

  /**
   * 聚合 T-1 小时的 TranslationUsageLog 到 KeyDailyUsage 缓存表。
   * 幂等：使用 upsert，重复执行不会重复计数（基于 date + keyId 唯一约束 + 差量计算）。
   *
   * 策略：对每个 (keyId, date) 组合，统计该小时内的日志，增量更新 KeyDailyUsage。
   * 由于日志是 append-only 且 success 恒 true，使用 _sum + _count 增量累加是安全的。
   * 但为简化实现，采用「全量重算当日」策略：查当日全部日志，覆盖写入 KeyDailyUsage。
   */
  async aggregateKeyDailyUsage(): Promise<number> {
    // 对齐到整点，处理 T-1 小时的数据
    const now = new Date();
    const hourStart = new Date(Math.floor(now.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000));
    const oneHourAgo = new Date(hourStart.getTime() - 60 * 60 * 1000);

    // 按 (keyId, date) 分组聚合 T-1 小时的日志
    const logs = await prisma.translationUsageLog.findMany({
      where: {
        createdAt: {
          gte: oneHourAgo,
          lt: hourStart,
        },
      },
      select: { keyId: true, engine: true, chars: true, createdAt: true },
    });

    if (logs.length === 0) return 0;

    // 按 (keyId, date) 聚合
    const grouped = new Map<string, { keyId: string; date: string; engine: TranslationEngine; chars: number; calls: number }>();
    for (const log of logs) {
      if (!log.keyId) continue;
      const date = log.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
      const key = `${log.keyId}:${date}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.chars += log.chars;
        existing.calls += 1;
      } else {
        grouped.set(key, {
          keyId: log.keyId,
          date,
          engine: log.engine,
          chars: log.chars,
          calls: 1,
        });
      }
    }

    // 全量重算当日（幂等：每次聚合覆盖当日值，而非增量累加）
    // 查询当日全部日志重新计算
    for (const [, entry] of grouped) {
      const dayStart = new Date(entry.date + 'T00:00:00.000Z');
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const dayAgg = await prisma.translationUsageLog.aggregate({
        where: {
          keyId: entry.keyId,
          createdAt: { gte: dayStart, lt: dayEnd },
        },
        _sum: { chars: true },
        _count: { _all: true },
      });

      await prisma.keyDailyUsage.upsert({
        where: {
          keyId_date: { keyId: entry.keyId, date: entry.date },
        },
        create: {
          keyId: entry.keyId,
          date: entry.date,
          engine: entry.engine,
          chars: dayAgg._sum.chars ?? 0,
          calls: dayAgg._count._all,
        },
        update: {
          chars: dayAgg._sum.chars ?? 0,
          calls: dayAgg._count._all,
        },
      });
    }

    return grouped.size;
  }

  // ── T5-04: 主管侧用量查询接口 ──

  /**
   * IM 账号列表（主管端 IM 账号页）：
   * 团队下全部 HELD/RELEASED 端口租约 → 映射为 IM 账号列表（按 channelAccountKey 展示）。
   * - 账号总数 = HELD + 未启动的 RELEASED
   * - 在线 = status=HELD 且 channelStatus=ONLINE
   * - 离线（仍占端口）= status=HELD 且 channelStatus=OFFLINE
   * - 占用端口合计 = status=HELD 的数量
   */
  async listImAccounts(teamId: string) {
    const leases = await prisma.portLease.findMany({
      where: { teamId },
      include: {
        licenseKey: {
          select: { id: true, nickname: true },
        },
      },
      orderBy: [{ status: 'asc' }, { acquiredAt: 'desc' }],
    });

    const now = Date.now();

    const items = leases.map((l) => {
      const [channel, ...accountParts] = l.channelAccountKey.split(':');
      const accountId = accountParts.join(':') || l.channelAccountKey;

      // IM 账号业务状态：RELEASED 一律视为未启动；HELD 按 channelStatus 区分
      let imStatus: 'ONLINE' | 'WAITING_QR' | 'OFFLINE' | 'RELEASED' | 'UNKNOWN';
      if (l.status === 'RELEASED') imStatus = 'RELEASED';
      else if (l.channelStatus === 'WAITING_QR') imStatus = 'WAITING_QR';
      else if (l.channelStatus === 'ONLINE' || l.channelStatus === 'OFFLINE') {
        imStatus = l.channelStatus;
      } else {
        const seenMs = now - new Date(l.lastSeenAt).getTime();
        imStatus = seenMs <= 60 * 1000 ? 'ONLINE' : 'OFFLINE';
      }

      return {
        leaseId: l.id,
        accountId,
        channelAccountKey: l.channelAccountKey,
        channel: channel || 'unknown',
        status: imStatus,
        isHeld: l.status === 'HELD',
        portsHeld: l.status === 'HELD' ? 1 : 0,
        keyId: l.keyId,
        keyNickname: l.licenseKey.nickname,
        clientId: l.clientId,
        acquiredAt: l.acquiredAt.toISOString(),
        lastSeenAt: l.lastSeenAt.toISOString(),
        releasedAt: l.releasedAt?.toISOString() ?? null,
        proxyExit: l.proxyExit ?? '',
        timezone: TIMEZONE,
      };
    });

    const totalCount = items.length;
    const heldCount = items.filter((i) => i.isHeld).length;
    const onlineCount = items.filter((i) => i.status === 'ONLINE').length;
    const offlineHeldCount = items.filter((i) => i.status === 'OFFLINE').length;
    const waitingQrCount = items.filter((i) => i.status === 'WAITING_QR').length;

    return {
      items,
      summary: {
        total: totalCount,
        online: onlineCount,
        offlineHeld: offlineHeldCount,
        waitingQr: waitingQrCount,
        portsHeld: heldCount,
      },
      timezone: TIMEZONE,
    };
  }

  /**
   * 翻译用量汇总（P0-B-10 AC4/AC8 / P1-B-16）：
   * - 团队级：累计已用 / 配额总量 / 剩余 / 是否耗尽
   * - 按密钥分布（P1）：每个密钥的翻译用量
   * - 按引擎 Key 分布：每个翻译 Key 的用量 / 额度 / 近 24h 统计
   */
  async getTranslationUsage(teamId: string) {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        translationQuota: true,
        translationUsed: true,
        status: true,
      },
    });
    if (!team) return null;

    const isExhausted = team.translationUsed >= team.translationQuota;
    const remaining = Math.max(team.translationQuota - team.translationUsed, 0);

    // 按密钥（LicenseKey）分布（P1-B-16 AC1/AC2）—— 即原型「按客服分布」
    const perKeyUsage = await this.getPerLicenseKeyUsage(teamId);

    // 按翻译引擎 Key 分布（平台级共享资源，不按团队隔离）
    const perEngineKey = await this.getPerEngineKeyUsage();

    // 近 24h 统计
    const since24h = new Date(Date.now() - WINDOW_24H_MS);
    const agg24h = await prisma.translationUsageLog.aggregate({
      where: { teamId, createdAt: { gte: since24h } },
      _sum: { chars: true },
      _count: { _all: true },
    });

    // 顶部统计卡片（累计已用 / 配额总量 / 剩余可用 / 已使用比例）
    const usedPercent =
      team.translationQuota > 0
        ? Number(((team.translationUsed / team.translationQuota) * 100).toFixed(1))
        : 0;
    const topStats = {
      used: team.translationUsed,
      quota: team.translationQuota,
      remaining,
      usedPercent,
    };

    // 按客服分布：在 perKeyUsage 基础上补充「占比」（相对团队累计已用）
    const denom = team.translationUsed > 0 ? team.translationUsed : 1;
    const byCustomer = perKeyUsage.map((k) => ({
      ...k,
      ratio: Number(((k.chars / denom) * 100).toFixed(1)),
    }));

    return {
      team: {
        id: team.id,
        name: team.name,
        status: team.status,
        translationUsed: team.translationUsed,
        translationQuota: team.translationQuota,
        remaining,
        isExhausted,
        // AC8：已耗尽展示阻断说明
        ...(isExhausted
          ? { exhaustedMessage: '翻译配额已耗尽，请联系管理员调大配额' }
          : {}),
      },
      usage24h: {
        calls: agg24h._count._all,
        chars: agg24h._sum.chars ?? 0,
      },
      topStats,
      perLicenseKey: byCustomer,
      perEngineKey,
      timezone: TIMEZONE,
    };
  }

  /** 按密钥（LicenseKey）维度的翻译用量分布（P1-B-16） */
  private async getPerLicenseKeyUsage(teamId: string) {
    const keys = await prisma.licenseKey.findMany({
      where: { teamId },
      select: { id: true, nickname: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    if (keys.length === 0) return [];

    // 批量查询每个密钥的翻译用量
    const usages = await prisma.translationUsageLog.groupBy({
      by: ['licenseKeyId'],
      where: {
        teamId,
        licenseKeyId: { not: null },
      },
      _sum: { chars: true },
      _count: { _all: true },
    });
    const usageMap = new Map(usages.map((u) => [u.licenseKeyId, u]));

    return keys.map((k) => {
      const u = usageMap.get(k.id);
      return {
        keyId: k.id,
        keyNickname: k.nickname,
        keyStatus: k.status,
        chars: u?._sum.chars ?? 0,
        calls: u?._count._all ?? 0,
      };
    });
  }

  /** 按翻译引擎 Key 维度的用量分布（P0-S-12 AC13/AC16，平台级共享资源） */
  private async getPerEngineKeyUsage() {
    const keys = await prisma.translationKey.findMany({
      orderBy: [{ engine: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        engine: true,
        name: true,
        status: true,
        quotaLimit: true,
        quotaUsed: true,
        lastUsedAt: true,
        lastFailureReason: true,
      },
    });

    const since24h = new Date(Date.now() - WINDOW_24H_MS);

    return Promise.all(
      keys.map(async (k) => {
        const agg24h = await prisma.translationUsageLog.aggregate({
          where: { keyId: k.id, createdAt: { gte: since24h } },
          _sum: { chars: true },
          _count: { _all: true },
        });

        const remaining =
          k.quotaLimit == null ? null : Math.max(k.quotaLimit - k.quotaUsed, 0);

        return {
          id: k.id,
          engine: k.engine,
          name: k.name,
          status: k.status,
          quotaLimit: k.quotaLimit,
          quotaUsed: k.quotaUsed,
          remaining,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          lastFailureReason: k.lastFailureReason ?? null,
          usage24h: {
            calls: agg24h._count._all,
            chars: agg24h._sum.chars ?? 0,
          },
        };
      }),
    );
  }

  /**
   * 查询指定翻译 Key 的引擎侧真实用量（DeepL 月度额度）。
   * 供管理后台 Key 详情页使用。
   */
  async getEngineKeyProviderUsage(keyId: string) {
    const key = await prisma.translationKey.findUnique({
      where: { id: keyId },
      select: { id: true, engine: true, name: true, keyEncrypted: true },
    });
    if (!key) return null;

    const apiKey = tryDecryptSecret(key.keyEncrypted, env.apiKeyEncKey);
    if (!apiKey) return { keyId, engine: key.engine, providerUsage: null };

    try {
      const provider = getProvider(key.engine);
      const usage = (await provider.getUsage?.(apiKey)) ?? null;
      return { keyId, engine: key.engine, providerUsage: usage };
    } catch {
      return { keyId, engine: key.engine, providerUsage: null };
    }
  }
}

export const usageService = new UsageService();
