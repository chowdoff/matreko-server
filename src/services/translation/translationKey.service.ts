import { AdminAccount, TranslationEngine, TranslationKeyStatus, LangSupportStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto';
import { AppError } from '@/utils/AppError';
import { writeAuditLog, AuditAction } from '@/services/audit.service';
import { getProvider } from '@/services/translation/providerRegistry';
import { TranslationProviderError } from '@/services/translation/errors';
import { ProviderUsage } from '@/services/translation/types';
import { recentFailureCount } from '@/services/translation/router';
import { setLanguageSupport } from '@/services/translation/langSupport';

/** 近 24h 失败统计窗口（T4-07 AC13） */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CreateTranslationKeyInput {
  engine: TranslationEngine;
  name: string;
  /** 明文 API Key（仅本次用于连通性校验，存储时加密，P0-S-12 AC5） */
  apiKey: string;
  /** 额度上限（字符），null = 不限额度 */
  quotaLimit?: number | null;
}

export interface UpdateTranslationKeyInput {
  name?: string;
  quotaLimit?: number | null;
}

/**
 * 翻译 API Key 管理（T4-06 / T4-07 / P0-S-12）
 *
 * - 添加：保存时连通性校验（仅「Key 无效」硬拒；网络/引擎侧异常放行并提示，避免离线开发被阻断）
 * - 存储：AES-256-GCM 加密（API_KEY_ENC_KEY），响应永远只返回掩码
 * - 无删除：仅停用/启用（DISABLED ↔ ACTIVE），历史用量保留
 * - 列表：掩码 + 状态 + 实时用量 + 近 24h 统计 + 单 Key/单引擎风险提示
 */
export class TranslationKeyService {
  /**
   * 添加翻译 Key（P0-S-12 AC1/AC4）：
   * 保存前用明文 Key 发起一次连通性校验；仅 Key 无效（AUTH/QUOTA/CONTENT/PARAM）硬拒；
   * 网络/引擎侧异常放行并带 connectivityWarning（离线开发可用）。
   */
  async createTranslationKey(
    input: CreateTranslationKeyInput,
    actor: AdminAccount,
    ip?: string,
  ) {
    if (!input.apiKey || input.apiKey.trim().length === 0) {
      throw AppError.badRequest('API Key 不能为空');
    }
    if (input.quotaLimit != null && (!Number.isInteger(input.quotaLimit) || input.quotaLimit < 0)) {
      throw AppError.badRequest('额度上限必须为非负整数', { field: 'quotaLimit' });
    }

    const connectivity = await this.testKey(input.engine, input.apiKey);
    if (!connectivity.ok && connectivity.hardFail) {
      throw AppError.badRequest(
        `翻译 Key 校验失败：${connectivity.message}`,
        { kind: connectivity.kind },
      );
    }

    const keyEncrypted = encryptSecret(input.apiKey.trim(), env.apiKeyEncKey);
    const key = await prisma.translationKey.create({
      data: {
        engine: input.engine,
        name: input.name,
        keyEncrypted,
        quotaLimit: input.quotaLimit ?? null,
        status: TranslationKeyStatus.ACTIVE,
        ...(connectivity.warning ? { lastFailureReason: connectivity.warning } : {}),
      },
    });

    await writeAuditLog({
      actorType: 'PLATFORM',
      actorId: actor.id,
      action: AuditAction.TRANSLATION_KEY_ADDED,
      detail: { keyId: key.id, engine: key.engine, name: key.name, connectivity: connectivity.ok ? 'ok' : 'warning' },
      ip,
    });

    return {
      id: key.id,
      engine: key.engine,
      name: key.name,
      status: key.status,
      quotaLimit: key.quotaLimit,
      quotaUsed: key.quotaUsed,
      maskedKey: maskKey(input.apiKey.trim()),
      createdAt: key.createdAt.toISOString(),
      // 引擎侧月度真实额度（DeepL 支持，Google 无），与自管 quotaUsed 分开标注
      providerUsage: connectivity.usage ?? null,
      ...(connectivity.warning ? { connectivityWarning: connectivity.warning } : {}),
    };
  }

  /** 翻译 Key 连通性校验（T4-06 AC4）：仅做真实调用，不对 DB 写入。
   *  同时并行尝试获取引擎侧真实用量（DeepL /v2/usage），用于校验 Key 有效性 + 展示月度额度。
   *  用量查询失败不影响主校验结果（connectivity.ok 仍为 true）。 */
  async testKey(engine: TranslationEngine, apiKey: string): Promise<{
    ok: boolean;
    hardFail: boolean;
    warning?: string;
    kind?: string;
    message?: string;
    usage?: ProviderUsage | null;
  }> {
    try {
      const provider = getProvider(engine);
      // 并行：翻译校验 + 引擎侧用量查询（getUsage 失败不阻断主校验）
      const [translated, usage] = await Promise.all([
        provider.translate({ text: 'Hello', targetLang: 'zh' }, apiKey),
        provider.getUsage?.(apiKey).catch(() => null),
      ]);
      void translated; // 翻译成功即可，结果不关心
      return { ok: true, hardFail: false, usage: usage ?? null };
    } catch (err) {
      const perr = err as TranslationProviderError;
      // Key 本身无效（AUTH/QUOTA/CONTENT/PARAM）→ 硬拒
      if (perr.keyUnavailable || perr.kind === 'CONTENT' || perr.kind === 'PARAM') {
        return { ok: false, hardFail: true, kind: perr.kind, message: perr.message };
      }
      // 网络/引擎侧异常 → 放行并提示（离线开发可用）
      return { ok: false, hardFail: false, kind: perr.kind, warning: `连通性校验未通过（可能为网络/引擎侧异常）：${perr.message}` };
    }
  }

  /** Key 列表（P0-S-12 AC2/AC13/AC14/AC16）：掩码 + 用量 + 近 24h + 风险提示 */
  async listTranslationKeys(filter?: { status?: TranslationKeyStatus }) {
    const keys = await prisma.translationKey.findMany({
      where: filter?.status ? { status: filter.status } : undefined,
      orderBy: [{ engine: 'asc' }, { createdAt: 'desc' }],
    });

    const items = await Promise.all(keys.map((k) => this.toListItem(k)));

    // 引擎级聚合 + 风险提示（AC10/AC11）
    const engineAgg = this.aggregateByEngine(keys);
    const riskHints = this.buildRiskHints(keys, engineAgg);

    // 顶部 4 张统计卡片（T4-06 / 管理后台 §3.4）
    const topStats = await this.computeTopStats(keys);

    return { items, engineAgg, riskHints, topStats };
  }

  /** 单个 Key 详情（含掩码与用量 + 引擎侧真实额度） */
  async getTranslationKey(id: string) {
    const key = await prisma.translationKey.findUnique({ where: { id } });
    if (!key) throw AppError.notFound('翻译 Key 不存在');
    const item = await this.toListItem(key);
    // 详情页额外查询引擎侧真实用量（DeepL /v2/usage）
    const providerUsage = await this.fetchProviderUsage(key.engine, key.keyEncrypted);
    return { ...item, providerUsage };
  }

  /** 修改 Key（名称 / 额度上限，P0-S-12 AC16 进度可视依赖 quotaLimit） */
  async updateTranslationKey(id: string, input: UpdateTranslationKeyInput, actor: AdminAccount, ip?: string) {
    const key = await prisma.translationKey.findUnique({ where: { id } });
    if (!key) throw AppError.notFound('翻译 Key 不存在');
    if (input.quotaLimit != null && (!Number.isInteger(input.quotaLimit) || input.quotaLimit < 0)) {
      throw AppError.badRequest('额度上限必须为非负整数', { field: 'quotaLimit' });
    }

    const data: { name?: string; quotaLimit?: number | null } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.quotaLimit !== undefined) data.quotaLimit = input.quotaLimit;

    const updated = await prisma.translationKey.update({ where: { id }, data });
    await writeAuditLog({
      actorType: 'PLATFORM',
      actorId: actor.id,
      action: AuditAction.TRANSLATION_KEY_UPDATED,
      detail: { keyId: id, changes: data },
      ip,
    });

    return {
      id: updated.id,
      engine: updated.engine,
      name: updated.name,
      status: updated.status,
      quotaLimit: updated.quotaLimit,
      quotaUsed: updated.quotaUsed,
    };
  }

  /** 停用 / 启用（P0-S-12 AC14：停用可逆、历史保留；无删除） */
  async setKeyStatus(id: string, status: TranslationKeyStatus, actor: AdminAccount, ip?: string) {
    const key = await prisma.translationKey.findUnique({ where: { id } });
    if (!key) throw AppError.notFound('翻译 Key 不存在');
    if (key.status === status) {
      return { alreadyInState: true, id, status };
    }
    const updated = await prisma.translationKey.update({
      where: { id },
      data: { status, ...(status === TranslationKeyStatus.ACTIVE ? { lastFailureReason: null } : {}) },
    });
    await writeAuditLog({
      actorType: 'PLATFORM',
      actorId: actor.id,
      action: AuditAction.TRANSLATION_KEY_STATUS_CHANGED,
      detail: { keyId: id, from: key.status, to: status },
      ip,
    });
    return { id: updated.id, status: updated.status };
  }

  /** 近 24h 用量统计（T4-07 AC13 / §8.3），含引擎侧真实额度（DeepL 月度） */
  async getKeyUsage(id: string) {
    const key = await prisma.translationKey.findUnique({ where: { id } });
    if (!key) throw AppError.notFound('翻译 Key 不存在');

    const since = new Date(Date.now() - FAILURE_WINDOW_MS);
    const [agg, failures24h, providerUsage] = await Promise.all([
      prisma.translationUsageLog.aggregate({
        where: { keyId: id, createdAt: { gte: since } },
        _sum: { chars: true },
        _count: { _all: true },
      }),
      Promise.resolve(recentFailureCount(id, FAILURE_WINDOW_MS)),
      this.fetchProviderUsage(key.engine, key.keyEncrypted),
    ]);

    return {
      id: key.id,
      engine: key.engine,
      name: key.name,
      quotaLimit: key.quotaLimit,
      quotaUsed: key.quotaUsed,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      lastFailureReason: key.lastFailureReason ?? null,
      // 引擎侧月度真实额度（DeepL 支持，Google 返回 null），与自管 quotaUsed 分开标注
      providerUsage,
      usage24h: {
        calls: agg._count._all,
        chars: agg._sum.chars ?? 0,
        failures: failures24h,
      },
      timezone: 'Asia/Shanghai',
    };
  }

  /** 引擎语种支持维护（P0-S-12 AC12 / T4-04）：手动增/改/删支持状态 */
  async setLanguageSupportStatus(engine: TranslationEngine, languageCode: string, status: LangSupportStatus, actor: AdminAccount, ip?: string) {
    await setLanguageSupport(engine, languageCode, status);
    await writeAuditLog({
      actorType: 'PLATFORM',
      actorId: actor.id,
      action: AuditAction.LANG_SYNC,
      detail: { engine, languageCode: languageCode.toLowerCase(), status },
      ip,
    });
    return { engine, languageCode: languageCode.toLowerCase(), status };
  }

  /** 语种支持列表（管理后台维护页读取） */
  async listLanguageSupport() {
    const rows = await prisma.engineLanguageSupport.findMany({ orderBy: [{ engine: 'asc' }, { languageCode: 'asc' }] });
    return rows.map((r) => ({
      engine: r.engine,
      languageCode: r.languageCode,
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  // ── 内部工具 ──

  /** 查询引擎侧真实用量（DeepL 支持，Google 返回 null） */
  private async fetchProviderUsage(
    engine: TranslationEngine,
    keyEncrypted: string,
  ): Promise<ProviderUsage | null> {
    const apiKey = tryDecryptSecret(keyEncrypted, env.apiKeyEncKey);
    if (!apiKey) return null;
    try {
      const provider = getProvider(engine);
      return (await provider.getUsage?.(apiKey)) ?? null;
    } catch {
      // 用量查询失败不阻断，返回 null
      return null;
    }
  }

  private async toListItem(k: {
    id: string;
    engine: TranslationEngine;
    name: string;
    keyEncrypted: string;
    status: TranslationKeyStatus;
    quotaLimit: number | null;
    quotaUsed: number;
    lastFailureReason: string | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }) {
    const since = new Date(Date.now() - FAILURE_WINDOW_MS);
    const agg = await prisma.translationUsageLog.aggregate({
      where: { keyId: k.id, createdAt: { gte: since } },
      _sum: { chars: true },
      _count: { _all: true },
    });
    // 掩码：解密失败（历史异常）时返回 null（AC5 常驻回归：绝不出现明文）
    const plain = tryDecryptSecret(k.keyEncrypted, env.apiKeyEncKey);
    return {
      id: k.id,
      engine: k.engine,
      name: k.name,
      status: k.status,
      maskedKey: plain ? maskKey(plain) : null,
      quotaLimit: k.quotaLimit,
      quotaUsed: k.quotaUsed,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      lastFailureReason: k.lastFailureReason ?? null,
      usage24h: {
        calls: agg._count._all,
        chars: agg._sum.chars ?? 0,
        failures: recentFailureCount(k.id, FAILURE_WINDOW_MS),
      },
      createdAt: k.createdAt.toISOString(),
    };
  }

  private aggregateByEngine(keys: { engine: TranslationEngine; status: TranslationKeyStatus }[]) {
    const map = new Map<TranslationEngine, { total: number; active: number }>();
    for (const k of keys) {
      const e = map.get(k.engine) ?? { total: 0, active: 0 };
      e.total += 1;
      if (k.status === TranslationKeyStatus.ACTIVE) e.active += 1;
      map.set(k.engine, e);
    }
    return [...map.entries()].map(([engine, v]) => ({ engine, ...v }));
  }

  private buildRiskHints(
    keys: { engine: TranslationEngine; status: TranslationKeyStatus }[],
    engineAgg: { engine: TranslationEngine; total: number; active: number }[],
  ): string[] {
    const hints: string[] = [];
    // 单 Key 风险：某引擎仅 1 个 ACTIVE Key
    for (const e of engineAgg) {
      if (e.active === 1) {
        hints.push(`引擎 ${e.engine} 仅配置 1 个可用 Key，一旦耗尽或失效整个引擎立即不可用`);
      }
    }
    // 单引擎风险：仅一个引擎有任意 Key 配置
    const enginesWithKeys = new Set(keys.map((k) => k.engine));
    if (enginesWithKeys.size === 1) {
      hints.push('仅配置了一个翻译引擎，不具备引擎间自动切换能力');
    }
    return hints;
  }

  /**
   * 顶部 4 张统计卡片：
   *  - 可用 Key：ACTIVE / 总 Key
   *  - 近 24 小时调用：TranslationUsageLog + audit translation_failed
   *  - 可用 Key 剩余额度：sum(quotaLimit - quotaUsed) ACTIVE
   *  - 引擎可用性：每个引擎是否有至少一个 ACTIVE 且未耗尽的 Key
   */
  private async computeTopStats(
    allKeys: { id: string; engine: TranslationEngine; status: TranslationKeyStatus; quotaLimit: number | null; quotaUsed: number }[],
  ) {
    const activeKeys = allKeys.filter((k) => k.status === TranslationKeyStatus.ACTIVE);
    const total = allKeys.length;
    const active = activeKeys.length;

    // 可用 Key 剩余额度（仅 ACTIVE 且有上限）
    const remaining = activeKeys
      .filter((k) => k.quotaLimit != null)
      .reduce((s, k) => s + Math.max((k.quotaLimit ?? 0) - k.quotaUsed, 0), 0);

    // 近 24h 调用 = success logs + failures
    const since = new Date(Date.now() - FAILURE_WINDOW_MS);
    const [successAgg, failureCount] = await Promise.all([
      prisma.translationUsageLog.aggregate({
        where: { createdAt: { gte: since } },
        _sum: { chars: true },
        _count: { _all: true },
      }),
      prisma.auditLog.count({
        where: {
          action: AuditAction.TRANSLATION_FAILED,
          createdAt: { gte: since },
        },
      }),
    ]);

    // 引擎可用性
    const engines: TranslationEngine[] = ['GOOGLE', 'DEEPL'];
    const engineAvailability = engines.map((engine) => {
      const ek = activeKeys.filter((k) => k.engine === engine);
      const usable = ek.some((k) => k.quotaLimit == null || k.quotaUsed < (k.quotaLimit ?? Infinity));
      return {
        engine,
        available: usable && ek.length > 0,
        activeKeyCount: ek.length,
      };
    });

    return {
      availableKeys: { active, total, note: '停用 / 耗尽 / 失败的不计入' },
      calls24h: {
        total: successAgg._count._all + failureCount,
        failures: failureCount,
        failureRate: successAgg._count._all + failureCount > 0
          ? (failureCount / (successAgg._count._all + failureCount)) * 100
          : 0,
      },
      remainingQuota: { chars: remaining, unit: '字符' },
      engineAvailability,
      windowHours: 24,
      timezone: 'Asia/Shanghai',
    };
  }
}

/** Key 掩码（P0-S-12 AC2/AC5 常驻回归：任何响应不得出现明文或可反推片段） */
export function maskKey(plain: string): string {
  if (plain.length <= 8) return '****';
  return `${plain.slice(0, 4)}***${plain.slice(-4)}`;
}

export const translationKeyService = new TranslationKeyService();
