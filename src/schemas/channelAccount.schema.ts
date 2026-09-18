import { z } from 'zod';

/**
 * 渠道账号登记接口校验（P0-C-03 AC1 / P0-C-18 AC1/AC15）
 *
 * 客户端上报本机**全部未删除**账号构成完整快照；服务端做全量对账（投影同步）。
 * 只登记存在性元数据 —— 代理凭据（host/port/账号密码）、fingerprint、dataDir
 * **不上报**（P0-C-18 AC18）。
 *
 * 例外：`proxyProtocol` + `proxyRegion` 这对**出口摘要**要上报 ——
 * 主管端「IM 账号列表」需要展示「代理出口」（如 SOCKS5·新加坡），且 P0-C-18 AC4/AC11
 * 的地区一致性校验也要用到出口地。这两个字段只描述"走的什么协议、从哪个地区出网"，
 * 不含任何可复用的代理凭据，因此不与 AC18 冲突（见 channel-account-design.md §2.3）。
 */

/** 单次对账的账号数量上限（防御性，非产品上限 —— P0-C-03 AC14 不设实例数上限） */
export const SYNC_ACCOUNTS_MAX = 500;

/** 代理协议（与 Prisma ProxyProtocol 枚举一致；DIRECT = 本机直连） */
export const PROXY_PROTOCOLS = ['SOCKS5', 'HTTP', 'HTTPS', 'DIRECT'] as const;

/** 代理协议字面量类型（服务端各处共用，避免与 Prisma 枚举字面量漂移） */
export type ProxyProtocolValue = (typeof PROXY_PROTOCOLS)[number];

/**
 * 出口地区码：ISO 3166-1 alpha-2 大写（SG / HK / US…），
 * 允许可选的 3166-2 子码（`US-CA`）以便将来细化到州/省。
 */
const PROXY_REGION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,4})?$/;

const accountItemSchema = z
  .object({
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
    /**
     * 代理协议。省略 = 本次不上报（服务端保留原值，兼容尚未实现代理上报的客户端）。
     */
    proxyProtocol: z.enum(PROXY_PROTOCOLS, {
      message: `代理协议仅支持 ${PROXY_PROTOCOLS.join(' / ')}`,
    }).optional(),
    /**
     * 代理出口地区码。允许省略：P0-C-18 AC12 明确"探测不到出口地时照常保存、
     * 仅提示一致性未校验"，因此不强制与 proxyProtocol 同时出现。
     */
    proxyRegion: z
      .string()
      .trim()
      .regex(PROXY_REGION_RE, 'proxyRegion 需为 ISO 3166-1 alpha-2 大写码（如 SG / HK）')
      .optional(),
  })
  .superRefine((v, ctx) => {
    // 直连没有"出口地"，避免出现「DIRECT·新加坡」这种自相矛盾的展示
    if (v.proxyProtocol === 'DIRECT' && v.proxyRegion) {
      ctx.addIssue({
        code: 'custom',
        path: ['proxyRegion'],
        message: 'DIRECT（本机直连）不应携带 proxyRegion',
      });
    }
  });

export const syncChannelAccountsSchema = z.object({
  accounts: z
    .array(accountItemSchema)
    .max(SYNC_ACCOUNTS_MAX, `单次最多上报 ${SYNC_ACCOUNTS_MAX} 个账号`),
});

export type SyncChannelAccountsInput = z.infer<typeof syncChannelAccountsSchema>;
export type SyncChannelAccountItem = SyncChannelAccountsInput['accounts'][number];
