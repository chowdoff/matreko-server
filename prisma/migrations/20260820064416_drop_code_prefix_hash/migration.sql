/*
  Warnings:

  - You are about to drop the column `codeHash` on the `license_keys` table. All the data in the column will be lost.
  - You are about to drop the column `codePrefix` on the `license_keys` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_license_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNUSED',
    "multiDeviceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deviceLimit" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "license_keys_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_license_keys" ("code", "createdAt", "deviceLimit", "id", "multiDeviceEnabled", "nickname", "status", "teamId") SELECT "code", "createdAt", "deviceLimit", "id", "multiDeviceEnabled", "nickname", "status", "teamId" FROM "license_keys";
DROP TABLE "license_keys";
ALTER TABLE "new_license_keys" RENAME TO "license_keys";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
