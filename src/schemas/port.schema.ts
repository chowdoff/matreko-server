import { z } from 'zod';

/**
 * 端口申请（P0-C-20 AC1/AC10）
 *
 * `channelAccountKey` 为历史字段（客户端原始上报值，可能是 `channel:id` 也可能是裸 id）。
 * 升级后的客户端**建议传全** `channelAccountId` + `channel`，服务端据此规范化落库，
 * 供主管端与 `channel_accounts` 精确匹配；老客户端不传也能跑（回落为解析 key）。
 */
export const acquirePortSchema = z.object({
  channelAccountKey: z
    .string()
    .trim()
    .min(1, 'channelAccountKey 不能为空')
    .max(256, 'channelAccountKey 不能超过 256 字符'),
  /** 规范化账号标识（客户端本地 port.id）；不传则从 channelAccountKey 解析 */
  channelAccountId: z.string().trim().min(1).max(128).optional(),
  /** 渠道；不传则按 channelAccountKey 的冒号前缀识别（识别不出则为 null） */
  channel: z.enum(['TELEGRAM', 'WHATSAPP']).optional(),
});

export type AcquirePortInput = z.infer<typeof acquirePortSchema>;

/**
 * 心跳协议（P0-C-20 AC2/AC8/AC12）
 * 客户端上报本机持有的全部 leaseId，服务端刷新 lastSeenAt 并返回已撤销的 lease。
 * 允许空数组：客户端本机当前未持有任何租约时上报 []，服务端返回 200（refreshed=0，held=团队当前总数）。
 *
 * `channelStatuses` 为可选扩展（P0-C-03 AC4/AC8/AC9/AC10）：上报各租约的渠道业务状态，
 * 使主管端 `WAITING_QR` / 权威 `ONLINE` 真正生效。老客户端不传 → 行为与改造前完全一致。
 */
export const heartbeatSchema = z.object({
  leaseIds: z.array(z.string()),
  /** 各租约的渠道业务状态（仅本 clientId 名下、仍 HELD 的租约会被写入） */
  channelStatuses: z
    .array(
      z.object({
        leaseId: z.string().min(1),
        status: z.enum(['ONLINE', 'WAITING_QR', 'OFFLINE']),
      }),
    )
    .optional(),
});

export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

/**
 * 端口释放（P0-C-20 AC3）
 * 单个释放，置 RELEASED。
 */
export const releasePortSchema = z.object({
  leaseId: z.string().min(1, 'leaseId 不能为空'),
});

export type ReleasePortInput = z.infer<typeof releasePortSchema>;

/**
 * 端口归零（P0-C-20 AC4/AC7）
 * 客户端启动/强杀重启时调用，释放本机全部占用。
 */
export const resetPortsSchema = z.object({});

export type ResetPortsInput = z.infer<typeof resetPortsSchema>;

/**
 * 手动释放确认（P0-C-20 AC11）
 * 主管/管理员手动释放端口前须确认。
 */
export const manualReleaseSchema = z.object({
  confirm: z.boolean().optional(),
});

export type ManualReleaseInput = z.infer<typeof manualReleaseSchema>;
