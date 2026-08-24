import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const BCRYPT_COST = 12;

/** 密码哈希（bcrypt cost=12，不可还原，P0-A-19 AC16） */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** SHA-256 十六进制摘要 */
export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 指纹哈希：SHA-256(fingerprint + keyId)（backend §5.3） */
export function hashFingerprint(fingerprint: string, keyId: string): string {
  return sha256(`${fingerprint}:${keyId}`);
}

/** 生成 N 字节安全随机串（Base64url，不含 `=`） */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 256 位安全随机数（refresh token / 后台会话 token） */
export function generateSecret(): string {
  return randomToken(32);
}

const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成随机初始密码（P0-A-19 AC2/AC10）：
 * 12 位字母数字混合，强制第 1 位字母 + 第 2 位数字，保证满足
 * 「长度 ≥ 8 且同时含字母与数字」。
 */
export function generateInitialPassword(length = 12): string {
  if (length < 2) throw new Error('初始密码长度不能小于 2');
  const bytes = crypto.randomBytes(length);
  const chars = Array.from({ length }, (_, i) => ALPHANUM[bytes[i] % ALPHANUM.length]);
  // 强制含字母与数字（不被随机位覆盖）
  chars[0] = ALPHANUM[crypto.randomInt(0, 26)]; // 大写/小写字母
  chars[1] = ALPHANUM[26 + crypto.randomInt(0, 10)]; // 数字
  return chars.join('');
}

// ── 密钥 code 生成（P0-B-09 AC1 / backend §5.2） ──

/** Base32 字符集（RFC 4648，A-Z2-7），大写便于键盘输入 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Char(): string {
  const idx = crypto.randomInt(0, BASE32_ALPHABET.length);
  return BASE32_ALPHABET[idx];
}

/**
 * 生成密钥明文：`MTRK-XXXX-XXXX-XXXX-XXXX`
 * （前缀 + 4 组 × 4 位 Base32，约 20 字符可键盘输入）
 */
export function generateLicenseCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let chunk = '';
    for (let i = 0; i < 4; i++) chunk += base32Char();
    groups.push(chunk);
  }
  return `MTRK-${groups.join('-')}`;
}

// ── AES-256-GCM 对称加解密（密钥码存储保密，backend §10） ──

const AES_ALGO = 'aes-256-gcm';
const GCM_IV_LEN = 12; // GCM 推荐 12 字节 IV
const GCM_TAG_LEN = 16;

/** 校验主密钥格式：32 字节 base64（密钥码与翻译 API Key 共用此校验） */
function assertKeyBytes(keyBase64: string): Buffer {
  const buf = Buffer.from(keyBase64, 'base64');
  if (buf.length !== 32) {
    throw new Error('主密钥必须是 32 字节 base64 编码（AES-256）');
  }
  return buf;
}

/**
 * AES-256-GCM 加密：返回 `iv.ct.tag` 三段 base64 拼接
 * 每次加密生成随机 IV，相同明文产出不同密文
 */
export function encryptLicenseCode(plaintext: string, keyBase64: string): string {
  const key = assertKeyBytes(keyBase64);
  const iv = crypto.randomBytes(GCM_IV_LEN);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), ct.toString('base64'), tag.toString('base64')].join('.');
}

/**
 * AES-256-GCM 解密：输入 `iv.ct.tag` base64 拼接
 * 认证失败（密文被篡改/密钥错误）抛错
 */
export function decryptLicenseCode(packed: string, keyBase64: string): string {
  const parts = packed.split('.');
  if (parts.length !== 3) throw new Error('密文格式非法（期望 iv.ct.tag）');
  const [ivB64, ctB64, tagB64] = parts;
  const key = assertKeyBytes(keyBase64);
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== GCM_IV_LEN || tag.length !== GCM_TAG_LEN) {
    throw new Error('密文 IV/tag 长度非法');
  }
  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * 安全解密：失败返回 null（用于历史/异常数据不阻断列表响应）
 */
export function tryDecryptLicenseCode(packed: string, keyBase64: string): string | null {
  try {
    return decryptLicenseCode(packed, keyBase64);
  } catch {
    return null;
  }
}

// ── 通用 AES-256-GCM（与密钥 code 同方案，仅主密钥不同；翻译 API Key 用 API_KEY_ENC_KEY） ──

/** 通用加密：返回 `iv.ct.tag` 三段 base64 拼接（翻译 API Key 等敏感字段存储） */
export const encryptSecret = encryptLicenseCode;

/** 通用解密：翻译 API Key 等（认证失败抛错） */
export const decryptSecret = decryptLicenseCode;

/** 安全解密：失败返回 null */
export function tryDecryptSecret(packed: string, keyBase64: string): string | null {
  try {
    return decryptSecret(packed, keyBase64);
  } catch {
    return null;
  }
}
