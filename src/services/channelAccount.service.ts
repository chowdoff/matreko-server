import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { normalizeChannelAccountId, buildChannelAccountKey } from '@/lib/channelAccountKey';
import type { ChannelValue } from '@/lib/channelAccountKey';
import type { SyncChannelAccountItem } from '@/schemas/channelAccount.schema';

/** 时区标注（PRD §2.6） */
const TIMEZONE = 'Asia/Shanghai';

/**
 * 账号状态（channel-account-design.md §4.1）
 * - NOT_STARTED：无 HELD 租约（不占端口）
 * - WAITING_QR：HELD + 客户端上报等待扫码
 * - ONLINE：HELD + 权威 channelStatus=ONLINE；或 channelStatus 缺失但 lastSeenAt 在窗口内
 * - OFFLINE：HELD + 其余情况（离线但仍占端口）
 *
 * 注意不含 `RELEASED` —— 那是**端口租约**语义，混进账号状态会与「未启动」无法区分。
 */
export type ChannelAccountStatus = 'NOT_STARTED' | 'WAITING_QR' | 'ONLINE' | 'OFFLINE';

interface AccountRow {
  id: string;
  keyId: string;
  clientId: string;
  channelAccountId: string;
  channel: ChannelValue;
  accountName: string;
  createdAt: Date;
  licenseKey: { id: string; nickname: string };
}

interface LeaseRow {
  id: string;
  clientId: string;
  channelAccountKey: string;
  channelAccountId: string | null;
  status: string;
  channelStatus: string | null;
  acquiredAt: Date;
  lastSeenAt: Date;
  releasedAt: Date | null;
  proxyExit: string | null;
}

export interface ChannelAccountItem {
  channelAccountId: string;
  accountId: string;
  channelAccountKey: string;
  channel: string;
  accountName: string;
  status: ChannelAccountStatus;
  online: boolean;
  isHeld: boolean;
  portsHeld: number;
  leaseId: string | null;
  keyId: string;
  keyNickname: string;
  clientId: string;
  createdAt: string;
  acquiredAt: string | null;
  lastSeenAt: string | null;
  releasedAt: string | null;
  proxyExit: string;
  timezone: string;
}

export interface ChannelAccountSummary {
  total: number;
  online: number;
  offline: number;
  waitingQr: number;
  notStarted: number;
  portsHeld: number;
}

/** 账号状态派生：无 HELD 租约 → 未启动；权威 channelStatus 优先，缺失时按心跳窗口兜底 */
function deriveStatus(lease: LeaseRow | undefined, nowMs: number): ChannelAccountStatus {
  if (!lease || lease.status !== 'HELD') return 'NOT_STARTED';
  if (lease.channelStatus === 'WAITING_QR') return 'WAITING_QR';
  if (lease.channelStatus === 'ONLINE') return 'ONLINE';
  if (lease.channelStatus === 'OFFLINE') return 'OFFLINE';
  return nowMs - lease.lastSeenAt.getTime() <= env.onlineWindowMs ? 'ONLINE' : 'OFFLINE';
}

/** 租约索引键：(clientId, channelAccountId)；老租约无 channelAccountId 时从 key 解析回退 */
function leaseIndexKey(clientId: string, accountId: string): string {
  return `${clientId}\u0000${accountId}`;
}

/** 把「账号 + 当前 HELD 租约」装配为主管端/客户端可见的列表项 */
function assembleItems(
  accounts: AccountRow[],
  heldLeases: LeaseRow[],
  nowMs: number,
): ChannelAccountItem[] {
  // 同一 (clientId, accountId) 理论上至多 1 条 HELD；异常时保留最后心跳最新的一条
  const heldMap = new Map<string, LeaseRow>();
  for (const l of heldLeases) {
    const accountId = normalizeChannelAccountId(l.channelAccountKey, l.channelAccountId);
    const k = leaseIndexKey(l.clientId, accountId);
    const prev = heldMap.get(k);
    if (!prev || l.lastSeenAt.getTime() > prev.lastSeenAt.getTime()) heldMap.set(k, l);
  }

  return accounts.map((a) => {
    const lease = heldMap.get(leaseIndexKey(a.clientId, a.channelAccountId));
    const status = deriveStatus(lease, nowMs);
    const isHeld = status !== 'NOT_STARTED';

    return {
      channelAccountId: a.channelAccountId,
      accountId: a.channelAccountId,
      channelAccountKey: buildChannelAccountKey(a.channel, a.channelAccountId),
      channel: a.channel,
      accountName: a.accountName,
      status,
      online: status === 'ONLINE',
      isHeld,
      portsHeld: isHeld ? 1 : 0,
      leaseId: lease?.id ?? null,
      keyId: a.keyId,
      keyNickname: a.licenseKey.nickname,
      clientId: a.clientId,
      createdAt: a.createdAt.toISOString(),
      acquiredAt: lease?.acquiredAt.toISOString() ?? null,
      lastSeenAt: lease?.lastSeenAt.toISOString() ?? null,
      releasedAt: lease?.releasedAt?.toISOString() ?? null,
      proxyExit: lease?.proxyExit ?? '',
      timezone: TIMEZONE,
    };
  });
}

function summarize(items: ChannelAccountItem[]): ChannelAccountSummary {
  return {
    total: items.length,
    online: items.filter((i) => i.status === 'ONLINE').length,
    offline: items.filter((i) => i.status === 'OFFLINE').length,
    waitingQr: items.filter((i) => i.status === 'WAITING_QR').length,
    notStarted: items.filter((i) => i.status === 'NOT_STARTED').length,
    portsHeld: items.filter((i) => i.isHeld).length,
  };
}

export class ChannelAccountService {
  /**
   * 全量对账（P0-C-03 AC1 / P0-C-18 AC1/AC15/AC20）。
   *
   * 客户端本地库是真相源，服务端只做投影：事务内
   * ① 快照内账号 upsert（`deletedAt` 复位，支持"删除后又添加同名账号"）；
   * ② 快照外的未删除账号置 `deletedAt`（软删，不物理删除）；
   * ③ 字段无变化则**不写库**（避免 `updatedAt` 抖动，也让幂等性可断言：重复提交同一快照三者皆 0）。
   *
   * 幂等：同一快照重复提交 → `created=0, updated=0, deleted=0`。
   */
  async syncAccounts(
    teamId: string,
    keyId: string,
    clientId: string,
    accounts: SyncChannelAccountItem[],
  ) {
    // 客户端本地数据异常时不应阻断对账：重复 channelAccountId 按"后者覆盖前者"处理
    const snapshot = new Map<string, SyncChannelAccountItem>();
    for (const a of accounts) snapshot.set(a.channelAccountId, a);

    const existing = await prisma.channelAccount.findMany({ where: { clientId } });
    const existingById = new Map(existing.map((e) => [e.channelAccountId, e]));

    const now = new Date();
    const result = { created: 0, updated: 0, deleted: 0 };

    await prisma.$transaction(
      async (tx) => {
      for (const item of snapshot.values()) {
        const prev = existingById.get(item.channelAccountId);

        if (!prev) {
          await tx.channelAccount.create({
            data: {
              teamId,
              keyId,
              clientId,
              channelAccountId: item.channelAccountId,
              channel: item.channel,
              accountName: item.accountName,
            },
          });
          result.created += 1;
          continue;
        }

        // 软删记录被重新添加 → 复位 deletedAt（P0-C-18 AC20「不重复追加」）
        const revoked = prev.deletedAt !== null;
        const changed =
          revoked ||
          prev.channel !== item.channel ||
          prev.accountName !== item.accountName ||
          prev.teamId !== teamId ||
          prev.keyId !== keyId;

        if (changed) {
          await tx.channelAccount.update({
            where: { id: prev.id },
            data: {
              channel: item.channel,
              accountName: item.accountName,
              teamId,
              keyId,
              deletedAt: null,
            },
          });
          result.updated += 1;
        }
      }

      // 不在快照内的未删除账号 → 软删
      const toDelete = existing
        .filter((e) => e.deletedAt === null && !snapshot.has(e.channelAccountId))
        .map((e) => e.id);
      if (toDelete.length > 0) {
        const res = await tx.channelAccount.updateMany({
          where: { id: { in: toDelete } },
          data: { deletedAt: now },
        });
        result.deleted = res.count;
      }
      },
      // 单次最多 500 条账号，逐行写库需要比默认 5s 更宽的窗口
      { timeout: 15000, maxWait: 10000 },
    );

    // 回读装配，保证响应与库内真实状态一致
    const view = await this.listTeamAccounts(teamId, { clientId });
    return {
      ...result,
      total: view.items.length,
      accounts: view.items,
      timezone: TIMEZONE,
    };
  }

  /**
   * 主管端 IM 账号列表（P0-B-10 AC1：本团队所有密钥下**已添加的**渠道账号）。
   *
   * 数据源 = `channel_accounts`（主表，未软删） LEFT JOIN 当前 HELD 租约（运行态）。
   * 与旧实现（用 `port_leases` 反推）的区别：**从未启动过的账号也在列表里**，状态为「未启动」。
   */
  async listTeamAccounts(teamId: string, filter?: { clientId?: string }) {
    const accounts = await prisma.channelAccount.findMany({
      where: {
        teamId,
        deletedAt: null,
        ...(filter?.clientId ? { clientId: filter.clientId } : {}),
      },
      include: { licenseKey: { select: { id: true, nickname: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const heldLeases = await prisma.portLease.findMany({
      where: { teamId, status: 'HELD' },
    });

    const items = assembleItems(
      accounts as AccountRow[],
      heldLeases as LeaseRow[],
      Date.now(),
    );

    return { items, summary: summarize(items), timezone: TIMEZONE };
  }
}

export const channelAccountService = new ChannelAccountService();
