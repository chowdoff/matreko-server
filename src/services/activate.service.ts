import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { sha256, hashFingerprint, generateSecret, randomToken, tryDecryptLicenseCode } from '@/lib/crypto';
import { signClientAccessToken } from '@/lib/jwt';
import { env } from '@/config/env';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { writeAuditLog, AuditAction } from '@/services/audit.service';

/** 客户端激活（P0-A-01 AC1/AC3-AC13/AC16，backend §5.1/§5.3） */
export interface ActivateInput {
  code: string;
  fingerprint: string;
  deviceLabel?: string;
}

export class ActivateService {
  async activate(input: ActivateInput, ip?: string) {
    const code = input.code.trim().toUpperCase();
    if (code.length < 6) {
      throw AppError.badRequest('密钥无效', ErrorCode.KEY_INVALID);
    }

    // ① 查密钥：候选集过滤掉无 code 的历史密钥，解密比对明文（backend §5.2）
    const candidates = await prisma.licenseKey.findMany({
      where: { code: { not: null }, status: { in: ['UNUSED', 'ACTIVE'] } },
      include: { team: true, deviceBindings: true },
    });
    const key = candidates.find((k) => {
      const decrypted = tryDecryptLicenseCode(k.code!, env.licenseCodeEncKey);
      return decrypted === code;
    });
    if (!key) {
      throw AppError.unauthorized('密钥无效', ErrorCode.KEY_INVALID);
    }

    // ② 密钥状态（AC4/AC5）：禁用态不可激活；启用后的密钥可正常激活/重新激活
    if (key.status !== 'UNUSED' && key.status !== 'ACTIVE') {
      throw AppError.forbidden('密钥已禁用，请联系主管', ErrorCode.KEY_DISABLED);
    }

    // ③ 团队状态（AC6/AC13）
    const team = key.team;
    if (team.status === 'DISABLED') {
      throw AppError.forbidden('团队已不可用，请联系管理员', ErrorCode.TEAM_UNAVAILABLE);
    }
    if (team.expiresAt.getTime() <= Date.now()) {
      throw AppError.forbidden(
        `团队已到期（${team.expiresAt.toISOString()}）`,
        ErrorCode.TEAM_UNAVAILABLE,
      );
    }

    // ④ 名额判定 + 绑定 + 签发：事务内完成
    // SQLite 连接器下事务启动即获取写锁（等价 BEGIN IMMEDIATE），并发激活串行执行，
    // 配合 (keyId, fingerprintHash) 唯一约束双保险（P0-A-01 AC11）
    return prisma.$transaction(async (tx) => {
      // 重新读取最新密钥状态（事务内必为最新已提交值）
      const latest = await tx.licenseKey.findUnique({
        where: { id: key.id },
        include: { deviceBindings: true },
      });
      if (!latest) throw AppError.notFound('密钥不存在');

      const fingerprintHash = hashFingerprint(input.fingerprint, latest.id);

      // 幂等：同 (keyId, fingerprint) 重复激活 → 返回「已激活」，不产生第二条绑定（AC10）
      const existing = await tx.deviceBinding.findUnique({
        where: { keyId_fingerprintHash: { keyId: latest.id, fingerprintHash } },
      });
      if (existing) {
        // 绑定仍在：每次重新激活都补发新凭据（删除旧凭据 + 签发新令牌），
        // 旧令牌立即作废，客户端须以本次返回的新令牌覆盖本地存储。
        // 目的：消除「本地 refreshToken 丢失后凭据仍有效、激活又不返还」的死锁（AC10 续激活），
        // 让客户端用本地缓存的密钥重激活即可自助捞回令牌，无需等 24 小时或找主管解绑。
        const cred = await this.issueCredential(
          tx,
          latest.id,
          fingerprintHash,
          existing.deviceLabel ?? undefined,
          ip,
          true,
        );
        return {
          alreadyActivated: true as const,
          reissued: true as const,
          device: existing,
          keyId: latest.id,
          team,
          ...cred,
        };
      }

      // 名额判定（AC8/AC9）
      const bindings = latest.deviceBindings;
      if (!latest.multiDeviceEnabled && bindings.length >= 1) {
        const occupied = bindings[0];
        throw AppError.conflict(
          '该密钥已在其他设备激活',
          ErrorCode.KEY_ACTIVATED_ON_OTHER_DEVICE,
          {
            deviceLabel: occupied.deviceLabel,
            boundAt: occupied.boundAt.toISOString(),
          },
        );
      }
      if (latest.multiDeviceEnabled && bindings.length >= latest.deviceLimit) {
        throw AppError.conflict(
          `已达设备数上限 ${latest.deviceLimit} 台，请联系主管解绑`,
          ErrorCode.DEVICE_LIMIT_REACHED,
        );
      }

      // 创建绑定（AC1/AC3/AC12）
      const device = await tx.deviceBinding.create({
        data: {
          keyId: latest.id,
          fingerprintHash,
          deviceLabel: input.deviceLabel,
        },
      });

      // 密钥首次激活：UNUSED → ACTIVE
      if (latest.status === 'UNUSED') {
        await tx.licenseKey.update({
          where: { id: latest.id },
          data: { status: 'ACTIVE' },
        });
      }

      // ⑤ 签发 clientId + refresh token（ClientCredential）+ access token
      const cred = await this.issueCredential(
        tx,
        latest.id,
        fingerprintHash,
        input.deviceLabel,
        ip,
        false,
      );

      const isAdditionalDevice = bindings.length > 0;
      return {
        alreadyActivated: false as const,
        device,
        keyId: latest.id,
        team,
        ...cred,
        // AC16：指纹变化按新设备激活成功后，原设备仍占名额
        note: isAdditionalDevice
          ? '本次为新增设备绑定，原设备绑定记录仍占用名额；原设备不再使用请联系主管解绑'
          : undefined,
      };
    });
  }

  /** 签发 clientId + refresh token + access token 并在事务内写审计（正常激活与补发共用） */
  private async issueCredential(
    tx: Prisma.TransactionClient,
    keyId: string,
    fingerprintHash: string,
    deviceLabel: string | undefined,
    ip: string | undefined,
    reissued: boolean,
  ) {
    const clientId = `cli_${randomToken(16)}`;
    const refreshToken = generateSecret();
    const jti = randomToken(16);
    const refreshTokenHash = sha256(refreshToken);
    const expiresAt = new Date(Date.now() + env.refreshTokenTtlMs);

    // 清理同 (keyId, fingerprintHash) 的旧凭据（过期/禁用后补发场景），
    // 避免对同一设备残留多条凭据记录
    await tx.clientCredential.deleteMany({
      where: { keyId, deviceFingerprintHash: fingerprintHash },
    });

    await tx.clientCredential.create({
      data: {
        keyId,
        deviceFingerprintHash: fingerprintHash,
        clientId,
        refreshTokenHash,
        expiresAt,
      },
    });

    const accessToken = signClientAccessToken({
      sub: clientId,
      keyId,
      deviceFingerprintHash: fingerprintHash,
      jti,
    });

    await writeAuditLog({
      actorType: 'CLIENT',
      actorId: clientId,
      action: AuditAction.ACTIVATE,
      detail: { keyId, deviceLabel, reissued },
      ip,
      tx,
    });

    return {
      clientId,
      accessToken,
      accessTokenExpiresInMs: env.accessTokenTtlMs,
      refreshToken,
      refreshTokenExpiresInMs: env.refreshTokenTtlMs,
    };
  }
}

export const activateService = new ActivateService();
