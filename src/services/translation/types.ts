import { TranslationEngine } from '@prisma/client';
import { TranslationProviderError } from './errors';

/** 引擎单次调用上限（backend §7.6），超出需分片 */
export const ENGINE_MAX_CHARS = 5000;

export interface TranslateParams {
  /** 待翻译原文 */
  text: string;
  /** 目标语言（ISO 639-1 小写，如 zh / en / ja） */
  targetLang: string;
  /** 源语言（可选，不传则引擎自动识别） */
  sourceLang?: string;
}

export interface TranslateResult {
  translatedText: string;
  detectedSourceLang?: string;
}

/**
 * 引擎侧真实用量（provider 返回，用于校准自管计数，如 DeepL /v2/usage）。
 * 与平台自管的 `quotaUsed`/`quotaLimit` 是两套数字，展示时需分开标注。
 */
export interface ProviderUsage {
  /** 当前计费周期已消耗字符 */
  characterCount: number;
  /** 当前计费周期上限；null = 无上限（如 DeepL Pro 未设 Cost Control） */
  characterLimit: number | null;
  /** 剩余 = characterLimit - characterCount；无上限时为 null */
  remaining: number | null;
  /** 引擎侧用量统计的截止时间（ISO），用于标注数据新鲜度 */
  fetchedAt: string;
}

/**
 * 翻译引擎适配层接口（backend §7.1）：
 * 统一入参 / 出参，内部负责语言代码归一化与错误归类。
 */
export interface TranslationProvider {
  readonly engine: TranslationEngine;
  /**
   * 执行单次翻译。
   * - 成功返回译文与检测到的源语言
   * - 失败抛出 TranslationProviderError（已归类 retryable / kind）
   * @param params 翻译参数
   * @param apiKey 该引擎下的明文 API Key（由服务端解密后传入）
   */
  translate(params: TranslateParams, apiKey: string): Promise<TranslateResult>;
  /**
   * 查询引擎侧真实用量（DeepL 支持；Google 无公开端点）。
   * 返回 null 表示该引擎无此能力；失败抛 TranslationProviderError（AUTH=Key 无效）。
   * 调用方应 `provider.getUsage?.(key).catch(() => null)` 兜底。
   */
  getUsage?(apiKey: string): Promise<ProviderUsage | null>;
}

/** 语言代码归一化：DeepL 使用大写（EN/ZH），Google 使用小写（en/zh） */
export function toGoogleLang(code: string): string {
  return code.toLowerCase();
}

export function toDeepLLang(code: string, forSource = false): string {
  // DeepL 目标语言大写；部分语言需明确变体（en→EN-GB, pt→PT-PT）。
  // 关键：source_lang 仅接受基础语言码（EN/PT），变体（EN-GB/PT-PT）会被拒绝。
  const base = code.toLowerCase();
  if (forSource) return base.toUpperCase();
  const overrides: Record<string, string> = { en: 'EN-GB', pt: 'PT-PT' };
  if (overrides[base]) return overrides[base];
  return base.toUpperCase();
}

export { TranslationProviderError };
