import { PrismaClient } from '@prisma/client';
import { ensureLanguageSupport } from '../src/services/translation/langSupport';

const prisma = new PrismaClient();

/**
 * 种子数据
 *
 * - M4 翻译代理：预置 Google / DeepL 引擎语种清单（EngineLanguageSupport）
 * - 部署初始化（P0-A-19 AC1）由服务端启动时自动完成，不在此处执行
 * - 翻译引擎 Key 含敏感凭据，不在此写入；请在管理后台手动添加
 */
async function main() {
  const seeded = await ensureLanguageSupport();
  console.log(`seed: 语种清单已预置 ${seeded} 条`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
