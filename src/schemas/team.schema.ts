import { z } from 'zod';

/** 团队创建（P0-S-11 AC1 / P0-A-19 AC2） */
export const createTeamSchema = z.object({
  name: z.string().trim().min(1, '团队名称不能为空').max(64, '团队名称不能超过 64 字符'),
  /** 主管账号邮箱（邮箱仅作账号标识，不做验证） */
  supervisorEmail: z.string().email('邮箱格式不正确'),
  /** 到期时刻：日期 + 时分秒（ISO 8601，服务端统一转存储 UTC 秒级） */
  expiresAt: z.string().datetime({ offset: true, message: '到期时刻格式不正确' }),
  /** 端口配额（非负整数） */
  portQuota: z.number().int('端口配额必须是整数').min(0, '端口配额不能为负'),
  /** 翻译配额总量（字符），默认 150 万 */
  translationQuota: z
    .number()
    .int('翻译配额必须是整数')
    .min(0, '翻译配额不能为负')
    .optional(),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;

/**
 * 配额与到期时刻修改（P0-S-11 AC3～AC5/AC10～AC13 / P0-B-10 AC15～AC17）
 * 所有字段可选，仅传需要修改的字段；创建时刻不可修改（AC12）。
 */
export const updateTeamQuotaSchema = z
  .object({
    /** 端口配额（非负整数，AC13） */
    portQuota: z.number().int('端口配额必须是整数').min(0, '端口配额不能为负').optional(),
    /** 翻译配额总量（字符，非负整数，AC13） */
    translationQuota: z
      .number()
      .int('翻译配额必须是整数')
      .min(0, '翻译配额不能为负')
      .optional(),
    /** 到期时刻（管理员可随时修改，改大即延长、改小即提前到期，AC3/AC4/AC11） */
    expiresAt: z.string().datetime({ offset: true, message: '到期时刻格式不正确' }).optional(),
    /** 改到过去时须显式确认影响范围（AC11） */
    confirm: z.boolean().optional(),
  })
  .refine((data) => data.portQuota !== undefined || data.translationQuota !== undefined || data.expiresAt !== undefined, {
    message: '至少需要修改一项（portQuota / translationQuota / expiresAt）',
  });

export type UpdateTeamQuotaInput = z.infer<typeof updateTeamQuotaSchema>;

/**
 * 团队禁用（P0-S-11 AC8～AC9）
 * confirm=true 时直接禁用；未传时若团队有活跃资源则返回影响范围提示。
 */
export const disableTeamSchema = z.object({
  confirm: z.boolean().optional(),
});

export type DisableTeamInput = z.infer<typeof disableTeamSchema>;
