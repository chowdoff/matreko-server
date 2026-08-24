/**
 * 一次性迁移脚本：把 LicenseKey.code 中已存的明文密钥码加密为 AES-256-GCM 密文
 *
 * 用法：
 *   npx tsx scripts/migrate-license-code-encrypt.ts
 *
 * 规则：
 *   - code 为 NULL：跳过（历史密钥明文从未入库，不可恢复）
 *   - code 已是密文（iv.ct.tag 格式，可成功解密）：跳过
 *   - code 是明文格式（MTRK-XXXX-XXXX-XXXX-XXXX）：加密回写
 *   - 既非密文也非明文格式：报告并跳过，需人工排查
 */
import { PrismaClient } from '@prisma/client';
import { encryptLicenseCode, tryDecryptLicenseCode, isValidLicenseCodeFormat } from '../src/lib/crypto';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  const keys = await prisma.licenseKey.findMany({
    where: { code: { not: null } },
    select: { id: true, code: true, codePrefix: true },
  });

  let encrypted = 0;
  let skippedAlreadyCipher = 0;
  let skippedUnknown = 0;
  let skippedNull = 0;

  for (const k of keys) {
    const raw = k.code!;
    // 已是密文：能解密成功
    if (tryDecryptLicenseCode(raw, env.licenseCodeEncKey)) {
      skippedAlreadyCipher++;
      continue;
    }
    // 明文格式：加密回写
    if (isValidLicenseCodeFormat(raw)) {
      const cipher = encryptLicenseCode(raw, env.licenseCodeEncKey);
      await prisma.licenseKey.update({
        where: { id: k.id },
        data: { code: cipher },
      });
      encrypted++;
      continue;
    }
    console.warn(`[skip] id=${k.id} prefix=${k.codePrefix} code 格式既非密文也非明文，需人工排查`);
    skippedUnknown++;
  }

  // code 为 NULL 的统计
  const nullCount = await prisma.licenseKey.count({ where: { code: null } });
  skippedNull = nullCount;

  console.log('迁移完成：');
  console.log(`  - 明文已加密回写：${encrypted}`);
  console.log(`  - 已是密文跳过：${skippedAlreadyCipher}`);
  console.log(`  - NULL（历史密钥，不可恢复）：${skippedNull}`);
  console.log(`  - 未知格式跳过：${skippedUnknown}`);
}

main()
  .catch((e) => {
    console.error('迁移失败：', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
