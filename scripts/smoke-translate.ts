import { prisma } from '@/lib/prisma';
import { translationService } from '@/services/translation/translation.service';
import { encryptSecret } from '@/lib/crypto';
import { env } from '@/config/env';

async function main() {
  // 取第一个团队（无则创建）+ 一个客户端 licenseKey
  let team = await prisma.team.findFirst();
  if (!team) {
    team = await prisma.team.create({
      data: {
        name: 'smoke-team',
        expiresAt: new Date(Date.now() + 86400000),
        portQuota: 5,
        translationQuota: 100,
      },
    });
  }
  let lic = await prisma.licenseKey.findFirst({ where: { teamId: team.id } });
  if (!lic) {
    lic = await prisma.licenseKey.create({
      data: { teamId: team.id, nickname: 'smoke-key', status: 'ACTIVE' },
    });
  }

  console.log('team=', team.id, 'quota=', team.translationQuota, 'key=', lic.id);

  // 幂等：把团队翻译用量归零，避免上次运行残留满额导致提前报 QUOTA_EXHAUSTED
  await prisma.team.update({ where: { id: team.id }, data: { translationUsed: 0 } });
  // 清理可能残留的坏 Key（上轮若异常退出）
  await prisma.translationKey.deleteMany({ where: { name: { startsWith: 'smoke-' } } });

  // 场景 A：无任何翻译 Key → 期望 TRANSLATION_SERVICE_UNAVAILABLE (503)
  try {
    await translationService.translate({ text: 'hello', targetLang: 'zh', teamId: team.id, clientKeyId: lic.id });
    console.log('A: 意外成功');
  } catch (e: any) {
    console.log('A (无 Key):', e.statusCode, e.code, '-', e.message);
  }

  // 场景 B：插入一个解密会失败的 Key（模拟失效）→ 期望 API_KEY_INVALID (503)
  const bad = await prisma.translationKey.create({
    data: { engine: 'GOOGLE', name: 'smoke-bad', keyEncrypted: '', status: 'ACTIVE' },
  });
  try {
    await translationService.translate({ text: 'hello', targetLang: 'zh', teamId: team.id, clientKeyId: lic.id });
    console.log('B: 意外成功');
  } catch (e: any) {
    console.log('B (坏 Key):', e.statusCode, e.code, '-', e.message);
  }
  // 确认坏 Key 被标记为 INVALID
  const after = await prisma.translationKey.findUnique({ where: { id: bad.id } });
  console.log('B: 坏 Key 状态 =', after?.status, 'reason =', after?.lastFailureReason);

  // 场景 C：配额耗尽 → 期望 QUOTA_EXHAUSTED (409)
  await prisma.team.update({ where: { id: team.id }, data: { translationUsed: team.translationQuota } });
  try {
    await translationService.translate({ text: 'hello', targetLang: 'zh', teamId: team.id, clientKeyId: lic.id });
    console.log('C: 意外成功');
  } catch (e: any) {
    console.log('C (配额耗尽):', e.statusCode, e.code, '-', e.message);
  }

  // 清理
  await prisma.translationKey.deleteMany({ where: { id: bad.id } });
  console.log('OK');
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
