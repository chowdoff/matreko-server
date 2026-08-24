/*
  Warnings:

  - Added the required column `nickname` to the `license_keys` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_license_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNUSED',
    "multiDeviceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deviceLimit" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "license_keys_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_license_keys" ("codeHash", "codePrefix", "createdAt", "deviceLimit", "id", "multiDeviceEnabled", "status", "teamId") SELECT "codeHash", "codePrefix", "createdAt", "deviceLimit", "id", "multiDeviceEnabled", "status", "teamId" FROM "license_keys";
DROP TABLE "license_keys";
ALTER TABLE "new_license_keys" RENAME TO "license_keys";
CREATE UNIQUE INDEX "license_keys_codeHash_key" ON "license_keys"("codeHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
