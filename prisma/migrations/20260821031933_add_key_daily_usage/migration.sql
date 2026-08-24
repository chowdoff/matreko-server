-- CreateTable
CREATE TABLE "key_daily_usages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "chars" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "key_daily_usages_keyId_date_idx" ON "key_daily_usages"("keyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "key_daily_usages_keyId_date_key" ON "key_daily_usages"("keyId", "date");

-- CreateIndex
CREATE INDEX "translation_usage_logs_keyId_createdAt_idx" ON "translation_usage_logs"("keyId", "createdAt");
