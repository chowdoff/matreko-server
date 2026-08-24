import { TTLCache } from '@/lib/cache';
import { env } from '@/config/env';
import { LicenseStatus, TeamStatus } from '@prisma/client';

/** 密钥 + 所属团队的状态缓存条目（鉴权链路 ④⑤ 共用一次查库） */
export interface KeyStatusCacheEntry {
  keyStatus: LicenseStatus;
  teamId: string;
  teamStatus: TeamStatus;
  /** 团队到期时刻（epoch 毫秒），判定是否已到期 */
  teamExpiresAt: number;
}

export interface TeamStatusCacheEntry {
  status: TeamStatus;
  expiresAt: number;
}

/** 密钥状态缓存（TTL 60s + 主动失效，禁用后 ≤5min 断权，P0-A-02 AC8） */
export const keyStatusCache = new TTLCache<KeyStatusCacheEntry>(env.keyStatusCacheTtlMs);

/** 团队状态缓存（配额变更 / 禁用后 1min 内生效，P0-B-10 AC5） */
export const teamStatusCache = new TTLCache<TeamStatusCacheEntry>(env.keyStatusCacheTtlMs);
