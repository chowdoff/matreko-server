import { z } from 'zod';

/** 语言代码：ISO 639-1 小写基础码，可选地区变体（如 en-gb） */
const langCode = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, '语言代码须为 ISO 639-1（如 zh / en / ja）');

/** 客户端翻译请求（T4-02 / backend §7.1） */
export const translateSchema = z.object({
  text: z.string().min(1, '翻译文本不能为空').max(20000, '翻译文本过长'),
  sourceLang: langCode.optional(),
  targetLang: langCode,
  /** 翻译方向：IN=接收（→中文）/ OUT=发送（→会话目标语言）；服务端仅按 targetLang 路由 */
  direction: z.enum(['IN', 'OUT']).optional(),
  /** 消息稳定标识（§9.2，幂等双保险，服务端当前仅透传不强制缓存） */
  stableMessageId: z.string().max(255).optional(),
});

export type TranslateInput = z.infer<typeof translateSchema>;

/** 新增翻译 Key（T4-06 AC1/AC4） */
export const createTranslationKeySchema = z.object({
  engine: z.enum(['GOOGLE', 'DEEPL']),
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称不超过 64 字符'),
  apiKey: z.string().trim().min(1, 'API Key 不能为空'),
  quotaLimit: z.number().int().min(0, '额度上限须为非负整数').nullable().optional(),
});

export type CreateTranslationKeyInputSchema = z.infer<typeof createTranslationKeySchema>;

/** 修改翻译 Key（T4-06 AC16） */
export const updateTranslationKeySchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  quotaLimit: z.number().int().min(0).nullable().optional(),
});

export type UpdateTranslationKeyInputSchema = z.infer<typeof updateTranslationKeySchema>;

/** 停用 / 启用 Key（T4-06 AC14） */
export const setKeyStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']),
});

/** 语种支持维护（T4-04 / P0-S-12 AC12） */
export const setLanguageSupportSchema = z.object({
  engine: z.enum(['GOOGLE', 'DEEPL']),
  languageCode: langCode,
  status: z.enum(['SUPPORTED', 'UNSUPPORTED']),
});
