import { z } from 'zod';

/** 生成密钥：昵称必填、多开开关可选（默认关闭） */
export const createLicenseSchema = z.object({
  nickname: z.string().min(1).max(64),
  multiDeviceEnabled: z.boolean().optional(),
});

export type CreateLicenseInput = z.infer<typeof createLicenseSchema>;

/** 禁用密钥（P0-B-09 AC3/AC7/AC8） */
export const disableLicenseSchema = z.object({
  /** 密钥活跃且有绑定设备时须显式确认影响范围（AC7 提交前提示） */
  confirm: z.boolean().optional(),
});

/** 多开开关（P0-B-09 AC5/AC9/AC10） */
export const setMultiDeviceSchema = z
  .object({
    enabled: z.boolean(),
    /** 关闭多开时必须指定保留的设备绑定 ID（AC9），未选择不提交 */
    keepDeviceBindingId: z.string().optional(),
  })
  .refine((v) => v.enabled || v.keepDeviceBindingId !== undefined, {
    message: '关闭多开时必须选择保留哪一台设备',
    path: ['keepDeviceBindingId'],
  });

export type DisableLicenseInput = z.infer<typeof disableLicenseSchema>;
export type SetMultiDeviceInput = z.infer<typeof setMultiDeviceSchema>;
