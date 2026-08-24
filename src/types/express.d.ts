import { AdminAccount, BackofficeSession, Team } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** 后台会话（requireBackofficeAuth 注入） */
      session?: BackofficeSession;
      /** 后台账号（含团队，requireBackofficeAuth 注入） */
      account?: AdminAccount & { team?: Team | null };
      /** 客户端凭据 claims（requireClientAuth 注入） */
      auth?: {
        keyId: string;
        clientId: string;
        deviceFingerprintHash: string;
        jti: string;
      };
      /** 当前 access token 剩余有效期（毫秒），供续期判断（requireClientAuth 注入） */
      authExpiresInMs?: number;
    }
  }
}

export {};
