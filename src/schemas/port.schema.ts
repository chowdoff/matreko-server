import { z } from 'zod';

/**
 * 端口申请（P0-C-20 AC1/AC10）
 * channelAccountKey = channel:accountId 稳定标识，客户端生成。
 */
export const acquirePortSchema = z.object({
  channelAccountKey: z
    .string()
    .trim()
    .min(1, 'channelAccountKey 不能为空')
    .max(256, 'channelAccountKey 不能超过 256 字符'),
});

export type AcquirePortInput = z.infer<typeof acquirePortSchema>;

/**
 * 心跳协议（P0-C-20 AC2/AC8/AC12）
 * 客户端上报本机持有的全部 leaseId，服务端刷新 lastSeenAt 并返回已撤销的 lease。
 * 允许空数组：客户端本机当前未持有任何租约时上报 []，服务端返回 200（refreshed=0，held=团队当前总数）。
 */
export const heartbeatSchema = z.object({
  leaseIds: z.array(z.string()),
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
