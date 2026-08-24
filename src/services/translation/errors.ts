/**
 * 翻译引擎适配层错误（T4-01 / backend §7.1 / §7.5）
 *
 * 统一把引擎 HTTP 调用结果归类为「可重试」与「不可重试」两类：
 * - 可重试（retryable=true）：429 / 5xx / 网络中断 / 超时 —— 引擎层自动换 Key 重试一次，失败则客户端按 P0-T-08 自动重试
 * - 不可重试（retryable=false）：API Key 无效 / Key 额度耗尽 / 内容被引擎拒绝 / 参数非法 —— 直接终态失败（P0-T-08 AC3）
 *
 * 错误 kind 用于服务端路由层决策（换 Key / 换引擎 / 直接返回终态失败）。
 */
export type ProviderErrorKind =
  | 'AUTH' // Key 无效（DeepL 403 / Google keyInvalid）
  | 'QUOTA' // 该 Key 额度耗尽（DeepL 456 / Google quotaExceeded）
  | 'RATE_LIMIT' // 429
  | 'SERVER' // 5xx
  | 'NETWORK' // 网络中断 / 超时 / DNS
  | 'CONTENT' // 内容被引擎拒绝
  | 'PARAM'; // 参数非法（非 Key 问题）

export interface TranslationProviderErrorPayload {
  kind: ProviderErrorKind;
  retryable: boolean;
  message: string;
  /** HTTP 状态码（若有），用于归因 */
  status?: number;
}

export class TranslationProviderError extends Error {
  kind: ProviderErrorKind;
  retryable: boolean;
  status?: number;

  constructor(payload: TranslationProviderErrorPayload) {
    super(payload.message);
    this.name = 'TranslationProviderError';
    this.kind = payload.kind;
    this.retryable = payload.retryable;
    this.status = payload.status;
    Object.setPrototypeOf(this, TranslationProviderError.prototype);
  }

  /** 该 Key 已彻底不可用（无效 / 额度耗尽），应从可用集移除 */
  get keyUnavailable(): boolean {
    return this.kind === 'AUTH' || this.kind === 'QUOTA';
  }
}

/** 引擎单次调用超时（backend §7.5：超时归类可重试） */
export const TRANSLATE_TIMEOUT_MS = 12_000;
