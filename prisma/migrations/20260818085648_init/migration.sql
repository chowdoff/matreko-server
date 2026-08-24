-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "portQuota" INTEGER NOT NULL,
    "translationQuota" INTEGER NOT NULL DEFAULT 1500000,
    "translationUsed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE'
);

-- CreateTable
CREATE TABLE "admin_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "teamId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_accounts_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "license_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNUSED',
    "multiDeviceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deviceLimit" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "license_keys_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "device_bindings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyId" TEXT NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "boundAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_bindings_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "license_keys" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "client_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyId" TEXT NOT NULL,
    "deviceFingerprintHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRenewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_credentials_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "license_keys" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "port_leases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "channelAccountKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    CONSTRAINT "port_leases_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "port_leases_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "license_keys" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "translation_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "engine" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyEncrypted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "quotaLimit" INTEGER,
    "quotaUsed" INTEGER NOT NULL DEFAULT 0,
    "lastFailureReason" TEXT,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "engine_language_supports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "engine" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUPPORTED',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "translation_usage_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "keyId" TEXT,
    "engine" TEXT NOT NULL,
    "chars" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "licenseKeyId" TEXT,
    CONSTRAINT "translation_usage_logs_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "translation_usage_logs_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "translation_keys" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "translation_usage_logs_licenseKeyId_fkey" FOREIGN KEY ("licenseKeyId") REFERENCES "license_keys" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "revoked_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jti" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "revokeAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "backoffice_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "backoffice_sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "admin_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_accounts_email_key" ON "admin_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "license_keys_codeHash_key" ON "license_keys"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "device_bindings_keyId_fingerprintHash_key" ON "device_bindings"("keyId", "fingerprintHash");

-- CreateIndex
CREATE UNIQUE INDEX "client_credentials_clientId_key" ON "client_credentials"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "client_credentials_refreshTokenHash_key" ON "client_credentials"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "engine_language_supports_engine_languageCode_key" ON "engine_language_supports"("engine", "languageCode");

-- CreateIndex
CREATE INDEX "translation_usage_logs_teamId_createdAt_idx" ON "translation_usage_logs"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "revoked_tokens_jti_key" ON "revoked_tokens"("jti");

-- CreateIndex
CREATE INDEX "revoked_tokens_revokeAt_idx" ON "revoked_tokens"("revokeAt");

-- CreateIndex
CREATE UNIQUE INDEX "backoffice_sessions_tokenHash_key" ON "backoffice_sessions"("tokenHash");
