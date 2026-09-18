import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';

/** 主管端设备管理视图（与原型"设备管理"页对齐） */

/**
 * 设备「在线」判据（P0-C-20 AC2 / P0-A-02）：
 * - 优先取 `ClientCredential.lastActiveAt`（由客户端 POST /api/client/ports/heartbeat 刷新）；
 * - 老客户端尚未实现心跳（lastActiveAt 为 null）→ 回落 `lastRenewedAt`（续期时间，现状行为）；
 * - 从未取得凭据（未激活/已登出）→ 回落绑定时间，必然离线。
 *
 * 窗口统一取 `env.onlineWindowMs`（默认 5 分钟），与 IM 账号列表 / 端口管理 / 客户端仪表板同源。
 * ⚠️ 历史缺陷：该窗口曾在此硬编码 5 分钟且判据只认续期时间——access token TTL 3 天，
 * 客户端几乎不主动续期，导致设备激活 5 分钟后必然显示离线（假离线）。
 */

/** 序号形设备指纹（仅展示用途），从 fingerprintHash 派生 */
function maskFingerprint(fingerprintHash: string): string {
  if (fingerprintHash.startsWith('fp-')) {
    return fingerprintHash.slice(3).toUpperCase();
  }
  // 后端 hash 截取前缀
  return 'WIN-' + fingerprintHash.slice(0, 6).toUpperCase();
}

/** 相对时间描述（"刚刚"/"X 分钟前"/"X 小时前"/"X 天前"） */
function formatRelative(from: Date, now: number): string {
  const diff = now - from.getTime();
  if (diff < 30 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
}

export class SupervisorDeviceService {
  /**
   * 主管团队设备列表（原型"设备管理"页）
   * 返回 4 张统计卡 + 设备明细
   */
  async listDevices(teamId: string) {
    const now = Date.now();

    // 1) 团队全部 deviceBinding（关联 licenseKey）
    const bindings = await prisma.deviceBinding.findMany({
      where: { licenseKey: { teamId } },
      include: {
        licenseKey: {
          select: { id: true, nickname: true, status: true, multiDeviceEnabled: true, deviceLimit: true },
        },
      },
      orderBy: { boundAt: 'desc' },
    });

    if (bindings.length === 0) {
      return {
        topStats: { totalBound: 0, online: 0, offline: 0, availableSlots: 0 },
        items: [],
        summary: { teamId },
        // 与统计区文案一致的提示
        hints: [
          '设备变化按照该设备处理：客服换键鼠 / 网卡 / 迁移虚拟机后，指纹变了就算一台新设备——有名称就能直接激活，没名称才会被拒',
        ],
      };
    }

    // 2) 关联 ClientCredential（取设备活跃时间/续期时间，作为在线判据）
    const fingerprints = bindings.map((b) => b.fingerprintHash);
    const keyIds = Array.from(new Set(bindings.map((b) => b.keyId)));
    const credentials = await prisma.clientCredential.findMany({
      where: { keyId: { in: keyIds }, deviceFingerprintHash: { in: fingerprints } },
      select: {
        keyId: true,
        deviceFingerprintHash: true,
        lastActiveAt: true,
        lastRenewedAt: true,
        clientId: true,
      },
    });
    const credMap = new Map<string, typeof credentials[number]>();
    for (const c of credentials) {
      credMap.set(`${c.keyId}:${c.deviceFingerprintHash}`, c);
    }

    // 3) 设备明细（推断 online/offline）
    const items = bindings.map((b) => {
      const cred = credMap.get(`${b.keyId}:${b.fingerprintHash}`);
      // 判据优先级：心跳活跃时间 → 续期时间 → 绑定时间（见文件头说明）
      const lastSeen = cred?.lastActiveAt ?? cred?.lastRenewedAt ?? b.boundAt;
      const lastSeenSource: 'HEARTBEAT' | 'RENEW' | 'BINDING' = cred?.lastActiveAt
        ? 'HEARTBEAT'
        : cred?.lastRenewedAt
          ? 'RENEW'
          : 'BINDING';
      const isKeyDisabled = b.licenseKey.status === 'DISABLED';
      const isOnline = !isKeyDisabled && lastSeen.getTime() >= now - env.onlineWindowMs;
      const relative = formatRelative(lastSeen, now);

      return {
        id: b.id,
        customerNickname: b.licenseKey.nickname,
        keyId: b.keyId,
        keyNickname: b.licenseKey.nickname,
        keyStatus: b.licenseKey.status,
        multiDeviceEnabled: b.licenseKey.multiDeviceEnabled,
        deviceLabel: b.deviceLabel,
        fingerprint: maskFingerprint(b.fingerprintHash),
        boundAt: b.boundAt.toISOString(),
        lastSeenAt: lastSeen.toISOString(),
        lastSeenRelative: relative,
        /** 在线判据来源：HEARTBEAT=已实现心跳保活；RENEW=老客户端回落续期时间；BINDING=无凭据 */
        lastSeenSource,
        status: isOnline ? 'ONLINE' : 'OFFLINE',
        keyDisabled: isKeyDisabled,
        canUnbind: true,
      };
    });

    // 4) 顶部统计
    const onlineCount = items.filter((i) => i.status === 'ONLINE').length;
    const offlineCount = items.length - onlineCount;

    // 可用名额 = 各 key 的 (multi ? 5 : 1) - 当前绑定数；DISABLED 密钥不计
    let availableSlots = 0;
    const allKeys = await prisma.licenseKey.findMany({
      where: { teamId },
      select: { id: true, multiDeviceEnabled: true, status: true, _count: { select: { deviceBindings: true } } },
    });
    for (const k of allKeys) {
      // 禁用态密钥不计入可绑定名额
      if (k.status === 'DISABLED') continue;
      const limit = k.multiDeviceEnabled ? 5 : 1;
      const used = k._count.deviceBindings;
      availableSlots += Math.max(0, limit - used);
    }

    return {
      topStats: {
        totalBound: items.length,
        online: onlineCount,
        offline: offlineCount,
        availableSlots,
      },
      items,
      summary: {
        teamId,
        // 分钟数随在线窗口（env.onlineWindowMs）同步，避免文案与判据漂移
        hint: `解绑会让它在 ${Math.ceil(env.onlineWindowMs / 60_000)} 分钟内退出登录`,
      },
    };
  }
}

export const supervisorDeviceService = new SupervisorDeviceService();
