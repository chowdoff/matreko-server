import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';
import { sha256, hashFingerprint, generateSecret, randomToken } from '@/lib/crypto';
import { signClientAccessToken } from '@/lib/jwt';
import { keyStatusCache, KeyStatusCacheEntry } from '@/lib/caches';
import { env } from '@/config/env';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { writeAuditLog, AuditAction } from '@/services/audit.service';

/** 密钥 + 团队状态读取（鉴权链 ④⑤ 共用；TTL 60s 缓存 + 主动失效） */
export async function getKeyStatusWithCache(keyId: string): Promise<KeyStatusCacheEntry | null> {
  const cached = keyStatusCache.get(keyId);
  if (cached) return cached;

  const key = await prisma.licenseKey.findUnique({
    where: { id: keyId },
    include: { team: true },
  });
  if (!key || !key.team) return null;

  const entry: KeyStatusCacheEntry = {
    keyStatus: key.status,
    teamId: key.teamId,
    teamStatus: key.team.status,
    teamExpiresAt: key.team.expiresAt.getTime(),
  };
  keyStatusCache.set(keyId, entry);
  return entry;
}

export interface RenewInput {
  /** refresh token（Authorization: Bearer） */
  refreshToken: string;
  /** 设备指纹原始值（X-Device-Fingerprint 头） */
  fingerprint: string;
  /** 旧 access token（可选，续期时撤销其 jti 进入宽限期） */
  oldAccessToken?: string;
}

/**
 * 无缝续期（P0-A-02 AC2/AC3/AC12，backend §4.2）：
 * 校验 refresh 哈希 → 密钥/团队状态 → 指纹 → 原子轮换
 * （旧 access jti 入撤销名单(RENEWED, 60s 宽限期) → 签新 access → 删旧 refresh 插新记录）。
 */
export async function renewClientCredential(input: RenewInput, ip?: string) {
  const refreshTokenHash = sha256(input.refreshToken);
  const credential = await prisma.clientCredential.findUnique({
    where: { refreshTokenHash },
  });
  if (!credential) {
    throw AppError.unauthorized('凭据已失效，请重新激活', ErrorCode.CREDENTIAL_REVOKED);
  }

  // 状态检查（密钥禁用 / 团队不可用）
  const status = await getKeyStatusWithCache(credential.keyId);
  if (!status) throw AppError.unauthorized('凭据已失效', ErrorCode.CREDENTIAL_REVOKED);
  if (status.keyStatus !== 'UNUSED' && status.keyStatus !== 'ACTIVE') {
    throw AppError.forbidden('密钥已禁用，请联系主管', ErrorCode.KEY_DISABLED);
  }
  if (status.teamStatus === 'DISABLED') {
    throw AppError.forbidden('团队已不可用，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
  }
  if (status.teamExpiresAt <= Date.now()) {
    throw AppError.forbidden('团队已到期', ErrorCode.TEAM_UNAVAILABLE);
  }

  // refresh 本身过期（滑动续期，24h）
  if (credential.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthorized('凭据已过期，请重新激活', ErrorCode.AUTH_EXPIRED);
  }

  // 指纹比对（AC9：renew 同样要求指纹一致）
  const fingerprintHash = hashFingerprint(input.fingerprint, credential.keyId);
  if (credential.deviceFingerprintHash !== fingerprintHash) {
    await writeAuditLog({
      actorType: 'CLIENT',
      actorId: credential.clientId,
      action: AuditAction.FINGERPRINT_MISMATCH,
      detail: { event: 'renew_fingerprint_mismatch', keyId: credential.keyId },
      ip,
    });
    throw AppError.forbidden('设备指纹不匹配', ErrorCode.FINGERPRINT_MISMATCH);
  }

  // 原子轮换
  const now = Date.now();
  const newJti = randomToken(16);
  const newRefreshToken = generateSecret();
  const newCredential = await prisma.$transaction(async (tx) => {
    // 旧 access jti 入撤销名单（RENEWED，60s 宽限期，AC3/AC12 调和）
    if (input.oldAccessToken) {
      try {
        const decoded = jwt.decode(input.oldAccessToken) as { jti?: string } | null;
        if (decoded?.jti) {
          await tx.revokedToken.create({
            data: { jti: decoded.jti, reason: 'RENEWED' },
          });
        }
      } catch {
        // 旧 token 解析失败则跳过撤销（无在途请求需保护）
      }
    }

    // 删除旧 refresh 记录，插入新记录（旋转式）
    await tx.clientCredential.delete({ where: { id: credential.id } });
    const created = await tx.clientCredential.create({
      data: {
        keyId: credential.keyId,
        deviceFingerprintHash: credential.deviceFingerprintHash,
        clientId: credential.clientId,
        refreshTokenHash: sha256(newRefreshToken),
        expiresAt: new Date(now + env.refreshTokenTtlMs),
        lastRenewedAt: new Date(now),
      },
    });

    await writeAuditLog({
      actorType: 'CLIENT',
      actorId: credential.clientId,
      action: AuditAction.TOKEN_REVOKED,
      detail: { event: 'credential_renewed', keyId: credential.keyId },
      ip,
      tx,
    });

    return created;
  });

  const accessToken = signClientAccessToken({
    sub: newCredential.clientId,
    keyId: newCredential.keyId,
    deviceFingerprintHash: newCredential.deviceFingerprintHash,
    jti: newJti,
  });

  return {
    clientId: newCredential.clientId,
    accessToken,
    accessTokenExpiresInMs: env.accessTokenTtlMs,
    refreshToken: newRefreshToken,
    refreshTokenExpiresInMs: env.refreshTokenTtlMs,
  };
}

/** 客户端登出（P0-A-02 / backend §4.3）：撤销本机凭据，jti 入撤销名单(REVOKED) */
export async function logoutClientCredential(
  clientId: string,
  keyId: string,
  jti: string,
  ip?: string,
) {
  await prisma.$transaction(async (tx) => {
    await tx.clientCredential.deleteMany({ where: { clientId } });
    await tx.revokedToken.create({ data: { jti, reason: 'REVOKED' } });
    await writeAuditLog({
      actorType: 'CLIENT',
      actorId: clientId,
      action: AuditAction.LOGOUT,
      detail: { keyId },
      ip,
      tx,
    });
  });
  keyStatusCache.delete(keyId);
}
