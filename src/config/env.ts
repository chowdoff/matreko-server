import dotenv from 'dotenv';

dotenv.config();

function toInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，当前值: ${value}`);
  }
  return n;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`缺少必填环境变量 ${name}，请检查 .env 配置`);
  }
  return value.trim();
}

export const env = {
  port: toInt(process.env.PORT, 3000, 'PORT'),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV === 'development',
  isProd: process.env.NODE_ENV === 'production',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',

  // ── 认证（backend §12） ──
  /** access token 有效期（毫秒），默认 15 分钟 */
  accessTokenTtlMs: toInt(process.env.ACCESS_TOKEN_TTL, 15 * 60 * 1000, 'ACCESS_TOKEN_TTL'),
  /** refresh token 有效期（毫秒），默认 24 小时 */
  refreshTokenTtlMs: toInt(process.env.REFRESH_TOKEN_TTL, 24 * 60 * 60 * 1000, 'REFRESH_TOKEN_TTL'),
  /** 续期无缝轮换宽限期（毫秒），默认 60 秒 */
  tokenRenewGraceMs: toInt(process.env.TOKEN_RENEW_GRACE_MS, 60 * 1000, 'TOKEN_RENEW_GRACE_MS'),
  /** 密钥/团队状态缓存 TTL（毫秒），默认 60 秒 */
  keyStatusCacheTtlMs: toInt(process.env.KEY_STATUS_CACHE_TTL_MS, 60 * 1000, 'KEY_STATUS_CACHE_TTL_MS'),
  /** 后台会话有效期（毫秒），默认 30 分钟；采用滑动续期——每次通过鉴权的 API 调用都刷新过期时间 */
  backofficeSessionTtlMs: toInt(process.env.BACKOFFICE_SESSION_TTL, 30 * 60 * 1000, 'BACKOFFICE_SESSION_TTL'),

  // ── 限流（backend §4.5） ──
  rateLimitTranslateCap: toInt(process.env.RATE_LIMIT_TRANSLATE_CAP, 20, 'RATE_LIMIT_TRANSLATE_CAP'),
  rateLimitTranslateRate: toInt(process.env.RATE_LIMIT_TRANSLATE_RATE, 20, 'RATE_LIMIT_TRANSLATE_RATE'),
  rateLimitOtherCap: toInt(process.env.RATE_LIMIT_OTHER_CAP, 50, 'RATE_LIMIT_OTHER_CAP'),
  rateLimitOtherRate: toInt(process.env.RATE_LIMIT_OTHER_RATE, 50, 'RATE_LIMIT_OTHER_RATE'),
  rateLimitActivateCap: toInt(process.env.RATE_LIMIT_ACTIVATE_CAP, 5, 'RATE_LIMIT_ACTIVATE_CAP'),
  rateLimitActivateRate: toInt(process.env.RATE_LIMIT_ACTIVATE_RATE, 1, 'RATE_LIMIT_ACTIVATE_RATE'),

  // ── 端口租约（backend §6.1） ──
  heartbeatIntervalMs: toInt(process.env.HEARTBEAT_INTERVAL, 2 * 60 * 1000, 'HEARTBEAT_INTERVAL'),
  leaseTtlMs: toInt(process.env.LEASE_TTL, 24 * 60 * 60 * 1000, 'LEASE_TTL'),
  leaseScanIntervalMs: toInt(process.env.LEASE_SCAN_INTERVAL, 60 * 1000, 'LEASE_SCAN_INTERVAL'),

  // ── 翻译（backend §7.6） ──
  engineMaxChars: toInt(process.env.ENGINE_MAX_CHARS, 5000, 'ENGINE_MAX_CHARS'),
  chunkSize: toInt(process.env.CHUNK_SIZE, 4500, 'CHUNK_SIZE'),
  langSyncCron: process.env.LANG_SYNC_CRON || '0 4 * * *',

  // ── 登录锁定（P0-A-19 AC7） ──
  loginLockThreshold: toInt(process.env.LOGIN_LOCK_THRESHOLD, 10, 'LOGIN_LOCK_THRESHOLD'),
  loginLockMs: toInt(process.env.LOGIN_LOCK_MS, 30 * 60 * 1000, 'LOGIN_LOCK_MS'),

  // ── 部署初始化（P0-A-19 AC1） ──
  platformEmail: requireEnv('PLATFORM_EMAIL'),
  platformInitialPassword: requireEnv('PLATFORM_INITIAL_PASSWORD'),

  // ── 加密密钥（backend §10） ──
  apiKeyEncKey: requireEnv('API_KEY_ENC_KEY'),
  jwtSecret: requireEnv('JWT_SECRET'),
  /** 密钥码 AES-256-GCM 加解密主密钥（32 字节 base64） */
  licenseCodeEncKey: requireEnv('LICENSE_CODE_ENC_KEY'),
} as const;
