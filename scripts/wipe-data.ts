/**
 * 一次性脚本：抹除所有业务数据，仅保留 PLATFORM 超级管理员
 *
 * 用法：
 *   npx tsx scripts/wipe-data.ts
 *
 * 抹除范围：Team / LicenseKey / PortLease / ClientCredential / DeviceBinding
 *           / TranslationKey / EngineLanguageSupport / TranslationUsageLog
 *           / AuditLog / BackofficeSession / RevokedToken / SUPERVISOR 账号
 * 保留：AdminAccount where role = PLATFORM
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('开始抹除业务数据...');

  // 按外键依赖顺序删除
  const steps = [
    { name: 'TranslationUsageLog', fn: () => prisma.translationUsageLog.deleteMany({}) },
    { name: 'PortLease', fn: () => prisma.portLease.deleteMany({}) },
    { name: 'ClientCredential', fn: () => prisma.clientCredential.deleteMany({}) },
    { name: 'DeviceBinding', fn: () => prisma.deviceBinding.deleteMany({}) },
    { name: 'LicenseKey', fn: () => prisma.licenseKey.deleteMany({}) },
    { name: 'TranslationKey', fn: () => prisma.translationKey.deleteMany({}) },
    { name: 'EngineLanguageSupport', fn: () => prisma.engineLanguageSupport.deleteMany({}) },
    { name: 'AuditLog', fn: () => prisma.auditLog.deleteMany({}) },
    { name: 'BackofficeSession', fn: () => prisma.backofficeSession.deleteMany({}) },
    { name: 'RevokedToken', fn: () => prisma.revokedToken.deleteMany({}) },
    { name: 'Team', fn: () => prisma.team.deleteMany({}) },
    { name: 'SUPERVISOR 账号', fn: () => prisma.adminAccount.deleteMany({ where: { role: 'SUPERVISOR' } }) },
  ];

  for (const step of steps) {
    const r = await step.fn();
    console.log(`  - ${step.name}: 删除 ${r.count} 条`);
  }

  // 确认超级管理员仍在
  const admins = await prisma.adminAccount.findMany({
    where: { role: 'PLATFORM' },
    select: { id: true, email: true, role: true, status: true },
  });
  console.log(`\n保留的超级管理员（${admins.length} 条）：`);
  for (const a of admins) {
    console.log(`  - ${a.email} (id=${a.id}, status=${a.status})`);
  }
}

main()
  .then(async () => {
    console.log('\n抹除完成');
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('抹除失败：', e);
    await prisma.$disconnect();
    process.exit(1);
  });
