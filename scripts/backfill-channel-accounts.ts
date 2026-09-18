/**
 * 回填脚本：从存量 `port_leases` 提取渠道账号，写入 `channel_accounts`。
 *
 * 用法：
 *   npx tsx scripts/backfill-channel-accounts.ts            # 实际写入
 *   npx tsx scripts/backfill-channel-accounts.ts --dry-run  # 只打印计划，不写库
 *
 * 为什么需要：主管端 IM 账号列表的数据源已从 `port_leases`（启动才产生记录）
 * 切换为 `channel_accounts`（添加即存在）。尚未回填时，存量"启动过"的账号会从列表中消失。
 * 本脚本把存量租约里的账号补登进新表，把窗口期压到秒级。
 *
 * 规则：
 *   - 对每个 (clientId, channelAccountId) 唯一组合 upsert（`channelAccountId` 由 key 规范化而来）；
 *   - **幂等**：可重复执行；已存在的账号**不覆盖** `accountName`（避免冲掉客户端上报的真实别名）；
 *   - 无法判定渠道的记录**跳过并打印清单**，人工确认后处理 —— 不猜测；
 *   - 已软删的账号不复活。
 */
import { prisma } from '@/lib/prisma';
import {
  normalizeChannelAccountId,
  parseChannelAccountKey,
} from '@/lib/channelAccountKey';
import type { ChannelValue } from '@/lib/channelAccountKey';

const DRY_RUN = process.argv.includes('--dry-run');

interface Candidate {
  teamId: string;
  keyId: string;
  clientId: string;
  channelAccountId: string;
  channel: ChannelValue;
  /** 来源租约 id（仅为日志可追溯） */
  sourceLeaseId: string;
}

async function main() {
  const leases = await prisma.portLease.findMany({
    orderBy: [{ teamId: 'asc' }, { acquiredAt: 'asc' }],
    select: {
      id: true,
      teamId: true,
      keyId: true,
      clientId: true,
      channelAccountKey: true,
      channelAccountId: true,
    },
  });

  console.log(`扫描到 ${leases.length} 条端口租约${DRY_RUN ? '（dry-run，不写库）' : ''}`);

  const candidates = new Map<string, Candidate>();
  const skipped: Array<{ leaseId: string; key: string; reason: string }> = [];

  for (const l of leases) {
    const accountId = normalizeChannelAccountId(l.channelAccountKey, l.channelAccountId);
    const channel = parseChannelAccountKey(l.channelAccountKey).channel;

    if (!channel) {
      skipped.push({
        leaseId: l.id,
        key: l.channelAccountKey,
        reason: '渠道无法判定（key 无 telegram/whatsapp 前缀），不猜测，需人工确认',
      });
      continue;
    }

    if (!accountId) {
      skipped.push({ leaseId: l.id, key: l.channelAccountKey, reason: '账号标识为空' });
      continue;
    }

    const k = `${l.clientId}\u0000${accountId}`;
    if (!candidates.has(k)) {
      candidates.set(k, {
        teamId: l.teamId,
        keyId: l.keyId,
        clientId: l.clientId,
        channelAccountId: accountId,
        channel,
        sourceLeaseId: l.id,
      });
    }
  }

  console.log(`待回填账号：${candidates.size} 个；跳过：${skipped.length} 条`);

  let created = 0;
  let existingKept = 0;
  let revived = 0;

  for (const c of candidates.values()) {
    const prev = await prisma.channelAccount.findUnique({
      where: {
        clientId_channelAccountId: {
          clientId: c.clientId,
          channelAccountId: c.channelAccountId,
        },
      },
    });

    if (prev) {
      if (prev.deletedAt !== null) {
        // 已软删但仍在申请过端口 → 说明账号其实还在用，复位
        console.log(
          `  [revive] ${c.channel}:${c.channelAccountId} client=${c.clientId}（原已软删）`,
        );
        if (!DRY_RUN) {
          await prisma.channelAccount.update({
            where: { id: prev.id },
            data: { deletedAt: null },
          });
        }
        revived += 1;
      } else {
        // 已存在：保留真实别名不动（幂等）
        existingKept += 1;
      }
      continue;
    }

    console.log(
      `  [create] ${c.channel}:${c.channelAccountId} team=${c.teamId} client=${c.clientId}（lease ${c.sourceLeaseId}）`,
    );
    if (!DRY_RUN) {
      await prisma.channelAccount.create({
        data: {
          teamId: c.teamId,
          keyId: c.keyId,
          clientId: c.clientId,
          channelAccountId: c.channelAccountId,
          channel: c.channel,
          // 存量无真实别名，只能退化为标识本身；客户端下次对账会覆盖为客服填写的名字
          accountName: c.channelAccountId,
        },
      });
    }
    created += 1;
  }

  if (skipped.length > 0) {
    console.log('\n⚠️ 以下租约无法判定渠道，已跳过（请人工确认后单独处理）：');
    for (const s of skipped) {
      console.log(`  - lease=${s.leaseId} key=${s.key} 原因=${s.reason}`);
    }
  }

  console.log(
    `\n完成：created=${created} revived=${revived} existingKept=${existingKept} skipped=${skipped.length}` +
      (DRY_RUN ? '（dry-run，未写库）' : ''),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('回填失败：', err);
    process.exit(1);
  });
