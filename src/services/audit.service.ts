import { ActorType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** 标准审计动作枚举（backend §3.2 AuditLog / §10） */
export const AuditAction = {
  CREDENTIAL_TAMPERED: 'credential_tampered',
  FINGERPRINT_MISMATCH: 'fingerprint_mismatch',
  TEAM_DISABLED: 'team_disabled',
  TEAM_ENABLED: 'team_enabled',
  TEAM_CREATED: 'team_created',
  KEY_DISABLED: 'key_disabled',
  KEY_ENABLED: 'key_enabled',
  QUOTA_CHANGED: 'quota_changed',
  LEASE_RELEASED_MANUAL: 'lease_released_manual',
  LEASE_RELEASED_TIMEOUT: 'lease_released_timeout',
  LOGIN_LOCKED: 'login_locked',
  ACCOUNT_RESET: 'account_reset',
  DEVICE_UNBOUND: 'device_unbound',
  DEVICE_OFFLINED: 'device_offlined',
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  PASSWORD_CHANGED: 'password_changed',
  ACTIVATE: 'activate',
  TOKEN_REVOKED: 'token_revoked',
  MULTI_DEVICE_CHANGED: 'multi_device_changed',
  LICENSE_GENERATED: 'license_generated',
  LANG_SYNC: 'lang_sync',
  TRANSLATION_KEY_ADDED: 'translation_key_added',
  TRANSLATION_KEY_UPDATED: 'translation_key_updated',
  TRANSLATION_KEY_STATUS_CHANGED: 'translation_key_status_changed',
  TRANSLATION_FAILED: 'translation_failed',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

interface WriteAuditParams {
  actorType: ActorType;
  actorId: string;
  action: AuditActionValue | string;
  detail?: unknown;
  ip?: string | null;
  /** 传入事务客户端时在事务内写入 */
  tx?: Prisma.TransactionClient;
}

/** 审计日志写入工具（后续所有安全事件统一调用） */
export async function writeAuditLog(params: WriteAuditParams): Promise<void> {
  const { actorType, actorId, action, detail, ip, tx } = params;
  const client = tx ?? prisma;
  await client.auditLog.create({
    data: {
      actorType,
      actorId,
      action,
      detail: detail !== undefined ? JSON.stringify(detail) : undefined,
      ip: ip ?? undefined,
    },
  });
}
