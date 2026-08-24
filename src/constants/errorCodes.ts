/**
 * 业务错误码枚举（backend §7.5 / §10）
 *
 * 错误响应统一结构：{ success: false, error: { code, message, details? } }
 * 客户端/前端依据 code 做可区分处理，message 面向用户展示。
 */
export const ErrorCode = {
  // ── 通用 ──
  PARAM_INVALID: 'PARAM_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // ── 认证（P0-A-02） ──
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** 凭据签名无效 / 已被篡改 */
  AUTH_INVALID: 'AUTH_INVALID',
  /** 凭据已过期 */
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  /** 凭据类型不符（后台凭据调客户端接口等，P0-A-19 AC17） */
  TOKEN_TYPE_MISMATCH: 'TOKEN_TYPE_MISMATCH',
  /** 凭据已撤销（续期轮换后超宽限期 / 主动吊销） */
  CREDENTIAL_REVOKED: 'CREDENTIAL_REVOKED',
  /** 硬件指纹不匹配（P0-A-02 AC9） */
  FINGERPRINT_MISMATCH: 'FINGERPRINT_MISMATCH',
  /** 单客户端限流（P0-A-02 AC10） */
  RATE_LIMITED: 'RATE_LIMITED',

  // ── 后台账号（P0-A-19） ──
  /** 邮箱或密码错误（统一提示，防枚举 AC6） */
  EMAIL_OR_PASSWORD_INVALID: 'EMAIL_OR_PASSWORD_INVALID',
  /** 账号锁定中（AC7），携带 lockRemainingMs */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  /** 账号已禁用（AC11） */
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  /** 团队被禁用 / 已到期，主管无法登录（AC12） */
  TEAM_UNAVAILABLE: 'TEAM_UNAVAILABLE',

  // ── 密钥 / 激活（P0-A-01 / P0-B-09） ──
  /** 密钥不存在（AC4） */
  KEY_INVALID: 'KEY_INVALID',
  /** 密钥已禁用（AC5） */
  KEY_DISABLED: 'KEY_DISABLED',
  /** 同 (keyId, fingerprint) 重复激活（AC10） */
  KEY_ALREADY_ACTIVATED: 'KEY_ALREADY_ACTIVATED',
  /** 未开多开且已有绑定（AC8） */
  KEY_ACTIVATED_ON_OTHER_DEVICE: 'KEY_ACTIVATED_ON_OTHER_DEVICE',
  /** 已达设备数上限 5 台（AC9） */
  DEVICE_LIMIT_REACHED: 'DEVICE_LIMIT_REACHED',
  /** 并发操作状态已变更（P0-B-09 AC12） */
  STATUS_CHANGED: 'STATUS_CHANGED',

  // ── 团队 ──
  TEAM_DISABLED: 'TEAM_DISABLED',
  TEAM_EXPIRED: 'TEAM_EXPIRED',

  // ── 端口租约（P0-C-20） ──
  /** 端口已用尽（AC7 服务端侧） */
  PORT_EXHAUSTED: 'PORT_EXHAUSTED',

  // ── 翻译（P0-S-12 / P0-T-07） ──
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  TRANSLATION_SERVICE_UNAVAILABLE: 'TRANSLATION_SERVICE_UNAVAILABLE',
  LANGUAGE_UNSUPPORTED: 'LANGUAGE_UNSUPPORTED',
  API_KEY_INVALID: 'API_KEY_INVALID',
  CONTENT_REJECTED: 'CONTENT_REJECTED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
