import { TranslationEngine, TranslationKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { isLanguageSupported } from './langSupport';

/**
 * 引擎双层选路 + 引擎内多 Key 选路（T4-03 / backend §7.2 / §7.3）
 *
 * 第一层（选引擎）：A = 存在可用 Key 的引擎；S = 按 EngineLanguageSupport 查 targetLang；
 *   C = A ∩ S。C 空且 A 空 → TRANSLATION_SERVICE_UNAVAILABLE；A 非空但 C 空 → LANGUAGE_UNSUPPORTED。
 *   C 非空 → 随机选一个引擎（不配比、不设优先级，PRD NG-11）；仅单引擎支持 → 直接路由该引擎（AC12）。
 * 第二层（选 Key）：该引擎下所有 ACTIVE 且额度未耗尽的 Key，按「剩余额度加权随机 + 最近失败避让」选择。
 */

/** 最近失败避让窗口（5 分钟，backend §7.3） */
const FAILURE_AVOID_WINDOW_MS = 5 * 60 * 1000;
/** 无额度上限 Key 的占位权重 */
const UNLIMITED_WEIGHT = 1_000_000;

/** 进程内 Key 健康度（仅在实例生命周期内有效；用于失败避让与近窗失败统计，不持久化） */
interface KeyHealth {
  /** 失败时间戳数组（用于近窗口失败次数统计） */
  failures: number[];
}
const keyHealth = new Map<string, KeyHealth>();

/** 记录某 Key 最近一次失败（transient 或 key 级错误都计入避让与失败统计） */
export function recordKeyFailure(keyId: string): void {
  const h = keyHealth.get(keyId) ?? { failures: [] };
  h.failures.push(Date.now());
  keyHealth.set(keyId, h);
}

/** 记录某 Key 成功（清零失败计数，避免长期被避让） */
export function recordKeySuccess(keyId: string): void {
  keyHealth.delete(keyId);
}

/** 近 windowMs 内的失败次数（T4-07 用量展示） */
export function recentFailureCount(keyId: string, windowMs: number): number {
  const h = keyHealth.get(keyId);
  if (!h) return 0;
  const cutoff = Date.now() - windowMs;
  return h.failures.filter((t) => t > cutoff).length;
}

function isKeyAvoided(keyId: string): boolean {
  const h = keyHealth.get(keyId);
  if (!h || h.failures.length === 0) return false;
  const last = h.failures[h.failures.length - 1];
  return Date.now() - last <= FAILURE_AVOID_WINDOW_MS;
}

/**
 * 选路第一层：根据目标语言选出候选引擎列表（随机打乱，单引擎则直接置顶）。
 * 不含 Key 级选择失败——仅做「引擎是否可用 + 语种是否支持」判定。
 */
export async function selectEnginesForTranslate(targetLang: string): Promise<TranslationEngine[]> {
  const activeKeys = await prisma.translationKey.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, engine: true, quotaLimit: true, quotaUsed: true },
  });

  // 可用 Key：ACTIVE 且额度未耗尽
  const usableByEngine = new Map<TranslationEngine, number>();
  for (const k of activeKeys) {
    const usable = k.quotaLimit == null || k.quotaUsed < k.quotaLimit;
    if (!usable) continue;
    usableByEngine.set(k.engine, (usableByEngine.get(k.engine) ?? 0) + 1);
  }

  // A：存在可用 Key 的引擎
  const availableEngines = [...usableByEngine.keys()];
  if (availableEngines.length === 0) {
    // 没有任何可用 Key（全部未配置/禁用/失效/耗尽）
    throw AppError.of(
      503,
      ErrorCode.TRANSLATION_SERVICE_UNAVAILABLE,
      '翻译服务不可用：未配置任何可用的翻译引擎 Key，请联系管理员',
    );
  }

  // S ∩ A：支持目标语言且有可用 Key 的引擎
  const candidates: TranslationEngine[] = [];
  for (const engine of availableEngines) {
    const supported = await isLanguageSupported(engine, targetLang);
    if (supported) candidates.push(engine);
  }

  if (candidates.length === 0) {
    // 区分：是「语言本身两引擎都不支持」还是「支持的引擎没有可用 Key」
    const anySupported = await anyEngineSupports(targetLang);
    if (anySupported) {
      throw AppError.of(
        503,
        ErrorCode.TRANSLATION_SERVICE_UNAVAILABLE,
        `翻译服务不可用：支持语言「${targetLang}」的引擎当前没有可用 Key，请联系管理员`,
      );
    }
    throw AppError.of(
      400,
      ErrorCode.LANGUAGE_UNSUPPORTED,
      `翻译引擎不支持目标语言「${targetLang}」`,
    );
  }

  // 随机打乱（多引擎时不在两者间配比，P0-S-12 AC3/AC8；单引擎保持原序）
  return shuffle(candidates);
}

/** 是否存在任一引擎支持该语言（用于错误归因） */
async function anyEngineSupports(targetLang: string): Promise<boolean> {
  for (const engine of [TranslationEngine.GOOGLE, TranslationEngine.DEEPL]) {
    if (await isLanguageSupported(engine, targetLang)) return true;
  }
  return false;
}

/**
 * 选路第二层：在指定引擎下按「剩余额度加权随机 + 最近失败避让」选择一个可用 Key。
 * 返回选中的 Key（含密文），无可用 Key 返回 null。
 */
export async function selectKey(engine: TranslationEngine): Promise<TranslationKey | null> {
  const keys = await prisma.translationKey.findMany({
    where: {
      engine,
      status: 'ACTIVE',
    },
  });

  const usable = keys.filter(
    (k) => (k.quotaLimit == null || k.quotaUsed < k.quotaLimit) && !isKeyAvoided(k.id),
  );
  if (usable.length === 0) return null;

  // 加权随机：权重 = 剩余额度（额度无上限用占位值）
  const weights = usable.map((k) => {
    const remaining = k.quotaLimit == null ? UNLIMITED_WEIGHT : Math.max(k.quotaLimit - k.quotaUsed, 0);
    return remaining;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // 全部剩余额度为 0（理论不会到这，因已过滤 quotaUsed<quotaLimit）：退回均匀随机
    return usable[Math.floor(Math.random() * usable.length)];
  }
  let r = Math.random() * total;
  for (let i = 0; i < usable.length; i++) {
    r -= weights[i];
    if (r <= 0) return usable[i];
  }
  return usable[usable.length - 1];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
