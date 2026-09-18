/**
 * 渠道账号标识解析（纯函数，无副作用 / 无 db 依赖）
 *
 * 背景：`channelAccountKey` 早期格式没有权威约定 —— 库里既有 `telegram:东南亚主号`（带渠道前缀）
 * 也有裸 `portId`（客户端 useAcquirePortMutation 实际只传 portId）。主管端靠 `split(':')[0]`
 * 猜渠道，key 不含冒号时会整体退化成"渠道 = 账号 id"。
 *
 * 本模块统一规范化规则，并作为 `port.service` / `channelAccount.service` / 回填脚本的唯一实现：
 * - 账号标识：显式传入优先 → 否则 key 含 ':' 取冒号后段 → 否则整个 key
 * - 渠道：显式传入优先 → 否则按冒号前缀识别（**无法识别时返回 null，绝不猜测**）
 *
 * 注意：「未知前缀」不等于「渠道为 unknown」——`123:456` 这种 key 的首段不是渠道名，
 * 此时渠道应为 null 而非字符串 '123'。
 */

/** 支持的 IM 渠道（与 prisma enum Channel 对齐） */
export const CHANNEL_VALUES = ['TELEGRAM', 'WHATSAPP'] as const;
export type ChannelValue = (typeof CHANNEL_VALUES)[number];

/** 渠道别名 → 枚举（小写匹配，兼容 telegram / Telegram） */
const CHANNEL_ALIAS: Record<string, ChannelValue> = {
  telegram: 'TELEGRAM',
  whatsapp: 'WHATSAPP',
};

/**
 * 解析 channelAccountKey。
 * - `'telegram:123456789'` → `{ channel: 'TELEGRAM', accountId: '123456789' }`
 * - `'k9x2m'` → `{ channel: null, accountId: 'k9x2m' }`
 * - `'123:456'` → `{ channel: null, accountId: '456' }`（前缀非渠道名，不猜测）
 * - `'tg:123'` → `{ channel: null, accountId: '123' }`（同上；别名表只认 telegram/whatsapp）
 */
export function parseChannelAccountKey(key: string): {
  channel: ChannelValue | null;
  accountId: string;
} {
  const idx = key.indexOf(':');
  if (idx < 0) return { channel: null, accountId: key };

  const prefix = key.slice(0, idx).trim();
  const rest = key.slice(idx + 1).trim();
  const channel = CHANNEL_ALIAS[prefix.toLowerCase()] ?? null;
  // 冒号后段为空（如 'telegram:'）时回落到整串，避免产出空 id
  return { channel, accountId: rest.length > 0 ? rest : key };
}

/**
 * 规范化账号标识（与 ChannelAccount.channelAccountId 对齐）。
 * 显式传入优先，其次按 key 解析 —— 保证同一账号在不同入口得到同一个 id。
 */
export function normalizeChannelAccountId(
  key: string,
  explicit?: string | null,
): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return parseChannelAccountKey(key).accountId;
}

/**
 * 规范化渠道枚举。
 * 显式传入优先；否则按 key 前缀识别；识别不出返回 `null`（由调用方决定是否跳过/回落）。
 */
export function normalizeChannel(
  explicit?: ChannelValue | null,
  key?: string,
): ChannelValue | null {
  if (explicit && CHANNEL_ALIAS[explicit.toLowerCase()]) {
    return CHANNEL_ALIAS[explicit.toLowerCase()]!;
  }
  if (key) return parseChannelAccountKey(key).channel;
  return null;
}

/** 组回 `CHANNEL:accountId` 形态的展示 key（渠道缺失时用 UNKNOWN 占位） */
export function buildChannelAccountKey(
  channel: ChannelValue | null,
  channelAccountId: string,
): string {
  return `${channel ?? 'UNKNOWN'}:${channelAccountId}`;
}
