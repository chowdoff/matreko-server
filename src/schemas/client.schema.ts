import { z } from 'zod';

/** 客户端激活（P0-A-01） */
export const activateSchema = z.object({
  code: z.string().trim().min(1, '密钥不能为空'),
  fingerprint: z.string().trim().min(1, '设备指纹不能为空'),
  deviceLabel: z.string().trim().max(64, '设备名称不能超过 64 字符').optional(),
});

/** 无缝续期（P0-A-02 AC2/AC3/AC12）：refresh token 走 Authorization 头 */
export const renewSchema = z.object({
  /** 旧 access token（可选）：续期时其 jti 入撤销名单进入 60s 宽限期 */
  oldAccessToken: z.string().optional(),
});

export type ActivateInput = z.infer<typeof activateSchema>;
export type RenewInput = z.infer<typeof renewSchema>;
