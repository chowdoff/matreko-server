import { prisma } from '@/lib/prisma';
import { getKeyStatusWithCache } from '@/services/token.service';

const TIMEZONE = 'Asia/Shanghai';

/** 在线判定窗口（与 P0-C-20 AC2 / supervisor 端口看板一致） */
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

/** 客户端 Home 页所需的一次性聚合数据（P0-C-20 / P0-B-10 AC19 / T1-06 增强） */
export interface ClientDashboardData {
  /** 服务端当前时刻（用于「当前时间」展示，与本机时间无关） */
  serverTime: string;
  timezone: string;

  team: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'DISABLED';
    expiresAt: string;
    /** 客户端可直接渲染「剩余 N 天」 */
    daysRemaining: number;
  };

  /** 顶部条与 Card 2 共用的团队端口占用 */
  teamPortHeader: {
    held: number;
    quota: number;
  };

  cards: {
    /** Card 1: 我的账号（团队渠道账号总数 / 本机已启动 / 本机占用端口） */
    myAccounts: {
      total: number;
      started: number;
      portsHeld: number;
    };
    /** Card 2: 团队端口占用（团队 held/quota + 本机 vs 同事拆分） */
    teamPorts: {
      held: number;
      quota: number;
      mine: number;
      others: number;
    };
    /** Card 3: 团队翻译配额 */
    translation: {
      used: number;
      quota: number;
      remaining: number;
    };
    /** Card 4: 翻译服务健康（连续失败计数由客户端自维护，P0-T-08） */
    translationService: {
      status: 'OK' | 'DEGRADED' | 'OUTAGE';
      reason: string | null;
    };
  };

  /** 每个渠道一张卡片 + 侧栏 2/3 角标 */
  channels: Array<{
    channel: 'telegram' | 'whatsapp';
    label: string;
    total: number;
    online: number;
    waitingQr: number;
    offlineHeld: number;
    notStarted: number;
  }>;
}

const CHANNEL_LABEL: Record<'telegram' | 'whatsapp', string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

/** 把 channelAccountKey（如 "telegram:东南亚主号"）解析为渠道枚举 */
function parseChannel(key: string): 'telegram' | 'whatsapp' | null {
  const [ch] = key.split(':');
  if (ch === 'telegram' || ch === 'whatsapp') return ch;
  return null;
}

/**
 * 客户端 Home 仪表板数据（P0-C-20 / P0-B-10 / 客户端首页原型）：
 * 一次返回：服务器时间 + 团队信息 + 4 张卡片 + 渠道分布（用于侧栏与渠道卡）。
 * 权限：仅返回本团队（透过 keyId → teamId 解析），不暴露其他团队/客服的明细。
 */
export async function getClientDashboard(
  keyId: string,
  clientId: string,
): Promise<ClientDashboardData> {
  const status = await getKeyStatusWithCache(keyId);
  if (!status) {
    throw new Error('Key status not found');
  }
  const teamId = status.teamId;

  // ── 团队基本信息 ─────────────────────────────────────────────
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      name: true,
      status: true,
      expiresAt: true,
      portQuota: true,
      translationQuota: true,
      translationUsed: true,
    },
  });
  if (!team) throw new Error('Team not found');

  // ── 团队所有租约（数据量小，单次查询即可；HELD+RELEASED 都拉） ──
  const allLeases = await prisma.portLease.findMany({
    where: { teamId },
    select: {
      clientId: true,
      channelAccountKey: true,
      status: true,
      channelStatus: true,
      lastSeenAt: true,
    },
  });

  const now = Date.now();
  const heldLeases = allLeases.filter((l) => l.status === 'HELD');

  // ── Card 1 / Card 2：本机 vs 同事 ──────────────────────────────
  const myHeld = heldLeases.filter((l) => l.clientId === clientId);
  const otherHeldCount = heldLeases.length - myHeld.length;

  // 团队视角下的「账号总数」= 团队中不同 channelAccountKey 的数量
  // （HELD + RELEASED 去重，覆盖「已启动」「曾启动过」的所有账号）
  const teamDistinctAccounts = new Set(allLeases.map((l) => l.channelAccountKey)).size;

  // ── Card 3：翻译配额 ────────────────────────────────────────
  const translationUsed = team.translationUsed;
  const translationQuota = team.translationQuota;
  const translationRemaining = Math.max(0, translationQuota - translationUsed);

  // ── Card 4：翻译服务健康 ────────────────────────────────────
  const keyGroups = await prisma.translationKey.groupBy({
    by: ['status'],
    where: { status: { in: ['ACTIVE', 'EXHAUSTED', 'INVALID', 'DISABLED'] } },
    _count: { _all: true },
  });
  const activeCount = keyGroups.find((g) => g.status === 'ACTIVE')?._count._all ?? 0;
  const totalCount = keyGroups.reduce((sum, g) => sum + g._count._all, 0);
  let translationService: ClientDashboardData['cards']['translationService'];
  if (activeCount > 0) {
    translationService = { status: 'OK', reason: null };
  } else if (totalCount === 0) {
    translationService = {
      status: 'OUTAGE',
      reason: '管理员尚未配置翻译引擎密钥',
    };
  } else {
    translationService = {
      status: 'OUTAGE',
      reason: '全部翻译引擎密钥已失效或耗尽，请联系管理员',
    };
  }

  // ── 渠道分布（Telegram / WhatsApp） ─────────────────────────
  // 每渠道的「账号总数」= 团队中该渠道不同 channelAccountKey 的数量
  // 在线 / 等待扫码 / 离线占端口 / 未启动  = 不同 channelAccountKey 在 HELD 中的状态分布
  const channels: ClientDashboardData['channels'] = (
    ['telegram', 'whatsapp'] as const
  ).map((channel) => {
    const inChannel = (k: string) => parseChannel(k) === channel;
    const total = new Set(allLeases.filter((l) => inChannel(l.channelAccountKey)).map((l) => l.channelAccountKey))
      .size;
    const heldInChannel = heldLeases.filter((l) => inChannel(l.channelAccountKey));
    const online = new Set(
      heldInChannel
        .filter(
          (l) =>
            l.channelStatus === 'ONLINE' && now - l.lastSeenAt.getTime() <= ONLINE_THRESHOLD_MS,
        )
        .map((l) => l.channelAccountKey),
    ).size;
    const waitingQr = new Set(
      heldInChannel
        .filter((l) => l.channelStatus === 'WAITING_QR')
        .map((l) => l.channelAccountKey),
    ).size;
    const offlineHeld = new Set(
      heldInChannel
        .filter(
          (l) =>
            l.channelStatus === 'OFFLINE' ||
            (l.channelStatus !== 'WAITING_QR' &&
              now - l.lastSeenAt.getTime() > ONLINE_THRESHOLD_MS),
        )
        .map((l) => l.channelAccountKey),
    ).size;
    const notStarted = Math.max(0, total - online - waitingQr - offlineHeld);
    return {
      channel,
      label: CHANNEL_LABEL[channel],
      total,
      online,
      waitingQr,
      offlineHeld,
      notStarted,
    };
  });

  // ── 剩余天数 ──────────────────────────────────────────────
  const msRemaining = team.expiresAt.getTime() - now;
  const daysRemaining = msRemaining > 0 ? Math.ceil(msRemaining / 86_400_000) : 0;

  return {
    serverTime: new Date(now).toISOString(),
    timezone: TIMEZONE,
    team: {
      id: team.id,
      name: team.name,
      status: team.status as 'ACTIVE' | 'DISABLED',
      expiresAt: team.expiresAt.toISOString(),
      daysRemaining,
    },
    teamPortHeader: {
      held: heldLeases.length,
      quota: team.portQuota,
    },
    cards: {
      myAccounts: {
        total: teamDistinctAccounts,
        started: myHeld.length,
        portsHeld: myHeld.length,
      },
      teamPorts: {
        held: heldLeases.length,
        quota: team.portQuota,
        mine: myHeld.length,
        others: otherHeldCount,
      },
      translation: {
        used: translationUsed,
        quota: translationQuota,
        remaining: translationRemaining,
      },
      translationService,
    },
    channels,
  };
}
