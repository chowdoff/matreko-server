import { TranslationEngine } from '@prisma/client';
import { TranslationProvider, TranslateParams, TranslateResult, ProviderUsage, toDeepLLang } from './types';
import { TranslationProviderError, TRANSLATE_TIMEOUT_MS } from './errors';

const DEEPL_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const DEEPL_USAGE_ENDPOINT = 'https://api-free.deepl.com/v2/usage';

/** DeepL 翻译接口原始响应（仅声明实际访问的字段，避免 any） */
interface DeepLRaw {
  translations?: Array<{ text?: string; detected_source_language?: string }>;
}

/** DeepL 用量查询接口原始响应 */
interface DeepLUsageRaw {
  character_count?: number;
  character_limit?: number;
}

/**
 * DeepL v2 适配（T4-01 / backend §7.1）
 *
 * - 接口：POST {endpoint}，Header Authorization: DeepL-Auth-Key <key>，body form-urlencoded { text, source_lang?, target_lang }
 * - 成功：translations[0].{ text, detected_source_language }
 * - 错误归类：
 *   - 403 → AUTH（Key 无效，不可重试）
 *   - 456 → QUOTA（该 Key 额度耗尽，不可重试，标记 EXHAUSTED）
 *   - 429 → RATE_LIMIT（可重试）
 *   - 5xx → SERVER（可重试）
 *   - 网络/超时 → NETWORK（可重试）
 */
export class DeepLProvider implements TranslationProvider {
  readonly engine = TranslationEngine.DEEPL;

  async translate(params: TranslateParams, apiKey: string): Promise<TranslateResult> {
    const target = toDeepLLang(params.targetLang);
    const source = params.sourceLang ? toDeepLLang(params.sourceLang, true) : undefined;

    const form = new URLSearchParams();
    form.set('text', params.text);
    form.set('target_lang', target);
    if (source) form.set('source_lang', source);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
    try {
      const resp = await fetch(DEEPL_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: controller.signal,
      });

      const raw = await resp.text();
      if (!resp.ok) {
        throw this.classify(resp.status, raw);
      }

      const json = safeJson(raw) as DeepLRaw;
      const translations = json?.translations;
      if (!Array.isArray(translations) || translations.length === 0) {
        throw new TranslationProviderError({
          kind: 'SERVER',
          retryable: true,
          message: 'DeepL 返回结构异常',
          status: resp.status,
        });
      }
      const first = translations[0];
      return {
        translatedText: String(first.text ?? ''),
        detectedSourceLang: first.detected_source_language
          ? String(first.detected_source_language).toLowerCase()
          : undefined,
      };
    } catch (err) {
      if (err instanceof TranslationProviderError) throw err;
      if (err instanceof TypeError && err.message.includes('aborted')) {
        throw new TranslationProviderError({
          kind: 'NETWORK',
          retryable: true,
          message: 'DeepL 翻译请求超时',
        });
      }
      throw new TranslationProviderError({
        kind: 'NETWORK',
        retryable: true,
        message: `DeepL 翻译网络异常：${(err as Error).message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 查询 DeepL 引擎侧真实用量（T4-06 连通性校验 + 真实额度展示）。
   * GET /v2/usage，返回 { character_count, character_limit }。
   * - 403 → AUTH（Key 无效），天然复用 testKey 的 hardFail 逻辑
   * - 网络异常 → NETWORK（可重试），不影响主校验
   */
  async getUsage(apiKey: string): Promise<ProviderUsage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
    try {
      const resp = await fetch(DEEPL_USAGE_ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
        signal: controller.signal,
      });
      const raw = await resp.text();
      if (!resp.ok) {
        throw this.classify(resp.status, raw);
      }

      const json = safeJson(raw) as DeepLUsageRaw;
      const count = typeof json?.character_count === 'number' ? json.character_count : 0;
      const limit = typeof json?.character_limit === 'number' ? json.character_limit : null;
      return {
        characterCount: count,
        characterLimit: limit,
        remaining: limit == null ? null : Math.max(limit - count, 0),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof TranslationProviderError) throw err;
      if (err instanceof TypeError && err.message.includes('aborted')) {
        throw new TranslationProviderError({
          kind: 'NETWORK',
          retryable: true,
          message: 'DeepL 用量查询超时',
        });
      }
      throw new TranslationProviderError({
        kind: 'NETWORK',
        retryable: true,
        message: `DeepL 用量查询网络异常：${(err as Error).message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(status: number, raw: string): TranslationProviderError {
    const msg = raw.slice(0, 200);
    if (status === 403) {
      return new TranslationProviderError({ kind: 'AUTH', retryable: false, message: `DeepL Key 无效：${msg}`, status });
    }
    if (status === 456) {
      return new TranslationProviderError({ kind: 'QUOTA', retryable: false, message: `DeepL Key 额度耗尽：${msg}`, status });
    }
    if (status === 429) {
      return new TranslationProviderError({ kind: 'RATE_LIMIT', retryable: true, message: `DeepL 限流：${msg}`, status });
    }
    if (status >= 500) {
      return new TranslationProviderError({ kind: 'SERVER', retryable: true, message: `DeepL 服务错误：${msg}`, status });
    }
    return new TranslationProviderError({ kind: 'CONTENT', retryable: false, message: `DeepL 请求被拒：${msg}`, status });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const deeplProvider = new DeepLProvider();
