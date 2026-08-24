import { ENGINE_MAX_CHARS } from './types';

/**
 * 字符计数：以 Unicode 码点为准（CJK / emoji 计为 1 字符，与配额计量口径一致）。
 */
export function charCount(text: string): number {
  return [...text].length;
}

/**
 * 超长消息分片（T4-05 / backend §7.6）：
 * 单条 ≤ ENGINE_MAX_CHARS 直接返回 [text]；
 * 超过则按「句子边界」贪心切分为每片 ≤ chunkSize 的若干片，逐片翻译后合并；
 * 若某段在句子边界处仍无断点且超过 chunkSize，则按硬上限强制切断（保证单段不超引擎上限）。
 *
 * @param text 原文
 * @param chunkSize 单片上限（默认 4500，来自 env，由调用方传入）
 */
export function splitIntoChunks(text: string, chunkSize: number): string[] {
  const max = chunkSize > 0 ? chunkSize : ENGINE_MAX_CHARS;
  if (charCount(text) <= ENGINE_MAX_CHARS && charCount(text) <= max) {
    return [text];
  }

  const points = Array.from(text);
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join(''));
      current = [];
    }
  };

  for (let i = 0; i < points.length; i++) {
    const ch = points[i];
    current.push(ch);

    const atSentenceEnd = isSentenceBoundary(ch);
    const reachedThreshold = charCount(current.join('')) >= Math.floor(max * 0.8);

    if (atSentenceEnd && reachedThreshold) {
      flush();
      continue;
    }
    // 硬上限保护：当前片已达 max 且仍未遇到句子边界，强制切断
    if (charCount(current.join('')) >= max) {
      flush();
    }
  }
  flush();

  // 兜底：若某片因无断点仍超 max（极端长词），按 max 硬切
  const safe: string[] = [];
  for (const c of chunks) {
    if (charCount(c) <= max) {
      safe.push(c);
    } else {
      for (let i = 0; i < c.length; i += max) {
        safe.push(c.slice(i, i + max));
      }
    }
  }
  return safe.length > 0 ? safe : [text];
}

/** 句子边界判定（中英文标点 + 换行） */
function isSentenceBoundary(ch: string): boolean {
  return /[。！？!?；;\n\r]/.test(ch);
}

/**
 * 按片段顺序合并译文。
 * 各引擎对片段译文通常已保留标点，直接拼接即可；去除引擎可能多余的首尾空白仅做整体 trim。
 */
export function mergeChunks(translatedChunks: string[]): string {
  return translatedChunks.join('').trim();
}
