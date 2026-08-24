import { AdminAccount } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { generateLicenseCode, encryptLicenseCode, tryDecryptLicenseCode } from '@/lib/crypto';
import { env } from '@/config/env';
import { keyStatusCache } from '@/lib/caches';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { writeAuditLog, AuditAction } from '@/services/audit.service';
import { CreateLicenseInput, DisableLicenseInput, SetMultiDeviceInput } from '@/schemas/license.schema';

const SUPERVISOR_ACTOR = (actor: AdminAccount) => ({ actorType: 'SUPERVISOR' as const, actorId: actor.id });

export class LicenseService {
  /**
   * 生成密钥（P0-B-09 AC1）：
   * MTRK- + 4×4 位 Base32；库中存 code（AES-256-GCM 密文，需展示时解密）；
   * 生成时必须指定昵称；可选开启多设备激活（默认关闭）。
   */
  async createLicense(teamId: string, input: CreateLicenseInput, actor: AdminAccount, ip?: string) {
    const code = generateLicenseCode();
    const multiDeviceEnabled = input.multiDeviceEnabled ?? false;
    const licenseKey = await prisma.licenseKey.create({
      data: {
        teamId,
        nickname: input.nickname,
        code: encryptLicenseCode(code, env.licenseCodeEncKey),
        multiDeviceEnabled,
      },
    });

    await writeAuditLog({
      ...SUPERVISOR_ACTOR(actor),
      action: AuditAction.LICENSE_GENERATED,
      detail: { keyId: licenseKey.id, nickname: input.nickname, multiDeviceEnabled },
      ip,
    });

    return { licenseKey, plaintextCode: code };
  }

  /** 密钥列表（本团队，P0-B-09 AC2）：状态 / 创建时间 / 多开开关 / 绑定设备列表与激活时间 */
  async listLicenses(teamId: string) {
    const keys = await prisma.licenseKey.findMany({
      where: { teamId },
      include: {
        deviceBindings: {
          select: { id: true, deviceLabel: true, boundAt: true },
          orderBy: { boundAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 附加 licenseCode 明文字段：AES-256-GCM 解密后返回
    const keyIds = keys.map((k) => k.id);
    if (keyIds.length === 0) return [];

    // 端口占用计数（仅 HELD）
    const portCounts = await prisma.portLease.groupBy({
      by: ['keyId'],
      where: { teamId, keyId: { in: keyIds }, status: 'HELD' },
      _count: { _all: true },
    });
    const portCountMap = new Map(portCounts.map((p) => [p.keyId, p._count._all]));

    // 翻译字符累计
    const usageRows = await prisma.translationUsageLog.groupBy({
      by: ['licenseKeyId'],
      where: { teamId, licenseKeyId: { in: keyIds } },
      _sum: { chars: true },
    });
    const usageMap = new Map(usageRows.map((u) => [u.licenseKeyId, u._sum.chars ?? 0]));

    return keys.map((k) => {
      const licenseCode = k.code ? tryDecryptLicenseCode(k.code, env.licenseCodeEncKey) : null;
      return {
        ...k,
        code: undefined,
        licenseCode,
        portsHeld: portCountMap.get(k.id) ?? 0,
        usageTotal: usageMap.get(k.id) ?? 0,
      };
    });
  }

  /** 密钥统计：总数 / 已激活 / 未激活 / 已禁用 */
  async getLicenseStats(teamId: string) {
    const groups = await prisma.licenseKey.groupBy({
      by: ['status'],
      where: { teamId },
      _count: { status: true },
    });

    const stats = { total: 0, active: 0, unused: 0, disabled: 0 };
    for (const g of groups) {
      const n = g._count.status;
      stats.total += n;
      if (g.status === 'ACTIVE') stats.active = n;
      else if (g.status === 'UNUSED') stats.unused = n;
      else if (g.status === 'DISABLED') stats.disabled = n;
    }
    return stats;
  }

  /**
   * 禁用密钥（P0-B-09 AC3/AC7/AC8）：
   * 不可删除只能禁用；活跃且有绑定设备时须 confirm=true 提交（AC7 提交前提示影响范围）；
   * 禁用后删除全部 ClientCredential（refresh 立即失效），access token 由鉴权链路按密钥状态拒绝（≤60s）。
   */
  async disableLicense(
    licenseId: string,
    teamId: string,
    actor: AdminAccount,
    input: DisableLicenseInput,
    ip?: string,
  ) {
    const key = await prisma.licenseKey.findFirst({
      where: { id: licenseId, teamId },
      include: {
        deviceBindings: { select: { id: true } },
        clientCredentials: { select: { id: true } },
      },
    });
    if (!key) throw AppError.notFound('密钥不存在');

    const impact = {
      boundDevices: key.deviceBindings.length,
      onlineClients: key.clientCredentials.length,
    };
    if (key.status === 'DISABLED') return { alreadyDisabled: true, impact };

    // AC7：正在被使用的密钥，禁用前须确认影响
    if (key.status === 'ACTIVE' && impact.boundDevices > 0 && !input.confirm) {
      throw AppError.conflict(
        '该密钥正在被使用，禁用后对应客服将在 5 分钟内下线，请确认后重试',
        ErrorCode.STATUS_CHANGED,
        impact,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.licenseKey.update({
        where: { id: key.id },
        data: { status: 'DISABLED' },
      });
      await tx.clientCredential.deleteMany({ where: { keyId: key.id } });
      await writeAuditLog({
        ...SUPERVISOR_ACTOR(actor),
        action: AuditAction.KEY_DISABLED,
        detail: { keyId: key.id, impact },
        ip,
        tx,
      });
    });

    // 主动失效：鉴权链路立即感知密钥禁用
    keyStatusCache.delete(key.id);
    return { impact };
  }

  /**
   * 启用密钥（实际业务：密钥可禁用/可启用，PRD 未细化）：
   * DISABLED → 恢复可用；有绑定设备恢复为 ACTIVE，无绑定设备恢复为 UNUSED；
   * 凭据不在此处重建——已绑定设备重新激活时由激活流程检测到凭据缺失后补发新凭据。
   */
  async enableLicense(licenseId: string, teamId: string, actor: AdminAccount, ip?: string) {
    const key = await prisma.licenseKey.findFirst({
      where: { id: licenseId, teamId },
      include: { deviceBindings: { select: { id: true } } },
    });
    if (!key) throw AppError.notFound('密钥不存在');

    if (key.status !== 'DISABLED') {
      return { alreadyEnabled: true, status: key.status, boundDevices: key.deviceBindings.length };
    }

    const nextStatus: 'ACTIVE' | 'UNUSED' = key.deviceBindings.length > 0 ? 'ACTIVE' : 'UNUSED';
    await prisma.licenseKey.update({
      where: { id: key.id },
      data: { status: nextStatus },
    });
    await writeAuditLog({
      ...SUPERVISOR_ACTOR(actor),
      action: AuditAction.KEY_ENABLED,
      detail: { keyId: key.id, status: nextStatus },
      ip,
    });

    // 鉴权链路立即感知密钥已恢复可用
    keyStatusCache.delete(key.id);
    return { alreadyEnabled: false, status: nextStatus, boundDevices: key.deviceBindings.length };
  }

  /**
   * 多开开关（P0-B-09 AC5/AC9/AC10）：
   * 开启后最多绑定 5 台；关闭时必须选择保留一台，其余设备自动按解绑流程下线。
   */
  async setMultiDevice(
    licenseId: string,
    teamId: string,
    actor: AdminAccount,
    input: SetMultiDeviceInput,
    ip?: string,
  ) {
    const key = await prisma.licenseKey.findFirst({
      where: { id: licenseId, teamId },
      include: { deviceBindings: true },
    });
    if (!key) throw AppError.notFound('密钥不存在');

    if (input.enabled) {
      if (key.multiDeviceEnabled) return { multiDeviceEnabled: true, deviceLimit: key.deviceLimit };
      await prisma.licenseKey.update({
        where: { id: key.id },
        data: { multiDeviceEnabled: true, deviceLimit: 5 },
      });
      await writeAuditLog({
        ...SUPERVISOR_ACTOR(actor),
        action: AuditAction.MULTI_DEVICE_CHANGED,
        detail: { keyId: key.id, enabled: true, deviceLimit: 5 },
        ip,
      });
      return { multiDeviceEnabled: true, deviceLimit: 5 };
    }

    // 关闭多开（AC9：未选择保留设备不提交）
    if (!key.multiDeviceEnabled) return { multiDeviceEnabled: false };

    const bindings = key.deviceBindings;
    if (bindings.length === 0) {
      await prisma.licenseKey.update({
        where: { id: key.id },
        data: { multiDeviceEnabled: false },
      });
      await writeAuditLog({
        ...SUPERVISOR_ACTOR(actor),
        action: AuditAction.MULTI_DEVICE_CHANGED,
        detail: { keyId: key.id, enabled: false },
        ip,
      });
      return { multiDeviceEnabled: false };
    }

    const keepId = input.keepDeviceBindingId!;
    const keep = bindings.find((b) => b.id === keepId);
    if (!keep) {
      // AC12：并发操作后设备列表已变化
      throw AppError.conflict(
        '设备状态已变更，请刷新后重试',
        ErrorCode.STATUS_CHANGED,
        { bindings: bindings.map((b) => b.id) },
      );
    }

    const offlineBindings = bindings.filter((b) => b.id !== keepId);
    const offlineIds = offlineBindings.map((b) => b.id);
    const offlineFingerprints = offlineBindings.map((b) => b.fingerprintHash);

    await prisma.$transaction(async (tx) => {
      await tx.licenseKey.update({
        where: { id: key.id },
        data: { multiDeviceEnabled: false },
      });
      // AC10：被选择下线的设备走解绑流程
      if (offlineIds.length > 0) {
        await tx.deviceBinding.deleteMany({ where: { id: { in: offlineIds } } });
        await tx.clientCredential.deleteMany({
          where: { keyId: key.id, deviceFingerprintHash: { in: offlineFingerprints } },
        });
      }
      await writeAuditLog({
        ...SUPERVISOR_ACTOR(actor),
        action: AuditAction.MULTI_DEVICE_CHANGED,
        detail: {
          keyId: key.id,
          enabled: false,
          keepDeviceBindingId: keep.id,
          offlineDeviceBindingIds: offlineIds,
        },
        ip,
        tx,
      });
    });

    keyStatusCache.delete(key.id);
    return { multiDeviceEnabled: false, keptDevice: keep.id, offlineDevices: offlineIds };
  }

  /**
   * 设备解绑（P0-B-09 AC4/AC11）：删除绑定 + ClientCredential，无次数限制；
   * access token 由鉴权链路指纹比对拒绝（≤60s 生效）。
   */
  async unbindDevice(bindingId: string, teamId: string, actor: AdminAccount, ip?: string) {
    const binding = await prisma.deviceBinding.findFirst({
      where: { id: bindingId, licenseKey: { teamId } },
      include: { licenseKey: { select: { id: true } } },
    });
    if (!binding) {
      throw AppError.conflict('设备状态已变更，请刷新后重试', ErrorCode.STATUS_CHANGED);
    }

    await prisma.$transaction(async (tx) => {
      await tx.deviceBinding.delete({ where: { id: binding.id } });
      await tx.clientCredential.deleteMany({
        where: { keyId: binding.keyId, deviceFingerprintHash: binding.fingerprintHash },
      });
      await writeAuditLog({
        ...SUPERVISOR_ACTOR(actor),
        action: AuditAction.DEVICE_UNBOUND,
        detail: { keyId: binding.keyId, deviceLabel: binding.deviceLabel },
        ip,
        tx,
      });
    });

    keyStatusCache.delete(binding.keyId);
    return { unbound: true };
  }
}

export const licenseService = new LicenseService();
