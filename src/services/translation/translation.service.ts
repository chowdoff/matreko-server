import { TranslationEngine, TranslationKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';
import { AppError } from '@/utils/AppError';
import { ErrorCode } from '@/constants/errorCodes';
import { tryDecryptSecret } from '@/lib/crypto';
import { getProvider } from './providerRegistry';
import { TranslateParams, TranslateResult, ENGINE_MAX_CHARS } from './types';
import { TranslationProviderError } from './errors';
import { splitIntoChunks, mergeChunks, charCount } from './chunker';
import {
  selectEnginesForTranslate,
  selectKey,
  recordKeyFailure,
  recordKeySuccess,
} from './router';

/** 单次翻译最多尝试的 (引擎, Key) 组合数（防极端情况下无限切换，backend §7.5） */
const MAX_ATTEMPTS = 4;

export interface TranslateRequest {
  text: string;
  sourceLang?: string;
  targetLang: string;
  /** 翻译方向（IN=收/OUT=发），服务端仅按 targetLang 路由，字段保留供对账 */
  direction?: 'IN' | 'OUT';
  /** 客户端所属团队 ID（来自鉴权链路） */
  teamId: string;
  /** 客户端实际使用的密钥 ID（licenseKey.id，用于按密钥维度计量） */
  clientKeyId: string;
}

export interface TranslateResponse {
  translatedText: string;
  detectedSourceLang?: string;
  engine: TranslationEngine;
  /** 原文总字符数（计量口径：按原文一次） */
  chars: number;
}

export class TranslationService {
  /**
   * 翻译主流程（T4-02 / T4-05 / 计量口径 §8.1）
   *
   * ① 团队翻译配额检查（达上限 → QUOTA_EXHAUSTED）
   * ② 双层选路：选引擎（按可用 Key + 语种支持）+ 选 Key（剩余额度加权随机 + 失败避让）
   * ③ 超长消息分片翻译后合并
   * ④ 成功即计量（TranslationUsageLog + 原子自增 Team / Key 用量），失败不计
   * ⑤ Key 级错误（无效/额度耗尽）自动标记并换 Key；全部不可用 → TRANSLATION_SERVICE_UNAVAILABLE
   */
  async translate(req: TranslateRequest): Promise<TranslateResponse> {
    const { text, sourceLang, targetLang, teamId, clientKeyId } = req;

    if (!text || text.trim().length === 0) {
      throw AppError.badRequest('翻译文本不能为空');
    }

    // ① 配额检查（处理前，backend §8.2）
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { translationUsed: true, translationQuota: true },
    });
    if (!team) throw AppError.notFound('团队不存在');
    if (team.translationUsed >= team.translationQuota) {
      throw AppError.of(
        409,
        ErrorCode.QUOTA_EXHAUSTED,
        '翻译配额已耗尽，请联系主管调大配额',
        { used: team.translationUsed, quota: team.translationQuota },
      );
    }

    // ② 选引擎（含语种支持判定；无引擎/语言不支持会在此抛出）
    const candidateEngines = await selectEnginesForTranslate(targetLang);

    // ③⑤ 逐引擎、逐 Key 尝试（上限 MAX_ATTEMPTS 次组合）
    let lastErr: TranslationProviderError | null = null;
    let attempts = 0;
    const triedKeyIds = new Set<string>();

    for (const engine of candidateEngines) {
      let key = (await selectKey(engine)) ?? null;
      let guard = 0;
      while (key && guard < 8) {
        guard++;
        if (triedKeyIds.has(key.id)) {
          key = await selectKey(engine);
          continue;
        }
        triedKeyIds.add(key.id);
        attempts++;

        try {
          const result = await this.translateWithKey(engine, key, {
            text,
            sourceLang,
            targetLang,
          });
          // ④ 成功即计量（同事务原子自增）
          await this.meter(teamId, clientKeyId, key, engine, charCount(text));
          recordKeySuccess(key.id);
          return {
            translatedText: result.translatedText,
            detectedSourceLang: result.detectedSourceLang,
            engine,
            chars: charCount(text),
          };
        } catch (err) {
          const perr = err as TranslationProviderError;
          lastErr = perr;
          // Key 级错误（无效/额度耗尽）→ 标记状态并换 Key；其余（429/5xx/网络）→ 失败避让换 Key
          if (perr.keyUnavailable) {
            await this.markKeyUnavailable(key, perr);
          }
          recordKeyFailure(key.id);

          if (attempts >= MAX_ATTEMPTS) break;
          key = await selectKey(engine);
        }
      }
      if (attempts >= MAX_ATTEMPTS) break;
    }

    // 全部组合失败
    throw this.mapProviderError(lastErr);
  }

  /**
   * 用指定 Key 完成一次翻译（含超长分片，T4-05）。
   * - 单条 ≤ ENGINE_MAX_CHARS：直接调用
   * - 超长：按句子边界分片（≤ chunkSize）逐片翻译，合并完整译文
   * - 任一片失败 → 抛出（整条失败，不计量、不返回截断译文）
   */
  private async translateWithKey(
    engine: TranslationEngine,
    key: TranslationKey,
    params: TranslateParams,
  ): Promise<TranslateResult> {
    const provider = getProvider(engine);
    const apiKey = tryDecryptSecret(key.keyEncrypted, env.apiKeyEncKey);
    if (!apiKey) {
      // 密文损坏 / 为空 / 主密钥不匹配：该 Key 实质已失效，按 key 级错误标记并换 Key
      throw new TranslationProviderError({
        kind: 'AUTH',
        retryable: false,
        message: '翻译 Key 解密失败（密文损坏或主密钥不匹配）',
      });
    }

    const total = charCount(params.text);
    if (total <= ENGINE_MAX_CHARS) {
      return provider.translate(params, apiKey);
    }

    // 分片翻译
    const chunks = splitIntoChunks(params.text, env.chunkSize);
    const translatedChunks: string[] = [];
    let detectedSourceLang: string | undefined;
    for (const chunk of chunks) {
      const r = await provider.translate({ ...params, text: chunk }, apiKey);
      if (!detectedSourceLang && r.detectedSourceLang) {
        detectedSourceLang = r.detectedSourceLang;
      }
      translatedChunks.push(r.translatedText);
    }
    return { translatedText: mergeChunks(translatedChunks), detectedSourceLang };
  }

  /** 计量写入（T5-01 / §8.1）：成功即落 TranslationUsageLog，同事务原子自增 Team / Key 用量 */
  private async meter(
    teamId: string,
    clientKeyId: string,
    key: TranslationKey,
    engine: TranslationEngine,
    chars: number,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.translationUsageLog.create({
        data: {
          teamId,
          keyId: key.id,
          licenseKeyId: clientKeyId,
          engine,
          chars,
          success: true,
        },
      });
      await tx.team.update({
        where: { id: teamId },
        data: { translationUsed: { increment: chars } },
      });
      await tx.translationKey.update({
        where: { id: key.id },
        data: { quotaUsed: { increment: chars }, lastUsedAt: new Date() },
      });
    });
  }

  /** Key 级错误标记：AUTH → INVALID，QUOTA → EXHAUSTED（P0-S-12 AC15） */
  private async markKeyUnavailable(key: TranslationKey, err: TranslationProviderError): Promise<void> {
    const status = err.kind === 'QUOTA' ? 'EXHAUSTED' : 'INVALID';
    try {
      await prisma.translationKey.update({
        where: { id: key.id },
        data: { status, lastFailureReason: err.message.slice(0, 255) },
      });
    } catch {
      // 标记失败不影响本次返回（仍按不可用处理，换 Key 继续）
    }
  }

  /** 将最后一次引擎错误映射为客户端可区分错误（backend §7.5） */
  private mapProviderError(err: TranslationProviderError | null): AppError {
    if (!err) {
      return AppError.of(
        503,
        ErrorCode.TRANSLATION_SERVICE_UNAVAILABLE,
        '翻译服务不可用，请联系管理员',
      );
    }
    switch (err.kind) {
      case 'AUTH':
        return AppError.of(503, ErrorCode.API_KEY_INVALID, `翻译 Key 无效：${err.message}`);
      case 'QUOTA':
        return AppError.of(503, ErrorCode.TRANSLATION_SERVICE_UNAVAILABLE, `翻译 Key 额度耗尽：${err.message}`);
      case 'CONTENT':
        return AppError.of(400, ErrorCode.CONTENT_REJECTED, `翻译内容被拒绝：${err.message}`);
      case 'PARAM':
        return AppError.of(400, ErrorCode.PARAM_INVALID, `翻译参数非法：${err.message}`);
      default:
        // RATE_LIMIT / SERVER / NETWORK：引擎整体不可用，客户端按 P0-T-08 熔断处理
        return AppError.of(
          503,
          ErrorCode.TRANSLATION_SERVICE_UNAVAILABLE,
          `翻译服务暂时不可用：${err.message}`,
        );
    }
  }
}

export const translationService = new TranslationService();
