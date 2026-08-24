import { TranslationEngine } from '@prisma/client';
import { TranslationProvider, TranslateParams, TranslateResult, toGoogleLang } from './types';
import { TranslationProviderError, TRANSLATE_TIMEOUT_MS } from './errors';

const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

/** Google 翻译接口原始响应（仅声明实际访问的字段，避免 any） */
interface GoogleRaw {
  data?: { translations?: Array<{ translatedText?: string; detectedSourceLanguage?: string }> };
  error?: { message?: string; errors?: Array<{ reason?: string }> };
}

/**
 * Google Translate v2 适配（T4-01 / backend §7.1）
 *
 * - 接口：POST {endpoint}?key=APIKEY，body JSON { q, source?, target, format: 'text' }
 * - 成功：data.translations[0].{ translatedText, detectedSourceLanguage }
 * - 错误归类：
 *   - 400 + reason=keyInvalid → AUTH（不可重试）
 *   - 400 + reason=quotaExceeded / userRateLimitExceeded → QUOTA（不可重试，标记该 Key 额度耗尽）
 *   - 429 → RATE_LIMIT（可重试）
 *   - 5xx → SERVER（可重试）
 *   - 网络/超时 → NETWORK（可重试）
 */
export class GoogleProvider implements TranslationProvider {
  readonly engine = TranslationEngine.GOOGLE;

  async translate(params: TranslateParams, apiKey: string): Promise<TranslateResult> {
    const target = toGoogleLang(params.targetLang);
    const source = params.sourceLang ? toGoogleLang(params.sourceLang) : undefined;

    const url = `${GOOGLE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: params.text,
          target,
          ...(source ? { source } : {}),
          format: 'text',
        }),
        signal: controller.signal,
      });

      const raw = await resp.text();
      if (!resp.ok) {
        throw this.classify(resp.status, raw);
      }

      const json = safeJson(raw) as GoogleRaw;
      const translations = json?.data?.translations;
      if (!Array.isArray(translations) || translations.length === 0) {
        throw new TranslationProviderError({
          kind: 'SERVER',
          retryable: true,
          message: 'Google 返回结构异常',
          status: resp.status,
        });
      }
      const first = translations[0];
      return {
        translatedText: String(first.translatedText ?? ''),
        detectedSourceLang: first.detectedSourceLanguage
          ? String(first.detectedSourceLanguage).toLowerCase()
          : undefined,
      };
    } catch (err) {
      if (err instanceof TranslationProviderError) throw err;
      if (err instanceof TypeError && err.message.includes('aborted')) {
        throw new TranslationProviderError({
          kind: 'NETWORK',
          retryable: true,
          message: 'Google 翻译请求超时',
        });
      }
      // fetch 网络层失败（DNS / 连接拒绝 / 离线）
      throw new TranslationProviderError({
        kind: 'NETWORK',
        retryable: true,
        message: `Google 翻译网络异常：${(err as Error).message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(status: number, raw: string): TranslationProviderError {
    const json = safeJson(raw) as GoogleRaw;
    const reason: string | undefined = json?.error?.errors?.[0]?.reason;
    const msg: string = json?.error?.message ?? raw.slice(0, 200);

    if (status === 400 && reason === 'keyInvalid') {
      return new TranslationProviderError({ kind: 'AUTH', retryable: false, message: `Google Key 无效：${msg}`, status });
    }
    if (status === 400 && (reason === 'quotaExceeded' || reason === 'userRateLimitExceeded')) {
      return new TranslationProviderError({ kind: 'QUOTA', retryable: false, message: `Google Key 额度耗尽：${msg}`, status });
    }
    if (status === 400 && reason === 'invalidTranslationLanguage') {
      return new TranslationProviderError({ kind: 'PARAM', retryable: false, message: `Google 不支持的语言：${msg}`, status });
    }
    if (status === 429) {
      return new TranslationProviderError({ kind: 'RATE_LIMIT', retryable: true, message: `Google 限流：${msg}`, status });
    }
    if (status >= 500) {
      return new TranslationProviderError({ kind: 'SERVER', retryable: true, message: `Google 服务错误：${msg}`, status });
    }
    // 其它 4xx（含 403）
    return new TranslationProviderError({ kind: 'AUTH', retryable: false, message: `Google 请求被拒：${msg}`, status });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const googleProvider = new GoogleProvider();
