import { z } from 'zod';

/**
 * 渠道账号登记接口校验（P0-C-03 AC1 / P0-C-18 AC1/AC15）
 *
 * 客户端上报本机**全部未删除**账号构成完整快照；服务端做全量对账（投影同步）。
 * 只登记存在性元数据 —— proxy / fingerprint / dataDir **不上报**（P0-C-18 AC18）。
 */

/** 单次对账的账号数量上限（防御性，非产品上限 —— P0-C-03 AC14 不设实例数上限） */
export const SYNC_ACCOUNTS_MAX = 500;

export const syncChannelAccountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        channelAccountId: z
          .string()
          .trim()
          .min(1, 'channelAccountId 不能为空')
          .max(128, 'channelAccountId 不能超过 128 字符'),
        channel: z.enum(['TELEGRAM', 'WHATSAPP'], {
          message: '渠道仅支持 TELEGRAM / WHATSAPP',
        }),
        accountName: z
          .string()
          .trim()
          .min(1, '账号名称不能为空')
          .max(64, '账号名称不能超过 64 字符'),
      }),
    )
    .max(SYNC_ACCOUNTS_MAX, `单次最多上报 ${SYNC_ACCOUNTS_MAX} 个账号`),
});

export type SyncChannelAccountsInput = z.infer<typeof syncChannelAccountsSchema>;
export type SyncChannelAccountItem = SyncChannelAccountsInput['accounts'][number];
