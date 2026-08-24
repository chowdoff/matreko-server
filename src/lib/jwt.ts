import jwt, { SignOptions, JwtPayload } from 'jsonwebtoken';
import { env } from '@/config/env';

/**
 * 客户端 access token claims（backend §4.3）：
 * - sub: clientId（限流维度 key）
 * - token_type: 'client'（与后台会话凭据隔离，P0-A-19 AC17）
 * - jti: 唯一标识，用于撤销名单 / 续期轮换宽限期
 */
export interface ClientAccessTokenPayload {
  sub: string; // clientId
  keyId: string;
  deviceFingerprintHash: string;
  token_type: 'client';
  jti: string;
}

export interface VerifiedClientToken {
  payload: ClientAccessTokenPayload;
  /** 剩余有效期（毫秒），供续期宽限期判断（backend §4.3） */
  expiresInMs: number;
}

/** token_type 非 client 的 JWT（P0-A-19 AC17）：供鉴权链区分「凭据类型不符」而非「签名无效」 */
export class TokenTypeMismatchError extends Error {
  constructor() {
    super('TOKEN_TYPE_MISMATCH');
    this.name = 'TokenTypeMismatchError';
  }
}

/** 签发客户端 access token（HS256） */
export function signClientAccessToken(
  payload: Omit<ClientAccessTokenPayload, 'token_type'>,
): string {
  const options: SignOptions = {
    algorithm: 'HS256',
    expiresIn: Math.floor(env.accessTokenTtlMs / 1000),
  };
  return jwt.sign({ ...payload, token_type: 'client' }, env.jwtSecret, options);
}

/**
 * 校验客户端 access token：
 * 签名 / 过期 / token_type 必须为 'client'（P0-A-19 AC17 双守卫之一）。
 */
export function verifyClientAccessToken(token: string): VerifiedClientToken {
  const payload = jwt.verify(token, env.jwtSecret, {
    algorithms: ['HS256'],
  }) as JwtPayload;

  if (payload.token_type !== 'client') {
    throw new TokenTypeMismatchError();
  }
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.keyId !== 'string' ||
    typeof payload.deviceFingerprintHash !== 'string' ||
    typeof payload.jti !== 'string'
  ) {
    throw new Error('INVALID_TOKEN_CLAIMS');
  }

  const expMs = (payload.exp ?? 0) * 1000;
  return {
    payload: {
      sub: payload.sub,
      keyId: payload.keyId,
      deviceFingerprintHash: payload.deviceFingerprintHash,
      token_type: 'client',
      jti: payload.jti,
    },
    expiresInMs: expMs - Date.now(),
  };
}
