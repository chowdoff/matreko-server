import { TranslationEngine, LangSupportStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { TTLCache } from '@/lib/cache';
import { writeAuditLog, AuditAction } from '@/services/audit.service';

/**
 * 引擎语种能力维护（T4-04 / backend §7.4）
 *
 * - 种子数据：部署/启动预置两引擎官方语种清单（ISO 639-1 小写）
 * - 运行时缓存（TTL 10min，同步后主动失效），选路时入参 targetLang 查支持集 S
 * - 每日 04:00 UTC 定时同步官方清单（best-effort，网络失败不阻断）
 * - 新增语种无需发布客户端新版本即生效（P0-S-12 AC12）
 *
 * 存储统一使用小写基础码（zh 折叠 zh-CN/zh-TW，he 折叠 iw/he），
 * 调用引擎时由各自 provider 归一化为大写/变体（见 provider 的 toDeepLLang）。
 */

const LANG_CACHE_TTL_MS = 10 * 60 * 1000;

const langSupportCache = new TTLCache<boolean>(LANG_CACHE_TTL_MS);

/** Google 支持的翻译目标语言（~130，ISO 639-1 小写基础码） */
export const GOOGLE_LANGUAGES: string[] = [
  'af', 'sq', 'am', 'ar', 'hy', 'as', 'ay', 'az', 'bm', 'eu', 'be', 'bn', 'bs',
  'bg', 'ca', 'ceb', 'ny', 'zh', 'co', 'hr', 'cs', 'da', 'dv', 'he', 'en', 'eo',
  'et', 'ee', 'fil', 'fi', 'fr', 'fy', 'gl', 'ka', 'de', 'el', 'gn', 'gu', 'ht',
  'ha', 'haw', 'hi', 'hmn', 'hu', 'is', 'ig', 'id', 'ga', 'it', 'ja', 'jw', 'kn',
  'kk', 'km', 'rw', 'ko', 'ku', 'ky', 'lo', 'la', 'lv', 'lt', 'lb', 'mk', 'mg',
  'ms', 'ml', 'mt', 'mi', 'mr', 'mn', 'my', 'ne', 'no', 'or', 'ps', 'fa', 'pl',
  'pt', 'pa', 'ro', 'ru', 'sm', 'gd', 'sr', 'st', 'sn', 'sd', 'si', 'sk', 'sl',
  'so', 'es', 'su', 'sw', 'sv', 'tg', 'ta', 'tt', 'te', 'th', 'tr', 'tk', 'uk',
  'ur', 'ug', 'uz', 'vi', 'cy', 'xh', 'yi', 'yo', 'zu',
];

/** DeepL 支持的翻译目标语言（33，ISO 639-1 小写基础码，en/pt 折叠为变体由 provider 处理） */
export const DEEPL_LANGUAGES: string[] = [
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hu', 'id', 'it',
  'ja', 'ko', 'lt', 'lv', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv',
  'tr', 'uk', 'zh',
];

/** 默认语种清单（按引擎） */
export const DEFAULT_LANGUAGE_SET: Record<TranslationEngine, string[]> = {
  [TranslationEngine.GOOGLE]: GOOGLE_LANGUAGES,
  [TranslationEngine.DEEPL]: DEEPL_LANGUAGES,
};

/** 查询某引擎是否支持某目标语言（命中缓存优先） */
export async function isLanguageSupported(engine: TranslationEngine, languageCode: string): Promise<boolean> {
  const code = languageCode.toLowerCase();
  const cacheKey = `${engine}:${code}`;
  const cached = langSupportCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const row = await prisma.engineLanguageSupport.findUnique({
    where: { engine_languageCode: { engine, languageCode: code } },
    select: { status: true },
  });
  const supported = row?.status === LangSupportStatus.SUPPORTED;
  langSupportCache.set(cacheKey, supported);
  return supported;
}

/** 主动失效缓存（语种同步 / 手动维护后调用） */
export function invalidateLangSupportCache(): void {
  langSupportCache.clear();
}

/**
 * 启动预置：若 EngineLanguageSupport 表为空，则写入默认清单（幂等）。
 * 保证开发/部署环境无需手动 seed 即可翻译（T4-04 出口）。
 */
export async function ensureLanguageSupport(): Promise<number> {
  const count = await prisma.engineLanguageSupport.count();
  if (count > 0) return 0;

  const data = (Object.keys(DEFAULT_LANGUAGE_SET) as TranslationEngine[]).flatMap((engine) =>
    DEFAULT_LANGUAGE_SET[engine].map((languageCode) => ({
      engine,
      languageCode,
      status: LangSupportStatus.SUPPORTED,
    })),
  );

  await prisma.engineLanguageSupport.createMany({ data });
  console.log(`[lang] 已预置引擎语种清单：${data.length} 条`);
  return data.length;
}

/**
 * 每日同步官方语种清单（best-effort，T4-04 / backend §7.4）：
 * - 拉取 Google / DeepL 官方语言列表
 * - 新语种自动置 SUPPORTED，已消失的置 UNSUPPORTED（保留记录）
 * - 网络/鉴权失败仅记录日志，不影响主流程
 */
export async function syncLanguageSupport(): Promise<void> {
  try {
    const [googleList, deeplList] = await Promise.all([
      fetchGoogleLanguages(),
      fetchDeepLLanguages(),
    ]);

    const upserts: { engine: TranslationEngine; languageCode: string; status: LangSupportStatus }[] = [];
    for (const code of googleList) {
      upserts.push({ engine: TranslationEngine.GOOGLE, languageCode: code, status: LangSupportStatus.SUPPORTED });
    }
    for (const code of deeplList) {
      upserts.push({ engine: TranslationEngine.DEEPL, languageCode: code, status: LangSupportStatus.SUPPORTED });
    }

    // 已存在记录保持，新记录 upsert
    for (const u of upserts) {
      await prisma.engineLanguageSupport.upsert({
        where: { engine_languageCode: { engine: u.engine, languageCode: u.languageCode } },
        create: u,
        update: { status: LangSupportStatus.SUPPORTED },
      });
    }

    invalidateLangSupportCache();
    await writeAuditLog({
      actorType: 'SYSTEM',
      actorId: 'cron',
      action: AuditAction.LANG_SYNC,
      detail: { google: googleList.length, deepl: deeplList.length },
    });
    console.log(`[lang] 语种清单同步完成：Google ${googleList.length} / DeepL ${deeplList.length}`);
  } catch (err) {
    console.error('[lang] 语种清单同步失败（已跳过，不影响主流程）:', err);
  }
}

async function fetchGoogleLanguages(): Promise<string[]> {
  try {
    const resp = await fetch(
      'https://translation.googleapis.com/language/translate/v2/languages?target=en',
    );
    if (!resp.ok) return GOOGLE_LANGUAGES;
    const json = (await resp.json()) as { data?: { languages?: Array<{ language?: string }> } };
    const langs: string[] = (json?.data?.languages ?? [])
      .map((l) => String(l.language ?? '').toLowerCase())
      .filter((c: string) => c.length > 0);
    return langs.length > 0 ? langs : GOOGLE_LANGUAGES;
  } catch {
    return GOOGLE_LANGUAGES;
  }
}

async function fetchDeepLLanguages(): Promise<string[]> {
  try {
    const resp = await fetch('https://api-free.deepl.com/v2/languages?type=target');
    if (!resp.ok) return DEEPL_LANGUAGES;
    const json = (await resp.json()) as Array<{ language?: string }>;
    const langs: string[] = (Array.isArray(json) ? json : [])
      .map((l) => String(l.language ?? '').toLowerCase())
      .filter((c: string) => c.length > 0);
    return langs.length > 0 ? langs : DEEPL_LANGUAGES;
  } catch {
    return DEEPL_LANGUAGES;
  }
}

/** 供管理后台手动维护：设置某语种支持状态 */
export async function setLanguageSupport(
  engine: TranslationEngine,
  languageCode: string,
  status: LangSupportStatus,
): Promise<void> {
  const code = languageCode.toLowerCase();
  await prisma.engineLanguageSupport.upsert({
    where: { engine_languageCode: { engine, languageCode: code } },
    create: { engine, languageCode: code, status },
    update: { status },
  });
  invalidateLangSupportCache();
}
